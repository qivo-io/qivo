import { describe, expect, it } from 'vitest'
import { toastLook } from './toasts'

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
