import { describe, expect, it } from 'vitest'
import { asStored, plannerFixture } from './plannerFixture.setup'
import { createWorkspaceRows } from './rowMap'
import { createWorkspaceBase } from './workspaceBase'

/* The rows a paint reads (store/rowMap.ts) never let it write into the
   server's rows, which the base keeps frozen (store/workspaceBase.ts). A
   whole-section paint finds its rows without copying them, and copies only
   the rows it then changes. */

/** Rows over a base holding two teams' memberships and three people, the
    fixture's admin and two users. */
function rowsOf() {
  const snap = plannerFixture()
  const [me] = snap.profiles
  snap.profiles.push(
    { ...me, id: 'p2', auth_user_id: undefined, name: 'Person 2', org_role: 'user' },
    { ...me, id: 'p3', auth_user_id: undefined, name: 'Person 3', org_role: 'user' },
  )
  snap.teamMembers = [
    { team_id: 't1', profile_id: me.id, is_leader: false },
    { team_id: 't1', profile_id: 'p2', is_leader: false },
    { team_id: 't2', profile_id: me.id, is_leader: false },
  ]
  const base = createWorkspaceBase()
  base.stage(asStored(snap))
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
    const { base, rows, me } = rowsOf()
    const admin = (row: { org_role: string }) => row.org_role === 'admin'
    rows.paint(() => {
      // a copy (p2), a delete (p3) and an insert (p4)
      const p2 = rows.profiles.get('p2')
      if (p2) p2.org_role = 'admin'
      rows.profiles.delete('p3')
      rows.profiles.set('p4', { ...(base.map('profiles').get(me) as object), id: 'p4' } as never)
    })
    // outside a pass `where` hands out what is shown, the server's row of
    // the fixture's admin among them
    expect(rows.profiles.where(admin).map((row) => row.id)).toEqual([me, 'p2', 'p4'])
    expect(rows.profiles.where(admin)[0]).toBe(base.map('profiles').get(me))
    rows.paint(() => {
      const found = rows.profiles.where(admin)
      expect(found.map((row) => row.id)).toEqual([me, 'p2', 'p4'])
      // inside a pass each is a copy a paint may change
      for (const row of found) row.name = 'Changed'
    })
    expect(base.map('profiles').get(me)?.name).not.toBe('Changed')
    expect(rows.profiles.peek(me)?.name).toBe('Changed')
  })
})
