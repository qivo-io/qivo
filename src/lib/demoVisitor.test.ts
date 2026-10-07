import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoVisitorContext } from './demoVisitor'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('optional demo visitor context', () => {
  it('uses a same-origin uncached request without credentials', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ context: 'signed-context' })))
    vi.stubGlobal('fetch', fetcher)
    expect(await demoVisitorContext(new AbortController().signal)).toBe('signed-context')
    expect(fetcher).toHaveBeenCalledWith('/api/demo-visitor', {
      cache: 'no-store',
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    })
  })

  it('continues without metadata on unavailable or malformed responses', async () => {
    for (const response of [
      new Response('not JSON'),
      new Response('{}'),
      new Response(JSON.stringify({ context: 'a'.repeat(129) })),
      new Response('unavailable', { status: 503 }),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response),
      )
      expect(await demoVisitorContext(new AbortController().signal)).toBeNull()
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )
    expect(await demoVisitorContext(new AbortController().signal)).toBeNull()
  })

  it('limits delay even when the network ignores cancellation', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetcher)
    const result = demoVisitorContext(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1800)
    expect(await result).toBeNull()
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
      true,
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends immediately with startup cancellation and never fetches for already-cancelled startup', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetcher)
    const startup = new AbortController()
    const result = demoVisitorContext(startup.signal)
    startup.abort(new Error('demo expired'))
    expect(await result).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await expect(demoVisitorContext(startup.signal)).rejects.toThrow('demo expired')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
