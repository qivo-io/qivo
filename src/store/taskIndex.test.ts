import { describe, expect, it } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import { createWorkspaceRows } from './rowMap'
import { createTaskIndex, type TaskSources } from './taskIndex'
import { createWorkspaceBase } from './workspaceBase'

/* The task index keeps the tasks up to date a change at a time, and must
   always hold what a full build from the same rows gives. */

const AT = '2026-09-14T08:00:00.000Z'

describe('the task index', () => {
  /** Rows over a base holding `snap`, and the sources the index reads. */
  function workspace(snap: Snapshot) {
    const base = createWorkspaceBase()
    const rows = createWorkspaceRows(base)
    base.stage(structuredClone(snap))
    rows.beginRepaint()
    rows.takeDirty()
    const sources = (): TaskSources => ({
      issues: rows.issues,
      links: rows.links,
      attachments: rows.attachments,
      labels: rows.labels,
      issueLabels: rows.list('issueLabels'),
      issueSubs: rows.list('issueSubs'),
      orgLoad: rows.list('orgLoad'),
      hiddenSubtaskParents: rows.flags('hiddenSubtaskParents'),
      hiddenParentTasks: rows.flags('hiddenParentTasks'),
      homeOrg: snap.orgs[0].id,
      mine: new Set(snap.myProfileIds),
      capacity: new Map(),
      defaultCapacity: 40,
    })
    /** Delivers `next` and answers what the rows say changed, for update. */
    const deliver = (next: Snapshot) => {
      base.stage(structuredClone(next))
      rows.beginRepaint()
      const dirty = rows.takeDirty()
      return {
        issues: dirty.keys.get('issues') ?? new Set<string>(),
        links: dirty.keys.get('links') ?? new Set<string>(),
        attachments: dirty.keys.get('attachments') ?? new Set<string>(),
        labels: dirty.keys.has('labels'),
        issueLabels: dirty.lists.has('issueLabels'),
        issueSubs: dirty.lists.has('issueSubs'),
        orgLoad: dirty.lists.has('orgLoad'),
        flags: dirty.flags,
      }
    }
    return { sources, deliver }
  }

  const task = (snap: Snapshot, id: string, num: number): Snapshot['issues'][number] => ({
    id,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })

  it('moves a task whose number changed to its place by number', () => {
    const snap = plannerFixture()
    snap.issues = [task(snap, 'a', 1), task(snap, 'b', 2)]
    const { sources, deliver } = workspace(snap)
    const index = createTaskIndex()
    index.full(sources())
    // a create's preview number moves when another create takes it
    snap.issues[0].num = 3
    const moved = index.update(sources(), deliver(snap))
    expect(moved).toEqual(new Map([['QN-1', 'QN-3']]))
    const fresh = createTaskIndex()
    fresh.full(sources())
    expect(index.issues().map((it) => it.key)).toEqual(['QN-2', 'QN-3'])
    expect(index.issues()).toEqual(fresh.issues())
  })

  it('holds what a full build gives after every kind of change, handle moves included', () => {
    let seed = 11
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      // the high bits: the low ones of this sequence repeat in short cycles
      return Math.floor((seed / 2147483648) * n)
    }
    const snap = plannerFixture()
    const home = snap.orgs[0].id
    const owner = snap.profiles[0].id
    snap.labels = ['b', 'a', 'c'].map((name, n) => ({
      id: `label-${n}`,
      org_id: home,
      name,
      name_lower: name,
      color: '#557733',
      created_at: AT,
    }))
    snap.issues = Array.from({ length: 12 }, (_, n) => ({
      ...task(snap, `t${n}`, n + 1),
      assignee_id: owner,
      start_week: '2026-09-14',
      end_week: '2026-09-21',
      remaining_hours: 4,
      remaining_set_at: AT,
    }))
    let made = 12
    const { sources, deliver } = workspace(snap)
    const index = createTaskIndex()
    index.full(sources())
    let capacity = 40
    const ids = () => snap.issues.map((row) => row.id)
    const pick = () => ids()[random(snap.issues.length)]
    const steps: (() => void)[] = [
      () => {
        const row = snap.issues[random(snap.issues.length)]
        row.title = `${row.title}!`
      },
      () => {
        // a parent's dates, completion and delay follow its subtasks'
        const row = snap.issues[random(snap.issues.length)]
        const week = `2026-${String(9 + random(3)).padStart(2, '0')}-${String(1 + random(28)).padStart(2, '0')}`
        row.start_week = week
        row.end_week = week < '2026-11-01' ? '2026-11-02' : '2026-12-28'
        row.status = (['todo', 'progress', 'done'] as const)[random(3)]
        row.remaining_hours = random(20)
        row.due_date = random(2) ? '2026-11-16' : '2026-12-14'
      },
      () => {
        // a new number, as a create's preview number moves; numbers stay
        // unique in an organization, as the server and newTaskPaint keep them
        made++
        snap.issues[random(snap.issues.length)].num = made
      },
      () => {
        const row = snap.issues[random(snap.issues.length)]
        const parent = pick()
        const isParent = snap.issues.some((other) => other.parent_id === row.id)
        if (parent !== row.id && !isParent && !snap.issues.find((r) => r.id === parent)?.parent_id)
          row.parent_id = parent
        else delete row.parent_id
      },
      () => {
        made++
        snap.issues.push({ ...task(snap, `t${made}`, made), assignee_id: owner })
      },
      () => {
        const gone = pick()
        snap.issues = snap.issues.filter((row) => row.id !== gone)
        for (const row of snap.issues) if (row.parent_id === gone) delete row.parent_id
      },
      () => {
        const [source, target] = [pick(), pick()]
        if (source !== target)
          snap.links.push({
            id: `link-${made}-${random(1000)}`,
            source_id: source,
            target_id: target,
            type: random(2) ? 'blocks' : 'relates',
            pair_key: [source, target].sort().join(':'),
            created_at: AT,
          })
      },
      () => {
        snap.links.splice(random(snap.links.length + 1), 1)
      },
      () => {
        snap.attachments.push({
          id: `att-${made}-${random(1000)}`,
          issue_id: pick(),
          name: 'file.pdf',
          size_bytes: 10,
          storage_id: 'kg2storage' as never,
          inline: random(2) === 0,
          created_at: AT,
        })
      },
      () => {
        snap.attachments.splice(random(snap.attachments.length + 1), 1)
      },
      () => {
        snap.issueLabels.push({ issue_id: pick(), label_id: `label-${random(3)}` })
      },
      () => {
        snap.issueLabels.splice(random(snap.issueLabels.length + 1), 1)
      },
      () => {
        snap.labels[random(3)].name = `label ${random(100)}`
      },
      () => {
        const follow = { issue_id: pick(), profile_id: owner, created_at: AT }
        if (!snap.issueSubs.some((s) => s.issue_id === follow.issue_id)) snap.issueSubs.push(follow)
        else snap.issueSubs.splice(random(snap.issueSubs.length), 1)
      },
      () => {
        const row = snap.issues[random(snap.issues.length)]
        row.has_hidden_subtasks = !row.has_hidden_subtasks
      },
      () => {
        const row = snap.issues[random(snap.issues.length)]
        row.has_hidden_parent = !row.has_hidden_parent
      },
      () => {
        snap.orgLoad = snap.issues
          .filter(() => random(3) > 0)
          .map((row) => ({
            issue_id: random(4) ? row.id : null,
            owner_id: owner,
            start_week: '2026-09-14',
            end_week: '2026-09-28',
            remaining: 1 + random(30),
            remaining_set_at: AT,
          }))
      },
      () => {
        capacity = 1 + random(40)
      },
    ]
    for (let step = 0; step < 400; step++) {
      steps[random(steps.length)]()
      const handlesBefore = new Map(index.uuidToKey)
      const changes = deliver(snap)
      const from = { ...sources(), capacity: new Map([[owner, capacity]]) }
      const moved = index.update(from, changes) ?? index.full(from)
      const fresh = createTaskIndex()
      fresh.full(from)
      const expectedMoves = new Map<string, string>()
      for (const [uuid, handle] of handlesBefore) {
        const now = fresh.uuidToKey.get(uuid)
        if (now && now !== handle) expectedMoves.set(handle, now)
      }
      expect(index.issues(), `step ${step}`).toEqual(fresh.issues())
      expect(index.issueById(), `step ${step}`).toEqual(fresh.issueById())
      expect(index.delays, `step ${step}`).toEqual(fresh.delays)
      expect(index.loads(), `step ${step}`).toEqual(fresh.loads())
      expect(index.uuidToKey, `step ${step}`).toEqual(fresh.uuidToKey)
      expect(index.keyToUuid, `step ${step}`).toEqual(fresh.keyToUuid)
      expect(index.keyByOrg, `step ${step}`).toEqual(fresh.keyByOrg)
      expect(moved, `step ${step}`).toEqual(expectedMoves)
    }
  })
})
