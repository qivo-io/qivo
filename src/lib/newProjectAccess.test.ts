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

  it('adds an org admin as anyone, since admin status gives no access, and drops the new lead’s entry as before', () => {
    const draft: AccessDraft = { access: { leo: 'user', ben: 'viewer' }, self: 'none' }
    expect(afterLeadChange(draft, 'leo', admin)).toEqual({
      access: { ben: 'viewer', nora: 'user' },
      self: 'auto',
    })
    // leading again drops the untouched entry
    expect(afterLeadChange(afterLeadChange(empty, 'leo', admin), 'nora', admin)).toEqual(empty)
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
    // the admin's automatic entry is the server's own grant, so it goes unsent
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

  it('names no lead to an org admin, who keeps managing the project, and warns them they will not see it', () => {
    expect(creatorNote({ creator: admin, lead: 'leo', sees: true })).toBeNull()
    expect(creatorNote({ creator: admin, lead: 'leo', sees: false })).toBe('hidden')
  })

  it('warns of nothing it does not know', () => {
    expect(creatorNote({ creator: admin, lead: 'leo', sees: null })).toBeNull()
    expect(creatorNote({ creator: me, lead: 'leo', sees: null })).toBe('lead')
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

  it('opens a sub-project the workspace holds and the creator is confirmed to see', () => {
    expect(
      afterProjectSaved({ type: 'project', name: 'Calibration', visible: true, sees: true }),
    ).toEqual({ message: 'Sub-project “Calibration” created', open: true })
    // an unconfirmed one stays closed with the plain toast, also when the
    // caller passes no confirmation at all
    for (const sees of [null, undefined])
      expect(
        afterProjectSaved({ type: 'project', name: 'Calibration', visible: true, sees }),
      ).toEqual({ message: 'Sub-project “Calibration” created', open: false })
  })

  it('says so and stays put for a sub-project the creator will not see, held or not', () => {
    for (const visible of [true, false])
      expect(
        afterProjectSaved({ type: 'project', name: 'Calibration', visible, sees: false }),
      ).toEqual({
        message: "Sub-project “Calibration” created. You don't have access to it.",
        open: false,
      })
  })

  it('stays put with the same message for a sub-project the workspace does not hold', () => {
    expect(
      afterProjectSaved({ type: 'project', name: 'Calibration', visible: false, sees: true }),
    ).toEqual({ message: 'Sub-project “Calibration” created', open: false })
  })
})
