import { describe, expect, it } from 'vitest'
import { TOASTS_SHOWN, type Toast, toastLook, withToast } from './toasts'

describe('toastLook', () => {
  it('shows a toast without a tone as a success', () => {
    expect(toastLook()).toEqual({ icon: 'check', color: 'var(--success)', politeness: 'polite' })
  })

  it('marks errors with the alert icon in the danger colour and interrupts', () => {
    expect(toastLook('error')).toEqual({
      icon: 'alert',
      color: 'var(--danger)',
      politeness: 'assertive',
    })
  })

  it('shows notices with the info icon in the neutral colour', () => {
    expect(toastLook('info')).toEqual({
      icon: 'info',
      color: 'var(--text-2)',
      politeness: 'polite',
    })
  })
})

describe('withToast', () => {
  const plain = (id: number): Toast => ({ id, text: `toast ${id}` })

  it('keeps three toasts, the newest ones', () => {
    let list: Toast[] = []
    for (const id of [1, 2, 3, 4]) list = withToast(list, plain(id))
    expect(list.map((t) => t.id)).toEqual([2, 3, 4])
  })

  it('keeps a sticky notice through three later toasts', () => {
    let list = withToast([], { id: 1, text: 'Not saved.', sticky: true, key: 'k' })
    for (const id of [2, 3, 4]) list = withToast(list, plain(id))
    expect(list.map((t) => t.id)).toEqual([1, 3, 4])
  })

  it('replaces the text of a notice shown again with its key, in place', () => {
    let list = withToast([], { id: 1, text: 'one line', sticky: true, key: 'k' })
    list = withToast(list, plain(2))
    list = withToast(list, { id: 3, text: 'two lines', sticky: true, key: 'k' })
    expect(list.map((t) => [t.id, t.text])).toEqual([
      [1, 'two lines'],
      [2, 'toast 2'],
    ])
  })

  it('lets successes and notices give way before an error', () => {
    let list = withToast([], { id: 1, text: 'Not saved.', tone: 'error' })
    for (const id of [2, 3]) list = withToast(list, plain(id))
    list = withToast(list, { id: 4, text: 'Moved.', tone: 'info' })
    expect(list.map((t) => t.id)).toEqual([1, 3, 4])
  })

  it('moves the oldest error into the next one when only errors can give way', () => {
    const error = (id: number): Toast => ({ id, text: `error ${id}`, tone: 'error' })
    let list: Toast[] = []
    for (const id of [1, 2, 3, 4]) list = withToast(list, error(id))
    expect(list.map((t) => [t.id, t.text])).toEqual([
      [2, 'error 1\nerror 2'],
      [3, 'error 3'],
      [4, 'error 4'],
    ])
    // two sticky notices leave room for the new toast alone: an error moves
    // into a new error, and stays beside a new success
    const sticky = (id: number): Toast => ({ id, text: `notice ${id}`, sticky: true })
    list = withToast(withToast([sticky(1), sticky(2)], error(3)), error(4))
    expect(list.map((t) => [t.id, t.text])).toEqual([
      [1, 'notice 1'],
      [2, 'notice 2'],
      [4, 'error 3\nerror 4'],
    ])
    list = withToast(list, plain(5))
    expect(list.map((t) => t.id)).toEqual([1, 2, 4, 5])
  })

  it('keeps a stream of errors to its newest lines, once each, and counts the rest', () => {
    let list: Toast[] = []
    for (let id = 1; id <= 20; id++)
      list = withToast(list, { id, text: id % 2 ? 'Not saved.' : `error ${id}`, tone: 'error' })
    const texts = list.map((t) => t.text)
    expect(texts).toHaveLength(TOASTS_SHOWN)
    for (const text of texts) expect(text.split('\n').length).toBeLessThanOrEqual(4)
    // the oldest toast now says how many earlier problems it folds away
    expect(texts[0]).toMatch(/^\d+ earlier problems not listed\./)
    expect(texts[0].split('\n').filter((line) => line === 'Not saved.')).toHaveLength(1)
  })
})
