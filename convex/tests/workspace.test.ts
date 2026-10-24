/* The workspace parts (workspace.ts, lib/workspaceParts.ts): windows that
 * cut themselves before Convex's limits, what each part reveals,
 * and answers that stay the same while the data does, so Convex re-sends
 * only the parts a change reaches. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS, projectLevel } from '../lib/access'
import { newWindowKey } from '../lib/db'
import {
  cut,
  cutPieces,
  halve,
  idWindows,
  inIdWindow,
  isIdWindow,
  MOST_PIECES,
  piecesAfter,
  startWindows,
  windowCount,
} from '../lib/idWindows'
import { PAGE, readProjects, readTasks } from '../lib/workspaceParts'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  patchCounters,
  plantIssue,
  plantMessage,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'

const DEFAULT_PAGE = structuredClone(PAGE)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(PAGE, structuredClone(DEFAULT_PAGE))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  vi.restoreAllMocks()
})

/* `n` tasks in the sub-project the fixture's guest can see, each with a
 * label, oldest first. */
async function plantTasks(t: T, f: OrgFixture, n: number, extra: Partial<Doc<'issues'>> = {}) {
  const tasks: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
    await t.run((ctx) =>
      ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: task.id,
        label_id: 'label',
        task_key: task.window_key,
      }),
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
            window_key: newWindowKey(),
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

/* The narrowest window of the grid that holds window key `key`, and its
 * sibling. */
function narrowestOf(key: string) {
  let pair = halve(whole)
  for (;;) {
    const [holds, other] = inIdWindow(key, pair![0]) ? pair! : [pair![1], pair![0]]
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
    expect(answer).toMatchObject({ state: 'overflow' })
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issues.map((i) => i.id).sort()).toEqual(tasks.map((task) => task.id).sort())
    expect(snap?.issueLabels).toHaveLength(9)
  })

  it('refuses with a sentence a window it cannot cut further', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, window_key: 'fff00000' })
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
            window_key: newWindowKey(),
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
  it('a marked link goes out once, with its source, before its marks are cleared', async () => {
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
  it('asks to be cut past half its relation rows of one kind, while it still shows them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f, 3)
    PAGE.relations = 4
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })
    expect(answer).toMatchObject({ state: 'ok', split: true })
    if (answer.state === 'ok') expect(answer.issueLabels).toHaveLength(3)
  })

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
          task_key: tasks[0].window_key,
        })
    })
    const w = narrowestOf(tasks[0].window_key!).holds
    expect(
      await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...w }),
    ).toMatchObject({ state: 'refused' })
  })

  it('reads subtasks a few at a time without missing one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [p1, p2, p3, leaf] = await plantTasks(t, f, 4)
    const kid = (parent: Doc<'issues'>, project: Doc<'projects'>) =>
      plantIssue(t, { org_id: f.org.id, project_id: project.id, parent_id: parent.id })
    // the subtask the guest is not shown comes last of its parent's
    for (let i = 0; i < 4; i++) await kid(p1, f.sub)
    await kid(p1, f.hidden)
    await kid(p2, f.sub)
    await kid(p2, f.sub)
    await kid(p3, f.hidden)
    for (const kids of [1, 2]) {
      PAGE.kids = kids
      const snap = await workspaceOf(as(t, f.guest))
      const hiddenKids = (task: Doc<'issues'>) =>
        snap?.issues.find((i) => i.id === task.id)?.has_hidden_subtasks
      expect([p1, p2, p3].map(hiddenKids)).toEqual([true, false, true])
      // every parent says it is one, whichever window its subtasks are in
      const parent = (task: Doc<'issues'>) =>
        snap?.issues.find((i) => i.id === task.id)?.has_subtasks
      expect([p1, p2, p3, leaf].map(parent)).toEqual([true, true, true, false])
    }
  })

  it('refuses with a sentence a window whose subtasks would pass the real limits', async () => {
    const t = newT(REAL_LIMITS)
    const f = await withOrg(t)
    // three parents in the narrowest window, with 100 subtasks each of
    // about 60 KB: about 18 MB of subtasks, which no cut can part
    const parents = await plantMany(t, 3, () => ({
      window_key: 'a0000000',
      org_id: f.org.id,
      project_id: f.sub.id,
    }))
    await plantMany(t, 300, (i) => ({
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parents[i % 3].id,
      description: LARGEST,
    }))
    const w = narrowestOf('a0000000').holds
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
  it('cover every id once, halve to their middle, and start as many as the counts ask', () => {
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
    // by the rows the windows read once the server counted them, else by
    // the numbers handed out
    const aged = { next_issue_num: 6500, next_project_num: 4001 }
    expect(startWindows(aged)).toEqual({ tasks: 64, projects: 32 })
    expect(startWindows({ ...aged, active_tasks: 300, live_projects: 10 })).toEqual({
      tasks: 2,
      projects: 1,
    })
  })

  it('cut into as many pieces of the grid as asked, and halve when asked for no valid count', () => {
    const left = idWindows(2)[0]
    const pieces = cut(left, 4)
    expect(pieces).toEqual([
      { from: '', to: '20000000' },
      { from: '20000000', to: '40000000' },
      { from: '40000000', to: '60000000' },
      { from: '60000000', to: '80000000' },
    ])
    expect(cut(idWindows(1)[0], 2)).toEqual(idWindows(2))
    // never narrower than the grid allows
    const narrow = cut({ from: 'ffc00000', to: null }, MOST_PIECES)
    expect(narrow).toHaveLength(4)
    expect(narrow?.every(isIdWindow)).toBe(true)
    expect(narrow?.at(-1)).toEqual({ from: 'fff00000', to: null })
    expect(cut({ from: 'fff00000', to: null }, 2)).toBeNull()
    // an overflow names its pieces, a split asks for halves, an ok answer for none
    expect(piecesAfter(left, { state: 'overflow', pieces: 4 })).toEqual(pieces)
    expect(piecesAfter(left, { state: 'overflow' })).toEqual(halve(left))
    for (const pieces of [3, 0, 1, MOST_PIECES * 2, Number.NaN])
      expect(piecesAfter(left, { state: 'overflow', pieces })).toEqual(halve(left))
    expect(piecesAfter(left, { state: 'ok', split: true, pieces: 8 })).toEqual(halve(left))
    expect(piecesAfter(left, { state: 'ok' })).toBeNull()
    expect(piecesAfter(left, { state: 'refused' })).toBeNull()
  })

  it('ask for enough pieces that each holds about half of what a read took', () => {
    const whole = idWindows(1)[0]
    // a read that took its rows from the first quarter: eight pieces
    expect(cutPieces(whole, '3fffffff-aaaa')).toBe(8)
    expect(cutPieces(whole, '7fffffff')).toBe(4)
    expect(cutPieces(whole, 'ffffffff')).toBe(2)
    // rows crowded at the start ask for the most
    expect(cutPieces(whole, '00000001')).toBe(MOST_PIECES)
    // a window that starts further in counts from its start
    expect(cutPieces({ from: '80000000', to: null }, 'a0000000')).toBe(8)
    // no hex point, or one before the window: halves
    for (const last of [undefined, '', 'person-1', '10000000'])
      expect(cutPieces({ from: '80000000', to: null }, last)).toBe(2)
  })

  it('send the same workspace in many windows as in one, relation rows across windows included, people cut as they overflow', async () => {
    const t = newT()
    const f = await withOrg(t)
    // tasks in four windows of four, by their window keys
    const at = (key: string, extra: Partial<Doc<'issues'>> = {}) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, window_key: key, ...extra })
    const a = await at('10000000')
    const b = await at('50000000')
    const c = await at('90000000', { relations_marked: true })
    const d = await at('d0000000')
    // subtasks in other windows than their parents, one the guest is not shown
    await at('e0000000', { parent_id: a.id })
    await at('20000000', { parent_id: a.id, project_id: f.hidden.id })
    // hidden load of the guest's own, in yet another window
    await at('60000000', {
      project_id: f.hidden.id,
      assignee_id: f.guest.id,
      start_week: '2026-01-05',
      end_week: '2026-01-05',
      remaining_hours: 2,
    })
    await t.run(async (ctx) => {
      const link = (source: Doc<'issues'>, target: Doc<'issues'>, marked?: true) =>
        ctx.db.insert('issue_links', {
          org_id: f.org.id,
          id: uuid(),
          source_id: source.id,
          target_id: target.id,
          type: 'blocks',
          pair_key: [source.id, target.id].sort().join(':'),
          created_at: NOW,
          task_archived: marked,
          task_key: source.window_key,
        })
      await link(a, d)
      await link(d, b)
      // marked links of restored c, one from each side
      await link(b, c, true)
      await link(c, a, true)
      for (const task of [a, c])
        await ctx.db.insert('issue_attachments', {
          org_id: f.org.id,
          id: uuid(),
          issue_id: task.id,
          name: 'evidence.txt',
          size_bytes: 1,
          storage_id: await ctx.storage.store(new Blob([]) as never),
          inline: false,
          created_at: NOW,
          task_archived: task === c ? true : undefined,
          task_key: task.window_key,
        })
      for (const task of [b, c])
        await ctx.db.insert('issue_subscriptions', {
          issue_id: task.id,
          profile_id: f.guest.id,
          created_at: NOW,
          task_archived: task === c ? true : undefined,
          task_key: task.window_key,
        })
    })
    await plantTasks(t, f, 4)
    const one = await workspaceOf(as(t, f.guest))
    // counters that ask for 16 task windows and 4 project windows
    await t.run((ctx) =>
      patchCounters(ctx, f.org.id, { next_issue_num: 1600, next_project_num: 1000 }),
    )
    PAGE.people.most = 2
    const many = await workspaceOf(as(t, f.guest))
    const by =
      <R>(key: (row: R) => string) =>
      (rows: readonly R[]) =>
        [...rows].sort((x, y) => (key(x) < key(y) ? -1 : 1))
    const sorted = (snap: typeof one) =>
      snap && {
        ...snap,
        orgs: [],
        issues: by<(typeof snap.issues)[number]>((r) => r.id)(snap.issues),
        issueLabels: by<(typeof snap.issueLabels)[number]>((r) => r.issue_id)(snap.issueLabels),
        links: by<(typeof snap.links)[number]>((r) => r.id)(snap.links),
        attachments: by<(typeof snap.attachments)[number]>((r) => r.id)(snap.attachments),
        issueSubs: by<(typeof snap.issueSubs)[number]>((r) => r.issue_id)(snap.issueSubs),
        orgLoad: by<(typeof snap.orgLoad)[number]>((r) => JSON.stringify(r))(snap.orgLoad),
        profiles: by<(typeof snap.profiles)[number]>((r) => r.id)(snap.profiles),
        teamMembers: by<(typeof snap.teamMembers)[number]>((r) => r.profile_id + r.team_id)(
          snap.teamMembers,
        ),
        projects: by<(typeof snap.projects)[number]>((r) => r.id)(snap.projects),
        access: by<(typeof snap.access)[number]>((r) => r.project_id + r.profile_id)(snap.access),
        teamAccess: by<(typeof snap.teamAccess)[number]>((r) => r.project_id + r.team_id)(
          snap.teamAccess,
        ),
      }
    expect(sorted(many)).toEqual(sorted(one))
    // every link goes out once, marked ones included
    expect(many?.links.map((l) => `${l.source_id}>${l.target_id}`).sort()).toEqual(
      [`${a.id}>${d.id}`, `${d.id}>${b.id}`, `${b.id}>${c.id}`, `${c.id}>${a.id}`].sort(),
    )
    expect(many?.attachments).toHaveLength(2)
    expect(many?.issueSubs).toHaveLength(2)
    expect(many?.orgLoad).toEqual([expect.objectContaining({ owner_id: f.guest.id })])
    const shown = (task: Doc<'issues'>) => many?.issues.find((i) => i.id === task.id)
    expect(shown(a)?.has_hidden_subtasks).toBe(true)
    expect(many?.issues.filter((i) => i.parent_id === a.id)).toHaveLength(1)
  })
})

describe('window keys', () => {
  it("the server picks a new task's key, so a writer who crowds ids into one window does not crowd the windows", async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = [0, 1, 2].map((i) => `abc00000-0000-4000-8000-00000000000${i}`)
    for (const id of ids)
      await as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Crowded',
      })
    const keys = await t.run(async (ctx) =>
      Promise.all(
        ids.map(
          async (id) =>
            (await ctx.db
              .query('issues')
              .withIndex('by_uuid', (q) => q.eq('id', id))
              .unique())!.window_key,
        ),
      ),
    )
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}$/)
    expect(new Set(keys).size).toBe(3)
  })

  it("every writer of a relation row gives it its task's key", async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = [uuid(), uuid()]
    const admin = as(t, f.admin)
    for (const id of [a, b])
      await admin.mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Keyed',
      })
    const label = uuid()
    await admin.mutation(api.labels.create, {
      org_id: f.org.id,
      id: label,
      name: 'Keyed',
      color: '#335577',
    })
    await admin.mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: a,
      label_id: label,
      on: true,
    })
    await admin.mutation(api.issues.addLink, {
      org_id: f.org.id,
      id: uuid(),
      source_id: b,
      target_id: a,
      type: 'blocks',
    })
    await as(t, f.user).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: a })
    const keyed = await t.run(async (ctx) => {
      const keyOf = async (id: string) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique())!.window_key
      return {
        a: await keyOf(a),
        b: await keyOf(b),
        labels: (
          await ctx.db
            .query('issue_labels')
            .withIndex('by_issue', (q) => q.eq('issue_id', a))
            .collect()
        ).map((r) => r.task_key),
        links: (
          await ctx.db
            .query('issue_links')
            .withIndex('by_source', (q) => q.eq('source_id', b))
            .collect()
        ).map((r) => r.task_key),
        follows: (
          await ctx.db
            .query('issue_subscriptions')
            .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', a))
            .collect()
        ).map((r) => r.task_key),
      }
    })
    expect(keyed.a).toMatch(/^[0-9a-f]{8}$/)
    expect(keyed.labels).toEqual([keyed.a])
    expect(keyed.links).toEqual([keyed.b])
    expect(keyed.follows.length).toBeGreaterThan(0)
    for (const key of keyed.follows) expect(key).toBe(keyed.a)
  })

  it('windows hold tasks by key, not id: ids in one narrowest window load apart, keys in one refuse', async () => {
    const t = newT()
    const f = await withOrg(t)
    const crowded = (i: number) => `fff00000-0000-4000-8000-00000000000${i}`
    const keys = ['10000000', '50000000', 'd0000000']
    for (const [i, key] of keys.entries())
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        id: crowded(i),
        window_key: key,
      })
    PAGE.tasks.most = 1
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issues.map((i) => i.id).sort()).toEqual([0, 1, 2].map(crowded))
    // the narrowest window of the crowded ids holds none of them
    const ofIds = narrowestOf('fff00000').holds
    const answer = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...ofIds })
    expect(answer).toMatchObject({ state: 'ok', issues: [] })
  })

  it('a task stored before window keys loads in the first window with its rows, until the backfill gives them one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      window_key: undefined,
    })
    // its label, and a follow written with a key that is not its task's
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id: old.id, label_id: 'old' })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: old.id,
        profile_id: f.admin.id,
        created_at: NOW,
        task_key: 'ffffffff',
      })
    })
    const oldProject = await plantProject(t, { org_id: f.org.id, window_key: undefined })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, window_key: 'c0000000' })
    const windows = idWindows(4)
    const holding = async () => {
      const answers = await Promise.all(
        windows.map((w) => as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...w })),
      )
      return answers.map((answer) =>
        answer.state === 'ok'
          ? answer.issues.some((i) => i.id === old.id) &&
            answer.issueLabels.some((l) => l.issue_id === old.id)
          : null,
      )
    }
    expect(await holding()).toEqual([true, false, false, false])
    const { BACKFILL_PAGE } = await import('../internal/windowKeysBackfill')
    BACKFILL_PAGE.rows = { issues: 1, projects: 1 }
    try {
      const remaining = async (table: 'issues' | 'projects') => {
        let rows = 0
        let cursor: string | null = null
        for (;;) {
          const page: { rows: number; cursor: string; done: boolean } = await t.query(
            internal.internal.windowKeysBackfill.remaining,
            { table, cursor },
          )
          rows += page.rows
          if (page.done) return rows
          cursor = page.cursor
        }
      }
      // withOrg's own rows have no key either
      const before = { issues: await remaining('issues'), projects: await remaining('projects') }
      expect(before.issues).toBeGreaterThanOrEqual(1)
      expect(before.projects).toBeGreaterThanOrEqual(1)
      expect(await t.action(internal.internal.windowKeysBackfill.run, { dry_run: true })).toEqual({
        dry_run: true,
        ...before,
      })
      expect(await remaining('issues')).toBe(before.issues)
      expect(await t.action(internal.internal.windowKeysBackfill.run, { dry_run: false })).toEqual({
        dry_run: false,
        ...before,
      })
      expect([await remaining('issues'), await remaining('projects')]).toEqual([0, 0])
      const keyOf = await t.run(async (ctx) => ({
        task: (await ctx.db.get(old._id))?.window_key,
        rows: [
          ...(await ctx.db
            .query('issue_labels')
            .withIndex('by_issue', (q) => q.eq('issue_id', old.id))
            .collect()),
          ...(await ctx.db
            .query('issue_subscriptions')
            .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', old.id))
            .collect()),
        ].map((row) => row.task_key),
        project: (await ctx.db.get(oldProject._id))?.window_key,
        audit: await ctx.db
          .query('platform_audit_log')
          .filter((q) => q.eq(q.field('action'), 'window_keys_backfill'))
          .collect(),
      }))
      expect(keyOf.task).toMatch(/^[0-9a-f]{8}$/)
      expect(keyOf.rows).toEqual([keyOf.task, keyOf.task])
      expect(keyOf.project).toMatch(/^[0-9a-f]{8}$/)
      expect(keyOf.audit.map((row) => row.detail)).toEqual([before])
      expect(await holding()).toEqual(windows.map((w) => inIdWindow(keyOf.task!, w)))
    } finally {
      BACKFILL_PAGE.rows = { issues: 25, projects: 500 }
    }
  })

  it("no part sends a window key, an archive mark, a mark flag or a relation row's organization", async () => {
    const t = newT()
    const f = await withOrg(t)
    const [task] = await plantTasks(t, f, 1)
    await t.run(async (ctx) => {
      await ctx.db.patch(task._id, { relations_marked: true })
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: task.id,
        label_id: 'marked',
        task_archived: true,
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: f.admin.id,
        created_at: NOW,
        task_archived: true,
      })
    })
    const snap = await workspaceOf(as(t, f.admin))
    expect(snap?.issueLabels).toHaveLength(2)
    expect(snap?.issueSubs).toHaveLength(1)
    for (const row of [...(snap?.issueLabels ?? []), ...(snap?.issueSubs ?? [])]) {
      expect(row).not.toHaveProperty('task_archived')
      expect(row).not.toHaveProperty('org_id')
    }
    for (const row of snap?.issues ?? []) {
      expect(row).not.toHaveProperty('relations_marked')
      expect(row).not.toHaveProperty('window_key')
    }
    expect(snap?.projects.length).toBeGreaterThan(0)
    for (const row of snap?.projects ?? []) expect(row).not.toHaveProperty('window_key')
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
    // in window key order, the window's order
    expect(read.answer.issues.map((i) => i.id)).toEqual(
      [...shown].sort((a, b) => (a.window_key! < b.window_key! ? -1 : 1)).map((task) => task.id),
    )
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
    const { holds, other } = narrowestOf(own.window_key!)
    expect(await rowsOf(f.guest, holds)).toHaveLength(1)
    expect(await rowsOf(f.guest, other)).toEqual([])
    expect(await rowsOf(f.viewer)).toEqual([])
    // A window narrower than the grid's, or off it, is refused, so the
    // window of a row tells at most the first three hex digits of its
    // window key, which the server picked at random and says nothing of
    // its id.
    for (const w of [
      { from: own.window_key!, to: null },
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
      windows.map((w) => inIdWindow(tasks[3].window_key!, w)),
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
        window_key: newWindowKey(),
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
      const w = idWindows(16).find((w) => inIdWindow(task.window_key!, w))!
      await readTasks(ctx, f.viewer, w)
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used
    })
    expect(read).toBeLessThan(30)
  }, 120_000)

  it('shows a task exactly where the person sees its project, for every kind of grant, however their own rows are read', async () => {
    const shownProjects = {
      admin: [
        'led',
        'grant',
        'viewerGrant',
        'share',
        'otherTeam',
        'foreignTeam',
        'none',
        'parentShared',
        'parentLed',
        'parentGrant',
      ],
      user: ['led', 'grant', 'viewerGrant', 'share', 'parentShared', 'parentLed', 'parentGrant'],
      // a viewer leads nothing
      viewer: ['grant', 'viewerGrant', 'share', 'parentShared', 'parentGrant'],
      // a guest gets nothing through teams
      guest: ['led', 'grant', 'viewerGrant', 'parentLed', 'parentGrant'],
    } as const
    for (const [role, expected] of Object.entries(shownProjects)) {
      const t = newT()
      const f = await withOrg(t)
      const me = await plantSeat(t, {
        org_id: f.org.id,
        org_role: role as keyof typeof shownProjects,
      })
      const { parent, kinds: byProject } = await t.run(async (ctx) => {
        const team = async (orgId: string) => {
          const id = uuid()
          await ctx.db.insert('teams', {
            id,
            org_id: orgId,
            name: 'Team',
            track_delay_default: false,
            created_at: NOW,
          })
          return id
        }
        const [mine, other, foreign] = [
          await team(f.org.id),
          await team(f.org.id),
          await team(f.otherOrg.id),
        ]
        for (const team_id of [mine, foreign])
          await ctx.db.insert('team_members', { team_id, profile_id: me.id, is_leader: false })
        const project = async (extra: Partial<Doc<'projects'>>) => {
          const id = uuid()
          await ctx.db.insert('projects', {
            id,
            org_id: f.org.id,
            type: 'project',
            key: id.slice(0, 5).toUpperCase(),
            name: 'Kind',
            description: '',
            sort_order: 1,
            num: 1,
            track_delay: false,
            created_at: NOW,
            window_key: newWindowKey(),
            ...extra,
          })
          return id
        }
        const grant = (project_id: string, level: 'user' | 'viewer') =>
          ctx.db.insert('project_access', { project_id, profile_id: me.id, level })
        const share = (project_id: string, team_id: string) =>
          ctx.db.insert('project_team_access', { project_id, team_id, level: 'user' })
        const parent = await project({ type: 'meta' })
        const sub = (extra: Partial<Doc<'projects'>> = {}) =>
          project({ parent_id: parent, ...extra })
        const ids = {
          led: await sub({ lead_id: me.id }),
          grant: await sub(),
          viewerGrant: await sub(),
          share: await sub(),
          otherTeam: await sub(),
          foreignTeam: await sub(),
          none: await sub(),
          archived: await sub({ archived_at: NOW }),
          deleted: await sub(),
          parentShared: await project({ parent_id: await project({ type: 'meta' }) }),
          parentLed: await project({ parent_id: await project({ type: 'meta', lead_id: me.id }) }),
          parentGrant: await project({ parent_id: await project({ type: 'meta' }) }),
        }
        await grant(ids.grant, 'user')
        await grant(ids.viewerGrant, 'viewer')
        await grant(ids.archived, 'user')
        await grant(ids.deleted, 'user')
        await share(ids.share, mine)
        await share(ids.otherTeam, other)
        await share(ids.foreignTeam, foreign)
        const parentOf = async (id: string) =>
          (await ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique())!.parent_id!
        await share(await parentOf(ids.parentShared), mine)
        await grant(await parentOf(ids.parentGrant), 'viewer')
        for (const [kind, project_id] of Object.entries(ids)) {
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id,
            num: 1,
            title: kind,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          })
        }
        // a deleted project leaves no row
        const gone = await ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', ids.deleted))
          .unique()
        await ctx.db.delete(gone!._id)
        return {
          parent,
          kinds: Object.fromEntries(Object.entries(ids).map(([kind, id]) => [id, kind])),
        }
      })
      for (const own of [
        DEFAULT_OWN_READS,
        // the person's five grants and two teams read at once
        { ...DEFAULT_OWN_READS, steps: [1, 8], manyTeams: 1 },
        {
          ...DEFAULT_OWN_READS,
          steps: [1],
          lookups: 0,
          rows: 0,
          manyTeams: 1,
          orgTeams: 0,
          bytes: 0,
        },
      ]) {
        Object.assign(OWN_READS, structuredClone(own))
        const shown = await t.run(async (ctx) => {
          const answer = await readTasks(ctx, me, whole)
          if (answer.state !== 'ok') throw new Error(answer.state)
          return answer.issues.map((task) => byProject[task.project_id]).sort()
        })
        expect(shown, `${role}, own reads ${JSON.stringify(own)}`).toEqual([...expected].sort())
        // the projects part, which asks about parents for navigation, shows
        // the projects the per-project walk shows
        const projects = await t.run(async (ctx) => {
          const answer = await readProjects(ctx, me, whole)
          if (answer.state !== 'ok') throw new Error(answer.state)
          const walk: string[] = []
          for (const p of await ctx.db.query('projects').collect())
            if (p.org_id === f.org.id && (await projectLevel(ctx, me, p)) !== null) walk.push(p.id)
          return { shown: answer.projects.map((p) => p.id).sort(), walk: walk.sort() }
        })
        expect(projects.shown, `${role}, own reads ${JSON.stringify(own)}`).toEqual(projects.walk)
        expect(projects.shown).toContain(parent)
      }
    }
  }, 60_000)

  it("a person's grants, memberships and team shares are read once a window, not once a project", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, org_role: 'user' })
    // one task in each of 60 sub-projects of 30 parents, five shared with a
    // team of the person's three, each parent granted to them
    await t.run(async (ctx) => {
      const teams: string[] = []
      for (let i = 0; i < 3; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id: id, profile_id: me.id, is_leader: false })
        teams.push(id)
      }
      const project = async (num: number, extra: Partial<Doc<'projects'>>) => {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          key: `R${num}`,
          name: `Spread ${num}`,
          description: '',
          sort_order: num,
          num,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
          ...extra,
        })
        return id
      }
      for (let n = 0; n < 30; n++) {
        const parent = await project(3000 + 3 * n, { type: 'meta' })
        await ctx.db.insert('project_access', {
          project_id: parent,
          profile_id: me.id,
          level: 'viewer',
        })
        for (const k of [1, 2]) {
          const sub = await project(3000 + 3 * n + k, { parent_id: parent })
          if (n % 6 === 0 && k === 1)
            await ctx.db.insert('project_team_access', {
              project_id: sub,
              team_id: teams[n % 3],
              level: 'user',
            })
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: sub,
            num: 3000 + 3 * n + k,
            title: `Spread ${n}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          })
        }
      }
    })
    /* the index ranges one whole window reads as `who`, and the tasks it shows */
    const reads = (who: Doc<'profiles'>) =>
      t.run(async (ctx) => {
        const answer = await readTasks(ctx, who, whole)
        if (answer.state !== 'ok') throw new Error(answer.state)
        return {
          ranges: (await ctx.meta.getTransactionMetrics()).databaseQueries.used,
          shown: answer.issues.length,
        }
      })
    const [member, admin] = [await reads(me), await reads(f.admin)]
    expect(member.shown).toBe(60)
    // an admin reads no access rows; the member asks about the first
    // projects one by one and then reads their own rows once, so they cost
    // less than half of the two ranges for each of the 90 projects
    expect(member.ranges - admin.ranges).toBeLessThan(90)
  })
})

describe('the projects and people parts', () => {
  it('a projects window answers overflow past its rows or its reads, its cuts send every project, and the narrowest one refuses', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 4; i++) await plantProject(t, { org_id: f.org.id })
    const ids = (snap: Awaited<ReturnType<typeof workspaceOf>>) =>
      snap?.projects.map((p) => p.id).sort()
    const one = await workspaceOf(as(t, f.admin))
    expect(one?.projects.length).toBeGreaterThan(4)
    const projectsOf = (w: { from: string; to: string | null }) =>
      as(t, f.admin).query(api.workspace.projects, { org_id: f.org.id, ...w })
    PAGE.projects.most = 2
    expect(await projectsOf(whole)).toEqual({ state: 'overflow', pieces: expect.any(Number) })
    expect(ids(await workspaceOf(as(t, f.admin)))).toEqual(ids(one))
    // past the hard budget between batches of grants
    Object.assign(PAGE, structuredClone(DEFAULT_PAGE))
    PAGE.batch = 1
    PAGE.hard.ranges = 5
    expect(await projectsOf(whole)).toEqual({ state: 'overflow' })
    // three projects in one narrowest window cannot be cut apart
    Object.assign(PAGE, structuredClone(DEFAULT_PAGE))
    for (let i = 0; i < 3; i++) await plantProject(t, { org_id: f.org.id, window_key: 'f0000000' })
    PAGE.projects.most = 2
    expect(await projectsOf(narrowestOf('f0000000').holds)).toMatchObject({
      state: 'refused',
      message: expect.stringMatching(/^One part/),
    })
  })

  it('a projects window does not ask to be cut for reads every part of the caller repeats', async () => {
    const t = newT()
    const f = await withOrg(t)
    // every other project far from the window under test
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query('projects').collect())
        await ctx.db.patch(p._id, { window_key: '10000000' })
    })
    const parent = await plantProject(t, { org_id: f.org.id, window_key: 'f0000000' })
    const child = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: parent.id,
      window_key: '10000000',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: child.id,
        profile_id: f.viewer.id,
        level: 'viewer',
      })
      // 60 more teams of the person, whose shares navigation reads
      for (let i = 0; i < 60; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: id,
          profile_id: f.viewer.id,
          is_leader: false,
        })
      }
    })
    PAGE.soft.ranges = 40
    // the organization's teams read at once, and each team by its own read
    for (const manyTeams of [DEFAULT_OWN_READS.manyTeams, Number.POSITIVE_INFINITY]) {
      OWN_READS.manyTeams = manyTeams
      const answer = await as(t, f.viewer).query(api.workspace.projects, {
        org_id: f.org.id,
        ...idWindows(16)[15],
      })
      // shown for navigation, and not cut although navigation read past it
      expect(answer, `manyTeams ${manyTeams}`).toMatchObject({
        state: 'ok',
        projects: [expect.objectContaining({ id: parent.id })],
      })
      expect(answer, `manyTeams ${manyTeams}`).not.toHaveProperty('split')
    }
  })

  it('a people window too full to cut refuses with a sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const crowded = [0, 1, 2].map((i) => `fff00000-0000-4000-8000-00000000000${i}`)
    const { _id, _creationTime, ...viewer } = f.viewer
    await t.run(async (ctx) => {
      for (const id of crowded)
        await ctx.db.insert('profiles', {
          ...viewer,
          id,
          email: `${id}@testbed.test`,
          auth_user_id: undefined,
        })
    })
    PAGE.people.most = 2
    expect(
      await as(t, f.admin).query(api.workspace.people, {
        org_id: f.org.id,
        ...narrowestOf('fff00000').holds,
      }),
    ).toMatchObject({ state: 'refused', message: expect.stringMatching(/^One part/) })
  })
})

describe('the people part', () => {
  it('names how many pieces to cut an overflowing window into, from how far its read reached', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = { from: 'a0000000', to: 'a0400000' }
    const { _id, _creationTime, ...viewer } = f.viewer
    await t.run(async (ctx) => {
      for (const at of ['a0000000', 'a0080000', 'a0100000', 'a0180000'])
        await ctx.db.insert('profiles', {
          ...viewer,
          id: `${at}-0000-4000-8000-000000000000`,
          email: `${at}@testbed.test`,
          auth_user_id: undefined,
        })
    })
    const inWindow = await t.run(async (ctx) =>
      (await ctx.db.query('profiles').collect())
        .filter((p) => p.org_id === f.org.id)
        .map((p) => p.id)
        .filter((id) => inIdWindow(id, w))
        .sort(),
    )
    PAGE.people.most = 2
    const answer = await as(t, f.admin).query(api.workspace.people, { org_id: f.org.id, ...w })
    expect(answer).toEqual({ state: 'overflow', pieces: cutPieces(w, inWindow[1]) })
    // the read reached an eighth of the window, sixteen pieces, which the
    // grid allows only four of
    expect(piecesAfter(w, answer)).toHaveLength(4)
  })

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
