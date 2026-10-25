/// <reference types="vite/client" />
import { createFunctionHandle, makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { createAuth, createAuthOptions } from '../auth'
import authSchema from '../betterAuth/schema'
import { MARKETING_DEMO, MARKETING_DEMO_VERSION } from '../internal/marketingDemoData'
import { byId } from '../lib/db'
import {
  DEMO_INSERTS_TOTAL,
  DEMO_MAX_PAYLOAD_BYTES,
  DEMO_TTL_MS,
  DEMO_WRITES_PER_MINUTE,
  DEMO_WRITES_TOTAL,
} from '../lib/demo'
import { PUBLIC_DEMO_STEPS } from '../model/demoSeed'
import { expectRefusal, newT, type T, uuid, workspaceOf } from './helpers.setup'

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
      await t.query(internal.oauthConnections.lookupAccess, {
        tokenHash: 'anything',
        resource: 'anything',
      }),
    ).toBeNull()
    // API access lists and revokes nothing in a demo, even for its admin
    await expectRefusal(
      a.as.query(api.apiAccess.list, { org_id: a.demo.orgId! }),
      'forbidden',
      /regular workspace/,
    )
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

describe('public demo provisioning steps', () => {
  // The whole Northstar work in one transaction read 1,612 index ranges
  // and 1,668 documents and wrote about 1,400 documents, which could pass
  // Convex's 1 s mutation limit on a slow backend. Each call now runs one
  // bounded step, held to the marketing seed's per-call budget.
  it('provisions a demo in calls of at most 300 index ranges, 350 documents read and 150 written', async () => {
    const limited = newT({
      transactionLimits: { databaseQueries: 300, documentsRead: 350, documentsWritten: 150 },
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
      await ctx.db.patch(receipt._id, { provision: { ...receipt.provision!, layout: '26:0' } })
    })
    const refusal = await expectRefusal(
      login.as.mutation(api.demo.ensureMine, {}),
      'forbidden',
      /updated while your demo was being prepared\. Start a new demo\./,
    )
    expect(refusal.data.reason).toBe('demo_unavailable')
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
