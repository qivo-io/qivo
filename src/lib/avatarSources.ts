import { MIB } from '../../convex/lib/limits'
import type { AvatarImageCache } from './avatarImageCache'
import { AVATAR_TYPES, avatarImage } from './images'

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
      fits, so one kept picture decodes to at most 256 KiB of pixels. One
      past pictureBytes is not decoded before its re-encode, and a
      re-encode that could not run is tried once more RETRY_DELAY later
      before the picture stays as initials.
    - `keptBytes`: the bytes all kept pictures hold together. The design
      size's 1,000 pictures of 10 to 30 KB fit. Past it, a picture an open
      view names takes the room of the held picture shown least recently
      that no view names, and waits as the person's initials, in the named
      order, only while every held picture is named. A waiting picture
      keeps the lease it was minted with and starts by itself once room
      frees.
    The store asks only for the caller's own pictures and those its open
    pages, pickers and views name (`named`, store/planner.ts). Measured on
    the benchmark page (scripts/perf, people=1000&pictures=1 at 1440 by
    1000, each picture a 20 KB PNG answered after 150 ms, 7 November 2026),
    against the store that asked for every picture of its roster:
    - The Board of 100 tasks: 1 mint call of 100 people, 100 downloads,
      2.0 MB kept, 13.3 MiB of JS heap, the first 25 pictures 1.4 s after
      the page opened; before, 10 mint calls, 1,000 downloads, 20.2 MB,
      14.6 MiB and 6.7 s.
    - Settings › Users' first page: 1 mint call of 25 people, 25 downloads,
      0.5 MB kept, 15.3 MiB, the 25 pictures after 1.3 s; before, 10 mint
      calls, 1,000 downloads, 20.2 MB, 16.4 MiB and 0.9 s, because that
      store minted from boot, before the page's rows arrived.
    - Leaving that page while each picture took 1.5 s: of the 22 people
      only it showed, the 5 downloads already running finished and no other
      was minted or downloaded until the page opened again.
    - With keptBytes lowered to 600 KB, after Settings › Users kept 17
      pictures, the Board took their room for 15 of its own and showed 14
      pictures among its 84 people; before, it downloaded none and showed 2. */
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
  /** its re-encode could not run once, so the next failure is final */
  shrinkFailed?: boolean
  /** its download: `slotted` once it holds a download slot, `dropped`
      when no view names its key any more while it waited for one */
  pending?: { controller: AbortController; source?: string; slotted: boolean; dropped: boolean }
}

type Dependencies = {
  now: () => number
  fetch: typeof fetch
  createUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  /** decodes the image at `url`, answering its size ({ width, height })
      when it can tell; any other answer means the size is unknown */
  decode: (url: string) => Promise<unknown>
  /** re-encodes a picture that passes the bounds, as an upload does.
      Answers `blob` itself when it can never be re-encoded (a type the
      browser's re-encode does not read), and rejects when the re-encode
      could not run this time. */
  shrink: (blob: Blob) => Promise<Blob>
  /** a picture the source started by itself, when room freed, now shows,
      or one whose lease ran out while it waited for a slot needs a mint
      now; either way the store rebuilds */
  changed: () => void
}

/** Portrait bytes, keyed by profile AND storage version. A renewed lease
 * confirms access without downloading an unchanged image. Prepared blob URLs
 * survive view remounts; decoded bytes may also be restored from the optional
 * account-scoped persistent cache. Signed URLs never go into persistence.
 *
 * `sync` gives the keys the store knows, every profile it holds or has a
 * face of with a picture, which the entries follow, and `named` the keys
 * the open views name, in their order, the only ones the store mints,
 * renews and downloads. A key no view names any more leaves the waiting
 * pictures, and its prepare still waiting for a download slot is dropped;
 * a download on its way finishes. A held picture no view names is not
 * renewed: past its lease and STALE_GRACE it shows no more (`url` answers
 * null) but keeps its bytes, counted in the kept bytes and the first to go
 * when a named picture needs room, the one shown least recently first.
 * Named again, one mint shows it with no download.
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
    shrink: async (blob) => {
      const type = blob.type.toLowerCase().split(';')[0]?.trim() ?? ''
      if (
        !(AVATAR_TYPES as readonly string[]).includes(type) ||
        typeof createImageBitmap !== 'function'
      )
        return blob
      const file = new File([blob], 'picture', { type: blob.type })
      const shrunk = await avatarImage(file)
      // avatarImage hands back its input when the re-encode failed
      if (shrunk === file) throw new Error('Profile picture could not be re-encoded')
      return shrunk
    },
    changed: () => {},
    ...overrides,
  }
  const entries = new Map<string, Entry>()
  let persistent: AvatarImageCache | null = null
  let restoreGeneration = 0
  // whether the boot's restore ran, after which a key that becomes known
  // is restored on its own
  let restoredAll = false
  let paused = false
  // the keys the open views name, and when each other key was last named
  let namedKeys: ReadonlySet<string> = new Set()
  const shownAt = new Map<string, number>()
  let shownTick = 0
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
  /* Frees room for `bytes` by releasing the held pictures no view names,
     the one shown least recently first, and answers whether it fits now.
     A named picture is never released for room. */
  const makeRoom = (bytes: number) => {
    if (roomFor(bytes)) return true
    const spare = [...entries]
      .filter(([key, entry]) => entry.bytes > 0 && !entry.pending && !namedKeys.has(key))
      .sort(([a], [b]) => (shownAt.get(a) ?? 0) - (shownAt.get(b) ?? 0))
    for (const [, entry] of spare) {
      if (roomFor(bytes)) break
      release(entry)
    }
    return roomFor(bytes)
  }
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
        if (!makeRoom(AVATAR_SOURCES.pictureBytes)) return
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
    // a held picture past its grace that no view named shows no more; its
    // renewal shows it again
    const hidden = !!ticket.source && !ticket.restored && expired(ticket)
    ticket.expiresAt = lease.exp * 1000
    ticket.retryAt = 0
    // The storage version is immutable. Keep the decoded source when only
    // its access token changes, including across a route's React remount.
    if (ticket.source && ticket.sourceOwned) {
      ticket.restored = false
      ticket.refreshFailed = false
      return hidden
    }
    if (ticket.pending || ticket.tooLarge) return false
    // a picture no open view names downloads nothing
    if (!namedKeys.has(key)) return false
    // a named picture takes the room of a held one no view names; with
    // every held picture named it waits, in the named order, as initials
    if (!ticket.source && !makeRoom(AVATAR_SOURCES.pictureBytes)) {
      ticket.waiting = { due: false, lease }
      if (!waitingKeys.has(key)) waitingKeys.set(key, ticket)
      return false
    }
    ticket.waiting = undefined
    waitingKeys.delete(key)
    const pending = {
      controller: new AbortController(),
      source: undefined as string | undefined,
      slotted: false,
      dropped: false,
    }
    ticket.pending = pending
    let slot = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const queued = takeSlot(pending.controller.signal)
      if (queued) await queued
      slot = true
      pending.slotted = true
      if (!current(key, ticket) || ticket.pending !== pending) return false
      // a lease that ran out while it waited for a slot, as through a
      // hidden page, is minted again now, not taken to the gateway for a
      // refusal and not left for the next sweep
      if (queued && lease.exp * 1000 <= deps.now()) {
        ticket.refreshFailed = true
        ticket.retryAt = 0
        deps.changed()
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
      // a picture past pictureBytes is re-encoded whatever its size, so it
      // is not decoded first
      let size: unknown = null
      if (blob.size <= AVATAR_SOURCES.pictureBytes) {
        pending.source = deps.createUrl(blob)
        size = await Promise.race([deps.decode(pending.source), timedOut])
      }
      if (!fits(blob, size)) {
        // a legacy picture: re-encoded as an upload is, kept only if it fits
        let shrunk: Blob
        try {
          shrunk = await Promise.race([deps.shrink(blob), timedOut])
        } catch (error) {
          if (!current(key, ticket) || ticket.pending !== pending) return false
          if (pending.controller.signal.aborted) throw error
          // could not run: tried again once after RETRY_DELAY, then final
          if (ticket.shrinkFailed) {
            ticket.tooLarge = true
            return false
          }
          ticket.shrinkFailed = true
          throw error
        }
        if (!current(key, ticket) || ticket.pending !== pending) return false
        if (pending.source) deps.revokeUrl(pending.source)
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
      // dropped while it waited for a slot: no failure, and the store mints
      // it again once a view names it
      if (pending.dropped) return false
      return failure(key, false, ticket)
    } finally {
      clearTimeout(timeout)
      if (pending.source) deps.revokeUrl(pending.source)
      if (ticket.pending === pending) ticket.pending = undefined
      if (slot) freeSlot()
    }
  }

  /* Restores the persistent cache's pictures of `keys` that hold no
     source yet, answering whether any shows now. */
  const restoreKeys = async (keys: readonly string[]): Promise<boolean> => {
    const cache = persistent
    if (!cache) return false
    const generation = restoreGeneration
    const work = keys.map(async (key) => {
      const entry = entries.get(key)
      if (!entry) return false
      let blob: Blob | null
      try {
        blob = await cache.read(key)
      } catch {
        return false
      }
      if (!blob || generation !== restoreGeneration || entries.get(key) !== entry || entry.source)
        return false
      if (blob.size > AVATAR_SOURCES.pictureBytes) {
        cache.remove(key)
        return false
      }
      if (!roomFor(blob.size)) return false
      const source = deps.createUrl(blob)
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Profile picture restore timed out')), 750)
      })
      let size: unknown
      try {
        size = await Promise.race([deps.decode(source), timedOut])
      } catch {
        deps.revokeUrl(source)
        cache.remove(key)
        return false
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      if (!fits(blob, size)) {
        deps.revokeUrl(source)
        cache.remove(key)
        return false
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
  }

  return {
    /** Follows the keys the store knows (`keys`), every profile it holds
        or has a face of with a picture, beside `without`, the profiles it
        knows with none, which the persistent cache prunes by
        (avatarImageCache.ts sync). Removing or replacing a key fences every
        pending response. A key that becomes known after the boot's restore
        is restored from the persistent cache on its own. */
    sync(keys: Iterable<string>, without: Iterable<string> = []) {
      const wanted = new Set(keys)
      persistent?.sync(wanted, without)
      for (const [key, entry] of entries) {
        if (wanted.has(key)) continue
        entries.delete(key)
        waitingKeys.delete(key)
        shownAt.delete(key)
        release(entry)
      }
      const added: string[] = []
      for (const key of wanted)
        if (!entries.has(key)) {
          entries.set(key, newEntry())
          added.push(key)
        }
      admit()
      if (restoredAll && added.length > 0 && persistent)
        void restoreKeys(added).then((shown) => {
          if (shown) deps.changed()
        })
    },
    /** Follows the keys the open views name, in their order, which the
        store mints, renews and downloads. Each named key counts as shown
        now; a key keeps the moment its last view let it go. A key no view
        names any more leaves the waiting pictures, and its prepare still
        waiting for a download slot is dropped. */
    named(keys: readonly string[]) {
      const next = new Set(keys)
      shownTick++
      for (const key of namedKeys) if (!next.has(key)) shownAt.set(key, shownTick)
      for (const key of next) shownAt.delete(key)
      namedKeys = next
      // the waiting pictures follow the named order
      const waiting = new Map<string, Entry>()
      for (const key of keys) {
        const entry = waitingKeys.get(key)
        if (entry) waiting.set(key, entry)
      }
      for (const [key, entry] of waitingKeys) if (!waiting.has(key)) entry.waiting = undefined
      waitingKeys.clear()
      for (const [key, entry] of waiting) waitingKeys.set(key, entry)
      for (const [key, entry] of entries) {
        if (next.has(key) || !entry.pending || entry.pending.slotted) continue
        entry.pending.dropped = true
        entry.pending.controller.abort()
      }
      admit()
    },
    setPersistent(cache: AvatarImageCache | null) {
      if (persistent === cache) return
      const previous = persistent
      persistent = cache
      restoreGeneration++
      previous?.dispose()
    },
    /** Shows the persistent cache's pictures of the keys known at boot, at
        most its 128 entries at once, each counted in the kept bytes,
        before their leases renew. A cached picture past pictureBytes or
        pictureEdge, as an older app kept, leaves the cache instead and
        downloads and re-encodes as any picture does. A restored picture
        renews once a view names it. */
    restore(): Promise<boolean> {
      restoredAll = true
      return restoreKeys([...entries.keys()])
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
    /** The source to show for `key`, or null. A held picture past its
        lease and STALE_GRACE shows no more: released when a view names it,
        kept for a later renewal when none does. */
    url(key: string) {
      const entry = entries.get(key)
      if (!entry) return null
      if (!paused && !entry.restored && expired(entry)) {
        if (!namedKeys.has(key)) return null
        release(entry)
      }
      return entry.source
    },
    /** Releases the named pictures past their grace, answering whether any
        went. One no view names keeps its bytes (url). */
    expire() {
      if (paused) return false
      let changed = false
      for (const [key, entry] of entries) {
        if (!entry.source || !expired(entry) || !namedKeys.has(key)) continue
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
    /** Drops every picture and what is on its way, for sign-out, a demo's
        end and reinitialization. The waiting keys go first, so the room
        each release frees starts no download with the old session's lease. */
    clear() {
      waitingKeys.clear()
      namedKeys = new Set()
      shownAt.clear()
      restoredAll = false
      const all = [...entries.values()]
      entries.clear()
      for (const entry of all) {
        entry.waiting = undefined
        release(entry)
      }
      restoreGeneration++
    },
  }
}
