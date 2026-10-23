import { describe, expect, it } from 'vitest'
import { plannerFixture } from './plannerFixture.setup'
import { createWorkspaceRows } from './rowMap'
import { createWorkspaceBase } from './workspaceBase'

/* The rows a paint reads (store/rowMap.ts) never let it write into the
   server's rows, which the base keeps frozen (store/workspaceBase.ts). A
   whole-section paint finds its rows without copying them, and copies only
   the rows it then changes. */

const AT = '2026-09-14T08:00:00.000Z'

/** Rows over a base holding two teams' memberships and three tasks. */
function rowsOf() {
  const snap = plannerFixture()
  const [me] = snap.profiles
  snap.teamMembers = [
    { team_id: 't1', profile_id: me.id, is_leader: false },
    { team_id: 't1', profile_id: 'p2', is_leader: false },
    { team_id: 't2', profile_id: me.id, is_leader: false },
  ]
  snap.issues = ['a', 'b', 'c'].map((id, n) => ({
    id,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: n + 1,
    title: `Task ${id}`,
    description: '',
    status: n === 0 ? 'done' : 'todo',
    priority: 'medium',
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }))
  const base = createWorkspaceBase()
  base.stage(snap)
  const rows = createWorkspaceRows(base)
  rows.beginRepaint()
  return { base, rows, me: me.id }
}

describe('kept list rows', () => {
  it("stay the server's rows outside a pass, and a later pass may change them in place", () => {
    const { base, rows, me } = rowsOf()
    const server = base.list('teamMembers')
    // a pending removal filters the list (removeUser, removeAtOnce)
    rows.paint(() => rows.keepList('teamMembers', (m) => m.profile_id === me))
    const shown = rows.list('teamMembers')
    expect(shown).toHaveLength(2)
    // outside a pass the kept rows are the server's own, unchanged
    for (const row of shown) expect(server).toContain(row)
    // a later paint changes a kept row in place (setTeamLeader)
    rows.paint(() => {
      const row = rows.list('teamMembers').find((m) => m.team_id === 't1')
      if (!row) throw new Error('kept row missing')
      row.is_leader = true
    })
    expect(rows.list('teamMembers').find((m) => m.team_id === 't1')?.is_leader).toBe(true)
    expect(base.list('teamMembers').every((m) => !m.is_leader)).toBe(true)
  })

  it('copies kept rows across a saved and restored repaint, and a repaint drops the filter', () => {
    const { base, rows, me } = rowsOf()
    rows.paint(() => rows.keepList('teamMembers', (m) => m.profile_id === me))
    const saved = rows.save()
    rows.beginRepaint()
    expect(rows.list('teamMembers')).toBe(base.list('teamMembers'))
    rows.restore(saved)
    rows.paint(() => {
      for (const row of rows.list('teamMembers')) row.is_leader = true
    })
    expect(rows.list('teamMembers').map((m) => m.is_leader)).toEqual([true, true])
    expect(base.list('teamMembers').every((m) => !m.is_leader)).toBe(true)
  })
})

describe('whole-section reads', () => {
  it('find rows among the server rows, copies, deletes and inserts, copying only what they hand to a paint', () => {
    const { base, rows } = rowsOf()
    rows.paint(() => {
      // a copy (b), a delete (c) and an insert (d)
      const b = rows.issues.get('b')
      if (b) b.status = 'done'
      rows.issues.delete('c')
      rows.issues.set('d', { ...(base.map('issues').get('a') as object), id: 'd' } as never)
    })
    const done = (row: { status: string }) => row.status === 'done'
    expect(rows.issues.keysWhere(done)).toEqual(['a', 'b', 'd'])
    expect([...rows.issues.peekValues()].map((row) => row.id)).toEqual(['a', 'b', 'd'])
    // outside a pass `where` hands out what is shown, the server's row for a
    rows.paint(() => {
      const found = rows.issues.where(done)
      expect(found.map((row) => row.id)).toEqual(['a', 'b', 'd'])
      // inside a pass each is a copy a paint may change
      for (const row of found) row.title = 'Changed'
    })
    expect(base.map('issues').get('a')?.title).toBe('Task a')
    expect(rows.issues.peek('a')?.title).toBe('Changed')
  })
})
