/* The workspace parts (workspace.ts, lib/workspaceParts.ts): windows that
 * cut themselves before Convex's limits, what each part reveals,
 * and answers that stay the same while the data does, so Convex re-sends
 * only the parts a change reaches. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { halve, idWindows, windowCount } from '../lib/idWindows'
import { PAGE } from '../lib/workspaceParts'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  patchCounters,
  plantIssue,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'

const DEFAULT_PAGE = structuredClone(PAGE)
afterEach(() => {
  Object.assign(PAGE, structuredClone(DEFAULT_PAGE))
  vi.restoreAllMocks()
})

/* `n` tasks in the sub-project the fixture's guest can see, each with a
 * label, oldest first. */
async function plantTasks(t: T, f: OrgFixture, n: number, extra: Partial<Doc<'issues'>> = {}) {
  const tasks: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
    await t.run((ctx) =>
      ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id: task.id, label_id: 'label' }),
    )
    tasks.push(task)
  }
  return tasks
}

const whole = { from: '', to: null }

describe('a tasks window', () => {
  it('answers split past its rows and keeps answering, so the app cuts it while it shows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f, 5)
    PAGE.tasks.split = 4
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.issues).toHaveLength(5)
    expect(answer.split).toBe(true)
    // the halves hold every task once
    const ids = []
    for (const w of halve(whole) ?? []) {
      const half = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...w })
      if (half.state !== 'ok') throw new Error(half.state)
      ids.push(...half.issues.map((i) => i.id))
    }
    expect(ids.sort()).toEqual(tasks.map((task) => task.id).sort())
  })

  it('stops before it reads too much and answers overflow, which the app cuts until every task loads', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f, 9)
    PAGE.tasks.most = 4
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })
    expect(answer).toEqual({ state: 'overflow' })
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issues.map((i) => i.id).sort()).toEqual(tasks.map((task) => task.id).sort())
    expect(snap?.issueLabels).toHaveLength(9)
  })

  it('refuses with a sentence a window it cannot cut further', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        id: `ffffffff-0000-4000-8000-00000000000${i}`,
      })
    PAGE.tasks.most = 1
    const last = { from: 'ffffffff', to: null }
    expect(halve(last)).toBeNull()
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...last })
    expect(answer).toMatchObject({ state: 'refused', message: expect.stringMatching(/^One part/) })
  })

  it('stops between batches once its reads pass the hard budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f, 6)
    PAGE.batch = 2
    PAGE.hard.ranges = 1
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })
    expect(answer).toEqual({ state: 'overflow' })
  })

  it('reads within the real limits where one read of the organization could not', async () => {
    // 1,500 tasks with 12,000 characters of description each hold about 17
    // MiB, past what one transaction may read.
    const t = newT({
      transactionLimits: {
        bytesRead: 16 * 1024 * 1024,
        documentsRead: 32_000,
        databaseQueries: 4096,
      },
    })
    const f = await withOrg(t)
    const description = 'x'.repeat(12_000)
    // in three writes, each inside the limit on what one may write
    for (let batch = 0; batch < 3; batch++)
      await t.run(async (ctx) => {
        for (let i = batch * 500; i < (batch + 1) * 500; i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: i + 1,
            title: `Task ${i}`,
            description,
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
      })
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issues).toHaveLength(1500)
  })
})

describe('windows', () => {
  it('cover every id once, halve to their middle, and start as many as the counters ask', () => {
    const four = idWindows(4)
    expect(four).toEqual([
      { from: '', to: '40000000' },
      { from: '40000000', to: '80000000' },
      { from: '80000000', to: 'c0000000' },
      { from: 'c0000000', to: null },
    ])
    expect(halve(four[1])).toEqual([
      { from: '40000000', to: '60000000' },
      { from: '60000000', to: '80000000' },
    ])
    expect(windowCount(0, 100)).toBe(1)
    expect(windowCount(250, 100)).toBe(4)
    expect(windowCount(10_000_000, 100)).toBe(1024)
  })

  it('send the same workspace in many windows as in one, people cut as they overflow', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f, 12)
    const one = await workspaceOf(as(t, f.admin))
    // counters that ask for 16 task windows and 4 project windows
    await t.run((ctx) =>
      patchCounters(ctx, f.org.id, { next_issue_num: 1600, next_project_num: 1000 }),
    )
    PAGE.people.most = 2
    const many = await workspaceOf(as(t, f.admin))
    const sorted = (snap: typeof one) =>
      snap && {
        ...snap,
        orgs: [],
        issues: [...snap.issues].sort((a, b) => (a.id < b.id ? -1 : 1)),
        issueLabels: [...snap.issueLabels].sort((a, b) => (a.issue_id < b.issue_id ? -1 : 1)),
        profiles: [...snap.profiles].sort((a, b) => (a.id < b.id ? -1 : 1)),
        teamMembers: [...snap.teamMembers].sort((a, b) =>
          a.profile_id + a.team_id < b.profile_id + b.team_id ? -1 : 1,
        ),
        projects: [...snap.projects].sort((a, b) => (a.id < b.id ? -1 : 1)),
        access: [...snap.access].sort((a, b) =>
          a.project_id + a.profile_id < b.project_id + b.profile_id ? -1 : 1,
        ),
        teamAccess: [...snap.teamAccess].sort((a, b) =>
          a.project_id + a.team_id < b.project_id + b.team_id ? -1 : 1,
        ),
      }
    expect(sorted(many)).toEqual(sorted(one))
  })
})

describe('what a part reveals', () => {
  it('a guest reads only the tasks they are shown, and no hidden id leaves', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shown = await plantTasks(t, f, 3)
    const hidden: Doc<'issues'>[] = []
    for (let i = 0; i < 40; i++)
      hidden.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.hidden.id,
          // every one a subtask of the first shown task
          parent_id: shown[0].id,
          assignee_id: f.user.id,
          start_week: '2026-01-05',
          end_week: '2026-01-05',
          remaining_hours: 2,
        }),
      )
    const read = await as(t, f.guest).query(async (ctx) => {
      const { readTasks } = await import('../lib/workspaceParts')
      const me = (await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', f.guest.id))
        .unique())!
      const answer = await readTasks(ctx, me, whole)
      return { answer, documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used }
    })
    if (read.answer.state !== 'ok') throw new Error(read.answer.state)
    // in id order, the window's order
    expect(read.answer.issues.map((i) => i.id)).toEqual(shown.map((task) => task.id).sort())
    // a group whose subtasks the guest is not shown says only that
    const group = read.answer.issues.find((i) => i.id === shown[0].id)
    expect(group?.has_hidden_subtasks).toBe(true)
    expect(read.answer.issues.filter((i) => i.has_hidden_subtasks)).toHaveLength(1)
    // A window reads every active task of its ids, hidden ones too, and
    // the rows of those it shows: its cost follows its size, not the
    // organization's.
    expect(read.documents).toBeLessThan(120)
    const text = JSON.stringify(await workspaceOf(as(t, f.guest)))
    for (const task of hidden) expect(text).not.toContain(task.id)
    expect(text).not.toContain(f.hidden.id)
  })

  it('hidden load: staff get anonymized rows, anyone else only their own, from the window of the task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plan = { start_week: '2026-01-05', end_week: '2026-01-05', remaining_hours: 3 }
    const own = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      assignee_id: f.guest.id,
      ...plan,
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      assignee_id: f.user.id,
      ...plan,
    })
    const rowsOf = async (who: Doc<'profiles'>, w: { from: string; to: string | null } = whole) => {
      const answer = await as(t, who).query(api.workspace.tasks, { org_id: f.org.id, ...w })
      if (answer.state !== 'ok') throw new Error(answer.state)
      return answer.orgLoad
    }
    expect(await rowsOf(f.guest)).toEqual([
      expect.objectContaining({ issue_id: null, owner_id: f.guest.id, remaining: 3 }),
    ])
    expect(JSON.stringify(await rowsOf(f.guest))).not.toContain(own.id)
    // a window that does not hold the task gives them nothing
    expect(await rowsOf(f.guest, { from: `${own.id}0`, to: null })).toEqual([])
    expect(await rowsOf(f.viewer)).toEqual([])
  })

  it('answers gone without a seat, and refuses without a sign-in', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(
      await as(t, f.admin).query(api.workspace.tasks, { org_id: f.otherOrg.id, ...whole }),
    ).toEqual({ state: 'gone' })
    expect(await as(t, f.admin).query(api.workspace.inbox, { org_id: 'no-such-org' })).toEqual({
      state: 'gone',
    })
    await expectRefusal(t.query(api.workspace.people, { org_id: f.org.id, ...whole }), 'forbidden')
  })
})

describe('answers Convex need not re-send', () => {
  it('are the same on every run of the same data, and log nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f, 3)
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const first = await workspaceOf(as(t, f.user))
    expect(await workspaceOf(as(t, f.user))).toEqual(first)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a rename elsewhere changes only the window that holds the task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f, 12)
    const windows = idWindows(4)
    const read = () =>
      Promise.all(
        windows.map((w) =>
          as(t, f.admin)
            .query(api.workspace.tasks, { org_id: f.org.id, ...w })
            .then((answer) => JSON.stringify(answer)),
        ),
      )
    const before = await read()
    await t.run(async (ctx) => {
      await ctx.db.patch(tasks[3]._id, { title: 'Renamed elsewhere' })
    })
    const after = await read()
    expect(after.map((answer, i) => answer !== before[i])).toEqual(
      windows.map((w) => tasks[3].id >= w.from && (w.to === null || tasks[3].id < w.to)),
    )
  })
})

describe('many projects', () => {
  it('a part reads only the projects its rows name, and a parent of 3,000 sub-projects shows for navigation within the real limits', async () => {
    const t = newT({
      transactionLimits: {
        bytesRead: 16 * 1024 * 1024,
        documentsRead: 32_000,
        databaseQueries: 4096,
      },
    })
    const f = await withOrg(t)
    // a parent the viewer reaches only through one of its 3,000 sub-projects
    const parent = uuid()
    const subs = await t.run(async (ctx) => {
      const row = (n: number, parent_id?: string) => ({
        id: n === 0 ? parent : uuid(),
        org_id: f.org.id,
        type: parent_id === undefined ? ('meta' as const) : ('project' as const),
        parent_id,
        key: `M${n}`,
        name: `Many ${n}`,
        description: '',
        sort_order: 1000 + n,
        num: 1000 + n,
        track_delay: false,
        created_at: NOW,
      })
      await ctx.db.insert('projects', row(0))
      const ids: string[] = []
      for (let n = 1; n <= 3000; n++)
        ids.push((await ctx.db.get(await ctx.db.insert('projects', row(n, parent))))!.id)
      await ctx.db.insert('project_access', {
        project_id: ids[2999],
        profile_id: f.viewer.id,
        level: 'viewer',
      })
      await patchCounters(ctx, f.org.id, { next_project_num: 4001 })
      return ids
    })
    const task = await plantIssue(t, { org_id: f.org.id, project_id: subs[2999] })
    const snap = await workspaceOf(as(t, f.viewer))
    const shown = new Set(snap?.projects.map((p) => p.id))
    expect(shown.has(parent)).toBe(true)
    expect(shown.has(subs[2999])).toBe(true)
    expect(subs.filter((id) => shown.has(id))).toHaveLength(1)
    expect(snap?.issues.map((i) => i.id)).toContain(task.id)
    // the task's window reads its task and project, not the organization's
    const read = await t.run(async (ctx) => {
      const { readTasks } = await import('../lib/workspaceParts')
      const w = idWindows(16).find((w) => task.id >= w.from && (w.to === null || task.id < w.to))!
      await readTasks(ctx, f.viewer, w)
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used
    })
    expect(read).toBeLessThan(30)
  }, 120_000)
})

describe('the people part', () => {
  it("sends each person's memberships with them, and the app keeps those of teams it holds", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      // a membership of a team that no longer exists
      await ctx.db.insert('team_members', {
        team_id: 'gone-team',
        profile_id: f.viewer.id,
        is_leader: false,
      })
    })
    const snap = await workspaceOf(as(t, f.admin))
    const mine = snap?.teamMembers.filter((m) => m.profile_id === f.user.id)
    expect(mine?.length).toBeGreaterThan(0)
    expect(snap?.teamMembers.some((m) => m.team_id === 'gone-team')).toBe(false)
    const answer = await as(t, f.admin).query(api.workspace.people, { org_id: f.org.id, ...whole })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.teamMembers.some((m) => m.team_id === 'gone-team')).toBe(true)
  })
})
