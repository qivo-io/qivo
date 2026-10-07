import { verifyPassword } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import authSchema from '../betterAuth/schema'
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
    await retire(t, false)
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual(tasks)
    expect(await t.run((ctx) => ctx.db.get(customer.user._id))).toEqual(customer.user)
    expect(await findUser(t, 'nora@demo.qivo.io')).toMatchObject({ banned: true })
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
