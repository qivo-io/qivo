/* The operator console backend (admin.ts) — the fail-closed sweep over every
 * public admin function (each platform wrapper refuses a signed-in
 * non-operator with 0015's per-call re-check, and the anonymous caller before
 * that), isOperator's deliberate fail-OPEN false (the AdminGate probe must
 * never throw — a clean false is what keeps the smoke's no-console-errors
 * check green), promoteOrgAdmin's rescue path with its audit row, and a
 * listUsers shape spot-check against the exact fields Users.tsx destructures,
 * including the banned_until wire-name mapping off Better Auth's
 * { banned, banExpires } and the newest-session last_sign_in_at
 * approximation (driven through the REAL local component, the identity-suite
 * pattern).
 *
 * The sweep is table-driven and forgetting-proofed: every export of
 * convex/admin.ts must appear in the table or in the documented exclusion
 * set, so a new admin function cannot ship ungated unnoticed. */
/// <reference types="vite/client" />

import type { FunctionReference } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as adminModule from '../admin'
import authSchema from '../betterAuth/schema'
import { as, expectRefusal, NOW, newT, type T, uuid, withOrg } from './helpers.setup'

const componentModules = import.meta.glob('../betterAuth/**/*.ts')

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, componentModules)
  return t
}

const DAY = 86_400_000

/* A real platform operator: a component user row (so audit's actor_email
 * resolves genuinely) plus the platform_admins row the wrappers gate on. */
async function withOperator(on: T) {
  const now = Date.now()
  const email = 'operator@platform.test'
  const user = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name: 'operator', email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  })
  const userId = user._id as string
  await on.run(async (ctx) => {
    await ctx.db.insert('platform_admins', { auth_user_id: userId, note: 'test', created_at: NOW })
  })
  return { userId, email, asOp: on.withIdentity({ subject: userId }) }
}

/* An operator's two marks, plantable apart: the Better Auth role (Better
 * Auth stores it as a comma-separated LIST, so `role` takes the raw string)
 * and the platform_admins row the wrappers gate on. `enrolled: false` plants
 * only the first — the stale-role state removeOperator must still be able to
 * clean up. `rows` plants the same operator more than once, the duplicate
 * enrolment the last-operator guard must see through. */
async function plantOperator(
  t: T,
  email: string,
  opts: { enrolled?: boolean; role?: string; rows?: number } = {},
): Promise<string> {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: email.split('@')[0],
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        role: opts.role ?? 'admin',
      },
    },
  })
  const userId = user._id as string
  if (opts.enrolled !== false) {
    await t.run(async (ctx) => {
      for (let i = 0; i < (opts.rows ?? 1); i++) {
        await ctx.db.insert('platform_admins', { auth_user_id: userId, note: '', created_at: NOW })
      }
    })
  }
  return userId
}

const authRole = (t: T, email: string): Promise<string | null> =>
  t.run(async (ctx) => {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })) as { role?: string | null } | null
    return user?.role ?? null
  })

const operatorIds = (t: T): Promise<string[]> =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_admins').withIndex('by_auth_user').collect()).map(
      (r) => r.auth_user_id,
    ),
  )

const profileRow = (t: T, id: string): Promise<Doc<'profiles'> | null> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
  )

const auditRows = (t: T): Promise<Doc<'platform_audit_log'>[]> =>
  t.run(async (ctx) => await ctx.db.query('platform_audit_log').withIndex('by_ts').collect())

/* ------------------------------------------------------ the fail-closed sweep */

const SURFACE: Record<string, { kind: 'query' | 'mutation'; args: Record<string, unknown> }> = {
  listOrgs: { kind: 'query', args: {} },
  orgDetail: { kind: 'query', args: { org_id: '00000000-0000-4000-8000-000000000000' } },
  listUsers: { kind: 'query', args: { search: '' } },
  platformStats: { kind: 'query', args: {} },
  auditLog: { kind: 'query', args: {} },
  promoteOrgAdmin: {
    kind: 'mutation',
    args: { profile_id: '00000000-0000-4000-8000-000000000000' },
  },
}

/* Deliberately outside the sweep: isOperator is the fail-open gate probe
 * (its own suite below); addOperator and removeOperator are
 * internalMutations, unreachable from clients (CLI enrolment only, each with
 * its own suite below). Everything else in the module is a type or helper
 * export. */
const EXCLUDED = new Set(['isOperator', 'addOperator', 'removeOperator'])

describe('fail-closed: every admin function refuses a non-operator', () => {
  it('the sweep covers every export of admin.ts (or documents its exclusion)', () => {
    const exported = Object.keys(adminModule)
    for (const name of exported) {
      expect(
        SURFACE[name] !== undefined || EXCLUDED.has(name),
        `admin.${name} is neither in the fail-closed sweep nor excluded with a reason`,
      ).toBe(true)
    }
    for (const name of Object.keys(SURFACE)) {
      expect(
        exported.includes(name),
        `sweep names admin.${name}, which admin.ts does not export`,
      ).toBe(true)
    }
  })

  for (const [name, spec] of Object.entries(SURFACE)) {
    it(`${name}: signed-in non-operator refused, anonymous refused`, async () => {
      const t = newAuthT()
      const f = await withOrg(t)
      const fn = (api.admin as unknown as Record<string, unknown>)[name]
      const q = fn as FunctionReference<'query', 'public', Record<string, unknown>, unknown>
      const m = fn as FunctionReference<'mutation', 'public', Record<string, unknown>, unknown>
      const asMember = as(t, f.admin) // an ORG admin — still not a platform operator
      await expectRefusal(
        spec.kind === 'query' ? asMember.query(q, spec.args) : asMember.mutation(m, spec.args),
        'forbidden',
        /not a platform operator/,
      )
      await expectRefusal(
        spec.kind === 'query' ? t.query(q, spec.args) : t.mutation(m, spec.args),
        'forbidden',
        /not signed in/,
      )
    })
  }
})

/* ----------------------------------------------------------------- isOperator */

describe('isOperator — the fail-open gate probe', () => {
  it('anonymous caller: false, not a throw', async () => {
    const t = newAuthT()
    expect(await t.query(api.admin.isOperator, {})).toBe(false)
  })

  it('signed-in non-operator: false; operator: true', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    expect(await as(t, f.admin).query(api.admin.isOperator, {})).toBe(false)
    const op = await withOperator(t)
    expect(await op.asOp.query(api.admin.isOperator, {})).toBe(true)
  })
})

/* ------------------------------------------------------------ promoteOrgAdmin */

describe('promoteOrgAdmin — the lockout rescue', () => {
  it('promotes a viewer to org admin and writes the audit row as the operator', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const op = await withOperator(t)

    await op.asOp.mutation(api.admin.promoteOrgAdmin, { profile_id: f.viewer.id })

    expect((await profileRow(t, f.viewer.id))?.org_role).toBe('admin')
    const rows = await auditRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'promote_org_admin',
      actor_auth_id: op.userId,
      actor_email: op.email,
      target_org_id: f.org.id,
      target_profile_id: f.viewer.id,
    })
  })

  it('agent target refused with the readable sentence; missing profile is not found; neither audits', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const op = await withOperator(t)

    await expectRefusal(
      op.asOp.mutation(api.admin.promoteOrgAdmin, { profile_id: f.agent.id }),
      'rule',
      /an agent cannot be an organization admin/,
    )
    expect((await profileRow(t, f.agent.id))?.org_role).toBe('user')
    await expectRefusal(
      op.asOp.mutation(api.admin.promoteOrgAdmin, { profile_id: uuid() }),
      'not_found',
      /profile not found/,
    )
    expect(await auditRows(t)).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ listUsers */

describe('listUsers — the cross-org account search', () => {
  it('returns every profile with the Users.tsx fields, maps the BA auth columns, and narrows on search', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const op = await withOperator(t)

    /* Give the viewer a REAL Better Auth login: banned with an expiry, and
     * one session — the two approximated auth.users columns. */
    const now = Date.now()
    const banExpires = now + DAY
    const sessionCreated = now - 1000
    const baUser = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'viewer',
          email: 'viewer@testbed.test',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          banned: true,
          banExpires,
        },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'session',
        data: {
          token: uuid(),
          userId: baUser._id as string,
          expiresAt: now + 60 * 60 * 1000,
          createdAt: sessionCreated,
          updatedAt: sessionCreated,
        },
      },
    })
    await t.run(async (ctx) => {
      const viewer = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', f.viewer.id))
        .unique()
      await ctx.db.patch(viewer!._id, { auth_user_id: baUser._id as string })
    })

    const rows = await op.asOp.query(api.admin.listUsers, { search: '' })
    /* withOrg: admin, user, viewer, guest, agent in Testbed Labs + otherAdmin in
     * Other — the operator itself holds no profile and must not appear. */
    expect(rows).toHaveLength(6)
    /* ordered by org name then profile name: Other sorts before Testbed Labs */
    expect(rows[0].org_name).toBe('Other')
    expect(rows.slice(1).map((r) => r.name)).toEqual(['Relay', 'admin', 'guest', 'user', 'viewer'])

    const viewerRow = rows.find((r) => r.profile_id === f.viewer.id)!
    expect(viewerRow).toEqual({
      profile_id: f.viewer.id,
      name: 'viewer',
      email: 'viewer@testbed.test',
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      org_role: 'viewer',
      has_login: true,
      last_sign_in_at: new Date(sessionCreated).toISOString(),
      banned_until: new Date(banExpires).toISOString(),
      created_at: NOW,
    })

    /* the agent: no email, no login, both auth columns null */
    const agentRow = rows.find((r) => r.profile_id === f.agent.id)!
    expect(agentRow.email).toBeNull()
    expect(agentRow.has_login).toBe(false)
    expect(agentRow.last_sign_in_at).toBeNull()
    expect(agentRow.banned_until).toBeNull()

    /* substring narrowing, the smoke's "row count NARROWS" check */
    const narrowed = await op.asOp.query(api.admin.listUsers, { search: 'viewer' })
    expect(narrowed.map((r) => r.profile_id)).toEqual([f.viewer.id])
    expect(narrowed.length).toBeLessThan(rows.length)

    // Fragments can appear in reverse order, and across name/email/org fields.
    for (const [search, ids] of [
      ['LABS VIEW', [f.viewer.id]],
      ['  lay\ttestbed ', [f.agent.id]],
      ['testbed missing', []],
    ] as const) {
      const matches = await op.asOp.query(api.admin.listUsers, { search })
      expect(matches.map((r) => r.profile_id)).toEqual(ids)
    }
  })
})

/* ------------------------------------------------------------ removeOperator */

describe('removeOperator — the CLI-only demotion', () => {
  it('demotes one of two operators: only that row and that role change, and it audits', async () => {
    const t = newAuthT()
    const keep = await plantOperator(t, 'keeper@platform.test')
    const drop = await plantOperator(t, 'leaver@platform.test')

    /* the CLI's argument arrives unnormalized — trimmed and lowercased here */
    expect(
      await t.mutation(internal.admin.removeOperator, { email: ' Leaver@PLATFORM.test ' }),
    ).toEqual({ auth_user_id: drop })

    expect(await operatorIds(t)).toEqual([keep])
    expect(await authRole(t, 'leaver@platform.test')).toBe('user')
    expect(await authRole(t, 'keeper@platform.test')).toBe('admin')
    const rows = await auditRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_email: 'cli', action: 'remove_operator' })
    expect(rows[0].detail).toEqual({ email: 'leaver@platform.test' })
  })

  it('refuses to remove the last enrolled operator, changing neither store', async () => {
    const t = newAuthT()
    const sole = await plantOperator(t, 'sole@platform.test')

    await expectRefusal(
      t.mutation(internal.admin.removeOperator, { email: 'sole@platform.test' }),
      'rule',
      /last platform operator/,
    )

    expect(await operatorIds(t)).toEqual([sole])
    expect(await authRole(t, 'sole@platform.test')).toBe('admin')
    expect(await auditRows(t)).toHaveLength(0)
  })

  it('strips the admin token out of a comma-separated role, keeping the others', async () => {
    const t = newAuthT()
    await plantOperator(t, 'keeper@platform.test')
    await plantOperator(t, 'leaver@platform.test', { role: 'admin,user' })
    /* no enrolment to lose, but the stale admin token still has to go */
    await plantOperator(t, 'stale@platform.test', { enrolled: false, role: 'support,admin' })

    await t.mutation(internal.admin.removeOperator, { email: 'leaver@platform.test' })
    await t.mutation(internal.admin.removeOperator, { email: 'stale@platform.test' })

    expect(await authRole(t, 'leaver@platform.test')).toBe('user')
    expect(await authRole(t, 'stale@platform.test')).toBe('support')
  })

  it('refuses a last operator whose enrolment is duplicated, changing neither store', async () => {
    const t = newAuthT()
    const sole = await plantOperator(t, 'sole@platform.test', { rows: 2 })

    await expectRefusal(
      t.mutation(internal.admin.removeOperator, { email: 'sole@platform.test' }),
      'rule',
      /last platform operator/,
    )

    expect(await operatorIds(t)).toEqual([sole, sole])
    expect(await authRole(t, 'sole@platform.test')).toBe('admin')
    expect(await auditRows(t)).toHaveLength(0)
  })

  it('refuses when every other enrolment is stale or no longer an admin', async () => {
    const t = newAuthT()
    const sole = await plantOperator(t, 'sole@platform.test')
    const demoted = await plantOperator(t, 'demoted@platform.test', { role: 'user' })
    const missing = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('platform_admins', {
        auth_user_id: missing,
        note: '',
        created_at: NOW,
      })
    })

    await expectRefusal(
      t.mutation(internal.admin.removeOperator, { email: 'sole@platform.test' }),
      'rule',
      /last platform operator/,
    )

    expect(await operatorIds(t)).toEqual(expect.arrayContaining([sole, demoted, missing]))
    expect(await operatorIds(t)).toHaveLength(3)
    expect(await authRole(t, 'sole@platform.test')).toBe('admin')
    expect(await auditRows(t)).toHaveLength(0)
  })

  it('removes every duplicate row of a demoted operator when another one remains', async () => {
    const t = newAuthT()
    const keep = await plantOperator(t, 'keeper@platform.test')
    await plantOperator(t, 'leaver@platform.test', { rows: 2 })

    await t.mutation(internal.admin.removeOperator, { email: 'leaver@platform.test' })

    expect(await operatorIds(t)).toEqual([keep])
    expect(await auditRows(t)).toHaveLength(1)
  })

  it('an unknown email is not found; an empty email is a bad request', async () => {
    const t = newAuthT()
    await plantOperator(t, 'sole@platform.test')

    await expectRefusal(
      t.mutation(internal.admin.removeOperator, { email: 'ghost@platform.test' }),
      'not_found',
      /no auth account with that email/,
    )
    await expectRefusal(
      t.mutation(internal.admin.removeOperator, { email: '  ' }),
      'bad_request',
      /email required/,
    )
    expect(await auditRows(t)).toHaveLength(0)
  })

  it('clears a stale admin role with no enrolment, then repeats as a silent no-op', async () => {
    const t = newAuthT()
    const sole = await plantOperator(t, 'sole@platform.test')
    await plantOperator(t, 'stale@platform.test', { enrolled: false })

    /* no platform_admins row — the last-operator guard must not fire */
    await t.mutation(internal.admin.removeOperator, { email: 'stale@platform.test' })
    expect(await authRole(t, 'stale@platform.test')).toBe('user')
    expect(await operatorIds(t)).toEqual([sole])
    expect(await auditRows(t)).toHaveLength(1)

    /* nothing left to change: no throw, no second audit row */
    await t.mutation(internal.admin.removeOperator, { email: 'stale@platform.test' })
    expect(await auditRows(t)).toHaveLength(1)
  })
})
