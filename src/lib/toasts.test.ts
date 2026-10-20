import { describe, expect, it } from 'vitest'
import { type Toast, toastLook, withToast } from './toasts'

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
})
