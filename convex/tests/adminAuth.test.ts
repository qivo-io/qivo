/* Operator auth actions (adminAuth.ts) under convex-test, with the LOCAL
 * Better Auth component registered (the /test export's register() would mount
 * the published component schema, which lacks the admin fields — the local
 * install is the one deployed, so it is the one tested). Adapter-level flows
 * are real here: user/session/account rows live in the component's namespace
 * and are reached through components.betterAuth.adapter.*. The full HTTP
 * surface (sign-in, JWT mint) still belongs to the browser smoke; the
 * capture flow itself (requestPasswordReset → createCaptureAuth ref) runs
 * in-process and is exercised end-to-end below.
 *
 * Env: better-auth's context wants a secret at first api call, and auth.ts
 * reads SITE_URL/CONVEX_SITE_URL — planted before any action runs. */

import { describe, expect, it } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { expectRefusal, newT, type T, uuid, withOrg } from './helpers.setup'

declare const process: { env: Record<string, string | undefined> }
process.env.BETTER_AUTH_SECRET ??= 'adminAuth-test-secret-not-a-real-deployment'
process.env.SITE_URL ??= 'http://localhost:5199'
process.env.CONVEX_SITE_URL ??= 'http://convex.site.test'

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}

type ComponentUser = { _id: string; email: string }

/* Seed a Better Auth user (and optionally session/account rows) through the
 * component adapter — the same trust position as the deployed seeds. */
async function plantLogin(
  t: T,
  email: string,
  opts: { session?: boolean; account?: boolean } = {},
): Promise<ComponentUser> {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: email.split('@')[0],
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as ComponentUser
    if (opts.session === true) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'session',
          data: {
            expiresAt: now + 3_600_000,
            token: `tok_${email}`,
            createdAt: now,
            updatedAt: now,
            userId: user._id,
          },
        },
      })
    }
    if (opts.account === true) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'account',
          data: {
            accountId: user._id,
            providerId: 'credential',
            userId: user._id,
            password: 'hash:not-a-real-hash',
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    }
    return user
  })
}

const componentRow = (t: T, model: 'user' | 'session' | 'account', field: string, value: string) =>
  t.run(
    async (ctx) =>
      await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model,
        where: [{ field, value }],
      }),
  )

async function plantOperator(t: T): Promise<{ userId: string }> {
  const user = await plantLogin(t, 'operator@test.local')
  await t.run(async (ctx) => {
    await ctx.db.insert('platform_admins', {
      auth_user_id: user._id,
      note: 'test operator',
      created_at: '2026-01-01T00:00:00.000Z',
    })
  })
  return { userId: user._id }
}

const auditRows = (t: T): Promise<Doc<'platform_audit_log'>[]> =>
  t.run(async (ctx) => await ctx.db.query('platform_audit_log').collect())

describe('operator gate', () => {
  it('no identity and non-operator identity both get the 403 sentence', async () => {
    const t = newAuthT()
    await expectRefusal(
      t.action(api.adminAuth.recoveryLink, { email: 'x@y.test' }),
      'forbidden',
      /platform admins only/,
    )
    const stranger = await plantLogin(t, 'stranger@test.local')
    await expectRefusal(
      t
        .withIdentity({ subject: stranger._id })
        .action(api.adminAuth.recoveryLink, { email: 'x@y.test' }),
      'forbidden',
      /platform admins only/,
    )
  })
})

describe('recoveryLink — the one-shot capture', () => {
  it('captures a real reset URL synchronously and audits as the operator', async () => {
    const t = newAuthT()
    const op = await plantOperator(t)
    await plantLogin(t, 'maya@test.local', { account: true })
    const { link } = await t
      .withIdentity({ subject: op.userId })
      .action(api.adminAuth.recoveryLink, { email: 'maya@test.local' })
    expect(link).toMatch(/\/reset-password\/[A-Za-z0-9_-]+/)
    expect(link).toContain('callbackURL=')
    const rows = await auditRows(t)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('recovery_link')
    expect(rows[0].actor_email).toBe('operator@test.local')
    expect(rows[0].actor_auth_id).toBe(op.userId)
    expect(rows[0].detail).toEqual({ email: 'maya@test.local' })
    // nothing stored anywhere: the link lives only in the action's return value
    const stray = await t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter((r) =>
        JSON.stringify(r.detail).includes('reset-password'),
      ),
    )
    expect(stray).toHaveLength(0)
  })

  it('an unknown email is user-not-found, never a mailer error', async () => {
    const t = newAuthT()
    const op = await plantOperator(t)
    await expectRefusal(
      t
        .withIdentity({ subject: op.userId })
        .action(api.adminAuth.recoveryLink, { email: 'nobody@test.local' }),
      'not_found',
      /no login found for that email/,
    )
  })
})

describe('insertBreakGlass — the one-transaction write', () => {
  const actor = { auth_user_id: 'op-auth-id', email: 'operator@test.local' }

  it('inserts the RA profile, claims it explicitly, and audits in the same transaction', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    await t.mutation(internal.adminAuth.insertBreakGlass, {
      org_id: f.org.id,
      email: 'rescue@test.local',
      name: 'Recovery Admin',
      auth_user_id: 'ba-user-rescue',
      actor,
    })
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', 'rescue@test.local'))
        .unique(),
    )
    expect(profile).not.toBeNull()
    expect(profile?.org_role).toBe('admin')
    expect(profile?.initials).toBe('RA')
    expect(profile?.color).toBe('#DC2626')
    // the explicit claimSeatsForLogin call — no auth-trigger side effect left
    expect(profile?.auth_user_id).toBe('ba-user-rescue')
    expect(profile?.accepted_at).toBeDefined()
    const rows = await auditRows(t)
    expect(rows.map((r) => r.action)).toEqual(['create_break_glass'])
    expect(rows[0].target_org_id).toBe(f.org.id)
    expect(rows[0].target_profile_id).toBe(profile?.id)
  })

  it('refuses duplicate emails and missing orgs, while recovery admins can exceed old seat allowances', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    await expectRefusal(
      t.mutation(internal.adminAuth.insertBreakGlass, {
        org_id: f.org.id,
        email: f.user.email as string,
        name: 'Recovery Admin',
        auth_user_id: 'ba-x',
        actor,
      }),
      'conflict',
      /a member with that email already exists/,
    )
    await expectRefusal(
      t.mutation(internal.adminAuth.insertBreakGlass, {
        org_id: uuid(),
        email: 'rescue@test.local',
        name: 'Recovery Admin',
        auth_user_id: 'ba-x',
        actor,
      }),
      'not_found',
      /organization not found/,
    )
    // Recovery admins count toward billing; no purchased seat blocks rescue.
    await t.mutation(internal.adminAuth.insertBreakGlass, {
      org_id: f.org.id,
      email: 'rescue@test.local',
      name: 'Recovery Admin',
      auth_user_id: 'ba-rescue-1',
      actor,
    })
    await t.mutation(internal.adminAuth.insertBreakGlass, {
      org_id: f.org.id,
      email: 'rescue2@test.local',
      name: 'Recovery Admin',
      auth_user_id: 'ba-rescue-2',
      actor,
    })
    // the refused attempts audited nothing
    const rows = await auditRows(t)
    expect(rows.map((r) => r.action)).toEqual(['create_break_glass', 'create_break_glass'])
  })
})

describe('deleteOrphanLogin', () => {
  it('an unknown email is not found; a member login is refused with the edge sentence', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'ghost@test.local' }),
      'not_found',
      /no auth account with that email/,
    )
    // login whose email a seat carries (home or guest alike) — not an orphan
    await plantLogin(t, f.guest.email as string)
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: f.guest.email as string }),
      'conflict',
      /that login belongs to a member — remove the member instead/,
    )
    // belt-and-braces: a seat pointing at the user id, email long gone
    const moved = await plantLogin(t, 'old-address@test.local')
    await t.run(async (ctx) => {
      const seat = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', f.viewer.id))
        .unique()
      if (seat === null) throw new Error('fixture seat vanished')
      await ctx.db.patch(seat._id, { auth_user_id: moved._id })
    })
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'old-address@test.local' }),
      'conflict',
      /remove the member instead/,
    )
  })

  it('reaps a true orphan — user, sessions and accounts — and audits as cli', async () => {
    const t = newAuthT()
    const orphan = await plantLogin(t, 'leftover@test.local', { session: true, account: true })
    await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'leftover@test.local' })
    expect(await componentRow(t, 'user', 'email', 'leftover@test.local')).toBeNull()
    expect(await componentRow(t, 'session', 'userId', orphan._id)).toBeNull()
    expect(await componentRow(t, 'account', 'userId', orphan._id)).toBeNull()
    const rows = await auditRows(t)
    expect(rows.map((r) => r.action)).toEqual(['delete_orphan'])
    expect(rows[0].actor_email).toBe('cli')
    expect(rows[0].detail).toEqual({ email: 'leftover@test.local' })
  })
})
