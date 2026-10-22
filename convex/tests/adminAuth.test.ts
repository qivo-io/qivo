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

import { describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LOGIN_PURGE } from '../adminAuth'
import authSchema from '../betterAuth/schema'
import { expectRefusal, newT, runInAuth, type T, uuid, withOrg } from './helpers.setup'

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

  /* createBreakGlass refuses demo mode, and the dashboard and deploy keys
   * can run this mutation without it. */
  it('refuses a demo deployment and writes nothing', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const profiles = () => t.run((ctx) => ctx.db.query('profiles').collect())
    const before = await profiles()
    vi.stubEnv('APP_MODE', 'demo')
    try {
      await expectRefusal(
        t.mutation(internal.adminAuth.insertBreakGlass, {
          org_id: f.org.id,
          email: 'rescue@test.local',
          name: 'Recovery Admin',
          auth_user_id: 'ba-rescue',
          actor,
        }),
        'forbidden',
        /requires a regular workspace/,
      )
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await profiles()).toEqual(before)
    expect(await auditRows(t)).toEqual([])
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
    // the fixture's guest login, whose email a seat carries (home or guest
    // alike), is not an orphan
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: f.guest.email as string }),
      'conflict',
      /that login belongs to a member, so remove the member instead/,
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

  it('reaps an orphan whose provider login kept a Unicode domain, typed as the login shows it', async () => {
    const t = newAuthT()
    await plantLogin(t, 'anna@bücher.de')
    await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'Anna@Bücher.de' })
    expect(await componentRow(t, 'user', 'email', 'anna@bücher.de')).toBeNull()
  })

  /* The MCP OAuth provider's rows and the roadmap undo receipts of `userId`,
   * planted as a connected assistant and a recent roadmap edit leave them. */
  const plantGrants = (t: T, userId: string) =>
    Promise.all([
      runInAuth(t, async (ctx) => {
        const at = Date.now()
        const grant = { clientId: 'mcp-client', userId, scopes: ['qivo:read'], createdAt: at }
        await ctx.db.insert('oauthAccessToken', { ...grant, token: `access-${userId}` })
        await ctx.db.insert('oauthRefreshToken', { ...grant, token: `refresh-${userId}` })
        await ctx.db.insert('oauthConsent', grant)
      }),
      t.run(async (ctx) => {
        await ctx.db.insert('roadmap_history', {
          auth_user_id: userId,
          session_key: 'roadmap-session',
          position: 1,
          expires_at: Date.now() + 60_000,
          changes: '[]',
        })
      }),
    ])

  /* How many of those rows `userId` still holds. */
  const grantsOf = async (t: T, userId: string) =>
    (
      await runInAuth(t, async (ctx) => [
        ...(await ctx.db
          .query('oauthAccessToken')
          .withIndex('userId', (q) => q.eq('userId', userId))
          .collect()),
        ...(await ctx.db
          .query('oauthRefreshToken')
          .withIndex('userId', (q) => q.eq('userId', userId))
          .collect()),
        ...(await ctx.db
          .query('oauthConsent')
          .withIndex('userId', (q) => q.eq('userId', userId))
          .collect()),
      ])
    ).length +
    (
      await t.run(async (ctx) =>
        ctx.db
          .query('roadmap_history')
          .withIndex('by_owner_session', (q) => q.eq('auth_user_id', userId))
          .collect(),
      )
    ).length

  it("also removes the orphan's OAuth grants and undo receipts, and nobody else's", async () => {
    const t = newAuthT()
    const orphan = await plantLogin(t, 'leftover@test.local', { session: true, account: true })
    const other = await plantLogin(t, 'someone-else@test.local', { session: true })
    await plantGrants(t, orphan._id)
    await plantGrants(t, other._id)
    expect(await grantsOf(t, orphan._id)).toBe(4)
    await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'leftover@test.local' })
    expect(await grantsOf(t, orphan._id)).toBe(0)
    expect(await grantsOf(t, other._id)).toBe(4)
    expect(await componentRow(t, 'session', 'userId', other._id)).not.toBeNull()
  })

  it('removes the login at once and a token backlog in bounded steps', async () => {
    const t = newAuthT()
    const limits = { ...LOGIN_PURGE }
    Object.assign(LOGIN_PURGE, { rows: 3, receipts: 2 })
    vi.useFakeTimers()
    try {
      const orphan = await plantLogin(t, 'leftover@test.local', { session: true, account: true })
      // a long-lived assistant's refreshes: four access and four refresh tokens
      await runInAuth(t, async (ctx) => {
        const grant = { clientId: 'mcp-client', userId: orphan._id, scopes: ['qivo:read'] }
        for (let n = 0; n < 4; n++) {
          const at = Date.now() + n
          await ctx.db.insert('oauthAccessToken', { ...grant, createdAt: at, token: `a${n}` })
          await ctx.db.insert('oauthRefreshToken', { ...grant, createdAt: at, token: `r${n}` })
        }
      })
      // and a busy roadmap session's undo receipts
      await t.run(async (ctx) => {
        for (let n = 0; n < 4; n++)
          await ctx.db.insert('roadmap_history', {
            auth_user_id: orphan._id,
            session_key: 'roadmap-session',
            position: n,
            expires_at: Date.now() + 60_000,
            changes: '[]',
          })
      })
      const tokensLeft = async () => {
        let n = await runInAuth(t, async (ctx) => {
          let rows = 0
          for (const table of ['session', 'oauthAccessToken', 'oauthRefreshToken'] as const)
            rows += (
              await ctx.db
                .query(table)
                .withIndex('userId', (q) => q.eq('userId', orphan._id))
                .collect()
            ).length
          return rows
        })
        n += await t.run(
          async (ctx) =>
            (
              await ctx.db
                .query('roadmap_history')
                .withIndex('by_owner_session', (q) => q.eq('auth_user_id', orphan._id))
                .collect()
            ).length,
        )
        return n
      }
      expect(await tokensLeft()).toBe(13)
      await t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'leftover@test.local' })
      // the login, its account and the audit row go in the first transaction
      expect(await componentRow(t, 'user', '_id', orphan._id)).toBeNull()
      expect(await componentRow(t, 'account', 'userId', orphan._id)).toBeNull()
      expect((await auditRows(t)).map((r) => r.action)).toEqual(['delete_orphan'])
      expect(await tokensLeft()).toBe(10)
      await t.finishAllScheduledFunctions(() => vi.runAllTimers())
      expect(await tokensLeft()).toBe(0)
    } finally {
      Object.assign(LOGIN_PURGE, limits)
      vi.useRealTimers()
    }
  })

  it('refuses to purge the sessions of a login that still exists', async () => {
    const t = newAuthT()
    const login = await plantLogin(t, 'still-here@test.local', { session: true })
    await expectRefusal(
      t.mutation(internal.adminAuth.purgeLoginTokens, { auth_user_id: login._id }),
      'rule',
      /still exists/,
    )
    expect(await componentRow(t, 'session', 'userId', login._id)).not.toBeNull()
  })

  it("refuses a platform operator's login and removes nothing", async () => {
    const t = newAuthT()
    const { userId } = await plantOperator(t)
    await plantGrants(t, userId)
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: 'operator@test.local' }),
      'conflict',
      /platform operator; run admin:removeOperator first/,
    )
    expect(await componentRow(t, 'user', '_id', userId)).not.toBeNull()
    expect(await grantsOf(t, userId)).toBe(4)
    expect(await auditRows(t)).toEqual([])
  })

  it('still refuses a member login and leaves its grants', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const member = f.guest.auth_user_id as string
    await plantGrants(t, member)
    await expectRefusal(
      t.mutation(internal.adminAuth.deleteOrphanLogin, { email: f.guest.email as string }),
      'conflict',
      /remove the member instead/,
    )
    expect(await grantsOf(t, member)).toBe(4)
  })
})
