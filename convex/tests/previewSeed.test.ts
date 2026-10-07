/* internal/previewSeed — Northstar Labs on a Vercel preview at the fixed
 * fixture password. These cases pay for real scrypt hashing (the roster's
 * shared hash, the operator's createUser, one verification), hence the long
 * per-test timeouts. */
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { marketingId } from '../internal/marketingDemoData'
import { FIXTURE_PASSWORD, OPERATOR } from '../internal/operator'
import { PREVIEW_CREDENTIAL_SET_ID, type PreviewSeedResult } from '../internal/previewSeed'
import { demoMonday } from '../model/demoSeed'
import { newT, plantIssue, plantProject, type T } from './helpers.setup'

declare const process: { env: Record<string, string | undefined> }
process.env.BETTER_AUTH_SECRET ??= 'previewSeed-test-secret-not-a-real-deployment'
process.env.CONVEX_SITE_URL ??= 'http://convex.site.test'

const PREVIEW = 'https://qivo-git-northstar-only-team.vercel.app'
const HUMANS = ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben'] as const
const SCRYPT = 60_000

const seedRef = makeFunctionReference<'action', Record<string, never>, PreviewSeedResult>(
  'internal/previewSeed:seed',
)
const provisionRef = makeFunctionReference<
  'mutation',
  { expected_site_url: string; password_hashes: Record<string, string>; credential_set_id: string },
  unknown
>('internal/marketingDemo:provision')

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}
type ComponentRow = { _id: string; role?: string | null; password?: string } | null
const componentRow = (t: T, model: 'user' | 'account', field: string, value: string) =>
  t.run(
    async (ctx) =>
      (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model,
        where: [{ field, value }],
      })) as ComponentRow,
  )
const receipt = (t: T) =>
  t.run(async (ctx) =>
    ctx.db
      .query('marketing_demo')
      .withIndex('by_key', (q) => q.eq('key', 'northstar-labs'))
      .unique(),
  )
const seed = (t: T) => t.action(seedRef, {})

/* One case fails the seed step's writer once, after the wipe has committed,
 * to show a reset is two transactions. Every other call writes normally. */
const failSeed = vi.hoisted(() => ({ once: false }))
vi.mock('../model/demoSeed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/demoSeed')>()
  return {
    ...actual,
    writeNorthstarWork: async (...args: Parameters<typeof actual.writeNorthstarWork>) => {
      if (failSeed.once) {
        failSeed.once = false
        throw new Error('injected seed failure')
      }
      return await actual.writeNorthstarWork(...args)
    },
  }
})

beforeEach(() => vi.stubEnv('SITE_URL', PREVIEW))
afterEach(() => vi.unstubAllEnvs())

describe('the preview seed', () => {
  it(
    'provisions the roster and the operator at the fixture password, marks the sample portraits, and is ready on the current Monday',
    async () => {
      const t = newAuthT()
      const result = await seed(t)
      expect(result).toMatchObject({
        site_url: PREVIEW,
        state: 'ready',
        // a new preview is not ready and current, so it is wiped (cheaply,
        // it holds no work yet) and then seeded
        mode: 'reset',
        anchor: demoMonday(Date.now()),
        counts: { projects: 3, subprojects: 12, tasks: 90, users: 8 },
      })

      const record = await receipt(t)
      expect(record?.credential_set_id).toBe(PREVIEW_CREDENTIAL_SET_ID)
      expect(record?.state).toBe('ready')

      // the seven logins exist and their credential accounts verify the password
      for (const key of HUMANS) {
        const user = await componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)
        expect(user, key).not.toBeNull()
        expect(user?._id).toBe(record?.auth_ids[key])
        const account = await componentRow(t, 'account', 'userId', user?._id ?? '')
        expect(account?.password).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)
      }
      const nora = await componentRow(t, 'account', 'userId', record?.auth_ids.nora ?? '')
      expect(await verifyPassword({ hash: nora?.password ?? '', password: FIXTURE_PASSWORD })).toBe(
        true,
      )

      // the operator: Better Auth role admin, one platform_admins row, no seat
      const operator = await componentRow(t, 'user', 'email', OPERATOR.email)
      expect(operator?._id).toBe(result.operator_auth_id)
      expect(operator?.role).toBe('admin')
      const admins = await t.run(async (ctx) => ctx.db.query('platform_admins').collect())
      expect(admins.map((a) => a.auth_user_id)).toEqual([result.operator_auth_id])

      // every profile wears its bundled portrait
      const profiles = await t.run(async (ctx) =>
        ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
          .collect(),
      )
      expect(profiles).toHaveLength(8)
      for (const p of profiles) expect(p.sample_avatar, p.name).toBeDefined()
      const atlasId = await marketingId('northstar-labs', 'person:atlas')
      expect(profiles.find((p) => p.id === atlasId)?.sample_avatar).toBe('atlas')
    },
    SCRYPT,
  )

  it(
    'a second push is a no-op that keeps every login',
    async () => {
      const t = newAuthT()
      const first = await seed(t)
      const before = await receipt(t)
      const second = await seed(t)
      expect(second.mode).toBe('seed')
      expect(second.operator_auth_id).toBe(first.operator_auth_id)
      expect((await receipt(t))?.auth_ids).toEqual(before?.auth_ids)
      expect((await receipt(t))?.updated_at).toBe(before?.updated_at)
    },
    SCRYPT,
  )

  it(
    'a stale anchor resets the work as a wipe and then a seed; a failed seed leaves it empty and the next push resets it even after manual work',
    async () => {
      const t = newAuthT()
      const { org_id } = await seed(t)
      const makeStale = () =>
        t.run(async (ctx) => {
          const record = await ctx.db
            .query('marketing_demo')
            .withIndex('by_key', (q) => q.eq('key', 'northstar-labs'))
            .unique()
          if (record !== null) await ctx.db.patch(record._id, { anchor: '2026-01-05' })
        })
      await makeStale()
      const result = await seed(t)
      expect(result.mode).toBe('reset')
      expect(result.anchor).toBe(demoMonday(Date.now()))
      expect(result.counts.tasks).toBe(90)

      // the wipe commits on its own, so a seed failing after it leaves the
      // preview empty rather than rolling back to the stale work
      await makeStale()
      failSeed.once = true
      await expect(seed(t)).rejects.toThrow(/injected seed failure/)
      const empty = await receipt(t)
      expect(empty?.state).toBe('empty')
      expect(empty?.anchor).toBeUndefined()
      expect(await t.run(async (ctx) => ctx.db.query('issues').collect())).toEqual([])

      // a reviewer signs in to the empty preview and adds work; a seed alone
      // would refuse it, so the next push wipes it and seeds again
      const project = await plantProject(t, { org_id, name: 'Added to the empty preview' })
      const task = await plantIssue(t, { org_id, project_id: project.id })
      expect(await seed(t)).toMatchObject({
        mode: 'reset',
        state: 'ready',
        anchor: demoMonday(Date.now()),
        counts: { tasks: 90 },
      })
      expect(await t.run(async (ctx) => ctx.db.get(task._id))).toBeNull()
    },
    SCRYPT,
  )

  it(
    'refuses a Northstar the CLI provisioned with private passwords',
    async () => {
      const t = newAuthT()
      const hash = await hashPassword('a private password')
      await t.mutation(provisionRef, {
        expected_site_url: PREVIEW,
        password_hashes: Object.fromEntries(HUMANS.map((key) => [key, hash])),
        credential_set_id: 'c1234567-89ab-4cde-8fab-0123456789ab',
      })
      await expect(seed(t)).rejects.toThrow(/provisioned by the CLI/)
      expect((await receipt(t))?.state).toBe('empty')
    },
    SCRYPT,
  )

  it('runs only on a Vercel preview origin, never on production or a development origin', async () => {
    const t = newAuthT()
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    await expect(seed(t)).rejects.toThrow(/not a Vercel preview origin/)
    vi.stubEnv('SITE_URL', 'https://qivo.io')
    await expect(seed(t)).rejects.toThrow(/production deployment/)
    expect(await t.run(async (ctx) => ctx.db.query('organizations').collect())).toEqual([])
  })
})
