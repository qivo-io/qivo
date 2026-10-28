import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../convex/lib/limits'
import {
  inboxCommentId,
  parseSeedArgs,
  planInbox,
  planSeed,
  runBoardScaleSeed,
  seededTask,
  seededTasks,
} from './board-scale-seed.mjs'

/* A local backend the seed talks to: Nora and the people in `fake.people`,
   Northstar with one sub-project, the tasks `fake.issues` holds, in the
   workspace parts, the personal tokens `fake.tokens` holds, the usage rows
   `fake.usage` holds, and every mutation it receives, with the login it
   came as. A comment whose id `fake.comments` holds is refused as taken. */
const fake = vi.hoisted(() => ({
  issues: [],
  calls: [],
  people: [],
  comments: new Set(),
  tokens: [],
  usage: [],
}))
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    setAdminAuth(_key, identity) {
      this.login = identity?.subject
    }
    async query(ref, args) {
      const name = getFunctionName(ref)
      // a system table answers the admin itself, never a person it acts as
      if (name === '_system/cli/tableData' && this.login)
        throw new Error("You don't have permission to perform this operation.")
      if (name === '_system/cli/tableData')
        return {
          page: {
            profiles: [
              {
                email: 'nora@demo.qivo.io',
                auth_user_id: 'nora-login',
                id: 'nora',
                name: 'Nora Lindqvist',
                org_id: 'org',
                kind: 'person',
                active: true,
              },
              ...fake.people,
            ],
            mcp_tokens: fake.tokens,
            agent_keys: [],
            billing_usage: fake.usage,
          }[args.table],
          isDone: true,
        }
      // the workspace parts (convex/workspace.ts), one window of each kind
      return {
        'workspace:root': {
          auth_user_id: 'nora-login',
          myProfileIds: ['nora'],
          orgs: [{ id: 'org' }],
        },
        'workspace:catalog': { state: 'ok', teams: [], labels: [] },
        'workspace:people': { state: 'ok', profiles: [], teamMembers: [] },
        'workspace:projects': {
          state: 'ok',
          projects: [{ id: 'sub', org_id: 'org', type: 'project' }],
          access: [],
          teamAccess: [],
          milestones: [],
        },
        'workspace:tasks': {
          state: 'ok',
          issues: fake.issues,
          links: [],
          issueLabels: [],
          attachments: [],
          issueSubs: [],
          orgLoad: [],
        },
        'workspace:inbox': {
          state: 'ok',
          unread: [],
          read: [],
          readMessageCount: 0,
          unreadTruncated: false,
          readTruncated: false,
          truncated: false,
        },
      }[name]
    }
    async mutation(ref, fields) {
      const name = getFunctionName(ref)
      fake.calls.push([name, fields, this.login])
      if (name !== 'comments:create') return
      if (fake.comments.has(fields.id))
        throw Object.assign(new Error('taken'), {
          data: { message: 'a comment with this id already exists' },
        })
      fake.comments.add(fields.id)
    }
  },
}))

const local = ['--local', '--deployment', 'local-scale-3214', '--url', 'http://127.0.0.1:3214']
const env = { QIVO_FIXTURE_LOCAL: 'true', QIVO_LOCAL_ADMIN_KEY: 'local-admin-key-1111' }

describe('board-scale-seed', () => {
  it('takes a local target and a task count', () => {
    expect(parseSeedArgs([...local, '--tasks', '500'])).toMatchObject({
      target: 'local',
      deployment: 'local-scale-3214',
      tasks: 500,
    })
    expect(parseSeedArgs(local).tasks).toBe(10_000)
  })

  it('takes an inbox count up to the task count', () => {
    expect(parseSeedArgs([...local, '--tasks', '1300', '--inbox', '600']).inbox).toBe(600)
    expect(parseSeedArgs(local).inbox).toBe(0)
    expect(() => parseSeedArgs([...local, '--tasks', '100', '--inbox', '101'])).toThrow(/--inbox/)
    expect(() => parseSeedArgs([...local, '--inbox', '-1'])).toThrow(/--inbox/)
    expect(() => parseSeedArgs([...local, '--inbox', '2.5'])).toThrow(/--inbox/)
    // no tasks hold no inbox items
    expect(parseSeedArgs([...local, '--tasks', '0']).inbox).toBe(0)
    expect(() => parseSeedArgs([...local, '--tasks', '0', '--inbox', '1'])).toThrow(/--inbox/)
  })

  it('refuses anything but a disposable local backend before it connects', async () => {
    expect(() => parseSeedArgs(['--url', 'http://127.0.0.1:3214'])).toThrow(/--local backend only/)
    expect(() => parseSeedArgs([...local, '--tasks', '-1'])).toThrow(/--tasks/)
    expect(() => parseSeedArgs([...local, '--tasks', '30001'])).toThrow(/0 to 30000/)
    expect(parseSeedArgs([...local, '--tasks', '0']).tasks).toBe(0)
    // credentials call the backend's own site origin, on loopback only
    expect(() => parseSeedArgs([...local, '--credentials', '5'])).toThrow(/--api-url/)
    expect(() =>
      parseSeedArgs([...local, '--credentials', '5', '--api-url', 'https://x.convex.site']),
    ).toThrow(/--api-url/)
    expect(() =>
      parseSeedArgs([...local, '--credentials', '501', '--api-url', 'http://127.0.0.1:3215']),
    ).toThrow(/0 to 500/)
    expect(parseSeedArgs([...local, '--tasks', '30000']).tasks).toBe(30_000)
    const refused = (args, extra = {}) =>
      runBoardScaleSeed(args, { env: { ...env, ...extra }, log: () => {} })
    await expect(
      refused(['--local', '--deployment', 'local-scale-3214', '--url', 'https://x.convex.cloud']),
    ).rejects.toThrow(/loopback/)
    await expect(refused(local, { QIVO_ENVIRONMENT: 'production' })).rejects.toThrow(/refuses/)
    await expect(refused(local, { CONVEX_DEPLOY_KEY: 'prod:qva_1111111111' })).rejects.toThrow(
      /CONVEX_DEPLOY_KEY/,
    )
    await expect(refused(local, { QIVO_FIXTURE_LOCAL: '' })).rejects.toThrow(/QIVO_FIXTURE_LOCAL/)
  })

  it('mixes statuses, owners, due dates, pauses and long titles the server accepts', () => {
    const tasks = Array.from({ length: 1000 }, (_, n) => seededTask(n, 'org', 'project', 'owner'))
    expect(new Set(tasks.map((task) => task.status)).size).toBe(5)
    expect(tasks.filter((task) => task.assignee_id === null)).toHaveLength(91)
    expect(tasks.filter((task) => task.due_date).length).toBe(143)
    expect(tasks.some((task) => task.due_date && task.due_date < new Date().toISOString())).toBe(
      true,
    )
    expect(
      tasks.filter((task) => task.paused).every((t) => !['backlog', 'done'].includes(t.status)),
    ).toBe(true)
    expect(Math.max(...tasks.map((task) => task.title.length))).toBeLessThanOrEqual(
      LIMITS.title.max,
    )
    expect(Math.max(...tasks.map((task) => task.title.length))).toBeGreaterThan(
      LIMITS.title.max - 20,
    )
    // titles read like Northstar's: words, no numbers, about 40 characters
    const short = tasks.filter((_, n) => n % 13).map((task) => task.title.length)
    const median = short.sort((a, b) => a - b)[short.length >> 1]
    expect(median).toBeGreaterThan(30)
    expect(median).toBeLessThan(55)
    expect(tasks.some((task) => /\d/.test(task.title))).toBe(false)
    expect(new Set(tasks.map((task) => task.title)).size).toBeGreaterThan(300)
    expect(tasks[41].description).toBe('Seeded by board-scale-seed as task 42.')
  })

  it('plans only the tasks still missing, family by family', () => {
    const fresh = planSeed(60, new Map())
    expect(fresh.added).toBe(60)
    // a family every 25th task: its first task, a parent and three more
    expect(fresh.list.filter((job) => job.family).map((job) => job.first)).toEqual([0, 25, 50])
    const done = (numbers, parent = 'parent') =>
      new Map(
        numbers.map((n) => [n, { task: { id: `task${n}` }, parent: n % 25 > 3 ? null : parent }]),
      )
    // a re-run finds 0 to 9 and 30 to 59, and adds 10 to 29 without repeats
    const present = done([...Array(10).keys(), ...Array.from({ length: 30 }, (_, i) => i + 30)])
    const resumed = planSeed(60, present)
    expect(resumed.list.map((job) => job.first)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => i + 10),
      25,
      29,
    ])
    expect(resumed.added).toBe(20)
    expect(planSeed(60, done([...Array(60).keys()])).added).toBe(0)
  })

  it('finishes a family a stopped run left partial, under the parent it made', () => {
    // the first task and its parent, then one of three subtasks
    const partial = planSeed(
      30,
      new Map([
        ...doneUpTo(25),
        [25, { task: { id: 'h' }, parent: 'p' }],
        [26, { task: {}, parent: 'p' }],
      ]),
    )
    expect(partial.list).toEqual([
      {
        first: 25,
        family: true,
        head: false,
        existing: { id: 'h' },
        parent: 'p',
        missing: [2, 3],
        attach: [],
      },
      { first: 29, family: false },
    ])
    expect(partial.added).toBe(3)
    // the first task alone: its parent and every subtask are still to make
    const headOnly = planSeed(
      30,
      new Map([...doneUpTo(25), [25, { task: { id: 'h' }, parent: null }]]),
    )
    expect(headOnly.list[0]).toEqual({
      first: 25,
      family: true,
      head: false,
      existing: { id: 'h' },
      parent: null,
      missing: [1, 2, 3],
      attach: [],
    })
    expect(headOnly.added).toBe(4)
  })

  it('attaches the tasks a smaller --tasks seeded on their own when the family grows', () => {
    // --tasks 27 seeds 25 and 26 on their own; --tasks 30 makes them a family
    const grown = planSeed(
      30,
      new Map([
        ...doneUpTo(25),
        [25, { task: { id: 'h' }, parent: null }],
        [26, { task: { id: 's' }, parent: null }],
      ]),
    )
    expect(grown.list).toEqual([
      {
        first: 25,
        family: true,
        head: false,
        existing: { id: 'h' },
        parent: null,
        missing: [2, 3],
        attach: [{ id: 's' }],
      },
      { first: 29, family: false },
    ])
    // once attached, the family is complete
    const after = planSeed(
      30,
      new Map([
        ...doneUpTo(25),
        ...[25, 26, 27, 28, 29].map((n) => [
          n,
          { task: { id: `t${n}` }, parent: n === 29 ? null : 'p' },
        ]),
      ]),
    )
    expect(after.list).toEqual([])
  })

  it('reads the seeded tasks from their marks and old titles, not parents or other tasks', () => {
    const found = seededTasks([
      { title: 'Tune the beta checklist', description: 'Seeded by board-scale-seed as task 12.' },
      { title: 'Board scale ship task 31', parent_id: 'p' },
      { title: 'Board scale parent 26' },
      { title: 'Coordinate sensor readings' },
      { title: 'Order the pilot batch', description: 'Not seeded as task 3.' },
    ])
    expect([...found.keys()].sort((a, b) => a - b)).toEqual([11, 30])
    expect(found.get(30)?.parent).toBe('p')
    expect(found.get(11)?.parent).toBe(null)
  })
})

/** The seeded tasks before `n`, families complete: a family's first task
    and its three subtasks under one parent. */
function doneUpTo(n) {
  return Array.from({ length: n }, (_, i) => [
    i,
    { task: { id: `t${i}` }, parent: i % 25 > 3 ? null : 'p0' },
  ])
}

describe('a rerun of board-scale-seed', () => {
  it('finishes a partial family under the parent it made, with the existing task', async () => {
    // tasks 0 to 29 are all there but family 25: its first task alone
    const seeded = (n, more = {}) => ({
      ...seededTask(n, 'org', 'sub', 'owner'),
      id: `task${n}`,
      parent_id: n === 0 ? 'parent0' : null,
      ...more,
    })
    fake.issues = Array.from({ length: 30 }, (_, n) => seeded(n)).filter((_, n) => n < 26 || n > 28)
    // Family 0's subtasks name their parent
    for (const task of fake.issues)
      if (/as task [234]\./.test(task.description)) task.parent_id = 'parent0'
    fake.calls = []
    await runBoardScaleSeed([...local, '--tasks', '30'], { env, log: () => {} })
    const [parent, ...rest] = fake.calls
    expect(parent[0]).toBe('issues:createParent')
    expect(parent[1]).toMatchObject({ id: 'task25', org_id: 'org' })
    expect(rest.map(([name, fields]) => [name, fields.description, fields.parent_id])).toEqual([
      ['issues:create', 'Seeded by board-scale-seed as task 27.', parent[1].parent_id],
      ['issues:create', 'Seeded by board-scale-seed as task 28.', parent[1].parent_id],
      ['issues:create', 'Seeded by board-scale-seed as task 29.', parent[1].parent_id],
    ])
    for (const [, fields] of rest) expect(fields.project_id).toBe('sub')
  })

  it('moves a task seeded on its own into the family it joins, then attaches it', async () => {
    // a run with --tasks 27 left 25 and 26 on their own, 26 in another project
    fake.issues = Array.from({ length: 27 }, (_, n) => ({
      ...seededTask(n, 'org', n === 26 ? 'other' : 'sub', 'owner'),
      id: `task${n}`,
      parent_id: n % 25 === 0 && n < 25 ? 'parent0' : null,
    }))
    for (const task of fake.issues)
      if (/as task [234]\./.test(task.description)) task.parent_id = 'parent0'
    fake.calls = []
    await runBoardScaleSeed([...local, '--tasks', '30'], { env, log: () => {} })
    const parent = fake.calls[0][1].parent_id
    expect(fake.calls.map(([name, fields]) => [name, fields.description ?? fields.id])).toEqual([
      ['issues:createParent', 'task25'],
      ['issues:create', 'Seeded by board-scale-seed as task 28.'],
      ['issues:create', 'Seeded by board-scale-seed as task 29.'],
      ['issues:move', 'task26'],
      ['issues:update', 'task26'],
      ['issues:create', 'Seeded by board-scale-seed as task 30.'],
    ])
    expect(fake.calls[3][1]).toEqual({
      id: 'task26',
      org_id: 'org',
      project_id: 'sub',
      detach_parent: true,
    })
    expect(fake.calls[4][1]).toEqual({ id: 'task26', org_id: 'org', patch: { parent_id: parent } })
  })
})

describe('board-scale-seed --inbox', () => {
  const sub = (n, more = {}) => ({
    ...seededTask(n, 'org', 'sub', n % 2 ? 'ana' : 'bo'),
    id: `task${n}`,
    parent_id: null,
    ...more,
  })
  const people = [
    { id: 'ana', name: 'Ana', auth_user_id: 'ana-login', org_id: 'org', org_role: 'user' },
    { id: 'bo', name: 'Bo', auth_user_id: 'bo-login', org_id: 'org', org_role: 'admin' },
    // an agent has no login, and a viewer cannot comment
    { id: 'relay', name: 'Relay', org_id: 'org', org_role: 'user' },
    { id: 'vi', name: 'Vi', auth_user_id: 'vi-login', org_id: 'org', org_role: 'viewer' },
  ]

  it('mentions Nora on the first tasks that are not archived, each as an owner with a login', () => {
    const present = seededTasks([
      sub(2),
      sub(0),
      sub(1, { archived_at: '2026-10-01T00:00:00.000Z' }),
      sub(3),
      { ...sub(4), project_id: 'empty' },
    ])
    const posters = new Map([['sub', people.slice(0, 2)]])
    const plan = planInbox(3, present, posters, { id: 'nora-id', name: 'Nora Lindqvist' })
    expect(plan.map(({ task, poster }) => [task.id, poster.id])).toEqual([
      ['task0', 'ana'],
      ['task2', 'ana'],
      ['task3', 'bo'],
    ])
    for (const { fields, task } of plan) {
      expect(fields).toMatchObject({
        id: inboxCommentId(task.id),
        issue_id: task.id,
        org_id: 'org',
      })
      expect(fields.body).toMatch(/^@\[Nora Lindqvist\]\(user:nora-id\) \S/)
    }
    // the same task always gets the same comment id, a lowercase UUID
    expect(inboxCommentId('task0')).toBe(inboxCommentId('task0'))
    expect(inboxCommentId('task0')).not.toBe(inboxCommentId('task1'))
    expect(inboxCommentId('task0')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('posts as the owners, never Nora, a viewer or an agent, and a rerun adds only what is missing', async () => {
    fake.people = people
    fake.issues = Array.from({ length: 6 }, (_, n) =>
      sub(n, { assignee_id: ['ana', 'bo', 'relay', 'vi', 'nora', 'ana'][n] }),
    )
    fake.comments = new Set()
    fake.calls = []
    const lines = []
    await runBoardScaleSeed([...local, '--tasks', '6', '--inbox', '4'], {
      env,
      log: (line) => lines.push(line),
    })
    const comments = () => fake.calls.filter(([name]) => name === 'comments:create')
    expect(comments().map(([, fields, login]) => [fields.issue_id, login])).toEqual([
      ['task0', 'ana-login'],
      ['task1', 'bo-login'],
      ['task2', 'ana-login'],
      ['task3', 'bo-login'],
    ])
    expect(lines.at(-1)).toBe('Done: 4 inbox comments posted for Nora, 0 there before.')
    // a larger count posts on the next tasks only
    fake.calls = []
    await runBoardScaleSeed([...local, '--tasks', '6', '--inbox', '6'], {
      env,
      log: (line) => lines.push(line),
    })
    expect(comments().map(([, fields]) => fields.issue_id)).toEqual([
      'task0',
      'task1',
      'task2',
      'task3',
      'task4',
      'task5',
    ])
    expect(fake.comments.size).toBe(6)
    expect(lines.at(-1)).toBe('Done: 2 inbox comments posted for Nora, 4 there before.')
    fake.people = []
  })
})

describe('board-scale-seed credentials', () => {
  // a person with a login and an agent beside Nora
  beforeEach(() => {
    fake.people = [
      { auth_user_id: 'leo-login', id: 'leo', org_id: 'org', kind: 'person', active: true },
      { id: 'atlas', org_id: 'org', kind: 'agent', active: true },
    ]
  })
  afterEach(() => {
    fake.people = []
  })

  it('adds tokens as their owners and agent keys as Nora, each with its calls, and only the missing ones again', async () => {
    fake.calls = []
    fake.issues = []
    // number 1 made its two calls in an earlier run
    fake.tokens = [{ id: 'made', name: 'Raycast (scale 1)', profile_id: 'leo' }]
    fake.usage = [{ org_id: 'org', credential_id: 'mcp_tokens:made', calls: 2 }]
    const fetched = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        fetched.push([url, init.headers.Authorization.slice(0, 4)])
        return { ok: true, status: 200, headers: new Headers() }
      }),
    )
    await runBoardScaleSeed(
      [...local, '--tasks', '0', '--credentials', '4', '--api-url', 'http://127.0.0.1:3215'],
      { env, log: () => {} },
    )
    vi.unstubAllGlobals()
    // number 1 is there already; 2 and 3 are tokens, 4 an agent key
    expect(fake.calls.map(([name, fields, as]) => [name, fields.name, as])).toEqual([
      ['tokens:createMcpToken', 'Zed (scale 2)', 'nora-login'],
      ['tokens:createMcpToken', 'Sheets sync (scale 3)', 'leo-login'],
      ['tokens:createAgentKey', 'Nightly build (scale 4)', 'nora-login'],
    ])
    expect(fake.calls[0][1]).toMatchObject({ profile_id: 'nora', access: 'read' })
    expect(fake.calls[0][1].token_prefix).toMatch(/^qvt_[0-9a-f]{7}$/)
    expect(fake.calls[2][1]).toMatchObject({ org_id: 'org', agent_id: 'atlas' })
    expect(fake.calls[2][1].key_prefix).toMatch(/^qva_[0-9a-f]{3}\.\.\.[0-9a-f]{5}$/)
    // 1 + n % 4 calls each, with the new secrets, on the site origin
    expect(fetched.map(([, scheme]) => scheme)).toEqual([
      ...Array(3).fill('Bear'),
      ...Array(4).fill('Bear'),
      'Bear',
    ])
    expect(new Set(fetched.map(([url]) => url))).toEqual(new Set(['http://127.0.0.1:3215/v1/me']))
  })

  it('deletes a credential a stopped run left without all its calls, and makes its number again', async () => {
    fake.calls = []
    // number 2 was saved but made one of its three calls, number 3 none
    fake.tokens = [
      { id: 'short', name: 'Zed (scale 2)', profile_id: 'nora' },
      { id: 'bare', name: 'Sheets sync (scale 3)', profile_id: 'leo' },
    ]
    fake.usage = [
      { org_id: 'org', credential_id: 'mcp_tokens:short', calls: 1 },
      // another organization's calls of the same id count for nothing here
      { org_id: 'elsewhere', credential_id: 'mcp_tokens:bare', calls: 9 },
    ]
    const fetched = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        fetched.push(url)
        return { ok: true, status: 200, headers: new Headers() }
      }),
    )
    await runBoardScaleSeed(
      [...local, '--tasks', '0', '--credentials', '3', '--api-url', 'http://127.0.0.1:3215'],
      { env, log: () => {} },
    )
    vi.unstubAllGlobals()
    expect(fake.calls.map(([name, fields, as]) => [name, fields.id ?? fields.name, as])).toEqual([
      ['tokens:createMcpToken', fake.calls[0][1].id, 'leo-login'],
      ['tokens:deleteMcpToken', 'short', 'nora-login'],
      ['tokens:createMcpToken', fake.calls[2][1].id, 'nora-login'],
      ['tokens:deleteMcpToken', 'bare', 'leo-login'],
      ['tokens:createMcpToken', fake.calls[4][1].id, 'leo-login'],
    ])
    expect(
      fake.calls.filter(([name]) => name === 'tokens:createMcpToken').map(([, f]) => f.name),
    ).toEqual(['Raycast (scale 1)', 'Zed (scale 2)', 'Sheets sync (scale 3)'])
    // every new credential makes all its calls: 2, 3 and 4
    expect(fetched).toHaveLength(9)
    fake.tokens = []
    fake.usage = []
  })
})
