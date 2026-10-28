import { describe, expect, it } from 'vitest'
import {
  ADDRESS,
  type DraftAction,
  type DraftForm,
  type DraftState,
  draftReduce,
  draftStart,
  draftText,
  draftUnsaved,
  EMAIL,
  PERSON_NAME,
  TRIMMED,
  wholeNumber,
} from './savedDraft'

/* The draft rule of a settings field (lib/savedDraft.ts), without React:
   the organization name of org-1, stored as "Northstar". */

const KEY = 'org-1:name'
const LEO = { name: 'Leo Martins' }

/** An action for KEY, which it leaves out. */
type Step<T> = DraftAction<T> extends infer A ? (A extends unknown ? Omit<A, 'key'> : never) : never

/** The state after `steps` from `saved`, each an action for KEY. */
function run<T>(form: DraftForm<T>, saved: T, ...steps: Step<T>[]): DraftState<T> {
  return steps.reduce<DraftState<T>>(
    (s, step) => draftReduce(s, { key: KEY, ...step } as DraftAction<T>, form),
    draftStart(KEY, saved),
  )
}

const shown = (s: DraftState<string>) => draftText(s, TRIMMED)

describe('a settings field’s draft', () => {
  it('follows every saved value while untouched', () => {
    const s = run(TRIMMED, 'Northstar', { type: 'saved', value: 'Northstar Labs' })
    expect(shown(s)).toBe('Northstar Labs')
    expect(s.base).toBe('Northstar Labs')
    expect(s.conflict).toBeNull()
    expect(draftUnsaved(s, TRIMMED)).toBe(false)
  })

  it('keeps a draft through a new saved value and marks the conflict', () => {
    const s = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Labs' },
    )
    expect(shown(s)).toBe('Northstar Robotics')
    expect(s.base).toBe('Northstar')
    expect(s.conflict).toEqual({ value: 'Northstar Labs', by: null })
    expect(draftUnsaved(s, TRIMMED)).toBe(true)
  })

  it('sees no conflict in a value equal to the base or to the save in flight', () => {
    const back = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Labs' },
      { type: 'saved', value: 'Northstar' },
    )
    expect(back.conflict).toBeNull()
    expect(shown(back)).toBe('Northstar Robotics')
    const own = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Robotics' },
    )
    expect(own.conflict).toBeNull()
    expect(own.draft).toBeNull()
    expect(own.base).toBe('Northstar Robotics')
    expect(own.sending).toEqual([])
  })

  it('keeps text typed after a save started through its acknowledgement', () => {
    const s = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'edit', text: 'Northstar Robotics AB' },
      { type: 'saved', value: 'Northstar Robotics' },
    )
    expect(shown(s)).toBe('Northstar Robotics AB')
    expect(s.base).toBe('Northstar Robotics')
    expect(s.conflict).toBeNull()
    expect(draftUnsaved(s, TRIMMED)).toBe(true)
    // the server's own delivery of the same value changes nothing
    expect(
      draftReduce(s, { key: KEY, type: 'saved', value: 'Northstar Robotics' }, TRIMMED),
    ).toEqual(s)
  })

  it('keeps an awaited save’s text on screen until the server’s value arrives', () => {
    const accepted = run(
      PERSON_NAME,
      'Nora Lind',
      { type: 'edit', text: 'Nora Lindqvist' },
      { type: 'send', seq: 1, value: 'Nora Lindqvist' },
      { type: 'accepted', seq: 1, value: 'Nora Lindqvist', seen: 'Nora Lind' },
    )
    expect(draftText(accepted, PERSON_NAME)).toBe('Nora Lindqvist')
    expect(draftUnsaved(accepted, PERSON_NAME)).toBe(false)
    const delivered = draftReduce(
      accepted,
      { key: KEY, type: 'saved', value: 'Nora Lindqvist' },
      PERSON_NAME,
    )
    expect(delivered.draft).toBeNull()
    // a later change elsewhere shows, since nothing was typed since the save
    const later = draftReduce(accepted, { key: KEY, type: 'saved', value: 'Nora L.' }, PERSON_NAME)
    expect(draftText(later, PERSON_NAME)).toBe('Nora L.')
    expect(later.conflict).toBeNull()
  })

  it('rebases a draft the server refused over another change and names who made it', () => {
    // the store's paint showed the save, the refusal took it away, and the
    // value the server keeps shows in the same render
    const s = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Robotics' },
      { type: 'refused', seq: 1, value: 'Northstar Robotics', seen: 'Northstar', by: LEO },
      { type: 'saved', value: 'Northstar Labs' },
    )
    expect(shown(s)).toBe('Northstar Robotics')
    expect(s.conflict).toEqual({ value: 'Northstar Labs', by: LEO })
    expect(draftUnsaved(s, TRIMMED)).toBe(true)
    // the kept value can arrive later, or before the refusal
    const late = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar' },
      { type: 'refused', seq: 1, value: 'Northstar Robotics', seen: 'Northstar', by: LEO },
    )
    expect(late.conflict).toBeNull()
    expect(shown(late)).toBe('Northstar Robotics')
    const arrived = draftReduce(late, { key: KEY, type: 'saved', value: 'Northstar Labs' }, TRIMMED)
    expect(arrived.conflict).toEqual({ value: 'Northstar Labs', by: LEO })
    const first = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Labs' },
      { type: 'refused', seq: 1, value: 'Northstar Robotics', seen: 'Northstar', by: 'you' },
    )
    expect(first.conflict).toEqual({ value: 'Northstar Labs', by: 'you' })
  })

  it('keeps a draft refused for another reason unsaved against its base', () => {
    const s = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'send', seq: 1, value: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Robotics' },
      { type: 'refused', seq: 1, value: 'Northstar Robotics', seen: 'Northstar' },
      { type: 'saved', value: 'Northstar' },
    )
    expect(shown(s)).toBe('Northstar Robotics')
    expect(s.base).toBe('Northstar')
    expect(s.conflict).toBeNull()
    expect(draftUnsaved(s, TRIMMED)).toBe(true)
  })

  it('drops the draft for Use saved, and makes the saved value the base for Keep mine', () => {
    const conflict = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Robotics' },
      { type: 'saved', value: 'Northstar Labs' },
    )
    const used = draftReduce(conflict, { key: KEY, type: 'discard' }, TRIMMED)
    expect(shown(used)).toBe('Northstar Labs')
    expect(used.conflict).toBeNull()
    expect(draftUnsaved(used, TRIMMED)).toBe(false)
    const kept = draftReduce(conflict, { key: KEY, type: 'keepMine' }, TRIMMED)
    expect(shown(kept)).toBe('Northstar Robotics')
    expect(kept.base).toBe('Northstar Labs')
    expect(kept.conflict).toBeNull()
    expect(draftUnsaved(kept, TRIMMED)).toBe(true)
  })

  it('takes a saved value equal to the draft as the draft saved', () => {
    const s = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: 'Northstar Labs ' },
      { type: 'saved', value: 'Northstar Labs' },
    )
    expect(s.draft).toBeNull()
    expect(s.conflict).toBeNull()
  })

  it('starts untouched for another record, and ignores answers for the earlier one', () => {
    const s = run(TRIMMED, 'Northstar', { type: 'edit', text: 'Northstar Robotics' })
    const other = draftStart<string>('org-2:name', 'Acme')
    expect(shown(other)).toBe('Acme')
    expect(draftReduce(other, { key: KEY, type: 'edit', text: 'x' }, TRIMMED)).toBe(other)
    expect(
      draftReduce(
        other,
        { key: KEY, type: 'refused', seq: 1, value: 'x', seen: 'Northstar', by: LEO },
        TRIMMED,
      ),
    ).toBe(other)
    expect(s.draft).toBe('Northstar Robotics')
  })

  it('compares values as the store saves them', () => {
    expect(TRIMMED.same(' Northstar ', 'Northstar')).toBe(true)
    expect(TRIMMED.same('Northstar', 'northstar')).toBe(false)
    expect(PERSON_NAME.same('Nora   Lind ', 'Nora Lind')).toBe(true)
    expect(PERSON_NAME.same('Nora Lind', 'Nora Lindqvist')).toBe(false)
    expect(ADDRESS.same(' Northstar ', 'northstar')).toBe(true)
    expect(ADDRESS.same('northstar', 'northstar-labs')).toBe(false)
    expect(EMAIL.same('Anna@Bücher.de', 'anna@xn--bcher-kva.de')).toBe(true)
    expect(EMAIL.same('anna@bucher.de', 'anna@xn--bcher-kva.de')).toBe(false)
    const hours = wholeNumber<number | null>(40)
    expect(hours.text(null)).toBe('40')
    expect(hours.same('40', '40.0')).toBe(true)
    expect(hours.same(' 32', '32')).toBe(true)
    expect(hours.same('', '40')).toBe(false)
    expect(hours.same('32', '40')).toBe(false)
    // a draft of only spaces is no change, and a new value replaces it
    const spaces = run(
      TRIMMED,
      'Northstar',
      { type: 'edit', text: ' Northstar ' },
      { type: 'saved', value: 'Northstar Labs' },
    )
    expect(spaces.conflict).toBeNull()
    expect(shown(spaces)).toBe('Northstar Labs')
  })

  it('leaves the draft alone for an older save’s acknowledgement', () => {
    const s = run(
      PERSON_NAME,
      'Nora Lind',
      { type: 'edit', text: 'Nora L' },
      { type: 'send', seq: 1, value: 'Nora L' },
      { type: 'edit', text: 'Nora Lindqvist' },
      { type: 'send', seq: 2, value: 'Nora Lindqvist' },
      { type: 'saved', value: 'Nora L' },
    )
    expect(s.draft).toBe('Nora Lindqvist')
    expect(s.base).toBe('Nora Lind')
    expect(s.conflict).toBeNull()
    expect(s.sending).toEqual([{ seq: 2, value: 'Nora Lindqvist' }])
    // and a refusal of the older save leaves it to the newer one
    const refused = draftReduce(
      s,
      { key: KEY, type: 'refused', seq: 1, value: 'Nora L', seen: 'Nora Lind', by: LEO },
      PERSON_NAME,
    )
    expect(refused.draft).toBe('Nora Lindqvist')
    expect(refused.refusedBy).toBeUndefined()
  })

  it('leaves the draft alone for a change to another field', () => {
    const s = run(TRIMMED, 'Northstar', { type: 'edit', text: 'Northstar Robotics' })
    const other = draftReduce(s, { key: 'org-1:slug', type: 'saved', value: 'acme' }, TRIMMED)
    expect(other).toBe(s)
  })
})
