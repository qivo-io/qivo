import { describe, expect, it, vi } from 'vitest'
import { createCanvasImageLoader } from './appearance'
import {
  type BackgroundCacheRecord,
  type BackgroundCacheStore,
  backgroundCacheScope,
  createBackgroundImageCache,
} from './backgroundImageCache'

const scope = backgroundCacheScope('https://backend.test', 'alice')
const selection = { key: 'custom:mountain', previewVersion: '2' }
const picture = () => new Blob(['image bytes'], { type: 'image/webp' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(initial: BackgroundCacheRecord | null = null) {
  let saved = initial
  const store: BackgroundCacheStore = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (value) => {
      saved = value
    }),
  }
  let serial = 0
  const fetchImage = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(picture()),
  )
  const createUrl = vi.fn(() => `blob:cached-${++serial}`)
  const revokeUrl = vi.fn()
  const options = { store, fetch: fetchImage, createUrl, revokeUrl }
  return { options, fetchImage, createUrl, revokeUrl, saved: () => saved }
}

describe('persistent account background bytes', () => {
  it('restores the original and reuses both byte versions after reload and URL renewal', async () => {
    const f = fixture()
    const first = createBackgroundImageCache(scope, f.options)
    first.select(selection)
    await first.resolve('https://private.test/original?t=first', selection, 'full')
    await first.resolve('https://private.test/preview?t=first', selection, 'preview')
    await first.settled()
    expect(f.saved()?.full).toBeInstanceOf(Blob)
    expect(f.saved()?.preview).toBeInstanceOf(Blob)
    expect(JSON.stringify(f.saved())).not.toContain('private.test')
    first.dispose()

    const reloaded = createBackgroundImageCache(scope, f.options)
    const restoredFull = await reloaded.restoreFull()
    expect(restoredFull).toEqual({ ...selection, url: 'blob:cached-3' })
    const preview = await reloaded.restorePreview()
    expect(preview).toEqual({ ...selection, url: 'blob:cached-4' })
    reloaded.select(selection)
    const full = await reloaded.resolve(
      'https://private.test/original?t=renewed',
      selection,
      'full',
    )
    expect(full).toBe(restoredFull.url)
    expect(await reloaded.resolve('https://private.test/original?t=third', selection, 'full')).toBe(
      full,
    )
    expect(f.fetchImage).toHaveBeenCalledTimes(2)
    reloaded.dispose()
    expect(f.revokeUrl).toHaveBeenCalledTimes(4)
  })

  it('does not restore a derivative as the original when only preview bytes are cached', async () => {
    const f = fixture({ scope, selection, preview: picture() })
    const cache = createBackgroundImageCache(scope, f.options)
    expect(await cache.restoreFull()).toBeNull()
    expect(f.fetchImage).not.toHaveBeenCalled()
    expect(f.createUrl).not.toHaveBeenCalled()
    cache.dispose()
  })

  it.each([
    backgroundCacheScope('https://backend.test', 'bob'),
    backgroundCacheScope('https://other-backend.test', 'alice'),
  ])('never restores another account or deployment (%s)', async (otherScope) => {
    const f = fixture({ scope, selection, full: picture(), preview: picture() })
    const cache = createBackgroundImageCache(otherScope, f.options)
    expect(await cache.restorePreview()).toBeNull()
    expect(await cache.restoreFull()).toBeNull()
    cache.select(selection)
    await cache.resolve('https://private.test/authorized', selection, 'full')
    expect(f.fetchImage).toHaveBeenCalledOnce()
    cache.dispose()
  })

  it('drops a stale derivative version while preserving the immutable original', async () => {
    const f = fixture({ scope, selection, full: picture(), preview: picture() })
    const cache = createBackgroundImageCache(scope, f.options)
    const updated = { ...selection, previewVersion: '3' }
    cache.select(updated)
    expect(await cache.restorePreview()).toBeNull()
    await cache.resolve('https://private.test/full?new-token', updated, 'full')
    await cache.resolve('https://private.test/preview?v=3', updated, 'preview')
    expect(f.fetchImage).toHaveBeenCalledTimes(1)
    expect(f.fetchImage.mock.calls[0][0]).toContain('v=3')
    await cache.settled()
    expect(f.saved()?.selection.previewVersion).toBe('3')
    cache.dispose()
  })

  it.each([null, { key: 'daily:lake', previewVersion: 'new' }])(
    'fences late restoration and byte fetches when authority changes to %j',
    async (next) => {
      const read = deferred<BackgroundCacheRecord>()
      const fetch = deferred<Response>()
      const f = fixture()
      f.options.store.read = () => read.promise
      f.options.fetch = vi.fn(() => fetch.promise)
      const cache = createBackgroundImageCache(scope, f.options)
      const restoring = cache.restorePreview()
      const restoringFull = cache.restoreFull()
      cache.select(selection)
      const loading = cache.resolve('https://private.test/old', selection, 'full')
      const refused = expect(loading).rejects.toThrow('Background changed')
      cache.select(next)
      read.resolve({ scope, selection, preview: picture(), full: picture() })
      fetch.resolve(new Response(picture()))
      expect(await restoring).toBeNull()
      expect(await restoringFull).toBeNull()
      await refused
      await cache.settled()
      expect(f.saved()?.selection ?? null).toEqual(next)
      expect(f.saved()?.full).toBeUndefined()
      expect(f.createUrl).not.toHaveBeenCalled()
      cache.dispose()
    },
  )

  it('persists immediate withdrawal even if unmounted before the storage read completes', async () => {
    const f = fixture({ scope, selection, preview: picture() })
    const cache = createBackgroundImageCache(scope, f.options)
    cache.select(null)
    cache.dispose()
    await cache.settled()
    expect(f.saved()).toBeNull()
  })

  it('queues withdrawal after a write already in progress, including after disposal', async () => {
    const f = fixture()
    const write = deferred<void>()
    const started = deferred<void>()
    const realWrite = f.options.store.write
    let first = true
    f.options.store.write = async (value) => {
      if (first) {
        first = false
        started.resolve()
        await write.promise
      }
      await realWrite(value)
    }
    const cache = createBackgroundImageCache(scope, f.options)
    cache.select(selection)
    await started.promise
    cache.select(null)
    cache.dispose()
    write.resolve()
    await cache.settled()
    expect(f.saved()).toBeNull()
  })

  it('falls back to in-memory bytes when storage fails or never answers', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.options.store.read = () => new Promise(() => {})
      f.options.store.write = async () => {
        throw new Error('quota')
      }
      const cache = createBackgroundImageCache(scope, f.options)
      cache.select(selection)
      const loading = cache.resolve('https://private.test/image', selection, 'full')
      await vi.advanceTimersByTimeAsync(751)
      const url = await loading
      expect(await cache.resolve('https://private.test/renewed', selection, 'full')).toBe(url)
      expect(f.fetchImage).toHaveBeenCalledOnce()
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed cached bytes and replaces a derivative that fails decoding', async () => {
    const f = fixture({ scope, selection, preview: picture(), full: 'bad' as unknown as Blob })
    const validate = vi.fn(async (url: string) => {
      if (url === 'blob:cached-1') throw new Error('corrupt cached preview')
    })
    const cache = createBackgroundImageCache(scope, { ...f.options, validate })
    cache.select(selection)
    await cache.resolve('https://private.test/fresh-preview', selection, 'preview')
    expect(f.fetchImage).toHaveBeenCalledOnce()
    expect(f.revokeUrl).toHaveBeenCalledWith('blob:cached-1')
    await cache.settled()
    expect(f.saved()?.full).toBeUndefined()
    cache.dispose()
  })

  it('never persists newly fetched bytes that fail decoding', async () => {
    const f = fixture()
    const cache = createBackgroundImageCache(scope, {
      ...f.options,
      validate: async () => {
        throw new Error('invalid image')
      },
    })
    cache.select(selection)
    await expect(cache.resolve('https://private.test/bad', selection, 'full')).rejects.toThrow(
      'invalid',
    )
    await cache.settled()
    expect(f.saved()?.full).toBeUndefined()
    cache.dispose()
  })

  it('keeps an in-flight preview blob alive when full loading starts', async () => {
    const f = fixture()
    const previewDecode = deferred<void>()
    const decoding = deferred<void>()
    const cache = createBackgroundImageCache(scope, {
      ...f.options,
      validate: async (url) => {
        if (url === 'blob:cached-1') {
          decoding.resolve()
          await previewDecode.promise
        }
      },
    })
    cache.select(selection)
    const preview = cache.resolve('https://private.test/preview', selection, 'preview')
    await decoding.promise
    await cache.resolve('https://private.test/full', selection, 'full')
    expect(f.revokeUrl).not.toHaveBeenCalledWith('blob:cached-1')
    previewDecode.resolve()
    expect(await preview).toBe('blob:cached-1')
    await cache.settled()
    expect(f.saved()?.preview).toBeInstanceOf(Blob)
    cache.dispose()
  })

  it('times out a stalled fetch and permits a fresh lease to recover', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const pending = deferred<Response>()
      f.fetchImage.mockImplementationOnce(() => pending.promise)
      const cache = createBackgroundImageCache(scope, f.options)
      cache.select(selection)
      const loading = cache.resolve('https://private.test/stalled', selection, 'full')
      const timedOut = expect(loading).rejects.toThrow('Background cache unavailable')
      await vi.advanceTimersByTimeAsync(30_001)
      await timedOut
      expect(f.fetchImage.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(await cache.resolve('https://private.test/new-lease', selection, 'full')).toMatch(
        /^blob:/,
      )
      pending.resolve(new Response(picture()))
      await cache.settled()
      expect(f.createUrl).toHaveBeenCalledOnce()
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases unpublished bytes when decoding times out and fences late completion', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const decoding = deferred<void>()
      const started = deferred<void>()
      const cache = createBackgroundImageCache(scope, {
        ...f.options,
        validate: async (url) => {
          if (url === 'blob:cached-1') {
            started.resolve()
            await decoding.promise
          }
        },
      })
      cache.select(selection)
      const loading = cache.resolve('https://private.test/slow-decode', selection, 'full')
      const timedOut = expect(loading).rejects.toThrow('Background cache unavailable')
      await started.promise
      await vi.advanceTimersByTimeAsync(30_001)
      await timedOut
      expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:cached-1')
      expect(f.saved()?.full).toBeUndefined()

      expect(await cache.resolve('https://private.test/fresh-lease', selection, 'full')).toBe(
        'blob:cached-2',
      )
      await cache.settled()
      const accepted = f.saved()?.full
      decoding.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await cache.settled()
      expect(f.saved()?.full).toBe(accepted)
      expect(f.revokeUrl).toHaveBeenCalledTimes(1)
      cache.dispose()
      expect(f.revokeUrl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an unavailable storage write permanently block later withdrawal', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const started = deferred<void>()
      const realWrite = f.options.store.write
      let first = true
      f.options.store.write = (value) => {
        if (first) {
          first = false
          started.resolve()
          return new Promise(() => {})
        }
        return realWrite(value)
      }
      const cache = createBackgroundImageCache(scope, f.options)
      cache.select(selection)
      await started.promise
      cache.select(null)
      cache.dispose()
      await vi.advanceTimersByTimeAsync(751)
      await cache.settled()
      expect(f.saved()).toBeNull()
      expect(realWrite).toHaveBeenCalledWith(null)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cached Canvas loader identities', () => {
  const image = {
    key: selection.key,
    fullVersion: selection.key,
    previewVersion: selection.previewVersion,
    url: 'https://private.test/full?t=first',
    previewUrl: 'https://private.test/preview?t=first',
  }
  it('keeps a blob paint through renewed signed URLs without another decode', async () => {
    const decode = vi.fn(async () => 'blob:reusable')
    const receive = vi.fn()
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(image)
    await Promise.resolve()
    loader.set({ ...image, url: 'https://private.test/full?t=renewed' })
    expect(decode).toHaveBeenCalledTimes(2)
    expect(receive.mock.lastCall?.[0].image.url).toBe('blob:reusable')
  })
  it('retries raw-URL fallbacks and failed decodes when a new lease arrives', async () => {
    const decode = vi.fn(async (url: string) => url)
    const loader = createCanvasImageLoader(decode, vi.fn())
    loader.set({ ...image, previewUrl: null })
    await Promise.resolve()
    loader.set({ ...image, previewUrl: null, url: 'https://private.test/full?t=renewed' })
    expect(decode).toHaveBeenCalledTimes(2)

    const failed = vi.fn().mockRejectedValueOnce(new Error('expired')).mockResolvedValue('blob:new')
    const retry = createCanvasImageLoader(failed, vi.fn())
    retry.set({ ...image, previewUrl: null })
    await Promise.resolve()
    retry.set({ ...image, previewUrl: null, url: 'https://private.test/full?t=fresh' })
    expect(failed).toHaveBeenCalledTimes(2)
  })
})
