import { MIB } from '../../convex/lib/limits'
import type { AvatarImageCache } from './avatarImageCache'
import { avatarImage } from './images'

const REFRESH_SKEW = 120_000
const RETRY_DELAY = 30_000
const STALE_GRACE = 10 * 60_000
const LOAD_TIMEOUT = 15_000

/** The bounds on profile pictures, an object the tests lower.
    - `downloads`: pictures downloading at once.
    - `pictureBytes` and `pictureEdge`: the most bytes and pixels on the
      longest edge one kept picture holds. The app uploads 256-pixel WebP
      of normally 10 to 30 KB (lib/images.ts avatarImage), so only a legacy
      picture an older browser could not re-encode passes them. Such a
      picture is re-encoded the same way, and kept only when the result
      fits, so one kept picture decodes to at most 256 KiB of pixels.
    - `keptBytes`: the bytes all kept pictures hold together. The design
      size's 1,000 pictures of 10 to 30 KB fit. Past it, a picture that
      would need room waits as the person's initials instead of evicting
      another, because while the store asks for its whole roster every
      picture is wanted at once.
    MEASURED_PICTURES */
export const AVATAR_SOURCES = {
  downloads: 6,
  pictureBytes: 256 * 1024,
  pictureEdge: 256,
  keptBytes: 32 * MIB,
}

type Lease = { url: string; exp: number }
type Size = { width: number; height: number }
type Entry = {
  source: string | null
  sourceOwned: boolean
  /** the bytes the source holds, counted in the kept bytes */
  bytes: number
  refreshFailed: boolean
  expiresAt: number
  retryAt: number
  restored?: boolean
  /** waiting for room in the kept bytes with its lease, `due` once room
      freed and its lease ran out, so the store mints it again */
  waiting?: { due: boolean; lease: Lease }
  /** too large even re-encoded, so initials until the version changes */
  tooLarge?: boolean
  pending?: { controller: AbortController; source?: string }
}

type Dependencies = {
  now: () => number
  fetch: typeof fetch
  createUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  /** decodes the image at `url`, answering its size ({ width, height })
      when it can tell; any other answer means the size is unknown */
  decode: (url: string) => Promise<unknown>
  /** re-encodes a picture that passes the bounds, as an upload does */
  shrink: (blob: Blob) => Promise<Blob>
  /** a picture the source started by itself, when room freed, now shows */
  changed: () => void
}

/** Portrait bytes, keyed by profile AND storage version. A renewed lease
 * confirms access without downloading an unchanged image. Prepared blob URLs
 * survive view remounts; decoded bytes may also be restored from the optional
 * account-scoped persistent cache. Signed URLs never go into persistence.
 *
 * AVATAR_SOURCES bounds the downloads at once, each kept picture and the
 * bytes kept in all. pause(true) holds everything while the page is hidden:
 * nothing renews, downloads or is released, and on return a held picture
 * past its renewal shows until its renewal answers, at most STALE_GRACE. */
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
      return { width: image.naturalWidth, height: image.naturalHeight }
    },
    shrink: (blob) => avatarImage(new File([blob], 'picture', { type: blob.type })),
    changed: () => {},
    ...overrides,
  }
  const entries = new Map<string, Entry>()
  let persistent: AvatarImageCache | null = null
  let restoreGeneration = 0
  let paused = false
  // the bytes kept sources hold, and the downloads on their way, each
  // counted at pictureBytes until it is known
  let kept = 0
  let downloading = 0
  let mostDownloading = 0
  // keys waiting for room, in the order the store asked for them
  const waitingKeys = new Map<string, Entry>()
  // prepares waiting for a download slot, in order
  const slotQueue: { grant: () => void; signal: AbortSignal }[] = []

  /* The bytes the kept pictures and every download on its way or waiting
     for a slot may hold, each download counted at pictureBytes. */
  const held = () => kept + (downloading + slotQueue.length) * AVATAR_SOURCES.pictureBytes
  const roomFor = (bytes: number) => held() + bytes <= AVATAR_SOURCES.keptBytes
  /* Starts the waiting keys, in order, while room remains for them: with
     the lease each waits with while it lasts, else marked due so the
     store mints it again. A picture started here tells the store through
     `changed` once it shows. */
  let admitting = false
  const admit = () => {
    if (admitting || paused) return
    admitting = true
    try {
      for (const [key, entry] of waitingKeys) {
        if (held() + AVATAR_SOURCES.pictureBytes > AVATAR_SOURCES.keptBytes) return
        if (entries.get(key) !== entry || !entry.waiting) {
          waitingKeys.delete(key)
          continue
        }
        if (entry.waiting.due) continue
        const { lease } = entry.waiting
        if (lease.exp * 1000 - deps.now() > REFRESH_SKEW) {
          void prepare(key, lease, entry).then((shown) => {
            if (shown) deps.changed()
          })
        } else entry.waiting.due = true
      }
    } finally {
      admitting = false
    }
  }
  const setSource = (entry: Entry, source: string | null, owned: boolean, bytes: number) => {
    if (entry.source && entry.sourceOwned) deps.revokeUrl(entry.source)
    kept -= entry.bytes
    entry.source = source
    entry.sourceOwned = owned
    entry.bytes = source ? bytes : 0
    kept += entry.bytes
  }
  const release = (entry: Entry) => {
    entry.pending?.controller.abort()
    if (entry.pending?.source) {
      deps.revokeUrl(entry.pending.source)
      entry.pending.source = undefined
    }
    entry.pending = undefined
    const freed = entry.bytes > 0
    setSource(entry, null, false, 0)
    entry.restored = false
    if (freed) admit()
  }
  /* Grants a download slot at once when one is free (null), else a
     promise of it, which rejects once `signal` aborts. */
  const takeSlot = (signal: AbortSignal): Promise<void> | null => {
    if (downloading < AVATAR_SOURCES.downloads && !paused && slotQueue.length === 0) {
      downloading++
      mostDownloading = Math.max(mostDownloading, downloading)
      return null
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', leave)
          downloading++
          mostDownloading = Math.max(mostDownloading, downloading)
          resolve()
        },
      }
      const leave = () => {
        const at = slotQueue.indexOf(waiter)
        if (at >= 0) slotQueue.splice(at, 1)
        admit()
        reject(new Error('Profile picture no longer wanted'))
      }
      signal.addEventListener('abort', leave, { once: true })
      slotQueue.push(waiter)
    })
  }
  const pump = () => {
    while (!paused && downloading < AVATAR_SOURCES.downloads && slotQueue.length) {
      slotQueue.shift()?.grant()
    }
  }
  const freeSlot = () => {
    downloading--
    pump()
    admit()
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
  const newEntry = (): Entry => ({
    source: null,
    sourceOwned: false,
    bytes: 0,
    refreshFailed: false,
    expiresAt: 0,
    retryAt: 0,
  })
  const largest = (size: unknown) => {
    const { width, height } = (size ?? {}) as Partial<Size>
    return typeof width === 'number' && typeof height === 'number' ? Math.max(width, height) : 0
  }
  const fits = (blob: Blob, size: unknown) =>
    blob.size <= AVATAR_SOURCES.pictureBytes && largest(size) <= AVATAR_SOURCES.pictureEdge

  /* Downloads and keeps the picture of `key` with `lease`, unless it is
     held already, too large, or past the kept bytes, where it waits with
     its lease until admit() starts it. */
  const prepare = async (
    key: string,
    lease: Lease,
    ticket = entries.get(key),
  ): Promise<boolean> => {
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
    if (ticket.pending || ticket.tooLarge) return false
    // start no download while the kept bytes and one more picture would
    // pass the budget; the key waits, in order, as initials
    if (!ticket.source && !roomFor(AVATAR_SOURCES.pictureBytes)) {
      ticket.waiting = { due: false, lease }
      if (!waitingKeys.has(key)) waitingKeys.set(key, ticket)
      return false
    }
    ticket.waiting = undefined
    waitingKeys.delete(key)
    const pending = { controller: new AbortController(), source: undefined as string | undefined }
    ticket.pending = pending
    let slot = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const queued = takeSlot(pending.controller.signal)
      if (queued) await queued
      slot = true
      if (!current(key, ticket) || ticket.pending !== pending) return false
      // a lease that ran out while it waited for a slot is minted again,
      // not taken to the gateway for a refusal
      if (queued && lease.exp * 1000 <= deps.now()) {
        ticket.refreshFailed = true
        return false
      }
      // the load's time starts with its download, not in the queue
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          pending.controller.abort()
          reject(new Error('Profile picture load timed out'))
        }, LOAD_TIMEOUT)
      })
      const publish = (source: string, owned: boolean, bytes: number) => {
        if (!current(key, ticket) || ticket.pending !== pending) return false
        setSource(ticket, source, owned, bytes)
        ticket.restored = false
        ticket.refreshFailed = false
        if (owned) pending.source = undefined
        return true
      }
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
          const refused = [401, 403, 404].includes(response.status)
          // a refused picture leaves the persistent cache too, or the
          // next boot would show it again before any mint
          if (refused) persistent?.remove(key)
          return failure(key, refused, ticket)
        }
        blob = await Promise.race([response.blob(), timedOut])
      } catch (error) {
        if (!current(key, ticket) || ticket.pending !== pending) return false
        if (pending.controller.signal.aborted) throw error
        // A forwarded/local origin may display the gateway's no-cors image
        // even when fetch cannot read it. Preserve that existing capability.
        // Explicit HTTP refusals return above and never take this fallback.
        // Its bytes cannot be read, so they count as one whole picture.
        await Promise.race([deps.decode(lease.url), timedOut])
        return publish(lease.url, false, AVATAR_SOURCES.pictureBytes)
      }
      if (!current(key, ticket) || ticket.pending !== pending) return false
      pending.source = deps.createUrl(blob)
      let size = await Promise.race([deps.decode(pending.source), timedOut])
      if (!fits(blob, size)) {
        // a legacy picture: re-encoded as an upload is, kept only if it fits
        const shrunk = await Promise.race([deps.shrink(blob), timedOut])
        if (!current(key, ticket) || ticket.pending !== pending) return false
        deps.revokeUrl(pending.source)
        pending.source = undefined
        if (shrunk !== blob) {
          pending.source = deps.createUrl(shrunk)
          size = await Promise.race([deps.decode(pending.source), timedOut])
        }
        if (shrunk === blob || !fits(shrunk, size)) {
          if (!current(key, ticket) || ticket.pending !== pending) return false
          ticket.tooLarge = true
          return false
        }
        blob = shrunk
      }
      const ready = publish(pending.source, true, blob.size)
      if (ready) persistent?.put(key, blob)
      return ready
    } catch {
      if (!current(key, ticket) || ticket.pending !== pending) return false
      return failure(key, false, ticket)
    } finally {
      clearTimeout(timeout)
      if (pending.source) deps.revokeUrl(pending.source)
      if (ticket.pending === pending) ticket.pending = undefined
      if (slot) freeSlot()
    }
  }

  return {
    /** Removing/replacing a roster entry fences every pending response. */
    sync(keys: Iterable<string>) {
      const wanted = new Set(keys)
      persistent?.sync(wanted)
      for (const [key, entry] of entries) {
        if (wanted.has(key)) continue
        entries.delete(key)
        waitingKeys.delete(key)
        release(entry)
      }
      for (const key of wanted) if (!entries.has(key)) entries.set(key, newEntry())
      admit()
    },
    setPersistent(cache: AvatarImageCache | null) {
      if (persistent === cache) return
      const previous = persistent
      persistent = cache
      restoreGeneration++
      previous?.dispose()
    },
    /** Shows the persistent cache's pictures, at most its 128 entries at
        once, each counted in the kept bytes, before their leases renew. */
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
        if (!roomFor(blob.size)) return false
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
        if (
          generation !== restoreGeneration ||
          entries.get(key) !== entry ||
          entry.source ||
          !roomFor(blob.size)
        ) {
          deps.revokeUrl(source)
          return false
        }
        setSource(entry, source, true, blob.size)
        entry.restored = true
        entry.waiting = undefined
        entry.expiresAt = Number.POSITIVE_INFINITY
        entry.refreshFailed = false
        return true
      })
      return (await Promise.all(work)).some(Boolean)
    },
    ticket: (key: string) => entries.get(key),
    /** Whether the store should mint `key` again now. Never while the page
        is hidden, while it is on its way, while it waits for room that has
        not freed, or once it proved too large. */
    needsRefresh(key: string) {
      const entry = entries.get(key)
      return (
        !!entry &&
        !paused &&
        !entry.pending &&
        !entry.tooLarge &&
        (!entry.waiting || entry.waiting.due) &&
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
      if (!paused && !entry.restored && expired(entry)) release(entry)
      return entry.source
    },
    expire() {
      if (paused) return false
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
    /** Holds every picture while the page is hidden, and on return makes
        each held one past its renewal due at once, shown until its renewal
        answers and released STALE_GRACE after the return if it never does. */
    pause(hidden: boolean) {
      if (paused === hidden) return
      paused = hidden
      if (hidden) return
      const now = deps.now()
      for (const entry of entries.values()) {
        if (!entry.source || entry.restored || entry.expiresAt - now > REFRESH_SKEW) continue
        entry.expiresAt = Math.max(entry.expiresAt, now)
        entry.retryAt = 0
      }
      pump()
      admit()
    },
    /** The bytes the kept pictures hold, for the tests and the measurement. */
    keptBytes: () => kept,
    /** Downloads on their way, and the most at once, for the tests and the
        measurement. */
    downloading: () => downloading,
    mostDownloading: () => mostDownloading,
    prepare,
    clear() {
      for (const entry of entries.values()) release(entry)
      entries.clear()
      waitingKeys.clear()
      restoreGeneration++
    },
  }
}
