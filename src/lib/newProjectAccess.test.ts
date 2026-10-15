import { describe, expect, it } from 'vitest'
import {
  type AccessDraft,
  afterAccessChange,
  afterLeadChange,
  afterProjectSaved,
  creatorNote,
  requestedAccess,
} from './newProjectAccess'

const me = { id: 'aisha', admin: false }
const admin = { id: 'nora', admin: true }
const empty: AccessDraft = { access: {}, self: 'none' }

describe('afterLeadChange', () => {
  it('adds a standard-user creator as User when someone else leads', () => {
    expect(afterLeadChange(empty, 'leo', me)).toEqual({ access: { aisha: 'user' }, self: 'auto' })
  })

  it('keeps the automatic entry while the lead moves between other people', () => {
    const auto = afterLeadChange(empty, 'leo', me)
    expect(afterLeadChange(auto, 'daniel', me)).toEqual(auto)
  })

  it('still drops the entry of another person who becomes lead', () => {
    const draft: AccessDraft = { access: { leo: 'viewer' }, self: 'none' }
    expect(afterLeadChange(draft, 'leo', me)).toEqual({ access: { aisha: 'user' }, self: 'auto' })
  })

  it('removes the untouched automatic entry when the creator leads again, and adds it back later', () => {
    const back = afterLeadChange(afterLeadChange(empty, 'leo', me), 'aisha', me)
    expect(back).toEqual(empty)
    expect(afterLeadChange(back, 'leo', me)).toEqual({ access: { aisha: 'user' }, self: 'auto' })
  })

  it('keeps an entry the creator changed beside the lead role', () => {
    const auto = afterLeadChange(empty, 'leo', me)
    const edited = afterAccessChange(auto, 'aisha', 'viewer', me)
    expect(afterLeadChange(edited, 'aisha', me)).toEqual({
      access: { aisha: 'viewer' },
      self: 'own',
    })
  })

  it('does not add back an entry the creator removed', () => {
    const removed = afterAccessChange(afterLeadChange(empty, 'leo', me), 'aisha', null, me)
    expect(afterLeadChange(removed, 'daniel', me)).toEqual({ access: {}, self: 'own' })
    expect(afterLeadChange(afterLeadChange(removed, 'aisha', me), 'leo', me)).toEqual({
      access: {},
      self: 'own',
    })
  })

  it('does not add a second entry when the creator already has one', () => {
    const own = afterAccessChange(empty, 'aisha', 'viewer', me)
    expect(afterLeadChange(own, 'leo', me)).toEqual({ access: { aisha: 'viewer' }, self: 'own' })
  })

  it('never adds an org admin, and drops the new lead’s entry as before', () => {
    const draft: AccessDraft = { access: { leo: 'user', ben: 'viewer' }, self: 'none' }
    expect(afterLeadChange(draft, 'leo', admin)).toEqual({
      access: { ben: 'viewer' },
      self: 'none',
    })
    expect(afterLeadChange(empty, 'nora', admin)).toEqual(empty)
  })
})

describe('afterAccessChange', () => {
  it('sets and clears a level', () => {
    const set = afterAccessChange(empty, 'leo', 'user', me)
    expect(set).toEqual({ access: { leo: 'user' }, self: 'none' })
    expect(afterAccessChange(set, 'leo', null, me)).toEqual(empty)
  })

  it('makes the creator’s entry their own on any change', () => {
    const auto = afterLeadChange(empty, 'leo', me)
    expect(afterAccessChange(auto, 'aisha', 'user', me).self).toBe('own')
    expect(afterAccessChange(auto, 'ben', 'user', me).self).toBe('auto')
  })
})

describe('requestedAccess', () => {
  it('leaves the automatic entry to the server, which stores the same grant', () => {
    const auto = afterLeadChange(empty, 'leo', me)
    expect(requestedAccess(auto, me)).toEqual({})
    expect(requestedAccess({ access: { ben: 'viewer', aisha: 'user' }, self: 'auto' }, me)).toEqual(
      {
        ben: 'viewer',
      },
    )
  })

  it('sends an entry the creator removed as null and one they changed as it is', () => {
    const auto = afterLeadChange(empty, 'leo', me)
    expect(requestedAccess(afterAccessChange(auto, 'aisha', null, me), me)).toEqual({ aisha: null })
    expect(requestedAccess(afterAccessChange(auto, 'aisha', 'viewer', me), me)).toEqual({
      aisha: 'viewer',
    })
  })

  it('sends nothing for the creator who never had an entry', () => {
    expect(requestedAccess(empty, me)).toEqual({})
    expect(requestedAccess(afterLeadChange(empty, 'leo', admin), admin)).toEqual({})
  })
})

describe('creatorNote', () => {
  it('warns when the creator would not see the project, before naming the lead', () => {
    expect(creatorNote({ creator: me, lead: 'leo', sees: false })).toBe('hidden')
  })

  it('names the lead when someone else leads a project the creator sees', () => {
    expect(creatorNote({ creator: me, lead: 'leo', sees: true })).toBe('lead')
  })

  it('says nothing when the creator leads', () => {
    expect(creatorNote({ creator: me, lead: 'aisha', sees: true })).toBeNull()
  })

  it('says nothing to an org admin', () => {
    expect(creatorNote({ creator: admin, lead: 'leo', sees: true })).toBeNull()
    expect(creatorNote({ creator: admin, lead: 'leo', sees: false })).toBeNull()
  })
})

describe('afterProjectSaved', () => {
  it('opens a project the creator can see', () => {
    expect(afterProjectSaved({ type: 'meta', name: 'Luma', visible: true })).toEqual({
      message: 'Project “Luma” created',
      open: true,
    })
  })

  it('stays put and says so when the creator cannot see it', () => {
    expect(afterProjectSaved({ type: 'meta', name: 'Luma', visible: false })).toEqual({
      message: "Project “Luma” created. You don't have access to it.",
      open: false,
    })
  })

  it('opens a sub-project as before', () => {
    expect(afterProjectSaved({ type: 'project', name: 'Calibration', visible: false })).toEqual({
      message: 'Sub-project “Calibration” created',
      open: true,
    })
  })
})
