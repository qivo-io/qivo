import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInlineImages, INLINE_IMAGES, type ObserverFactory } from './inlineImages'
import { createMintQueue, type MintCall, type MintOutcome } from './mintQueue'

const BOUNDS = structuredClone(INLINE_IMAGES)
const KIB = 1024

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type FakeObserver = {
  margin: string
  receive: Parameters<ObserverFactory>[0]
  elements: Set<Element>
}

/* A loader over stand-ins: a fake IntersectionObserver the test moves
   elements through, a mint per id (or through a real mint queue), and a
   fetch of images of `size` bytes each, answered at once unless `hold`. */
function harness(o: { size?: number; hold?: boolean; queue?: boolean; observer?: boolean } = {}) {
  let now = 1_000_000
  const observers: FakeObserver[] = []
  const factory: ObserverFactory = (receive, options) => {
    const obs: FakeObserver = { margin: String(options.rootMargin), receive, elements: new Set() }
    observers.push(obs)
    return {
      observe: (e: Element) => obs.elements.add(e),
      unobserve: (e: Element) => obs.elements.delete(e),
      disconnect: () => obs.elements.clear(),
    }
  }
  const calls: string[][] = []
  const mintCall: MintCall = async (_org, ids) => {
    calls.push(ids.attachment_ids ?? [])
    return {
      attachments: Object.fromEntries(
        (ids.attachment_ids ?? []).map((id) => [
          id,
          { url: `https://files.test/files/${id}`, exp: now / 1000 + 600 },
        ]),
      ),
      avatars: {},
    }
  }
  const queue = createMintQueue(mintCall, { refused: () => false })
  const held = new Set<string>()
  const mint = vi.fn(async (id: string, _fresh: boolean): Promise<MintOutcome> => {
    if (!held.has(id)) return { state: 'missing' }
    if (o.queue) return queue.request({ kind: 'attachment', id, org: 'org', key: `att:${id}` })
    return {
      state: 'lease',
      lease: { url: `https://files.test/files/${id}`, exp: now / 1000 + 600 },
    }
  })
  const downloads: { url: string; answer: ReturnType<typeof deferred<Response>> }[] = []
  let open = 0
  let most = 0
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const answer = deferred<Response>()
    downloads.push({ url: String(input), answer })
    open++
    most = Math.max(most, open)
    if (!o.hold) answer.resolve(image(o.size ?? 100 * KIB))
    try {
      return await answer.promise
    } finally {
      open--
    }
  })
  let serial = 0
  const revokeUrl = vi.fn()
  const loader = createInlineImages({
    held: (id) => held.has(id),
    mint,
    fetch: fetcher,
    createUrl: () => `blob:image-${++serial}`,
    revokeUrl,
    measure: async () => ({ width: 800, height: 600 }),
    observer: o.observer === false ? null : factory,
    rootOf: () => null,
    now: () => now,
  })
  /* Moves `element` near (true) or far (false), as the observers would. */
  const move = (element: Element, near: boolean) => {
    for (const obs of observers)
      if (obs.elements.has(element)) {
        const nearObserver = obs.margin.startsWith(`${INLINE_IMAGES.near * 100}%`)
        obs.receive([
          { target: element, isIntersecting: nearObserver ? near : near || nearObserver },
        ])
      }
  }
  /* One view of attachment `id`: watches reach and pins while near. */
  const view = (id: string) => {
    held.add(id)
    const element = { id } as unknown as Element
    let pinned = false
    // a view listens to what its attachment shows, as useInlineImage does
    const unwatch = loader.watch(id, () => {})
    const stop = loader.observe(element, (near) => {
      if (near && !pinned) {
        pinned = true
        loader.pin(id)
      } else if (!near && pinned) {
        pinned = false
        loader.unpin(id)
      }
    })
    return {
      element,
      near: () => move(element, true),
      far: () => move(element, false),
      unmount: () => {
        stop()
        if (pinned) loader.unpin(id)
        pinned = false
        unwatch()
      },
      shown: () => loader.snapshot(id),
    }
  }
  return {
    loader,
    mint,
    calls,
    fetcher,
    downloads,
    revokeUrl,
    held,
    view,
    most: () => most,
    open: () => open,
    time: (ms: number) => {
      now += ms
    },
  }
}

/* An answer of `bytes` image bytes. Not a real Response: Node reads a
   real one's body in a later event-loop turn, which fake timers hold. */
function image(bytes: number, status = 200) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' })
  return { ok: status < 300, status, blob: async () => blob } as unknown as Response
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('the inline image loader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.assign(INLINE_IMAGES, structuredClone(BOUNDS))
  })

  it('asks nothing for an image out of reach, and mints and downloads one that comes near', async () => {
    const h = harness()
    const v = h.view('a')
    await settle()
    expect(h.mint).not.toHaveBeenCalled()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(v.shown().state).toBe('waiting')
    v.near()
    await settle()
    expect(h.mint).toHaveBeenCalledOnce()
    expect(h.fetcher).toHaveBeenCalledWith('https://files.test/files/a', {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    })
    expect(v.shown()).toMatchObject({ state: 'ready', url: 'blob:image-1' })
    expect(v.shown().box).toEqual({ width: 800, height: 600 })
  })

  it('mints 100 near images in one call and downloads them four at a time', async () => {
    const h = harness({ queue: true, hold: true })
    const views = Array.from({ length: 100 }, (_, i) => h.view(`img-${i}`))
    for (const v of views) v.near()
    await settle()
    expect(h.calls.map((c) => c.length)).toEqual([100])
    expect(h.downloads).toHaveLength(4)
    while (h.downloads.some((d) => d.answer)) {
      const waiting = h.downloads.filter((d) => d.answer)
      if (!waiting.length) break
      for (const d of waiting) {
        d.answer.resolve(image(KIB))
        Object.assign(d, { answer: null })
      }
      await settle()
    }
    expect(h.downloads).toHaveLength(100)
    expect(h.most()).toBe(4)
    expect(views.every((v) => v.shown().state === 'ready')).toBe(true)
  })

  it('downloads an attachment two windows show once', async () => {
    const h = harness()
    const pane = h.view('shared')
    const popOut = h.view('shared')
    pane.near()
    popOut.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(pane.shown()).toBe(popOut.shown())
  })

  it('unpins a far image, which keeps its recorded box', async () => {
    const h = harness()
    const v = h.view('a')
    v.near()
    await settle()
    v.far()
    expect(h.loader.stats()).toMatchObject({ cachedBytes: 100 * KIB, pinnedBytes: 0 })
    expect(v.shown().box).toEqual({ width: 800, height: 600 })
  })

  it('evicts the least recently unpinned bytes past a lowered budget, never a pinned image', async () => {
    INLINE_IMAGES.cacheBytes = 250 * KIB
    const h = harness()
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => h.view(id))
    for (const v of [a, b, c, d]) v.near()
    await settle()
    // all four are near: 400 KiB held, none evicted
    expect(h.revokeUrl).not.toHaveBeenCalled()
    a.far()
    b.far()
    expect(h.revokeUrl).not.toHaveBeenCalled()
    c.far()
    // a, b and c are out of reach: 300 KiB, so a, the first unpinned, goes
    expect(h.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:image-1')
    expect(a.shown()).toMatchObject({ state: 'waiting', box: { width: 800, height: 600 } })
    expect(d.shown().state).toBe('ready')
    expect(h.loader.stats().cachedBytes).toBe(200 * KIB)
  })

  it('shows a remounted image within its lease from its bytes, with no mint or download', async () => {
    const h = harness()
    const first = h.view('a')
    first.near()
    await settle()
    first.unmount()
    const again = h.view('a')
    again.near()
    await settle()
    expect(h.mint).toHaveBeenCalledOnce()
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(again.shown()).toMatchObject({ state: 'ready', url: 'blob:image-1' })
  })

  it('mints again before it shows held bytes past their lease, and downloads nothing', async () => {
    const h = harness()
    const first = h.view('a')
    first.near()
    await settle()
    first.unmount()
    h.time(9 * 60_000)
    const again = h.view('a')
    again.near()
    // not shown before the mint answers
    expect(again.shown().state).toBe('renewing')
    await settle()
    expect(h.mint).toHaveBeenCalledTimes(2)
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(again.shown()).toMatchObject({ state: 'ready', url: 'blob:image-1' })
  })

  it('marks an image gone and drops its bytes when a mint omits it', async () => {
    const h = harness()
    const v = h.view('a')
    v.near()
    await settle()
    v.unmount()
    h.time(9 * 60_000)
    h.held.delete('a')
    h.mint.mockResolvedValueOnce({ state: 'missing' })
    const again = h.view('a')
    h.held.add('a')
    again.near()
    await settle()
    expect(again.shown().state).toBe('gone')
    expect(h.revokeUrl).toHaveBeenCalledWith('blob:image-1')
  })

  it('never shows held bytes again once the store’s row gate fails, within the lease too', async () => {
    const h = harness()
    const v = h.view('a')
    v.near()
    await settle()
    v.unmount()
    h.held.delete('a')
    const element = { id: 'again' } as unknown as Element
    h.loader.observe(element, () => {})
    h.loader.pin('a')
    expect(h.loader.snapshot('a').state).toBe('gone')
    expect(h.revokeUrl).toHaveBeenCalledWith('blob:image-1')
    expect(h.mint).toHaveBeenCalledOnce()
  })

  it('drops bytes the store forgot, and an image out of reach whose row went', async () => {
    const h = harness()
    const a = h.view('a')
    const b = h.view('b')
    a.near()
    b.near()
    await settle()
    b.far()
    h.held.delete('b')
    h.loader.retain((id) => h.held.has(id))
    expect(h.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:image-2')
    // a removal of a shown one: it asks the gate again and is gone
    h.held.delete('a')
    h.loader.drop('a')
    expect(a.shown().state).toBe('gone')
    expect(h.revokeUrl).toHaveBeenCalledWith('blob:image-1')
  })

  it('takes one fresh mint after a gateway 404, then shows it as gone', async () => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(image(0, 404))
    const v = h.view('a')
    v.near()
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true])
    expect(v.shown().state).toBe('ready')
    h.fetcher.mockResolvedValue(image(0, 404))
    h.loader.drop('a')
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true, false, true])
    expect(v.shown().state).toBe('gone')
  })

  it('takes a fresh mint again for a refusal after a download succeeded since the last one', async () => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(image(0, 404))
    const v = h.view('a')
    v.near()
    await settle()
    expect(v.shown().state).toBe('ready')
    // evicted out of reach, so coming near again downloads again
    INLINE_IMAGES.cacheBytes = 0
    v.far()
    expect(h.loader.stats().cachedBytes).toBe(0)
    h.fetcher.mockResolvedValueOnce(image(0, 404))
    v.near()
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true, false, true])
    expect(v.shown().state).toBe('ready')
  })

  it('tries a plain-URL fallback that fails again later, a network failure and no refusal, and never marks it gone', async () => {
    const h = harness()
    h.fetcher.mockRejectedValue(new TypeError('Failed to fetch'))
    const v = h.view('a')
    v.near()
    await settle()
    expect(v.shown()).toMatchObject({ state: 'ready', url: 'https://files.test/files/a' })
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.loader.loaded('a', null)
      expect(v.shown()).toMatchObject({ state: 'waiting', url: null })
      await vi.advanceTimersByTimeAsync(INLINE_IMAGES.retry)
      expect(h.fetcher).toHaveBeenCalledTimes(attempt + 1)
      expect(v.shown()).toMatchObject({ state: 'ready', url: 'https://files.test/files/a' })
    }
    // no fresh mint: nothing refused the lease
    expect(h.mint.mock.calls.every(([, fresh]) => !fresh)).toBe(true)
  })

  it('asks again for a near image the row gate marked gone once its rows come back', async () => {
    const h = harness()
    const v = h.view('a')
    v.near()
    await settle()
    // the task leaves the workspace while its window shows the image
    h.held.delete('a')
    h.loader.drop('a')
    expect(v.shown().state).toBe('gone')
    h.loader.retain((id) => h.held.has(id))
    expect(v.shown().state).toBe('gone')
    // and comes back with a later delivery
    h.held.add('a')
    h.loader.retain((id) => h.held.has(id))
    await settle()
    expect(v.shown()).toMatchObject({ state: 'ready' })
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    // one the server refused stays gone on a rebuild
    h.mint.mockResolvedValueOnce({ state: 'missing' })
    h.loader.drop('a')
    await settle()
    expect(v.shown().state).toBe('gone')
    h.loader.retain((id) => h.held.has(id))
    await settle()
    expect(v.shown().state).toBe('gone')
  })

  it('takes the fresh mint a refusal asks for when the image comes near again after it went far or the page hid', async () => {
    const h = harness({ hold: true })
    const v = h.view('a')
    v.near()
    await settle()
    v.far()
    h.downloads[0]?.answer.resolve(image(0, 404))
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false])
    v.near()
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true])
    // the same while the page is hidden
    h.downloads[1]?.answer.resolve(image(KIB))
    await settle()
    INLINE_IMAGES.cacheBytes = 0
    v.far()
    v.near()
    await settle()
    h.loader.pause(true)
    h.downloads[2]?.answer.resolve(image(0, 404))
    await settle()
    expect(h.mint).toHaveBeenCalledTimes(3)
    h.loader.pause(false)
    await settle()
    expect(h.mint.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true, false, true])
  })

  it('keeps "Loading image…" and tries again after a failed mint', async () => {
    const h = harness()
    h.mint.mockResolvedValueOnce({ state: 'failed' })
    const v = h.view('a')
    v.near()
    await settle()
    expect(v.shown().state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.retry)
    expect(v.shown().state).toBe('ready')
  })

  it('falls back to the minted URL when fetch cannot read it, holding its slot until the view reports', async () => {
    INLINE_IMAGES.downloads = 1
    const h = harness()
    h.fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const a = h.view('a')
    const b = h.view('b')
    a.near()
    b.near()
    await settle()
    expect(a.shown()).toMatchObject({ state: 'ready', url: 'https://files.test/files/a' })
    expect(h.fetcher).toHaveBeenCalledOnce()
    h.loader.loaded('a', { width: 10, height: 10 })
    await settle()
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(b.shown().state).toBe('ready')
  })

  it('gives a plain-URL fallback’s slot back after 30 s with no report, and keeps showing it', async () => {
    INLINE_IMAGES.downloads = 1
    const h = harness()
    h.fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const a = h.view('a')
    const b = h.view('b')
    a.near()
    b.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.stall)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(a.shown()).toMatchObject({ state: 'ready', url: 'https://files.test/files/a' })
    // its late report gives nothing back twice
    h.loader.loaded('a', { width: 10, height: 10 })
    expect(h.loader.stats().downloading).toBe(0)
  })

  it('frees the slot of a download that fetch cannot read once nothing shows it', async () => {
    INLINE_IMAGES.downloads = 1
    const h = harness({ hold: true })
    const a = h.view('a')
    a.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    // the window closes while the download runs, and then it fails
    a.unmount()
    h.downloads[0]?.answer.reject(new TypeError('Failed to fetch'))
    await settle()
    const b = h.view('b')
    b.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(h.loader.stats().downloading).toBe(1)
    // the next view of the first asks again
    const back = h.view('a')
    back.near()
    await settle()
    expect(h.mint.mock.calls.filter(([id]) => id === 'a')).toHaveLength(2)
  })

  it('gives the slot of a download that receives nothing for 30 s back, and tries it again later', async () => {
    INLINE_IMAGES.downloads = 1
    const h = harness({ hold: true })
    const a = h.view('a')
    const b = h.view('b')
    a.near()
    b.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.stall - 1)
    expect(h.fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    // the stalled one aborted and its slot went to b
    expect(h.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(a.shown().state).toBe('waiting')
    expect(h.loader.stats().downloading).toBe(1)
    // its late answer is fenced and gives no slot back twice
    h.downloads[0]?.answer.resolve(image(KIB))
    h.downloads[1]?.answer.resolve(image(KIB))
    await settle()
    expect(a.shown().state).toBe('waiting')
    expect(b.shown().state).toBe('ready')
    expect(h.loader.stats().downloading).toBe(0)
    // a tries again while near
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.retry)
    expect(h.fetcher).toHaveBeenCalledTimes(3)
    h.downloads[2]?.answer.resolve(image(KIB))
    await settle()
    expect(a.shown().state).toBe('ready')
  })

  it('never stops a download that keeps receiving bytes, however long it takes', async () => {
    const h = harness({ hold: true })
    const a = h.view('a')
    a.near()
    await settle()
    // a slow link: a part every 20 s, the whole taking a minute
    let sent = 0
    const body = {
      getReader: () => ({
        read: async () => {
          if (sent === 3) return { done: true, value: undefined }
          await new Promise((r) => setTimeout(r, 20_000))
          sent++
          return { done: false, value: new Uint8Array(KIB) }
        },
      }),
    }
    h.downloads[0]?.answer.resolve({
      ok: true,
      status: 200,
      body,
      headers: new Headers({ 'content-type': 'image/png' }),
    } as unknown as Response)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(a.shown()).toMatchObject({ state: 'ready', url: 'blob:image-1' })
    expect(h.loader.stats().pinnedBytes).toBe(3 * KIB)
  })

  it('stops a download whose views all went far after a short grace, and gives its slot to a near image', async () => {
    INLINE_IMAGES.downloads = 1
    const h = harness({ hold: true })
    const a = h.view('a')
    a.near()
    await settle()
    a.far()
    const b = h.view('b')
    b.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    // a quick scroll back within the grace keeps it
    a.near()
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.leave)
    expect(h.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    a.far()
    await vi.advanceTimersByTimeAsync(INLINE_IMAGES.leave)
    expect(h.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(h.fetcher.mock.calls[1]?.[0]).toBe('https://files.test/files/b')
    // the late answer of the stopped one is fenced
    h.downloads[0]?.answer.resolve(image(KIB))
    await settle()
    expect(a.shown().state).toBe('waiting')
    expect(h.loader.stats()).toMatchObject({ downloading: 1, cachedBytes: 0 })
  })

  it('treats every image as near without IntersectionObserver', async () => {
    const h = harness({ observer: false })
    const v = h.view('a')
    await settle()
    expect(v.shown().state).toBe('ready')
  })

  it('starts no mint or download while the page is hidden, and resumes on return', async () => {
    const h = harness({ hold: true })
    const a = h.view('a')
    a.near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledOnce()
    h.loader.pause(true)
    const b = h.view('b')
    b.near()
    await settle()
    expect(h.mint).toHaveBeenCalledOnce()
    // the running download finishes
    h.downloads[0]?.answer.resolve(image(KIB))
    await settle()
    expect(a.shown().state).toBe('ready')
    h.loader.pause(false)
    await settle()
    expect(h.mint).toHaveBeenCalledTimes(2)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })

  it('lends external images their own slots, given back on load, error or the time-out', async () => {
    INLINE_IMAGES.external = 2
    const h = harness()
    const started: number[] = []
    const gives = [0, 1, 2].map((i) => h.loader.external(() => started.push(i)))
    expect(started).toEqual([0, 1])
    gives[0]?.()
    expect(started).toEqual([0, 1, 2])
    // a waiting one that leaves gives nothing back twice
    gives[0]?.()
    expect(h.loader.stats().externalLoading).toBe(2)
    h.loader.pause(true)
    gives[1]?.()
    const late: number[] = []
    h.loader.external(() => late.push(3))
    expect(late).toEqual([])
    h.loader.pause(false)
    expect(late).toEqual([3])
  })

  it('names the attachment a blob URL it made shows, for a pasted copy, and nothing for another', async () => {
    const h = harness()
    const v = h.view('pasted')
    v.near()
    await settle()
    expect(h.loader.attachmentOf('blob:image-1')).toBe('pasted')
    expect(h.loader.attachmentOf('blob:elsewhere')).toBeNull()
    h.loader.clear()
    expect(h.loader.attachmentOf('blob:image-1')).toBeNull()
  })

  it('revokes every blob URL when the store clears', async () => {
    const h = harness()
    const [a, b] = ['a', 'b'].map((id) => h.view(id))
    a.near()
    b.near()
    await settle()
    b.far()
    h.loader.clear()
    expect(h.revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual([
      'blob:image-1',
      'blob:image-2',
    ])
    expect(h.loader.stats()).toMatchObject({ cachedBytes: 0, downloading: 0 })
    expect(a.shown().state).toBe('waiting')
  })

  it('keeps its four slots after a clear that downloads on their way outlive', async () => {
    const h = harness({ hold: true })
    for (const id of ['a', 'b', 'c', 'd']) h.view(id).near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledTimes(4)
    h.loader.clear()
    // the old downloads end after the clear, which let their slots go
    for (const d of h.downloads) d.answer.resolve(image(KIB))
    await settle()
    for (const id of ['e', 'f', 'g', 'h', 'i', 'j']) h.view(id).near()
    await settle()
    expect(h.fetcher).toHaveBeenCalledTimes(8)
    expect(h.loader.stats().downloading).toBe(4)
  })
})
