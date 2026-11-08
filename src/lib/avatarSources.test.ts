import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvatarImageCache } from './avatarImageCache'
import { AVATAR_SOURCES, createAvatarSources } from './avatarSources'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const KEY = 'avatar:person:version-one'
const LEASE = { url: 'https://files.test/portrait?token=first', exp: 600 }

function persistentFixture(blob: Blob | null = new Blob(['cached face'], { type: 'image/webp' })) {
  const blobs = new Map(blob ? [[KEY, blob]] : [])
  const cache: AvatarImageCache = {
    read: vi.fn(async (key: string) => blobs.get(key) ?? null),
    sync: vi.fn(),
    put: vi.fn((key: string, value: Blob) => blobs.set(key, value)),
    remove: vi.fn((key: string) => blobs.delete(key)),
    clear: vi.fn(async () => blobs.clear()),
    dispose: vi.fn(),
    settled: vi.fn(async () => undefined),
  }
  return { cache, blobs }
}

function fixture(
  overrides: { shrink?: (blob: Blob) => Promise<Blob>; changed?: () => void } = {},
  // whether each sync names the keys it knows, as a page that shows every
  // known picture does; the cases of the named pictures name their own
  nameKnown = true,
) {
  let now = 0
  let serial = 0
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(new Blob(['face'])))
  const decode = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue(undefined)
  const revokeUrl = vi.fn()
  const createUrl = vi.fn(() => `blob:portrait-${++serial}`)
  const cache = createAvatarSources({
    now: () => now,
    fetch: fetcher,
    decode,
    createUrl,
    revokeUrl,
    ...overrides,
  })
  // these cases show every known picture on an open page: each sync names
  // the keys it knows, as the store names the people its views show
  const sync = cache.sync
  cache.sync = (keys, without) => {
    const all = [...keys]
    sync(all, without)
    if (nameKnown) cache.named(all)
  }
  cache.sync([KEY])
  return {
    cache,
    fetcher,
    decode,
    createUrl,
    revokeUrl,
    time: (value: number) => {
      now = value
    },
  }
}

describe('prepared profile pictures', () => {
  it('publishes only after decode and shares one ready source across consumers and renewed leases', async () => {
    const f = fixture()
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
    expect(f.cache.url(KEY)).toBeNull()
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(f.fetcher).toHaveBeenCalledOnce()
    decoded.resolve()
    expect(await loading).toBe(true)
    const firstView = f.cache.url(KEY)
    f.time(480_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(f.cache.url(KEY)).toBe(firstView)
    await f.cache.prepare(KEY, { url: 'https://files.test/portrait?token=renewed', exp: 1080 })
    expect(f.cache.url(KEY)).toBe(firstView)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    expect(f.fetcher).toHaveBeenCalledOnce()
    expect(f.decode).toHaveBeenCalledOnce()
  })

  it('uses the browser fetch function with the correct receiver', async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(new Blob(['face'], { type: 'image/jpeg' })))
    })
    vi.stubGlobal('fetch', fetcher)
    const cache = createAvatarSources({
      createUrl: () => 'blob:portrait-bound-fetch',
      decode: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(),
    })
    cache.sync([KEY])
    cache.named([KEY])
    expect(await cache.prepare(KEY, LEASE)).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('keeps a prepared picture through delayed/failed renewal, with retry backoff and a bounded grace', async () => {
    const f = fixture()
    await f.cache.prepare(KEY, LEASE)
    const ready = f.cache.url(KEY)
    f.time(480_000)
    expect(f.cache.failure(KEY, false)).toBe(false)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    expect(f.cache.url(KEY)).toBe(ready)
    f.time(510_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    f.time(1_199_999)
    expect(f.cache.url(KEY)).toBe(ready)
    f.time(1_200_000)
    expect(f.cache.expire()).toBe(true)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith(ready)
  })

  it('immediately revokes a prepared picture on an explicit access refusal', async () => {
    const f = fixture()
    await f.cache.prepare(KEY, LEASE)
    const ready = f.cache.url(KEY)
    expect(f.cache.failure(KEY, true)).toBe(true)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith(ready)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
  })

  it('retries an initial failed download without publishing undecoded bytes', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValueOnce(new Error('offline'))
    f.decode.mockRejectedValueOnce(new Error('offline'))
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    f.time(30_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(await f.cache.prepare(KEY, LEASE)).toBe(true)
    expect(f.cache.url(KEY)).toBe('blob:portrait-1')
  })

  it('revokes failed decode bytes and leaves the source unavailable', async () => {
    const f = fixture()
    f.decode.mockRejectedValueOnce(new Error('broken image'))
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:portrait-1')
  })

  it('fences late decoded bytes when a picture is replaced or removed', async () => {
    const f = fixture()
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const old = f.cache.prepare(KEY, LEASE)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
    const replacement = 'avatar:person:version-two'
    f.cache.sync([replacement])
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:portrait-1')
    await f.cache.prepare(replacement, LEASE)
    decoded.resolve()
    expect(await old).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.cache.url(replacement)).toBe('blob:portrait-2')
    f.cache.sync([])
    expect(f.revokeUrl).toHaveBeenCalledWith('blob:portrait-2')
  })

  it('does not let a mint from an old authentication session populate a recreated key', async () => {
    const f = fixture()
    const ticket = f.cache.ticket(KEY)
    f.cache.clear()
    f.cache.sync([KEY])
    expect(await f.cache.prepare(KEY, LEASE, ticket)).toBe(false)
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.cache.prepare(KEY, LEASE)
    expect(f.cache.failure(KEY, true, ticket)).toBe(false)
    expect(f.cache.url(KEY)).toBe('blob:portrait-1')
  })

  it('aborts a pending download on clear and ignores a response that arrives anyway', async () => {
    const f = fixture()
    const download = deferred<Response>()
    f.fetcher.mockReturnValueOnce(download.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    const signal = f.fetcher.mock.calls[0][1]?.signal
    f.cache.clear()
    expect(signal?.aborted).toBe(true)
    download.resolve(new Response(new Blob(['old face'])))
    expect(await loading).toBe(false)
    expect(f.createUrl).not.toHaveBeenCalled()
    expect(f.cache.url(KEY)).toBeNull()
  })

  it.each(['download', 'decode'])(
    'bounds a stalled %s and permits a later retry',
    async (stage) => {
      vi.useFakeTimers()
      try {
        const f = fixture()
        const stalled = deferred<never>()
        if (stage === 'download') f.fetcher.mockReturnValueOnce(stalled.promise)
        else f.decode.mockReturnValueOnce(stalled.promise)
        const loading = f.cache.prepare(KEY, LEASE)
        // Node 24 reads a downloaded Blob in a later event-loop turn, not in
        // microtasks, so wait for the decode to start before the time runs out.
        if (stage === 'decode') await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await loading).toBe(false)
        expect(f.cache.url(KEY)).toBeNull()
        expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
        if (stage === 'decode') expect(f.revokeUrl).toHaveBeenCalledWith('blob:portrait-1')
        f.time(30_000)
        expect(f.cache.needsRefresh(KEY)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('does not republish bytes if access is refused during decode', async () => {
    const f = fixture()
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
    f.cache.failure(KEY, true)
    decoded.resolve()
    expect(await loading).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:portrait-1')
  })

  it('falls back to a decoded image URL when a browser origin cannot read the gateway with fetch', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValue(new TypeError('Failed to fetch'))
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledWith(LEASE.url))
    expect(f.cache.url(KEY)).toBeNull()
    decoded.resolve()
    expect(await loading).toBe(true)
    expect(f.cache.url(KEY)).toBe(LEASE.url)
    expect(f.createUrl).not.toHaveBeenCalled()
    f.cache.clear()
    expect(f.revokeUrl).not.toHaveBeenCalled()
  })

  it('prepares replacement signed URLs for a direct-image fallback while preserving its old paint', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValue(new TypeError('Failed to fetch'))
    await f.cache.prepare(KEY, LEASE)
    f.time(480_000)
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const renewed = { url: 'https://files.test/portrait?token=second', exp: 1080 }
    const loading = f.cache.prepare(KEY, renewed)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledWith(renewed.url))
    expect(f.cache.url(KEY)).toBe(LEASE.url)
    decoded.resolve()
    expect(await loading).toBe(true)
    expect(f.cache.url(KEY)).toBe(renewed.url)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.revokeUrl).not.toHaveBeenCalled()
  })

  it('retains a direct fallback if renewal also fails to decode', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValue(new TypeError('Failed to fetch'))
    await f.cache.prepare(KEY, LEASE)
    f.time(480_000)
    f.decode.mockRejectedValueOnce(new Error('offline'))
    expect(
      await f.cache.prepare(KEY, { url: 'https://files.test/portrait?token=second', exp: 1080 }),
    ).toBe(false)
    expect(f.cache.url(KEY)).toBe(LEASE.url)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    expect(f.revokeUrl).not.toHaveBeenCalled()
    f.time(510_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
  })

  it.each([401, 403, 404])(
    'does not bypass an explicit HTTP %s with a direct-image fallback',
    async (status) => {
      const f = fixture()
      f.fetcher.mockResolvedValueOnce(new Response(null, { status }))
      expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
      expect(f.cache.url(KEY)).toBeNull()
      expect(f.decode).not.toHaveBeenCalled()
    },
  )

  it('fences an in-flight fallback decode when the roster entry is replaced', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledWith(LEASE.url))
    f.cache.sync(['avatar:person:version-two'])
    decoded.resolve()
    expect(await loading).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.revokeUrl).not.toHaveBeenCalled()
  })

  it('restores authorized bytes before a lease is renewed, then keeps the source through renewal', async () => {
    const f = fixture()
    const stored = persistentFixture()
    f.cache.setPersistent(stored.cache)
    await f.cache.restore()
    expect(f.cache.url(KEY)).toBe('blob:portrait-1')
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    await f.cache.prepare(KEY, LEASE)
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.cache.url(KEY)).toBe('blob:portrait-1')
    expect(f.cache.needsRefresh(KEY)).toBe(false)
  })

  it('removes corrupt persisted bytes and fences a replacement during restore', async () => {
    const f = fixture()
    const stored = persistentFixture()
    f.cache.setPersistent(stored.cache)
    f.decode.mockRejectedValueOnce(new Error('broken cached image'))
    expect(await f.cache.restore()).toBe(false)
    expect(stored.cache.remove).toHaveBeenCalledWith(KEY)
    expect(f.cache.url(KEY)).toBeNull()

    const decoded = deferred()
    f.decode.mockReturnValueOnce(decoded.promise)
    stored.blobs.set(KEY, new Blob(['replacement race'], { type: 'image/webp' }))
    const restoring = f.cache.restore()
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(2))
    f.cache.sync(['avatar:person:version-two'])
    decoded.resolve()
    expect(await restoring).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
  })

  it('removes persisted bytes after an explicit access refusal', async () => {
    const f = fixture()
    const stored = persistentFixture()
    f.cache.setPersistent(stored.cache)
    await f.cache.restore()
    expect(f.cache.failure(KEY, true)).toBe(true)
    expect(stored.cache.remove).toHaveBeenCalledWith(KEY)
    expect(f.cache.url(KEY)).toBeNull()
  })

  it('bounds a stalled persisted decode and removes its bytes', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const stored = persistentFixture()
      f.cache.setPersistent(stored.cache)
      f.decode.mockReturnValueOnce(new Promise<void>(() => {}))
      const restoring = f.cache.restore()
      await vi.advanceTimersByTimeAsync(750)
      expect(await restoring).toBe(false)
      expect(stored.cache.remove).toHaveBeenCalledWith(KEY)
      expect(f.revokeUrl).toHaveBeenCalledWith('blob:portrait-1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('profile picture bounds', () => {
  const BOUNDS = structuredClone(AVATAR_SOURCES)
  afterEach(() => {
    Object.assign(AVATAR_SOURCES, structuredClone(BOUNDS))
  })
  const KIB = 1024
  const face = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/webp' })
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `avatar:person-${i}:v1`)

  it('downloads at most six pictures at once', async () => {
    const f = fixture()
    const held = Array.from({ length: 8 }, () => deferred<Response>())
    let next = 0
    f.fetcher.mockImplementation(
      () => (held[next++] as ReturnType<typeof deferred<Response>>).promise,
    )
    const all = keys(8)
    f.cache.sync(all)
    const loading = all.map((key) => f.cache.prepare(key, LEASE))
    expect(f.fetcher).toHaveBeenCalledTimes(6)
    expect(f.cache.downloading()).toBe(6)
    // a key waiting for a slot is on its way, so nothing mints it again
    expect(f.cache.needsRefresh(all[7] as string)).toBe(false)
    held[0]?.resolve(new Response(face(KIB)))
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(7))
    for (const h of held) h.resolve(new Response(face(KIB)))
    expect(await Promise.all(loading)).toEqual(Array(8).fill(true))
    expect(f.cache.downloading()).toBe(0)
  })

  it('re-encodes a 300 KiB picture without decoding it first, and keeps the result', async () => {
    const shrink = vi.fn(async () => face(18 * KIB))
    const f = fixture({ shrink })
    f.fetcher.mockResolvedValue(new Response(face(300 * KIB)))
    f.decode.mockResolvedValue({ width: 256, height: 256 })
    expect(await f.cache.prepare(KEY, LEASE)).toBe(true)
    expect(shrink).toHaveBeenCalledOnce()
    // only the re-encoded picture is decoded
    expect(f.decode).toHaveBeenCalledExactlyOnceWith('blob:portrait-1')
    expect(f.cache.url(KEY)).toBe('blob:portrait-1')
    expect(f.cache.keptBytes()).toBe(18 * KIB)
  })

  it('re-encodes a 512-pixel picture of few bytes and keeps the result', async () => {
    const shrink = vi.fn(async () => face(18 * KIB))
    const f = fixture({ shrink })
    f.fetcher.mockResolvedValue(new Response(face(20 * KIB)))
    f.decode.mockResolvedValueOnce({ width: 512, height: 512 })
    f.decode.mockResolvedValueOnce({ width: 256, height: 256 })
    expect(await f.cache.prepare(KEY, LEASE)).toBe(true)
    expect(shrink).toHaveBeenCalledOnce()
    expect(f.cache.url(KEY)).toBe('blob:portrait-2')
    expect(f.cache.keptBytes()).toBe(18 * KIB)
    expect(f.revokeUrl).toHaveBeenCalledWith('blob:portrait-1')
  })

  it('tries a picture whose re-encode could not run again later, and keeps it as initials after a second failure', async () => {
    const shrink = vi.fn(async (): Promise<Blob> => {
      throw new Error('could not re-encode')
    })
    const f = fixture({ shrink })
    f.fetcher.mockImplementation(async () => new Response(face(300 * KIB)))
    f.decode.mockResolvedValue({ width: 256, height: 256 })
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    f.time(30_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    // the second try re-encodes
    shrink.mockResolvedValueOnce(face(18 * KIB))
    expect(await f.cache.prepare(KEY, LEASE)).toBe(true)
    expect(f.cache.keptBytes()).toBe(18 * KIB)
    // another picture whose re-encode fails twice stays initials
    const other = 'avatar:other:v1'
    f.cache.sync([KEY, other])
    expect(await f.cache.prepare(other, LEASE)).toBe(false)
    f.time(60_000)
    expect(await f.cache.prepare(other, LEASE)).toBe(false)
    f.time(3_600_000)
    expect(f.cache.needsRefresh(other)).toBe(false)
    expect(f.fetcher).toHaveBeenCalledTimes(4)
  })

  it('keeps a picture whose type cannot be re-encoded as initials, without trying again', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({}))
    try {
      const f = fixture({})
      f.fetcher.mockResolvedValue(
        new Response(new Blob([new Uint8Array(300 * KIB)], { type: 'image/svg+xml' })),
      )
      expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
      f.time(3_600_000)
      expect(f.cache.needsRefresh(KEY)).toBe(false)
      expect(f.decode).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a picture that stays too large as initials, never kept or retried until its version changes', async () => {
    const stored = persistentFixture(null)
    const f = fixture({ shrink: async () => face(300 * KIB) })
    f.cache.setPersistent(stored.cache)
    f.fetcher.mockResolvedValue(new Response(face(300 * KIB)))
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(stored.cache.put).not.toHaveBeenCalled()
    expect(f.cache.keptBytes()).toBe(0)
    f.time(3_600_000)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    const replaced = 'avatar:person:version-two'
    f.cache.sync([replaced])
    expect(f.cache.needsRefresh(replaced)).toBe(true)
  })

  it('starts no download past a lowered kept budget, and a roster change frees room in the order asked', async () => {
    AVATAR_SOURCES.keptBytes = 500 * KIB
    const changed = vi.fn()
    const f = fixture({ changed })
    f.fetcher.mockImplementation(async () => new Response(face(200 * KIB)))
    const [a, b, c, d] = keys(4) as [string, string, string, string]
    f.cache.sync([a, b, c, d])
    expect(await f.cache.prepare(a, LEASE)).toBe(true)
    expect(await f.cache.prepare(b, LEASE)).toBe(true)
    // 400 KiB kept: one more picture of up to 256 KiB would pass 500
    expect(await f.cache.prepare(c, LEASE)).toBe(false)
    expect(await f.cache.prepare(d, LEASE)).toBe(false)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect([c, d].map((k) => [f.cache.url(k), f.cache.needsRefresh(k)])).toEqual([
      [null, false],
      [null, false],
    ])
    // the roster drops a: c starts by itself with the lease it waited
    // with, d still waits, and nothing mints either again
    f.cache.sync([b, c, d])
    expect(f.fetcher).toHaveBeenCalledTimes(3)
    expect(f.cache.needsRefresh(c)).toBe(false)
    expect(f.cache.needsRefresh(d)).toBe(false)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(f.cache.url(c)).not.toBeNull()
    expect(f.cache.keptBytes()).toBe(400 * KIB)
    // a waiting lease that ran out is minted again instead
    f.time(600_000)
    f.cache.sync([c, d])
    expect(f.cache.needsRefresh(d)).toBe(true)
  })

  it('counts the pictures waiting for a download slot against the budget, so a thousand at once stay inside it', async () => {
    AVATAR_SOURCES.keptBytes = 2 * 1024 * 1024
    const f = fixture()
    f.fetcher.mockImplementation(async () => new Response(face(200 * KIB)))
    const all = keys(40)
    f.cache.sync(all)
    // every prepare asked in one go, as a chunk's answers arrive
    const results = await Promise.all(all.map((key) => f.cache.prepare(key, LEASE)))
    // 2 MiB holds eight reservations of 256 KiB; once they are 200 KiB
    // each, room for one more, which starts by itself, and no more
    expect(results.filter(Boolean)).toHaveLength(8)
    await vi.waitFor(() => expect(f.cache.keptBytes()).toBe(9 * 200 * KIB))
    expect(f.fetcher).toHaveBeenCalledTimes(9)
    expect(f.cache.keptBytes()).toBeLessThanOrEqual(AVATAR_SOURCES.keptBytes)
  })

  it('starts no download for a waiting picture when a clear frees room', async () => {
    AVATAR_SOURCES.keptBytes = 500 * KIB
    const f = fixture()
    f.fetcher.mockImplementation(async () => new Response(face(200 * KIB)))
    const [a, b, c] = keys(3) as [string, string, string]
    f.cache.sync([a, b, c])
    expect(await f.cache.prepare(a, LEASE)).toBe(true)
    expect(await f.cache.prepare(b, LEASE)).toBe(true)
    expect(await f.cache.prepare(c, LEASE)).toBe(false)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    // sign-out: releasing a frees room while c still waits with its lease
    f.cache.clear()
    await Promise.resolve()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.cache.downloading()).toBe(0)
    expect(f.cache.keptBytes()).toBe(0)
  })

  it.each([
    ['300 KiB', 300 * KIB, 256],
    ['2,048-pixel', 30 * KIB, 2048],
  ])(
    'never shows a cached %s picture an older app kept, and downloads it again',
    async (_, bytes, edge) => {
      const stored = persistentFixture(face(bytes))
      const shrink = vi.fn(async () => face(18 * KIB))
      const f = fixture({ shrink })
      f.cache.setPersistent(stored.cache)
      f.decode.mockResolvedValue({ width: edge, height: edge })
      expect(await f.cache.restore()).toBe(false)
      expect(f.cache.url(KEY)).toBeNull()
      expect(f.cache.keptBytes()).toBe(0)
      expect(stored.cache.remove).toHaveBeenCalledWith(KEY)
      expect(f.cache.needsRefresh(KEY)).toBe(true)
      // the mint that follows downloads and re-encodes it
      f.fetcher.mockResolvedValue(new Response(face(bytes)))
      f.decode.mockReset()
      f.decode.mockResolvedValueOnce({ width: edge, height: edge })
      f.decode.mockResolvedValue({ width: 256, height: 256 })
      expect(await f.cache.prepare(KEY, LEASE)).toBe(true)
      expect(f.fetcher).toHaveBeenCalledOnce()
      expect(f.cache.keptBytes()).toBe(18 * KIB)
      expect(stored.blobs.get(KEY)?.size).toBe(18 * KIB)
    },
  )

  it('counts restored pictures in the kept bytes', async () => {
    const f = fixture()
    f.cache.setPersistent(persistentFixture(face(30 * KIB)).cache)
    await f.cache.restore()
    expect(f.cache.keptBytes()).toBe(30 * KIB)
    f.cache.failure(KEY, true)
    expect(f.cache.keptBytes()).toBe(0)
  })

  it('removes the persistent copy when the gateway refuses the picture', async () => {
    const stored = persistentFixture()
    const f = fixture()
    f.cache.setPersistent(stored.cache)
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await f.cache.prepare(KEY, LEASE)).toBe(false)
    expect(stored.cache.remove).toHaveBeenCalledWith(KEY)
  })

  it('renews, downloads and releases nothing while hidden, and on return renews without a download', async () => {
    const f = fixture()
    await f.cache.prepare(KEY, LEASE)
    const ready = f.cache.url(KEY)
    f.cache.pause(true)
    // an hour hidden, far past the lease and its grace
    f.time(3_600_000)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    expect(f.cache.expire()).toBe(false)
    expect(f.cache.url(KEY)).toBe(ready)
    const other = 'avatar:other:v1'
    f.cache.sync([KEY, other])
    const waiting = f.cache.prepare(other, { ...LEASE, exp: 4200 })
    expect(f.fetcher).toHaveBeenCalledOnce()
    f.cache.pause(false)
    expect(await waiting).toBe(true)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(f.cache.url(KEY)).toBe(ready)
    await f.cache.prepare(KEY, { url: 'https://files.test/portrait?token=back', exp: 4200 })
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.cache.url(KEY)).toBe(ready)
    // a refusal at the renewal still releases it
    expect(f.cache.failure(KEY, true)).toBe(true)
    expect(f.cache.url(KEY)).toBeNull()
  })

  it('asks for a mint at once for a picture whose lease ran out while it waited for a slot through a hidden page', async () => {
    const changed = vi.fn()
    const f = fixture({ changed })
    const held = Array.from({ length: 6 }, () => deferred<Response>())
    let next = 0
    f.fetcher.mockImplementation(async () => {
      const answer = held[next++]
      return answer ? answer.promise : new Response(face(KIB))
    })
    const all = keys(8)
    f.cache.sync(all)
    const loading = all.map((key) => f.cache.prepare(key, LEASE))
    expect(f.fetcher).toHaveBeenCalledTimes(6)
    f.cache.pause(true)
    for (const h of held) h.resolve(new Response(face(KIB)))
    await Promise.all(loading.slice(0, 6))
    // back after an hour, past the waiting pictures' lease
    f.time(3_600_000)
    f.cache.pause(false)
    expect(await Promise.all(loading.slice(6))).toEqual([false, false])
    expect(f.fetcher).toHaveBeenCalledTimes(6)
    expect(changed).toHaveBeenCalled()
    expect(all.slice(6).map((key) => f.cache.needsRefresh(key))).toEqual([true, true])
  })

  it('releases a held picture whose renewal keeps failing after the return, not later', async () => {
    const f = fixture()
    await f.cache.prepare(KEY, LEASE)
    f.cache.pause(true)
    f.time(3_600_000)
    f.cache.pause(false)
    f.cache.failure(KEY, false)
    f.time(3_600_000 + 10 * 60_000 - 1)
    expect(f.cache.url(KEY)).not.toBeNull()
    f.time(3_600_000 + 10 * 60_000)
    expect(f.cache.url(KEY)).toBeNull()
  })
})

describe('pictures only for what the open views name', () => {
  const BOUNDS = structuredClone(AVATAR_SOURCES)
  afterEach(() => {
    Object.assign(AVATAR_SOURCES, structuredClone(BOUNDS))
  })
  const KIB = 1024
  const face = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/webp' })
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `avatar:person-${i}:v1`)

  it('downloads a picture only while a view names it', async () => {
    const f = fixture({}, false)
    const [a, b] = keys(2) as [string, string]
    f.cache.sync([a, b])
    f.cache.named([a])
    expect(await f.cache.prepare(b, LEASE)).toBe(false)
    expect(await f.cache.prepare(a, LEASE)).toBe(true)
    expect(f.fetcher).toHaveBeenCalledOnce()
    expect(f.cache.url(b)).toBeNull()
  })

  it('drops a closed page’s waiting and slot-waiting pictures, finishes a running download and keeps loading one another view names', async () => {
    AVATAR_SOURCES.downloads = 1
    const f = fixture({}, false)
    const running = deferred<Response>()
    f.fetcher.mockImplementationOnce(() => running.promise)
    f.fetcher.mockImplementation(async () => new Response(face(20 * KIB)))
    const [a, b, c] = keys(3) as [string, string, string]
    f.cache.sync([a, b, c])
    f.cache.named([a, b, c])
    const first = f.cache.prepare(a, LEASE)
    const second = f.cache.prepare(b, LEASE)
    const third = f.cache.prepare(c, LEASE)
    expect(f.fetcher).toHaveBeenCalledOnce()
    // the page that showed a and b closes; another view still names c
    f.cache.named([c])
    expect(await second).toBe(false)
    running.resolve(new Response(face(20 * KIB)))
    expect(await first).toBe(true)
    expect(await third).toBe(true)
    // a ran to its end and is kept, b never downloaded, c loaded
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.cache.url(a)).not.toBeNull()
    expect(f.cache.url(b)).toBeNull()
    expect(f.cache.url(c)).not.toBeNull()
    // b, dropped, is no failure: named again, the store mints it at once
    f.cache.named([b, c])
    expect(f.cache.needsRefresh(b)).toBe(true)
  })

  it('lets a named picture past the budget take the room of the one shown least recently that nothing names', async () => {
    AVATAR_SOURCES.keptBytes = 4 * 256 * KIB
    const f = fixture({}, false)
    f.fetcher.mockImplementation(async () => new Response(face(256 * KIB)))
    const all = keys(6)
    const [a, b, c, d, e, g] = all as [string, string, string, string, string, string]
    f.cache.sync(all)
    f.cache.named([a, b, c, d])
    for (const key of [a, b, c, d]) expect(await f.cache.prepare(key, LEASE)).toBe(true)
    expect(f.cache.keptBytes()).toBe(4 * 256 * KIB)
    // b is let go first, then a: b is shown least recently
    f.cache.named([a, c, d])
    f.cache.named([c, d])
    f.cache.named([c, d, e])
    expect(await f.cache.prepare(e, LEASE)).toBe(true)
    expect(f.cache.url(b)).toBeNull()
    expect(f.cache.url(a)).not.toBeNull()
    expect(f.cache.keptBytes()).toBe(4 * 256 * KIB)
    // with every held picture named, a fifth waits as initials
    f.cache.named([a, c, d, e, g])
    expect(await f.cache.prepare(g, LEASE)).toBe(false)
    expect(f.cache.url(g)).toBeNull()
    expect([a, c, d, e].every((key) => f.cache.url(key) !== null)).toBe(true)
    expect(f.fetcher).toHaveBeenCalledTimes(5)
  })

  it('keeps the held pictures nothing names while a large named batch downloads within the budget', async () => {
    // room for the 50 pictures of 20 KiB below with six downloads on their
    // way at 256 KiB each, not for 30 downloads at 256 KiB
    AVATAR_SOURCES.keptBytes = 12 * 256 * KIB
    const f = fixture({}, false)
    f.fetcher.mockImplementation(async () => new Response(face(20 * KIB)))
    const earlier = keys(20)
    const page = Array.from({ length: 30 }, (_, i) => `avatar:page-${i}:v1`)
    f.cache.sync([...earlier, ...page])
    f.cache.named(earlier)
    for (const key of earlier) expect(await f.cache.prepare(key, LEASE)).toBe(true)
    // the earlier page closes, and the next names 30 others at once. Six
    // download, and the rest wait for a slot, each counted at 256 KiB
    f.cache.named(page)
    await Promise.all(page.map((key) => f.cache.prepare(key, LEASE)))
    await vi.waitFor(() => expect(page.every((key) => f.cache.url(key) !== null)).toBe(true))
    // 50 pictures of 20 KiB fit the budget, so none of the earlier ones went
    expect(earlier.every((key) => f.cache.url(key) !== null)).toBe(true)
    expect(f.cache.keptBytes()).toBe(50 * 20 * KIB)
    expect(f.fetcher).toHaveBeenCalledTimes(50)
  })

  it('waits in the named order and starts the first named once room frees', async () => {
    AVATAR_SOURCES.keptBytes = 2 * 256 * KIB
    const changed = vi.fn()
    const f = fixture({ changed }, false)
    f.fetcher.mockImplementation(async () => new Response(face(256 * KIB)))
    const [a, b, c, d] = keys(4) as [string, string, string, string]
    f.cache.sync([a, b, c, d])
    f.cache.named([a, b, c, d])
    await f.cache.prepare(a, LEASE)
    await f.cache.prepare(b, LEASE)
    expect(await f.cache.prepare(c, LEASE)).toBe(false)
    expect(await f.cache.prepare(d, LEASE)).toBe(false)
    // d comes first now, and a goes: d starts, c still waits
    f.cache.named([d, c, b])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(f.cache.url(d)).not.toBeNull()
    expect(f.cache.url(c)).toBeNull()
  })

  it('stops showing a held picture no view names past its grace, keeps its bytes, and shows it again on one renewal', async () => {
    const f = fixture({}, false)
    f.cache.sync([KEY])
    f.cache.named([KEY])
    await f.cache.prepare(KEY, LEASE)
    const shown = f.cache.url(KEY)
    expect(shown).not.toBeNull()
    f.cache.named([])
    // the lease ends at 600 s and the grace 10 minutes after
    f.time(1_200_000)
    expect(f.cache.expire()).toBe(false)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.cache.keptBytes()).toBeGreaterThan(0)
    expect(f.revokeUrl).not.toHaveBeenCalled()
    // named again, one renewal shows it with no download. A render and a
    // sweep before the renewal answers, as the store makes once a view
    // names the person, keep its bytes.
    f.cache.named([KEY])
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.cache.expire()).toBe(false)
    expect(f.cache.keptBytes()).toBeGreaterThan(0)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(await f.cache.prepare(KEY, { url: 'https://files.test/portrait?r=2', exp: 1800 })).toBe(
      true,
    )
    expect(f.cache.url(KEY)).toBe(shown)
    expect(f.fetcher).toHaveBeenCalledOnce()
    // a refusal releases it
    expect(f.cache.failure(KEY, true)).toBe(true)
    expect(f.cache.url(KEY)).toBeNull()
  })

  it('keeps a held picture no view names hidden past its grace when the tab shows again', async () => {
    const f = fixture({}, false)
    f.cache.sync([KEY])
    f.cache.named([KEY])
    await f.cache.prepare(KEY, LEASE)
    const shown = f.cache.url(KEY)
    f.cache.named([])
    // past the lease at 600 s and its grace
    f.time(1_200_000)
    expect(f.cache.url(KEY)).toBeNull()
    // hidden too while the page is, so a render then paints no picture
    f.cache.pause(true)
    expect(f.cache.url(KEY)).toBeNull()
    f.cache.pause(false)
    // still hidden, and nothing renews it until a view names it
    expect(f.cache.url(KEY)).toBeNull()
    f.time(1_500_000)
    expect(f.cache.url(KEY)).toBeNull()
    f.cache.named([KEY])
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(await f.cache.prepare(KEY, { url: 'https://files.test/portrait?r=2', exp: 2400 })).toBe(
      true,
    )
    expect(f.cache.url(KEY)).toBe(shown)
  })

  it('keeps a named picture past its grace while its renewal is on its way, and releases it once the renewal fails', async () => {
    const f = fixture({}, false)
    f.cache.sync([KEY])
    f.cache.named([KEY])
    await f.cache.prepare(KEY, LEASE)
    f.time(1_200_000)
    expect(f.cache.url(KEY)).toBeNull()
    expect(f.cache.expire()).toBe(false)
    expect(f.cache.keptBytes()).toBeGreaterThan(0)
    expect(f.cache.failure(KEY, false)).toBe(true)
    expect(f.cache.keptBytes()).toBe(0)
  })

  it('renews a picture named again past its grace once, though an older renewal of it failed', async () => {
    const f = fixture({}, false)
    f.cache.sync([KEY])
    f.cache.named([KEY])
    await f.cache.prepare(KEY, LEASE)
    const shown = f.cache.url(KEY)
    // a renewal near the lease's end fails, then the page closes
    f.time(500_000)
    expect(f.cache.failure(KEY, false)).toBe(false)
    f.cache.named([])
    f.time(2_000_000)
    // named again, its old failure neither delays its renewal nor lets a
    // sweep release it first
    f.cache.named([KEY])
    expect(f.cache.needsRefresh(KEY)).toBe(true)
    expect(f.cache.expire()).toBe(false)
    expect(await f.cache.prepare(KEY, { url: 'https://files.test/portrait?r=2', exp: 2600 })).toBe(
      true,
    )
    expect(f.cache.url(KEY)).toBe(shown)
    expect(f.fetcher).toHaveBeenCalledOnce()
  })

  it('restores the persisted picture of a key that becomes known after the boot', async () => {
    const stored = persistentFixture(face(20 * KIB))
    const changed = vi.fn()
    const f = fixture({ changed }, false)
    f.cache.sync([])
    f.cache.setPersistent(stored.cache)
    await f.cache.restore()
    expect(f.cache.url(KEY)).toBeNull()
    // a face arrives with the key the device holds
    f.cache.sync([KEY])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(f.cache.url(KEY)).not.toBeNull()
    expect(f.fetcher).not.toHaveBeenCalled()
    // shown before its renewal, which a view's naming asks for
    f.cache.named([KEY])
    expect(f.cache.needsRefresh(KEY)).toBe(true)
  })

  it('leaves a picture to its download when a restore lands while it downloads, and renews it by its lease', async () => {
    const stored = persistentFixture(face(20 * KIB))
    const f = fixture({}, false)
    f.cache.sync([])
    f.cache.setPersistent(stored.cache)
    await f.cache.restore()
    // a face arrives with the key the device holds. Its restore reads, and
    // its decode is still on its way when the picture's mint answers
    const restoring = deferred<unknown>()
    f.decode.mockImplementationOnce(() => restoring.promise)
    f.cache.sync([KEY])
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
    f.cache.named([KEY])
    const download = deferred<Response>()
    f.fetcher.mockImplementationOnce(() => download.promise)
    const loading = f.cache.prepare(KEY, LEASE)
    restoring.resolve(undefined)
    await vi.waitFor(() => expect(f.revokeUrl).toHaveBeenCalledOnce())
    // the restore gave way to the download
    expect(f.cache.url(KEY)).toBeNull()
    download.resolve(new Response(face(20 * KIB)))
    expect(await loading).toBe(true)
    expect(f.cache.url(KEY)).not.toBeNull()
    // the lease ends at 600 s, so it renews from 480 s on
    f.time(479_000)
    expect(f.cache.needsRefresh(KEY)).toBe(false)
    f.time(480_000)
    expect(f.cache.needsRefresh(KEY)).toBe(true)
  })

  it('hands the persistent cache the known keys and the profiles known without a picture', () => {
    const stored = persistentFixture()
    const f = fixture({}, false)
    f.cache.setPersistent(stored.cache)
    f.cache.sync([KEY], ['someone-without'])
    expect(stored.cache.sync).toHaveBeenLastCalledWith(new Set([KEY]), ['someone-without'])
  })
})
