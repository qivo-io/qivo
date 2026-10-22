import { describe, expect, it } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import { createWorkspaceBase } from './workspaceBase'

/* The base keeps each unchanged row's object across deliveries and says
   exactly which rows changed. */

const AT = '2026-09-14T08:00:00.000Z'

/** A snapshot with tasks `ids`, and for each a load row of a task in a
    project its reader cannot see, the only load rows the base keeps. */
function snapshotOf(ids: string[]): Snapshot {
  const snap = plannerFixture()
  snap.issues = ids.map((id, n) => ({
    id,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: n + 1,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }))
  snap.orgLoad = ids.map((_, n) => ({
    issue_id: null,
    owner_id: snap.profiles[0].id,
    start_week: '2026-09-14',
    end_week: '2026-09-21',
    remaining: n + 1,
    remaining_set_at: AT,
  }))
  return snap
}

describe('the workspace base', () => {
  it('keeps the object of every row that holds the same data, and names only the changed one', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b', 'c'])
    base.stage(structuredClone(snap))
    base.apply()
    const before = base.map('issues')
    const [a, b] = [before.get('a'), before.get('b')]
    snap.issues[1].title = 'Renamed'
    base.stage(structuredClone(snap))
    const changes = base.apply()
    expect([...(changes?.issues?.keys() ?? [])]).toEqual(['b'])
    expect(changes?.orgLoad).toBeUndefined()
    expect(base.map('issues').get('a')).toBe(a)
    expect(base.map('issues').get('b')).not.toBe(b)
    expect(base.map('issues').get('b')?.title).toBe('Renamed')
    expect(Object.isFrozen(base.map('issues').get('b'))).toBe(true)
  })

  it('names a removed and an added task, and a list that only moved', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b', 'c'])
    base.stage(structuredClone(snap))
    base.apply()
    // b goes, d comes, and the load rows arrive in another order
    const next = structuredClone(snap)
    const d = { ...next.issues[1], id: 'd', num: 4, title: 'Task d' }
    next.issues = [next.issues[0], next.issues[2], d]
    next.orgLoad = [next.orgLoad[1], next.orgLoad[2], next.orgLoad[0]]
    const entered = base.stage(structuredClone(next))
    expect([...entered]).toEqual(['d'])
    const changes = base.apply()
    expect(new Set(changes?.issues?.keys())).toEqual(new Set(['b', 'd']))
    expect(changes?.issues?.get('b')).toMatchObject({ id: 'b' })
    expect(changes?.issues?.get('d')).toBeUndefined()
    expect([...base.map('issues').keys()]).toEqual(['a', 'c', 'd'])
    // a list in a new order is a change
    expect(changes?.orgLoad).toBeDefined()
    expect(base.list('orgLoad').map((row) => row.remaining)).toEqual([2, 3, 1])
  })

  it('reports nothing for a delivery that changes nothing, and nothing twice', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    base.stage(structuredClone(snap))
    base.apply()
    expect(base.apply()).toBeNull()
    base.stage(structuredClone(snap))
    expect(base.apply()).toEqual({})
  })

  it('reports only what several deliveries before one apply changed in the end', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    base.stage(structuredClone(snap))
    base.apply()
    const a = base.map('issues').get('a')
    // a renamed and back, c added and gone again, b renamed for good
    const renamed = structuredClone(snap)
    renamed.issues[0].title = 'Renamed'
    renamed.issues[1].title = 'Renamed too'
    renamed.issues.push({ ...renamed.issues[1], id: 'c', num: 3 })
    base.stage(structuredClone(renamed))
    const back = structuredClone(renamed)
    back.issues[0].title = snap.issues[0].title
    back.issues.pop()
    base.stage(structuredClone(back))
    const changes = base.apply()
    expect([...(changes?.issues?.keys() ?? [])]).toEqual(['b'])
    expect(base.map('issues').get('a')?.title).toBe(snap.issues[0].title)
    expect(base.map('issues').has('c')).toBe(false)
    expect(a?.title).toBe(snap.issues[0].title)
  })

  it("keys an owner's hidden load rows by their place, keeps a new order across deliveries and leaves out rows naming a task", () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    const hidden = (remaining: number) => ({ ...snap.orgLoad[0], remaining })
    // a server before the app derived its shown tasks' load sent their rows
    // too, which would count twice
    const shown = { ...snap.orgLoad[0], issue_id: 'a', remaining: 9 }
    snap.orgLoad = [shown, hidden(1), hidden(2), hidden(4)]
    base.stage(structuredClone(snap))
    base.apply()
    expect(base.list('orgLoad').map((row) => row.remaining)).toEqual([1, 2, 4])
    // the first hidden row goes: the second takes its place
    const fewer = structuredClone(snap)
    fewer.orgLoad.splice(1, 1)
    base.stage(structuredClone(fewer))
    expect(base.apply()?.orgLoad).toBeDefined()
    expect(base.list('orgLoad').map((row) => row.remaining)).toEqual([2, 4])
    // a new order staged twice before one apply is still a change
    const moved = structuredClone(fewer)
    moved.orgLoad.reverse()
    base.stage(structuredClone(moved))
    base.stage(structuredClone(moved))
    expect(base.apply()?.orgLoad).toBeDefined()
    expect(base.list('orgLoad').map((row) => row.remaining)).toEqual([4, 2])
  })

  it("gives a new flag set when a task's hidden subtasks come and go, and keeps the old one as it was", () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    base.stage(structuredClone(snap))
    base.apply()
    const before = base.flags('hiddenSubtaskParents')
    snap.issues[0].has_hidden_subtasks = true
    base.stage(structuredClone(snap))
    base.apply()
    const on = base.flags('hiddenSubtaskParents')
    expect([...on]).toEqual(['a'])
    expect(on).not.toBe(before)
    expect(before.size).toBe(0)
    snap.issues[0].has_hidden_subtasks = false
    base.stage(structuredClone(snap))
    base.apply()
    expect(base.flags('hiddenSubtaskParents').size).toBe(0)
    expect([...on]).toEqual(['a'])
    // a change that leaves the flags alone keeps the same set
    const off = base.flags('hiddenSubtaskParents')
    snap.issues[1].title = 'Renamed'
    base.stage(structuredClone(snap))
    base.apply()
    expect(base.flags('hiddenSubtaskParents')).toBe(off)
  })

  it('keeps an id that starts with # as it is', () => {
    const base = createWorkspaceBase()
    // an id made before ids had to be uuids
    const snap = snapshotOf(['#legacy-task', 'b'])
    base.stage(structuredClone(snap))
    base.apply()
    expect(base.map('issues').get('#legacy-task')?.id).toBe('#legacy-task')
    expect(base.stagedTask('#legacy-task')?.id).toBe('#legacy-task')
    snap.issues[0].title = 'Renamed'
    base.stage(structuredClone(snap))
    expect([...(base.apply()?.issues?.keys() ?? [])]).toEqual(['#legacy-task'])
  })
})
