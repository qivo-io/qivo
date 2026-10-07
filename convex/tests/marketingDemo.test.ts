/* Isolated fixture boundaries: only the receipt-owned demo may be
 * rebuilt, and repeat seeding must preserve both manual work and real login
 * identities. The local Better Auth component is the deployed schema. These
 * tests exercise its actual adapter without paying for scrypt hashing. */
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import {
  DEMO_SYNC_TIME,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingInstant,
} from '../internal/marketingDemoData'
import { canSeeProject, hasProjectLevel } from '../lib/access'
import { logActivity } from '../model/activity'
import { newOrgDefaults, newTeamDefaults } from '../model/orgs'
import schema from '../schema'
import {
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
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
  state: 'absent' | 'empty' | 'ready'
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
  Inspection
>('internal/marketingDemo:apply')
const avatarRef = makeFunctionReference<
  'mutation',
  typeof TARGET & { person: string; storage_id: Id<'_storage'> },
  null
>('internal/marketingDemo:adoptAvatar')

const newAuthT = (): T => {
  const t = newT()
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
// The CLI's reset: two transactions, a wipe and then a seed.
const reset = async (t: T, anchor = ANCHOR) => {
  await apply(t, 'wipe', anchor)
  return await apply(t, 'seed', anchor)
}
const profiles = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
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
  return await apply(t, 'seed')
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
      expect(meta.icon).toBeTruthy()
    }
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
      for (const task of tasks) {
        const children = tasks.filter((child) => child.parent_id === task.id)
        if (children.length) {
          expect(children.length, task.title).toBeGreaterThanOrEqual(2)
          expect(children.length, task.title).toBeLessThanOrEqual(4)
          expect(task.remaining_hours).toBeUndefined()
        }
        if (task.archived_at !== undefined) expect(task.status).toBe('done')
        if (task.end_week !== undefined && task.due_date !== undefined) {
          // A scheduled week includes Friday, the latest planned working day.
          const plannedEnd = Date.parse(task.end_week) + 4 * 86_400_000
          expect(plannedEnd, task.title).toBeLessThanOrEqual(Date.parse(task.due_date))
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
      for (const comment of comments.toSorted((a, b) => a.created_at.localeCompare(b.created_at))) {
        if (comment.author === undefined) throw new Error('Seeded comment is missing its author')
        const participants = expectedRecipients.get(comment.issue_id)!
        participants.add(comment.author)
        for (const participant of participants) {
          if (participant !== comment.author)
            expectedMessages.push(
              JSON.stringify([comment.issue_id, comment.author, participant, comment.created_at]),
            )
        }
      }
      expect(
        messages
          .filter((message) => message.kind === 'comment')
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
    // Identities are retained; only the dated Team sync stamps follow the anchor.
    const unstamped = (rows: Doc<'profiles'>[]) =>
      rows.map((row) => ({ ...row, sync_at: undefined }))
    const profilesAfter = await profiles(t, result.org_id)
    expect(unstamped(profilesAfter)).toEqual(unstamped(stableProfiles))
    for (const person of MARKETING_DEMO.people) {
      expect(profilesAfter.find((p) => p.name === person.name)?.sync_at, person.key).toBe(
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
    expect(await t.run(async (ctx) => ctx.db.system.get(file))).toBeNull()
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
    const task = (await t.run(async (ctx) => ctx.db.query('issues').collect()))[0]
    await t.run(async (ctx) => {
      const nora = (await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', noraId))
        .unique())!
      await ctx.db.patch(nora._id, {
        message_retention_days: undefined,
        // Team sync stamps from interactive use, on a person the seed leaves unstamped
        sync_at: NOW,
        sync_since: NOW,
      })
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
      // Every stamp is set or cleared from the dataset, following the anchor.
      for (const person of MARKETING_DEMO.people) {
        const row = roster.find((p) => p.name === person.name)
        expect(row?.sync_at, person.key).toBe(
          person.syncDay === undefined
            ? undefined
            : marketingInstant(anchor, person.syncDay, DEMO_SYNC_TIME),
        )
        expect(row?.sync_since, person.key).toBeUndefined()
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
      expect(after.messages.every((message) => message.read_at === undefined)).toBe(true)
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

  it('wipe removes work but preserves the roster and allows reseeding with stable issue UUIDs', async () => {
    const t = newAuthT()
    const result = await seeded(t)
    const roster = await profiles(t, result.org_id)
    const issueIds = (await t.run(async (ctx) => ctx.db.query('issues').collect())).map((i) => i.id)
    await t.run(async (ctx) => {
      const org = (await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', result.org_id))
        .unique())!
      await ctx.db.patch(org._id, { activity_count: 500 })
    })
    expect(await apply(t, 'wipe')).toMatchObject({
      state: 'empty',
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
      expect(
        (await ctx.db
          .query('organizations')
          .withIndex('by_uuid', (q) => q.eq('id', result.org_id))
          .unique())!.activity_count,
      ).toBe(1)
    })
    await apply(t, 'seed', NEXT_ANCHOR)
    expect((await t.run(async (ctx) => ctx.db.query('issues').collect())).map((i) => i.id)).toEqual(
      issueIds,
    )
  }, 30_000)

  it('does not treat an empty receipt as permission to erase manual work added after wipe', async () => {
    const t = newAuthT()
    const demo = await seeded(t)
    await apply(t, 'wipe')
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

  it.each(['comment', 'milestone', 'link', 'activity'] as const)(
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
          const id = await demoId(`activity:import:${MARKETING_DEMO.issues[0].key}`)
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
