import { describe, expect, it, vi } from 'vitest'
import {
  AVATAR_IMAGE_MAX_BYTES,
  AVATAR_IMAGE_MAX_ENTRIES,
  AVATAR_IMAGE_MAX_TOTAL_BYTES,
  type AvatarImageCacheRecord,
  type AvatarImageCacheStore,
  avatarCacheScope,
  createAvatarImageCache,
} from './avatarImageCache'

const scope = avatarCacheScope('https://backend.test', 'alice')
const otherScope = avatarCacheScope('https://backend.test', 'bob')
const picture = (text = 'portrait') => new Blob([text], { type: 'image/webp' })

function fixture(initial: AvatarImageCacheRecord | null = null) {
  let saved = initial
  const store: AvatarImageCacheStore = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (record) => {
      saved = record
    }),
  }
  return { store, saved: () => saved }
}

async function flush(cache: ReturnType<typeof createAvatarImageCache>) {
  await cache.settled()
  await Promise.resolve()
}

describe('persistent account profile image bytes', () => {
  it('restores only the authorized roster and replaces a storage-version key', async () => {
    const f = fixture({
      scope,
      entries: [
        { key: 'avatar:alice:storage-1', blob: picture('old') },
        { key: 'avatar:bob:storage-2', blob: picture('other') },
      ],
    })
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['avatar:alice:storage-1'])
    expect(await cache.read('avatar:alice:storage-1')).toBeInstanceOf(Blob)
    expect(await cache.read('avatar:bob:storage-2')).toBeNull()
    await flush(cache)
    expect(f.saved()?.entries.map((entry) => entry.key)).toEqual(['avatar:alice:storage-1'])

    cache.sync(['avatar:alice:storage-3'])
    expect(await cache.read('avatar:alice:storage-3')).toBeNull()
    cache.put('avatar:alice:storage-3', picture('new'))
    await flush(cache)
    expect(f.saved()?.entries.map((entry) => entry.key)).toEqual(['avatar:alice:storage-3'])
    cache.dispose()
  })

  it('isolates backend/account scope and never restores another record', async () => {
    const f = fixture({ scope: otherScope, entries: [{ key: 'avatar:bob:1', blob: picture() }] })
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['avatar:bob:1'])
    expect(await cache.read('avatar:bob:1')).toBeNull()
    await flush(cache)
    expect(f.saved()).toBeNull()
    cache.dispose()
  })

  it('bounds entries and total bytes, evicting oldest entries first', async () => {
    const f = fixture()
    const cache = createAvatarImageCache(scope, { store: f.store })
    const keys = Array.from(
      { length: AVATAR_IMAGE_MAX_ENTRIES + 2 },
      (_, index) => `avatar:a:${index}`,
    )
    cache.sync(keys)
    for (const key of keys) cache.put(key, picture(key))
    await flush(cache)
    expect(f.saved()?.entries).toHaveLength(AVATAR_IMAGE_MAX_ENTRIES)
    expect(f.saved()?.entries[0]?.key).toBe(keys[2])

    const large = new Blob([new Uint8Array(AVATAR_IMAGE_MAX_TOTAL_BYTES / 2)], {
      type: 'image/png',
    })
    cache.put(keys.at(-1)!, large)
    cache.put(keys.at(-2)!, large)
    await flush(cache)
    expect(f.saved()?.entries.reduce((sum, entry) => sum + entry.blob.size, 0)).toBeLessThanOrEqual(
      AVATAR_IMAGE_MAX_TOTAL_BYTES,
    )
    cache.dispose()
  })

  it('rejects malformed and oversized bytes without persisting them', async () => {
    const f = fixture()
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['good', 'bad', 'too-large'])
    cache.put('bad', new Blob(['text'], { type: 'text/plain' }))
    cache.put(
      'too-large',
      new Blob([new Uint8Array(AVATAR_IMAGE_MAX_BYTES + 1)], { type: 'image/png' }),
    )
    await flush(cache)
    expect(await cache.read('bad')).toBeNull()
    expect(await cache.read('too-large')).toBeNull()
    expect(f.saved()).toBeNull()
    cache.dispose()
  })

  it('does not fence a restore when the same roster is synchronized again', async () => {
    let resolveRead!: (record: AvatarImageCacheRecord | null) => void
    const f = fixture()
    const read = vi.fn(
      () => new Promise<AvatarImageCacheRecord | null>((resolve) => (resolveRead = resolve)),
    )
    f.store.read = read
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['avatar:alice:1'])
    const reading = cache.read('avatar:alice:1')
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    cache.sync(['avatar:alice:1'])
    resolveRead({ scope, entries: [{ key: 'avatar:alice:1', blob: picture() }] })
    expect(await reading).toBeInstanceOf(Blob)
    cache.dispose()
  })

  it('times out a stalled read and remains usable in memory', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.store.read = () => new Promise<AvatarImageCacheRecord | null>(() => {})
      const cache = createAvatarImageCache(scope, { store: f.store })
      cache.sync(['avatar:alice:1'])
      cache.put('avatar:alice:1', picture())
      await vi.advanceTimersByTimeAsync(751)
      expect(await cache.read('avatar:alice:1')).toBeInstanceOf(Blob)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a late read repopulate after clear or disposal', async () => {
    let resolveRead!: (record: AvatarImageCacheRecord | null) => void
    const f = fixture()
    f.store.read = () => new Promise((resolve) => (resolveRead = resolve))
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['avatar:alice:old'])
    const oldRead = cache.read('avatar:alice:old')
    await cache.clear()
    resolveRead({ scope, entries: [{ key: 'avatar:alice:old', blob: picture('stale') }] })
    expect(await oldRead).toBeNull()
    expect(await cache.read('avatar:alice:old')).toBeNull()
    cache.dispose()
  })

  it('bounds a stalled write without blocking reads or shutdown', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.store.write = () => new Promise<void>(() => {})
      const cache = createAvatarImageCache(scope, { store: f.store })
      cache.sync(['avatar:alice:1'])
      cache.put('avatar:alice:1', picture())
      const settled = cache.settled()
      await vi.advanceTimersByTimeAsync(751)
      await settled
      expect(await cache.read('avatar:alice:1')).toBeInstanceOf(Blob)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores failed writes while keeping bytes available for the session', async () => {
    const f = fixture()
    f.store.write = vi.fn(async () => {
      throw new Error('quota')
    })
    const cache = createAvatarImageCache(scope, { store: f.store })
    cache.sync(['avatar:alice:1'])
    cache.put('avatar:alice:1', picture())
    await flush(cache)
    expect(await cache.read('avatar:alice:1')).toBeInstanceOf(Blob)
    cache.dispose()
  })
})
