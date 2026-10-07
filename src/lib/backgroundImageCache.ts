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

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
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
  const pending = new Map<string, Promise<string>>()
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
    async restorePreview() {
      return restore('preview')
    },
    /** Restore the original bytes before current appearance metadata arrives. */
    async restoreFull() {
      return restore('full')
    },
    async resolve(url: string, selection: BackgroundSelection, quality: 'preview' | 'full') {
      if (disposed || !same(selected ?? null, selection)) throw new Error('Background changed')
      const version = generation
      const identity = `${selection.key}:${quality}:${quality === 'preview' ? selection.previewVersion : ''}`
      const existing = pending.get(identity)
      if (existing) return existing
      const parentSignal = controller.signal
      const transfer = new AbortController()
      const cancel = () => transfer.abort()
      parentSignal.addEventListener('abort', cancel, { once: true })
      const signal = transfer.signal
      let transient: Blob | null = null
      const request = bounded(
        (async () => {
          await loaded
          if (disposed || generation !== version || signal.aborted)
            throw new Error('Background changed')
          reconcile()
          const cached = record?.[quality]
          if (cached) {
            const cachedUrl = urlFor(cached)
            try {
              await validate(cachedUrl)
              if (disposed || generation !== version || signal.aborted)
                throw new Error('Background changed')
              return cachedUrl
            } catch {
              if (disposed || generation !== version || signal.aborted)
                throw new Error('Background changed')
              delete record![quality]
              revokeUrl(cachedUrl)
              urls.delete(cached)
              save(version)
            }
          }
          const response = await fetchImage(url, { credentials: 'omit', signal })
          if (!response.ok) throw new Error('Background unavailable')
          const blob = await response.blob()
          if (disposed || generation !== version || signal.aborted)
            throw new Error('Background changed')
          if (!blob.type.startsWith('image/') || !blob.size) throw new Error('Invalid background')
          const resolved = urlFor(blob)
          transient = blob
          await validate(resolved)
          if (disposed || generation !== version || signal.aborted)
            throw new Error('Background changed')
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
      pending.set(identity, request)
      try {
        return await request
      } catch (error) {
        if (pending.get(identity) === request) pending.delete(identity)
        throw error
      }
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
      pending.delete(
        `${selection.key}:${quality}:${quality === 'preview' ? selection.previewVersion : ''}`,
      )
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
