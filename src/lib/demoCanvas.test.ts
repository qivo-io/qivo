import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEMO_CANVAS_FEED_URL,
  DEMO_CANVAS_REFRESH_MS,
  DEMO_CANVAS_TIMEOUT_MS,
  demoCanvasFeedUrl,
  watchDemoCanvas,
} from './demoCanvas'

const picture = {
  id: 'public-landscape',
  image_url: 'https://regular.convex.cloud/api/storage/original',
  preview_url: 'https://regular.convex.cloud/api/storage/preview',
  title: 'A calm lake',
  location: 'Norway',
  creator: 'Example photographer',
  filename: 'lake.jpg',
  attribution: 'Example photographer / Example library',
  source_url: 'https://example.test/lake',
  license: 'CC BY 4.0',
  license_url: 'https://example.test/license',
}
const date = '2026-09-14'
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_DEMO_CANVAS_FEED_URL', '')
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('public demo Canvas endpoint', () => {
  it('uses the regular public feed by default and accepts explicit HTTPS or local development feeds', () => {
    expect(demoCanvasFeedUrl()).toBe(DEMO_CANVAS_FEED_URL)
    expect(demoCanvasFeedUrl('https://regular-dev.convex.site/public/canvas', false)).toBe(
      'https://regular-dev.convex.site/public/canvas',
    )
    for (const origin of ['http://localhost:3211', 'http://127.0.0.1:3211', 'http://[::1]:3211'])
      expect(demoCanvasFeedUrl(`${origin}/public/canvas`, true)).toBe(`${origin}/public/canvas`)
  })

  it('rejects credentials, URL state, unsafe schemes and non-development HTTP destinations', () => {
    for (const url of [
      'https://user:secret@example.test/public/canvas',
      'https://example.test/public/canvas?date=2020-01-01',
      'https://example.test/public/canvas#state',
      'http://example.test/public/canvas',
      'http://localhost.evil.test/public/canvas',
      'javascript:alert(1)',
      '/public/canvas',
    ])
      expect(() => demoCanvasFeedUrl(url, true), url).toThrow()
    expect(() => demoCanvasFeedUrl('http://localhost:3211/public/canvas', false)).toThrow()
  })
})

describe('public demo Canvas lifetime', () => {
  it('omits credentials, preserves metadata and keeps its supplied date across same-week polls', async () => {
    vi.setSystemTime(new Date('2026-09-14T23:59:59Z'))
    const fetchFeed = vi.fn().mockImplementation(async () => response(picture))
    vi.stubGlobal('fetch', fetchFeed)
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFeed).toHaveBeenCalledWith(`${DEMO_CANVAS_FEED_URL}?date=${date}`, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    })
    expect(receive).toHaveBeenLastCalledWith(picture)
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_REFRESH_MS)
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-15')
    expect(fetchFeed).toHaveBeenCalledTimes(2)
    expect(fetchFeed.mock.calls[1][0]).toBe(`${DEMO_CANVAS_FEED_URL}?date=${date}`)
    stop()
  })

  it('removes a withdrawn image at the next poll and refreshes metadata on visible focus', async () => {
    const revised = { ...picture, title: 'A changed public selection' }
    const fetchFeed = vi
      .fn()
      .mockResolvedValueOnce(response(picture))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(revised))
    vi.stubGlobal('fetch', fetchFeed)
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_REFRESH_MS)
    expect(receive).toHaveBeenLastCalledWith(null)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenLastCalledWith(revised)
    stop()
  })

  it('does not overlap requests and ignores focus while the document is hidden', async () => {
    const request = deferred<Response>()
    const fetchFeed = vi.fn().mockReturnValue(request.promise)
    vi.stubGlobal('fetch', fetchFeed)
    const stop = watchDemoCanvas(date, vi.fn())
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchFeed).toHaveBeenCalledTimes(1)
    request.resolve(response(picture))
    await vi.advanceTimersByTimeAsync(0)
    Object.assign(document, { visibilityState: 'hidden' })
    window.dispatchEvent(new Event('focus'))
    expect(fetchFeed).toHaveBeenCalledTimes(1)
    Object.assign(document, { visibilityState: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchFeed).toHaveBeenCalledTimes(2)
    stop()
  })

  it('bounds a stalled fetch, aborts it and prevents its late reply replacing a newer selection', async () => {
    const old = deferred<Response>()
    const latest = { ...picture, id: 'new-selection', title: 'New selection' }
    const fetchFeed = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(latest))
    vi.stubGlobal('fetch', fetchFeed)
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    const signal = fetchFeed.mock.calls[0][1].signal as AbortSignal
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_TIMEOUT_MS)
    expect(signal.aborted).toBe(true)
    expect(receive).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_REFRESH_MS - DEMO_CANVAS_TIMEOUT_MS)
    expect(receive).toHaveBeenLastCalledWith(latest)
    old.resolve(response(picture))
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledTimes(2)
    stop()
  })

  it('also bounds a response body that never finishes', async () => {
    const body = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }))
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_TIMEOUT_MS)
    expect(receive).toHaveBeenCalledExactlyOnceWith(null)
    body.resolve(picture)
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledTimes(1)
    stop()
  })

  it('aborts on disposal and cannot publish or restart after switching away from the daily source', async () => {
    const request = deferred<Response>()
    const fetchFeed = vi.fn().mockReturnValue(request.promise)
    vi.stubGlobal('fetch', fetchFeed)
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    const signal = fetchFeed.mock.calls[0][1].signal as AbortSignal
    stop()
    expect(signal.aborted).toBe(true)
    request.resolve(response(picture))
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(DEMO_CANVAS_REFRESH_MS * 2)
    expect(fetchFeed).toHaveBeenCalledTimes(1)
    expect(receive).not.toHaveBeenCalled()
  })

  it.each([
    ['a refused response', () => new Response('', { status: 503 })],
    ['invalid JSON', () => new Response('not JSON')],
    ['missing image metadata', () => response({ image_url: picture.image_url })],
    ['an executable image URL', () => response({ ...picture, image_url: 'javascript:alert(1)' })],
    [
      'a credential-bearing image URL',
      () => response({ ...picture, preview_url: 'https://user:secret@example.test/image' }),
    ],
  ])('clears the daily selection after %s', async (_label, answer) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer()))
    const receive = vi.fn()
    const stop = watchDemoCanvas(date, receive)
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledExactlyOnceWith(null)
    stop()
  })

  it('settles immediately without fetching when configuration or the supplied date is invalid', () => {
    const fetchFeed = vi.fn()
    vi.stubGlobal('fetch', fetchFeed)
    vi.stubEnv('VITE_DEMO_CANVAS_FEED_URL', 'https://example.test/public/canvas?token=secret')
    const receive = vi.fn()
    watchDemoCanvas(date, receive)()
    expect(receive).toHaveBeenCalledExactlyOnceWith(null)
    vi.stubEnv('VITE_DEMO_CANVAS_FEED_URL', '')
    watchDemoCanvas('2026-02-30', receive)()
    expect(receive).toHaveBeenCalledTimes(2)
    expect(fetchFeed).not.toHaveBeenCalled()
  })
})
