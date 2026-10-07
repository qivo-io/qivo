import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { indexedAvatarImageCache } from './avatarImageCache'
import { indexedBackgroundCache } from './backgroundImageCache'

function indexedDbFixture() {
  const request = {
    result: { scope: 'test' },
    error: null,
    onsuccess: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
  }
  const objectStore = {
    get: vi.fn(() => request),
    put: vi.fn(() => request),
    delete: vi.fn(() => request),
  }
  const transaction = {
    objectStore: vi.fn(() => objectStore),
    abort: vi.fn(),
    error: null,
    oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
  }
  const openRequest = {
    result: { transaction: vi.fn(() => transaction) },
    onsuccess: undefined as (() => void) | undefined,
  }
  vi.stubGlobal('indexedDB', { open: vi.fn(() => openRequest) })
  return { request, objectStore, transaction, openRequest }
}

const caches = [
  {
    name: 'background',
    unavailable: 'Background cache unavailable',
    create() {
      const cache = indexedBackgroundCache()
      return {
        read: () => cache.read(),
        write: () =>
          cache.write({ scope: 'test', selection: { key: 'custom:a', previewVersion: null } }),
        clear: () => cache.write(null),
      }
    },
  },
  {
    name: 'avatar',
    unavailable: 'Avatar image cache unavailable',
    create() {
      const cache = indexedAvatarImageCache()
      return {
        read: () => cache.read(),
        write: () => cache.write({ scope: 'test', entries: [] }),
        clear: () => cache.write(null),
      }
    },
  },
]

describe.each(caches)('$name IndexedDB storage', ({ create, unavailable }) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe.each(['read', 'write', 'clear'] as const)('%s', (operation) => {
    async function start() {
      const f = indexedDbFixture()
      const cache = create()
      const resolved = vi.fn()
      const rejected = vi.fn()
      void cache[operation]().then(resolved, rejected)
      f.openRequest.onsuccess?.()
      await Promise.resolve()
      expect(f.openRequest.result.transaction).toHaveBeenCalledOnce()
      return { ...f, resolved, rejected }
    }

    it('cancels its timeout when the request completes normally', async () => {
      const f = await start()
      if (operation === 'read') f.request.onsuccess?.()
      else f.transaction.oncomplete?.()
      await vi.advanceTimersByTimeAsync(751)
      expect(f.resolved).toHaveBeenCalledExactlyOnceWith(
        operation === 'read' ? f.request.result : undefined,
      )
      expect(f.rejected).not.toHaveBeenCalled()
      expect(f.transaction.abort).not.toHaveBeenCalled()
    })

    it('clears the timeout when queueing the request throws synchronously', async () => {
      const f = indexedDbFixture()
      const error = new DOMException('Transaction is inactive', 'TransactionInactiveError')
      f.transaction.objectStore.mockImplementation(() => {
        throw error
      })
      f.transaction.abort.mockImplementation(() => {
        throw new DOMException('Transaction already finished', 'InvalidStateError')
      })
      const rejected = vi.fn()
      void create()[operation]().catch(rejected)
      f.openRequest.onsuccess?.()
      await vi.advanceTimersByTimeAsync(751)
      expect(rejected).toHaveBeenCalledExactlyOnceWith(error)
      expect(f.transaction.abort).not.toHaveBeenCalled()
    })

    it('rejects a timed-out operation even when abort emits no event', async () => {
      const f = await start()
      await vi.advanceTimersByTimeAsync(751)
      expect(f.rejected).toHaveBeenCalledExactlyOnceWith(new Error(unavailable))
      expect(f.resolved).not.toHaveBeenCalled()
      expect(f.transaction.abort).toHaveBeenCalledOnce()
    })

    it('contains abort errors when a transaction finishes before its completion event', async () => {
      const f = await start()
      f.transaction.abort.mockImplementation(() => {
        throw new DOMException('Transaction already finished', 'InvalidStateError')
      })
      await vi.advanceTimersByTimeAsync(751)
      expect(f.rejected).toHaveBeenCalledExactlyOnceWith(new Error(unavailable))
      expect(f.resolved).not.toHaveBeenCalled()
      if (operation === 'read') f.request.onsuccess?.()
      else f.transaction.oncomplete?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.resolved).not.toHaveBeenCalled()
      expect(f.transaction.abort).toHaveBeenCalledOnce()
    })
  })
})
