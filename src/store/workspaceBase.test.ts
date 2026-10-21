import { describe, expect, it } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import { createWorkspaceBase } from './workspaceBase'

/* The base keeps each unchanged row's object across deliveries and says
   exactly which rows changed. */

const AT = '2026-09-14T08:00:00.000Z'

/** A snapshot with tasks `ids` and a load row for each. */
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
  snap.orgLoad = ids.map((id) => ({
    issue_id: id,
    owner_id: snap.profiles[0].id,
    start_week: '2026-09-14',
    end_week: '2026-09-21',
    remaining: 4,
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
    next.orgLoad = [{ ...next.orgLoad[1], issue_id: 'd' }, next.orgLoad[2], next.orgLoad[0]]
    const entered = base.stage(structuredClone(next))
    expect([...entered]).toEqual(['d'])
    const changes = base.apply()
    expect(new Set(changes?.issues?.keys())).toEqual(new Set(['b', 'd']))
    expect(changes?.issues?.get('b')).toMatchObject({ id: 'b' })
    expect(changes?.issues?.get('d')).toBeUndefined()
    expect([...base.map('issues').keys()]).toEqual(['a', 'c', 'd'])
    // the load rows sum in delivery order, so a new order is a change
    expect(changes?.orgLoad).toBeDefined()
    expect(base.list('orgLoad').map((row) => row.issue_id)).toEqual(['d', 'c', 'a'])
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
})
