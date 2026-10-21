import { verifyPassword } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { INSPECT_READ } from '../internal/marketingDemo'
import { REMOVAL_BUDGET } from '../model/cascade'
import { newT, type T, withOrg } from './helpers.setup'

const SITE = 'https://preview.qivo.io'
const HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`
const EMAIL = 'private-operator@example.test'
const newAuthT = () => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}
const findUser = (t: T, email: string) =>
  t.query(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: 'email', value: email }],
  })
const provision = (t: T) =>
  t.mutation(internal.internal.operator.provisionOperator, { email: EMAIL, password_hash: HASH })
const retire = (t: T, dry_run?: boolean) =>
  t.mutation(internal.internal.operator.retireLegacyFixtures, {
    expected_site_url: SITE,
    ...(dry_run === undefined ? {} : { dry_run }),
  })

beforeEach(() => {
  vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
  vi.stubEnv('SITE_URL', SITE)
  vi.stubEnv('QIVO_ADMIN_EMAIL', EMAIL)
  vi.stubEnv('QIVO_ADMIN_PW', crypto.randomUUID())
})
afterEach(() => vi.unstubAllEnvs())

describe('private fixture operator', () => {
  it('hashes a privately supplied password and preserves the existing account on repeat provisioning', async () => {
    const t = newAuthT()
    const password = crypto.randomUUID()
    vi.stubEnv('QIVO_ADMIN_PW', password)
    const result = await t.action(internal.internal.operator.testOperator, {})
    const user = await findUser(t, EMAIL)
    expect(user).toMatchObject({ _id: result.auth_user_id, role: 'admin', emailVerified: true })
    const account = await t.query(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [{ field: 'userId', value: result.auth_user_id }],
    })
    expect(await verifyPassword({ password, hash: account.password })).toBe(true)
    expect(await provision(t)).toEqual({ auth_user_id: result.auth_user_id, created: false })
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: 'account',
        where: [{ field: 'userId', value: result.auth_user_id }],
      }),
    ).toEqual(account)
  }, 60_000)

  it('fails closed for missing or weak credentials, production and existing unrelated accounts', async () => {
    const t = newAuthT()
    vi.stubEnv('QIVO_ADMIN_PW', '')
    await expect(provision(t)).rejects.toThrow(/generated private password/)
    vi.stubEnv('QIVO_ADMIN_PW', crypto.randomUUID())
    vi.stubEnv('QIVO_ENVIRONMENT', 'production')
    await expect(provision(t)).rejects.toThrow(/production/)
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    const original = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          email: EMAIL,
          name: 'Existing customer',
          emailVerified: true,
          role: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await expect(provision(t)).rejects.toThrow(/never adopted or reset/)
    expect(await findUser(t, EMAIL)).toEqual(original)
    expect(await t.run((ctx) => ctx.db.query('platform_admins').collect())).toEqual([])
  })
})

describe('legacy fixture retirement', () => {
  const legacyRoster = async (t: T) => {
    const result = await t.mutation(internal.internal.marketingDemo.provision, {
      expected_site_url: SITE,
      credential_set_id: '00000000-0000-4000-8000-000000000000',
      password_hashes: Object.fromEntries(
        ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben'].map((key) => [key, HASH]),
      ),
    })
    return result
  }

  it('retires receipt-owned logins while preserving all fixture and customer work', async () => {
    const t = newAuthT()
    const customer = await withOrg(t)
    await legacyRoster(t)
    await t.mutation(internal.internal.marketingDemo.apply, {
      expected_site_url: SITE,
      anchor: '2026-09-07',
      mode: 'seed',
    })
    const tasks = await t.run((ctx) => ctx.db.query('issues').collect())
    expect(tasks.length).toBeGreaterThan(0)
    expect(await retire(t)).toMatchObject({ dry_run: true, accounts: 7, profiles: 8 })
    // a pending contract credential of a fixture seat stays retired
    const pending = await t.mutation(internal.machine.testing.mintCredential, {
      email: 'nora@demo.qivo.io',
      kind: 'mcp_token',
      key_prefix: 'qvt_pend000',
      key_hash: 'c'.repeat(64),
      name: 'contract pass token 0',
      access: 'write',
      pending: true,
    })
    await retire(t, false)
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual(tasks)
    expect(await t.run((ctx) => ctx.db.get(customer.user._id))).toEqual(customer.user)
    expect(await findUser(t, 'nora@demo.qivo.io')).toMatchObject({ banned: true })
    expect(
      await t.mutation(internal.machine.testing.activateNamedCredentials, {
        profile_id: pending.profile_id,
        name: 'contract pass token 0',
      }),
    ).toEqual({ activated: 0 })
    await retire(t, false)
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual(tasks)
  })

  it('refuses retirement when a fixture identity also owns a seat outside its fixture', async () => {
    const t = newAuthT()
    const customer = await withOrg(t)
    await legacyRoster(t)
    const nora = await findUser(t, 'nora@demo.qivo.io')
    await t.run((ctx) => ctx.db.patch(customer.user._id, { auth_user_id: nora._id }))
    await expect(retire(t, false)).rejects.toThrow(/outside its owned organization/)
    expect(await findUser(t, 'nora@demo.qivo.io')).not.toMatchObject({ banned: true })
  })

  it('refuses automatic retirement when a roster login gained platform privileges', async () => {
    const t = newAuthT()
    await legacyRoster(t)
    const nora = await findUser(t, 'nora@demo.qivo.io')
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: nora._id,
        note: 'Manually promoted',
        created_at: new Date().toISOString(),
      }),
    )
    await expect(retire(t, false)).rejects.toThrow(/operator privileges/)
    expect(await findUser(t, 'nora@demo.qivo.io')).not.toMatchObject({ banned: true })
  })

  it('defaults to dry run, preserves customer work, requires a replacement operator and is repeatable', async () => {
    const t = newAuthT()
    const customer = await withOrg(t)
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          email: 'operator@demo.local',
          name: 'Operator',
          emailVerified: true,
          role: 'admin',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: user._id,
          providerId: 'credential',
          userId: user._id,
          password: HASH,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'session',
        data: {
          userId: user._id,
          token: crypto.randomUUID(),
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: user._id,
        note: 'Test operator for the admin smoke drive',
        created_at: new Date().toISOString(),
      }),
    )
    expect(await retire(t)).toMatchObject({
      dry_run: true,
      accounts: 1,
      operator_replacement_required: true,
    })
    expect(await findUser(t, 'operator@demo.local')).toEqual(user)
    await expect(retire(t, false)).rejects.toThrow(/replacement operator/)
    await provision(t)
    expect(await retire(t, false)).toMatchObject({
      accounts: 1,
      operator_replacement_required: false,
    })
    const retired = await findUser(t, 'operator@demo.local')
    expect(retired).toMatchObject({ banned: true, emailVerified: false, role: 'user' })
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: 'session',
        where: [{ field: 'userId', value: user._id }],
      }),
    ).toBeNull()
    expect(
      await t.query(components.betterAuth.adapter.findOne, {
        model: 'account',
        where: [{ field: 'userId', value: user._id }],
      }),
    ).toMatchObject({ password: null })
    await retire(t, false)
    expect(await findUser(t, 'operator@demo.local')).toEqual(retired)
    expect(await t.run((ctx) => ctx.db.get(customer.org._id))).toEqual(customer.org)
    expect(await t.run((ctx) => ctx.db.get(customer.user._id))).toEqual(customer.user)
  })

  it('refuses an account that lacks the legacy fixture ownership marker', async () => {
    const t = newAuthT()
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          email: 'operator@demo.local',
          name: 'Unrelated account',
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await expect(retire(t, false)).rejects.toThrow(/fixture marker/)
  })
})

describe('Northstar wipe', () => {
  const defaults = { ...REMOVAL_BUDGET }
  const inspectDefaults = { ...INSPECT_READ }
  afterEach(() => {
    Object.assign(REMOVAL_BUDGET, defaults)
    Object.assign(INSPECT_READ, inspectDefaults)
  })

  const apply = (t: T, mode: 'seed' | 'wipe') =>
    t.mutation(internal.internal.marketingDemo.apply, {
      expected_site_url: SITE,
      anchor: '2026-09-07',
      mode,
    })
  const orgRows = (t: T, orgId: string) =>
    t.run(async (ctx) => {
      const count = async (table: 'issues' | 'projects' | 'teams' | 'labels' | 'profiles') =>
        (
          await ctx.db
            .query(table)
            .withIndex('by_org', (q) => q.eq('org_id', orgId))
            .collect()
        ).length
      return {
        issues: await count('issues'),
        projects: await count('projects'),
        teams: await count('teams'),
        labels: await count('labels'),
        profiles: await count('profiles'),
        activity: (
          await ctx.db
            .query('activity_events')
            .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
            .collect()
        ).length,
      }
    })

  it('deletes a grown copy in bounded batches, keeps its people, and seeds it again', async () => {
    // Convex's real limits, which one transaction for all of it would pass
    const t = newT({ transactionLimits: true })
    t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
    const { org_id } = await t.mutation(internal.internal.marketingDemo.provision, {
      expected_site_url: SITE,
      credential_set_id: '00000000-0000-4000-8000-000000000000',
      password_hashes: Object.fromEntries(
        ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben'].map((key) => [key, HASH]),
      ),
    })
    await apply(t, 'seed')
    const seeded = await orgRows(t, org_id)
    expect(seeded.issues).toBeGreaterThan(0)
    // manual or contract-test work: 500 more tasks, each with a comment
    await t.run(async (ctx) => {
      const project = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .filter((q) => q.eq(q.field('type'), 'project'))
        .first()
      const author = await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .first()
      if (project === null || author === null) throw new Error('the seed made no project')
      for (let i = 0; i < 500; i++) {
        const id = crypto.randomUUID()
        await ctx.db.insert('issues', {
          id,
          org_id,
          project_id: project.id,
          num: 10_000 + i,
          title: `Manual task ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: '2026-09-07T00:00:00.000Z',
          updated_at: '2026-09-07T00:00:00.000Z',
        })
        await ctx.db.insert('comments', {
          id: crypto.randomUUID(),
          issue_id: id,
          author: author.id,
          body: 'manual',
          created_at: '2026-09-07T00:00:00.000Z',
        })
      }
    })

    // The CLI inspects before it wipes. Past INSPECT_READ the count stops
    // and says so, so a copy larger than one query may read can be wiped.
    const inspect = () =>
      t.query(internal.internal.marketingDemo.inspect, { expected_site_url: SITE })
    const total = seeded.issues + 500
    expect((await inspect()).counts).toMatchObject({ tasks: total })
    expect((await inspect()).counts).not.toHaveProperty('tasks_partial')
    INSPECT_READ.tasks = 100
    expect((await inspect()).counts).toMatchObject({ tasks: 100, tasks_partial: true })
    Object.assign(INSPECT_READ, inspectDefaults, { bytes: 1 })
    expect((await inspect()).counts).toMatchObject({ tasks: 1, tasks_partial: true })
    Object.assign(INSPECT_READ, inspectDefaults)

    // the first batch leaves work behind, which a seed refuses
    // a step that leaves work answers without inspecting it all again
    expect(await apply(t, 'wipe')).toEqual({ state: 'empty', wipe_done: false })
    await expect(apply(t, 'seed')).rejects.toThrow(/work was added after wipe/)
    let steps = 1
    while (!(await apply(t, 'wipe')).wipe_done) expect(++steps).toBeLessThan(50)
    expect(steps).toBeGreaterThan(2)
    expect(await orgRows(t, org_id)).toEqual({
      issues: 0,
      projects: 0,
      teams: 0,
      labels: 0,
      profiles: seeded.profiles,
      activity: 0,
    })
    expect(await apply(t, 'wipe')).toMatchObject({ wipe_done: true })

    await apply(t, 'seed')
    expect(await orgRows(t, org_id)).toEqual(seeded)
  }, 60_000)
})
