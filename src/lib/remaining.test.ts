import { describe, expect, it } from 'vitest'
import {
  remainingCreate,
  remainingPatch,
  remainingPatchFromInput,
  remainingValue,
} from './remaining'

describe('remainingPatch — emptiness, not falsiness', () => {
  it('writes a typed number over an unset field', () => {
    expect(remainingPatch('8', undefined)).toEqual({ write: true, value: 8 })
  })

  it('clears the field when the box is emptied', () => {
    expect(remainingPatch('', 8)).toEqual({ write: true, value: null })
    expect(remainingPatch('   ', 8)).toEqual({ write: true, value: null })
  })

  // the falsy-zero bug: "0" must be a value, not a clear
  it('treats "0" as the number 0, not as unset', () => {
    expect(remainingPatch('0', undefined)).toEqual({ write: true, value: 0 })
    expect(remainingPatch('0', null)).toEqual({ write: true, value: 0 })
  })

  it('leaves a stored 0 alone on a bare focus/blur', () => {
    // the box shows "0", the user tabs through without typing
    expect(remainingPatch('0', 0)).toEqual({ write: false, value: 0 })
  })

  it('clears a stored 0 only when the box is actually emptied', () => {
    expect(remainingPatch('', 0)).toEqual({ write: true, value: null })
  })

  it('does not write when the value is unchanged', () => {
    expect(remainingPatch('8', 8).write).toBe(false)
    expect(remainingPatch('8.5', 8.5).write).toBe(false)
    expect(remainingPatch('', undefined).write).toBe(false)
    expect(remainingPatch('', null).write).toBe(false)
  })

  it('ignores leading/trailing space around a real number', () => {
    expect(remainingPatch(' 12 ', 8)).toEqual({ write: true, value: 12 })
    expect(remainingPatch(' 8 ', 8).write).toBe(false)
  })

  it('keeps fractional hours (the column is numeric(6,1))', () => {
    expect(remainingPatch('2.5', undefined)).toEqual({ write: true, value: 2.5 })
  })

  it('writes nothing for unparseable text', () => {
    // a number input can still hand back garbage; NaN must never reach the store
    for (const bad of ['abc', '--', 'e', '1e', '1.2.3']) {
      expect(remainingPatch(bad, 8)).toEqual({ write: false, value: null })
    }
  })

  it('handles a missing raw value as empty', () => {
    expect(remainingPatch(null, 8)).toEqual({ write: true, value: null })
    expect(remainingPatch(undefined, undefined).write).toBe(false)
  })

  // negatives are rejected by the DB check constraint, so the client lets the
  // write go and surfaces the rollback rather than silently swallowing it
  it('passes a negative through for the server to reject', () => {
    expect(remainingPatch('-3', 8)).toEqual({ write: true, value: -3 })
  })
})

describe('remainingPatchFromInput — the element knows what the value cannot say', () => {
  // <input type="number"> sanitizes text it can't parse to "", so the raw
  // value alone makes "user pasted 8h" look exactly like "user emptied the
  // box" — and clearing a real estimate is the destructive outcome
  const el = (value: string, badInput = false) => ({ value, validity: { badInput } })

  it('does not clear a stored value when the text was unparseable', () => {
    expect(remainingPatchFromInput(el('', true), 8)).toEqual({ write: false, value: null })
  })

  it('still treats a genuinely emptied box as a clear', () => {
    expect(remainingPatchFromInput(el('', false), 8)).toEqual({ write: true, value: null })
  })

  it('writes a parsed value as usual', () => {
    expect(remainingPatchFromInput(el('12'), 8)).toEqual({ write: true, value: 12 })
    expect(remainingPatchFromInput(el('0'), 0).write).toBe(false)
  })

  it('survives an element without a validity object', () => {
    expect(remainingPatchFromInput({ value: '5' }, 8)).toEqual({ write: true, value: 5 })
  })
})

describe('remainingCreate — the create path wants undefined, not null', () => {
  it('is undefined for an empty box', () => {
    expect(remainingCreate('')).toBeUndefined()
    expect(remainingCreate('  ')).toBeUndefined()
    expect(remainingCreate(undefined)).toBeUndefined()
  })

  it('keeps a typed 0 (the falsy-zero trap on the create path)', () => {
    expect(remainingCreate('0')).toBe(0)
  })

  it('keeps a typed number', () => {
    expect(remainingCreate('8')).toBe(8)
    expect(remainingCreate('2.5')).toBe(2.5)
  })
})

describe('remainingValue — what the input displays', () => {
  it('shows an empty box for an unset field', () => {
    expect(remainingValue(undefined)).toBe('')
    expect(remainingValue(null)).toBe('')
  })

  it('shows a stored 0 as "0", not as the unset placeholder', () => {
    expect(remainingValue(0)).toBe(0)
  })

  it('shows a stored number', () => {
    expect(remainingValue(8)).toBe(8)
    expect(remainingValue(2.5)).toBe(2.5)
  })
})
