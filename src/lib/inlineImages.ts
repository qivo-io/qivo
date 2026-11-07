/* The images a task description or a comment shows, loaded only near the
   visible part of their window. One loader a store keeps one entry an
   attachment id, shared by every window that shows it: its bytes as a
   blob URL, its recorded size and its lease. The loader mints through the
   store's mint queue (lib/mintQueue.ts) behind the store's row gate, at
   most INLINE_IMAGES.downloads downloads run at once, and the bytes of
   images out of reach stay within INLINE_IMAGES.cacheBytes. A download
   that receives nothing for INLINE_IMAGES.stall gives its slot back and
   tries again later, and one whose views all went far stops after
   INLINE_IMAGES.leave, so a stalled or abandoned download never keeps a
   slot a near image needs. External images take their source only near
   view, a few at a time in their own pool. Nothing new starts while the
   page is hidden.

   Access. A cached image shows again only after the store's row gate
   passes for it, and after a mint names it again once its lease is within
   INLINE_IMAGES.skew of its end; that mint downloads nothing. A mint that
   omits it, or a gateway refusal (401, 403 or 404) right after a fresh
   mint, marks it gone and drops its bytes. A network failure is no
   refusal: the image tries again later. The store drops an entry wherever
   it forgets the file, and clear() drops them all with the store. One the
   row gate marked gone while a view showed it asks again once the gate
   passes (retain). */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MIB } from '../../convex/lib/limits'
import type { MintOutcome } from './mintQueue'

/** The loader's bounds, an object the tests lower.
    - `downloads`: description and comment images downloading at once,
      across the app.
    - `external`: external images loading at once, in their own pool so a
      slow host never holds the slots the task's own images need.
    - `cacheBytes`: the bytes kept for images out of reach, least recently
      shown first out. Images near view are never evicted, so the bytes
      held are those of the images a few screens of open windows show, plus
      at most this.
    - `near` and `far`: an image is near while it lies within `near` times
      its scrolling window's height of the visible part, and far once it
      lies more than `far` times that height away. A near image loads and
      shows; a far one shows a placeholder of its recorded size.
    - `retry`: how long a failed mint or download waits before it tries
      again, while the image stays near.
    - `stall`: how long a download may go without receiving a byte, or
      its decode may take, before it stops, gives its slot back and tries
      again later. It bounds the time without progress, not the whole
      download, so a large image on a slow link that keeps arriving is
      never cut off: a 20 MiB attachment at 256 kbit/s takes about 11
      minutes and goes on. A plain-URL fallback, whose progress cannot be
      seen, gives its slot back after the same time and goes on loading.
    - `leave`: how long a download whose views all went far or unmounted
      goes on before it stops and gives its slot to a near image, so a
      quick scroll back keeps it.
    - `externalTimeout`: how long an external image may load before it
      shows as unavailable, with a retry.
    - `skew`: how long before its lease ends a cached image needs a mint
      that names it again before it shows again.
    Measured on the benchmark page (images=100, photos of 1,200 by 800 and
    143 KB answered after 150 ms, the description scrolling in its own box
    of 258 pixels at 1440 by 1000): 2 images asked for with the window at
    its top, at most 3 downloads at once (4 at 390 by 844), 18 downloads
    while scrolling to the end in steps, then 2.3 MB kept out of reach and
    0.3 MB near after scrolling back, with a JS heap of 14 MB. Six images
    of 4,096 pixels (3.5 MB each) kept 20.9 MB in all, inside cacheBytes.
    On a local backend the app before this asked for that task's 100
    images in 100 calls as it opened, with 99 downloads at once; this one
    asked for 2. */
export const INLINE_IMAGES = {
  downloads: 4,
  external: 4,
  cacheBytes: 64 * MIB,
  near: 1,
  far: 3,
  retry: 5_000,
  stall: 30_000,
  leave: 2_000,
  externalTimeout: 15_000,
  skew: 120_000,
}

type Size = { width: number; height: number }

/** What a view of one attachment shows. `waiting` and `loading` both show
    "Loading image…" in a box of `box`, `renewing` shows the bytes only to
    a view already showing them, `ready` shows `url` and `gone` shows
    "Image unavailable". */
export type InlineImage = {
  state: 'waiting' | 'loading' | 'renewing' | 'ready' | 'gone'
  url: string | null
  box: Size | null
}

type Observer = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>
/** Builds an IntersectionObserver, injected so the tests can drive reach. */
export type ObserverFactory = (
  receive: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void,
  options: IntersectionObserverInit,
) => Observer

type Dependencies = {
  /** a lease for attachment `id`, behind the store's row gate; `fresh`
      skips any lease the store keeps */
  mint: (id: string, fresh: boolean) => Promise<MintOutcome>
  /** the store's row gate: whether it still holds or names attachment `id` */
  held: (id: string) => boolean
  fetch: typeof fetch
  createUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  /** decodes the image at `url` and answers its size */
  measure: (url: string) => Promise<Size>
  observer: ObserverFactory | null
  /** the nearest scrolling ancestor of `element`, its reach's root */
  rootOf: (element: Element) => Element | null
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

/* Where an entry's bytes are: none yet (`idle`), waiting for a download
   slot (`queued`), downloading (`loading`), held (`ready`) or refused
   (`gone`). */
type Phase = 'idle' | 'queued' | 'loading' | 'ready' | 'gone'
type Entry = {
  id: string
  phase: Phase
  /** a mint is on its way */
  minting: boolean
  /** held bytes whose lease needs a mint before a new view shows them */
  renewing: boolean
  url: string | null
  owned: boolean
  bytes: number
  box: Size | null
  /** the lease's end, in ms */
  exp: number
  /** the minted URL a queued download fetches */
  leaseUrl: string | null
  pins: number
  /** a gateway refusal took one fresh mint and no download has succeeded
      since, so the next refusal marks it gone */
  refusedOnce: boolean
  /** the plain-URL fallback waits for its view to report its <img> */
  fallbackSlot: boolean
  /** gives back the download slot the entry holds, once: its download's,
      or the plain-URL fallback's until its view reports */
  slot: (() => void) | null
  controller: AbortController | null
  retry: unknown
  /** the time left to a download whose views all went far (`leave`) */
  leaving: unknown
  /** gone because the store's row gate failed, so a later rebuild whose
      gate passes asks again */
  gated: boolean
  shown: InlineImage
  listeners: Set<() => void>
}

const WAITING: InlineImage = { state: 'waiting', url: null, box: null }

/* The nearest ancestor that scrolls, or null for the page. */
function scrollRoot(element: Element): Element | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return at
  }
  return null
}

/* The body of `response` as a blob, calling `progress` as each part
   arrives, so a download that keeps receiving bytes is never taken for a
   stalled one. */
async function readBody(response: Response, progress: () => void): Promise<Blob> {
  const reader = response.body?.getReader()
  if (!reader) return response.blob()
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    progress()
  }
  return new Blob(parts, { type: response.headers.get('content-type') ?? '' })
}

async function measureImage(url: string): Promise<Size> {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty image')
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/** A loader of inline images. Every dependency is injected for the tests;
    the store passes `mint` and `held`. */
export function createInlineImages(
  overrides: Partial<Dependencies> & Pick<Dependencies, 'mint' | 'held'>,
) {
  const deps: Dependencies = {
    fetch: (input, init) => fetch(input, init),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    measure: measureImage,
    observer:
      typeof IntersectionObserver === 'undefined'
        ? null
        : (receive, options) => new IntersectionObserver(receive, options),
    rootOf: scrollRoot,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    ...overrides,
  }
  const entries = new Map<string, Entry>()
  // unpinned entries holding bytes, least recently unpinned first
  const unpinned = new Map<string, Entry>()
  let cachedBytes = 0
  let downloading = 0
  let mostDownloading = 0
  let generation = 0
  let paused = false
  const slotQueue: Entry[] = []
  const externalQueue: (() => void)[] = []
  let externalLoading = 0

  const publish = (entry: Entry) => {
    const box = entry.box
    const shown: InlineImage =
      entry.phase === 'gone'
        ? { state: 'gone', url: null, box }
        : entry.phase === 'ready' && entry.url
          ? { state: entry.renewing ? 'renewing' : 'ready', url: entry.url, box }
          : {
              state: entry.minting || entry.phase !== 'idle' ? 'loading' : 'waiting',
              url: null,
              box,
            }
    const before = entry.shown
    if (before.state === shown.state && before.url === shown.url && before.box === shown.box) return
    entry.shown = shown
    for (const listener of entry.listeners) listener()
  }
  const entryOf = (id: string) => {
    let entry = entries.get(id)
    if (!entry) {
      entry = {
        id,
        phase: 'idle',
        minting: false,
        renewing: false,
        url: null,
        owned: false,
        bytes: 0,
        box: null,
        exp: 0,
        leaseUrl: null,
        pins: 0,
        refusedOnce: false,
        fallbackSlot: false,
        slot: null,
        controller: null,
        retry: null,
        leaving: null,
        gated: false,
        shown: WAITING,
        listeners: new Set(),
      }
      entries.set(id, entry)
    }
    return entry
  }
  /* Forgets an entry nothing shows, waits for or listens to. */
  const tidy = (entry: Entry) => {
    if (
      entry.pins === 0 &&
      entry.listeners.size === 0 &&
      !entry.url &&
      !entry.minting &&
      (entry.phase === 'idle' || entry.phase === 'gone')
    )
      entries.delete(entry.id)
  }
  const forgetBytes = (entry: Entry) => {
    if (unpinned.delete(entry.id)) cachedBytes -= entry.bytes
    if (entry.url && entry.owned) deps.revokeUrl(entry.url)
    entry.url = null
    entry.owned = false
    entry.bytes = 0
    entry.renewing = false
  }
  const freeSlot = () => {
    downloading--
    pumpSlots()
  }
  /* Stops what the entry has on its way: a mint is fenced, a download
     aborts and gives its slot back, a queued one leaves the queue, a
     plain-URL fallback gives its slot back, and a retry is called off. */
  const stop = (entry: Entry) => {
    entry.minting = false
    entry.controller?.abort()
    entry.controller = null
    entry.slot?.()
    entry.fallbackSlot = false
    const at = slotQueue.indexOf(entry)
    if (at >= 0) slotQueue.splice(at, 1)
    if (entry.retry !== null) deps.clearTimer(entry.retry)
    entry.retry = null
    if (entry.leaving !== null) deps.clearTimer(entry.leaving)
    entry.leaving = null
    entry.leaseUrl = null
  }
  const gone = (entry: Entry) => {
    stop(entry)
    forgetBytes(entry)
    entry.phase = 'gone'
    entry.exp = 0
    publish(entry)
    tidy(entry)
  }
  /* Keeps the bytes of unpinned images within cacheBytes, least recently
     unpinned first out, keeping their recorded size. A pinned image is
     never in the list. */
  const enforce = () => {
    for (const entry of unpinned.values()) {
      if (cachedBytes <= INLINE_IMAGES.cacheBytes) return
      forgetBytes(entry)
      entry.phase = 'idle'
      entry.exp = 0
      publish(entry)
      tidy(entry)
    }
  }
  /* A failed mint or download: held bytes stay held but unrenewed, and
     the entry tries again later while a view keeps it near. With no view
     near it schedules nothing and is forgotten once nothing watches it;
     the next view asks again. */
  const retryLater = (entry: Entry) => {
    if (entry.phase !== 'ready') entry.phase = 'idle'
    publish(entry)
    if (entry.retry !== null) deps.clearTimer(entry.retry)
    entry.retry = null
    if (entry.pins === 0) return tidy(entry)
    entry.retry = deps.setTimer(() => {
      entry.retry = null
      if (entry.pins > 0) want(entry, false)
      else tidy(entry)
    }, INLINE_IMAGES.retry)
  }
  function pumpSlots() {
    while (!paused && downloading < INLINE_IMAGES.downloads && slotQueue.length) {
      const entry = slotQueue.shift() as Entry
      downloading++
      mostDownloading = Math.max(mostDownloading, downloading)
      void download(entry)
    }
  }
  const pumpExternal = () => {
    while (!paused && externalLoading < INLINE_IMAGES.external && externalQueue.length)
      externalQueue.shift()?.()
  }
  const lease = (entry: Entry, fresh: boolean) => {
    const version = generation
    entry.minting = true
    if (entry.retry !== null) deps.clearTimer(entry.retry)
    entry.retry = null
    publish(entry)
    void deps.mint(entry.id, fresh).then((outcome) => {
      if (version !== generation || entries.get(entry.id) !== entry || !entry.minting) return
      entry.minting = false
      if (outcome.state === 'missing' || outcome.state === 'refused') return gone(entry)
      if (outcome.state === 'failed') return retryLater(entry)
      entry.exp = outcome.lease.exp * 1000
      if (entry.phase === 'ready' && entry.owned) {
        // a renewal: the held bytes show again, nothing downloads
        entry.renewing = false
        publish(entry)
        return
      }
      if (entry.pins === 0 || paused) {
        // nothing shows it now; the next view asks again
        publish(entry)
        tidy(entry)
        return
      }
      entry.phase = 'queued'
      entry.leaseUrl = outcome.lease.url
      slotQueue.push(entry)
      publish(entry)
      pumpSlots()
    })
  }
  /* A gateway refusal: one fresh mint, then gone. With no view near or
     the page hidden, the fresh mint waits for the next view (want). */
  const refused = (entry: Entry) => {
    forgetBytes(entry)
    entry.exp = 0
    if (entry.refusedOnce) return gone(entry)
    entry.refusedOnce = true
    entry.phase = 'idle'
    if (entry.pins > 0 && !paused) return lease(entry, true)
    publish(entry)
    tidy(entry)
  }
  async function download(entry: Entry) {
    const version = generation
    const url = entry.leaseUrl as string
    entry.leaseUrl = null
    const controller = new AbortController()
    entry.controller = controller
    entry.phase = 'loading'
    publish(entry)
    const current = () =>
      version === generation && entries.get(entry.id) === entry && entry.controller === controller
    // The slot goes back once, whichever comes first: the end, an abort, a
    // stall or the plain-URL fallback's report. A clear let every slot go.
    let held = true
    const slot = () => {
      if (!held) return
      held = false
      if (entry.slot === slot) entry.slot = null
      if (version === generation) freeSlot()
    }
    entry.slot = slot
    // INLINE_IMAGES.stall without progress stops the download
    let stall: unknown = null
    const quiet = () => {
      if (stall !== null) deps.clearTimer(stall)
      stall = null
    }
    const arm = () => {
      quiet()
      stall = deps.setTimer(() => {
        stall = null
        if (!current()) return
        controller.abort()
        entry.controller = null
        slot()
        retryLater(entry)
      }, INLINE_IMAGES.stall)
    }
    try {
      arm()
      let response: Response
      try {
        response = await deps.fetch(url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
      } catch {
        if (!current() || controller.signal.aborted) return
        if (entry.pins === 0) {
          // No view will render the fallback <img> that would free the
          // slot, so the slot goes back now and the next view asks again.
          entry.controller = null
          entry.phase = 'idle'
          publish(entry)
          tidy(entry)
          return
        }
        // A forwarded or local origin may show the gateway's no-cors image
        // even when fetch cannot read it. The view's <img> loads the URL
        // and keeps the slot until it reports load or error, or for
        // INLINE_IMAGES.stall, after which it loads on uncounted. Its
        // bytes cannot be read, so they are not counted.
        entry.controller = null
        entry.url = url
        entry.owned = false
        entry.phase = 'ready'
        entry.fallbackSlot = true
        held = false
        const fallback = () => {
          if (entry.slot !== fallback) return
          entry.slot = null
          entry.fallbackSlot = false
          deps.clearTimer(timer)
          if (version === generation) freeSlot()
        }
        const timer = deps.setTimer(fallback, INLINE_IMAGES.stall)
        entry.slot = fallback
        publish(entry)
        return
      }
      if (!current()) return
      if (!response.ok) {
        entry.controller = null
        if ([401, 403, 404].includes(response.status)) return refused(entry)
        return retryLater(entry)
      }
      arm()
      const blob = await readBody(response, arm)
      if (!current()) return
      const source = deps.createUrl(blob)
      let size: Size
      try {
        arm()
        size = await deps.measure(source)
      } catch {
        deps.revokeUrl(source)
        if (!current()) return
        entry.controller = null
        return gone(entry)
      }
      if (!current()) {
        deps.revokeUrl(source)
        return
      }
      entry.controller = null
      entry.url = source
      entry.owned = true
      entry.bytes = blob.size
      entry.box = size
      entry.phase = 'ready'
      entry.renewing = false
      entry.refusedOnce = false
      if (entry.pins === 0) {
        unpinned.set(entry.id, entry)
        cachedBytes += entry.bytes
      }
      publish(entry)
      enforce()
    } catch {
      if (!current()) return
      entry.controller = null
      retryLater(entry)
    } finally {
      quiet()
      slot()
      // a download that ended needs no stop for its views going far
      if (entry.phase !== 'loading' && entry.leaving !== null) {
        deps.clearTimer(entry.leaving)
        entry.leaving = null
      }
    }
  }
  /* What a near entry needs next: nothing while it loads or shows within
     its lease, a mint before it shows held bytes past their lease, else a
     mint and a download, a fresh one while a refusal waits for it, so the
     store's lease the gateway refused is never taken again. `gate` asks
     the store's row gate first. */
  function want(entry: Entry, gate: boolean) {
    if (entry.phase === 'gone') return
    if (gate && !deps.held(entry.id)) {
      gone(entry)
      entry.gated = true
      return
    }
    if (paused || entry.minting) return
    if (entry.phase === 'queued' || entry.phase === 'loading') return
    if (entry.phase === 'ready' && entry.url) {
      if (entry.fallbackSlot) return
      if (!entry.renewing && entry.exp - deps.now() > INLINE_IMAGES.skew) return
      if (entry.owned) {
        entry.renewing = true
        return lease(entry, false)
      }
      // a plain-URL fallback holds no bytes to renew; it loads again
      entry.url = null
      entry.phase = 'idle'
    }
    lease(entry, entry.refusedOnce)
  }
  /* The store forgot attachment `id`. */
  const drop = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    stop(entry)
    forgetBytes(entry)
    entry.exp = 0
    entry.refusedOnce = false
    entry.gated = false
    entry.phase = 'idle'
    publish(entry)
    if (entry.pins > 0) want(entry, true)
    tidy(entry)
  }

  /* The reach of every observed element, by its scrolling root. */
  type Reach = {
    near: Observer
    far: Observer
    elements: Map<Element, (near: boolean) => void>
  }
  const roots = new Map<Element | null, Reach>()
  const reachOf = (root: Element | null, factory: ObserverFactory): Reach => {
    const known = roots.get(root)
    if (known) return known
    const elements = new Map<Element, (near: boolean) => void>()
    const margin = (times: number) => `${times * 100}% 0px ${times * 100}% 0px`
    const reach: Reach = {
      elements,
      near: factory(
        (seen) => {
          for (const e of seen) if (e.isIntersecting) elements.get(e.target)?.(true)
        },
        { root, rootMargin: margin(INLINE_IMAGES.near) },
      ),
      far: factory(
        (seen) => {
          for (const e of seen) if (!e.isIntersecting) elements.get(e.target)?.(false)
        },
        { root, rootMargin: margin(INLINE_IMAGES.far) },
      ),
    }
    roots.set(root, reach)
    return reach
  }

  return {
    /** Tells `receive` when `element` comes near (true) or goes far
        (false). Without IntersectionObserver every image is near at once.
        Answers the way to stop. */
    observe(element: Element, receive: (near: boolean) => void): () => void {
      const factory = deps.observer
      if (!factory) {
        receive(true)
        return () => {}
      }
      const root = deps.rootOf(element)
      const reach = reachOf(root, factory)
      reach.elements.set(element, receive)
      reach.near.observe(element)
      reach.far.observe(element)
      return () => {
        reach.elements.delete(element)
        reach.near.unobserve(element)
        reach.far.unobserve(element)
        if (reach.elements.size === 0 && roots.get(root) === reach) {
          reach.near.disconnect()
          reach.far.disconnect()
          roots.delete(root)
        }
      }
    },
    /** A view of attachment `id` came near: it loads, or shows its held
        bytes once the row gate passes and, past their lease, a mint names
        it again. A view joining one that already shows the bytes past
        their lease waits for that mint, which never hides them from the
        view already showing. */
    pin(id: string) {
      const entry = entryOf(id)
      entry.pins++
      if (entry.leaving !== null) deps.clearTimer(entry.leaving)
      entry.leaving = null
      if (unpinned.delete(id)) cachedBytes -= entry.bytes
      want(entry, true)
    },
    /** A view of attachment `id` went far or unmounted: once nothing shows
        it, its bytes join the cache of images out of reach, and a download
        on its way stops after INLINE_IMAGES.leave unless a view comes near
        again. */
    unpin(id: string) {
      const entry = entries.get(id)
      if (!entry || entry.pins === 0) return
      entry.pins--
      if (entry.pins > 0) return
      if (entry.fallbackSlot) {
        // nothing will report the plain-URL load any more
        entry.slot?.()
        entry.fallbackSlot = false
        entry.url = null
        entry.phase = 'idle'
      } else if (entry.phase === 'loading' && entry.leaving === null) {
        entry.leaving = deps.setTimer(() => {
          entry.leaving = null
          if (entry.pins > 0 || entry.phase !== 'loading') return
          // its slot goes to a near image; the late answer is fenced
          stop(entry)
          entry.phase = 'idle'
          publish(entry)
          tidy(entry)
        }, INLINE_IMAGES.leave)
      } else if (entry.phase === 'queued') {
        const at = slotQueue.indexOf(entry)
        if (at >= 0) slotQueue.splice(at, 1)
        entry.leaseUrl = null
        entry.phase = 'idle'
      }
      if (entry.retry !== null) {
        deps.clearTimer(entry.retry)
        entry.retry = null
      }
      if (entry.url && entry.owned) {
        unpinned.set(id, entry)
        cachedBytes += entry.bytes
        enforce()
      }
      publish(entry)
      tidy(entry)
    },
    /** The view's <img> of attachment `id` loaded, with its size, or failed
        (null). A plain-URL fallback frees its slot then. A failed fallback
        follows a fetch that threw, a network failure and no refusal, so it
        shows "Loading image…" and tries again later; a failed image of
        held bytes takes one fresh mint, then shows as gone. */
    loaded(id: string, size: Size | null) {
      const entry = entries.get(id)
      if (entry?.phase !== 'ready') return
      if (entry.fallbackSlot) entry.slot?.()
      if (size === null && !entry.owned) {
        entry.url = null
        entry.phase = 'idle'
        return retryLater(entry)
      }
      if (size === null) return refused(entry)
      // the plain-URL fallback loaded, which ends a refusal's fresh mint
      entry.refusedOnce = false
      if (!entry.box || entry.box.width !== size.width || entry.box.height !== size.height) {
        entry.box = size
        publish(entry)
      }
    },
    /** The attachment whose image shows at `url`, a blob: URL this loader
        made, or null, for a copy of a rendered image pasted into an
        editor. */
    attachmentOf(url: string): string | null {
      for (const entry of entries.values()) if (entry.url === url) return entry.id
      return null
    },
    /** What a view of attachment `id` shows. */
    snapshot(id: string): InlineImage {
      return entries.get(id)?.shown ?? WAITING
    },
    /** Calls `listener` when what attachment `id` shows changes. */
    watch(id: string, listener: () => void): () => void {
      const entry = entryOf(id)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        tidy(entry)
      }
    },
    /** The store forgot attachment `id`, a removal or its task leaving:
        its bytes and lease go, and a view still showing it asks again
        through the row gate. */
    drop,
    /** Drops the bytes of every image out of reach whose attachment fails
        the store's row gate `held`, as after a part delivery without it,
        and asks again for near images a clear or a pause left waiting, and
        for near ones the gate marked gone whose rows came back. */
    retain(held: (id: string) => boolean) {
      for (const [id, entry] of unpinned) if (!held(id) && entry.pins === 0) drop(id)
      for (const entry of entries.values()) {
        if (entry.pins === 0 || !held(entry.id)) continue
        if (entry.phase === 'gone' && entry.gated) {
          entry.phase = 'idle'
          entry.gated = false
          entry.refusedOnce = false
        }
        if (entry.phase === 'idle' && !entry.minting && entry.retry === null) want(entry, false)
      }
    },
    /** While hidden no new mint or download starts; the ones on their way
        finish. On return the near images ask again. */
    pause(hidden: boolean) {
      if (paused === hidden) return
      paused = hidden
      if (hidden) return
      pumpSlots()
      pumpExternal()
      for (const entry of entries.values()) if (entry.pins > 0) want(entry, false)
    },
    /** A slot of the external pool for one external image: `start` runs
        once it is granted, and the answer gives the slot back. */
    external(start: () => void): () => void {
      let state: 'waiting' | 'held' | 'done' = 'waiting'
      const grant = () => {
        state = 'held'
        externalLoading++
        start()
      }
      externalQueue.push(grant)
      pumpExternal()
      return () => {
        if (state === 'waiting') {
          const at = externalQueue.indexOf(grant)
          if (at >= 0) externalQueue.splice(at, 1)
        } else if (state === 'held') {
          externalLoading--
          pumpExternal()
        }
        state = 'done'
      }
    },
    /** What the loader holds, for the tests and the measurement. */
    stats: () => {
      let pinnedBytes = 0
      for (const e of entries.values()) if (e.pins > 0) pinnedBytes += e.bytes
      return {
        downloading,
        mostDownloading,
        cachedBytes,
        pinnedBytes,
        externalLoading,
        entries: entries.size,
      }
    },
    /** Drops every entry, its bytes and what is on its way, with the store.
        A view still mounted asks again once the store's rows are back
        (retain). */
    clear() {
      generation++
      slotQueue.length = 0
      for (const entry of entries.values()) {
        stop(entry)
        forgetBytes(entry)
        entry.phase = 'idle'
        entry.exp = 0
        entry.box = null
        entry.refusedOnce = false
        entry.gated = false
        publish(entry)
        tidy(entry)
      }
      downloading = 0
      mostDownloading = 0
      unpinned.clear()
      cachedBytes = 0
    },
  }
}

export type InlineImages = ReturnType<typeof createInlineImages>

/** What a view of attachment `id` shows, with `element` its wrapper: the
    view pins the attachment while its wrapper is near and unpins it when
    it goes far or unmounts. `near` tells whether the view may show the
    bytes. It turns true only once this view's pin has run, so the row gate
    and a renewal past the lease decide what shows before any held bytes
    paint. */
export function useInlineImage(
  loader: InlineImages,
  id: string | null,
  element: Element | null,
): InlineImage & { near: boolean } {
  const [near, setNear] = useState(false)
  // the attachment this view's pin has run for
  const [pinned, setPinned] = useState<string | null>(null)
  useEffect(() => {
    setNear(false)
    if (!id || !element) return
    return loader.observe(element, setNear)
  }, [loader, id, element])
  useEffect(() => {
    if (!near || !id) return
    loader.pin(id)
    setPinned(id)
    return () => {
      setPinned(null)
      loader.unpin(id)
    }
  }, [loader, id, near])
  const subscribe = useCallback(
    (listener: () => void) => (id ? loader.watch(id, listener) : () => {}),
    [loader, id],
  )
  const shown = useSyncExternalStore(
    subscribe,
    () => (id ? loader.snapshot(id) : WAITING),
    () => WAITING,
  )
  return { ...shown, near: near && pinned === id }
}

/** An external image's turn to load: `load` stays false until the view
    is near and the external pool grants it a slot, then true until the
    image passes INLINE_IMAGES.externalTimeout, which shows it as
    `unavailable` until `retry`. The view calls `settled` once its <img>
    loads or fails, which gives the slot back. */
export function useExternalImage(
  loader: InlineImages,
  src: string | null,
  element: Element | null,
): { load: boolean; unavailable: boolean; settled: () => void; retry: () => void } {
  const [near, setNear] = useState(false)
  const [load, setLoad] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const give = useRef<() => void>(() => {})
  useEffect(() => {
    setNear(false)
    if (!src || !element) return
    return loader.observe(element, (value) => {
      if (value) setNear(true)
    })
  }, [loader, src, element])
  useEffect(() => {
    setLoad(false)
    setUnavailable(false)
    if (!near || !src || attempt < 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    let release = () => {}
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      release()
    }
    release = loader.external(() => {
      setLoad(true)
      timer = setTimeout(() => {
        if (done) return
        finish()
        setLoad(false)
        setUnavailable(true)
      }, INLINE_IMAGES.externalTimeout)
    })
    give.current = finish
    return finish
  }, [loader, src, near, attempt])
  return {
    load,
    unavailable,
    settled: () => give.current(),
    retry: () => setAttempt((n) => n + 1),
  }
}
