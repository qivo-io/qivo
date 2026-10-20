import { describe, expect, it } from 'vitest'
import type { FieldChange } from '../../convex/lib/functions'
import { type Lookup, noticeText, type Refusal, refusalLine } from './fieldNotice'

/* The words of a field_changed refusal's notice (store/fieldNotice.ts). */

const EMIL = 'p-emil'
const ME = 'p-me'
const look: Lookup = {
  record: (change) =>
    change.record === 'comment'
      ? 'this comment on QN-12'
      : change.record === 'milestone'
        ? 'milestone “Beta”'
        : 'QN-12',
  writer: (id) => (id === ME ? 'you' : id === EMIL ? { name: 'Emil Berg' } : null),
}
const change = (over: Partial<FieldChange> = {}): FieldChange => ({
  record: 'task',
  id: 'task-12',
  field: 'description',
  by: EMIL,
  at: '2026-10-20T10:00:00.000Z',
  ...over,
})
const line = (over: Partial<Refusal>) =>
  refusalLine({ changes: [change()], count: 1, ...over }, look)

describe('refusalLine', () => {
  it('names who changed the field when the server proves it', () => {
    expect(line({})).toBe(
      'Not saved. Emil Berg changed the description of QN-12. Your change was discarded.',
    )
  })

  it('says while you were offline for a write that waited through a drop', () => {
    expect(line({ offline: true })).toBe(
      'Not saved. Emil Berg changed the description of QN-12 while you were offline. Your change was discarded.',
    )
  })

  it('says the field was changed elsewhere when nobody is proven', () => {
    expect(line({ changes: [change({ by: null })] })).toBe(
      'Not saved. The description of QN-12 was changed elsewhere. Your change was discarded.',
    )
    // two people, or one the store does not know, name nobody either
    expect(line({ changes: [change(), change({ field: 'title', by: 'p-gone' })] })).toBe(
      'Not saved. The description and title of QN-12 were changed elsewhere. Your change was discarded.',
    )
  })

  it('tells the person their own other seat or tab changed it', () => {
    expect(line({ changes: [change({ by: ME })] })).toBe(
      'Not saved. You changed the description of QN-12 elsewhere. This change was discarded.',
    )
  })

  it('counts the later changes a refused one took with it', () => {
    expect(line({ count: 2 })).toBe(
      'Not saved. Emil Berg changed the description of QN-12. Your 2 changes were discarded.',
    )
  })

  it('says a whole Roadmap batch was not saved', () => {
    expect(
      line({
        batch: 14,
        changes: [change({ field: 'start_week' }), change({ field: 'end_week' })],
      }),
    ).toBe(
      'Not saved. Emil Berg changed the dates of QN-12. None of the 14 roadmap changes were saved.',
    )
  })

  it('says a refused comment edit is still in its editor', () => {
    expect(line({ kept: true, changes: [change({ record: 'comment', field: 'body' })] })).toBe(
      'Not saved. Emil Berg changed this comment on QN-12. Your text is still in the editor. Save again to replace their version.',
    )
  })

  it('says a refused delete was not done', () => {
    expect(line({ deletes: true, changes: [change({ record: 'milestone', field: 'week' })] })).toBe(
      'Not deleted. Emil Berg changed the date of milestone “Beta”. Check it before you delete it again.',
    )
  })
})

describe('noticeText', () => {
  it('shows three lines, then how many more', () => {
    expect(noticeText(['a', 'b'])).toBe('a\nb')
    expect(noticeText(['a', 'b', 'c', 'd', 'e'])).toBe('a\nb\nc\nAnd 2 more not saved.')
  })
})
