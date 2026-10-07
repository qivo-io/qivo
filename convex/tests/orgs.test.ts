/* model/orgs + identity.createOrganization over the ported SQL rules:
 * private.name_initials (0117), private.org_slug + the two slug constraints
 * (0107), the org counters (0050/0100), public.create_organization (0118
 * minus the cut domain gate).
 *
 * Fixtures are local to this file on purpose — helpers.setup.ts is another
 * agent's surface this phase. withLogin mirrors identity.test.ts's: a real
 * component user + session, the two rows getAuthUser reads. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import {
  assertNotLastAdmin,
  assertNotLastTeam,
  assertSlugAvailable,
  generateSlug,
  nameInitials,
  narrateSlugChange,
  nextIssueNum,
  nextProjectNum,
  weekLabel,
} from '../model/orgs'
import { activityFor, expectRefusal, newT, plantSeat, type T, uuid } from './helpers.setup'

const componentModules = import.meta.glob('../betterAuth/**/*.ts')

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, componentModules)
  return t
}

const NOW = '2026-01-01T00:00:00.000Z'

let t: T

beforeEach(() => {
  t = newAuthT()
})

/* A verified login; `name` is what create_organization derives the admin seat
 * from (the provider display name). */
async function withLogin(on: T, email: string, name = email.split('@')[0]) {
  const now = Date.now()
  const user = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name, email, emailVerified: true, createdAt: now, updatedAt: now },
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

/* A bare org row — enough for slug-collision probes and the counter tests. */
const plantOrg = (
  on: T,
  slug: string,
  extra: Partial<WithoutSystemFields<Doc<'organizations'>>> = {},
): Promise<Doc<'organizations'>> =>
  on.run(async (ctx) => {
    const _id = await ctx.db.insert('organizations', {
      id: uuid(),
      name: slug,
      slug,
      created_at: NOW,
      next_issue_num: 0,
      next_project_num: 0,
      date_format: 'YYYY-MM-DD',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 32,
      gravatar_avatars: true,
      ...extra,
    })
    return (await ctx.db.get(_id)) as Doc<'organizations'>
  })

const orgByUuid = (on: T, id: string) =>
  on.run((ctx) =>
    ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

describe('nameInitials — the 0117 truth table', () => {
  it('matches the SQL answers, and every answer fits the 1..3 column cap', () => {
    const cases: Array<[string, string]> = [
      ['Erik Holm', 'EH'],
      ['anna fält', 'AF'],
      ['Åsa Öberg', 'ÅÖ'],
      ['Jean Luc Picard', 'JL'],
      ['Testbench', 'T'],
      ['  spaced   out  ', 'SO'],
      ['Maya (guest)', 'MG'],
      ['J. R. R. Tolkien', 'JR'],
      ['3M Company', '3C'],
      ['Мария Иванова', 'МИ'],
      ['日本 語', '日語'],
      ['(((', '?'],
      // the fold: two codepoints in — four and six out without the outer cut
      ['ßeta ßoy', 'SS'],
      ['ﬄip ﬄop', 'FF'],
      ['ßonly', 'SS'],
    ]
    for (const [name, want] of cases) {
      const got = nameInitials(name)
      expect(got, name).toBe(want)
      expect([...got].length, name).toBeGreaterThanOrEqual(1)
      expect([...got].length, name).toBeLessThanOrEqual(3)
    }
  })

  it("nothing to take falls to '?'", () => {
    expect(nameInitials('')).toBe('?')
    expect(nameInitials('   ')).toBe('?')
    expect(nameInitials(null)).toBe('?')
    expect(nameInitials(undefined)).toBe('?')
  })
})

describe('generateSlug — private.org_slug (0107)', () => {
  it('lowers, collapses separator runs and trims the ends', async () => {
    expect(await t.run((ctx) => generateSlug(ctx, '  Nimbus  Labs!  '))).toBe('nimbus-labs')
  })

  it("a reserved word is skipped like a taken one — 'Admin' ⇒ admin-2, never a refusal", async () => {
    expect(await t.run((ctx) => generateSlug(ctx, 'Admin'))).toBe('admin-2')
  })

  it('probes past taken slugs: acme, acme-2 held ⇒ acme-3', async () => {
    await plantOrg(t, 'acme')
    await plantOrg(t, 'acme-2')
    expect(await t.run((ctx) => generateSlug(ctx, 'Acme'))).toBe('acme-3')
  })

  it('a cut landing on a separator is re-trimmed (the latent bug 0107 fixed)', async () => {
    expect(await t.run((ctx) => generateSlug(ctx, `${'a'.repeat(31)} x`))).toBe('a'.repeat(31))
  })

  it('the -2 stem is cut again at its own offset and re-trimmed', async () => {
    await plantOrg(t, 'a'.repeat(32))
    expect(await t.run((ctx) => generateSlug(ctx, 'a'.repeat(40)))).toBe(`${'a'.repeat(30)}-2`)
  })

  it("an unslugifiable name still yields an address — '!!!' ⇒ org-2, because 'org' itself is reserved", async () => {
    // the 0107 fallback base is 'org', which sits ON the reserved list — the
    // SQL loop probes it straight to org-2 (its own probe only asserts shape)
    expect(await t.run((ctx) => generateSlug(ctx, '!!!'))).toBe('org-2')
  })
})

describe('assertSlugAvailable — the setSlug refusal taxonomy', () => {
  it('a reserved word refuses under slug_reserved with the server sentence', async () => {
    const err = await expectRefusal(
      t.run((ctx) => assertSlugAvailable(ctx, 'admin')),
      'conflict',
    )
    expect(err.data.reason).toBe('slug_reserved')
    expect(err.data.message).toBe('That address is reserved — choose another.')
  })

  it('malformed shapes refuse under slug_shape', async () => {
    for (const bad of ['a--b', '-ab', 'ab-', '', 'UPPER', 'a'.repeat(41)]) {
      const err = await expectRefusal(
        t.run((ctx) => assertSlugAvailable(ctx, bad)),
        'conflict',
      )
      expect(err.data.reason, bad).toBe('slug_shape')
      expect(err.data.message).toBe(
        'An address is lowercase letters, digits and single hyphens between them — up to 40 characters.',
      )
    }
  })

  it("a held slug refuses under slug_taken — except for its own holder's same-value write", async () => {
    const org = await plantOrg(t, 'nimbus')
    const err = await expectRefusal(
      t.run((ctx) => assertSlugAvailable(ctx, 'nimbus')),
      'conflict',
    )
    expect(err.data.reason).toBe('slug_taken')
    expect(err.data.message).toBe('That address is already taken — choose another.')
    await t.run((ctx) => assertSlugAvailable(ctx, 'nimbus', org.id)) // owner passes
    await t.run((ctx) => assertSlugAvailable(ctx, 'nimbus-labs')) // free passes
  })
})

describe('counters — nextIssueNum / nextProjectNum (0050/0100)', () => {
  it('dense from 1, chaining inside one mutation even off a stale doc, independent per counter', async () => {
    const org = await plantOrg(t, 'counting')
    const nums = await t.run(async (ctx) => [
      await nextIssueNum(ctx, org),
      await nextIssueNum(ctx, org), // the in-helper re-read chains past the stale doc in hand
      await nextProjectNum(ctx, org),
    ])
    expect(nums).toEqual([1, 2, 1])
    const after = await t.run(async (ctx) => (await ctx.db.get(org._id))!)
    expect(after.next_issue_num).toBe(2)
    expect(after.next_project_num).toBe(1)
  })
})

describe('identity.createOrganization — the whole door', () => {
  it('creates org + admin seat + starter team and labels without a fixed seat allowance', async () => {
    const login = await withLogin(t, 'Founder@Nimbus.test', ' Nimbus   Founder ')
    const orgId = await login.as.mutation(api.identity.createOrganization, {
      name: '  Nimbus Labs  ',
    })

    const org = await orgByUuid(t, orgId)
    expect(org).not.toBeNull()
    expect(org!.name).toBe('Nimbus Labs')
    expect(org!.slug).toBe('nimbus-labs')
    expect(org!.next_issue_num).toBe(0)
    expect(org!.next_project_num).toBe(0)
    expect(org!.date_format).toBe('YYYY-MM-DD')
    expect(org!.week_start).toBe(1)
    expect(org!.week_one_rule).toBe('first4day')
    expect(org!.default_plannable_hours).toBe(32)
    expect(org!.gravatar_avatars).toBe(true)
    expect(org!.max_attachment_mb).toBe(20)
    expect(org!.only_team_leads_manage_project_users).toBe(true)
    expect(org!.billing).toBeUndefined()

    const seats = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    expect(seats.length).toBe(1)
    const me = seats[0]
    expect(me.org_role).toBe('admin')
    expect(me.auth_user_id).toBe(login.userId)
    expect(me.email).toBe('founder@nimbus.test') // lowered
    expect(me.name).toBe('Nimbus Founder') // provider name, whitespace-folded
    expect(me.initials).toBe('NF')
    expect(me.color).toBe('#6D7BF2')
    expect(me.accepted_at).toBeDefined()
    expect(me.active).toBe(true)
    expect(me.kind).toBe('person')
    expect(me.plannable_hours).toBeUndefined() // falls back to the org default
    expect(me.message_retention_days).toBe(7)

    const teams = await t.run((ctx) =>
      ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    expect(teams.length).toBe(1)
    const team = teams[0]
    expect(team.name).toBe('Nimbus Labs') // named exactly the ORG's name
    expect(team.max_attachment_mb).toBeUndefined() // legacy field is never created
    expect(team.stale_days).toBe(120)
    expect(team.archive_days).toBe(30)
    expect(team.track_delay_default).toBe(true)

    const members = await t.run((ctx) =>
      ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', team.id))
        .collect(),
    )
    expect(members.length).toBe(1)
    expect(members[0].profile_id).toBe(me.id)
    expect(members[0].is_leader).toBe(true)

    const labels = await t.run((ctx) =>
      ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    expect(labels.map((label) => label.name).sort()).toEqual(['Electronics', 'Mechanical'])
    expect(new Set(labels.map((label) => label.id)).size).toBe(2)
    for (const label of labels) {
      expect(label.name_lower).toBe(label.name.toLowerCase())
      expect(label.color).toMatch(/^#[0-9A-F]{6}$/)
      expect(label.created_at).toBe(org!.created_at)
    }
  })

  it("with no provider name, the address's local part becomes the admin's name", async () => {
    const login = await withLogin(t, 'plain@example.test', '   ')
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Plainware' })
    const me = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('profiles')
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .collect()
        )[0],
    )
    expect(me.name).toBe('plain')
    expect(me.initials).toBe('P')
  })

  it('refuses a login holding an accepted non-guest seat', async () => {
    const login = await withLogin(t, 'settled@example.test')
    await plantSeat(t, {
      org_id: uuid(),
      email: 'settled@example.test',
      auth_user_id: login.userId,
      accepted_at: NOW,
    })
    await expectRefusal(
      login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' }),
      'rule',
      /^you already belong to an organization$/,
    )
  })

  it('a guest-only login succeeds — guest seats are not a home', async () => {
    const login = await withLogin(t, 'wanderer@example.test')
    await plantSeat(t, {
      org_id: uuid(),
      email: 'wanderer@example.test',
      auth_user_id: login.userId,
      accepted_at: NOW,
      org_role: 'guest',
    })
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Homestead' })
    expect((await orgByUuid(t, orgId))?.slug).toBe('homestead')
  })

  it.each([
    { match: 'login', retention: 30 },
    { match: 'login', retention: undefined },
    { match: 'email', retention: 30 },
    { match: 'email', retention: undefined },
  ])(
    'inherits the oldest $match seat retention ($retention), including Never',
    async ({ match, retention }) => {
      const login = await withLogin(t, 'wanderer@example.test')
      await plantSeat(t, {
        org_id: uuid(),
        email: match === 'email' ? 'wanderer@example.test' : 'old-address@example.test',
        auth_user_id: match === 'login' ? login.userId : undefined,
        accepted_at: match === 'login' ? NOW : undefined,
        org_role: 'guest',
        message_retention_days: retention,
        created_at: NOW,
      })
      await plantSeat(t, {
        org_id: uuid(),
        email: 'wanderer@example.test',
        org_role: 'guest',
        message_retention_days: 90,
        created_at: '2026-01-02T00:00:00.000Z',
      })
      const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Homestead' })
      const me = await t.run((ctx) =>
        ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .unique(),
      )
      expect(me).not.toBeNull()
      expect(me!.message_retention_days).toBe(retention)
    },
  )

  it('a blank name is refused', async () => {
    const login = await withLogin(t, 'nameless@example.test')
    await expectRefusal(
      login.as.mutation(api.identity.createOrganization, { name: '   ' }),
      'rule',
      /^the organization needs a name$/,
    )
  })

  it('probes past a taken slug — the second Nimbus lands at nimbus-2', async () => {
    await plantOrg(t, 'nimbus')
    const login = await withLogin(t, 'second@example.test')
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Nimbus' })
    expect((await orgByUuid(t, orgId))?.slug).toBe('nimbus-2')
  })

  it("a company called Admin gets admin-2, not a refusal — 0107's self-serve rule", async () => {
    const login = await withLogin(t, 'boss@example.test')
    const orgId = await login.as.mutation(api.identity.createOrganization, { name: 'Admin' })
    expect((await orgByUuid(t, orgId))?.slug).toBe('admin-2')
  })
})

/* A bare team row for the last-team guard. */
const plantTeam = (on: T, org_id: string): Promise<Doc<'teams'>> =>
  on.run(async (ctx) => {
    const _id = await ctx.db.insert('teams', {
      id: uuid(),
      org_id,
      name: 'Planted',
      stale_days: 120,
      archive_days: 30,
      track_delay_default: true,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'teams'>
  })

describe('assertNotLastAdmin — profiles_last_admin_* (0099)', () => {
  it('the sole active admin cannot go: two verbs, two verbatim sentences', async () => {
    const org = await plantOrg(t, 'lone-admin')
    const admin = await plantSeat(t, { org_id: org.id, org_role: 'admin' })
    await plantSeat(t, { org_id: org.id, org_role: 'user' }) // non-admins never save it
    await expectRefusal(
      t.run((ctx) => assertNotLastAdmin(ctx, admin, 'demote')),
      'rule',
      /^cannot demote the last admin$/,
    )
    await expectRefusal(
      t.run((ctx) => assertNotLastAdmin(ctx, admin, 'remove')),
      'rule',
      /^cannot remove the last admin$/,
    )
  })

  it('an INACTIVE second admin does not count — the last admin is the last who can sign in', async () => {
    const org = await plantOrg(t, 'sleepy-admin')
    const admin = await plantSeat(t, { org_id: org.id, org_role: 'admin' })
    await plantSeat(t, { org_id: org.id, org_role: 'admin', active: false })
    await expectRefusal(
      t.run((ctx) => assertNotLastAdmin(ctx, admin, 'demote')),
      'rule',
      /^cannot demote the last admin$/,
    )
  })

  it('a second ACTIVE admin frees both directions', async () => {
    const org = await plantOrg(t, 'two-admins')
    const admin = await plantSeat(t, { org_id: org.id, org_role: 'admin' })
    await plantSeat(t, { org_id: org.id, org_role: 'admin' })
    await t.run((ctx) => assertNotLastAdmin(ctx, admin, 'demote'))
    await t.run((ctx) => assertNotLastAdmin(ctx, admin, 'remove'))
  })
})

describe('assertNotLastTeam — teams_last_guard (0078)', () => {
  it('the only team stays; a sibling in the SAME org frees it; a foreign team never does', async () => {
    const org = await plantOrg(t, 'one-team')
    const other = await plantOrg(t, 'other-team-org')
    const team = await plantTeam(t, org.id)
    await plantTeam(t, other.id) // a foreign team is no sibling
    await expectRefusal(
      t.run((ctx) => assertNotLastTeam(ctx, team)),
      'rule',
      /^cannot delete the last team$/,
    )
    await plantTeam(t, org.id)
    await t.run((ctx) => assertNotLastTeam(ctx, team))
  })
})

describe('narrateSlugChange — organizations_slug_narrate (0108)', () => {
  it('a real move writes exactly one row naming both addresses; a same-value write none', async () => {
    const org = await plantOrg(t, 'zz-narrate-probe', { name: 'ZZ Narrate Probe' })
    const actor = await plantSeat(t, { org_id: org.id, org_role: 'admin' })

    await t.run((ctx) =>
      narrateSlugChange(ctx, org, {
        old_slug: 'zz-narrate-probe',
        new_slug: 'zz-narrate-probe',
        actor_id: actor.id,
        now: NOW,
      }),
    )
    expect(await activityFor(t, org.id)).toEqual([])

    await t.run((ctx) =>
      narrateSlugChange(ctx, org, {
        old_slug: 'zz-narrate-probe',
        new_slug: 'zz-narrate-probe-2',
        actor_id: actor.id,
        now: NOW,
      }),
    )
    const rows = await activityFor(t, org.id)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      org_id: org.id,
      actor_id: actor.id,
      verb: 'changed the address of',
      target_type: 'org',
      target_id: org.id,
      label: 'ZZ Narrate Probe', // the org NAME, not the slug
      detail: 'zz-narrate-probe → zz-narrate-probe-2',
      ts: NOW,
    })
    expect(rows[0].project_id).toBeUndefined()
    expect(rows[0].team_id).toBeUndefined()
  })
})

describe('weekLabel — the dates.ts port for milestone narration', () => {
  // expectations produced by the client algorithm itself (53,805-case parity
  // sweep across every setting combination and three timezones, zero drift)
  const iso = { week_start: 1, week_one_rule: 'first4day', date_format: 'YYYY-MM-DD' }

  it('ISO defaults: week number, day-first date, and the Dec–Jan straddle both ways', () => {
    expect(weekLabel('2025-12-29', iso)).toBe('W1, 29 Dec') // already week 1 of 2026
    expect(weekLabel('2025-12-22', iso)).toBe('W52, 22 Dec')
    expect(weekLabel('2026-01-01', { ...iso, week_one_rule: 'firstfull' })).toBe('W52, 29 Dec')
  })

  it('an unaligned date floors to its week start (isoToWeek round-trip semantics)', () => {
    expect(weekLabel('2026-01-01', iso)).toBe('W1, 29 Dec') // a Thursday
  })

  it('week_start and date_format both follow the SUBJECT org', () => {
    expect(
      weekLabel('2026-05-12', { week_start: 0, week_one_rule: 'jan1', date_format: 'MMM D, YYYY' }),
    ).toBe('W20, May 10') // Sunday weeks, month-first
    expect(
      weekLabel('2026-05-12', { week_start: 2, week_one_rule: 'jan1', date_format: 'MM/DD/YYYY' }),
    ).toBe('W20, May 12')
  })

  it("out-of-range settings coerce to Monday/first4day/day-first — setWeekConfig's fallbacks", () => {
    expect(
      weekLabel('2026-01-01', { week_start: 9, week_one_rule: 'nonsense', date_format: 'iso' }),
    ).toBe('W1, 29 Dec')
  })
})
