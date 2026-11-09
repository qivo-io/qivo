import { describe, expect, it } from 'vitest'
import { asStored, plannerFixture, type Snapshot } from './plannerFixture.setup'
import { createWorkspaceBase } from './workspaceBase'

/* The base keeps each unchanged row's object across deliveries and says
   exactly which rows changed. */

const AT = '2026-09-14T08:00:00.000Z'

/** A snapshot with teams `ids`, and the fixture's person a member of each,
    the leader of none. */
function snapshotOf(ids: string[]): Snapshot {
  const snap = plannerFixture()
  snap.teams = ids.map((id) => ({
    id,
    org_id: snap.orgs[0].id,
    name: `Team ${id}`,
    track_delay_default: false,
    created_at: AT,
  }))
  snap.teamMembers = ids.map((team_id) => ({
    team_id,
    profile_id: snap.profiles[0].id,
    is_leader: false,
  }))
  return snap
}

describe('the workspace base', () => {
  it('keeps the object of every row that holds the same data, and names only the changed one', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b', 'c'])
    base.stage(asStored(structuredClone(snap)))
    base.apply()
    const before = base.map('teams')
    const [a, b] = [before.get('a'), before.get('b')]
    snap.teams[1].name = 'Renamed'
    base.stage(asStored(structuredClone(snap)))
    const changes = base.apply()
    expect([...(changes?.teams?.keys() ?? [])]).toEqual(['b'])
    expect(changes?.teamMembers).toBeUndefined()
    expect(base.map('teams').get('a')).toBe(a)
    expect(base.map('teams').get('b')).not.toBe(b)
    expect(base.map('teams').get('b')?.name).toBe('Renamed')
    expect(Object.isFrozen(base.map('teams').get('b'))).toBe(true)
  })

  it('names a removed and an added team, and a list that only moved', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b', 'c'])
    base.stage(asStored(structuredClone(snap)))
    base.apply()
    // b goes, d comes, and the memberships arrive in another order
    const next = structuredClone(snap)
    const d = { ...next.teams[1], id: 'd', name: 'Team d' }
    next.teams = [next.teams[0], next.teams[2], d]
    next.teamMembers = [next.teamMembers[1], next.teamMembers[2], next.teamMembers[0]]
    base.stage(asStored(structuredClone(next)))
    const changes = base.apply()
    expect(new Set(changes?.teams?.keys())).toEqual(new Set(['b', 'd']))
    expect(changes?.teams?.get('b')).toMatchObject({ id: 'b' })
    expect(changes?.teams?.get('d')).toBeUndefined()
    expect([...base.map('teams').keys()]).toEqual(['a', 'c', 'd'])
    // a list in a new order is a change
    expect(changes?.teamMembers).toBeDefined()
    expect(base.list('teamMembers').map((row) => row.team_id)).toEqual(['b', 'c', 'a'])
  })

  it('reports nothing for a delivery that changes nothing, and nothing twice', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    base.stage(asStored(structuredClone(snap)))
    base.apply()
    expect(base.apply()).toBeNull()
    base.stage(asStored(structuredClone(snap)))
    expect(base.apply()).toEqual({})
  })

  it('reports only what several deliveries before one apply changed in the end', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b'])
    base.stage(asStored(structuredClone(snap)))
    base.apply()
    const a = base.map('teams').get('a')
    // a renamed and back, c added and gone again, b renamed for good
    const renamed = structuredClone(snap)
    renamed.teams[0].name = 'Renamed'
    renamed.teams[1].name = 'Renamed too'
    renamed.teams.push({ ...renamed.teams[1], id: 'c' })
    base.stage(asStored(structuredClone(renamed)))
    const back = structuredClone(renamed)
    back.teams[0].name = snap.teams[0].name
    back.teams.pop()
    base.stage(asStored(structuredClone(back)))
    const changes = base.apply()
    expect([...(changes?.teams?.keys() ?? [])]).toEqual(['b'])
    expect(base.map('teams').get('a')?.name).toBe(snap.teams[0].name)
    expect(base.map('teams').has('c')).toBe(false)
    expect(a?.name).toBe(snap.teams[0].name)
  })

  it('keeps a list by place and a new order across deliveries', () => {
    const base = createWorkspaceBase()
    const snap = snapshotOf(['a', 'b', 'c'])
    base.stage(asStored(structuredClone(snap)))
    base.apply()
    // the first membership goes: the second takes its place
    const fewer = structuredClone(snap)
    fewer.teamMembers.splice(0, 1)
    base.stage(asStored(structuredClone(fewer)))
    expect(base.apply()?.teamMembers).toBeDefined()
    expect(base.list('teamMembers').map((row) => row.team_id)).toEqual(['b', 'c'])
    // a new order staged twice before one apply is still a change
    const moved = structuredClone(fewer)
    moved.teamMembers.reverse()
    base.stage(asStored(structuredClone(moved)))
    base.stage(asStored(structuredClone(moved)))
    expect(base.apply()?.teamMembers).toBeDefined()
    expect(base.list('teamMembers').map((row) => row.team_id)).toEqual(['c', 'b'])
  })
})
