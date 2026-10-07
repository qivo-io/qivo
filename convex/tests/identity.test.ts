/* Login ↔ seat linking invariants over convex/identity.ts.
 *
 * The claim loop is driven through claimSeatsInternal with explicit
 * { userId, email, emailVerified } args; claimMySeats and createOrganization
 * are driven FOR REAL by registering the LOCAL Better Auth component
 * (convex/betterAuth/ — schema + adapter, the exact modules the deployment
 * runs) on the convex-test backend and seeding user/session rows through the
 * component adapter. @convex-dev/better-auth/test's register(t) does load
 * under this config, but is NOT used: it registers the package's PUBLISHED
 * component (schema without the admin() fields, adapter bound to the
 * package's own static options) — under our local install that is a
 * different component than the one deployed. registerComponent with the
 * local schema + modules is the local-install analog of the same helper. */
/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const componentModules = import.meta.glob('../betterAuth/**/*.ts')

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, componentModules)
  return t
}

const NOW = '2026-01-01T00:00:00.000Z'
const DAY2 = '2026-01-02T00:00:00.000Z'
const DAY3 = '2026-01-03T00:00:00.000Z'

const EMAIL = 'invitee@example.test'
const LOGIN = 'ba_login_1'

let t: T
let f: OrgFixture

beforeEach(async () => {
  t = newAuthT()
  f = await withOrg(t)
})

const claim = (
  on: T,
  args: Partial<{ userId: string; email: string; emailVerified: boolean }> = {},
) =>
  on.mutation(internal.identity.claimSeatsInternal, {
    userId: LOGIN,
    email: EMAIL,
    emailVerified: true,
    ...args,
  })

const reload = (on: T, seat: Doc<'profiles'>) =>
  on.run(async (ctx) => (await ctx.db.get(seat._id)) as Doc<'profiles'>)

/* A real login: a component user row plus an unexpired session, the two rows
 * getAuthUser reads. subject/sessionId mirror what the Convex JWT carries. */
async function withLogin(on: T, email: string, emailVerified = true) {
  const now = Date.now()
  const user = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name: email.split('@')[0], email, emailVerified, createdAt: now, updatedAt: now },
    },
  })
  const session = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: {
        token: uuid(),
        userId: user._id as string,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  return {
    userId: user._id as string,
    as: on.withIdentity({ subject: user._id as string, sessionId: session._id as string }),
  }
}

describe('claimSeatsForLogin — the claim loop', () => {
  it('adopts every unclaimed seat carrying the address across orgs; claimed and other-email seats untouched', async () => {
    const first = await plantSeat(t, { org_id: f.org.id, email: EMAIL, created_at: DAY2 })
    const second = await plantSeat(t, { org_id: f.otherOrg.id, email: EMAIL, created_at: DAY3 })
    const claimed = await plantSeat(t, {
      org_id: uuid(),
      email: EMAIL,
      auth_user_id: 'someone-else',
      accepted_at: NOW,
    })
    const bystander = await plantSeat(t, { org_id: f.org.id, email: 'bystander@example.test' })

    expect(await claim(t)).toBe(2)

    const a = await reload(t, first)
    expect(a.auth_user_id).toBe(LOGIN)
    expect(a.org_role).toBe('user') // first non-guest in wins the home role
    expect(a.accepted_at).toBeDefined() // a verified-email claim IS the acceptance
    const b = await reload(t, second)
    expect(b.auth_user_id).toBe(LOGIN)
    expect(b.org_role).toBe('guest') // second non-guest adoption demoted
    expect(b.accepted_at).toBeDefined()
    const c = await reload(t, claimed)
    expect(c.auth_user_id).toBe('someone-else')
    expect(c.org_role).toBe('user')
    expect((await reload(t, bystander)).auth_user_id).toBeUndefined()
  })

  it('an unverified email claims nothing', async () => {
    const seat = await plantSeat(t, { org_id: f.org.id, email: EMAIL })
    expect(await claim(t, { emailVerified: false })).toBe(0)
    expect((await reload(t, seat)).auth_user_id).toBeUndefined()
  })

  it('the older seat wins the home role in either org order (created_at, id — 0085)', async () => {
    for (const firstOrg of ['org', 'otherOrg'] as const) {
      const t2 = newAuthT()
      const f2 = await withOrg(t2)
      const older = await plantSeat(t2, { org_id: f2[firstOrg].id, email: EMAIL, created_at: DAY2 })
      const newer = await plantSeat(t2, {
        org_id: f2[firstOrg === 'org' ? 'otherOrg' : 'org'].id,
        email: EMAIL,
        created_at: DAY3,
      })
      expect(await claim(t2)).toBe(2)
      expect((await reload(t2, older)).org_role).toBe('user')
      expect((await reload(t2, newer)).org_role).toBe('guest')
    }
  })

  it('a login already holding a home seat adopts a further non-guest seat as a guest, skipping bootstrap', async () => {
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'home@example.test',
      auth_user_id: LOGIN,
      accepted_at: NOW,
    })
    // admin-less org: without the home seat this claim would bootstrap to admin
    const waiting = await plantSeat(t, { org_id: uuid(), email: EMAIL, created_at: DAY2 })
    expect(await claim(t)).toBe(1)
    const seat = await reload(t, waiting)
    expect(seat.auth_user_id).toBe(LOGIN)
    expect(seat.org_role).toBe('guest')
    expect(seat.accepted_at).toBeDefined()
  })

  it('a waiting seat in an org where the login already sits is skipped — never two seats per (org, login)', async () => {
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'first-invite@example.test',
      auth_user_id: LOGIN,
      accepted_at: NOW,
    })
    const reinvited = await plantSeat(t, { org_id: f.org.id, email: EMAIL })
    expect(await claim(t)).toBe(0)
    expect((await reload(t, reinvited)).auth_user_id).toBeUndefined()
  })

  it('a login with no waiting seat claims nothing and creates nothing', async () => {
    const before = await t.run((ctx) => ctx.db.query('profiles').collect())
    expect(await claim(t, { email: 'stranger@example.test' })).toBe(0)
    const after = await t.run((ctx) => ctx.db.query('profiles').collect())
    expect(after.length).toBe(before.length)
  })

  it('matches lower(input) against the stored address, exactly the 0085 predicate', async () => {
    // the input is lowered before matching…
    const seat = await plantSeat(t, { org_id: f.org.id, email: EMAIL })
    expect(await claim(t, { email: 'InViTee@Example.TEST' })).toBe(1)
    expect((await reload(t, seat)).auth_user_id).toBe(LOGIN)
    // …the stored side is not: `email = lower(p_email)` compares the stored
    // string verbatim (the schema stores lowercase; a mixed-case row is out of
    // contract and, like in SQL, simply never matches)
    const offContract = await plantSeat(t, { org_id: f.otherOrg.id, email: 'Mixed@Case.test' })
    expect(await claim(t, { userId: 'ba_login_2', email: 'mixed@case.test' })).toBe(0)
    expect(await claim(t, { userId: 'ba_login_2', email: 'Mixed@Case.test' })).toBe(0)
    expect((await reload(t, offContract)).auth_user_id).toBeUndefined()
  })
})

describe('bootstrap (0002): an org whose admins hold no login makes its first login an admin', () => {
  it('the first claim into an admin-less org is promoted to admin', async () => {
    const seat = await plantSeat(t, { org_id: uuid(), email: EMAIL })
    expect(await claim(t)).toBe(1)
    const adopted = await reload(t, seat)
    expect(adopted.org_role).toBe('admin')
    expect(adopted.auth_user_id).toBe(LOGIN)
    expect(adopted.accepted_at).toBeDefined()
  })

  it('an org whose admin already holds a login does not promote', async () => {
    const seat = await plantSeat(t, { org_id: f.org.id, email: EMAIL }) // f.admin is claimed
    expect(await claim(t)).toBe(1)
    expect((await reload(t, seat)).org_role).toBe('user')
  })

  it('an UNCLAIMED admin seat does not block promotion — the predicate is admin WITH a login', async () => {
    const orgId = uuid()
    await plantSeat(t, { org_id: orgId, email: 'founder@example.test', org_role: 'admin' })
    const seat = await plantSeat(t, { org_id: orgId, email: EMAIL, created_at: DAY2 })
    await claim(t)
    expect((await reload(t, seat)).org_role).toBe('admin')
  })

  it('an inactive admin holding a login still blocks — 0002 never consulted active (0099 postdates it)', async () => {
    const orgId = uuid()
    await plantSeat(t, {
      org_id: orgId,
      email: 'gone@example.test',
      org_role: 'admin',
      auth_user_id: 'departed-login',
      accepted_at: NOW,
      active: false,
    })
    const seat = await plantSeat(t, { org_id: orgId, email: EMAIL, created_at: DAY2 })
    await claim(t)
    expect((await reload(t, seat)).org_role).toBe('user')
  })

  it('a guest seat adopted by a home-less login can bootstrap to admin', async () => {
    const seat = await plantSeat(t, { org_id: uuid(), email: EMAIL, org_role: 'guest' })
    expect(await claim(t)).toBe(1)
    expect((await reload(t, seat)).org_role).toBe('admin')
  })
})

describe('claimMySeats — through the real component', () => {
  it("adopts the caller's waiting seat, resolving email + verification from the component user row", async () => {
    const login = await withLogin(t, 'fresh@example.test')
    const seat = await plantSeat(t, { org_id: f.org.id, email: 'fresh@example.test' })
    expect(await login.as.mutation(api.identity.claimMySeats, {})).toBe(1)
    const adopted = await reload(t, seat)
    expect(adopted.auth_user_id).toBe(login.userId) // = identity.subject = component user._id
    expect(adopted.accepted_at).toBeDefined()
  })

  it('an unverified login claims nothing even on the real path', async () => {
    const login = await withLogin(t, 'shy@example.test', false)
    const seat = await plantSeat(t, { org_id: f.org.id, email: 'shy@example.test' })
    expect(await login.as.mutation(api.identity.claimMySeats, {})).toBe(0)
    expect((await reload(t, seat)).auth_user_id).toBeUndefined()
  })
})

describe('createOrganization guards (0118)', () => {
  it('refuses an unverified login first', async () => {
    const login = await withLogin(t, 'eager@example.test', false)
    await expectRefusal(
      login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' }),
      'rule',
      /confirm your email address/,
    )
  })

  it('refuses a login with an accepted non-guest home seat', async () => {
    const login = await withLogin(t, 'settled@example.test')
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'settled@example.test',
      auth_user_id: login.userId,
      accepted_at: NOW,
    })
    await expectRefusal(
      login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' }),
      'rule',
      /you already belong to an organization/,
    )
  })

  it('a guest-only login passes both guards and creates', async () => {
    const login = await withLogin(t, 'guest-only@example.test')
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'guest-only@example.test',
      auth_user_id: login.userId,
      accepted_at: NOW,
      org_role: 'guest',
    })
    // the full path is asserted in orgs.test.ts; here only that the door opens
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' })
    expect(typeof orgId).toBe('string')
  })

  it('an unaccepted non-guest seat is not a home — the guard reads accepted_at', async () => {
    const login = await withLogin(t, 'pending@example.test')
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'pending@example.test',
      auth_user_id: login.userId, // claimed but never accepted
    })
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' })
    expect(typeof orgId).toBe('string')
  })
})

describe('acceptInvitation (0118)', () => {
  const caller = () => t.withIdentity({ subject: 'ba_accepting' })

  it("uniformly answers 'invitation not found' — absent id, someone else's seat, an unclaimed seat", async () => {
    const foreign = await plantSeat(t, {
      org_id: f.org.id,
      email: 'theirs@example.test',
      auth_user_id: 'someone-else',
    })
    const unclaimed = await plantSeat(t, { org_id: f.org.id, email: 'nobody@example.test' })
    for (const profile_id of [uuid(), foreign.id, unclaimed.id]) {
      await expectRefusal(
        caller().mutation(api.identity.acceptInvitation, { profile_id }),
        'rule',
        /^invitation not found$/,
      )
    }
    // the id is not an existence oracle: nothing changed either
    expect((await reload(t, foreign)).accepted_at).toBeUndefined()
    expect((await reload(t, unclaimed)).auth_user_id).toBeUndefined()
  })

  it("accepts the caller's pending seat, keeping its role when no home exists", async () => {
    const seat = await plantSeat(t, {
      org_id: f.org.id,
      email: 'mine@example.test',
      auth_user_id: 'ba_accepting',
    })
    await caller().mutation(api.identity.acceptInvitation, { profile_id: seat.id })
    const accepted = await reload(t, seat)
    expect(accepted.accepted_at).toBeDefined()
    expect(accepted.org_role).toBe('user')
  })

  it('re-runs the home check at accept time — a second non-guest acceptance demotes to guest', async () => {
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'mine@example.test',
      auth_user_id: 'ba_accepting',
      accepted_at: NOW,
    })
    const pending = await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: 'mine@example.test',
      auth_user_id: 'ba_accepting',
    })
    await caller().mutation(api.identity.acceptInvitation, { profile_id: pending.id })
    const accepted = await reload(t, pending)
    expect(accepted.accepted_at).toBeDefined()
    expect(accepted.org_role).toBe('guest')
  })

  it('an already-accepted seat returns silently, changing nothing', async () => {
    await plantSeat(t, {
      org_id: f.org.id,
      email: 'mine@example.test',
      auth_user_id: 'ba_accepting',
      accepted_at: NOW,
    })
    const settled = await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: 'mine@example.test',
      auth_user_id: 'ba_accepting',
      accepted_at: DAY2, // planted past the home check — the early return must not demote it
    })
    await caller().mutation(api.identity.acceptInvitation, { profile_id: settled.id })
    const after = await reload(t, settled)
    expect(after.accepted_at).toBe(DAY2)
    expect(after.org_role).toBe('user')
  })
})

describe('whoami', () => {
  it("returns the caller's active seats and nobody else's", async () => {
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: f.admin.email,
      auth_user_id: f.admin.auth_user_id,
      accepted_at: NOW,
      org_role: 'guest',
    })
    await plantSeat(t, {
      org_id: uuid(),
      email: f.admin.email,
      auth_user_id: f.admin.auth_user_id,
      accepted_at: NOW,
      active: false, // deactivated seats stay invisible
    })
    const me = await as(t, f.admin).query(api.identity.whoami, {})
    expect(me.authUserId).toBe(f.admin.auth_user_id)
    expect(me.profiles.map((p) => p.org_id).sort()).toEqual([f.org.id, f.otherOrg.id].sort())
    const home = me.profiles.find((p) => p.org_id === f.org.id)
    expect(home?.id).toBe(f.admin.id)
    expect(home?.org_role).toBe('admin')
  })

  it('a seatless login gets an empty list, not an error', async () => {
    const me = await t.withIdentity({ subject: 'ba_seatless' }).query(api.identity.whoami, {})
    expect(me.authUserId).toBe('ba_seatless')
    expect(me.profiles).toEqual([])
  })
})
