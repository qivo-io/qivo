import { LIMITS, MIB } from '../../convex/lib/limits'

/** One account/deployment-scoped selection, containing bytes rather than bearer
 * URLs. IndexedDB is optional: blocked storage still leaves the in-tab cache. */
export type BackgroundSelection = { key: string; previewVersion: string | null }
export type BackgroundCacheRecord = {
  scope: string
  selection: BackgroundSelection
  preview?: Blob
  full?: Blob
}
export type BackgroundCacheStore = {
  read(): Promise<BackgroundCacheRecord | null>
  write(record: BackgroundCacheRecord | null): Promise<void>
}

// a full image is at most the background image size the server takes
const MAX_IMAGE_BYTES = LIMITS.backgroundSize.max * MIB
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const STORAGE_TIMEOUT_MS = 750

function abortTransaction(tx: IDBTransaction) {
  try {
    tx.abort()
  } catch {
    // A transaction may have completed between the timeout and this call.
    // The operation is already being rejected by the timeout in that case.
  }
}

function bounded<T>(work: Promise<T>, timeout = STORAGE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Background cache unavailable')), timeout)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** What a request for an image of a selection that is no longer the
    current one, or of a disposed cache, rejects with. */
export class BackgroundChanged extends Error {
  constructor() {
    super('Background changed')
  }
}

export function backgroundCacheScope(deployment: string, accountId: string) {
  return JSON.stringify([deployment, accountId])
}

export function indexedBackgroundCache(): BackgroundCacheStore {
  let database: Promise<IDBDatabase> | undefined
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('qivo-background-image', 1)
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        reject(new Error('Background cache unavailable'))
      }, STORAGE_TIMEOUT_MS)
      request.onupgradeneeded = () => request.result.createObjectStore('current')
      request.onsuccess = () => {
        clearTimeout(timer)
        if (expired) request.result.close()
        else resolve(request.result)
      }
      request.onerror = () => {
        clearTimeout(timer)
        reject(request.error)
      }
      request.onblocked = () => {
        expired = true
        clearTimeout(timer)
        reject(new Error('Background cache unavailable'))
      }
    })
    return database
  }
  return {
    async read() {
      const db = await open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('current', 'readonly')
        const timer = setTimeout(() => {
          reject(new Error('Background cache unavailable'))
          abortTransaction(tx)
        }, STORAGE_TIMEOUT_MS)
        const fail = (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
        tx.onabort = () => fail(tx.error ?? new Error('Background cache unavailable'))
        tx.onerror = () => fail(tx.error ?? new Error('Background cache unavailable'))
        try {
          const request = tx.objectStore('current').get('image')
          request.onsuccess = () => {
            clearTimeout(timer)
            resolve(request.result ?? null)
          }
          request.onerror = () => fail(request.error)
        } catch (error) {
          fail(error)
        }
      })
    },
    async write(record) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('current', 'readwrite')
        const timer = setTimeout(() => {
          reject(new Error('Background cache unavailable'))
          abortTransaction(tx)
        }, STORAGE_TIMEOUT_MS)
        const fail = (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
        tx.oncomplete = () => {
          clearTimeout(timer)
          resolve()
        }
        tx.onerror = () => fail(tx.error ?? new Error('Background cache unavailable'))
        tx.onabort = () => fail(tx.error ?? new Error('Background cache unavailable'))
        try {
          if (record) tx.objectStore('current').put(record, 'image')
          else tx.objectStore('current').delete('image')
        } catch (error) {
          fail(error)
        }
      })
    },
  }
}

export function createBackgroundImageCache(
  scope: string,
  options: {
    store?: BackgroundCacheStore
    fetch?: typeof fetch
    createUrl?: (blob: Blob) => string
    revokeUrl?: (url: string) => void
    validate?: (url: string) => Promise<void>
  } = {},
) {
  const store = options.store ?? indexedBackgroundCache()
  const fetchImage = options.fetch ?? fetch
  const createUrl = options.createUrl ?? URL.createObjectURL.bind(URL)
  const revokeUrl = options.revokeUrl ?? URL.revokeObjectURL.bind(URL)
  const validate = options.validate ?? (async () => {})
  let record: BackgroundCacheRecord | null = null
  let selected: BackgroundSelection | null | undefined
  let generation = 0
  let disposed = false
  let writes = Promise.resolve()
  const urls = new Map<Blob, string>()
  // a request by identity, its transfer, how many callers that may leave
  // still wait for it, and whether every such caller left, which stops it
  const pending = new Map<
    string,
    { request: Promise<string>; transfer: AbortController; waiting: number; stopped: boolean }
  >()
  let controller = new AbortController()
  const validBlob = (blob: unknown, maxBytes: number): blob is Blob =>
    blob instanceof Blob && blob.type.startsWith('image/') && blob.size > 0 && blob.size <= maxBytes
  const loaded = bounded(Promise.resolve().then(() => store.read())).then(
    (value) => {
      if (
        !disposed &&
        value?.scope === scope &&
        typeof value.selection?.key === 'string' &&
        /^(custom|daily):.+/.test(value.selection.key) &&
        (value.selection.previewVersion === null ||
          typeof value.selection.previewVersion === 'string')
      )
        record = {
          scope,
          selection: value.selection,
          ...(validBlob(value.preview, MAX_PREVIEW_BYTES) ? { preview: value.preview } : {}),
          ...(validBlob(value.full, MAX_IMAGE_BYTES) ? { full: value.full } : {}),
        }
    },
    () => {},
  )
  const urlFor = (blob: Blob) => {
    let url = urls.get(blob)
    if (!url) {
      url = createUrl(blob)
      urls.set(blob, url)
    }
    return url
  }
  const save = (version: number) => {
    const snapshot = record ? { ...record, selection: { ...record.selection } } : null
    writes = writes
      .then(async () => {
        // Flush the final selection even after unmount. In particular, a
        // queued withdrawal must follow a write already in progress.
        if (generation === version) await bounded(store.write(snapshot))
      })
      .catch(() => {})
  }
  const reconcile = () => {
    if (selected === undefined) return
    const previous = record
    if (!selected) record = null
    else if (record?.selection.key !== selected.key) record = { scope, selection: selected }
    else if (record.selection.previewVersion !== selected.previewVersion)
      record = { scope, selection: selected, full: record.full }
    if (record === previous) return
    for (const [blob, url] of urls)
      if (blob !== record?.preview && blob !== record?.full) {
        revokeUrl(url)
        urls.delete(blob)
      }
  }
  const same = (a: BackgroundSelection | null, b: BackgroundSelection | null) =>
    a?.key === b?.key && a?.previewVersion === b?.previewVersion
  /* The identity resolve shares one request of `quality` under. */
  const identityOf = (selection: BackgroundSelection, quality: 'preview' | 'full') =>
    `${selection.key}:${quality}:${quality === 'preview' ? selection.previewVersion : ''}`
  const restore = async (quality: 'preview' | 'full') => {
    const version = generation
    await loaded
    if (
      disposed ||
      generation !== version ||
      !record?.[quality] ||
      (selected !== undefined && !same(selected, record.selection))
    )
      return null
    return { ...record.selection, url: urlFor(record[quality] as Blob) }
  }

  /* The request behind resolve for `identity`, through `transfer`. It
     keeps its answer under `identity` until the selection changes, and
     forgets a failed one. */
  const fetchFor = (
    url: string,
    quality: 'preview' | 'full',
    identity: string,
    transfer: AbortController,
  ): Promise<string> => {
    const version = generation
    const parentSignal = controller.signal
    const cancel = () => transfer.abort()
    parentSignal.addEventListener('abort', cancel, { once: true })
    const signal = transfer.signal
    let transient: Blob | null = null
    const request = bounded(
      (async () => {
        await loaded
        if (disposed || generation !== version || signal.aborted) throw new BackgroundChanged()
        reconcile()
        const cached = record?.[quality]
        if (cached) {
          const cachedUrl = urlFor(cached)
          try {
            await validate(cachedUrl)
            if (disposed || generation !== version || signal.aborted) throw new BackgroundChanged()
            return cachedUrl
          } catch {
            if (disposed || generation !== version || signal.aborted) throw new BackgroundChanged()
            delete record![quality]
            revokeUrl(cachedUrl)
            urls.delete(cached)
            save(version)
          }
        }
        const response = await fetchImage(url, { credentials: 'omit', signal })
        if (!response.ok) throw new Error('Background unavailable')
        const blob = await response.blob()
        if (disposed || generation !== version || signal.aborted) throw new BackgroundChanged()
        if (!blob.type.startsWith('image/') || !blob.size) throw new Error('Invalid background')
        const resolved = urlFor(blob)
        transient = blob
        await validate(resolved)
        if (disposed || generation !== version || signal.aborted) throw new BackgroundChanged()
        // Bound persisted bytes as well as the number of selected images.
        if (blob.size <= (quality === 'preview' ? MAX_PREVIEW_BYTES : MAX_IMAGE_BYTES)) {
          record = { ...record!, [quality]: blob }
          save(version)
        }
        transient = null
        return resolved
      })(),
      30_000,
    ).finally(() => {
      transfer.abort()
      parentSignal.removeEventListener('abort', cancel)
      // A timeout can settle before decoding does. Release this unpublished
      // request's bytes now; its late completion is fenced by signal.aborted.
      if (transient) {
        const transientUrl = urls.get(transient)
        if (transientUrl) revokeUrl(transientUrl)
        urls.delete(transient)
        transient = null
      }
    })
    pending.set(identity, { request, transfer, waiting: 0, stopped: false })
    request.catch(() => {
      if (pending.get(identity)?.request === request) pending.delete(identity)
    })
    return request
  }

  return {
    /** undefined authority means startup is still pending; null is withdrawal. */
    select(selection: BackgroundSelection | null) {
      if (disposed || (selected !== undefined && same(selected, selection))) return
      selected = selection
      const version = ++generation
      controller.abort()
      controller = new AbortController()
      pending.clear()
      void loaded.then(() => {
        if (generation !== version) return
        reconcile()
        save(version)
      })
    },
    /** The selection's cached preview, once its bytes decode (`validate`).
        Bytes that no longer decode leave the cache, so a retry or the next
        read fetches the derivative again instead of showing them. */
    async restorePreview() {
      const version = generation
      const restored = await restore('preview')
      const blob = record?.preview
      if (!restored || !blob || urls.get(blob) !== restored.url) return restored
      try {
        await validate(restored.url)
        return restored
      } catch {
        if (disposed || generation !== version || record?.preview !== blob) return null
        delete record.preview
        revokeUrl(restored.url)
        urls.delete(blob)
        // a settled read of these bytes would answer them again
        pending.delete(identityOf(record.selection, 'preview'))
        save(version)
        return null
      }
    },
    /** Restore the original bytes before current appearance metadata arrives. */
    async restoreFull() {
      return restore('full')
    },
    /** The selection's bytes of `quality` as a blob URL, from the cache or
        fetched from `url`, one request an identity shared by its callers.
        A caller's `signal` detaches that caller only: its promise rejects,
        and the transfer stops once every caller with a signal has left and
        none without one joined. The canvas passes none, so Settings'
        preview leaving never stops the canvas's request. */
    async resolve(
      url: string,
      selection: BackgroundSelection,
      quality: 'preview' | 'full',
      signal?: AbortSignal,
    ): Promise<string> {
      if (disposed || !same(selected ?? null, selection)) throw new BackgroundChanged()
      if (signal?.aborted) throw new DOMException('Background request left', 'AbortError')
      const identity = identityOf(selection, quality)
      // A settled request answers again until the selection changes; one
      // every caller left is stopped, so a new caller starts afresh.
      if (!pending.has(identity) || pending.get(identity)?.stopped)
        fetchFor(url, quality, identity, new AbortController())
      const entry = pending.get(identity) as NonNullable<ReturnType<typeof pending.get>>
      if (!signal) {
        // a caller without a signal never leaves, so the transfer runs on
        entry.waiting = Number.POSITIVE_INFINITY
        return await entry.request
      }
      entry.waiting++
      return await new Promise<string>((resolve, reject) => {
        const leave = () => {
          entry.waiting--
          if (entry.waiting === 0) {
            entry.stopped = true
            entry.transfer.abort()
          }
          reject(new DOMException('Background request left', 'AbortError'))
        }
        signal.addEventListener('abort', leave, { once: true })
        entry.request.then(
          (value) => {
            signal.removeEventListener('abort', leave)
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener('abort', leave)
            reject(error)
          },
        )
      })
    },
    reject(selection: BackgroundSelection, quality: 'preview' | 'full') {
      if (disposed || !same(selected ?? null, selection) || !record) return
      const blob = record[quality]
      if (blob) {
        const url = urls.get(blob)
        if (url) revokeUrl(url)
        urls.delete(blob)
      }
      delete record[quality]
      pending.delete(identityOf(selection, quality))
      save(generation)
    },
    dispose() {
      disposed = true
      controller.abort()
      pending.clear()
      for (const url of urls.values()) revokeUrl(url)
      urls.clear()
    },
    /** Tests and shutdown callers can await the already queued storage work. */
    async settled() {
      await loaded
      await writes
    },
  }
}
