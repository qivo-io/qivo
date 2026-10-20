/* A note that survives a crash.

   A crash, a killed tab or a shutdown cannot warn while a change waits for
   the server's answer (lib/leaveGuard). So each change Qivo sends is noted
   in browser storage until the server confirms or refuses it, and the next
   start says which ones it never heard back about. A note names only the
   task's key and what kind of change it was, never any text or other task
   content. Notes are kept per organization and the person's profile there
   (the scope), and per page, so one page never reports another open page's
   changes: each page holds a Web Lock for as long as it lives, and only the
   notes of pages whose lock is gone are reported. */

/** What a note says about one change: the task's key, when it is about a
    task, and what changed ("description", "a project change"). */
export type UnconfirmedChange = { task: string | null; what: string }

type Stored = UnconfirmedChange & { id: string; at: number }

const PREFIX = 'qivo.unconfirmed.v1:'
const LOCK_PREFIX = 'qivo-page:'
/** Notes older than this are dropped unread, such as those of an
    organization the person has left. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

type Dependencies = {
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
  /** This page's id. */
  page: string
  /** The ids of the pages still open, or null when the browser cannot tell. */
  livePages: () => Promise<ReadonlySet<string> | null>
  now?: () => number
}

/** Creates the note. Storage that is full or refused only loses the note,
    never a change. */
export function createUnconfirmedNote(deps: Dependencies) {
  const now = deps.now ?? (() => Date.now())
  const own = new Map<string, Map<string, Stored>>()
  let next = 0
  const keyOf = (scope: string) => `${PREFIX}${scope}:${deps.page}`

  function save(scope: string) {
    const entries = own.get(scope)
    try {
      if (entries?.size) deps.storage().setItem(keyOf(scope), JSON.stringify([...entries.values()]))
      else deps.storage().removeItem(keyOf(scope))
    } catch {
      // A note that cannot be stored cannot be reported either.
    }
  }

  /** The stored keys of every page's notes in `scope`. */
  function keysOf(scope: string): string[] {
    const keys: string[] = []
    try {
      const storage = deps.storage()
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(`${PREFIX}${scope}:`)) keys.push(key)
      }
    } catch {
      // Unavailable storage holds no notes.
    }
    return keys
  }

  return {
    /** Notes a change just sent in `scope`. Answers the function that
        clears it once the server confirmed or refused it. */
    add(scope: string, change: UnconfirmedChange): () => void {
      const id = String(++next)
      const entries = own.get(scope) ?? new Map<string, Stored>()
      own.set(scope, entries)
      entries.set(id, { ...change, id, at: now() })
      save(scope)
      return () => {
        if (!own.get(scope)?.delete(id)) return
        save(scope)
      }
    },

    /** Clears every page's notes in `scopes`, for a sign-out. */
    forget(scopes: Iterable<string>) {
      for (const scope of scopes) {
        own.delete(scope)
        for (const key of keysOf(scope)) {
          try {
            deps.storage().removeItem(key)
          } catch {
            // Nothing more can be done about storage that refuses.
          }
        }
      }
    },

    /** Answers the changes that pages which have closed noted in `scopes`
        and never cleared, and clears those notes, so each is told once.
        When the browser cannot tell which pages are open, it reports none,
        because the page that wrote a note may still be waiting for its
        answer, and only drops notes older than KEEP_MS. */
    async collect(scopes: Iterable<string>): Promise<UnconfirmedChange[]> {
      const live = await deps.livePages()
      const found: UnconfirmedChange[] = []
      for (const scope of scopes) {
        for (const key of keysOf(scope)) {
          const page = key.slice(`${PREFIX}${scope}:`.length)
          if (page === deps.page || live?.has(page)) continue
          let entries: Partial<Stored>[] = []
          try {
            const parsed: unknown = JSON.parse(deps.storage().getItem(key) || 'null')
            if (Array.isArray(parsed)) entries = parsed
          } catch {
            // A note that cannot be read says nothing.
          }
          const kept = entries.filter(
            (entry) => typeof entry?.what === 'string' && now() - Number(entry.at) < KEEP_MS,
          )
          if (!live && kept.length) continue
          try {
            deps.storage().removeItem(key)
          } catch {
            // The note stays, and the next start reads it again.
          }
          if (!live) continue
          for (const entry of kept)
            found.push({
              task: typeof entry.task === 'string' ? entry.task : null,
              what: String(entry.what),
            })
        }
      }
      return found
    },
  }
}

const browser = typeof document !== 'undefined' && typeof navigator !== 'undefined'
const locks = browser && 'locks' in navigator ? navigator.locks : null
const page = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Math.random())

// Held until the page closes or crashes; the browser then frees it.
void locks?.request(`${LOCK_PREFIX}${page}`, () => new Promise<never>(() => {})).catch(() => {})

/** The note this page keeps. */
export const unconfirmedNote = createUnconfirmedNote({
  storage: () => localStorage,
  page,
  livePages: async () => {
    if (!locks) return null
    try {
      const { held = [] } = await locks.query()
      return new Set(
        held.flatMap(({ name }) =>
          name?.startsWith(LOCK_PREFIX) ? [name.slice(LOCK_PREFIX.length)] : [],
        ),
      )
    } catch {
      return null
    }
  },
})

/** The sentence that tells the person about `changes` a closed page could
    not confirm, or null when there are none. It never says they were lost,
    because the server may have saved them. */
export function unconfirmedText(changes: UnconfirmedChange[]): string | null {
  if (!changes.length) return null
  const count = changes.length === 1 ? '1 change' : `${changes.length} changes`
  const [only] = changes
  if (changes.length === 1 && only.task)
    return `Qivo closed before it could confirm 1 change to ${only.task} (${only.what}). Check the task.`
  const named = [...new Set(changes.map((c) => (c.task ? `${c.task} (${c.what})` : c.what)))]
  const shown = named.slice(0, 5)
  if (named.length > shown.length) shown.push(`${named.length - shown.length} more`)
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]
  return `Qivo closed before it could confirm ${count}: ${list}. Check ${changes.length === 1 ? 'it' : 'them'}.`
}
