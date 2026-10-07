/// <reference types="vite/client" />
import { createFunctionHandle, makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import { createAuthOptions } from '../auth'
import authSchema from '../betterAuth/schema'
import { DEMO_INSERTS_TOTAL, DEMO_TTL_MS, DEMO_WRITES_PER_MINUTE } from '../lib/demo'
import { expectRefusal, newT, type T, uuid } from './helpers.setup'

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
      onCreateHandle: await createFunctionHandle(internal.demo.onCreate),
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
      onCreateHandle: await createFunctionHandle(internal.demo.onCreate),
    }),
  )
  const as = on.withIdentity({ subject: user._id as string, sessionId: session._id as string })
  return { user, session, as }
}

async function readyDemo() {
  const login = await anonymousLogin()
  const demo = await login.as.mutation(api.demo.ensureMine, {})
  const snapshot = await login.as.query(api.snapshot.forMe, {})
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
    const [first, retry] = await Promise.all([
      login.as.mutation(api.demo.ensureMine, {}),
      login.as.mutation(api.demo.ensureMine, {}),
    ])
    expect(first.status).toBe('ready')
    expect(retry.orgId).toBe(first.orgId)
    expect(await t.run((ctx) => ctx.db.query('organizations').collect())).toHaveLength(1)
    expect(await login.as.query(api.appearance.get, {})).toEqual({
      mode: 'blue',
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
    await expectRefusal(login.as.query(api.snapshot.forMe, {}), 'forbidden', /prepared/)
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

  it('disables anonymous auth on normal deployments and preserves stable plugin schema', () => {
    const demo = createAuthOptions({} as never)
    expect(demo.session).toEqual({ expiresIn: 86400, disableSessionRefresh: true })
    expect(demo.emailAndPassword.enabled).toBe(false)
    expect(demo.disabledPaths).toContain('/delete-anonymous-user')
    vi.stubEnv('APP_MODE', 'normal')
    const normal = createAuthOptions({} as never)
    expect(normal.emailAndPassword.enabled).toBe(true)
    expect(normal.disabledPaths).toContain('/sign-in/anonymous')
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
      init: { method: string; headers: Record<string, string>; body: string },
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
    await expectRefusal(a.as.query(api.snapshot.forMe, {}), 'forbidden', /expired/)
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
    await expectRefusal(a.as.query(api.snapshot.forMe, {}), 'forbidden', /expired/)
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
    const mine = await a.as.query(api.snapshot.forMe, {})
    expect(JSON.stringify(mine)).not.toContain(b.demo.orgId)
  }, 30_000)

  it('refuses invitations, additional organizations, credential minting and editable synthetic email', async () => {
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
  })

  it('enforces write/record quotas transactionally and refuses large websocket payloads', async () => {
    const a = await readyDemo()
    await t.run((ctx) =>
      ctx.db.patch(a.receipt._id, {
        write_window_at: Date.now(),
        write_window_count: DEMO_WRITES_PER_MINUTE,
      }),
    )
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Over budget' }),
      'forbidden',
      /change limit/,
    )
    await t.run((ctx) =>
      ctx.db.patch(a.receipt._id, { write_window_count: 0, insert_count: DEMO_INSERTS_TOTAL }),
    )
    await expectRefusal(
      a.as.mutation(api.profiles.setDisplayName, { name: 'Needs an activity row' }),
      'forbidden',
      /record limit/,
    )
    expect((await t.run((ctx) => ctx.db.get(a.profile._id)))?.name).toBe(a.profile.name)
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
})
