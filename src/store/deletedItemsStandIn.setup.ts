/* A stand-in for the reads and writes of Settings › Projects › Deleted
   items (convex/deletedItems.ts page, roles, people, purgeSummary, item,
   restore and purge), for the jsdom tests and the browser benchmark's
   server (scripts/perf/server.mjs). It answers from a fixture of deleted
   items (DeletedFixture): the rows as one login's seats see them, with
   what the page's filters read beside each row. deletedFixtureOf builds
   one from a workspace the caller holds (the first tasks of its
   sub-projects as task items, one sub-project as a project item, deleters
   among its people and an agent's key), and
   src/store/deletedItemsParity.test.ts builds one from what the real
   functions stored and holds the answers to theirs.

   It applies the page's rules (convex/model/deletedItemsPage.ts) to the
   fixture:
   - without a scope, every seat's project entries and `scope_needed`
     unless kind is project, and a search there finds project entries by
     their names and keys and a task by its reference in every seat;
   - a scope of one organization names some of its projects, a top-level
     one standing for its sub-projects, or all of them; it lists the
     deleted sub-projects of its top-level projects as project entries
     (every project item with All projects), then its task items, and for
     a search or the assignee filter the tasks inside its project items,
     each an entry of its own;
   - project entries before task entries, each newest first, ties by the
     fixture's order, then id, the tasks of one project item by number;
   - `kind`, `deleted_by` with `via`, `someone`, `assignee` and the search
     (convex/lib/searchTerms.ts, whole words, the last also as a prefix,
     accents exact) apply before the page is cut, which `limit` sets;
   - `missing: 'matches'` on every search page, `legacy` on the scoped
     search and assignee pages of a seat that is not an admin's, and an
     admin's while the fixture holds older rows;
   - the refusals of an argument the page does not take, as bad_request,
     and of a search past LIMITS.search, as the rule.
   Its cursors are plain JSON of the arguments and the position, refused
   with bad_request for other arguments. It reads no read budget, so
   too_wide, both `missing` notes, `legacy`, a stopped page, hidden rows,
   people not ready or stopped, a failing read, slow, refused and paused
   restore calls and deferred items answer only when `force` asks for
   them. It imports nothing the benchmark's worker cannot load. */

import { ConvexError } from 'convex/values'
import { LIMITS, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import { matchesTerms, searchTerms } from '../../convex/lib/searchTerms'
import { issueKey } from '../../convex/lib/taskRefs'
import type {
  DeletedPeople,
  DeletedPerson,
  DeletedRole,
  PurgeSummary,
} from '../../convex/model/deletedItemsChoices'
import type {
  DeletedEntry,
  DeletedHit,
  DeletedPage,
  PageArgs,
} from '../../convex/model/deletedItemsPage'
import type { DeletedRow } from '../../convex/model/deletedItemsRows'

/** The reads the stand-in answers, by their function names. */
export const DELETED_READS = [
  'deletedItems:page',
  'deletedItems:roles',
  'deletedItems:people',
  'deletedItems:purgeSummary',
  'deletedItems:item',
] as const

/** Whether `name` is a read the stand-in answers. */
export const isDeletedRead = (name: string): boolean =>
  (DELETED_READS as readonly string[]).includes(name)

/** A task an item stores, as the search and the assignee filter read it:
    only the tasks of projects the seat may read. `path` is where its hit
    says it sat. */
export type DeletedTask = {
  num: number
  title: string
  description: string
  project_id: string
  assignee_id?: string
  archived: boolean
  path: string[]
}

/** One deleted item as one seat sees it: its row, what the filters read
    beside it, and its stored tasks. */
export type DeletedFixtureItem = {
  row: DeletedRow
  /** newer first among equal deletion times, as the server's _creationTime */
  order: number
  /** the profile that deleted it, while that profile is the one stored */
  deleted_by?: string
  /** how the seat may know it was deleted (model/deletedItemsRows.ts howOf) */
  how: string
  /** the projects that put a task item in a scope of some projects */
  scope: string[]
  /** a project item's top-level project, for a scope that names it */
  parent?: string
  tasks: DeletedTask[]
  /** what Delete now deletes with it, null for no admin's seat */
  purge?: PurgeSummary | null
}

/** One seat of the login. */
export type DeletedSeat = {
  org_id: string
  org_name: string
  me: string
  role: DeletedRole['role']
  can_purge: boolean
}

/** The deleted items one login sees, its seats, the projects each seat
    sees (live and archived, for a scope) and each organization's people. */
export type DeletedFixture = {
  seats: DeletedSeat[]
  items: DeletedFixtureItem[]
  projects: { id: string; org_id: string; parent_id?: string }[]
  people: (DeletedPerson & { org_id: string })[]
  /** an admin's organization holds rows stored before v0.1.122, the first
      release that wrote the page's fields */
  older?: boolean
}

/** States the stand-in answers whatever the fixture says, as the perf
    page's `deletedstate` parameter names them. */
export type ForcedDeleted = {
  tooWide?: boolean
  missing?: 'reads' | 'matches'
  legacy?: boolean
  /** each page stops after this many entries, with a cursor */
  stopped?: number
  /** an admin's task rows show hidden */
  hidden?: boolean
  peopleNotReady?: boolean
  /** each people batch stops after this many rows */
  peopleStopped?: number
  /** the reads that fail, by name without the module */
  fail?: readonly string[]
  /** ms each restore and purge call waits, for the caller to wait */
  slow?: number
  /** the call, counted from 1 over the fixture's life, refused whole */
  refuseAt?: number
  /** the call the pause meets */
  pauseAt?: number
  /** a restore defers a task item whose project item the same call restores */
  deferred?: boolean
  /** Delete now's count of a project item: at least 1,000 (`at-least`), or
      a failed read (`failed`) */
  purge?: 'at-least' | 'failed'
}

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })
const EMPTY: DeletedPage = { entries: [], items: [], next_cursor: null }
const NOT_CURSOR = 'cursor must be the next_cursor of an earlier page'

/** The page's most entries, DELETED_PAGE.rows. */
const ROWS = 25

/** The position a plain JSON cursor names for arguments `key`. */
function openCursor(text: string | undefined, key: string, refusal: string): number {
  if (text === undefined) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const [k, at] = Array.isArray(parsed) ? parsed : []
  if (k !== key || typeof at !== 'number') throw badRequest(refusal)
  return at
}

/* ------------------------------------------------------------ the page */

/** One entry before the page is cut: its item, the tasks it found, and
    where it sorts. */
type Found = { item: DeletedFixtureItem; part: 0 | 1; num: number; tasks: DeletedTask[] }

/** Project entries first, each part newest first, ties by order and id,
    the tasks of one project item by number. */
function newerFirst(a: Found, b: Found): number {
  if (a.part !== b.part) return a.part - b.part
  const x = a.item.row
  const y = b.item.row
  if (x.deleted_at !== y.deleted_at) return x.deleted_at < y.deleted_at ? 1 : -1
  if (a.item.order !== b.item.order) return b.item.order - a.item.order
  if (x.id !== y.id) return x.id < y.id ? 1 : -1
  return a.num - b.num
}

/** What a project entry's search reads: its names and keys. */
const projectNames = (item: DeletedFixtureItem) =>
  [item.row.title, item.row.key, ...item.row.projects.map((p) => `${p.name} ${p.key}`)].join(' ')

/** The hit an entry shows for the tasks it found (convex/model/
    deletedItemsPage.ts hitOf): a project item's task, or a task item's
    first match by number when its row does not show one already. */
function hitOf(found: Found, row: DeletedRow): DeletedHit | undefined {
  if (found.tasks.length === 0) return undefined
  if (row.kind === 'task' && found.tasks.some((t) => issueKey(t.num) === row.key)) return undefined
  const task = [...found.tasks].sort((x, y) => x.num - y.num)[0]
  const subtask = row.kind === 'task' && !row.redacted
  return {
    key: issueKey(task.num),
    title: task.title,
    ...(subtask ? { root_key: row.key, ...(row.hidden ? {} : { root_title: row.title }) } : {}),
    archived: task.archived,
    path: row.redacted ? [] : task.path,
    ...(row.redacted ? { redacted: true as const } : {}),
  }
}

/** The answer of deletedItems.page for `args` over `fx`. Throws the
    server's refusals. */
export function deletedPageOf(
  fx: DeletedFixture,
  args: PageArgs,
  force: ForcedDeleted = {},
): DeletedPage {
  const limit = args.limit ?? ROWS
  if (!Number.isInteger(limit) || limit < 1 || limit > ROWS)
    throw badRequest(`limit must be a whole number from 1 to ${ROWS}`)
  const scope = args.scope
  if (scope && 'project_ids' in scope) {
    const n = new Set(scope.project_ids).size
    if (n < 1 || n > 50) throw badRequest('scope.project_ids must name 1 to 50 projects')
  }
  if (args.assignee !== undefined && scope === undefined)
    throw badRequest('assignee needs a scope, one organization and its projects or all of them')
  if (args.someone === true && (args.deleted_by !== undefined || args.via !== undefined))
    throw badRequest('someone goes with neither deleted_by nor via, as it names no person')
  if (args.via !== undefined && args.deleted_by === undefined)
    throw badRequest('via needs deleted_by, the person whose deletes it narrows')
  const text = (args.search ?? '').trim()
  if (overText(LIMITS.search, text))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const terms = searchTerms(text)
  const key = JSON.stringify([
    scope === undefined
      ? null
      : [scope.org_id, 'all' in scope ? null : [...new Set(scope.project_ids)].sort()],
    args.kind ?? null,
    terms.map((t) => [t.word, t.prefix, t.num ?? null]),
    args.deleted_by ?? null,
    args.via ?? null,
    args.assignee ?? null,
    args.someone === true,
  ])
  const from = openCursor(args.cursor, key, NOT_CURSOR)
  const seats = scope === undefined ? fx.seats : fx.seats.filter((s) => s.org_id === scope.org_id)
  if (seats.length === 0) return EMPTY
  if (text !== '' && terms.length === 0)
    return scope === undefined && args.kind !== 'project' ? { ...EMPTY, scope_needed: true } : EMPTY
  if (force.tooWide && scope !== undefined) return { ...EMPTY, too_wide: true }
  const orgs = new Set(seats.map((s) => s.org_id))
  // the projects a scope of some projects holds, and its top-level ones
  let held: Set<string> | null = null
  let tops = new Set<string>()
  if (scope !== undefined && 'project_ids' in scope) {
    const seen = fx.projects.filter((p) => p.org_id === scope.org_id)
    const named = seen.filter((p) => scope.project_ids.includes(p.id))
    if (named.length === 0) return EMPTY
    tops = new Set(named.filter((p) => p.parent_id === undefined).map((p) => p.id))
    held = new Set(named.map((p) => p.id))
    for (const p of seen) if (p.parent_id !== undefined && tops.has(p.parent_id)) held.add(p.id)
  }
  const scopeIds = held
  const holdsProject = (item: DeletedFixtureItem) =>
    scopeIds === null || (item.parent !== undefined && tops.has(item.parent))
  const holdsTasks = (item: DeletedFixtureItem) =>
    scopeIds === null ||
    (item.row.kind === 'project' ? holdsProject(item) : item.scope.some((id) => scopeIds.has(id)))
  const asAsked = (item: DeletedFixtureItem) => {
    if (args.someone === true) return item.deleted_by === undefined
    if (args.deleted_by === undefined) return true
    if (item.deleted_by !== args.deleted_by) return false
    return args.via === undefined || item.how === args.via || item.how.startsWith(`${args.via}:`)
  }
  const assigned = (task: DeletedTask) =>
    args.assignee === undefined || task.assignee_id === args.assignee
  const kept = fx.items.filter(
    (item) =>
      orgs.has(item.row.org_id) && item.row.state !== ('purging' as string) && asAsked(item),
  )
  const found: Found[] = []
  if (args.kind !== 'task' && !(scope !== undefined && args.assignee !== undefined))
    for (const item of kept)
      if (
        item.row.kind === 'project' &&
        holdsProject(item) &&
        (terms.length === 0 || matchesTerms(terms, { title: projectNames(item), description: '' }))
      )
        found.push({ item, part: 0, num: 0, tasks: [] })
  const tasks = args.kind !== 'project'
  const refs = terms.filter((t) => t.num != null)
  /** The entries of the tasks `item` holds that `keep` keeps: a task item
      once, a project item once a task. */
  const entriesOf = (item: DeletedFixtureItem, keep: (task: DeletedTask) => boolean) => {
    const hits = item.tasks.filter((task) => assigned(task) && keep(task))
    if (hits.length === 0) return
    if (item.row.kind === 'task') found.push({ item, part: 1, num: 0, tasks: hits })
    else for (const task of hits) found.push({ item, part: 1, num: task.num, tasks: [task] })
  }
  const matches = (task: DeletedTask) =>
    matchesTerms(terms, { num: task.num, title: task.title, description: task.description })
  if (scope === undefined) {
    // a task reference finds its task in every seat, and no title does
    if (tasks && refs.length > 0)
      for (const item of kept)
        entriesOf(item, (task) => refs.some((r) => r.num === task.num) && matches(task))
  } else if (tasks) {
    const inScope = kept.filter(holdsTasks)
    if (terms.length > 0) for (const item of inScope) entriesOf(item, matches)
    else if (args.assignee !== undefined) for (const item of inScope) entriesOf(item, () => true)
    else
      for (const item of inScope)
        if (item.row.kind === 'task') found.push({ item, part: 1, num: 0, tasks: [] })
  }
  found.sort(newerFirst)
  // the server ends a full page with a cursor, even where nothing follows,
  // and a stopped page with one while anything is left
  const size = force.stopped !== undefined ? Math.min(force.stopped, limit) : limit
  const shown = found.slice(from, from + size)
  const next =
    shown.length === limit || (size < limit && from + size < found.length) ? from + size : null
  const entries: DeletedEntry[] = []
  const rows = new Map<string, DeletedRow>()
  for (const f of shown) {
    const seat = seats.find((s) => s.org_id === f.item.row.org_id)
    let row = f.item.row
    if (force.hidden && seat?.role === 'admin' && row.kind === 'task') {
      const { status: _status, reason: _reason, ...rest } = row
      row = { ...rest, title: '', hidden: true }
    }
    rows.set(row.id, row)
    const hit = hitOf(f, row)
    entries.push(hit === undefined ? { item_id: row.id } : { item_id: row.id, task: hit })
  }
  const page: DeletedPage = {
    entries,
    items: [...rows.values()],
    next_cursor: next === null ? null : JSON.stringify([key, next]),
  }
  if (scope === undefined && args.kind !== 'project') page.scope_needed = true
  // matches may be missing from every search page
  const searchNote = terms.length > 0 ? 'matches' : undefined
  const missing = force.missing ?? searchNote
  if (missing !== undefined) page.missing = missing
  const legacy =
    force.legacy === true ||
    (scope !== undefined &&
      tasks &&
      (terms.length > 0 || args.assignee !== undefined) &&
      // anyone but an admin always, an admin while the organization holds
      // older rows (convex/model/deletedItemsPage.ts olderRows)
      seats.some((s) => s.role !== 'admin' || fx.older === true))
  if (legacy) page.legacy = true
  return page
}

/* ------------------------------------------------- beside the entries */

/** deletedItems.roles over `fx`. */
export const deletedRolesOf = (fx: DeletedFixture): DeletedRole[] =>
  fx.seats.map((s) => ({
    org_id: s.org_id,
    org_name: s.org_name,
    role: s.role,
    can_purge: s.can_purge,
  }))

/** The people batch's size, PEOPLE_BATCH. */
const PEOPLE = 25

/** deletedItems.people over `fx`: an organization's people in name key
    order, ties by id, 25 a batch, with a search of every word of the name. */
export function deletedPeopleOf(
  fx: DeletedFixture,
  args: { org_id: string; search?: string; cursor?: string },
  force: ForcedDeleted = {},
): DeletedPeople {
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const scope = JSON.stringify([args.org_id, nameKey(search)])
  const from = openCursor(
    args.cursor,
    scope,
    'cursor must come from an earlier batch of these people, for the same organization and search',
  )
  const seat = fx.seats.find((s) => s.org_id === args.org_id)
  if (seat === undefined) return { state: 'ready', rows: [], next: null, stopped: false }
  if (force.peopleNotReady) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(search))
  const all = fx.people
    .filter((p) => p.org_id === args.org_id && matches(nameKey(p.name)))
    .sort((a, b) => {
      const ka = nameKey(a.name)
      const kb = nameKey(b.name)
      if (ka !== kb) return ka < kb ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  const size = force.peopleStopped ?? PEOPLE
  const rows = all
    .slice(from, from + size)
    .map(({ org_id: _org, ...person }) => ({ ...person, you: person.id === seat.me }))
  const end = from + size >= all.length
  return {
    state: 'ready',
    rows,
    next: end ? null : JSON.stringify([scope, from + size]),
    stopped: force.peopleStopped !== undefined && !end,
  }
}

/** The items that wait for item `id`, and those that wait for them in
    turn, `id` among them. */
function waitingFor(fx: DeletedFixture, id: string): Set<string> {
  const along = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const item of fx.items) {
      const holder = item.row.blocked?.item_id
      if (holder !== undefined && along.has(holder) && !along.has(item.row.id)) {
        along.add(item.row.id)
        grew = true
      }
    }
  }
  return along
}

/** deletedItems.purgeSummary over `fx`: null for no admin's seat and an
    item not ready or stuck. */
export function deletedPurgeSummaryOf(fx: DeletedFixture, id: string): PurgeSummary | null {
  const item = fx.items.find((i) => i.row.id === id)
  if (!item) return null
  const seat = fx.seats.find((s) => s.org_id === item.row.org_id)
  if (seat?.role !== 'admin') return null
  if (item.row.state !== 'ready' && item.row.state !== 'stuck') return null
  if (item.purge !== undefined) return item.purge
  if (item.row.kind === 'task') return { along: 0, exact: true }
  return { along: waitingFor(fx, id).size - 1, exact: true }
}

/** deletedItems.item over `fx`. */
export const deletedItemOf = (fx: DeletedFixture, id: string): DeletedRow | null =>
  fx.items.find((i) => i.row.id === id)?.row ?? null

/** What read `name` answers for `args`, or throws its refusal or a forced
    failure. */
export function deletedStandIn(
  fx: DeletedFixture,
  name: string,
  args: Record<string, unknown>,
  force: ForcedDeleted = {},
): unknown {
  const short = name.slice('deletedItems:'.length)
  if (force.fail?.includes(short)) throw new Error(`deletedItems.${short} failed`)
  switch (name) {
    case 'deletedItems:page':
      return deletedPageOf(fx, args as PageArgs, force)
    case 'deletedItems:roles':
      return deletedRolesOf(fx)
    case 'deletedItems:people':
      return deletedPeopleOf(fx, args as { org_id: string }, force)
    case 'deletedItems:purgeSummary': {
      if (force.purge === 'failed') throw new Error('deletedItems.purgeSummary failed')
      const summary = deletedPurgeSummaryOf(fx, String(args.id))
      // a task item takes nothing along, whatever the bound
      const project = deletedItemOf(fx, String(args.id))?.kind === 'project'
      return force.purge === 'at-least' && summary !== null && project
        ? { along: 1000, exact: false }
        : summary
    }
    case 'deletedItems:item':
      return deletedItemOf(fx, String(args.id))
  }
  throw new Error(`not a Deleted items read: ${name}`)
}

/* ------------------------------------------------------------- writes */

/** The restore and purge calls the stand-in answered, to count `refuseAt`
    and `pauseAt` by. */
const callsOf = new WeakMap<DeletedFixture, number>()

/** The refusal a forced call meets, or null. */
function forcedRefusal(
  fx: DeletedFixture,
  force: ForcedDeleted,
): ConvexError<{ code: string; message: string }> | null {
  const n = (callsOf.get(fx) ?? 0) + 1
  callsOf.set(fx, n)
  if (force.pauseAt === n)
    return new ConvexError({
      code: 'paused',
      message: 'Qivo is offline. Edits wait until it is back.',
    })
  if (force.refuseAt === n)
    return new ConvexError({
      code: 'rule',
      message: 'restoring is paused while the organization is read-only',
    })
  return null
}

/** Takes item `id` out of `fx`, and lets the items that waited for it be
    restored. */
function takeOut(fx: DeletedFixture, id: string) {
  fx.items = fx.items.filter((i) => i.row.id !== id)
  for (const item of fx.items) {
    if (item.row.blocked?.item_id !== id) continue
    const { blocked: _gone, ...row } = item.row
    item.row = { ...row, can_restore: true }
  }
}

/** deletedItems.restore over `fx`: each id restored, refused with the
    reason its row shows, deferred behind a project item of the same call
    (with `force.deferred`), or not_found. Restored items leave `fx`. */
export function deletedRestore(
  fx: DeletedFixture,
  args: { org_id: string; ids: string[] },
  force: ForcedDeleted = {},
) {
  if (args.ids.length > LIMITS.restoreBatch.max)
    throw new ConvexError({ code: 'rule', message: LIMITS.restoreBatch.refusal })
  const refusal = forcedRefusal(fx, force)
  if (refusal !== null) throw refusal
  const out = {
    restored: [] as string[],
    stepping: [] as string[],
    refused: [] as { id: string; reason: string }[],
    deferred: [] as string[],
  }
  for (const id of new Set(args.ids)) {
    const item = fx.items.find((i) => i.row.id === id && i.row.org_id === args.org_id)
    if (!item) {
      out.refused.push({ id, reason: 'not_found' })
      continue
    }
    const holder = item.row.blocked?.item_id
    if (force.deferred && holder !== undefined && args.ids.includes(holder)) {
      out.deferred.push(id)
      continue
    }
    if (item.row.state !== 'ready') out.refused.push({ id, reason: item.row.state })
    else if (!item.row.can_restore)
      out.refused.push({ id, reason: item.row.blocked?.reason ?? 'no_access' })
    else out.restored.push(id)
  }
  for (const id of out.restored) takeOut(fx, id)
  return out
}

/** deletedItems.purge over `fx`: each id deleted for good with what waits
    for it, or not_found. */
export function deletedPurge(
  fx: DeletedFixture,
  args: { org_id: string; ids: string[] },
  force: ForcedDeleted = {},
) {
  if (args.ids.length > LIMITS.purgeBatch.max)
    throw new ConvexError({ code: 'rule', message: LIMITS.purgeBatch.refusal })
  const refusal = forcedRefusal(fx, force)
  if (refusal !== null) throw refusal
  const purged: string[] = []
  const refused: { id: string; reason: string }[] = []
  for (const id of new Set(args.ids)) {
    const item = fx.items.find((i) => i.row.id === id && i.row.org_id === args.org_id)
    if (!item) {
      refused.push({ id, reason: 'not_found' })
      continue
    }
    const along = waitingFor(fx, id)
    fx.items = fx.items.filter((i) => !along.has(i.row.id))
    purged.push(id)
  }
  return { purged, refused }
}

/* --------------------------------------------- a fixture from a workspace */

/** The parts of a workspace deletedFixtureOf reads (convex/lib/
    workspaceJoin.ts Workspace). */
export type DeletedSource = {
  orgs: readonly { id: string; name: string }[]
  myProfileIds: readonly string[]
  profiles: readonly {
    id: string
    org_id: string
    name: string
    kind: 'person' | 'agent'
    org_role: string
    active: boolean
    auth_user_id?: string
  }[]
  projects: readonly {
    id: string
    org_id: string
    type: string
    key: string
    name: string
    parent_id?: string
    lead_id?: string
    archived_at?: string
  }[]
  issues: readonly {
    id: string
    org_id: string
    project_id: string
    num: number
    title: string
    description?: string
    status: string
    assignee_id?: string
  }[]
}

/**
 * A fixture of deleted items over `ws` for its login, as the benchmark's
 * page and the jsdom tests read it: the first `tasks` tasks by number of
 * the home organization's live sub-projects after the first as task
 * items, one a minute back from `at`, and the first live sub-project as a
 * project item with its tasks, deleted an hour before, unless
 * `projectItem` is false. The login deleted most of them; every third
 * task item another person of the organization deleted, and every seventh
 * an agent through its key, named "agent key". An admin's seat sees every
 * item, anyone else's its own deletes. Each other organization of the
 * login gets a project item of its first sub-project, for a page whose
 * rows span several.
 */
export function deletedFixtureOf(
  ws: DeletedSource,
  o: { tasks: number; at?: string; projectItem?: boolean },
): DeletedFixture {
  const at = Date.parse(o.at ?? '2026-10-16T15:00:00.000Z')
  const home = ws.orgs[0]
  const seats: DeletedSeat[] = ws.orgs.flatMap((org) => {
    const me = ws.profiles.find((p) => p.org_id === org.id && ws.myProfileIds.includes(p.id))
    if (!me) return []
    const admin = me.org_role === 'admin'
    const lead = ws.projects.some((p) => p.org_id === org.id && p.lead_id === me.id)
    const role: DeletedRole['role'] = admin ? 'admin' : lead ? 'lead' : 'user'
    return [{ org_id: org.id, org_name: org.name, me: me.id, role, can_purge: admin }]
  })
  const seatOf = (org: string) => seats.find((s) => s.org_id === org)
  const projectById = new Map(ws.projects.map((p) => [p.id, p]))
  const other = ws.profiles.find(
    (p) => p.org_id === home.id && p.kind === 'person' && !ws.myProfileIds.includes(p.id),
  )
  const agent = ws.profiles.find((p) => p.org_id === home.id && p.kind === 'agent')
  /** Who deleted the `i`th item of organization `org`, and how. */
  const deleterOf = (org: string, i: number) => {
    const me = seatOf(org)?.me
    if (org === home.id && i % 7 === 6 && agent)
      return {
        profile: agent.id,
        how: 'agent_keys:key-1',
        deleter: {
          you: false,
          name: agent.name,
          kind: 'agent_keys' as const,
          credential_name: 'agent key',
        },
      }
    if (org === home.id && i % 3 === 2 && other)
      return {
        profile: other.id,
        how: 'app',
        deleter: { you: false, name: other.name, kind: 'app' as const },
      }
    const self = ws.profiles.find((p) => p.id === me)
    return {
      profile: me,
      how: 'app',
      deleter: { you: true, name: self?.name, kind: 'app' as const },
    }
  }
  const pathOf = (projectId: string) => {
    const p = projectById.get(projectId)
    const top = p?.parent_id === undefined ? undefined : projectById.get(p.parent_id)
    return [top?.name ?? '', p?.name ?? ''].filter(Boolean)
  }
  const stored = (issue: DeletedSource['issues'][number]): DeletedTask => ({
    num: issue.num,
    title: issue.title,
    description: issue.description ?? '',
    project_id: issue.project_id,
    ...(issue.assignee_id ? { assignee_id: issue.assignee_id } : {}),
    archived: false,
    path: pathOf(issue.project_id),
  })
  const projectsOf = (p: DeletedSource['projects'][number], tasks: number) => [
    { id: p.id, name: p.name, key: p.key, type: 'project' as const, tasks, archived_tasks: 0 },
  ]
  const items: DeletedFixtureItem[] = []
  /** Item `id` of organization `org`, deleted at `when` by the `i`th
      deleter, when the seat sees it. */
  const add = (
    org: string,
    i: number,
    when: number,
    fields: Pick<DeletedRow, 'id' | 'kind' | 'key' | 'title' | 'counts' | 'projects' | 'path'> &
      Partial<DeletedRow>,
    rest: Pick<DeletedFixtureItem, 'scope' | 'tasks'> & { parent?: string },
  ) => {
    const seat = seatOf(org)
    const who = deleterOf(org, i)
    if (seat === undefined || (seat.role !== 'admin' && who.profile !== seat.me)) return
    const deleter = {
      ...who.deleter,
      ...(who.profile === undefined ? {} : { profile_id: who.profile }),
      who: `${who.profile ?? ''}|${who.how}`,
    }
    items.push({
      row: {
        org_id: org,
        org_name: ws.orgs.find((x) => x.id === org)?.name ?? '',
        archived: false,
        deleted_at: new Date(when).toISOString(),
        deleter,
        state: 'ready',
        can_restore: true,
        can_purge: seat.can_purge,
        ...fields,
      },
      order: 0,
      deleted_by: who.profile,
      how: who.how,
      ...rest,
    })
  }
  const subs = ws.projects.filter(
    (p) => p.org_id === home.id && p.parent_id !== undefined && p.archived_at === undefined,
  )
  const [first, ...rest] = subs
  if (o.projectItem !== false && first !== undefined) {
    const inside = ws.issues.filter((t) => t.project_id === first.id)
    add(
      home.id,
      0,
      at - 3_600_000,
      {
        id: `deleted-${first.id}`,
        kind: 'project',
        key: first.key,
        title: first.name,
        counts: { tasks: inside.length, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
        projects: projectsOf(first, inside.length),
        path: [projectById.get(first.parent_id ?? '')?.name ?? ''],
      },
      { scope: [first.id], parent: first.parent_id, tasks: inside.map(stored) },
    )
  }
  ws.issues
    .filter((t) => t.org_id === home.id && rest.some((p) => p.id === t.project_id))
    .sort((a, b) => a.num - b.num)
    .slice(0, o.tasks)
    .forEach((t, i) => {
      const project = projectById.get(t.project_id)
      add(
        home.id,
        i,
        at - (i + 1) * 60_000,
        {
          id: `deleted-${t.id}`,
          kind: 'task',
          key: issueKey(t.num),
          title: t.title,
          status: t.status as DeletedRow['status'],
          counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
          projects: project ? projectsOf(project, 1) : [],
          path: pathOf(t.project_id),
        },
        { scope: [t.project_id], tasks: [stored(t)] },
      )
    })
  for (const seat of seats) {
    if (seat.org_id === home.id) continue
    const p = ws.projects.find((x) => x.org_id === seat.org_id && x.parent_id !== undefined)
    if (!p) continue
    add(
      seat.org_id,
      0,
      at - 120_000,
      {
        id: `deleted-${p.id}`,
        kind: 'project',
        key: p.key,
        title: p.name,
        counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
        projects: projectsOf(p, 0),
        path: [projectById.get(p.parent_id ?? '')?.name ?? ''],
      },
      { scope: [p.id], parent: p.parent_id, tasks: [] },
    )
  }
  return {
    seats,
    items,
    projects: ws.projects
      .filter((p) => seats.some((s) => s.org_id === p.org_id))
      .map((p) => ({
        id: p.id,
        org_id: p.org_id,
        ...(p.parent_id === undefined ? {} : { parent_id: p.parent_id }),
      })),
    people: ws.profiles.map((p) => ({
      org_id: p.org_id,
      id: p.id,
      name: p.name,
      org_role: p.org_role as DeletedPerson['org_role'],
      kind: p.kind,
      active: p.active,
      pending: p.kind === 'person' && !p.auth_user_id,
      you: false,
    })),
  }
}
