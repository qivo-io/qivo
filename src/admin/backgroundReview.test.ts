import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBackgroundReviewQueue } from './backgroundReview'

afterEach(() => vi.useRealTimers())

function pendingRead() {
  let receive: (value: string) => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  const unsubscribe = vi.fn()
  const result = readBackgroundReviewQueue<string>((onResult, onError) => {
    receive = onResult
    fail = onError
    return unsubscribe
  })
  return { result, receive, fail, unsubscribe }
}

describe('post-approval image queue read', () => {
  it('unsubscribes and removes the timeout after the first result', async () => {
    vi.useFakeTimers()
    const read = pendingRead()
    read.receive('next image')
    read.receive('later update')
    await expect(read.result).resolves.toBe('next image')
    expect(read.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unsubscribes and preserves a read failure so the dialog can offer retry', async () => {
    vi.useFakeTimers()
    const read = pendingRead()
    const error = new Error('image queue unavailable')
    read.fail(error)
    await expect(read.result).rejects.toBe(error)
    expect(read.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out after ten seconds and ignores late results while a fresh retry succeeds', async () => {
    vi.useFakeTimers()
    const read = pendingRead()
    const failure = expect(read.result).rejects.toThrow(/timed out.*connection/)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(read.unsubscribe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expect(read.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    const retry = pendingRead()
    read.receive('late image')
    read.fail(new Error('late failure'))
    retry.receive('retry image')
    await expect(retry.result).resolves.toBe('retry image')
    expect(read.unsubscribe).toHaveBeenCalledTimes(1)
    expect(retry.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unsubscribes when a cached result arrives before subscription setup returns', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const result = readBackgroundReviewQueue<string>((receive) => {
      receive('cached image')
      return unsubscribe
    })
    await expect(result).resolves.toBe('cached image')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timeout when subscription setup throws', async () => {
    vi.useFakeTimers()
    const result = readBackgroundReviewQueue(() => {
      throw new Error('client closed')
    })
    await expect(result).rejects.toThrow('client closed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
