/// <reference types="vite/client" />
import { createFunctionHandle, makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc, TableNames } from '../_generated/dataModel'
import { createAuth, createAuthOptions } from '../auth'
import authSchema from '../betterAuth/schema'
import { MARKETING_DEMO, MARKETING_DEMO_VERSION } from '../internal/marketingDemoData'
import { accessOf, ordinaryOf } from '../lib/access'
import { byId } from '../lib/db'
import {
  DEMO_INSERTS_TOTAL,
  DEMO_MAX_PAYLOAD_BYTES,
  DEMO_TTL_MS,
  DEMO_WRITES_PER_MINUTE,
  DEMO_WRITES_TOTAL,
} from '../lib/demo'
import { DEMO_UNAVAILABLE } from '../lib/demoRefusals'
import {
  NORTHSTAR_STEPS,
  newNorthstarRun,
  PUBLIC_DEMO_CALL_SIZES,
  PUBLIC_DEMO_CALLS,
  PUBLIC_DEMO_STEPS,
  stepCalls,
} from '../model/demoSeed'
import schema from '../schema'
import { expectRefusal, newT, type T, uuid, workspaceOf } from './helpers.setup'
import { NORTHSTAR, plantNorthstar } from './northstar.setup'
import { forgetUsedId } from './trash.setup'

const componentModules = import.meta.glob('../betterAuth/**/*.ts')
let t: T

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
  vi.stubEnv('CONVEX_SITE_URL', 'https://some.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-hermetic-secret-never-a-deployment-314159')
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
  t = newT()
  t.registerComponent('betterAuth', authSchema, componentModules)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Drive the actual component adapter's transactional onCreate handles.
 * This covers the user-write/receipt and session-write/clamp atomicity. */
async function anonymousLogin(on = t) {
  const now = Date.now()
  const user = await on.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'Nora',
          email: `visitor-${uuid()}@demo.qivo.invalid`,
          emailVerified: false,
          isAnonymous: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      onCreateHandle: await createFunctionHandle(internal.authTriggers.onCreate),
    }),
  )
  const session = await on.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'session',
        data: {
          token: uuid(),
          userId: user._id as string,
          expiresAt: now + 7 * DEMO_TTL_MS,
          createdAt: now,
          updatedAt: now,
        },
      },
      onCreateHandle: await createFunctionHandle(internal.authTriggers.onCreate),
    }),
  )
  const as = on.withIdentity({ subject: user._id as string, sessionId: session._id as string })
  return { user, session, as }
}

type Counts = Partial<
  Pick<
    Doc<'demo_write_counts'>,
    'write_window_at' | 'write_window_count' | 'write_count' | 'insert_count'
  >
>

/** The write and insert counters of the demo with receipt `receipt`. */
const countsOf = (receipt: Doc<'demo_sessions'>) =>
  t.run((ctx) =>
    ctx.db
      .query('demo_write_counts')
      .withIndex('by_demo', (q) => q.eq('demo_id', receipt.id))
      .unique(),
  )

/** Sets the demo's counters, as many writes would have left them. */
const setCounts = (receipt: Doc<'demo_sessions'>, counts: Counts) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('demo_write_counts')
      .withIndex('by_demo', (q) => q.eq('demo_id', receipt.id))
      .unique()
    if (row) await ctx.db.patch(row._id, counts)
    else await ctx.db.insert('demo_write_counts', { demo_id: receipt.id, ...counts })
  })

/** Calls ensureMine as the browser does, until the demo is ready, and
 * answers every reply. */
async function provision(as: Awaited<ReturnType<typeof anonymousLogin>>['as']) {
  const answers = [await as.mutation(api.demo.ensureMine, {})]
  while (answers.at(-1)?.status === 'unprovisioned' && answers.length < 100)
    answers.push(await as.mutation(api.demo.ensureMine, {}))
  return answers
}

async function readyDemo() {
  const login = await anonymousLogin()
  const demo = (await provision(login.as)).at(-1)!
  const snapshot = await workspaceOf(login.as)
  if (!snapshot || !demo.orgId) throw new Error('demo did not become ready')
  const receipt = await t.run((ctx) =>
    ctx.db
      .query('demo_sessions')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', login.user._id as string))
      .unique(),
  )
  if (!receipt) throw new Error('missing receipt')
  const profile = await t.run((ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_auth', (q) => q.eq('auth_user_id', login.user._id as string))
      .unique(),
  )
  if (!profile) throw new Error('missing profile')
  return { ...login, demo, snapshot, receipt, profile }
}

describe('public demo ownership and authentication', () => {
  it('atomically tracks an abandoned identity and clamps its session to the original deadline', async () => {
    const login = await anonymousLogin()
    const receipts = await t.run((ctx) => ctx.db.query('demo_sessions').collect())
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      auth_user_id: login.user._id,
      status: 'unprovisioned',
      created_at: Date.now(),
      expires_at: Date.now() + DEMO_TTL_MS,
    })
    expect(receipts[0].org_id).toBeUndefined()
    expect(login.session.expiresAt).toBe(receipts[0].expires_at)
    const job = await t.run((ctx) => ctx.db.system.get(receipts[0].expiry_scheduled_id!))
    expect(job?.scheduledTime).toBe(receipts[0].expires_at)
    expect(job?.name).toBe('demo:expire')
  })

  it('rolls the auth allocation back if admission is closed or the deployment is the main app', async () => {
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'false')
    await expectRefusal(anonymousLogin(), 'forbidden', /unavailable/)
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
    vi.stubEnv('SITE_URL', 'https://qivo.io')
    await expectRefusal(anonymousLogin(), 'forbidden', /main deployment/)
    expect(await t.run((ctx) => ctx.db.query('demo_sessions').collect())).toEqual([])
    const users = await t.query(components.betterAuth.adapter.findMany, {
      model: 'user',
      paginationOpts: { cursor: null, numItems: 100 },
    })
    expect(users.page).toEqual([])
  })

  it('resumes one organization under simultaneous provisioning and later admission closure', async () => {
    const login = await anonymousLogin()
    const started = await Promise.all([
      login.as.mutation(api.demo.ensureMine, {}),
      login.as.mutation(api.demo.ensureMine, {}),
    ])
    // the two calls ran one after the other, each one step
    expect(started.map((answer) => answer.progress?.step).sort()).toEqual([1, 2])
    const first = (await provision(login.as)).at(-1)!
    expect(first.status).toBe('ready')
    expect(await t.run((ctx) => ctx.db.query('organizations').collect())).toHaveLength(1)
    expect(await login.as.query(api.appearance.get, {})).toEqual({
      mode: 'dark',
      image_source: 'daily',
      custom_image: null,
    })
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'false')
    const resumed = await login.as.mutation(api.demo.ensureMine, {})
    expect(resumed).toEqual(first)
  })

  it('requires a real anonymous account and refuses unprovisioned ordinary data', async () => {
    await expectRefusal(t.mutation(api.demo.ensureMine, {}), 'forbidden', /not signed in/)
    const login = await anonymousLogin()
    await expectRefusal(login.as.query(api.workspace.root, {}), 'forbidden', /prepared/)
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: login.user._id as string }],
        update: { isAnonymous: false },
      },
    })
    await expectRefusal(
      login.as.mutation(api.demo.ensureMine, {}),
      'forbidden',
      /temporary demo login/,
    )
  })

  it("provisions only in the token's live session of an existing anonymous login", async () => {
    const login = await anonymousLogin()
    const other = await anonymousLogin()
    const userId = login.user._id as string
    const sessionId = login.session._id as string
    const refused = (as: typeof login.as) =>
      expectRefusal(as.mutation(api.demo.ensureMine, {}), 'forbidden', /temporary demo login/)
    const step = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query('demo_sessions')
            .withIndex('by_auth_user', (q) => q.eq('auth_user_id', userId))
            .unique(),
        )
      )?.provision?.step
    expect(await login.as.mutation(api.demo.ensureMine, {})).toMatchObject({
      status: 'unprovisioned',
      progress: { step: 1 },
    })
    // A token without a session, or with another login's live session.
    await refused(t.withIdentity({ subject: userId }))
    await refused(t.withIdentity({ subject: userId, sessionId: other.session._id as string }))
    await refused(t.withIdentity({ subject: userId, sessionId: 'not-a-session-id' }))
    // The session at its expiry, then gone.
    const setSession = (update: { expiresAt: number }) =>
      t.mutation(components.betterAuth.adapter.updateOne, {
        input: { model: 'session', where: [{ field: '_id', value: sessionId }], update },
      })
    await setSession({ expiresAt: Date.now() })
    await refused(login.as)
    await setSession({ expiresAt: Number.NaN })
    await refused(login.as)
    await setSession({ expiresAt: Date.now() + 1 })
    expect(await login.as.mutation(api.demo.ensureMine, {})).toMatchObject({
      progress: { step: 2 },
    })
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'session', where: [{ field: '_id', value: sessionId }] },
    })
    await refused(login.as)
    // A live session whose login is gone. No trigger runs on this raw
    // delete, so the receipt is still active.
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: other.user._id as string }] },
    })
    await refused(other.as)
    expect(await step()).toBe(2)
  })

  it('disables anonymous auth on normal deployments and preserves stable plugin schema', async () => {
    const anonymousSignIn = () =>
      createAuth({} as never).handler(
        new Request('https://some.convex.site/api/auth/sign-in/anonymous', { method: 'POST' }),
      )
    const demo = createAuthOptions({} as never)
    expect(demo.session).toEqual({ expiresIn: 86400, disableSessionRefresh: true })
    expect(demo.emailAndPassword.enabled).toBe(false)
    vi.stubEnv('APP_MODE', 'normal')
    const normal = createAuthOptions({} as never)
    expect(normal.emailAndPassword.enabled).toBe(true)
    expect((await anonymousSignIn()).status).toBe(404)
    const shape = createAuthOptions({} as never, { schemaOnly: true })
    expect(shape.plugins.some((plugin) => plugin.id === 'anonymous')).toBe(true)
  })

  it('creates a real anonymous HTTP session and signs JWTs capped at the fixed deadline', async () => {
    const http = (
      path: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<Response> => (t as unknown as { fetch: typeof http }).fetch(path, init)
    const login = await http('/api/auth/sign-in/anonymous', {
      method: 'POST',
      headers: {
        Origin: 'https://demo.qivo.io',
        'Content-Type': 'application/json',
        'Better-Auth-Cookie': '',
      },
      body: '{}',
    })
    expect(login.status).toBe(200)
    const cookie = login.headers
      .get('Set-Better-Auth-Cookie')
      ?.match(/(?:^|,\s*)([^=;,]*session_token=[^;]+)/)?.[1]
    expect(cookie).toBeTruthy()
    const receipt = (await t.run((ctx) => ctx.db.query('demo_sessions').collect()))[0]
    expect(receipt.status).toBe('unprovisioned')
    vi.setSystemTime(receipt.expires_at - 30_000)
    const tokenResponse = await http('/api/auth/convex/token', {
      headers: { Origin: 'https://demo.qivo.io', 'Better-Auth-Cookie': cookie! },
    })
    expect(tokenResponse.status).toBe(200)
    const { token } = JSON.parse(await tokenResponse.text()) as { token: string }
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp: number
    }
    expect(payload.exp).toBe(Math.floor(receipt.expires_at / 1000))
    const verifications = await t.query(components.betterAuth.adapter.findMany, {
      model: 'verification',
      paginationOpts: { cursor: null, numItems: 100 },
    })
    expect(verifications.page).toEqual([])
    vi.setSystemTime(receipt.expires_at + 1)
    const expired = await http('/api/auth/convex/token', {
      headers: { Origin: 'https://demo.qivo.io', 'Better-Auth-Cookie': cookie! },
    })
    expect(expired.status).toBe(401)
  })

  it('refuses external auth routes and foreign-origin admission before allocating data', async () => {
    const fetch = (
      path: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<Response> => (t as unknown as { fetch: typeof fetch }).fetch(path, init)
    const request = {
      method: 'POST',
      headers: { Origin: 'https://demo.qivo.io', 'Content-Type': 'application/json' },
      body: '{}',
    }
    for (const path of [
      '/sign-up/email',
      '/sign-in/social',
      '/request-password-reset',
      '/link-social',
      '/admin/create-user',
      '/oauth2/register',
    ]) {
      expect((await fetch(`/api/auth${path}`, request)).status).toBe(403)
    }
    // Convex checks the demo's tokens with its keys, never this discovery
    const discovery = await fetch('/api/auth/convex/.well-known/openid-configuration', {
      method: 'GET',
      headers: { Origin: 'https://demo.qivo.io' },
    })
    expect(discovery.status).toBe(403)
    // the demo has no authorization server, and serves no metadata for one
    for (const path of [
      '/.well-known/openid-configuration',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const answer = await fetch(path, {
        method: 'GET',
        headers: { Origin: 'https://demo.qivo.io' },
      })
      expect([path, answer.status, answer.headers.get('Location')]).toEqual([path, 404, null])
    }
    // and its MCP endpoint refuses without pointing a client at one
    const mcp = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(mcp.status).toBe(403)
    expect(mcp.headers.get('WWW-Authenticate')).toBeNull()
    expect(await mcp.json()).toEqual({
      error: 'The Qivo demo does not serve MCP. Connect your client to a regular Qivo workspace.',
    })
    expect(
      (
        await fetch('/api/auth/sign-in/anonymous', {
          ...request,
          headers: { ...request.headers, Origin: 'https://foreign.invalid' },
        })
      ).status,
    ).toBe(403)
    expect(await t.run((ctx) => ctx.db.query('demo_sessions').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('demo_admission').collect())).toEqual([])
    const users = await t.query(components.betterAuth.adapter.findMany, {
      model: 'user',
      paginationOpts: { cursor: null, numItems: 100 },
    })
    expect(users.page).toEqual([])
  })
})

describe('demo lifetime and capabilities', () => {
  it('permits shortened smoke deadlines only in an explicitly enabled localhost development deployment', async () => {
    const expireOwned = makeFunctionReference<
      'mutation',
      { auth_user_id: string; expected_site_url: string; delay_ms: number },
      { expiresAt: number }
    >('internal/demoTest:expireOwned')
    const a = await readyDemo()
    await expectRefusal(
      t.mutation(expireOwned, {
        auth_user_id: a.user._id as string,
        expected_site_url: 'https://demo.qivo.io',
        delay_ms: 1000,
      }),
      'forbidden',
      /localhost/,
    )
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    vi.stubEnv('DEMO_TEST_CONTROLS', 'true')
    vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:demo-tests')
    const args = {
      auth_user_id: a.user._id as string,
      expected_site_url: 'http://localhost:5199',
      delay_ms: 2000,
    }
    await expectRefusal(t.mutation(expireOwned, args), 'forbidden', /localhost/)
    vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:demo-tests')
    const short = await t.mutation(expireOwned, args)
    expect(short.expiresAt).toBe(Date.now() + 2000)
    const session = await t.query(components.betterAuth.adapter.findOne, {
      model: 'session',
      where: [{ field: '_id', value: a.session._id as string }],
    })
    expect(session?.expiresAt).toBe(short.expiresAt)
    await expectRefusal(
      t.mutation(expireOwned, { ...args, delay_ms: 60_000 }),
      'forbidden',
      /between/,
    )
    vi.setSystemTime(short.expiresAt)
    await expectRefusal(a.as.query(api.workspace.root, {}), 'forbidden', /expired/)
  })

  it('refuses old identities at the deadline even before the cleanup job runs', async () => {
    const a = await readyDemo()
    const deadline = a.receipt.expires_at
    vi.setSystemTime(deadline - 1)
    await a.as.mutation(api.profiles.setDisplayName, { name: 'Before expiry' })
    expect(await t.query(internal.demo.tokenDeadline, { auth_user_id: a.user._id as string })).toBe(
      deadline,
    )
    vi.setSystemTime(deadline)
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'After expiry' }),
      'forbidden',
      /expired/,
    )
    await expectRefusal(a.as.query(api.workspace.root, {}), 'forbidden', /expired/)
    await expectRefusal(
      a.as.mutation(api.demo.ensureMine, {}),
      'forbidden',
      /temporary demo login|expired/,
    )
    await expectRefusal(
      t.query(internal.demo.tokenDeadline, { auth_user_id: a.user._id as string }),
      'forbidden',
      /expired/,
    )
    expect((await a.as.query(api.demo.current, {})).status).toBe('expired')
    await t.mutation(internal.demo.expire, { id: a.receipt.id })
    expect((await t.run((ctx) => ctx.db.get(a.receipt._id)))?.status).toBe('deleting')
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: 'session',
        where: [{ field: '_id', value: a.session._id as string }],
      }),
    ).toBeNull()
  })

  it('prevents cross-copy reads and email fan-out even with an accidentally duplicated address', async () => {
    const a = await readyDemo(),
      b = await readyDemo()
    await t.run(async (ctx) => ctx.db.patch(b.profile._id, { email: a.profile.email }))
    await a.as.mutation(api.profiles.setDisplayName, { name: 'My private Nora' })
    expect((await t.run((ctx) => ctx.db.get(b.profile._id)))?.name).toBe(b.profile.name)
    await a.as.mutation(api.profiles.setMessageRetention, { days: 30 })
    expect((await t.run((ctx) => ctx.db.get(b.profile._id)))?.message_retention_days).toBe(
      b.profile.message_retention_days,
    )
    await expectRefusal(
      a.as.mutation(api.orgs.update, { org_id: b.demo.orgId!, patch: { name: 'Intrusion' } }),
      'forbidden',
      /no profile/,
    )
    const mine = await workspaceOf(a.as)
    expect(JSON.stringify(mine)).not.toContain(b.demo.orgId)
  }, 30_000)

  it('refuses invitations, additional organizations, credential minting, API access and editable synthetic email', async () => {
    const a = await readyDemo()
    await expectRefusal(
      a.as.mutation(api.identity.createOrganization, { name: 'Escape' }),
      'forbidden',
      /regular workspace/,
    )
    await expectRefusal(
      a.as.mutation(api.profiles.update, {
        org_id: a.demo.orgId!,
        id: a.profile.id,
        patch: { email: 'someone@example.com' },
      }),
      'forbidden',
      /regular workspace/,
    )
    await expectRefusal(
      a.as.mutation(api.tokens.createMcpToken, {
        id: uuid(),
        profile_id: a.profile.id,
        name: 'Escape',
        token_prefix: 'qvt_test',
        token_hash: 'a'.repeat(64),
        access: 'write',
      }),
      'forbidden',
      /regular workspace/,
    )
    expect(
      await t.query(internal.oauthAccess.lookupAccess, {
        tokenHash: 'anything',
        resource: 'anything',
      }),
    ).toBeNull()
    // API access lists and revokes nothing in a demo, even for its admin
    for (const read of [
      a.as.query(api.apiAccess.summary, { org_id: a.demo.orgId! }),
      a.as.query(api.apiAccess.page, { org_id: a.demo.orgId!, kind: 'all', state: 'all' }),
      a.as.query(api.apiAccess.people, { org_id: a.demo.orgId! }),
    ])
      await expectRefusal(read, 'forbidden', /regular workspace/)
    await expectRefusal(
      a.as.mutation(api.apiAccess.revoke, {
        org_id: a.demo.orgId!,
        table: 'mcp_tokens',
        id: uuid(),
      }),
      'forbidden',
      /regular workspace/,
    )
  })

  it('enforces write/record quotas transactionally and refuses large websocket payloads', async () => {
    const a = await readyDemo()
    await setCounts(a.receipt, {
      write_window_at: Date.now(),
      write_window_count: DEMO_WRITES_PER_MINUTE,
    })
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Over budget' }),
      'forbidden',
      /change limit/,
    )
    await setCounts(a.receipt, { write_window_count: 0, insert_count: DEMO_INSERTS_TOTAL })
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Needs an activity row' }),
      'forbidden',
      /record limit/,
    )
    expect((await t.run((ctx) => ctx.db.get(a.profile._id)))?.name).toBe(a.profile.name)
    // a person's first Team sync stamp adds the row that replaced a profile
    // field, which the limit does not count
    await a.as.mutation(api.teamSync.stamp, { org_id: a.demo.orgId!, profile_id: a.profile.id })
    expect(await countsOf(a.receipt)).toMatchObject({ insert_count: DEMO_INSERTS_TOTAL })
    await setCounts(a.receipt, { write_count: DEMO_WRITES_TOTAL, insert_count: 0 })
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Over the total' }),
      'forbidden',
      /change limit/,
    )
    await setCounts(a.receipt, { write_count: 0 })
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'x'.repeat(70_000) }),
      'forbidden',
      /too large/,
    )
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: '😀'.repeat(20_000) }),
      'forbidden',
      /too large/,
    )
  })

  it('marks messages read and sets the retention at the record limit without spending a record', async () => {
    const a = await readyDemo()
    const orgId = a.demo.orgId!
    // two unread items, one for markRead and one for markAllRead
    const planted = await t.run(async (ctx) => {
      const issues = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .take(2)
      const ids: string[] = []
      for (const [n, issue] of issues.entries()) {
        const id = uuid()
        await ctx.db.insert('messages', {
          id,
          org_id: orgId,
          recipient_id: a.profile.id,
          issue_id: issue.id,
          issue_title: issue.title,
          kind: 'comment',
          detail: `Comment ${n}`,
          // newer than any seeded message, so each stays its item's newest
          created_at: new Date(Date.now() + 60_000).toISOString(),
        })
        ids.push(id)
      }
      return ids
    })
    expect(planted).toHaveLength(2)
    // each write below adds the visitor's read-message sweep row (model/
    // messages.ts lowerSweepDue), which the record limit does not count
    const sweepRows = () =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query('message_sweeps')
          .withIndex('by_profile', (q) => q.eq('profile_id', a.profile.id))
          .collect()
        for (const row of rows) await ctx.db.delete(row._id)
        return rows.length
      })
    await sweepRows()
    await setCounts(a.receipt, { insert_count: DEMO_INSERTS_TOTAL })
    await a.as.mutation(api.messages.markRead, { org_id: orgId, ids: [planted[0]] })
    expect(await sweepRows()).toBe(1)
    await a.as.mutation(api.messages.markAllRead, { org_id: orgId })
    expect(await sweepRows()).toBe(1)
    await a.as.mutation(api.profiles.setMessageRetention, { days: 30 })
    expect(await sweepRows()).toBe(1)
    expect(await countsOf(a.receipt)).toMatchObject({ insert_count: DEMO_INSERTS_TOTAL })
    const read = await t.run(async (ctx) => {
      const out: (string | undefined)[] = []
      for (const id of planted) out.push((await byId(ctx, 'messages', id))?.read_at)
      return out
    })
    expect(read.every((at) => at !== undefined)).toBe(true)
  })

  it('counts writes beside the receipt, which a write leaves as it was', async () => {
    const a = await readyDemo()
    const receipt = await t.run((ctx) => ctx.db.get(a.receipt._id))
    await a.as.mutation(api.profiles.setDisplayName, { name: 'Counted once' })
    await a.as.mutation(api.profiles.setDisplayName, { name: 'Counted twice' })
    expect(await t.run((ctx) => ctx.db.get(a.receipt._id))).toEqual(receipt)
    expect(await countsOf(a.receipt)).toMatchObject({
      write_window_at: Date.now(),
      write_window_count: 2,
      write_count: 2,
    })
  })

  it('counts a star as one write and its row as one record, and a refused star as nothing', async () => {
    const a = await readyDemo()
    const org_id = a.profile.org_id
    // a top-level project the visitor sees through ordinary access, and
    // one they do not
    const { mine, other } = await t.run(async (ctx) => {
      const tops = (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect()
      ).filter((p) => p.parent_id === undefined && p.archived_at === undefined)
      const access = accessOf(ctx, ordinaryOf(a.profile), tops)
      const seen = await Promise.all(tops.map((p) => access.visible(p.id)))
      return {
        mine: tops.find((_, i) => seen[i]),
        other: tops.find((_, i) => !seen[i]),
      }
    })
    if (mine === undefined) throw new Error('the visitor sees no top-level project')
    const counts = async () => {
      const row = await countsOf(a.receipt)
      return { writes: row?.write_count ?? 0, records: row?.insert_count ?? 0 }
    }
    const star = (project_id: string, favorite = true) =>
      a.as.mutation(api.projectNav.setFavorite, { org_id, project_id, favorite })
    const start = await counts()
    await star(mine.id)
    expect(await counts()).toEqual({ writes: start.writes + 1, records: start.records + 1 })
    await star(mine.id)
    expect(await counts()).toEqual({ writes: start.writes + 2, records: start.records + 1 })
    await star(mine.id, false)
    expect(await counts()).toEqual({ writes: start.writes + 3, records: start.records + 1 })
    // a refused star rolls its write back
    await expectRefusal(star(other?.id ?? uuid()), 'not_found', /^project not found$/)
    expect(await counts()).toEqual({ writes: start.writes + 3, records: start.records + 1 })
  })

  it('starts the counts of a receipt from before them at what it holds', async () => {
    const a = await readyDemo()
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('demo_write_counts')
        .withIndex('by_demo', (q) => q.eq('demo_id', a.receipt.id))
        .unique()
      if (row) await ctx.db.delete(row._id)
      await ctx.db.patch(a.receipt._id, {
        write_window_at: Date.now(),
        write_window_count: DEMO_WRITES_PER_MINUTE - 1,
        write_count: 40,
        insert_count: 7,
      })
    })
    await a.as.mutation(api.profiles.setDisplayName, { name: 'One more' })
    expect(await countsOf(a.receipt)).toMatchObject({
      write_window_count: DEMO_WRITES_PER_MINUTE,
      write_count: 41,
    })
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Over budget' }),
      'forbidden',
      /change limit/,
    )
  })

  it('moves work to Deleted items and back without spending the record limit on moved rows', async () => {
    const a = await readyDemo()
    const org_id = a.profile.org_id
    // a seeded task with its conversation and a comment just under the
    // payload limit, whose stored copy would pass it
    const task = await t.run(async (ctx) => {
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect()
      const leaf = tasks.find(
        (row) => row.archived_at === undefined && !tasks.some((kid) => kid.parent_id === row.id),
      )!
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: leaf.id,
        author: a.profile.id,
        body: 'x'.repeat(DEMO_MAX_PAYLOAD_BYTES - 1000),
        created_at: new Date().toISOString(),
      })
      return leaf
    })
    /* The demo's counters, and the ids of the records a delete or a
     * restore adds besides the rows it moves: items, activity rows and
     * notices. */
    const counters = async () => {
      const counts = await countsOf(a.receipt)
      const ids = await t.run(async (ctx) => {
        const ids: string[] = []
        for (const table of ['deleted_items', 'activity_events', 'messages'] as const)
          for (const row of await ctx.db.query(table).collect())
            if (row.org_id === org_id) ids.push(row._id)
        return ids
      })
      return { inserts: counts?.insert_count ?? 0, writes: counts?.write_count ?? 0, ids }
    }
    const added = (before: { ids: string[] }, after: { ids: string[] }) =>
      after.ids.filter((id) => !before.ids.includes(id)).length
    // near the limit, so a move that counted its rows would be refused
    await setCounts(a.receipt, { insert_count: DEMO_INSERTS_TOTAL - 10 })
    const before = await counters()
    await a.as.mutation(api.issues.deleteDeep, { org_id, id: task.id })
    const deleted = await counters()
    expect(await t.run((ctx) => byId(ctx, 'issues', task.id))).toBeNull()
    expect(deleted.writes).toBe(before.writes + 1)
    // the item and the 'deleted' activity row
    expect(deleted.inserts - before.inserts).toBe(added(before, deleted))
    expect(added(before, deleted)).toBe(2)

    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', task.id))
        .unique(),
    )
    const result = await a.as.mutation(api.deletedItems.restore, { org_id, ids: [item!.id] })
    expect(result.restored).toEqual([item!.id])
    const restored = await counters()
    expect(await t.run((ctx) => byId(ctx, 'issues', task.id))).not.toBeNull()
    expect(restored.writes).toBe(deleted.writes + 1)
    // the 'restored' activity row and the notices to the task's followers
    expect(restored.inserts - deleted.inserts).toBe(added(deleted, restored))
    expect(restored.inserts).toBeLessThanOrEqual(DEMO_INSERTS_TOTAL)
  })
})

describe('public demo records and used ids', () => {
  /** The number of rows in every table. */
  const rowsByTable = () =>
    t.run(async (ctx) => {
      const rows: Record<string, number> = {}
      for (const table of Object.keys(schema.tables) as TableNames[])
        rows[table] = (await ctx.db.query(table).collect()).length
      return rows
    })

  it('spends none of the record limit on the used_ids row of a created task or project, nor one a restore writes', async () => {
    const a = await readyDemo()
    const org_id = a.profile.org_id
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect(),
    )
    const sub = projects.find((p) => p.type === 'project' && p.archived_at === undefined)
    if (sub === undefined) throw new Error('the demo has no sub-project')
    const task = uuid()
    const creates = [
      () =>
        a.as.mutation(api.issues.create, { org_id, id: task, project_id: sub.id, title: 'Mine' }),
      () =>
        a.as.mutation(api.projects.create, {
          org_id,
          id: uuid(),
          type: 'meta',
          key: 'MINE',
          name: 'Mine',
          sort_order: 9,
        }),
    ]
    for (const create of creates) {
      const before = { counts: await countsOf(a.receipt), rows: await rowsByTable() }
      await create()
      const after = { counts: await countsOf(a.receipt), rows: await rowsByTable() }
      const added = (table: string) => after.rows[table] - before.rows[table]
      expect(added('used_ids')).toBe(1)
      // every row the create added counts, but the used_ids row, a task's
      // description and comment count rows and a project's reach rows
      // (model/projectNav.ts), which are part of what they describe, and the
      // counters' own row (lib/demo.ts demoCounts)
      const counted =
        Object.keys(after.rows).reduce((sum, table) => sum + added(table), 0) -
        added('used_ids') -
        added('issue_descriptions') -
        added('task_comment_counts') -
        added('project_reach') -
        added('demo_write_counts')
      expect((after.counts?.insert_count ?? 0) - (before.counts?.insert_count ?? 0)).toBe(counted)
    }

    // a restore that writes the used_ids row again, as for a task stored
    // before that table, spends nothing on it either
    await a.as.mutation(api.issues.deleteDeep, { org_id, id: task })
    await forgetUsedId(t, task)
    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', task))
        .unique(),
    )
    if (item === null) throw new Error('the task is not in Deleted items')
    /* The ids of the records a restore adds besides the rows it moves. */
    const ids = () =>
      t.run(async (ctx) => {
        const found: string[] = []
        for (const table of ['deleted_items', 'activity_events', 'messages'] as const)
          for (const row of await ctx.db.query(table).collect())
            if (row.org_id === org_id) found.push(row._id)
        return found
      })
    const before = { counts: await countsOf(a.receipt), ids: await ids() }
    await a.as.mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    const after = { counts: await countsOf(a.receipt), ids: await ids() }
    expect(await t.run((ctx) => byId(ctx, 'issues', task))).not.toBeNull()
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query('used_ids').collect()).filter((row) => row.row_id === task),
      ),
    ).toHaveLength(1)
    expect((after.counts?.insert_count ?? 0) - (before.counts?.insert_count ?? 0)).toBe(
      after.ids.filter((id) => !before.ids.includes(id)).length,
    )
  })
})

describe('public demo archive rechecks', () => {
  /** The number of rows in every table. */
  const rowsByTable = () =>
    t.run(async (ctx) => {
      const rows: Record<string, number> = {}
      for (const table of Object.keys(schema.tables) as TableNames[])
        rows[table] = (await ctx.db.query(table).collect()).length
      return rows
    })

  /* The demo's archive_rechecks rows, as project ids. */
  const rechecksOf = (orgId: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query('archive_rechecks').collect())
        .filter((row) => row.org_id === orgId)
        .map((row) => row.project_id),
    )

  /* Runs `change` and answers how many records the demo counted for it,
   * and how many rows it added in every table but archive_rechecks, the
   * read-message sweep rows that an archive's notices, stored read, give
   * their recipients, which the record limit does not count either
   * (model/messages.ts lowerSweepDue), and the counters' own row (lib/demo.ts
   * demoCounts). */
  async function spent(receipt: Doc<'demo_sessions'>, change: () => Promise<unknown>) {
    const before = { counts: await countsOf(receipt), rows: await rowsByTable() }
    await change()
    const after = { counts: await countsOf(receipt), rows: await rowsByTable() }
    const added = (table: string) => after.rows[table] - before.rows[table]
    return {
      counted: (after.counts?.insert_count ?? 0) - (before.counts?.insert_count ?? 0),
      rows:
        Object.keys(after.rows).reduce((sum, table) => sum + added(table), 0) -
        added('archive_rechecks') -
        added('message_sweeps') -
        added('demo_write_counts'),
      rechecks: added('archive_rechecks'),
    }
  }

  it("spends none of the record limit on a visitor's rechecks", async () => {
    const a = await readyDemo()
    const org_id = a.profile.org_id
    // a seeded group, made a Done parent that waits for its open subtask
    const { parent, child } = await t.run(async (ctx) => {
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect()
      const child = tasks.find(
        (row) =>
          row.archived_at === undefined &&
          row.parent_id !== undefined &&
          !tasks.some((kid) => kid.parent_id === row.id),
      )
      if (child === undefined) throw new Error('the demo has no open subtask')
      const parent = tasks.find((row) => row.id === child.parent_id)!
      await ctx.db.patch(parent._id, { status: 'done', done_at: '2026-07-01T00:00:00.000Z' })
      return { parent, child }
    })
    const archive = await spent(a.receipt, () =>
      a.as.mutation(api.issues.archive, { org_id, id: child.id }),
    )
    expect(archive.rechecks).toBe(1)
    expect(await rechecksOf(org_id)).toEqual([parent.project_id])
    expect(archive.counted).toBe(archive.rows)

    const project = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect()
      ).find(
        (p) => p.type === 'project' && p.archived_at === undefined && p.id !== parent.project_id,
      ),
    )
    if (project === undefined) throw new Error('the demo has no other sub-project')
    await a.as.mutation(api.projects.archive, { org_id, id: project.id })
    const restore = await spent(a.receipt, () =>
      a.as.mutation(api.projects.unarchive, { org_id, id: project.id }),
    )
    expect(restore.rechecks).toBe(1)
    expect(restore.counted).toBe(restore.rows)
    expect((await rechecksOf(org_id)).sort()).toEqual([parent.project_id, project.id].sort())
  })

  it('keeps one row a project however often a visitor restores it', async () => {
    const a = await readyDemo()
    const org_id = a.profile.org_id
    const project = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect()
      ).find((p) => p.type === 'project' && p.archived_at === undefined),
    )
    if (project === undefined) throw new Error('the demo has no sub-project')
    for (let round = 0; round < 3; round++) {
      await a.as.mutation(api.projects.archive, { org_id, id: project.id })
      await a.as.mutation(api.projects.unarchive, { org_id, id: project.id })
    }
    expect(await rechecksOf(org_id)).toEqual([project.id])
    // a row a run's leg or find phase wrote, or one a run's chain holds and
    // deletes once it is done, is no reason to skip a visitor's
    const stamp = '2026-09-14T02:30:00.000Z'
    for (const other of [{ from_run: stamp }, { due_by: stamp }, { handed_at: stamp }]) {
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query('archive_rechecks').collect())
          await ctx.db.delete(row._id)
        await ctx.db.insert('archive_rechecks', { org_id, project_id: project.id, ...other })
      })
      await a.as.mutation(api.projects.archive, { org_id, id: project.id })
      await a.as.mutation(api.projects.unarchive, { org_id, id: project.id })
      expect(await rechecksOf(org_id), Object.keys(other)[0]).toEqual([project.id, project.id])
    }
  })
})

describe('public demo provisioning steps', () => {
  it('runs every step once, and a step past the call sizes in a call of its own', () => {
    expect(stepCalls([1, 2, 3, 4, 5], [2, 2])).toEqual([[1, 2], [3, 4], [5]])
    expect(stepCalls([1, 2, 3], [2, 2, 2])).toEqual([[1, 2], [3]])
    expect(PUBLIC_DEMO_CALLS.flat()).toEqual(NORTHSTAR_STEPS)
    expect(PUBLIC_DEMO_STEPS).toBe(PUBLIC_DEMO_CALLS.length)
    // The sizes fit today's data. Retune them when this fails.
    expect(PUBLIC_DEMO_CALL_SIZES.reduce((n, size) => n + size, 0)).toBe(NORTHSTAR_STEPS.length)
  })

  // The whole Northstar work in one transaction read 1,612 index ranges
  // and 1,668 documents and wrote about 1,400 documents, which could pass
  // Convex's 1 s mutation limit on a slow backend. Each call runs a few of
  // its steps (PUBLIC_DEMO_CALLS), held to a third of Convex's byte limits
  // and to counts that keep it inside a third of the rest. convex-test does
  // not keep the time limit, so the range budget stands in for it
  // (model/demoSeed.ts PUBLIC_DEMO_CALL_SIZES has the numbers).
  it('provisions a demo in calls inside a budget near their use, every step once', async () => {
    const limited = newT({
      transactionLimits: {
        databaseQueries: 630,
        documentsRead: 900,
        documentsWritten: 650,
        bytesRead: Math.floor((16 * 1024 * 1024) / 3),
        bytesWritten: Math.floor((16 * 1024 * 1024) / 3),
      },
    })
    limited.registerComponent('betterAuth', authSchema, componentModules)
    const login = await anonymousLogin(limited)
    expect((await login.as.query(api.demo.current, {})).progress).toEqual({
      step: 0,
      steps: PUBLIC_DEMO_STEPS,
    })
    const answers = await provision(login.as)
    expect(answers.map((answer) => answer.progress?.step ?? 'ready')).toEqual([
      ...Array.from({ length: PUBLIC_DEMO_STEPS - 1 }, (_, i) => i + 1),
      'ready',
    ])
    expect(answers.at(-1)).toMatchObject({ status: 'ready', progress: null })
    const receipt = await limited.run((ctx) => ctx.db.query('demo_sessions').unique())
    expect(receipt).toMatchObject({ status: 'ready', seed_version: MARKETING_DEMO_VERSION })
    expect(receipt).not.toHaveProperty('provision')
    const org = await limited.run((ctx) => ctx.db.query('organizations').unique())
    expect(org).toMatchObject({ id: answers.at(-1)?.orgId, max_attachment_mb: 5 })
    const tasks = await limited.run((ctx) => ctx.db.query('issues').collect())
    expect(tasks).toHaveLength(MARKETING_DEMO.issues.length)
  })

  it('gives the public demo the notices and follows of a seed that asks person by person', async () => {
    const login = await anonymousLogin()
    await provision(login.as)
    const receipt = (await t.run((ctx) => ctx.db.query('demo_sessions').unique()))!
    // the same data through writeNorthstarWork, which reads no sight up
    // front, at the same anchor and write time (the frozen clock)
    const stepped = await plantNorthstar(t, receipt.anchor, new Date().toISOString())
    const byKey = async (namespace: string, orgId: string) => {
      const { ids } = await newNorthstarRun(namespace)
      const person = new Map(Object.entries(ids.person).map(([key, id]) => [id, key]))
      const issue = new Map(Object.entries(ids.issue).map(([key, id]) => [id, key]))
      return t.run(async (ctx) => ({
        notices: (await ctx.db.query('messages').collect())
          .filter((m) => m.org_id === orgId)
          .map((m) =>
            [
              person.get(m.recipient_id),
              m.actor_id && person.get(m.actor_id),
              issue.get(m.issue_id),
              m.kind,
              m.detail,
            ].join(' '),
          )
          .sort(),
        follows: (await ctx.db.query('issue_subscriptions').collect())
          .filter((follow) => issue.has(follow.issue_id))
          .map((follow) => `${issue.get(follow.issue_id)} ${person.get(follow.profile_id)}`)
          .sort(),
      }))
    }
    const demo = await byKey(`public-demo:${receipt.id}`, receipt.org_id!)
    expect(demo.notices.length).toBeGreaterThan(100)
    expect(demo.follows.length).toBeGreaterThan(100)
    expect(demo).toEqual(await byKey(NORTHSTAR, stepped.org.id))
  })

  it('refuses the workspace until the last step, and resumes at the step a stopped visitor left', async () => {
    const login = await anonymousLogin()
    for (let call = 0; call < 3; call++) await login.as.mutation(api.demo.ensureMine, {})
    const halfway = await t.run((ctx) => ctx.db.query('demo_sessions').unique())
    expect(halfway).toMatchObject({ status: 'unprovisioned', provision: { step: 3 } })
    expect(halfway?.org_id).toBeTruthy()
    await expectRefusal(login.as.query(api.workspace.root, {}), 'forbidden', /prepared/)
    expect(await login.as.query(api.demo.current, {})).toMatchObject({
      status: 'unprovisioned',
      orgId: null,
      progress: { step: 3, steps: PUBLIC_DEMO_STEPS },
    })
    const answers = await provision(login.as)
    expect(answers[0].progress?.step).toBe(4)
    expect(answers.at(-1)?.orgId).toBe(halfway?.org_id)
    expect(await t.run((ctx) => ctx.db.query('organizations').collect())).toHaveLength(1)
  })

  it('refuses to resume a demo whose steps changed in a deploy, and names the next step', async () => {
    const login = await anonymousLogin()
    await login.as.mutation(api.demo.ensureMine, {})
    await t.run(async (ctx) => {
      const receipt = (await ctx.db.query('demo_sessions').unique())!
      // 26 of the 27 calls of the layout before the steps were grouped
      await ctx.db.patch(receipt._id, {
        provision: { ...receipt.provision!, step: 26, layout: '27:0' },
      })
    })
    // a demo that cannot finish shows none of its steps done
    expect((await login.as.query(api.demo.current, {})).progress).toEqual({
      step: 0,
      steps: PUBLIC_DEMO_STEPS,
    })
    const refusal = await expectRefusal(
      login.as.mutation(api.demo.ensureMine, {}),
      'forbidden',
      /updated while your demo was being prepared\. Start a new demo\./,
    )
    // the demo app shows this sentence on its refusal screen
    expect(refusal.data).toMatchObject({
      reason: 'demo_unavailable',
      message: DEMO_UNAVAILABLE.updated,
    })
  })

  it('gives a dataset edit without a version bump a new layout, so a demo halfway refuses', async () => {
    const { PUBLIC_DEMO_LAYOUT } = await import('../model/demoSeed')
    vi.resetModules()
    vi.doMock('../internal/marketingDemoData', async (actual) => {
      const data = await actual<typeof import('../internal/marketingDemoData')>()
      const [first, ...rest] = data.MARKETING_DEMO.labels
      const labels = [{ ...first, key: `${first.key}-renamed` }, ...rest]
      return { ...data, MARKETING_DEMO: { ...data.MARKETING_DEMO, labels } }
    })
    try {
      const edited = await import('../model/demoSeed')
      expect(edited.PUBLIC_DEMO_STEPS).toBe(PUBLIC_DEMO_STEPS)
      expect(edited.PUBLIC_DEMO_LAYOUT).not.toBe(PUBLIC_DEMO_LAYOUT)
    } finally {
      vi.doUnmock('../internal/marketingDemoData')
      vi.resetModules()
    }
  })
})
