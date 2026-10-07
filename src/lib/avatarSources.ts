import type { AvatarImageCache } from './avatarImageCache'

const REFRESH_SKEW = 120_000
const RETRY_DELAY = 30_000
const STALE_GRACE = 10 * 60_000
const LOAD_TIMEOUT = 15_000

type Lease = { url: string; exp: number }
type Entry = {
  source: string | null
  sourceOwned: boolean
  refreshFailed: boolean
  expiresAt: number
  retryAt: number
  restored?: boolean
  pending?: { controller: AbortController; source?: string }
}

type Dependencies = {
  now: () => number
  fetch: typeof fetch
  createUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  decode: (url: string) => Promise<void>
}

/** Portrait bytes, keyed by profile AND storage version. A renewed lease
 * confirms access without downloading an unchanged image. Prepared blob URLs
 * survive view remounts; decoded bytes may also be restored from the optional
 * account-scoped persistent cache. Signed URLs never go into persistence. */
export function createAvatarSources(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    decode: async (url) => {
      const image = new Image()
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.src = url
      await image.decode()
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty profile picture')
    },
    ...overrides,
  }
  const entries = new Map<string, Entry>()
  let persistent: AvatarImageCache | null = null
  let restoreGeneration = 0
  const release = (entry: Entry) => {
    entry.pending?.controller.abort()
    if (entry.pending?.source) {
      deps.revokeUrl(entry.pending.source)
      entry.pending.source = undefined
    }
    entry.pending = undefined
    if (entry.source && entry.sourceOwned) deps.revokeUrl(entry.source)
    entry.source = null
    entry.sourceOwned = false
    entry.restored = false
  }
  const expired = (entry: Entry) => deps.now() >= entry.expiresAt + STALE_GRACE
  const current = (key: string, ticket: Entry | undefined) =>
    !!ticket && entries.get(key) === ticket
  const failure = (key: string, refused: boolean, ticket = entries.get(key)) => {
    if (!current(key, ticket)) return false
    const changed = !!ticket.source && (refused || expired(ticket))
    if (refused || expired(ticket)) release(ticket)
    ticket.retryAt = deps.now() + RETRY_DELAY
    ticket.refreshFailed = true
    if (refused) ticket.expiresAt = 0
    return changed
  }

  return {
    /** Removing/replacing a roster entry fences every pending response. */
    sync(keys: Iterable<string>) {
      const wanted = new Set(keys)
      persistent?.sync(wanted)
      for (const [key, entry] of entries) {
        if (wanted.has(key)) continue
        entries.delete(key)
        release(entry)
      }
      for (const key of wanted)
        if (!entries.has(key))
          entries.set(key, {
            source: null,
            sourceOwned: false,
            refreshFailed: false,
            expiresAt: 0,
            retryAt: 0,
          })
    },
    setPersistent(cache: AvatarImageCache | null) {
      if (persistent === cache) return
      const previous = persistent
      persistent = cache
      restoreGeneration++
      previous?.dispose()
    },
    async restore() {
      const cache = persistent
      if (!cache) return false
      const generation = ++restoreGeneration
      const work = [...entries.entries()].map(async ([key, entry]) => {
        let blob: Blob | null
        try {
          blob = await cache.read(key)
        } catch {
          return false
        }
        if (!blob || generation !== restoreGeneration || entries.get(key) !== entry || entry.source)
          return false
        const source = deps.createUrl(blob)
        let timeout: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Profile picture restore timed out')), 750)
        })
        try {
          await Promise.race([deps.decode(source), timedOut])
        } catch {
          deps.revokeUrl(source)
          cache.remove(key)
          return false
        } finally {
          if (timeout) clearTimeout(timeout)
        }
        if (generation !== restoreGeneration || entries.get(key) !== entry || entry.source) {
          deps.revokeUrl(source)
          return false
        }
        entry.source = source
        entry.sourceOwned = true
        entry.restored = true
        entry.expiresAt = Number.POSITIVE_INFINITY
        entry.refreshFailed = false
        return true
      })
      return (await Promise.all(work)).some(Boolean)
    },
    ticket: (key: string) => entries.get(key),
    needsRefresh(key: string) {
      const entry = entries.get(key)
      return (
        !!entry &&
        !entry.pending &&
        deps.now() >= entry.retryAt &&
        (entry.refreshFailed ||
          !entry.source ||
          entry.restored ||
          entry.expiresAt - deps.now() <= REFRESH_SKEW)
      )
    },
    url(key: string) {
      const entry = entries.get(key)
      if (!entry) return null
      if (!entry.restored && expired(entry)) release(entry)
      return entry.source
    },
    expire() {
      let changed = false
      for (const entry of entries.values()) {
        if (!entry.source || !expired(entry)) continue
        release(entry)
        changed = true
      }
      return changed
    },
    failure(key: string, refused: boolean, ticket?: Entry) {
      const changed = failure(key, refused, ticket)
      if (refused && persistent) persistent.remove(key)
      return changed
    },
    async prepare(key: string, lease: Lease, ticket = entries.get(key)): Promise<boolean> {
      if (!current(key, ticket)) return false
      ticket.expiresAt = lease.exp * 1000
      ticket.retryAt = 0
      // The storage version is immutable. Keep the decoded source when only
      // its access token changes, including across a route's React remount.
      if (ticket.source && ticket.sourceOwned) {
        ticket.restored = false
        ticket.refreshFailed = false
        return false
      }
      if (ticket.pending) return false
      const pending = { controller: new AbortController(), source: undefined as string | undefined }
      ticket.pending = pending
      let timeout: ReturnType<typeof setTimeout>
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          pending.controller.abort()
          reject(new Error('Profile picture load timed out'))
        }, LOAD_TIMEOUT)
      })
      const publish = (source: string, owned: boolean) => {
        if (!current(key, ticket) || ticket.pending !== pending) return false
        if (ticket.source && ticket.sourceOwned) deps.revokeUrl(ticket.source)
        ticket.source = source
        ticket.sourceOwned = owned
        ticket.restored = false
        ticket.refreshFailed = false
        if (owned) pending.source = undefined
        return true
      }
      try {
        let blob: Blob
        try {
          const response = await Promise.race([
            deps.fetch(lease.url, {
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
              signal: pending.controller.signal,
            }),
            timedOut,
          ])
          if (!current(key, ticket) || ticket.pending !== pending) return false
          if (!response.ok) {
            return failure(key, [401, 403, 404].includes(response.status), ticket)
          }
          blob = await Promise.race([response.blob(), timedOut])
        } catch (error) {
          if (!current(key, ticket) || ticket.pending !== pending) return false
          if (pending.controller.signal.aborted) throw error
          // A forwarded/local origin may display the gateway's no-cors image
          // even when fetch cannot read it. Preserve that existing capability.
          // Explicit HTTP refusals return above and never take this fallback.
          await Promise.race([deps.decode(lease.url), timedOut])
          return publish(lease.url, false)
        }
        if (!current(key, ticket) || ticket.pending !== pending) return false
        pending.source = deps.createUrl(blob)
        await Promise.race([deps.decode(pending.source), timedOut])
        const ready = publish(pending.source, true)
        if (ready) persistent?.put(key, blob)
        return ready
      } catch {
        if (!current(key, ticket) || ticket.pending !== pending) return false
        return failure(key, false, ticket)
      } finally {
        clearTimeout(timeout)
        if (pending.source) deps.revokeUrl(pending.source)
        if (ticket.pending === pending) ticket.pending = undefined
      }
    },
    clear() {
      for (const entry of entries.values()) release(entry)
      entries.clear()
      restoreGeneration++
    },
  }
}
