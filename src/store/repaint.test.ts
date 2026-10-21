import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A repaint shapes every view model again. The memoized views (Roadmap rows,
   Board cards) skip a task by identity, so the store's contract is that a
   task keeps its object exactly while it, its delay and every task above and
   below it hold the same data, and that P.contextVersion moves when anything
   else a task's view reads changes. A delivery that changes nothing on
   screen notifies no view. The network double captures the snapshot
   subscription, and every write waits until the test answers it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

type Pending = { name: string; resolve: (value: unknown) => void }
const AT = '2026-09-14T08:00:00.000Z'

describe('view model identity across repaints', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  let sent: Pending[]
  let emits: number
  let stop: () => void

  const P = () => store.P
  const task = (id: string) => P().issues.find((issue) => issue.uuid === id)!
  const row = (snap: Snapshot, id: string) => snap.issues.find((issue) => issue.id === id)!

  /* The next delivery: the last one with `change` applied, as the server
     holds it. */
  function deliverChange(change: (snap: Snapshot) => void) {
    change(snapshot)
    snapshot.delivered_at = new Date(Date.parse(snapshot.delivered_at) + 1000).toISOString()
    deliver(structuredClone(snapshot))
  }

  function addTask(id: string, parent?: string) {
    snapshot.issues.push({
      id,
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: snapshot.issues.length + 1,
      title: `Task ${id}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      assignee_id: snapshot.profiles[0].id,
      created_at: AT,
      updated_at: AT,
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...(parent ? { parent_id: parent } : {}),
    })
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = plannerFixture()
    snapshot.projects[0].track_delay = true
    // a parent with two subtasks, and two tasks on their own
    addTask('parent')
    addTask('child-a', 'parent')
    addTask('child-b', 'parent')
    addTask('alone')
    addTask('other')
    sent = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, next) => {
      if (getFunctionName(ref) === 'snapshot:forMe') {
        deliver = next
        next(structuredClone(snapshot))
      }
      return vi.fn()
    })
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve) => sent.push({ name, resolve }))
    })
    store = await import('./planner')
    await store.initStore()
    emits = 0
    stop = P().subscribe(() => emits++)
  })
  afterEach(() => {
    stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps every unchanged task, and P.issueById with it, when one task changes', () => {
    const before = new Map(P().issues.map((it) => [it.uuid, it]))
    const context = P().contextVersion
    deliverChange((snap) => {
      row(snap, 'alone').title = 'Renamed elsewhere'
    })
    expect(task('alone').title).toBe('Renamed elsewhere')
    expect(task('alone')).not.toBe(before.get('alone'))
    for (const id of ['parent', 'child-a', 'child-b', 'other'])
      expect(task(id), id).toBe(before.get(id))
    for (const it of P().issues) expect(P().issueById[it.id]).toBe(it)
    expect(P().contextVersion).toBe(context)
  })

  it('gives the tasks above and below a changed task new objects, and no one else', () => {
    let before = new Map(P().issues.map((it) => [it.uuid, it]))
    deliverChange((snap) => {
      row(snap, 'child-a').status = 'done'
    })
    // the parent shows its subtasks' progress; a sibling reads neither
    for (const id of ['parent', 'child-a']) expect(task(id), id).not.toBe(before.get(id))
    for (const id of ['child-b', 'alone', 'other']) expect(task(id), id).toBe(before.get(id))
    before = new Map(P().issues.map((it) => [it.uuid, it]))
    deliverChange((snap) => {
      row(snap, 'parent').title = 'Renamed parent'
    })
    // a subtask's owner list asks about the tasks above it
    for (const id of ['parent', 'child-a', 'child-b']) expect(task(id), id).not.toBe(before.get(id))
    for (const id of ['alone', 'other']) expect(task(id), id).toBe(before.get(id))
  })

  it('gives a task a new object when a task it is linked to changes', () => {
    deliverChange((snap) => {
      snap.links.push({
        id: 'link-1',
        // stored as the blocker's link
        source_id: 'other',
        target_id: 'alone',
        type: 'blocks',
        pair_key: 'alone:other',
        created_at: AT,
      })
    })
    const before = new Map(P().issues.map((it) => [it.uuid, it]))
    // the blocker is done: Team sync's row for the task it blocks says so
    deliverChange((snap) => {
      row(snap, 'other').status = 'done'
    })
    for (const id of ['other', 'alone']) expect(task(id), id).not.toBe(before.get(id))
    for (const id of ['parent', 'child-a', 'child-b']) expect(task(id), id).toBe(before.get(id))
  })

  it('keeps the very same list when a delivery changes no task', () => {
    const issues = P().issues
    const byId = P().issueById
    deliverChange((snap) => {
      snap.messages.push({
        id: 'message-1',
        org_id: snap.orgs[0].id,
        recipient_id: snap.profiles[0].id,
        issue_id: 'alone',
        issue_title: 'Task alone',
        kind: 'change',
        detail: 'Status changed',
        created_at: AT,
      })
    })
    expect(P().unreadMessages).toBe(1)
    expect(P().issues).toBe(issues)
    expect(P().issueById).toBe(byId)
  })

  it('gives a task whose delay changed a new object, its data the same', async () => {
    // the dates module the store loaded, after resetModules
    const { TODAY_WEEK, weekToISO } = await import('../lib/dates')
    const me = snapshot.profiles[0].id
    deliverChange((snap) => {
      Object.assign(row(snap, 'alone'), {
        start_week: weekToISO(TODAY_WEEK),
        end_week: weekToISO(TODAY_WEEK),
        due_date: weekToISO(TODAY_WEEK + 1),
        remaining_hours: 8,
        remaining_set_at: new Date().toISOString(),
      })
    })
    const before = task('alone')
    const other = task('other')
    const delay = P().delayOf(before)
    // another task of the same owner, outside this view, fills the weeks
    deliverChange((snap) => {
      snap.orgLoad.push({
        issue_id: null,
        owner_id: me,
        start_week: weekToISO(TODAY_WEEK),
        end_week: weekToISO(TODAY_WEEK + 1),
        remaining: 400,
        remaining_set_at: new Date().toISOString(),
      })
    })
    expect(P().delayOf(task('alone'))).not.toEqual(delay)
    expect(task('alone')).not.toBe(before)
    expect(task('other')).toBe(other)
  })

  it('moves contextVersion when something besides the tasks changes, and only then', () => {
    const context = P().contextVersion
    const before = new Map(P().issues.map((it) => [it.uuid, it]))
    deliverChange((snap) => {
      row(snap, 'other').title = 'A task change'
    })
    expect(P().contextVersion).toBe(context)
    deliverChange((snap) => {
      snap.projects[0].name = 'Renamed project'
    })
    expect(P().contextVersion).not.toBe(context)
    // the tasks themselves did not change
    expect(task('alone')).toBe(before.get('alone'))
    const renamed = P().contextVersion
    deliverChange((snap) => {
      snap.profiles[0].name = 'Renamed person'
    })
    expect(P().contextVersion).not.toBe(renamed)
    // a team membership decides what the person sees (the search palette
    // asks P.canSee again when this moves)
    const named = P().contextVersion
    deliverChange((snap) => {
      snap.teams.push({
        id: 'team-1',
        org_id: snap.orgs[0].id,
        name: 'Field',
        stale_days: 7,
        archive_days: 30,
        track_delay_default: true,
        created_at: AT,
      })
    })
    const teamed = P().contextVersion
    expect(teamed).not.toBe(named)
    deliverChange((snap) => {
      snap.teamMembers.push({
        team_id: 'team-1',
        profile_id: snap.profiles[0].id,
        is_leader: false,
      })
    })
    expect(P().contextVersion).not.toBe(teamed)
  })

  it('keeps contextVersion for the organization load and Team sync stamps', () => {
    const context = P().contextVersion
    const people = P().users
    // another person's hours outside this view: only the delays read them
    deliverChange((snap) => {
      snap.orgLoad.push({
        issue_id: null,
        owner_id: snap.profiles[0].id,
        start_week: '2026-09-14',
        end_week: '2026-09-21',
        remaining: 12,
        remaining_set_at: AT,
      })
    })
    expect(P().contextVersion).toBe(context)
    // a change made on a person through Team sync stamps them
    deliverChange((snap) => {
      snap.profiles[0].sync_at = '2026-09-16T08:00:00.000Z'
    })
    expect(P().users).not.toBe(people)
    expect(P().contextVersion).toBe(context)
  })

  it('notifies no view for a delivery that changes nothing on screen', async () => {
    // the paint stamps the time of the edit, which the server's row matches
    vi.useFakeTimers({ now: Date.parse('2026-09-16T08:00:00.000Z') })
    try {
      // a write waits with its paint; the delivery that holds its change
      // shows exactly what is on screen already
      void P().updateIssue(task('alone').id, { title: 'Painted first' })
      expect(sent).toHaveLength(1)
      const shown = emits
      deliverChange((snap) => {
        Object.assign(row(snap, 'alone'), {
          title: 'Painted first',
          updated_at: new Date().toISOString(),
        })
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(emits).toBe(shown)
      expect(task('alone').title).toBe('Painted first')
      expect(P().roadmapUndo.busy).toBe(true)
      // the answer ends the wait, which Roadmap's undo reads, so it shows
      // though the rows stay as they were
      sent[0].resolve(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(P().roadmapUndo.busy).toBe(false)
      expect(emits).toBe(shown + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still notifies for a delivery that changes only rows no view model holds', () => {
    const shown = emits
    // another person's task in a project this person cannot see takes the
    // next number, which only the New task preview reads
    deliverChange((snap) => {
      snap.orgs[0].next_issue_num = 40
    })
    expect(emits).toBe(shown + 1)
    expect(P().nextIssueKey(snapshot.projects[0].id)).toContain('41')
  })

  it('notifies for a delivery that changes a task', () => {
    const shown = emits
    deliverChange((snap) => {
      row(snap, 'other').priority = 'high'
    })
    expect(emits).toBe(shown + 1)
  })
})
