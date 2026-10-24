import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whenIdle } from './idle'

describe('whenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('waits for requestIdleCallback where the browser has it, and cancels it', () => {
    const steps: IdleRequestCallback[] = []
    const cancel = vi.fn()
    vi.stubGlobal('requestIdleCallback', (step: IdleRequestCallback, options?: object) => {
      steps.push(step)
      expect(options).toEqual({ timeout: 2000 })
      return 7
    })
    vi.stubGlobal('cancelIdleCallback', cancel)
    const step = vi.fn()
    const stop = whenIdle(step, { timeout: 2000 })
    vi.runAllTimers()
    expect(step).not.toHaveBeenCalled()
    expect(steps).toHaveLength(1)
    stop()
    expect(cancel).toHaveBeenCalledWith(7)
  })

  it('runs the step in a timer task with time of its own where it has not (Safari)', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    let left = -1
    whenIdle((deadline) => {
      left = deadline.timeRemaining()
    })
    vi.advanceTimersByTime(49)
    expect(left).toBe(-1)
    vi.advanceTimersByTime(1)
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThanOrEqual(10)
  })

  it('does not run a step cancelled before its timer', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    const step = vi.fn()
    whenIdle(step)()
    vi.runAllTimers()
    expect(step).not.toHaveBeenCalled()
  })
})
