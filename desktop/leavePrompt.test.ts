import { describe, expect, it, vi } from 'vitest'
import { createLeavePrompt, LEAVE_PROMPT } from './leavePrompt'

describe('desktop leave prompt', () => {
  it('leaves only when the person chooses Leave', () => {
    const onStay = vi.fn()
    let choice = 0
    const ask = vi.fn(() => choice)
    const handle = createLeavePrompt({ ask, onStay })

    const leave = { preventDefault: vi.fn() }
    handle(leave)
    expect(ask).toHaveBeenCalledWith(LEAVE_PROMPT)
    expect(leave.preventDefault).toHaveBeenCalled()
    expect(onStay).not.toHaveBeenCalled()

    choice = 1
    const stay = { preventDefault: vi.fn() }
    handle(stay)
    expect(stay.preventDefault).not.toHaveBeenCalled()
    expect(onStay).toHaveBeenCalled()
  })
})
