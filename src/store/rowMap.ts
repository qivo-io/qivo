/* The workspace rows the store shows (store/planner.ts `rows`): the server's
   rows (store/workspaceBase.ts) with every live layer painted over them.

   A paint runs inside a pass (WorkspaceRows.paint). Inside a pass, a row a
   paint reads is first copied (copyRow) into the section's overlay, and the
   paint changes the copy; outside one, a read hands out the overlay's copy
   or the server's frozen row. A repaint empties the overlays and paints
   every layer again, so it copies only the rows the layers reach instead of
   every row. Layer rule 1 (store/layers.ts) already forbids keeping a row
   object, so paints work unchanged.

   The rows also record what changed, in two ways:
   - since the last rebuild (takeDirty), so the store reshapes only those
     view models;
   - since the last workspace emit, with the row each key showed then
     (rowsChanged), so a repaint that changes nothing on screen emits
     nothing. */

import type { Row } from './rows'
import { sameData } from './stable'
import {
  type Changes,
  type KeyedName,
  LISTED_SECTIONS,
  type ListedName,
  type RowOf,
  sameRow,
  type WorkspaceBase,
} from './workspaceBase'

/** The row type of each list as the store reads it. */
type ListRow = {
  teamMembers: Row<'team_members'>
  access: Row<'project_access'>
  teamAccess: Row<'project_team_access'>
  issueLabels: Row<'issue_labels'>
  issueSubs: Row<'issue_subscriptions'>
  orgLoad: RowOf<'orgLoad'>
}

/* How many rows copyRow copied, for the tests' cost checks (rowCopies). */
let copies = 0

/** How many rows copyRow has copied. */
export const rowCopies = () => copies

/** A copy of `row` that a paint may change without touching the server's
    row: its own fields, and a deep copy of any object or list in it. */
export function copyRow<T extends object>(row: T): T {
  copies++
  const copy = { ...row }
  for (const key in copy) {
    const value = copy[key]
    if (value && typeof value === 'object') copy[key] = structuredClone(value)
  }
  return copy
}

/** An overlay entry for a key a paint deleted. */
const GONE = Symbol('gone')

/** The hidden-flag sets kept beside the task rows. */
export type FlagName = 'hiddenSubtaskParents' | 'hiddenParentTasks'

/** What changed since the last rebuild: the keys of each keyed section
    ('all' after a paint walked it), and the lists and flag sets that
    changed at all. */
export type Dirty = {
  keys: Map<KeyedName, Set<string> | 'all'>
  lists: Set<ListedName>
  flags: boolean
}

/** The bookkeeping the sections share. */
type Host = {
  base: WorkspaceBase
  /** Whether a paint runs. */
  painting: () => boolean
  /** Records that `key` of `name` changes now, and the row it showed. */
  touch: (name: KeyedName, key: string, shown: object | undefined) => void
  /** Records that a paint walks every row of `name`. */
  touchAll: (name: KeyedName) => void
}

/** A keyed section: Map-like over the server's rows and the overlay. */
export class RowMap<R extends object> {
  /** The paints' copies, inserts and deletes, by key. */
  overlay = new Map<string, R | typeof GONE>()

  constructor(
    readonly name: KeyedName,
    private readonly host: Host,
  ) {}

  private get base(): ReadonlyMap<string, R> {
    return this.host.base.map(this.name) as unknown as ReadonlyMap<string, R>
  }

  /** The row shown for `key`, without copying it. */
  peek(key: string): R | undefined {
    const own = this.overlay.get(key)
    if (own !== undefined) return own === GONE ? undefined : own
    return this.base.get(key)
  }

  /** The row for `key`; inside a pass, the overlay's copy of it. */
  get(key: string): R | undefined {
    const own = this.overlay.get(key)
    if (own !== undefined) {
      if (this.host.painting()) this.host.touch(this.name, key, own === GONE ? undefined : own)
      return own === GONE ? undefined : own
    }
    const row = this.base.get(key)
    if (row === undefined || !this.host.painting()) return row
    this.host.touch(this.name, key, row)
    const copy = copyRow(row)
    this.overlay.set(key, copy)
    return copy
  }

  has(key: string): boolean {
    return this.peek(key) !== undefined
  }

  set(key: string, row: R): this {
    this.host.touch(this.name, key, this.peek(key))
    this.overlay.set(key, row)
    return this
  }

  delete(key: string): boolean {
    const had = this.peek(key)
    if (had === undefined) return false
    this.host.touch(this.name, key, had)
    if (this.base.has(key)) this.overlay.set(key, GONE)
    else this.overlay.delete(key)
    return true
  }

  get size(): number {
    let size = this.base.size
    for (const [key, own] of this.overlay) {
      const based = this.base.has(key)
      if (own === GONE) size -= based ? 1 : 0
      else if (!based) size++
    }
    return size
  }

  /** Every key and row, the server's order first and the inserts after.
      Inside a pass every row handed out is a copy, as get's are. */
  *entries(): IterableIterator<[string, R]> {
    const painting = this.host.painting()
    if (painting) this.host.touchAll(this.name)
    for (const [key, row] of this.base) {
      const own = this.overlay.get(key)
      if (own === GONE) continue
      if (own !== undefined) yield [key, own]
      else if (painting) {
        this.host.touch(this.name, key, row)
        const copy = copyRow(row)
        this.overlay.set(key, copy)
        yield [key, copy]
      } else yield [key, row]
    }
    for (const [key, own] of this.overlay) if (own !== GONE && !this.base.has(key)) yield [key, own]
  }

  *keys(): IterableIterator<string> {
    for (const [key] of this.base) if (this.overlay.get(key) !== GONE) yield key
    for (const [key, own] of this.overlay) if (own !== GONE && !this.base.has(key)) yield key
  }

  *values(): IterableIterator<R> {
    for (const [, row] of this.entries()) yield row
  }

  forEach(visit: (row: R, key: string) => void) {
    for (const [key, row] of this.entries()) visit(row, key)
  }

  [Symbol.iterator]() {
    return this.entries()
  }
}

/** Creates the workspace rows over `base`. */
export function createWorkspaceRows(base: WorkspaceBase) {
  let passes = 0
  const dirty: Dirty = { keys: new Map(), lists: new Set(), flags: false }
  // since the last checkpoint: the row each changed key showed then
  // (undefined for none), and each changed list and flag set
  const shownKeys = new Map<KeyedName, Map<string, object | undefined>>()
  const shownLists = new Map<ListedName, readonly object[]>()
  const shownFlags = new Map<FlagName, ReadonlySet<string>>()

  const host: Host = {
    base,
    painting: () => passes > 0,
    touch(name, key, shown) {
      const keys = dirty.keys.get(name)
      if (keys === undefined) dirty.keys.set(name, new Set([key]))
      else if (keys !== 'all') keys.add(key)
      let at = shownKeys.get(name)
      if (!at) {
        at = new Map()
        shownKeys.set(name, at)
      }
      if (!at.has(key)) at.set(key, shown)
    },
    touchAll(name) {
      dirty.keys.set(name, 'all')
    },
  }

  const maps = {
    orgs: new RowMap<Row<'organizations'>>('orgs', host),
    teams: new RowMap<Row<'teams'>>('teams', host),
    profiles: new RowMap<Row<'profiles'>>('profiles', host),
    projects: new RowMap<Row<'projects'>>('projects', host),
    issues: new RowMap<Row<'issues'>>('issues', host),
    links: new RowMap<Row<'issue_links'>>('links', host),
    milestones: new RowMap<Row<'milestones'>>('milestones', host),
    labels: new RowMap<Row<'labels'>>('labels', host),
    attachments: new RowMap<Row<'issue_attachments'>>('attachments', host),
    messages: new RowMap<Row<'messages'>>('messages', host),
  }

  // the paints' copies of the lists and flag sets
  const listOverlay = new Map<ListedName, object[]>()
  const flagOverlay = new Map<FlagName, Set<string>>()

  /** List `name` as shown: inside a pass, a copy the paint may change. */
  function list<S extends ListedName>(name: S): ListRow[S][] {
    const own = listOverlay.get(name)
    if (own) {
      // a paint may change the copy an earlier pass made
      if (passes > 0) dirty.lists.add(name)
      return own as ListRow[S][]
    }
    const server = base.list(name) as readonly object[]
    if (passes === 0) return server as ListRow[S][]
    noteList(name, server)
    const copy = server.map(copyRow)
    listOverlay.set(name, copy)
    return copy as ListRow[S][]
  }
  function noteList(name: ListedName, shown: readonly object[]) {
    dirty.lists.add(name)
    if (!shownLists.has(name)) shownLists.set(name, shown)
  }
  function setList<S extends ListedName>(name: S, value: ListRow[S][]) {
    noteList(name, list(name))
    listOverlay.set(name, value)
  }
  /** Flag set `name` as shown: inside a pass, a copy the paint may change. */
  function flags(name: FlagName): Set<string> {
    const own = flagOverlay.get(name)
    if (own) {
      if (passes > 0) dirty.flags = true
      return own
    }
    // outside a paint nothing may change it (store/layers.ts), as the rows
    const server = base.flags(name) as Set<string>
    if (passes === 0) return server
    noteFlags(name, server)
    const copy = new Set(server)
    flagOverlay.set(name, copy)
    return copy
  }
  function noteFlags(name: FlagName, shown: ReadonlySet<string>) {
    dirty.flags = true
    if (!shownFlags.has(name)) shownFlags.set(name, shown)
  }

  /** Everything a repaint changes, to put back with restore (the test
      builds' layer check, store/planner.ts checkLayers). */
  function save() {
    return {
      overlays: (Object.values(maps) as RowMap<object>[]).map(
        (map) => [map, new Map(map.overlay)] as const,
      ),
      lists: new Map(listOverlay),
      flags: new Map(flagOverlay),
      dirty: {
        keys: new Map([...dirty.keys].map(([k, v]) => [k, v === 'all' ? v : new Set(v)])),
        lists: new Set(dirty.lists),
        flags: dirty.flags,
      },
      shownKeys: new Map([...shownKeys].map(([k, v]) => [k, new Map(v)])),
      shownLists: new Map(shownLists),
      shownFlags: new Map(shownFlags),
    }
  }
  /** Puts back what `saved` holds. */
  function restore(saved: ReturnType<typeof save>) {
    for (const [map, overlay] of saved.overlays) map.overlay = overlay
    listOverlay.clear()
    for (const [k, v] of saved.lists) listOverlay.set(k, v)
    flagOverlay.clear()
    for (const [k, v] of saved.flags) flagOverlay.set(k, v)
    dirty.keys = saved.dirty.keys
    dirty.lists = saved.dirty.lists
    dirty.flags = saved.dirty.flags
    shownKeys.clear()
    for (const [k, v] of saved.shownKeys) shownKeys.set(k, v)
    shownLists.clear()
    for (const [k, v] of saved.shownLists) shownLists.set(k, v)
    shownFlags.clear()
    for (const [k, v] of saved.shownFlags) shownFlags.set(k, v)
  }

  return {
    ...maps,
    list,
    setList,
    flags,

    /** Runs `paint` as a pass. */
    paint(paint: () => void) {
      passes++
      try {
        paint()
      } finally {
        passes--
      }
    },

    /** Starts a repaint: forgets every paint and applies the staged
        delivery. Answers what the delivery changed, or null. */
    beginRepaint(): Changes | null {
      for (const map of Object.values(maps) as RowMap<object>[]) {
        for (const [key, own] of map.overlay)
          host.touch(map.name, key, typeof own === 'symbol' ? undefined : own)
        map.overlay = new Map()
      }
      for (const [name, own] of listOverlay) noteList(name, own)
      listOverlay.clear()
      for (const [name, own] of flagOverlay) noteFlags(name, own)
      flagOverlay.clear()
      const lists = new Map(LISTED_SECTIONS.map((name) => [name, base.list(name)]))
      // the Sets an apply replaces when their tasks change
      const flagsBefore = {
        hiddenSubtaskParents: base.flags('hiddenSubtaskParents'),
        hiddenParentTasks: base.flags('hiddenParentTasks'),
      }
      const changes = base.apply()
      if (!changes) return null
      for (const [name, changed] of Object.entries(changes) as [
        keyof Changes,
        Map<string, object | undefined>,
      ][]) {
        const listed = lists.get(name as ListedName)
        if (listed) {
          noteList(name as ListedName, listed)
          continue
        }
        for (const [key, before] of changed) host.touch(name as KeyedName, key, before)
      }
      for (const name of ['hiddenSubtaskParents', 'hiddenParentTasks'] as const)
        if (flagsBefore[name] !== base.flags(name)) noteFlags(name, flagsBefore[name])
      return changes
    },

    /** What changed since the last call, which it forgets. */
    takeDirty(): Dirty {
      const taken = { keys: new Map(dirty.keys), lists: new Set(dirty.lists), flags: dirty.flags }
      dirty.keys.clear()
      dirty.lists.clear()
      dirty.flags = false
      return taken
    },

    /** Whether any row outside `except` shows other data than at the last
        checkpoint. */
    rowsChanged(except: KeyedName): boolean {
      for (const [name, keys] of shownKeys) {
        if (name === except) continue
        const map = maps[name] as RowMap<object>
        for (const [key, shown] of keys) {
          const now = map.peek(key)
          if (shown === undefined || now === undefined ? shown !== now : !sameRow(shown, now))
            return true
        }
      }
      for (const [name, shown] of shownLists) if (!sameData(shown, list(name))) return true
      for (const [name, shown] of shownFlags) if (!sameData(shown, flags(name))) return true
      return false
    },

    /** Forgets what changed since the last checkpoint: what shows now is
        the next comparison's start (a workspace emit). */
    checkpoint() {
      shownKeys.clear()
      shownLists.clear()
      shownFlags.clear()
    },

    save,
    restore,
    /** Forgets every row and paint (a disposed demo). */
    reset() {
      base.reset()
      for (const map of Object.values(maps) as RowMap<object>[]) map.overlay = new Map()
      listOverlay.clear()
      flagOverlay.clear()
      dirty.keys.clear()
      dirty.lists.clear()
      dirty.flags = false
      shownKeys.clear()
      shownLists.clear()
      shownFlags.clear()
    },
  }
}

export type WorkspaceRows = ReturnType<typeof createWorkspaceRows>
