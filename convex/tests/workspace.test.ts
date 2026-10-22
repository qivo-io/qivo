/* The workspace parts (workspace.ts, lib/workspaceParts.ts): windows that
 * cut themselves before Convex's limits, what each part reveals,
 * and answers that stay the same while the data does, so Convex re-sends
 * only the parts a change reaches. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { halve, idWindows, inIdWindow, windowCount } from '../lib/idWindows'
import { PAGE } from '../lib/workspaceParts'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  patchCounters,
  plantIssue,
  plantMessage,
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

/* Convex's limits on what one transaction may read. */
const REAL_LIMITS = {
  transactionLimits: { bytesRead: 16 * 1024 * 1024, documentsRead: 32_000, databaseQueries: 4096 },
}

/* The largest description the server accepts, of 3-byte characters: about
 * 60 KB stored. */
const LARGEST = '€'.repeat(20_000)

/* Plants `n` active tasks with fields `extra`, in writes of 50. */
async function plantMany(
  t: T,
  n: number,
  extra: (i: number) => Partial<Doc<'issues'>> & { org_id: string; project_id: string },
) {
  const planted: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += 50)
    planted.push(
      ...(await t.run(async (ctx) => {
        const rows: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + 50); i++) {
          const _id = await ctx.db.insert('issues', {
            id: uuid(),
            num: 10_000 + i,
            title: `Task ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            ...extra(i),
          })
          rows.push((await ctx.db.get(_id))!)
        }
        return rows
      })),
    )
  return planted
}

/* The narrowest window of the grid that holds `id`, and its sibling. */
function narrowestOf(id: string) {
  let pair = halve(whole)
  for (;;) {
    const [holds, other] = inIdWindow(id, pair![0]) ? pair! : [pair![1], pair![0]]
    const next = halve(holds)
    if (next === null) return { holds, other }
    pair = next
  }
}

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
        id: `fff00000-0000-4000-8000-00000000000${i}`,
      })
    PAGE.tasks.most = 1
    // the narrowest window of the grid
    const last = narrowestOf('ffffffff').holds
    expect(last).toEqual({ from: 'fff00000', to: null })
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

describe('links of a restored task', () => {
  it('a marked link to a restored target goes out once, before its marks are cleared', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b, c] = await plantTasks(t, f, 3)
    const hiddenSource = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    // b was archived, its links marked, then restored before the clear ran
    const linkIds = await t.run(async (ctx) => {
      const link = (source_id: string, target_id: string) => ({
        org_id: f.org.id,
        id: uuid(),
        source_id,
        target_id,
        type: 'blocks' as const,
        pair_key: [source_id, target_id].sort().join(':'),
        created_at: NOW,
        task_archived: true as const,
      })
      await ctx.db.patch(b._id, { relations_marked: true })
      const ids = [link(a.id, b.id), link(b.id, c.id), link(hiddenSource.id, b.id)]
      for (const row of ids) await ctx.db.insert('issue_links', row)
      return ids.map((row) => row.id)
    })
    const linksOf = async (who: Doc<'profiles'>) =>
      (await workspaceOf(as(t, who)))?.links.map((l) => l.id).sort()
    expect(await linksOf(f.admin)).toEqual([...linkIds].sort())
    // the guest is not shown the hidden source, so its link stays out
    expect(await linksOf(f.guest)).toEqual(linkIds.slice(0, 2).sort())
    // a flagged source sends its marked link itself, so it still goes once
    await t.run((ctx) => ctx.db.patch(a._id, { relations_marked: true }))
    expect(await linksOf(f.admin)).toEqual([...linkIds].sort())
  })
})

describe('reads a window cannot bound by its rows', () => {
  it('answers overflow past its relation rows of one kind, flagged tasks included, and its cuts send them all', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantTasks(t, f, 8)
    PAGE.relations = 3
    expect(await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })).toEqual(
      { state: 'overflow' },
    )
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issueLabels).toHaveLength(8)
    // a flagged task reads its rows from its own indexes, bounded alike
    await t.run(async (ctx) => {
      await ctx.db.patch(tasks[0]._id, { relations_marked: true })
      for (let i = 0; i < 3; i++)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: tasks[0].id,
          label_id: `marked-${i}`,
          task_archived: true,
        })
    })
    const w = narrowestOf(tasks[0].id).holds
    expect(
      await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...w }),
    ).toMatchObject({
      state: 'refused',
    })
  })

  it('reads subtasks a few at a time without missing one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [p1, p2, p3] = await plantTasks(t, f, 3)
    const kid = (parent: Doc<'issues'>, project: Doc<'projects'>) =>
      plantIssue(t, { org_id: f.org.id, project_id: project.id, parent_id: parent.id })
    // the subtask the guest is not shown comes last of its parent's
    for (let i = 0; i < 4; i++) await kid(p1, f.sub)
    await kid(p1, f.hidden)
    await kid(p2, f.sub)
    await kid(p2, f.sub)
    await kid(p3, f.hidden)
    PAGE.kids = 2
    const snap = await workspaceOf(as(t, f.guest))
    const hiddenKids = (task: Doc<'issues'>) =>
      snap?.issues.find((i) => i.id === task.id)?.has_hidden_subtasks
    expect([p1, p2, p3].map(hiddenKids)).toEqual([true, false, true])
  })

  it('refuses with a sentence a window whose subtasks would pass the real limits', async () => {
    const t = newT(REAL_LIMITS)
    const f = await withOrg(t)
    // three parents in the narrowest window, with 100 subtasks each of
    // about 60 KB: about 18 MB of subtasks, which no cut can part
    const parents = await plantMany(t, 3, (i) => ({
      id: `a0000000-0000-4000-8000-00000000000${i}`,
      org_id: f.org.id,
      project_id: f.sub.id,
    }))
    await plantMany(t, 300, (i) => ({
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parents[i % 3].id,
      description: LARGEST,
    }))
    const w = narrowestOf(parents[0].id).holds
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...w })
    expect(answer).toMatchObject({ state: 'refused', message: expect.stringMatching(/^One part/) })
  }, 120_000)

  it('reads tasks shared with many teams within the real limits', async () => {
    const t = newT(REAL_LIMITS)
    const f = await withOrg(t)
    // 25 projects shared with the same 100 teams, the viewer in one
    const teams = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 100; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        ids.push(id)
      }
      await ctx.db.insert('team_members', {
        team_id: ids[99],
        profile_id: f.viewer.id,
        is_leader: false,
      })
      return ids
    })
    const shared: string[] = []
    for (let n = 0; n < 25; n++)
      shared.push(
        await t.run(async (ctx) => {
          const id = uuid()
          await ctx.db.insert('projects', {
            id,
            org_id: f.org.id,
            type: 'meta',
            key: `T${n}`,
            name: `Shared ${n}`,
            description: '',
            sort_order: 2000 + n,
            num: 2000 + n,
            track_delay: false,
            created_at: NOW,
          })
          for (const team_id of teams)
            await ctx.db.insert('project_team_access', { project_id: id, team_id, level: 'viewer' })
          return id
        }),
      )
    const task = await plantIssue(t, { org_id: f.org.id, project_id: shared[24] })
    const snap = await workspaceOf(as(t, f.viewer))
    const shown = new Set(snap?.projects.map((p) => p.id))
    expect(shared.filter((id) => shown.has(id))).toHaveLength(25)
    expect(snap?.issues.map((i) => i.id)).toContain(task.id)
  }, 120_000)

  it('cuts an inbox whose tasks would pass the real limits, and says so', async () => {
    const t = newT(REAL_LIMITS)
    const f = await withOrg(t)
    // 900 archived tasks of about 60 KB each, about 52 MiB, each named by
    // an unread message, older than one about a task the person is shown
    const archived = await plantMany(t, 900, () => ({
      org_id: f.org.id,
      project_id: f.sub.id,
      description: LARGEST,
      archived_at: NOW,
    }))
    for (let from = 0; from < archived.length; from += 300)
      await t.run(async (ctx) => {
        for (const task of archived.slice(from, from + 300))
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: f.org.id,
            recipient_id: f.admin.id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: 'planted',
            created_at: NOW,
          })
      })
    const [shown] = await plantTasks(t, f, 1)
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: shown.id })
    const answer = await as(t, f.admin).query(api.workspace.inbox, { org_id: f.org.id })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.unread.map((m) => m.issue_id)).toEqual([shown.id])
    expect(answer).toMatchObject({ truncated: true, unreadTruncated: true })
  }, 120_000)
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
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
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
    const { holds, other } = narrowestOf(own.id)
    expect(await rowsOf(f.guest, holds)).toHaveLength(1)
    expect(await rowsOf(f.guest, other)).toEqual([])
    expect(await rowsOf(f.viewer)).toEqual([])
    // A window narrower than the grid's, or off it, is refused, so the
    // window of a row tells at most the first three hex digits of its id.
    for (const w of [
      { from: own.id.slice(0, 8), to: null },
      { from: own.id, to: `${own.id}0` },
      { from: '00000000', to: null },
      { from: '20000000', to: '60000000' },
    ])
      await expectRefusal(
        as(t, f.guest).query(api.workspace.tasks, { org_id: f.org.id, ...w }),
        'bad_request',
      )
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
