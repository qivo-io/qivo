import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import { liveIn } from '../../convex/lib/liveTasks'
import { parentLink, workingSetOf } from '../../convex/lib/workingSet'
import { canonicalLoad, committedByWeek, type LoadSpan } from '../../convex/lib/workload'
import { orgLoadRows } from '../../convex/planning'
import { isoToWeek, TODAY_WEEK, tsToWeek, weekToISO } from '../lib/dates'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The store derives the load of the tasks it shows from their rows with the
   server's fence (convex/lib/loadRows.ts), and takes only the load of tasks
   it is not shown from the snapshot. So a pending edit moves its owner's
   load and delays at once, and the result is what the server's own load
   rows (convex/planning.ts orgLoadRows) give. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

describe('the load the store derives from the tasks it shows', () => {
  let store: typeof import('./planner')
  let deliver: (snap: Snapshot) => void

  const P = () => store.P

  /** Boots the store on `snap`, every write left waiting. */
  async function boot(snap: Snapshot) {
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') {
        deliver = (s) => next(structuredClone(s))
        deliver(snap)
      }
      return vi.fn()
    })
    store = await import('./planner')
    await store.initStore()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'identity:claimMySeats'
        ? Promise.resolve(null)
        : new Promise(() => {}),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('moves the load and the delay with a pending hours or owner edit', async () => {
    const snap = plannerFixture()
    const me = snap.profiles[0].id
    const other = { ...snap.profiles[0], id: 'person-2', name: 'Other', auth_user_id: undefined }
    snap.profiles.push(other)
    snap.projects[0].track_delay = true
    const week = TODAY_WEEK + 1
    const task: Snapshot['issues'][number] = {
      id: 'task-1',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Planned',
      description: '',
      status: 'todo',
      priority: 'medium',
      assignee_id: me,
      start_week: weekToISO(week),
      end_week: weekToISO(week),
      due_date: weekToISO(week + 1),
      remaining_hours: 8,
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    }
    snap.issues = [task]
    // the row a server before this change also sent for the shown task,
    // which must not count twice
    snap.orgLoad = [
      {
        issue_id: task.id,
        owner_id: me,
        start_week: weekToISO(week),
        end_week: weekToISO(week),
        remaining: 8,
        remaining_set_at: null,
      },
    ]
    await boot(snap)
    expect(P().weekLoadOf(me, week)).toBe(8)
    expect(P().delayOf('QN-1')?.status).toBe('ok')
    // more hours than two weeks hold: late at once, before any answer
    void P().updateIssue('QN-1', { remaining: 100 })
    expect(P().weekLoadOf(me, week)).toBe(100)
    expect(P().delayOf('QN-1')?.status).toBe('late')
    // and the hours follow a new owner at once
    void P().updateIssue('QN-1', { assignee: other.id })
    expect(P().weekLoadOf(me, week)).toBe(0)
    expect(P().weekLoadOf(other.id, week)).toBe(100)
  })

  it('adds up what the server’s load rows give, whatever the mix of tasks', async () => {
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor((seed / 2147483648) * n)
    }
    const org = 'org-1'
    const doc = <T extends object>(row: T) => ({ ...row, _id: 'doc' as never, _creationTime: 0 })
    const person = (id: string): Doc<'profiles'> =>
      doc({
        id,
        org_id: org,
        name: id,
        initials: 'XX',
        color: '#335577',
        org_role: 'user' as const,
        active: true,
        kind: 'person' as const,
        created_at: AT,
      })
    const me: Doc<'profiles'> = {
      ...person('me'),
      org_role: 'admin',
      auth_user_id: 'test-account',
    }
    // an outsider owns work here but is no profile of this organization
    const roster = [me, person('ana'), person('ben')]
    const owners = [...roster.map((p) => p.id), 'outsider']
    const projects: Doc<'projects'>[] = ['shown', 'hidden', 'archived', 'shown-2'].map((id, num) =>
      doc({
        id,
        org_id: org,
        type: 'project' as const,
        key: id.toUpperCase().slice(0, 4),
        num,
        name: id,
        description: '',
        sort_order: num,
        track_delay: true,
        created_at: AT,
        ...(id === 'archived' ? { archived_at: AT } : {}),
      }),
    )
    const byUuid = new Map(projects.map((p) => [p.id, p]))
    const visible = (id: string) => id !== 'hidden'
    const statuses = ['todo', 'progress', 'review', 'done', 'backlog'] as const
    const issues: Doc<'issues'>[] = Array.from({ length: 160 }, (_, n) => {
      const start = TODAY_WEEK - 2 + random(6)
      const planned = random(5)
        ? { start_week: weekToISO(start), end_week: weekToISO(start + random(4)) }
        : {}
      return doc({
        id: `t${n}`,
        org_id: org,
        project_id: projects[random(projects.length)].id,
        num: n + 1,
        title: `Task ${n}`,
        description: '',
        status: statuses[random(statuses.length)],
        priority: 'medium' as const,
        assignee_id: random(6) ? owners[random(owners.length)] : undefined,
        reviewer_id: random(2) ? owners[random(owners.length)] : undefined,
        ...planned,
        remaining_hours: [0, 0.1, 0.2, 0.3, 1.5, 4, 7][random(7)],
        ...(random(2) ? { remaining_set_at: AT } : {}),
        paused: random(6) === 0,
        created_at: AT,
        updated_at: AT,
      })
    })
    // subtasks, some across projects the reader cannot see
    for (const task of issues) if (random(4) === 0) task.parent_id = issues[random(40)].id
    for (const task of issues) if (task.parent_id === task.id) delete task.parent_id
    const view = { byUuid, visible }
    const active = issues.filter((i) => liveIn(byUuid)(i.project_id))
    const rows = orgLoadRows(me, view, new Set(roster.map((p) => p.id)), active)
    // the snapshot as forMe shapes it: the working set, and the load rows of
    // tasks the reader is not shown
    const workingSet = workingSetOf(active, view)
    const strip = <T extends { _id: unknown; _creationTime: number }>(doc: T) => {
      const { _id, _creationTime, ...row } = doc
      return row
    }
    const snap = plannerFixture()
    snap.myProfileIds = [me.id]
    snap.orgs = [{ ...snap.orgs[0], id: org }]
    snap.profiles = roster.map(strip)
    snap.projects = projects.filter((p) => visible(p.id)).map(strip)
    snap.issues = workingSet.tasks.map((task) => {
      const { parent_id: _parent, relations_marked: _marks, ...row } = strip(task)
      return {
        ...row,
        ...parentLink(task, workingSet.shown),
        has_hidden_subtasks: workingSet.hasHiddenSubtasks(task.id),
      }
    })
    snap.orgLoad = rows.filter((row) => row.issue_id === null)
    await boot(snap)
    expect(P().issues.length).toBe(workingSet.tasks.length)
    // the server's rows by owner, added up in the order both sides use
    const expected = new Map<string, LoadSpan[]>()
    for (const row of rows) {
      const list = expected.get(row.owner_id) ?? []
      list.push({
        issueUuid: row.issue_id,
        start: isoToWeek(row.start_week),
        end: isoToWeek(row.end_week),
        remaining: row.remaining,
        remainingSet: row.remaining_set_at === null ? null : tsToWeek(row.remaining_set_at),
      })
      expected.set(row.owner_id, list)
    }
    // the mix holds shown and hidden rows, and tasks the fence leaves out
    expect(rows.some((row) => row.issue_id === null)).toBe(true)
    expect(rows.filter((row) => row.issue_id !== null).length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(workingSet.tasks.length)
    for (const owner of owners) {
      const byWeek = committedByWeek(canonicalLoad(expected.get(owner) ?? []))
      for (let week = TODAY_WEEK - 3; week <= TODAY_WEEK + 10; week++)
        expect(P().weekLoadOf(owner, week), `${owner}, week ${week}`).toBe(byWeek.get(week) ?? 0)
    }
  })
})
