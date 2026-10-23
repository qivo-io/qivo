/* The server's workspace rows as the store keeps them between deliveries
   (store/planner.ts). Each delivery is compared with the rows kept before
   it: a row that holds the same data keeps its object, and only the rows
   that changed are taken from the delivery, frozen. So a delivery that
   changes one task costs one cheap comparison per row, and everything built
   from the rows can tell exactly what changed (Changes).

   A delivery is staged when it arrives and applied at the start of the next
   workspace paint (store/rowMap.ts), so the rows on screen stay exactly what
   was last painted until then. Rows are frozen in every build, so code that
   writes into the server's rows outside a paint throws instead of changing
   them unseen. */

import type { Workspace } from '../../convex/lib/workspaceJoin'
import { sameData } from './stable'

/** The workspace as the live parts join into it (convex/lib/workspaceJoin.ts). */
export type Snapshot = Workspace

/** The row sections kept by key, and how each row's key reads. */
const KEYED = {
  orgs: (r: Snapshot['orgs'][number]) => r.id,
  teams: (r: Snapshot['teams'][number]) => r.id,
  profiles: (r: Snapshot['profiles'][number]) => r.id,
  projects: (r: Snapshot['projects'][number]) => r.id,
  issues: (r: Snapshot['issues'][number]) => r.id,
  links: (r: Snapshot['links'][number]) => r.id,
  milestones: (r: Snapshot['milestones'][number]) => r.id,
  labels: (r: Snapshot['labels'][number]) => r.id,
  attachments: (r: Snapshot['attachments'][number]) => r.id,
  messages: (r: Snapshot['messages'][number]) => r.id,
}
/** The row sections kept as lists in delivery order, and their natural keys.
    A hidden task's load row has no task id, so a load row is keyed by its
    owner, then its place among that owner's rows (keysOf). Only those rows
    are kept (hiddenLoad). */
const LISTED = {
  teamMembers: (r: Snapshot['teamMembers'][number]) => `${r.team_id}:${r.profile_id}`,
  access: (r: Snapshot['access'][number]) => `${r.project_id}:${r.profile_id}`,
  teamAccess: (r: Snapshot['teamAccess'][number]) => `${r.project_id}:${r.team_id}`,
  issueLabels: (r: Snapshot['issueLabels'][number]) => `${r.issue_id}:${r.label_id}`,
  issueSubs: (r: Snapshot['issueSubs'][number]) => `${r.issue_id}:${r.profile_id}`,
  orgLoad: (r: Snapshot['orgLoad'][number]) =>
    r.issue_id === null ? `hidden:${r.owner_id}` : `task:${r.issue_id}`,
}

/** Whether two rows of a section have the same key, by its fields. Two
    hidden load rows of one owner count as the same here; keysOf tells them
    apart by place. */
const byId = (a: { id: string }, b: { id: string }) => a.id === b.id
const SAME_KEY: Record<keyof typeof KEYED | keyof typeof LISTED, (a: never, b: never) => boolean> =
  {
    orgs: byId,
    teams: byId,
    profiles: byId,
    projects: byId,
    issues: byId,
    links: byId,
    milestones: byId,
    labels: byId,
    attachments: byId,
    messages: byId,
    teamMembers: (a: RowOf<'teamMembers'>, b: RowOf<'teamMembers'>) =>
      a.team_id === b.team_id && a.profile_id === b.profile_id,
    access: (a: RowOf<'access'>, b: RowOf<'access'>) =>
      a.project_id === b.project_id && a.profile_id === b.profile_id,
    teamAccess: (a: RowOf<'teamAccess'>, b: RowOf<'teamAccess'>) =>
      a.project_id === b.project_id && a.team_id === b.team_id,
    issueLabels: (a: RowOf<'issueLabels'>, b: RowOf<'issueLabels'>) =>
      a.issue_id === b.issue_id && a.label_id === b.label_id,
    issueSubs: (a: RowOf<'issueSubs'>, b: RowOf<'issueSubs'>) =>
      a.issue_id === b.issue_id && a.profile_id === b.profile_id,
    orgLoad: (a: RowOf<'orgLoad'>, b: RowOf<'orgLoad'>) =>
      a.issue_id === b.issue_id && (a.issue_id !== null || a.owner_id === b.owner_id),
  }

export type KeyedName = keyof typeof KEYED
export type ListedName = keyof typeof LISTED
export type SectionName = KeyedName | ListedName
export const KEYED_SECTIONS = Object.keys(KEYED) as KeyedName[]
export const LISTED_SECTIONS = Object.keys(LISTED) as ListedName[]

/** One row of section `S`. */
export type RowOf<S extends SectionName> = Snapshot[S][number]

/** The values outside the row sections. */
export type Scalars = Pick<
  Snapshot,
  | 'auth_user_id'
  | 'myProfileIds'
  | 'readMessageCount'
  | 'unreadTruncated'
  | 'readTruncated'
  | 'messagesCut'
  | 'delivered_at'
>

/** What one apply changed: for each section, every key whose row was
    added, changed or removed, with the row it had before (undefined when
    added). The row it has now is in the base. */
export type Changes = Partial<Record<SectionName, Map<string, object | undefined>>>

/** Freezes `value` and everything in it. A delivery's rows hold mostly
    strings and numbers, so only the objects among their fields are walked,
    without listing every field first. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    const fields = value as Record<string, unknown>
    for (const key in fields) {
      const inner = fields[key]
      if (inner && typeof inner === 'object') deepFreeze(inner)
    }
  }
  return value
}

/** Whether two rows hold the same data: their fields compared one by one,
    nested values (an organization's billing) by sameData. */
export function sameRow(a: object, b: object): boolean {
  if (a === b) return true
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  let count = 0
  for (const key in x) {
    const value = x[key]
    if (value === undefined) continue
    count++
    const other = y[key]
    if (value !== other && !(typeof value === 'object' && sameData(value, other))) return false
  }
  for (const key in y) if (y[key] !== undefined) count--
  return count === 0
}

/** The keys of `list` in order, read with `keyOf`. With `counted`, each
    key also takes its place among the rows of that key, as an owner's
    hidden load rows share one (orgLoad). Ids stay as they are otherwise,
    whatever they hold. */
function keysOf<R>(list: readonly R[], keyOf: (row: R) => string, counted: boolean): string[] {
  if (!counted) return list.map(keyOf)
  const seen = new Map<string, number>()
  return list.map((row) => {
    const key = keyOf(row)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return `${key}#${n}`
  })
}

/** One section's staged state: its rows in delivery order and their keys,
    the keys changed since the last apply with the row each had then, and
    whether keys came, went or moved since then. `index` finds a key's
    place, built when first asked. */
type Staged = {
  list: readonly object[]
  keys: readonly string[]
  pending: Map<string, object | undefined>
  moved: boolean
  index: Map<string, number> | null
}

/** Where each key of `state` is in its list. */
function indexOf(state: Staged): Map<string, number> {
  state.index ??= new Map(state.keys.map((key, i) => [key, i]))
  return state.index
}

/** Creates an empty base. */
export function createWorkspaceBase() {
  const empty = (): Staged => ({
    list: [],
    keys: [],
    pending: new Map(),
    moved: false,
    index: null,
  })
  const staged = new Map<SectionName, Staged>()
  // the applied rows: the keyed sections by key, every section as a list
  const maps = new Map<KeyedName, Map<string, object>>()
  const lists = new Map<SectionName, readonly object[]>()
  // the tasks flagged has_hidden_subtasks and has_hidden_parent, each Set
  // replaced, never changed, so one handed out keeps what it held
  const flagged = {
    hiddenSubtaskParents: new Set<string>() as ReadonlySet<string>,
    hiddenParentTasks: new Set<string>() as ReadonlySet<string>,
  }
  let scalars: Scalars | null = null
  let stagedScalars: Scalars | null = null

  const reset = () => {
    for (const name of [...KEYED_SECTIONS, ...LISTED_SECTIONS]) {
      staged.set(name, empty())
      lists.set(name, Object.freeze([]))
    }
    for (const name of KEYED_SECTIONS) maps.set(name, new Map())
    flagged.hiddenSubtaskParents = new Set()
    flagged.hiddenParentTasks = new Set()
    scalars = null
    stagedScalars = null
  }
  reset()

  /** Stages section `name` of a delivery: unchanged rows keep the object
      staged before, changed ones are frozen. Answers the keys it holds that
      the delivery before did not. */
  function stageSection(
    name: SectionName,
    next: readonly object[],
    keyOf: (row: never) => string,
  ): string[] {
    const state = staged.get(name) ?? empty()
    const prev = state.list
    const remember = (key: string, before: object | undefined) => {
      if (!state.pending.has(key)) state.pending.set(key, before)
    }
    // the usual delivery holds the same rows in the same order, which the
    // keys' fields tell without building every key
    const same = SAME_KEY[name] as (a: object, b: object) => boolean
    const sameKeys = next.length === prev.length && next.every((row, i) => same(prev[i], row))
    const keys = sameKeys
      ? state.keys
      : keysOf(next, keyOf as (row: object) => string, name === 'orgLoad')
    let list: object[]
    let changed = false
    const added: string[] = []
    if (sameKeys) {
      list = next.map((row, i) => {
        if (sameRow(prev[i], row)) return prev[i]
        changed = true
        remember(keys[i], prev[i])
        return deepFreeze(row)
      })
    } else {
      changed = true
      const before = new Map(state.keys.map((key, i) => [key, prev[i]]))
      list = next.map((row, i) => {
        const old = before.get(keys[i])
        before.delete(keys[i])
        if (old === undefined) added.push(keys[i])
        else if (sameRow(old, row)) return old
        remember(keys[i], old)
        return deepFreeze(row)
      })
      for (const [key, old] of before) remember(key, old)
      state.moved = true
      state.index = null
    }
    if (changed) {
      state.list = Object.freeze(list)
      state.keys = keys
    }
    staged.set(name, state)
    return added
  }

  return {
    /** Stages delivery `snap`, which apply() makes the rows. Answers the
        ids of the tasks it holds that the delivery before it did not. */
    stage(snap: Snapshot): Set<string> {
      let added: string[] = []
      for (const name of KEYED_SECTIONS) {
        const keys = stageSection(name, snap[name], KEYED[name])
        if (name === 'issues') added = keys
      }
      for (const name of LISTED_SECTIONS) stageSection(name, snap[name], LISTED[name])
      stagedScalars = {
        auth_user_id: snap.auth_user_id,
        myProfileIds: snap.myProfileIds,
        readMessageCount: snap.readMessageCount,
        unreadTruncated: snap.unreadTruncated,
        readTruncated: snap.readTruncated,
        messagesCut: snap.messagesCut,
        delivered_at: snap.delivered_at,
      }
      return new Set(added)
    },

    /** Makes the staged delivery the rows and answers what changed, or
        null when nothing was staged since the last apply. */
    apply(): Changes | null {
      if (stagedScalars === null) return null
      scalars = stagedScalars
      stagedScalars = null
      const changes: Changes = {}
      for (const [name, state] of staged) {
        if (!state.pending.size && !state.moved) continue
        lists.set(name, state.list)
        const map = maps.get(name as KeyedName)
        if (map) {
          if (state.moved) {
            map.clear()
            state.list.forEach((row, i) => {
              map.set(state.keys[i], row)
            })
          } else {
            const index = indexOf(state)
            for (const key of state.pending.keys()) {
              const at = index.get(key)
              if (at !== undefined) map.set(key, state.list[at])
            }
          }
        }
        // a row changed and changed back is no change
        const after = map ?? new Map(state.list.map((row, i) => [state.keys[i], row]))
        const changed = new Map<string, object | undefined>()
        for (const [key, old] of state.pending) {
          const now = after.get(key)
          if (old === undefined ? now !== undefined : now === undefined || !sameRow(old, now))
            changed.set(key, old)
        }
        if (name === 'issues' && changed.size) {
          const next = {
            hiddenSubtaskParents: new Set(flagged.hiddenSubtaskParents),
            hiddenParentTasks: new Set(flagged.hiddenParentTasks),
          }
          for (const key of changed.keys()) {
            const row = (map as Map<string, RowOf<'issues'>>).get(key)
            if (row?.has_hidden_subtasks) next.hiddenSubtaskParents.add(key)
            else next.hiddenSubtaskParents.delete(key)
            if (row?.has_hidden_parent) next.hiddenParentTasks.add(key)
            else next.hiddenParentTasks.delete(key)
          }
          for (const flag of ['hiddenSubtaskParents', 'hiddenParentTasks'] as const)
            if (!sameData(next[flag], flagged[flag])) flagged[flag] = next[flag]
        }
        // a list that only changed its order changed too
        if (changed.size || state.moved) changes[name] = changed
        state.pending = new Map()
        state.moved = false
      }
      return changes
    },

    /** The applied rows of keyed section `name`. */
    map<S extends KeyedName>(name: S): ReadonlyMap<string, RowOf<S>> {
      return maps.get(name) as Map<string, RowOf<S>>
    },
    /** The applied rows of section `name`, in delivery order. */
    list<S extends SectionName>(name: S): readonly RowOf<S>[] {
      return lists.get(name) as readonly RowOf<S>[]
    },
    /** The tasks the applied delivery flags with has_hidden_subtasks
        (hiddenSubtaskParents) or has_hidden_parent (hiddenParentTasks). A
        Set handed out never changes; an apply that changes it gives a new
        one. */
    flags: (name: 'hiddenSubtaskParents' | 'hiddenParentTasks') => flagged[name],
    /** Whether a delivery is staged that no apply took yet. */
    staging: () => stagedScalars !== null,
    /** The applied delivery's values outside the sections, or null before
        the first. */
    scalars: (): Scalars | null => scalars,
    /** The staged task `id`, from the newest delivery. */
    stagedTask(id: string): RowOf<'issues'> | undefined {
      const state = staged.get('issues')
      const at = state ? indexOf(state).get(id) : undefined
      return at === undefined ? undefined : (state?.list[at] as RowOf<'issues'>)
    },
    /** Forgets every row. */
    reset,
  }
}

export type WorkspaceBase = ReturnType<typeof createWorkspaceBase>
