/** Persistent portrait bytes, scoped to one deployment and account.
 *
 * The cache stores image bytes only. Signed URLs and their access leases stay
 * outside persistence, so a renewed lease can continue to use the same Blob.
 * IndexedDB is optional: blocked or unavailable storage leaves the caller with
 * its in-memory source handling.
 */
export type AvatarImageCacheEntry = { key: string; blob: Blob }
export type AvatarImageCacheRecord = { scope: string; entries: AvatarImageCacheEntry[] }

export type AvatarImageCacheStore = {
  read(): Promise<AvatarImageCacheRecord | null>
  write(record: AvatarImageCacheRecord | null): Promise<void>
}

export type AvatarImageCache = {
  /** Return bytes only when the key is in the current authorized roster. */
  read(key: string): Promise<Blob | null>
  /** Replace the authorized roster and prune entries outside it. */
  sync(keys: Iterable<string>): void
  /** Queue valid bytes for an authorized key. */
  put(key: string, blob: Blob): void
  /** Remove one key from memory and persistence. */
  remove(key: string): void
  /** Remove all bytes and the persisted record for this scope. */
  clear(): Promise<void>
  /** Fence pending reads and writes. */
  dispose(): void
  /** Tests and shutdown callers can await queued storage work. */
  settled(): Promise<void>
}

export const AVATAR_IMAGE_MAX_BYTES = 1024 * 1024
export const AVATAR_IMAGE_MAX_ENTRIES = 128
export const AVATAR_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const AVATAR_IMAGE_STORAGE_TIMEOUT_MS = 750

function abortTransaction(tx: IDBTransaction) {
  try {
    tx.abort()
  } catch {
    // A transaction may have completed between the timeout and this call.
    // The operation is already being rejected by the timeout in that case.
  }
}

function bounded<T>(work: Promise<T>, timeout = AVATAR_IMAGE_STORAGE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Avatar image cache unavailable'))
    }, timeout)
    work.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function avatarCacheScope(deployment: string, accountId: string) {
  return JSON.stringify([deployment, accountId])
}

const validKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0
const validBlob = (blob: unknown): blob is Blob =>
  typeof Blob !== 'undefined' &&
  blob instanceof Blob &&
  blob.type.startsWith('image/') &&
  blob.size > 0 &&
  blob.size <= AVATAR_IMAGE_MAX_BYTES

function normalizeRecord(value: unknown): AvatarImageCacheRecord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { scope?: unknown; entries?: unknown }
  if (typeof candidate.scope !== 'string' || !Array.isArray(candidate.entries)) return null
  const entries: AvatarImageCacheEntry[] = []
  const seen = new Set<string>()
  let total = 0
  for (const item of candidate.entries) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { key?: unknown; blob?: unknown }
    if (!validKey(entry.key) || seen.has(entry.key) || !validBlob(entry.blob)) continue
    if (entries.length >= AVATAR_IMAGE_MAX_ENTRIES) break
    if (total + entry.blob.size > AVATAR_IMAGE_MAX_TOTAL_BYTES) break
    seen.add(entry.key)
    total += entry.blob.size
    entries.push({ key: entry.key, blob: entry.blob })
  }
  return { scope: candidate.scope, entries }
}

function boundedBlobEntries(entries: Map<string, Blob>) {
  // Map insertion order is used as a small LRU: replacing a key moves it to
  // the end, and old entries are evicted first when a bound is exceeded.
  while (entries.size > AVATAR_IMAGE_MAX_ENTRIES) {
    const first = entries.keys().next().value
    if (typeof first !== 'string') break
    entries.delete(first)
  }
  let total = 0
  for (const blob of entries.values()) total += blob.size
  while (total > AVATAR_IMAGE_MAX_TOTAL_BYTES && entries.size) {
    const first = entries.keys().next().value
    if (typeof first !== 'string') break
    const blob = entries.get(first)
    entries.delete(first)
    if (blob) total -= blob.size
  }
}

/** IndexedDB backing store used by the default client cache. */
export function indexedAvatarImageCache(): AvatarImageCacheStore {
  let database: Promise<IDBDatabase> | undefined
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('qivo-avatar-images', 1)
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        reject(new Error('Avatar image cache unavailable'))
      }, AVATAR_IMAGE_STORAGE_TIMEOUT_MS)
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
        reject(new Error('Avatar image cache unavailable'))
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
          reject(new Error('Avatar image cache unavailable'))
          abortTransaction(tx)
        }, AVATAR_IMAGE_STORAGE_TIMEOUT_MS)
        const fail = (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
        tx.onabort = () => fail(tx.error ?? new Error('Avatar image cache unavailable'))
        tx.onerror = () => fail(tx.error ?? new Error('Avatar image cache unavailable'))
        try {
          const request = tx.objectStore('current').get('avatars')
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
          reject(new Error('Avatar image cache unavailable'))
          abortTransaction(tx)
        }, AVATAR_IMAGE_STORAGE_TIMEOUT_MS)
        const fail = (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
        tx.oncomplete = () => {
          clearTimeout(timer)
          resolve()
        }
        tx.onerror = () => fail(tx.error ?? new Error('Avatar image cache unavailable'))
        tx.onabort = () => fail(tx.error ?? new Error('Avatar image cache unavailable'))
        try {
          if (record) tx.objectStore('current').put(record, 'avatars')
          else tx.objectStore('current').delete('avatars')
        } catch (error) {
          fail(error)
        }
      })
    },
  }
}

export function createAvatarImageCache(
  scope: string,
  options: { store?: AvatarImageCacheStore } = {},
): AvatarImageCache {
  const store = options.store ?? indexedAvatarImageCache()
  const entries = new Map<string, Blob>()
  const touched = new Set<string>()
  let persisted: Map<string, Blob> | null = null
  let roster: Set<string> | undefined
  let disposed = false
  let revision = 0
  let readEpoch = 0
  let writes = Promise.resolve()

  const loadedRecord = bounded(Promise.resolve().then(() => store.read()))
    .then((value) => {
      if (!disposed && readEpoch === 0) {
        const record = normalizeRecord(value)
        if (record?.scope === scope) {
          persisted = new Map(record.entries.map((entry) => [entry.key, entry.blob]))
          applyPersisted()
        }
      }
    })
    .catch(() => {})

  function applyPersisted() {
    if (!roster || !persisted) return
    for (const [key, blob] of persisted) {
      if (roster.has(key) && !touched.has(key) && !entries.has(key)) entries.set(key, blob)
    }
    for (const key of persisted.keys()) {
      if (!roster.has(key)) persisted.delete(key)
    }
    boundedBlobEntries(entries)
    for (const key of persisted.keys()) {
      if (!entries.has(key)) persisted.delete(key)
    }
  }

  function snapshot(): AvatarImageCacheRecord | null {
    if (!entries.size) return null
    return { scope, entries: [...entries].map(([key, blob]) => ({ key, blob })) }
  }

  function enqueue(token: number, force = false) {
    writes = writes
      .then(async () => {
        await loadedRecord
        if (!force && (disposed || token !== revision)) return
        try {
          // Build the record after the initial read has settled. A sync that
          // arrives during startup must persist restored bytes rather than the
          // empty pre-read snapshot.
          await bounded(store.write(snapshot()))
        } catch {
          // Persistence is opportunistic. The in-memory cache remains usable.
        }
      })
      .catch(() => {})
  }

  function save() {
    enqueue(revision)
  }

  return {
    async read(key) {
      const token = revision
      if (disposed || !validKey(key) || !roster?.has(key)) return null
      await loadedRecord
      if (disposed || token !== revision || !roster?.has(key)) return null
      return entries.get(key) ?? null
    },

    sync(keys) {
      if (disposed) return
      const next = new Set<string>()
      for (const key of keys) if (validKey(key)) next.add(key)
      const changed =
        !roster || roster.size !== next.size || [...roster].some((key) => !next.has(key))
      roster = next
      if (!changed) {
        applyPersisted()
        return
      }
      revision += 1
      for (const key of entries.keys()) if (!next.has(key)) entries.delete(key)
      if (persisted) {
        for (const key of persisted.keys()) if (!next.has(key)) persisted.delete(key)
      }
      applyPersisted()
      save()
    },

    put(key, blob) {
      if (disposed || !roster?.has(key) || !validBlob(blob)) return
      revision += 1
      touched.add(key)
      entries.delete(key)
      entries.set(key, blob)
      boundedBlobEntries(entries)
      if (persisted) {
        persisted.delete(key)
        persisted.set(key, blob)
        for (const existing of persisted.keys()) {
          if (!entries.has(existing)) persisted.delete(existing)
        }
      }
      save()
    },

    remove(key) {
      if (disposed || !validKey(key)) return
      revision += 1
      touched.add(key)
      entries.delete(key)
      persisted?.delete(key)
      save()
    },

    clear() {
      if (disposed) return Promise.resolve()
      revision += 1
      readEpoch += 1
      roster = undefined
      entries.clear()
      persisted = null
      touched.clear()
      const done = writes
      enqueue(revision, true)
      return done.then(() => writes)
    },

    dispose() {
      if (disposed) return
      disposed = true
      revision += 1
      readEpoch += 1
      roster = undefined
      entries.clear()
      persisted = null
      touched.clear()
    },

    async settled() {
      await loadedRecord
      await writes
    },
  }
}
