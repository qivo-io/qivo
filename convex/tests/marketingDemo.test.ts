/* Isolated fixture boundaries: only the receipt-owned demo may be
 * rebuilt, and repeat seeding must preserve both manual work and real login
 * identities. The local Better Auth component is the deployed schema. These
 * tests exercise its actual adapter without paying for scrypt hashing. */
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components, internal } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { RESERVED_PARTS } from '../internal/marketingDemo'
import {
  DEMO_SYNC_TIME,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingInstant,
} from '../internal/marketingDemoData'
import { canSeeProject, hasProjectLevel } from '../lib/access'
import { MCP_PROVENANCE } from '../machine/shared'
import { logActivity, machineDetail } from '../model/activity'
import { removeProfile } from '../model/cascade'
import { moveProjectToTrash, moveTasksToTrash, TRASH_BUDGET } from '../model/deletedItems'
import { NORTHSTAR_BATCH, NORTHSTAR_STEPS } from '../model/demoSeed'
import { nameKeysReady } from '../model/nameKeys'
import { newOrgDefaults, newTeamDefaults } from '../model/orgs'
import { navReady } from '../model/projectNav'
import schema from '../schema'
import {
  countersFor,
  expectDescriptions,
  expectLiveCounts,
  expectRefusal,
  fileState,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  settleScheduled,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { expectExact } from './nameKeys.setup'
import { expectReachExact, expectReachMatchesAccess } from './projectReach.setup'
import { assertNoDanglingRefs } from './refs.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const SITE = 'https://preview.qivo.io'
const ANCHOR = '2026-09-07'
const NEXT_ANCHOR = '2026-11-02'
const TARGET = { expected_site_url: SITE }
const CREDENTIAL_SET = 'c1234567-89ab-4cde-8fab-0123456789ab'
const OTHER_CREDENTIAL_SET = 'd1234567-89ab-4cde-8fab-0123456789ab'
const HUMANS = ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben'] as const
const HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`
const HASHES = Object.fromEntries(HUMANS.map((key) => [key, HASH]))
const demoId = (key: string) => marketingId('northstar-labs', key)

type Inspection = {
  org_id: string
  state: 'absent' | 'empty' | 'seeding' | 'ready'
  anchor?: string
  version: number
  credential_set_id?: string
  counts: { users: number; projects: number; subprojects: number; tasks: number; avatars: number }
}
// Explicit wire references let the suite run before local codegen is refreshed.
const inspectRef = makeFunctionReference<'query', typeof TARGET, Inspection>(
  'internal/marketingDemo:inspect',
)
const provisionRef = makeFunctionReference<
  'mutation',
  typeof TARGET & { password_hashes: Record<string, string>; credential_set_id: string },
  Inspection
>('internal/marketingDemo:provision')
const applyRef = makeFunctionReference<
  'mutation',
  typeof TARGET & { anchor: string; mode: 'seed' | 'wipe' },
  Inspection & {
    wipe_done?: boolean
    seed_done?: boolean
    seed_step?: number
    seed_steps?: number
  }
>('internal/marketingDemo:apply')
const restoreRef = makeFunctionReference<
  'mutation',
  typeof TARGET & { person: string; sample_avatar?: boolean },
  { profile_id: string }
>('internal/marketingDemo:restoreSeat')
const avatarRef = makeFunctionReference<
  'mutation',
  typeof TARGET & { person: string; storage_id: Id<'_storage'> },
  null
>('internal/marketingDemo:adoptAvatar')

const newAuthT = (options: Parameters<typeof newT>[0] = {}): T => {
  const t = newT(options)
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}
const provision = (t: T, credentialSet = CREDENTIAL_SET) =>
  t.mutation(provisionRef, {
    ...TARGET,
    password_hashes: HASHES,
    credential_set_id: credentialSet,
  })
const apply = (t: T, mode: 'seed' | 'wipe', anchor = ANCHOR) =>
  t.mutation(applyRef, { ...TARGET, mode, anchor })
// The CLI's wipe: one bounded batch a call, until the backend says it is done.
const checkReservedRef = makeFunctionReference<
  'query',
  typeof TARGET & { part: number },
  { parts: number }
>('internal/marketingDemo:checkReserved')
// The CLI's reserved-id check before a wipe, one read-only part a call.
const checkReserved = async (t: T) => {
  let parts = 1
  for (let part = 0; part < parts; part++)
    parts = (await t.query(checkReservedRef, { ...TARGET, part })).parts
}
// The CLI's wipe: the check, then one bounded batch a call until done.
const wipe = async (t: T, anchor = ANCHOR) => {
  await checkReserved(t)
  for (let step = 0; step < 100; step++) {
    const result = await apply(t, 'wipe', anchor)
    if (result.wipe_done !== false) return result
  }
  throw new Error('the wipe did not finish in 100 calls')
}
// The CLI's seed: one step a call, until the backend says it is done.
// The last step schedules the closed months' usage rows (usage.ts
// closeOrgMonth). They are settled here, so no snapshot sees them move.
const seed = async (t: T, anchor = ANCHOR) => {
  for (let step = 0; step < 200; step++) {
    const result = await apply(t, 'seed', anchor)
    if (result.seed_done !== false) {
      await settleScheduled(t)
      return result
    }
  }
  throw new Error('the seed did not finish in 200 calls')
}
// The CLI's reset: a wipe and then a seed, each in its own transactions.
const reset = async (t: T, anchor = ANCHOR) => {
  await wipe(t, anchor)
  return await seed(t, anchor)
}
/* The used_ids rows organization `orgId` holds (schema.ts). */
const usedIds = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('used_ids')
      .withIndex('by_org_kept', (q) => q.eq('org_id', orgId))
      .collect(),
  )
const profiles = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  )
/* The organization's Team sync stamp rows, by person. */
const stamps = async (t: T, orgId: string) =>
  new Map(
    (
      await t.run((ctx) =>
        ctx.db
          .query('sync_stamps')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect(),
      )
    ).map((row) => [row.profile_id, row]),
  )
const componentRow = (t: T, model: 'user' | 'account', field: string, value: string) =>
  t.run(async (ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model,
      where: [{ field, value }],
    }),
  )
const storeImage = (t: T): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob(['demo portrait']) as never)
    // convex-test omits the upload request's content type; emulate its metadata.
    await ctx.db.patch(sid as never, { contentType: 'image/jpeg' } as never)
    return sid
  })

async function seeded(t: T) {
  await provision(t)
  return await seed(t)
}

async function fixtureSnapshot(t: T) {
  const data = await t.run(async (ctx) => ({
    tables: Object.fromEntries(
      await Promise.all(
        (Object.keys(schema.tables) as TableNames[]).map(async (table) => [
          table,
          await ctx.db.query(table).collect(),
        ]),
      ),
    ) as { [K in TableNames]: Doc<K>[] },
    storage: await ctx.db.system.query('_storage').collect(),
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }))
  const auth = await Promise.all(
    HUMANS.map(async (key) => {
      const user = await componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)
      const account = user ? await componentRow(t, 'account', 'userId', user._id) : null
      return { user, account }
    }),
  )
  return { ...data, auth }
}

async function assertUnprovisioned(t: T) {
  expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').collect())).toEqual([])
  expect(await t.query(inspectRef, TARGET)).toMatchObject({ state: 'absent' })
  for (const key of HUMANS) {
    expect(await componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)).toBeNull()
  }
}

beforeEach(() => {
  vi.stubEnv('SITE_URL', SITE)
  vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
})
afterEach(() => vi.unstubAllEnvs())

describe('marketing demo provisioning', () => {
  it('creates seven private logins and one agent, exactly one org admin, and no emails or operator privileges', async () => {
    const t = newAuthT()
    const first = await provision(t)
    expect(first).toMatchObject({
      state: 'empty',
      credential_set_id: CREDENTIAL_SET,
      counts: { users: 8, tasks: 0, avatars: 0 },
    })
    const roster = await profiles(t, first.org_id)
    expect(roster.filter((p) => p.org_role === 'admin').map((p) => p.name)).toEqual(['Nora Berg'])
    expect(roster.filter((p) => p.kind === 'agent')).toHaveLength(1)
    expect(roster.find((p) => p.kind === 'agent')).toMatchObject({ name: 'Atlas' })
    expect(roster.find((p) => p.kind === 'agent')?.auth_user_id).toBeUndefined()
    for (const key of HUMANS) {
      const person = roster.find((p) => p.email === `${key}@demo.qivo.io`)
      expect(person?.auth_user_id).toBeDefined()
      expect(person?.message_retention_days).toBe(7)
      expect(person?.plannable_hours).toBe(newOrgDefaults(NOW).default_plannable_hours)
      const user = await componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)
      expect(user).toMatchObject({ _id: person?.auth_user_id, emailVerified: true, role: 'user' })
      expect(await componentRow(t, 'account', 'userId', person!.auth_user_id!)).toMatchObject({
        providerId: 'credential',
        password: HASH,
      })
    }
    expect(await t.run(async (ctx) => ctx.db.query('platform_admins').collect())).toEqual([])
    expect(
      await t.run(async (ctx) => ctx.db.system.query('_scheduled_functions').collect()),
    ).toEqual([])
    // A second provisioning call adopts only the receipt it created and leaves
    // every profile document and auth identity byte-for-byte unchanged.
    expect(await provision(t)).toEqual(first)
    expect(await profiles(t, first.org_id)).toEqual(roster)
  })

  it('concurrent provision retries using the same credential receipt create one roster', async () => {
    const t = newAuthT()
    const [first, second] = await Promise.all([provision(t), provision(t)])
    expect(first).toEqual(second)
    expect(first.credential_set_id).toBe(CREDENTIAL_SET)
    expect(await profiles(t, first.org_id)).toHaveLength(8)
    expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').collect())).toHaveLength(1)
    expect(await t.query(inspectRef, TARGET)).toEqual(first)
  })

  it('concurrent clones with different credential receipts have exactly one owner', async () => {
    const t = newAuthT()
    const attempts = await Promise.allSettled([
      provision(t, CREDENTIAL_SET),
      provision(t, OTHER_CREDENTIAL_SET),
    ])
    const successes = attempts.filter((result) => result.status === 'fulfilled')
    const failures = attempts.filter((result) => result.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    const winner = successes[0].value
    const loser = failures[0].reason
    const refusal = await expectRefusal(Promise.reject(loser), 'conflict', /credential set/)
    expect(refusal.data.reason).toBe('demo_credentials_mismatch')
    expect(await t.query(inspectRef, TARGET)).toEqual(winner)
    expect(await profiles(t, winner.org_id)).toHaveLength(8)
    const before = await profiles(t, winner.org_id)
    await provision(t, winner.credential_set_id!)
    const losingSet =
      winner.credential_set_id === CREDENTIAL_SET ? OTHER_CREDENTIAL_SET : CREDENTIAL_SET
    await expectRefusal(provision(t, losingSet), 'conflict', /credential set/)
    expect(await profiles(t, winner.org_id)).toEqual(before)
  })

  it('rejects an invalid last password hash before creating any login or organization', async () => {
    const t = newAuthT()
    await expectRefusal(
      t.mutation(provisionRef, {
        ...TARGET,
        credential_set_id: CREDENTIAL_SET,
        password_hashes: { ...HASHES, ben: 'invalid' },
      }),
      'bad_request',
      /invalid password hash/,
    )
    await assertUnprovisioned(t)
    expect(await t.run(async (ctx) => ctx.db.query('organizations').collect())).toEqual([])
    expect(await t.run(async (ctx) => ctx.db.query('profiles').collect())).toEqual([])
  })

  it.each(['slug', 'id'] as const)(
    'refuses an unowned organization %s without adopting or changing it',
    async (collision) => {
      const t = newAuthT()
      const f = await withOrg(t)
      const orgId = await demoId('org')
      await t.run(async (ctx) =>
        ctx.db.patch(f.org._id, collision === 'slug' ? { slug: 'northstar-labs' } : { id: orgId }),
      )
      const before = await t.run(async (ctx) => ctx.db.query('organizations').collect())
      await expectRefusal(provision(t), 'conflict', /unowned organization/)
      expect(await t.run(async (ctx) => ctx.db.query('organizations').collect())).toEqual(before)
      expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').collect())).toEqual([])
      expect(await componentRow(t, 'user', 'email', 'nora@demo.qivo.io')).toBeNull()
    },
  )

  it.each(['profile', 'login'] as const)(
    'refuses an email already owned by a foreign %s',
    async (collision) => {
      const t = newAuthT()
      const f = await withOrg(t)
      if (collision === 'profile') {
        await t.run(async (ctx) => ctx.db.patch(f.user._id, { email: 'ben@demo.qivo.io' }))
      } else {
        await t.run(async (ctx) =>
          ctx.runMutation(components.betterAuth.adapter.create, {
            input: {
              model: 'user',
              data: {
                name: 'Existing login',
                email: 'ben@demo.qivo.io',
                emailVerified: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          }),
        )
      }
      await expectRefusal(provision(t), 'conflict', /unowned account/)
      expect(await t.query(inspectRef, TARGET)).toMatchObject({ state: 'absent' })
      expect(await componentRow(t, 'user', 'email', 'nora@demo.qivo.io')).toBeNull()
      expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').collect())).toEqual([])
    },
  )

  it('refuses a reserved profile UUID held by another organization', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const reserved = await demoId('person:nora')
    await t.run(async (ctx) => ctx.db.patch(f.user._id, { id: reserved }))
    await expectRefusal(provision(t), 'conflict', /profile|id|UUID/i)
    await assertUnprovisioned(t)
    expect(await t.run(async (ctx) => ctx.db.get(f.user._id))).toMatchObject({
      id: reserved,
      org_id: f.org.id,
    })
  })

  it('requires an exact site match and refuses production regardless of its hostname', async () => {
    const t = newAuthT()
    await expectRefusal(
      t.mutation(provisionRef, {
        ...TARGET,
        expected_site_url: 'https://other.example',
        password_hashes: HASHES,
        credential_set_id: CREDENTIAL_SET,
      }),
      'rule',
      /SITE_URL does not match/,
    )
    vi.stubEnv('QIVO_ENVIRONMENT', 'production')
    await expect(provision(t)).rejects.toThrow(/production/)
    vi.stubEnv('QIVO_ENVIRONMENT', '')
    await expect(provision(t)).rejects.toThrow(/QIVO_ENVIRONMENT/)
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    vi.stubEnv('APP_MODE', 'demo')
    await expect(provision(t)).rejects.toThrow(/public demo/)
    vi.stubEnv('APP_MODE', '')
    vi.stubEnv('SITE_URL', 'https://qivo.io')
    await expect(t.query(inspectRef, { expected_site_url: 'https://qivo.io' })).rejects.toThrow(
      /production/,
    )
    expect(await t.run(async (ctx) => ctx.db.query('organizations').collect())).toEqual([])
  })
})

describe('marketing demo rebuild ownership', () => {
  it('seeds three projects with 2–5 subprojects each, and repeat seed preserves manual edits', async () => {
    const t = newAuthT()
    const result = await seeded(t)
    expect(result).toMatchObject({
      state: 'ready',
      anchor: ANCHOR,
      counts: {
        projects: 3,
        subprojects: 12,
        tasks: MARKETING_DEMO.issues.length,
        users: 8,
      },
    })
    const projects = await t.run(async (ctx) => ctx.db.query('projects').collect())
    for (const meta of projects.filter((p) => p.type === 'meta')) {
      const children = projects.filter((p) => p.parent_id === meta.id)
      expect(children.length).toBeGreaterThanOrEqual(2)
      expect(children.length).toBeLessThanOrEqual(5)
    }
    // the seed writes no icons, which nothing shows
    for (const row of [
      ...projects,
      ...(await t.run(async (ctx) => ctx.db.query('teams').collect())),
    ])
      expect([row.icon, row.icon_color]).toEqual([undefined, undefined])
    const task = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
    await t.run(async (ctx) => ctx.db.patch(task._id, { title: 'Customer walkthrough adjustment' }))
    const manual = await plantIssue(t, {
      org_id: result.org_id,
      project_id: task.project_id,
      title: 'Manual demo task',
    })
    const before = await t.run(async (ctx) => ctx.db.query('issues').collect())
    await apply(t, 'seed')
    expect(await t.run(async (ctx) => ctx.db.query('issues').collect())).toEqual(before)
    expect(await t.run(async (ctx) => ctx.db.get(manual._id))).not.toBeNull()
    await expectRefusal(apply(t, 'seed', NEXT_ANCHOR), 'rule', /use reset to change dates/)
  })

  it('gives every row its name key and puts a renamed person back on reset', async () => {
    const t = newAuthT()
    const { org_id } = await seeded(t)
    expect(await t.run((ctx) => nameKeysReady(ctx, org_id))).toBe(true)
    await expectExact(t, org_id)
    const [person] = await profiles(t, org_id)
    await t.run((ctx) => ctx.db.patch(person._id, { name: 'Renamed', name_key: 'renamed' }))
    await reset(t, NEXT_ANCHOR)
    expect((await t.run((ctx) => ctx.db.get(person._id)))?.name_key).toBe(person.name_key)
    await expectExact(t, org_id)
  })

  it('seeds ranked usage whose account rows and month totals stay exact across a later reseed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-09-20T12:00:00.000Z'))
    const t = newAuthT()
    await seeded(t)
    const clean = {
      unranked: 0,
      differing_accounts: 0,
      differing_totals: 0,
      unsettled: 0,
      done: true,
    }
    // six months of three callers' calls
    expect(await t.action(internal.internal.usageRanksBackfill.check, {})).toMatchObject({
      ...clean,
      buckets: 6,
    })
    const first = await t.run(async (ctx) => ctx.db.query('billing_usage').collect())
    expect(first.every((row) => row.neg_calls === -row.calls)).toBe(true)
    // a month later the reseed moves every month's calls and adds one month
    vi.setSystemTime(Date.parse('2026-10-20T12:00:00.000Z'))
    await reset(t, NEXT_ANCHOR)
    expect(await t.action(internal.internal.usageRanksBackfill.check, {})).toMatchObject({
      ...clean,
      buckets: 7,
    })
    vi.useRealTimers()
  })

  it('writes the reach rows of every lead and share it seeds, and again on reset', async () => {
    const t = newAuthT()
    const { org_id } = await seeded(t)
    expect(await t.run((ctx) => navReady(ctx, org_id))).toBe(true)
    await expectReachExact(t)
    await expectReachMatchesAccess(t, org_id)
    const states = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect()
      ).map((p) => p.archive_state),
    )
    expect(new Set(states)).toEqual(new Set(['live']))
    await reset(t, NEXT_ANCHOR)
    await expectReachExact(t)
  })

  it('seeds two teams with separate leaders, partial membership overlap, default settings, and inherited project access', async () => {
    const t = newAuthT()
    await seeded(t)
    await t.run(async (ctx) => {
      const teams = await ctx.db.query('teams').collect()
      const memberships = await ctx.db.query('team_members').collect()
      const roster = await ctx.db.query('profiles').collect()
      const projects = await ctx.db.query('projects').collect()
      const grants = await ctx.db.query('project_team_access').collect()
      expect(teams).toHaveLength(2)
      const leaders = memberships.filter((member) => member.is_leader)
      expect(leaders).toHaveLength(2)
      expect(new Set(leaders.map((leader) => leader.profile_id)).size).toBe(2)
      const memberIds = teams.map(
        (team) =>
          new Set(
            memberships
              .filter((member) => member.team_id === team.id)
              .map((member) => member.profile_id),
          ),
      )
      expect([...memberIds[0]].some((person) => memberIds[1].has(person))).toBe(true)
      expect([...memberIds[0]].some((person) => !memberIds[1].has(person))).toBe(true)
      expect([...memberIds[1]].some((person) => !memberIds[0].has(person))).toBe(true)
      for (const team of teams) expect(team).toMatchObject(newTeamDefaults(team.created_at))
      expect(await ctx.db.query('project_access').collect()).toEqual([])
      expect(grants).toHaveLength(6)
      for (const project of projects) {
        const root = project.parent_id
          ? projects.find((candidate) => candidate.id === project.parent_id)!
          : project
        expect(project.team_id, `${project.name} has no owning team`).toBeUndefined()
        const userTeams = teams.filter((team) =>
          grants.some(
            (grant) =>
              grant.project_id === root.id && grant.team_id === team.id && grant.level === 'user',
          ),
        )
        for (const team of teams) {
          expect(
            grants.find((grant) => grant.project_id === root.id && grant.team_id === team.id),
          ).toBeDefined()
        }
        for (const person of roster) {
          expect(await canSeeProject(ctx, person, project), `${person.name}: ${project.name}`).toBe(
            true,
          )
          const ownsProject =
            person.id === project.lead_id ||
            person.id === root.lead_id ||
            userTeams.some((team) =>
              memberships.some(
                (member) => member.profile_id === person.id && member.team_id === team.id,
              ),
            )
          expect(
            await hasProjectLevel(ctx, person, project.id, 'user'),
            `${person.name}: ${project.name}`,
          ).toBe(ownsProject)
        }
      }
    })
  })

  it('seeds team-lead reporters, two archived tasks per main project, complete parents, and feasible dates', async () => {
    const t = newAuthT()
    await seeded(t)
    await t.run(async (ctx) => {
      const projects = await ctx.db.query('projects').collect()
      const tasks = await ctx.db.query('issues').collect()
      const links = await ctx.db.query('issue_links').collect()
      for (const root of projects.filter((project) => project.type === 'meta')) {
        const projectIds = new Set(
          projects.filter((project) => project.parent_id === root.id).map((project) => project.id),
        )
        const projectTasks = tasks.filter((task) => projectIds.has(task.project_id))
        expect(
          projectTasks.filter((task) => task.archived_at !== undefined),
          root.name,
        ).toHaveLength(2)
        const lead = projects.find((project) => project.id === root.id)?.lead_id
        expect(
          projectTasks.filter((task) => task.reporter_id === lead).length,
          root.name,
        ).toBeGreaterThan(projectTasks.length / 2)
      }
      // The planned end the app shows. A group's is the latest end of its
      // scheduled, unarchived leaves at any depth, never a stored date.
      const endOf = (task: Doc<'issues'>): string | undefined => {
        const kids = tasks.filter((c) => c.parent_id === task.id && c.archived_at === undefined)
        if (!kids.length) return task.end_week ?? task.start_week
        let end: string | undefined
        for (const kid of kids) {
          const kidEnd = endOf(kid)
          if (kidEnd !== undefined && (end === undefined || kidEnd > end)) end = kidEnd
        }
        return end
      }
      for (const task of tasks) {
        const children = tasks.filter((child) => child.parent_id === task.id)
        const plannedEnd = endOf(task)
        if (children.length) {
          expect(children.length, task.title).toBeGreaterThanOrEqual(2)
          expect(children.length, task.title).toBeLessThanOrEqual(4)
          expect(task.remaining_hours).toBeUndefined()
          expect(task.start_week, task.title).toBeUndefined()
          expect(task.end_week, task.title).toBeUndefined()
          expect(plannedEnd, task.title).toBeDefined()
        }
        if (task.archived_at !== undefined) expect(task.status).toBe('done')
        if (plannedEnd !== undefined && task.due_date !== undefined) {
          // A scheduled week includes Friday, the latest planned working day.
          const friday = Date.parse(plannedEnd) + 4 * 86_400_000
          expect(friday, task.title).toBeLessThanOrEqual(Date.parse(task.due_date))
        }
      }
      for (const link of links.filter((link) => link.type === 'blocks')) {
        const blocker = tasks.find((task) => task.id === link.source_id)!
        const dependent = tasks.find((task) => task.id === link.target_id)!
        expect(blocker.end_week, blocker.title).toBeDefined()
        expect(dependent.start_week, dependent.title).toBeDefined()
        expect(Date.parse(dependent.start_week!), dependent.title).toBeGreaterThan(
          Date.parse(blocker.end_week!),
        )
      }
    })
  })

  it('marks the labels, links and follows of archived tasks as the archive steps would, and no other row', async () => {
    const t = newAuthT()
    await seeded(t)
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query('issues').collect()
      const archived = new Set(
        tasks.filter((task) => task.archived_at !== undefined).map((task) => task.id),
      )
      const labels = await ctx.db.query('issue_labels').collect()
      const follows = await ctx.db.query('issue_subscriptions').collect()
      for (const row of [...labels, ...follows]) {
        expect(row.task_archived === true, row.issue_id).toBe(archived.has(row.issue_id))
      }
      for (const link of await ctx.db.query('issue_links').collect()) {
        expect(link.task_archived === true, link.id).toBe(
          archived.has(link.source_id) || archived.has(link.target_id),
        )
      }
      expect(labels.filter((row) => row.task_archived).length).toBeGreaterThan(0)
      expect(follows.filter((row) => row.task_archived).length).toBeGreaterThan(0)
      // every archived task here has a follow, so each carries the flag
      for (const task of tasks) {
        expect(task.relations_marked === true, task.title).toBe(archived.has(task.id))
      }
    })
  })

  it('gives every human and Atlas unread notifications for tasks they can see, using real assignment, review and comment events', async () => {
    const t = newAuthT()
    await seeded(t)
    await t.run(async (ctx) => {
      const roster = await ctx.db.query('profiles').collect()
      const messages = await ctx.db.query('messages').collect()
      const tasks = await ctx.db.query('issues').collect()
      const projects = await ctx.db.query('projects').collect()
      for (const person of roster) {
        const inbox = messages.filter((message) => message.recipient_id === person.id)
        expect(inbox.length, person.name).toBeGreaterThan(0)
        expect(
          inbox.some((message) => message.read_at === undefined),
          person.name,
        ).toBe(true)
        for (const message of inbox) {
          const task = tasks.find((task) => task.id === message.issue_id)!
          const project = projects.find((project) => project.id === task.project_id)!
          expect(await canSeeProject(ctx, person, project)).toBe(true)
          expect(message.actor_id).not.toBe(person.id)
          expect(message.detail).toMatch(
            /Assigned to you|New comment|Mentioned you|Ready for your review/,
          )
        }
      }
      const atlas = roster.find((person) => person.kind === 'agent')!
      expect(
        messages.some((message) => message.recipient_id === atlas.id && message.kind === 'comment'),
      ).toBe(true)
    })
    await assertNoDanglingRefs(t, 'marketing demo inbox')
  })

  it('persists every task conversation with distinct timestamps and notifies its other participants', async () => {
    const t = newAuthT()
    await seeded(t)
    const commentIds = new Map(
      await Promise.all(
        MARKETING_DEMO.comments.map(
          async (comment) => [comment.key, await demoId(`comment:${comment.key}`)] as const,
        ),
      ),
    )
    const taskIds = new Map(
      await Promise.all(
        MARKETING_DEMO.issues.map(
          async (task) => [task.key, await demoId(`issue:${task.key}`)] as const,
        ),
      ),
    )
    const personIds = new Map(
      await Promise.all(
        MARKETING_DEMO.people.map(
          async (person) => [person.key, await demoId(`person:${person.key}`)] as const,
        ),
      ),
    )
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query('issues').collect()
      const comments = await ctx.db.query('comments').collect()
      const roster = await ctx.db.query('profiles').collect()
      const messages = await ctx.db.query('messages').collect()
      const subscriptions = await ctx.db.query('issue_subscriptions').collect()
      expect(comments).toHaveLength(MARKETING_DEMO.comments.length)
      expect(new Set(comments.map((comment) => comment.id)).size).toBe(comments.length)
      for (const task of tasks) {
        const thread = comments.filter((comment) => comment.issue_id === task.id)
        expect(thread.length, task.title).toBeGreaterThanOrEqual(1)
        expect(thread.length, task.title).toBeLessThanOrEqual(5)
        expect(new Set(thread.map((comment) => comment.created_at)).size, task.title).toBe(
          thread.length,
        )
      }
      // The import follows each task for its assignee, and for its reviewer
      // when the task is seeded In Review, before any comment is written.
      const expectedRecipients = new Map<string, Set<string>>(
        tasks.map((task) => {
          const followers = new Set(task.assignee_id ? [task.assignee_id] : [])
          if (task.status === 'review' && task.reviewer_id) followers.add(task.reviewer_id)
          return [task.id, followers]
        }),
      )
      const expectedMessages: string[] = []
      for (const sample of MARKETING_DEMO.comments) {
        const comment = comments.find((row) => row.id === commentIds.get(sample.key))!
        const task = tasks.find((row) => row.id === comment.issue_id)!
        const author = roster.find((person) => person.id === comment.author)!
        expect(comment).toMatchObject({
          issue_id: taskIds.get(sample.issue),
          author: personIds.get(sample.author),
          body: sample.body,
        })
        expect(comment.created_at.slice(0, 10)).toBe(marketingDate(ANCHOR, sample.day))
        expect(await hasProjectLevel(ctx, author, task.project_id, 'user')).toBe(true)
      }
      // A reply reaches the followers above and authors who have already joined
      // the dated conversation, never its own author or a later participant.
      // Messages about an archived task arrive read, so the prune keeps one
      // per participant; the exact list covers the active tasks.
      const archived = new Set(tasks.filter((task) => task.archived_at).map((task) => task.id))
      const archivedItems = new Set<string>()
      for (const comment of comments.toSorted((a, b) => a.created_at.localeCompare(b.created_at))) {
        if (comment.author === undefined) throw new Error('Seeded comment is missing its author')
        const participants = expectedRecipients.get(comment.issue_id)!
        participants.add(comment.author)
        for (const participant of participants) {
          if (participant === comment.author) continue
          if (archived.has(comment.issue_id)) {
            archivedItems.add(JSON.stringify([comment.issue_id, participant]))
          } else {
            expectedMessages.push(
              JSON.stringify([comment.issue_id, comment.author, participant, comment.created_at]),
            )
          }
        }
      }
      expect(archivedItems.size).toBeGreaterThan(0)
      for (const key of archivedItems) {
        const [issueId, recipientId] = JSON.parse(key) as [string, string]
        const item = messages.filter(
          (message) => message.issue_id === issueId && message.recipient_id === recipientId,
        )
        expect(item, key).toHaveLength(1)
        expect(item[0].read_at, key).toBeDefined()
      }
      expect(
        messages
          .filter((message) => message.kind === 'comment' && !archived.has(message.issue_id))
          .map((message) =>
            JSON.stringify([
              message.issue_id,
              message.actor_id,
              message.recipient_id,
              message.created_at,
            ]),
          )
          .sort(),
      ).toEqual(expectedMessages.sort())
      expect(
        subscriptions
          .map((subscription) => `${subscription.issue_id}:${subscription.profile_id}`)
          .sort(),
      ).toEqual(
        [...expectedRecipients]
          .flatMap(([task, participants]) => [...participants].map((person) => `${task}:${person}`))
          .sort(),
      )
    })
    await assertNoDanglingRefs(t, 'marketing demo conversations')
  })

  it('hands seeded Review tasks to their reviewers and leaves In Progress and Done reviewers unnotified', async () => {
    const t = newAuthT()
    await seeded(t)
    const expected = await Promise.all(
      MARKETING_DEMO.issues.map(async (task) => ({
        key: task.key,
        status: task.status,
        id: await demoId(`issue:${task.key}`),
        reviewer: task.reviewer ? await demoId(`person:${task.reviewer}`) : undefined,
      })),
    )
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query('issues').collect()
      const messages = await ctx.db.query('messages').collect()
      const subscriptions = await ctx.db.query('issue_subscriptions').collect()
      // the seed instant: some tasks carry an earlier, dated last write
      const seededAt = (await ctx.db.query('projects').first())!.created_at
      for (const { key, id, reviewer } of expected) {
        expect(tasks.find((task) => task.id === id)?.reviewer_id, key).toBe(reviewer)
      }
      const reviewed = expected.filter((task) => task.reviewer !== undefined)
      expect(reviewed.filter((task) => task.status === 'review').length).toBeGreaterThan(0)
      expect(reviewed.filter((task) => task.status === 'progress').length).toBeGreaterThan(0)
      expect(reviewed.filter((task) => task.status === 'done').length).toBeGreaterThan(0)
      for (const { key, status, id, reviewer } of reviewed) {
        const handoffs = messages.filter(
          (message) =>
            message.issue_id === id &&
            message.recipient_id === reviewer &&
            message.kind === 'change',
        )
        // The import subscribes at the seed instant; a comment subscribes
        // its author at the comment's earlier dated time.
        const followsFromImport = subscriptions.some(
          (row) =>
            row.issue_id === id && row.profile_id === reviewer && row.created_at === seededAt,
        )
        if (status === 'review') {
          expect(
            handoffs.map((message) => message.detail),
            key,
          ).toEqual(['Ready for your review'])
          expect(followsFromImport, key).toBe(true)
        } else {
          expect(handoffs, key).toEqual([])
          expect(followsFromImport, key).toBe(false)
        }
      }
    })
  })

  it('reset shifts dates and clears manual work/files while retaining identities, avatars, and all other organization data', async () => {
    const t = newAuthT()
    const foreign = await withOrg(t)
    const foreignTask = await plantIssue(t, {
      org_id: foreign.org.id,
      project_id: foreign.sub.id,
      title: 'Real unrelated work',
    })
    const result = await seeded(t)
    const roster = await profiles(t, result.org_id)
    const nora = roster.find((p) => p.email === 'nora@demo.qivo.io')!
    const avatar = await storeImage(t)
    await t.mutation(avatarRef, { ...TARGET, person: 'nora', storage_id: avatar })
    const stableProfiles = await profiles(t, result.org_id)
    const authBefore = await Promise.all(
      HUMANS.map((key) => componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)),
    )
    const accountsBefore = await Promise.all(
      stableProfiles
        .filter((p) => p.auth_user_id)
        .map((p) => componentRow(t, 'account', 'userId', p.auth_user_id!)),
    )
    const projectsBefore = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
        .collect(),
    )
    const tasksBefore = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
        .collect(),
    )
    const manual = await plantIssue(t, {
      org_id: result.org_id,
      project_id: projectsBefore[0].id,
      title: 'Delete this manual addition',
    })
    const file = await storeImage(t)
    const commentId = await t.run(async (ctx) => {
      await ctx.db.insert('issue_attachments', {
        org_id: manual.org_id,
        id: uuid(),
        issue_id: manual.id,
        name: 'demo.jpg',
        size_bytes: 13,
        mime: 'image/jpeg',
        storage_id: file,
        inline: false,
        uploaded_by: nora.id,
        created_at: NOW,
      })
      return await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: manual.id,
        author: nora.id,
        body: 'A manually added discussion',
        created_at: NOW,
      })
    })
    const foreignBefore = await t.run(async (ctx) => ({
      org: await ctx.db.get(foreign.org._id),
      team: await ctx.db.get(foreign.team._id),
      task: await ctx.db.get(foreignTask._id),
      profiles: await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', foreign.org.id))
        .collect(),
      projects: await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', foreign.org.id))
        .collect(),
    }))
    await reset(t, NEXT_ANCHOR)
    await assertNoDanglingRefs(t, 'marketing demo reset')
    // Identities are retained; only the dated Team sync stamps, which live
    // off the profiles, follow the anchor.
    const profilesAfter = await profiles(t, result.org_id)
    expect(profilesAfter).toEqual(stableProfiles)
    const stampsAfter = await stamps(t, result.org_id)
    for (const person of MARKETING_DEMO.people) {
      const profile = profilesAfter.find((p) => p.name === person.name)
      expect(stampsAfter.get(profile?.id ?? '')?.at, person.key).toBe(
        person.syncDay === undefined
          ? undefined
          : marketingInstant(NEXT_ANCHOR, person.syncDay, DEMO_SYNC_TIME),
      )
    }
    expect(
      await Promise.all(
        HUMANS.map((key) => componentRow(t, 'user', 'email', `${key}@demo.qivo.io`)),
      ),
    ).toEqual(authBefore)
    expect(
      await Promise.all(
        stableProfiles
          .filter((p) => p.auth_user_id)
          .map((p) => componentRow(t, 'account', 'userId', p.auth_user_id!)),
      ),
    ).toEqual(accountsBefore)
    const projectsAfter = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
        .collect(),
    )
    const tasksAfter = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
        .collect(),
    )
    expect(projectsAfter.map((p) => p.id)).toEqual(projectsBefore.map((p) => p.id))
    expect(tasksAfter.map((i) => i.id)).toEqual(tasksBefore.map((i) => i.id))
    const scheduled = tasksBefore.find((i) => i.start_week !== undefined)!
    expect(scheduled).toBeDefined()
    const moved = tasksAfter.find((i) => i.id === scheduled.id)!
    expect(Date.parse(moved.start_week!) - Date.parse(scheduled.start_week!)).toBe(56 * 86_400_000)
    expect(await t.run(async (ctx) => ctx.db.get(manual._id))).toBeNull()
    expect(await t.run(async (ctx) => ctx.db.get(commentId))).toBeNull()
    expect(await fileState(t, file)).toBe('held')
    expect(await t.run(async (ctx) => ctx.db.system.get(avatar))).not.toBeNull()
    expect(
      await t.run(async (ctx) => ({
        org: await ctx.db.get(foreign.org._id),
        team: await ctx.db.get(foreign.team._id),
        task: await ctx.db.get(foreignTask._id),
        profiles: await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', foreign.org.id))
          .collect(),
        projects: await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', foreign.org.id))
          .collect(),
      })),
    ).toEqual(foreignBefore)
  }, 30_000)

  it('reset replaces conversations, inbox history, subscriptions, and team grants without accumulating rows', async () => {
    const t = newAuthT()
    const result = await seeded(t)
    const snapshot = () =>
      t.run(async (ctx) => ({
        messages: await ctx.db.query('messages').collect(),
        comments: await ctx.db.query('comments').collect(),
        subscriptions: await ctx.db.query('issue_subscriptions').collect(),
        teams: await ctx.db.query('teams').collect(),
        memberships: await ctx.db.query('team_members').collect(),
        grants: await ctx.db.query('project_team_access').collect(),
        individual: await ctx.db.query('project_access').collect(),
      }))
    const original = await snapshot()
    const noraId = await demoId('person:nora')
    const leoId = await demoId('person:leo')
    const task = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
    await t.run(async (ctx) => {
      const nora = (await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', noraId))
        .unique())!
      await ctx.db.patch(nora._id, { message_retention_days: undefined })
      // Team sync stamps from interactive use, on a person the seed leaves unstamped
      await ctx.db.insert('sync_stamps', {
        org_id: result.org_id,
        profile_id: noraId,
        at: NOW,
        since: NOW,
      })
      // Who can create projects, changed in the demo
      const leo = (await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', leoId))
        .unique())!
      await ctx.db.patch(leo._id, { can_create_projects: true })
      const org = (await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', result.org_id))
        .unique())!
      await ctx.db.patch(org._id, { project_creators: 'selected' })
      await ctx.db.patch(original.messages[0]._id, { read_at: NOW })
      await ctx.db.patch(original.comments[0]._id, { body: 'Manually edited conversation' })
      await ctx.db.insert('messages', {
        id: uuid(),
        org_id: result.org_id,
        recipient_id: noraId,
        issue_id: task.id,
        issue_title: task.title,
        kind: 'change',
        detail: 'Manual inbox history that reset must remove',
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: original.grants[0].project_id,
        profile_id: noraId,
        level: 'user',
      })
    })
    let before = await snapshot()
    for (const anchor of [NEXT_ANCHOR, ANCHOR]) {
      await reset(t, anchor)
      const after = await snapshot()
      const roster = await profiles(t, result.org_id)
      expect(
        roster.filter((p) => p.kind === 'person').every((p) => p.message_retention_days === 7),
      ).toBe(true)
      // A reset keeps neither who can create projects nor a person's right to.
      expect(roster.filter((p) => p.can_create_projects !== undefined)).toEqual([])
      const org = await t.run(async (ctx) =>
        ctx.db
          .query('organizations')
          .withIndex('by_uuid', (q) => q.eq('id', result.org_id))
          .unique(),
      )
      expect(org?.project_creators).toBeUndefined()
      // Every stamp is set or cleared from the dataset, following the anchor.
      const stamped = await stamps(t, result.org_id)
      for (const person of MARKETING_DEMO.people) {
        const row = roster.find((p) => p.name === person.name)
        const stamp = stamped.get(row?.id ?? '')
        expect(stamp?.at, person.key).toBe(
          person.syncDay === undefined
            ? undefined
            : marketingInstant(anchor, person.syncDay, DEMO_SYNC_TIME),
        )
        expect(stamp?.since, person.key).toBeUndefined()
      }
      for (const table of [
        'messages',
        'comments',
        'subscriptions',
        'teams',
        'memberships',
        'grants',
        'individual',
      ] as const) {
        expect(after[table], table).toHaveLength(original[table].length)
        const oldIds = new Set(before[table].map((row) => row._id))
        expect(
          after[table].some((row) => oldIds.has(row._id)),
          table,
        ).toBe(false)
      }
      // the reset restores the seed's read state, where only messages about
      // archived tasks are read, because they arrive read
      const archivedTasks = new Set(
        (await t.run(async (ctx) => ctx.db.query('issues').collect()))
          .filter((issue) => issue.archived_at)
          .map((issue) => issue.id),
      )
      expect(archivedTasks.size).toBeGreaterThan(0)
      for (const message of after.messages) {
        expect(message.read_at !== undefined, message.detail).toBe(
          archivedTasks.has(message.issue_id),
        )
      }
      const conversation = (rows: Doc<'comments'>[]) =>
        rows
          .map((comment) => ({
            id: comment.id,
            task: comment.issue_id,
            author: comment.author,
            body: comment.body,
            time: comment.created_at.slice(10),
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      expect(conversation(after.comments)).toEqual(conversation(original.comments))
      expect(new Set(after.comments.map((comment) => comment.id)).size).toBe(after.comments.length)
      expect(
        after.messages.some((message) => message.detail.includes('Manual inbox history')),
      ).toBe(false)
      expect(
        new Set(after.grants.map((grant) => `${grant.project_id}:${grant.team_id}`)).size,
      ).toBe(6)
      expect(
        new Set(
          after.subscriptions.map(
            (subscription) => `${subscription.issue_id}:${subscription.profile_id}`,
          ),
        ).size,
      ).toBe(after.subscriptions.length)
      before = after
    }
    await assertNoDanglingRefs(t, 'marketing demo repeat reset')
  }, 30_000)

  it("writes each task's import row and short history in order, with stamps that agree", async () => {
    const t = newAuthT()
    const result = await seeded(t)
    const { rows, tasks, links } = await t.run(async (ctx) => ({
      rows: await ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', result.org_id))
        .collect(),
      tasks: await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', result.org_id))
        .collect(),
      links: await ctx.db.query('issue_links').collect(),
    }))
    expect(rows.length).toBe(MARKETING_DEMO.issues.length + MARKETING_DEMO.history.length)
    const atlas = await demoId('person:atlas')
    for (const issue of MARKETING_DEMO.issues) {
      const id = await demoId(`issue:${issue.key}`)
      const task = tasks.find((row) => row.id === id)!
      // in insertion order, which the task window pages by
      const own = rows
        .filter((row) => row.target_id === id)
        .sort((x, y) => x._creationTime - y._creationTime)
      for (const [i, row] of own.entries()) if (i > 0) expect(row.ts >= own[i - 1].ts).toBe(true)
      // the import row comes first, at the task's creation
      expect(own[0]).toMatchObject({
        id: await demoId(`activity:import:${issue.key}`),
        actor_id: atlas,
      })
      expect(own[0].ts, issue.key).toBe(task.created_at)
      const changes = MARKETING_DEMO.history.filter((c) => c.issue === issue.key)
      for (const [i, c] of changes.entries()) {
        expect(own[i + 1].id, c.key).toBe(await demoId(`activity:change:${c.key}`))
      }
      // the stamps agree with the history
      expect(task.updated_at >= task.status_at!, issue.key).toBe(true)
      const lastMove = own.filter((row) => ['moved', 'changed'].includes(row.verb)).at(-1)
      if (issue.status === 'done') expect(task.status_at, issue.key).toBe(task.done_at)
      else if (issue.status === 'review' && task.review_at !== undefined)
        expect(task.status_at, issue.key).toBe(task.review_at)
      else if (!lastMove) expect(task.status_at, issue.key).toBe(task.created_at)
      if (lastMove) expect(task.status_at, issue.key).toBe(lastMove.ts)
    }
    const byKey = new Map<string, (typeof rows)[number]>()
    for (const c of MARKETING_DEMO.history) {
      const id = await demoId(`activity:change:${c.key}`)
      byKey.set(c.key, rows.find((row) => row.id === id)!)
    }
    expect(byKey.get('pcb-review-started')).toMatchObject({
      verb: 'moved',
      detail: 'from To Do to In Progress',
      named_task_nums: [],
    })
    expect(byKey.get('accessibility-audit-started')).toMatchObject({
      verb: 'changed',
      detail: machineDetail('(status To Do → In Progress)', MCP_PROVENANCE),
      actor_id: atlas,
    })
    expect(byKey.get('offline-buffer-reliability')).toMatchObject({
      verb: 'labeled',
      detail: '“Reliability”',
      named_task_nums: [],
    })
    const ingestionId = await demoId('issue:ingestion')
    const ingestion = tasks.find((row) => row.id === ingestionId)!
    expect(ingestion.num).toBe(58)
    const linked = byKey.get('telemetry-contract-blocks-ingestion')!
    expect(linked).toMatchObject({
      verb: 'linked',
      detail: `(blocks QN-${ingestion.num})`,
      named_task_nums: [ingestion.num],
    })
    // only the link row names a task
    expect(rows.filter((row) => row.named_task_nums?.length).map((row) => row.id)).toEqual([
      linked.id,
    ])
    const linkId = await demoId('link:telemetry-contract:ingestion')
    expect(links.find((l) => l.id === linkId)?.created_at).toBe(linked.ts)
    // the next change to a task follows its seeded rows
    const target = linked.target_id
    const before = rows.filter((row) => row.target_id === target).length
    await t.run((ctx) =>
      logActivity(ctx, {
        org_id: result.org_id,
        actor_id: undefined,
        verb: 'renamed',
        target_type: 'issue',
        target_id: target,
        label: linked.label,
        ts: NOW,
        named_task_nums: [],
      }),
    )
    const history = await t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_target', (q) =>
          q.eq('org_id', result.org_id).eq('target_type', 'issue').eq('target_id', target),
        )
        .collect(),
    )
    expect(history).toHaveLength(before + 1)
    expect(history.at(-1)?.verb).toBe('renamed')
  }, 30_000)

  it('wipe removes work but preserves the roster and allows reseeding with stable issue UUIDs', async () => {
    const t = newAuthT()
    const result = await seeded(t)
    const counted = await expectLiveCounts(t, result.org_id)
    // every seeded task has its description row, and the wipe takes them
    const described = await expectDescriptions(t, result.org_id)
    expect(described).toBeGreaterThanOrEqual(counted.active_tasks)
    const roster = await profiles(t, result.org_id)
    const issueIds = (await t.run(async (ctx) => ctx.db.query('issues').collect())).map((i) => i.id)
    // every seeded task and project holds its id in used_ids, which the wipe
    // lets go and the reseed takes again
    const ids = await usedIds(t, result.org_id)
    expect(ids).toHaveLength(MARKETING_DEMO.issues.length + MARKETING_DEMO.projects.length)
    expect(await wipe(t)).toMatchObject({
      state: 'empty',
      wipe_done: true,
      counts: { projects: 0, tasks: 0, users: 8 },
    })
    await assertNoDanglingRefs(t, 'marketing demo wipe')
    await t.run(async (ctx) => {
      for (const table of [
        'teams',
        'team_members',
        'project_team_access',
        'project_access',
        'messages',
        'issue_subscriptions',
      ] as const)
        expect(await ctx.db.query(table).collect(), table).toEqual([])
    })
    expect(await profiles(t, result.org_id)).toEqual(roster)
    for (const person of roster.filter((p) => p.kind === 'person')) {
      expect(await componentRow(t, 'account', 'userId', person.auth_user_id!)).not.toBeNull()
    }
    await t.run(async (ctx) => {
      await logActivity(ctx, {
        org_id: result.org_id,
        actor_id: undefined,
        verb: 'updated',
        target_type: 'org',
        target_id: result.org_id,
        label: 'After wipe',
        ts: NOW,
      })
      expect(
        await ctx.db
          .query('activity_events')
          .withIndex('by_org_ts', (q) => q.eq('org_id', result.org_id))
          .collect(),
      ).toHaveLength(1)
    })
    // the wipe rewinds the counters, so the reseed numbers tasks from 1, and
    // the live counts follow the rows it deleted and writes
    expect(await countersFor(t, result.org_id)).toEqual({ next_issue_num: 0, next_project_num: 0 })
    expect(await expectLiveCounts(t, result.org_id)).toEqual({ active_tasks: 0, live_projects: 0 })
    expect(await expectDescriptions(t, result.org_id)).toBe(0)
    expect(await usedIds(t, result.org_id)).toEqual([])
    await seed(t, NEXT_ANCHOR)
    expect((await usedIds(t, result.org_id)).map((row) => row.row_id).sort()).toEqual(
      ids.map((row) => row.row_id).sort(),
    )
    expect(await expectLiveCounts(t, result.org_id)).toEqual(counted)
    expect(await expectDescriptions(t, result.org_id)).toBe(described)
    expect((await t.run(async (ctx) => ctx.db.query('issues').collect())).map((i) => i.id)).toEqual(
      issueIds,
    )
  }, 30_000)

  it('does not treat an empty receipt as permission to erase manual work added after wipe', async () => {
    const t = newAuthT()
    const demo = await seeded(t)
    await wipe(t)
    const manualProject = await plantProject(t, {
      org_id: demo.org_id,
      name: 'A manually prepared walkthrough',
    })
    const manualIssue = await plantIssue(t, {
      org_id: demo.org_id,
      project_id: manualProject.id,
      title: 'Keep these meeting notes',
    })
    await expectRefusal(
      apply(t, 'seed', NEXT_ANCHOR),
      'rule',
      /work was added after wipe.*use reset/,
    )
    expect(await t.run(async (ctx) => ctx.db.get(manualProject._id))).toEqual(manualProject)
    expect(await t.run(async (ctx) => ctx.db.get(manualIssue._id))).toEqual(manualIssue)
    expect(await t.query(inspectRef, TARGET)).toMatchObject({
      state: 'empty',
      counts: { tasks: 1 },
    })
    // An explicit reset (wipe, then seed) is the authorized replacement, and
    // repeating it is how an operator recovers from a seed that failed.
    expect(await reset(t, NEXT_ANCHOR)).toMatchObject({
      state: 'ready',
      anchor: NEXT_ANCHOR,
    })
    expect(await t.run(async (ctx) => ctx.db.get(manualProject._id))).toBeNull()
    expect(await t.run(async (ctx) => ctx.db.get(manualIssue._id))).toBeNull()
    await assertNoDanglingRefs(t, 'reset after manual work in empty demo')
  }, 30_000)

  it('has no single-call reset: the validator refuses that mode', async () => {
    // A retired wire value a typed caller can no longer send. Were the union
    // to accept it again, this call would reach the ownership check (no demo
    // is provisioned) and refuse with a typed error instead.
    const retired = 'reset' as unknown as 'seed'
    await expect(
      newAuthT().mutation(applyRef, { ...TARGET, mode: retired, anchor: ANCHOR }),
    ).rejects.toThrowError(/Validator error/)
  })

  it.each(['northstar', 'cloud-launch'])(
    'refuses reset when reserved team %s belongs to another organization before clearing work',
    async (key) => {
      const t = newAuthT()
      const foreign = await withOrg(t)
      await seeded(t)
      const id = await demoId(`team:${key}`)
      await t.run(async (ctx) => {
        const team = await ctx.db
          .query('teams')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique()
        await ctx.db.patch(team!._id, { org_id: foreign.org.id })
      })
      const before = await fixtureSnapshot(t)
      const refusal = await expectRefusal(
        reset(t),
        'conflict',
        /reserved team id belongs to another organization/,
      )
      expect(refusal.data.reason).toBe('demo_id_collision')
      expect(await fixtureSnapshot(t)).toEqual(before)
    },
  )

  it.each(['comment', 'milestone', 'link', 'activity', 'history'] as const)(
    'refuses reset when a reserved %s UUID now belongs to foreign work, before any deletion',
    async (collision) => {
      const t = newAuthT()
      const foreign = await withOrg(t)
      const foreignTask = await plantIssue(t, {
        org_id: foreign.org.id,
        project_id: foreign.sub.id,
        title: 'Customer production work',
      })
      const secondTask = await plantIssue(t, {
        org_id: foreign.org.id,
        project_id: foreign.sub.id,
        title: 'Customer dependency',
      })
      await seeded(t)
      // Move an actual reserved row under foreign ownership without creating
      // duplicate app UUIDs. A rebuild must refuse to reuse that UUID even
      // though all of the ordinary project/task collision checks still pass.
      await t.run(async (ctx) => {
        if (collision === 'comment') {
          const id = await demoId(`comment:${MARKETING_DEMO.comments[0].key}`)
          const row = await ctx.db
            .query('comments')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique()
          await ctx.db.patch(row!._id, { issue_id: foreignTask.id, author: foreign.admin.id })
        } else if (collision === 'milestone') {
          const id = await demoId(`milestone:${MARKETING_DEMO.milestones[0].key}`)
          const row = await ctx.db
            .query('milestones')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique()
          await ctx.db.patch(row!._id, { project_id: foreign.meta.id })
        } else if (collision === 'link') {
          const first = MARKETING_DEMO.links[0]
          const id = await demoId(`link:${first.source}:${first.target}`)
          const row = await ctx.db
            .query('issue_links')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique()
          await ctx.db.patch(row!._id, {
            source_id: foreignTask.id,
            target_id: secondTask.id,
            pair_key: [foreignTask.id, secondTask.id].sort().join(':'),
          })
        } else {
          const id = await demoId(
            collision === 'activity'
              ? `activity:import:${MARKETING_DEMO.issues[0].key}`
              : `activity:change:${MARKETING_DEMO.history[0].key}`,
          )
          const row = await ctx.db
            .query('activity_events')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique()
          await ctx.db.patch(row!._id, {
            org_id: foreign.org.id,
            project_id: foreign.meta.id,
            actor_id: foreign.admin.id,
            target_id: foreignTask.id,
          })
        }
      })
      const snapshot = () =>
        t.run(async (ctx) => ({
          projects: await ctx.db.query('projects').collect(),
          issues: await ctx.db.query('issues').collect(),
          comments: await ctx.db.query('comments').collect(),
          milestones: await ctx.db.query('milestones').collect(),
          links: await ctx.db.query('issue_links').collect(),
          activities: await ctx.db.query('activity_events').collect(),
          receipt: await ctx.db.query('marketing_demo').collect(),
        }))
      const before = await snapshot()
      const refusal = await expectRefusal(
        reset(t, NEXT_ANCHOR),
        'conflict',
        /reserved|another organization/,
      )
      expect(refusal.data.reason).toBe('demo_id_collision')
      expect(await snapshot()).toEqual(before)
      await assertNoDanglingRefs(t, `refused ${collision} collision`)
    },
  )

  it('puts back a removed seat with its reserved id and login, so a reset accepts the roster', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const t = newAuthT()
    const result = await seeded(t)
    const roster = await profiles(t, result.org_id)
    const atlas = roster.find((p) => p.kind === 'agent')!
    const leo = roster.find((p) => p.email === 'leo@demo.qivo.io')!
    // both have API usage in the seed, which keeps their ids taken
    const named = await t.run(async (ctx) =>
      (await ctx.db.query('billing_usage').collect()).map((row) => row.profile_id),
    )
    expect(named).toEqual(expect.arrayContaining([atlas.id, leo.id]))
    for (const profile of [atlas, leo])
      await t.run((ctx) => removeProfile(ctx, { profile, now: new Date().toISOString() }))
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    await expectRefusal(reset(t, NEXT_ANCHOR), 'rule', /roster changed; restore a removed seat/)

    const restore = (person: string) => t.mutation(restoreRef, { ...TARGET, person })
    await expectRefusal(restore('nobody'), 'bad_request', /unknown person/)
    // a login that is not the receipt's cannot take the seat back
    const receipt = await t.run(async (ctx) => (await ctx.db.query('marketing_demo').unique())!)
    await t.run((ctx) =>
      ctx.db.patch(receipt._id, { auth_ids: { ...receipt.auth_ids, leo: 'another-login' } }),
    )
    await expectRefusal(restore('leo'), 'rule', /login ownership changed/)
    await t.run((ctx) => ctx.db.patch(receipt._id, { auth_ids: receipt.auth_ids }))
    expect(await restore('atlas')).toEqual({ profile_id: atlas.id })
    await restore('leo')
    await expectRefusal(restore('atlas'), 'conflict', /in place or still being removed/)
    const strip = ({ _id, _creationTime, created_at, accepted_at, ...row }: Doc<'profiles'>) => row
    const back = await profiles(t, result.org_id)
    for (const before of [atlas, leo])
      expect(strip(back.find((p) => p.id === before.id)!)).toEqual(strip(before))
    expect(await reset(t, NEXT_ANCHOR)).toMatchObject({ state: 'ready', anchor: NEXT_ANCHOR })
  })

  it.each(['extra-person', 'changed-login'] as const)(
    'refuses reset when ownership changed through %s',
    async (change) => {
      const t = newAuthT()
      const result = await seeded(t)
      if (change === 'extra-person') {
        await plantSeat(t, { org_id: result.org_id, name: 'Invited real customer' })
      } else {
        const nora = (await profiles(t, result.org_id)).find(
          (p) => p.email === 'nora@demo.qivo.io',
        )!
        await t.run(async (ctx) => ctx.db.patch(nora._id, { auth_user_id: 'different-real-login' }))
      }
      const workBefore = await t.run(async (ctx) => ctx.db.query('issues').collect())
      await expectRefusal(reset(t, NEXT_ANCHOR), 'rule', /roster changed|login ownership changed/)
      expect(await t.run(async (ctx) => ctx.db.query('issues').collect())).toEqual(workBefore)
    },
  )
})

describe('marketing demo Deleted items', () => {
  // fake timers keep the steps of a moving item from running in between
  const DEFAULT_TRASH_BUDGET = { ...TRASH_BUDGET }
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    Object.assign(TRASH_BUDGET, DEFAULT_TRASH_BUDGET)
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  const TRASH_LEFT = /Deleted items must be empty; run the same command again/

  /* Nora deletes a task and, in bounded steps that have not run, a whole
   * project, as the app does: the project's item is still moving, with
   * tasks left under its absent projects. */
  async function trashSome(t: T, orgId: string) {
    await t.run(async (ctx) => {
      const nora = (
        await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect()
      ).find((p) => p.org_role === 'admin')!
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      const [first, second] = projects.filter((p) => p.type === 'meta')
      const task = (
        await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect()
      ).find((i) => projects.some((p) => p.id === i.project_id && p.parent_id === first.id))!
      const now = new Date().toISOString()
      await moveTasksToTrash(ctx, { actor: nora, root: task, subtasks: [], now })
      Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
      await moveProjectToTrash(ctx, { actor: nora, project: second, now })
    })
  }

  const purgeAll = async (t: T, orgId: string) => {
    for (let calls = 1; ; calls++) {
      expect(calls).toBeLessThan(200)
      if ((await t.mutation(internal.deletedItems.purgeOrg, { org_id: orgId })).done) return
    }
  }

  it('refuses a wipe while Deleted items hold anything, and wipes and reseeds once purgeOrg emptied them', async () => {
    const t = newAuthT()
    const demo = await seeded(t)
    const issueIds = (await t.run(async (ctx) => ctx.db.query('issues').collect())).map((i) => i.id)
    await trashSome(t, demo.org_id)
    const before = await fixtureSnapshot(t)
    await expectRefusal(apply(t, 'wipe', NEXT_ANCHOR), 'rule', TRASH_LEFT)
    expect(await fixtureSnapshot(t)).toEqual(before)

    await purgeAll(t, demo.org_id)
    expect(await reset(t, NEXT_ANCHOR)).toMatchObject({
      state: 'ready',
      anchor: NEXT_ANCHOR,
      counts: { tasks: MARKETING_DEMO.issues.length },
    })
    // the same uuids and numbers again, the deleted and the stranded included
    const issues = await t.run(async (ctx) => ctx.db.query('issues').collect())
    expect(issues.map((i) => i.id)).toEqual(issueIds)
    expect(new Set(issues.map((i) => i.num)).size).toBe(issues.length)
    await t.run(async (ctx) => {
      for (const table of ['deleted_items', 'deleted_rows', 'deleted_tasks'] as const)
        expect(await ctx.db.query(table).collect(), table).toEqual([])
    })
    await assertNoDanglingRefs(t, 'reset after purging Deleted items')
  }, 60_000)

  it('refuses a seed after a wipe once something reached Deleted items again', async () => {
    const t = newAuthT()
    const demo = await seeded(t)
    await wipe(t)
    // a stored row a purge stopped short of: no item, but a reserved uuid
    await t.run((ctx) =>
      ctx.db.insert('deleted_rows', {
        item_id: uuid(),
        org_id: demo.org_id,
        table: 'milestones',
        owner_id: uuid(),
        row_id: uuid(),
        created_ts: 0,
        row: {
          table: 'milestones',
          doc: { id: uuid(), project_id: uuid(), name: 'Gone', week: ANCHOR, created_at: NOW },
        },
      }),
    )
    await expectRefusal(apply(t, 'seed', NEXT_ANCHOR), 'rule', /work was added after wipe/)
    await expectRefusal(apply(t, 'wipe'), 'rule', TRASH_LEFT)
    await purgeAll(t, demo.org_id)
    expect(await reset(t, NEXT_ANCHOR)).toMatchObject({ state: 'ready' })
  }, 60_000)

  it("refuses a seed whose reserved task uuid another organization's Deleted items keep", async () => {
    const t = newAuthT()
    const foreign = await withOrg(t)
    await seeded(t)
    await wipe(t)
    const reserved = await demoId(`issue:${MARKETING_DEMO.issues[0].key}`)
    await t.run((ctx) =>
      ctx.db.insert('deleted_rows', {
        item_id: uuid(),
        org_id: foreign.org.id,
        table: 'issues',
        owner_id: reserved,
        row_id: reserved,
        created_ts: 0,
        row: {
          table: 'issues',
          doc: {
            id: reserved,
            org_id: foreign.org.id,
            num: 7,
            project_id: foreign.sub.id,
            title: 'Customer work in Deleted items',
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          },
        },
      }),
    )
    // the check steps come before any step that writes work
    const refusal = await expectRefusal(
      seed(t, NEXT_ANCHOR),
      'conflict',
      /reserved task id belongs to another organization/,
    )
    expect(refusal.data.reason).toBe('demo_id_collision')
    expect(await t.query(inspectRef, TARGET)).toMatchObject({
      state: 'seeding',
      counts: { projects: 0, subprojects: 0, tasks: 0 },
    })
    await expectRefusal(apply(t, 'seed', NEXT_ANCHOR), 'conflict', /reserved task id/)
  }, 60_000)

  it('refuses a seed whose reserved task uuid another organization used before, or the demo since its wipe', async () => {
    const t = newAuthT()
    const foreign = await withOrg(t)
    const { org_id } = await seeded(t)
    await wipe(t)
    const reserved = await demoId(`issue:${MARKETING_DEMO.issues[0].key}`)
    // another organization's task that held the id, deleted for good
    const used = await t.run((ctx) =>
      ctx.db.insert('used_ids', { table: 'issues', row_id: reserved, org_id: foreign.org.id }),
    )
    await expectRefusal(checkReserved(t), 'conflict', /reserved task id belongs to another/)
    const refusal = await expectRefusal(
      seed(t, NEXT_ANCHOR),
      'conflict',
      /reserved task id belongs to another organization/,
    )
    expect(refusal.data.reason).toBe('demo_id_collision')
    // a task the demo itself created with the id since the wipe and deleted
    // for good passes the check before a wipe, which lets it go, but a seed
    // check step refuses it, naming the demo as its holder
    await t.run(async (ctx) => {
      await ctx.db.delete(used)
      await ctx.db.insert('used_ids', { table: 'issues', row_id: reserved, org_id })
    })
    await checkReserved(t)
    const own = await expectRefusal(
      seed(t, NEXT_ANCHOR),
      'conflict',
      /reserved task id is still taken by this demo/,
    )
    expect(own.data.reason).toBe('demo_id_taken')
    // a reset lets it go and seeds again
    await reset(t, NEXT_ANCHOR)
    expect(await usedIds(t, org_id)).toHaveLength(
      MARKETING_DEMO.issues.length + MARKETING_DEMO.projects.length,
    )
  }, 120_000)

  it('refuses at a check step, before it writes, a reserved task id a pending detach kept through the wipe', async () => {
    const t = newAuthT()
    const { org_id } = await seeded(t)
    const reserved = await demoId(`issue:${MARKETING_DEMO.issues[0].key}`)
    const detach = await t.run((ctx) =>
      ctx.db.insert('archived_detaches', {
        parent_id: reserved,
        actor_id: uuid(),
        deleted_at: NOW,
        progress_at: NOW,
        attempts: 0,
      }),
    )
    await wipe(t)
    expect(await usedIds(t, org_id)).toMatchObject([{ row_id: reserved, kept: expect.any(Number) }])
    const refusal = await expectRefusal(
      seed(t, NEXT_ANCHOR),
      'conflict',
      /reserved task id is still taken by this demo/,
    )
    expect(refusal.data.reason).toBe('demo_id_taken')
    // the seed wrote nothing
    expect(await t.query(inspectRef, TARGET)).toMatchObject({
      counts: { projects: 0, subprojects: 0, tasks: 0 },
    })
    for (const table of ['teams', 'labels'] as const)
      expect(
        await t.run((ctx) =>
          ctx.db
            .query(table)
            .withIndex('by_org', (q) => q.eq('org_id', org_id))
            .collect(),
        ),
        table,
      ).toEqual([])
    // once the detach ended, a reset lets the id go and seeds
    await t.run((ctx) => ctx.db.delete(detach))
    await reset(t, NEXT_ANCHOR)
    expect(await usedIds(t, org_id)).toHaveLength(
      MARKETING_DEMO.issues.length + MARKETING_DEMO.projects.length,
    )
  }, 120_000)

  it("refuses a reset before its wipe when another organization's row holds a reserved id the demo holds live", async () => {
    const t = newAuthT()
    const foreign = await withOrg(t)
    await seeded(t)
    const reserved = await demoId(`issue:${MARKETING_DEMO.issues[0].key}`)
    // an earlier release after a rollback can leave another organization's
    // row of an id the demo holds
    await t.run((ctx) =>
      ctx.db.insert('used_ids', { table: 'issues', row_id: reserved, org_id: foreign.org.id }),
    )
    const refusal = await expectRefusal(
      checkReserved(t),
      'conflict',
      /reserved task id belongs to another organization/,
    )
    expect(refusal.data.reason).toBe('demo_id_collision')
    expect((await t.query(inspectRef, TARGET)).counts.tasks).toBe(MARKETING_DEMO.issues.length)
  }, 60_000)
})

describe('marketing demo seed steps', () => {
  // The whole seed in one transaction wrote about 1,400 documents and read
  // about 2,500 index ranges, and the reserved-id check alone took up to 2 s
  // on a loaded machine. Every call of a seed, a check or a wipe now does a
  // small, bounded part of that.
  it('seeds, checks and wipes in calls of at most 300 index ranges, 350 documents read and 150 written', async () => {
    const t = newAuthT({
      transactionLimits: { databaseQueries: 300, documentsRead: 350, documentsWritten: 150 },
    })
    await provision(t)
    const answers = [await apply(t, 'seed')]
    while (answers.at(-1)?.seed_done === false && answers.length < 200)
      answers.push(await apply(t, 'seed'))
    const steps = answers[0].seed_steps ?? 0
    // the check parts, the work and the usage history
    expect(steps).toBe(RESERVED_PARTS + NORTHSTAR_STEPS.length + 1)
    expect(answers.slice(0, -1).map((a) => [a.state, a.seed_step])).toEqual(
      Array.from({ length: steps }, (_, step) => ['seeding', step]),
    )
    expect(answers.at(-1)).toMatchObject({
      state: 'ready',
      seed_done: true,
      anchor: ANCHOR,
      counts: { projects: 3, subprojects: 12, tasks: MARKETING_DEMO.issues.length, users: 8 },
    })
    expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').unique())).not.toHaveProperty(
      'seed',
    )
    expect(await wipe(t)).toMatchObject({ state: 'empty', counts: { tasks: 0 } })
  }, 60_000)

  // first call, then the check parts: the next call is the setup step
  const toSetup = async (t: T, anchor = ANCHOR) => {
    for (let call = 0; call <= RESERVED_PARTS; call++) await apply(t, 'seed', anchor)
  }
  /* Moves the live row of `issue` into Deleted items, as a delete's first
   * step leaves it while its links are still to follow. */
  const trashTask = (t: T, issue: Doc<'issues'>) =>
    t.run(async (ctx) => {
      const { _id, _creationTime, ...doc } = issue
      await ctx.db.delete(_id)
      await ctx.db.insert('deleted_rows', {
        item_id: uuid(),
        org_id: issue.org_id,
        table: 'issues',
        owner_id: issue.id,
        row_id: issue.id,
        created_ts: _creationTime,
        row: { table: 'issues', doc },
      })
    })

  it('refuses a work step whose uuid another organization took after the check parts, and writes nothing', async () => {
    const t = newAuthT()
    const foreign = await withOrg(t)
    const { org_id } = await provision(t)
    await toSetup(t)
    // a client-supplied uuid created between the check parts and the setup
    await plantProject(t, {
      org_id: foreign.org.id,
      id: await demoId(`project:${MARKETING_DEMO.projects[0].key}`),
      name: 'Customer project',
    })
    await expectRefusal(apply(t, 'seed'), 'conflict', /reserved project id belongs to another/)
    expect(await t.query(inspectRef, TARGET)).toMatchObject({
      state: 'seeding',
      counts: { projects: 0, subprojects: 0, tasks: 0 },
    })
    for (const table of ['teams', 'labels'] as const) {
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect(),
      )
      expect(rows, table).toEqual([])
    }
    expect(await countersFor(t, org_id)).toEqual({ next_issue_num: 0, next_project_num: 0 })
  }, 60_000)

  it('refuses to resume a seed once work was added or moved to Deleted items since it began', async () => {
    const t = newAuthT()
    const { org_id } = await provision(t)
    await apply(t, 'seed')
    // work added after the first call, before the setup step
    const project = await plantProject(t, { org_id, name: 'Walkthrough notes' })
    const task = await plantIssue(t, { org_id, project_id: project.id, title: 'Keep me' })
    const counters = await countersFor(t, org_id)
    await expectRefusal(seed(t), 'rule', /work was added after wipe; use reset/)
    expect(await t.run(async (ctx) => ctx.db.get(task._id))).toEqual(task)
    expect(await countersFor(t, org_id)).toEqual(counters)
    // a seeded task moved to Deleted items after the setup step
    await reset(t)
    await wipe(t)
    await toSetup(t)
    await apply(t, 'seed')
    await apply(t, 'seed')
    const seededTask = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
    await trashTask(t, seededTask)
    const tasks = (await t.query(inspectRef, TARGET)).counts.tasks
    await expectRefusal(seed(t), 'rule', /work changed during the seed; use reset/)
    expect((await t.query(inspectRef, TARGET)).counts.tasks).toBe(tasks)
  }, 120_000)

  it('refuses a work step whose row the demo already holds, and a receipt from another step layout', async () => {
    const t = newAuthT()
    const { org_id } = await provision(t)
    await toSetup(t)
    await apply(t, 'seed')
    // a demo user creates a task with a computed reserved uuid between calls
    const project = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .filter((q) => q.eq(q.field('type'), 'project'))
        .first(),
    )
    const reserved = await demoId(`issue:${MARKETING_DEMO.issues[0].key}`)
    await plantIssue(t, { org_id, project_id: project!.id, id: reserved, title: 'Look-alike' })
    await expectRefusal(apply(t, 'seed'), 'rule', /work changed during the seed; use reset/)
    const withId = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', reserved))
        .collect(),
    )
    expect(withId.map((issue) => issue.title)).toEqual(['Look-alike'])
    // a step index written under another layout of the steps
    await reset(t)
    await wipe(t)
    await apply(t, 'seed')
    await apply(t, 'seed')
    await t.run(async (ctx) => {
      const receipt = await ctx.db.query('marketing_demo').unique()
      await ctx.db.patch(receipt!._id, { seed: { ...receipt!.seed!, layout: 'another layout' } })
    })
    await expectRefusal(apply(t, 'seed'), 'rule', /use reset to change dates or dataset version/)
  }, 120_000)

  it('refuses a task step whose label or parent task was deleted or moved since it was written', async () => {
    const t = newAuthT()
    await provision(t)
    await toSetup(t)
    await apply(t, 'seed')
    // a label delete is final, not a Deleted items entry
    const labelId = await demoId(`label:${MARKETING_DEMO.issues[0].labels[0]}`)
    await t.run(async (ctx) => {
      const label = await ctx.db
        .query('labels')
        .withIndex('by_uuid', (q) => q.eq('id', labelId))
        .unique()
      await ctx.db.delete(label!._id)
    })
    await expectRefusal(apply(t, 'seed'), 'rule', /a seeded label is missing; use reset/)
    expect((await t.query(inspectRef, TARGET)).counts.tasks).toBe(0)
    // a parent task gone once its step ran: the first task of a later step
    // whose parent an earlier step wrote
    await reset(t)
    await wipe(t)
    await toSetup(t)
    await apply(t, 'seed')
    const child = MARKETING_DEMO.issues.findIndex(
      (issue, index) =>
        issue.parent !== undefined &&
        MARKETING_DEMO.issues.findIndex((p) => p.key === issue.parent) <
          index - (index % NORTHSTAR_BATCH.tasks),
    )
    for (let step = 0; step < Math.floor(child / NORTHSTAR_BATCH.tasks); step++)
      await apply(t, 'seed')
    const parentId = await demoId(`issue:${MARKETING_DEMO.issues[child].parent}`)
    await t.run(async (ctx) => {
      const parent = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', parentId))
        .unique()
      await ctx.db.delete(parent!._id)
    })
    const tasks = (await t.query(inspectRef, TARGET)).counts.tasks
    await expectRefusal(apply(t, 'seed'), 'rule', /a seeded task is missing; use reset/)
    expect((await t.query(inspectRef, TARGET)).counts.tasks).toBe(tasks)
    // the same parent moved to another project instead
    await reset(t)
    await wipe(t)
    await toSetup(t)
    await apply(t, 'seed')
    for (let step = 0; step < Math.floor(child / NORTHSTAR_BATCH.tasks); step++)
      await apply(t, 'seed')
    const home = MARKETING_DEMO.issues.find((it) => it.key === MARKETING_DEMO.issues[child].parent)
    const elsewhere = MARKETING_DEMO.projects.find(
      (project) => project.parent !== undefined && project.key !== home?.project,
    )
    const elsewhereId = await demoId(`project:${elsewhere!.key}`)
    await t.run(async (ctx) => {
      const parent = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', parentId))
        .unique()
      await ctx.db.patch(parent!._id, { project_id: elsewhereId })
    })
    const written = (await t.query(inspectRef, TARGET)).counts.tasks
    await expectRefusal(apply(t, 'seed'), 'rule', /parent task moved to another project; use reset/)
    expect((await t.query(inspectRef, TARGET)).counts.tasks).toBe(written)
  }, 180_000)

  it("passes the check for an owned link whose task is in the demo's own Deleted items", async () => {
    const t = newAuthT()
    await seeded(t)
    const link = MARKETING_DEMO.links[0]
    const sourceId = await demoId(`issue:${link.source}`)
    const source = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', sourceId))
        .unique(),
    )
    await trashTask(t, source!)
    await checkReserved(t)
  }, 60_000)

  it('resumes a stopped seed at its next step, refuses another anchor until a reset, and wipes a half-seeded demo', async () => {
    const t = newAuthT()
    await provision(t)
    await apply(t, 'seed')
    await apply(t, 'seed')
    expect(await t.query(inspectRef, TARGET)).toMatchObject({ state: 'seeding', anchor: ANCHOR })
    await expectRefusal(apply(t, 'seed', NEXT_ANCHOR), 'rule', /use reset to change dates/)
    // the refused call wrote nothing, and the same anchor carries on
    expect(await apply(t, 'seed')).toMatchObject({ state: 'seeding', seed_step: 2 })
    expect(await seed(t)).toMatchObject({
      state: 'ready',
      counts: { tasks: MARKETING_DEMO.issues.length },
    })
    // a seed stopped part way, then a reset to another week
    await wipe(t)
    await apply(t, 'seed', NEXT_ANCHOR)
    expect(await wipe(t, NEXT_ANCHOR)).toMatchObject({ state: 'empty', counts: { tasks: 0 } })
    expect(await t.run(async (ctx) => ctx.db.query('marketing_demo').unique())).not.toHaveProperty(
      'seed',
    )
    expect(await seed(t, NEXT_ANCHOR)).toMatchObject({ state: 'ready', anchor: NEXT_ANCHOR })
    await assertNoDanglingRefs(t, 'marketing demo resumed seed')
  }, 60_000)
})

describe('marketing demo dataset upgrades', () => {
  it.each([1, 2, 3, MARKETING_DEMO_VERSION + 1])(
    'preserves every row on seed from dataset version %s and requires an explicit reset',
    async (version) => {
      const t = newAuthT()
      const demo = await seeded(t)
      const avatar = await storeImage(t)
      await t.mutation(avatarRef, { ...TARGET, person: 'nora', storage_id: avatar })
      const roster = await profiles(t, demo.org_id)
      const task = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
      await t.run(async (ctx) => {
        await ctx.db.patch(task._id, { title: 'Preserve this edited task until reset' })
        const receipt = await ctx.db.query('marketing_demo').unique()
        await ctx.db.patch(receipt!._id, { version })
      })
      const before = await fixtureSnapshot(t)
      await expectRefusal(apply(t, 'seed'), 'rule', /use reset to change dates or dataset version/)
      expect(await fixtureSnapshot(t)).toEqual(before)
      expect(await reset(t)).toMatchObject({
        version: MARKETING_DEMO_VERSION,
        state: 'ready',
        counts: { ...demo.counts, avatars: 1 },
      })
      expect(await profiles(t, demo.org_id)).toEqual(roster)
      expect(await t.run(async (ctx) => ctx.db.get(task._id))).toBeNull()
      expect(await t.run(async (ctx) => ctx.db.system.get(avatar))).not.toBeNull()
      await assertNoDanglingRefs(t, 'marketing demo version reset')
    },
    30_000,
  )
})

describe('marketing demo avatar ownership', () => {
  it('adopts fresh bytes idempotently and refuses bytes belonging to another profile or an attachment', async () => {
    const t = newAuthT()
    const result = await seeded(t)
    const avatar = await storeImage(t)
    await t.mutation(avatarRef, { ...TARGET, person: 'nora', storage_id: avatar })
    await t.mutation(avatarRef, { ...TARGET, person: 'nora', storage_id: avatar })
    await expectRefusal(
      t.mutation(avatarRef, { ...TARGET, person: 'leo', storage_id: avatar }),
      'bad_request',
      /already belong/,
    )
    const file = await storeImage(t)
    const task = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
    await t.run(async (ctx) =>
      ctx.db.insert('issue_attachments', {
        org_id: task.org_id,
        id: uuid(),
        issue_id: task.id,
        name: 'already-attached.jpg',
        size_bytes: 13,
        storage_id: file,
        inline: false,
        created_at: NOW,
      }),
    )
    await expectRefusal(
      t.mutation(avatarRef, { ...TARGET, person: 'leo', storage_id: file }),
      'bad_request',
      /already belong/,
    )
    const roster = await profiles(t, result.org_id)
    expect(roster.find((p) => p.email === 'leo@demo.qivo.io')?.avatar_storage_id).toBeUndefined()
    expect(await t.run(async (ctx) => ctx.db.system.get(avatar))).not.toBeNull()
    expect(await t.run(async (ctx) => ctx.db.system.get(file))).not.toBeNull()
  })
})
