import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameBatch } from './frameBatch'

describe('frameBatch', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs once a frame however often it is asked, and again in a later frame', () => {
    const frames: (() => void)[] = []
    const run = vi.fn()
    const batch = frameBatch(run, (callback) => frames.push(callback))
    for (let i = 0; i < 1000; i++) batch.schedule()
    expect(frames).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()
    frames.shift()?.()
    expect(run).toHaveBeenCalledOnce()
    batch.schedule()
    batch.schedule()
    frames.shift()?.()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('drops a run cancelled before its frame', () => {
    const frames: (() => void)[] = []
    const run = vi.fn()
    const batch = frameBatch(run, (callback) => frames.push(callback))
    batch.schedule()
    batch.cancel()
    frames.shift()?.()
    expect(run).not.toHaveBeenCalled()
    batch.schedule()
    frames.shift()?.()
    expect(run).toHaveBeenCalledOnce()
  })

  it('uses requestAnimationFrame where the page has it, else a timer of a frame', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    frameBatch(run).schedule()
    vi.advanceTimersByTime(15)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledOnce()
    const raf = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', raf)
    frameBatch(run).schedule()
    expect(raf).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
