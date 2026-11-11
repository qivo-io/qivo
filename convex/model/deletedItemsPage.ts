/* The Deleted items page (deletedItems.page, design 6.2): one page of up to
 * DELETED_PAGE.rows entries, project entries first and then task entries,
 * each part newest first, with the type, deleter, search and assignee
 * filters applied before the page is cut, and a sealed next_cursor that
 * continues after its last entry. The app reads it from the release after
 * v0.1.148, and it builds its rows with model/deletedItemsRows.ts rowOf,
 * the row deletedItems.item answers, so it shows nothing of an item that
 * the item's row would not show the same caller.
 *
 * Scope. Without one the page reads every active seat of the login and
 * lists project entries only, and says that task entries need a scope
 * (scope_needed); a search there finds project entries by name and key and
 * a task by its reference (QN-12 or 12) in every seat, never task titles or
 * descriptions. A scope names one organization and either some of its
 * projects or all of them. A top-level project stands for itself and its
 * sub-projects, live, archived and in Deleted items. A scope holds the
 * deleted sub-projects of its top-level projects as project entries (All
 * projects: every project item), and as task entries the task items with a
 * task in one of its projects and, for a search or the assignee filter, the
 * tasks inside its project items, each an entry of its own.
 *
 * Sources. A seat reads only the ranges that can hold what it sees, split
 * by kind and narrowed to the scope (projectPlan, taskPlan). An
 * organization admin reads the organization's
 * items of a kind, one person's, or those under the scope's projects. Anyone
 * else reads their own deletes, the project items whose stored rows name
 * them as lead, and the items under projects of the scope (live or
 * archived), with the task items that have a subtask there: with All
 * projects under each project they lead, and with some projects under each
 * project of the scope they see, whatever their level there, since a
 * family from before the subtask rule can join it to a project they lead
 * outside the scope (scopeRanges). The ordered ranges are read newest
 * first from the cursor and merged; the stored-lead and cross-project
 * ranges have no order, so they are read whole and sorted. Every item is
 * judged by viewOf for the seat in its organization, so its scope, filters
 * and visibility decide before the page is cut. A task item is in the
 * scope of anyone but an admin through a project of it they see (heldFor).
 *
 * Deleter filters. `deleted_by` keeps one person's deletes by the
 * reference predicate, and `via` narrows them to 'app', a kind of
 * credential (its bare table, which every viewer may know) or one
 * credential where the seat may know which (`table:id`). `someone` keeps
 * the deletes whose deleter line says Someone for the seat, deleted by no
 * profile that passes the reference predicate. No index serves it, so the
 * seat reads its usual ranges and keeps those in code (deletedAsAsked).
 *
 * Order and cursor. Project entries come before task entries. Within each,
 * items come by deleted_at, _creationTime and _id, all descending, the
 * order every range's index gives, and the tasks a search or the assignee
 * filter finds inside one project item follow its place by number. The
 * admin's assignee path reads its index instead (assigneeEntries), in that
 * index's order. next_cursor seals the position of the last entry, or of
 * the last item a stopped page looked at, with the path it belongs to and
 * a digest of the arguments, so it opens only for the same arguments and
 * path and shows nothing of the position.
 *
 * Search. Every term must match a whole word, the last also as a prefix,
 * and a task reference its number, with accents exact (lib/searchTerms.ts),
 * which is main Search's rule, kept here for project entries too, rather
 * than the substring match of Settings lists (coordinator, 2026-11-05). A
 * project entry matches by the names and keys its row shows. Task entries
 * come from the task numbers the text names and from search_text queries,
 * each filtered to the items of one of the seat's sources, with fixed
 * allowances set before any reads (gatherTasks); the cross-project items no
 * query covers are read whole. A candidate counts only in a project the
 * seat may read in its view of the item (ItemView readable), so an
 * admin's search keeps its sources and drops the tasks they cannot read,
 * which is how it narrows an admin's search (coordinator, 2026-11-05).
 * Every page gathers the same candidates and orders them, and is the
 * entries after its cursor.
 *
 * Stops. A browse or scan that spends its budget ends the page with
 * next_cursor at the last item it looked at, also with no entries. A page
 * whose rows run out of their own budget ends before the first entry whose
 * row it could not build, and past it with `reads` when that is its first
 * entry (answerOf).
 * `missing` says that entries sorting before the page's last one may be
 * missing: `reads` when the budget cut an unordered range or the opening of
 * a seat's sources, or the page went past an entry whose row its budget
 * could not build, and `matches` on every search page, an admin's
 * included, never computed from a stop, since every seat's search sources
 * hold tasks hidden from it (owner, 2026-10-28, as main Search). Rows
 * stored before v0.1.122, the first release that wrote the page's fields,
 * hold none of them, so only their number finds them; `legacy` says so
 * (olderRows). */

import type { IndexRange } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { digestText, openCursorText, sealCursorText } from '../lib/archiveCursorSeal'
import { ARCHIVED_SCOPE } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import type { DeletedItemKind } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS } from '../lib/limits'
import {
  convexText,
  matchesTerms,
  type SearchFields,
  type SearchTerm,
  searchTerms,
} from '../lib/searchTerms'
import { issueKey } from '../lib/taskRefs'
import { type ItemView, type Sight, sameReference, sightOf, viewOf } from './deletedItems'
import {
  type DeletedRow,
  hitPath,
  howOf,
  type Reads,
  rowOf,
  spending,
  spent,
} from './deletedItemsRows'

type Item = Doc<'deleted_items'>
type Task = Doc<'deleted_tasks'>
type Profile = Doc<'profiles'>

/**
 * What one page reads and answers. `rows` entries a page.
 *
 * `sources` bounds the ordered ranges the browse or the assignee scan of
 * anyone but an admin merges for one seat (scopeRanges): their own
 * deletes, each top-level project in the scope that they lead, and each
 * other project in the scope that the range of no such top-level project
 * covers, live and archived alike. With All projects that other project is
 * one they lead or whose top-level project they lead; with some projects
 * it is any they see, whatever their level there. The assignee scan reads
 * both kinds in each of these ranges, so it counts each once, as the
 * browse does. The bound is the design size's sum for one person
 * (coordinator, 2026-11-05): the 200 live and 500 archived sub-projects one
 * person may read, each led one by one, the organization's 200 live and
 * 300 archived top-level projects, each led, and their own deletes, 1,201
 * ranges, which also holds a scope of all the projects they can read.
 * Inside it they browse, filter by assignee and search; past it they get
 * too_wide, and a scope of fewer projects serves them. `adminSources`
 * bounds the ranges an admin's scope of some projects opens, the ordered
 * and the cross-project ranges together (taskPlan, searchPlan). Past it the admin reads the
 * organization's range of the kind and keeps the scope in code, and
 * searches the organization in one query, which leaves the search's room
 * to its results. `searches` search queries one call plans, past which the
 * seat's search reads its organization through one query and judges every
 * candidate. `candidates` results one search query reads at most, below
 * the 1,024 one Convex search query can scan, and `results` the results
 * the call's search queries read together, split into equal allowances
 * before any of them reads.
 *
 * Convex stops a query at 16 MiB, 32,000 documents or 4,096 ranges. `call`
 * covers every read of the call but the rows of the page's entries and
 * takes five eighths of each: 10 MiB, 20,000 documents and 2,560 ranges.
 * `build` covers those rows (answerOf) and takes two eighths more: 4 MiB,
 * 8,000 documents and 1,024 ranges. Its check comes before each row and
 * after each task a redacted row passes over to find the one it shows,
 * whose rows hold their searchable text, so the page ends before the first
 * entry whose row it ran out of reads for (answerOf). The last eighth
 * holds what runs past the last checks: the sight of the seat the call
 * opened last, a document past each other check, and the reads
 * authedQuery makes for the login. The assignee filter reads one task
 * item's assigned tasks whole past its check (scanEntry, assigneeEntries),
 * at most LIMITS.subtasks.max + 1 rows, whose searchable text at the
 * description cap in a three-byte script can pass that eighth; with
 * ordinary text it is a few dozen KB.
 * `find` is the share of `call` the ranges that find items may spend:
 * 6 MiB, 12,000 documents and 1,600 ranges. Its ranges are the page's own
 * bound, set by the widest browse inside the design size: a member who
 * leads the 700 sub-projects one by one opens a range for their own
 * deletes, for each sub-project and for its cross-project rows, and the
 * range of the stored rows that name them as lead, which with the project
 * entries before them is 1,403 ranges on the first page. That leaves about
 * 4 MiB, 8,000 documents and 960 ranges for sights and for judging items,
 * which reads mostly what the seat's sight holds. A part of a page that
 * cannot open every source inside `find` lists none of their items. The
 * page ends after the tasks of a project item the part went on inside
 * first, or where the part starts, for the next page to read it with the
 * whole budget, or, when the part is the page's first, with
 * `missing: 'reads'` (readPart).
 * `gather` is the part of `call` a page's task search keeps for itself, so
 * a page that lists project entries first leaves the search the same room
 * as a page that starts with it, and every page gathers the same
 * candidates. Every search result counts as an index range, as Convex
 * fetches each by id. A mutable object, so tests can lower it; replace
 * `call`, `build`, `find` and `gather` whole rather than change their
 * fields.
 *
 * tests/deletedItemsPageReads.test.ts logs what each case reads under
 * convex-test at the design size with ordinary text, one figure raised a
 * case, with the page's ranges as it counts them, `call` and `build`
 * together, each search result a range, and its documents and bytes as
 * convex-test counts them. Every case answered whole. No search source
 * reads rows stored before v0.1.122, so each search query's allowance is
 * its own. The rows of each page's entries (`build`) read one range and no
 * document, as judging the items had read what the rows show. An admin's
 * search over a project item they read none of answers `matches` with no
 * entry, and a search past `searches` reads the organization in one query.
 *
 * An organization admin's page, which judges task items by the admin's own
 * levels, costs about what a standard user's with the same rows costs, plus
 * the items only an admin lists. A timing on a local backend on 8 November
 * 2026 found the admins' and the member's searches reading about what
 * convex-test counts, and the two leads' searches reading more ranges, for
 * a reason it did not find.
 */
export const DELETED_PAGE = {
  rows: 25,
  sources: 1_201,
  adminSources: 256,
  searches: 96,
  candidates: 256,
  results: 512,
  call: { bytes: 10 * 1024 * 1024, rows: 20_000, ranges: 2_560 },
  build: { bytes: 4 * 1024 * 1024, rows: 8_000, ranges: 1_024 },
  find: { bytes: 6 * 1024 * 1024, rows: 12_000, ranges: 1_600 },
  gather: { bytes: 4 * 1024 * 1024, rows: 8_000, ranges: 1_536 },
}

/* What a lookup of a task number counts against the search's room, from
 * before its read to the verdict on the task it found, whatever it read:
 * whether a task hidden from the caller holds the number changes nothing
 * a later source may read. A lookup reads at most four rows, an item, and
 * the reads viewOf makes of a project item's stored rows. */
const LOOKUP: Reads = { ranges: 16, rows: 128, bytes: 256 << 10 }

/** A task the search or the assignee filter found, where its item's row
 * does not show it: a subtask of a task item, or a task of a project item.
 * `key`, `title`, `archived` and `path` are the task's own; `path` is where
 * it sat, its project after the top-level or parent project, empty for a
 * redacted task item as on its row. `root_key` and `root_title` name a task
 * item's root when the task found is one of its subtasks, as the item's row
 * would, so the page can say that the root and its other subtasks come back
 * too. A redacted item's hit has neither, since its row never names the
 * root, and a hidden item's has `root_key` without `root_title`, as its row
 * shows the key without the title (hitOf). */
export type DeletedHit = {
  key: string
  title: string
  root_key?: string
  root_title?: string
  archived: boolean
  path: string[]
  redacted?: true
}

/** One line of the page: an item, or a task found inside one. */
export type DeletedEntry = {
  item_id: string
  task?: DeletedHit
}

/** One page of Deleted items. `items` holds each item an entry names once,
 * as its row shows it to the caller, so a restore target is never listed
 * twice. */
export type DeletedPage = {
  entries: DeletedEntry[]
  items: DeletedRow[]
  next_cursor: string | null
  /** no scope, so no task entry was read but by a task reference */
  scope_needed?: true
  /** the scope needs more sources than one page merges; choose fewer projects */
  too_wide?: true
  /** entries that sort before the last one may be missing, `reads` after
   * a budget stop and `matches` on every search page */
  missing?: 'matches' | 'reads'
  /** the search or the assignee filter may miss tasks deleted before
   * v0.1.122, the first release that wrote the page's fields, which only a
   * search for their key finds (olderRows) */
  legacy?: true
}

/** What the page is asked (deletedItems.page). `someone` keeps the deletes
 * of people no longer in the organization and goes with neither
 * `deleted_by` nor `via`. */
export type PageArgs = {
  scope?: { org_id: string; project_ids: string[] } | { org_id: string; all: true }
  kind?: DeletedItemKind
  search?: string
  deleted_by?: string
  via?: string
  someone?: true
  assignee?: string
  cursor?: string
  limit?: number
}

const EMPTY: DeletedPage = { entries: [], items: [], next_cursor: null }

/* ------------------------------------------------------------ the order */

/** Where an entry sorts inside its part: its item's deleted_at,
 * _creationTime and _id, newest first, then `num`, lowest first: 0 for an
 * item, a task's number for a task of a project item. The admin's assignee
 * path puts a task row's deleted_at, _creationTime and _id here instead. */
type At = { at: string; ct: number; id: string; num: number }

/** Project entries (0) come before task entries (1). */
type Part = 0 | 1

/** A position: in a part, after `at`, or at the part's start. */
type Place = { part: Part; at: At | null }

/** The two orders a cursor can be in: items, or the admin's assignee
 * index. A cursor opens only on its own path. */
type Path = 'items' | 'assignee'

const itemAt = (item: Item, num = 0): At => ({
  at: item.deleted_at,
  ct: item._creationTime,
  id: item._id,
  num,
})

/** Whether `a` sorts before `b`. */
function before(a: At, b: At): boolean {
  if (a.at !== b.at) return a.at > b.at
  if (a.ct !== b.ct) return a.ct > b.ct
  if (a.id !== b.id) return a.id > b.id
  return a.num < b.num
}

const order = (a: At, b: At): number => (before(a, b) ? -1 : before(b, a) ? 1 : 0)

/* ----------------------------------------------------------- the cursor */

/* The version a page cursor carries outside and inside its sealed text.
 * Every sealed cursor shares one key (lib/archiveCursorSeal.ts), so the
 * version inside keeps a cursor of another list from opening here. */
const CURSOR_PREFIX = 'd1~'
const CURSOR_VERSION = 'deleted-page-1'
/* Far above the longest cursor this page writes, so only junk is refused
 * unopened. */
const CURSOR_MAX = 4096

type Cursor = { path: Path; place: Place }

/** `c` sealed for the arguments of `key`, as next_cursor. */
async function cursorText(key: string, c: Cursor): Promise<string> {
  const { at } = c.place
  const position = at === null ? null : [at.at, at.ct, at.id, at.num]
  const body = JSON.stringify([CURSOR_VERSION, key, c.path, c.place.part, position])
  return `${CURSOR_PREFIX}${await sealCursorText(body)}`
}

/** The cursor `text` holds for the arguments of `key`, or null when it is
 * not one this page wrote for them. */
async function openCursor(text: string, key: string): Promise<Cursor | null> {
  if (!text.startsWith(CURSOR_PREFIX) || text.length > CURSOR_MAX) return null
  const opened = await openCursorText(text.slice(CURSOR_PREFIX.length))
  if (opened === null) return null
  let body: unknown
  try {
    body = JSON.parse(opened)
  } catch {
    return null
  }
  if (!Array.isArray(body) || body.length !== 5) return null
  const [version, from, path, part, position] = body
  if (version !== CURSOR_VERSION || from !== key) return null
  if ((path !== 'items' && path !== 'assignee') || (part !== 0 && part !== 1)) return null
  if (position === null) return { path, place: { part, at: null } }
  if (!Array.isArray(position) || position.length !== 4) return null
  const [at, ct, id, num] = position
  if (typeof at !== 'string' || typeof id !== 'string') return null
  if (typeof ct !== 'number' || !Number.isFinite(ct) || !Number.isSafeInteger(num)) return null
  return { path, place: { part, at: { at, ct, id, num } } }
}

/* ------------------------------------------------------- the arguments */

/** The arguments as the page reads them. `terms` is empty without a
 * search. */
type Asked = {
  scope?: { org: string; ids: string[] | null }
  kind?: DeletedItemKind
  text: string
  terms: SearchTerm[]
  deletedBy?: string
  via?: string
  /** only the deletes whose deleter line says Someone */
  someone: boolean
  assignee?: string
  limit: number
}

/** `a` checked and read, or a refusal (badRequest, or the search's own). */
function asked(a: PageArgs): Asked {
  const limit = a.limit ?? DELETED_PAGE.rows
  if (!Number.isInteger(limit) || limit < 1 || limit > DELETED_PAGE.rows)
    throw badRequest(`limit must be a whole number from 1 to ${DELETED_PAGE.rows}`)
  let scope: Asked['scope']
  if (a.scope !== undefined) {
    if ('all' in a.scope) scope = { org: a.scope.org_id, ids: null }
    else {
      const ids = [...new Set(a.scope.project_ids)]
      if (ids.length < 1 || ids.length > ARCHIVED_SCOPE.ids)
        throw badRequest(`scope.project_ids must name 1 to ${ARCHIVED_SCOPE.ids} projects`)
      scope = { org: a.scope.org_id, ids: ids.sort() }
    }
  }
  if (a.assignee !== undefined && scope === undefined)
    throw badRequest('assignee needs a scope, one organization and its projects or all of them')
  if (a.someone === true && (a.deleted_by !== undefined || a.via !== undefined))
    throw badRequest('someone goes with neither deleted_by nor via, as it names no person')
  if (a.via !== undefined && a.deleted_by === undefined)
    throw badRequest('via needs deleted_by, the person whose deletes it narrows')
  const text = limitedText(LIMITS.search, a.search ?? '')
  return {
    scope,
    kind: a.kind,
    text,
    terms: searchTerms(text),
    deletedBy: a.deleted_by,
    via: a.via,
    someone: a.someone === true,
    assignee: a.assignee,
    limit,
  }
}

/** The digest a cursor of `a` seals: everything but the cursor and the
 * limit, so a cursor of other arguments never opens. `someone` joins it
 * only when asked, so the cursors of every other page keep their digest. */
const keyOf = (a: Asked): Promise<string> =>
  digestText(
    JSON.stringify([
      a.scope === undefined ? null : [a.scope.org, a.scope.ids],
      a.kind ?? null,
      a.terms.map((t) => [t.word, t.prefix, t.num === undefined ? 'w' : t.num]),
      a.deletedBy ?? null,
      a.via ?? null,
      a.assignee ?? null,
      ...(a.someone ? ['someone'] : []),
    ]),
  )

/* --------------------------------------------------------------- seats */

/** One seat the page reads, with its sight of its organization. `admin`
 * decides the management parts, since an organization admin keeps every
 * item, which are the organization's ranges, heldFor, the admin's assignee
 * index, olderRows' probe and a project entry's names in a search
 * (projectEntry). Which tasks the seat reads is its view of each item
 * (model/deletedItems.ts viewOf), an admin's included. */
type Seat = { me: Profile; sight: Sight; orgName: string; admin: boolean }

/** What a scope holds in one seat's sight: every project, or the named
 * projects the seat sees with the sub-projects it sees of the top-level
 * ones among them (`ids`), the named top-level projects (`tops`) and the
 * named projects themselves (`named`). */
type Scoped = { all: boolean; ids: Set<string>; tops: Set<string>; named: Doc<'projects'>[] }

/** The scope `ids` names in `seat`'s sight, or null when it names nothing
 * the seat sees: unknown, foreign, hidden and deleted ids alike. */
function scopedOf(seat: Seat, ids: string[] | null): Scoped | null {
  if (ids === null) return { all: true, ids: new Set(), tops: new Set(), named: [] }
  const { sight } = seat
  const sees = (p: Doc<'projects'>) => sight.levels.levelOf(p) !== null
  const named: Doc<'projects'>[] = []
  for (const id of ids) {
    const p = sight.projects.get(id)
    if (p !== undefined && sees(p)) named.push(p)
  }
  if (named.length === 0) return null
  const tops = new Set(named.filter((p) => p.type === 'meta').map((p) => p.id))
  const held = new Set(named.map((p) => p.id))
  for (const p of sight.projects.values())
    if (p.parent_id !== undefined && tops.has(p.parent_id) && sees(p)) held.add(p.id)
  return { all: false, ids: held, tops, named }
}

/** Whether `scope` holds project item `item` as a project entry: a deleted
 * sub-project of one of its top-level projects, or any with All projects. */
const holdsProject = (scope: Scoped | null, item: Item): boolean =>
  scope === null ||
  scope.all ||
  (item.parent_project_id !== undefined && scope.tops.has(item.parent_project_id))

/** Whether `scope` holds the tasks of `item`: a project item it holds, or
 * a task item with a project in it. It reads the item's fields, before
 * viewOf; heldFor then checks a task item against what the seat sees. */
function holdsTasks(scope: Scoped, item: Item): boolean {
  if (scope.all) return true
  if (item.kind === 'project') return holdsProject(scope, item)
  const ids = [item.project_id, item.parent_project_id, ...item.projects.map((p) => p.id)]
  return ids.some((id) => id !== undefined && scope.ids.has(id))
}

/** Whether `scope` holds the tasks of `item` as `seat` sees it (`view`,
 * from viewOf). An admin keeps every item with every project of it, so the
 * item's fields decide (holdsTasks), its root's top-level project and a
 * deleted project included, and a scoped browse lists a hidden item there.
 * For anyone else a task item counts only through a project its view
 * holds, so a scope never lists an item through a project hidden from
 * them, such as a redacted item's root. */
const heldFor = (seat: Seat, scope: Scoped, item: Item, view: ItemView): boolean =>
  scope.all ||
  seat.admin ||
  item.kind === 'project' ||
  view.projects.some((p) => scope.ids.has(p.id))

/** Whether `item` passes the deleter filters for `seat`. With `someone`,
 * its deleter line says Someone, since no profile that passes the
 * reference predicate deleted it, as deletedItemsRows.ts deleterOf
 * decides. With `deletedBy`, the person it names deleted it while their
 * profile is the one that deleted, and with `via` it was deleted the way
 * `via` names, as the seat may know it (deletedItemsRows.ts howOf) or by
 * that way's table for a bare table, since a row shows the kind of
 * credential to every viewer. A `table:id` the seat may not know matches
 * nothing. */
function deletedAsAsked(seat: Seat, a: Asked, item: Item): boolean {
  if (a.someone) {
    const id = item.deleted_by
    return id === undefined || !sameReference(seat.sight.profiles.get(id), item)
  }
  if (a.deletedBy === undefined) return true
  const deleter = seat.sight.profiles.get(a.deletedBy)
  if (item.deleted_by !== a.deletedBy || !sameReference(deleter, item)) return false
  if (a.via === undefined) return true
  const how = howOf(seat.me, item)
  return how === a.via || how.startsWith(`${a.via}:`)
}

/** Whether `seat`'s person leads live or archived project `p`. */
const leads = (seat: Seat, p: Doc<'projects'> | undefined): boolean =>
  p !== undefined && seat.sight.levels.levelOf(p) === 'lead'

/**
 * The projects whose ranges hold the task items `seat`'s person sees in
 * `scope`, for anyone but an admin: each top-level project they lead in it
 * (`tops`), read with its sub-projects (parentRange), each other project
 * read on its own (`alone`, projectRange), and each project whose
 * cross-project task rows name more items (`cross`). With All projects
 * those are the projects they lead or whose top-level project they lead,
 * which hold every item they see. With some projects they are the
 * projects of the scope they see, whatever their level there. A family
 * from before the subtask rule (model/issues.ts sameTopLevel) can join a
 * project of the scope to one they lead outside it, under another
 * top-level project, and they see it through that one, so only the ranges
 * of the scope's own projects name it: its root's range, or the
 * cross-project rows of its subtask. viewOf and heldFor then judge every
 * item these ranges name, so none hidden from them is listed (taskPlan,
 * searchPlan).
 */
function scopeRanges(seat: Seat, scope: Scoped) {
  const tops: string[] = []
  const alone: string[] = []
  const cross: string[] = []
  const { projects } = seat.sight
  const inScope = (p: Doc<'projects'>) => scope.all || scope.ids.has(p.id)
  for (const p of projects.values()) {
    if (!inScope(p)) continue
    if (p.type === 'meta') {
      if (leads(seat, p)) tops.push(p.id)
      continue
    }
    const parent = p.parent_id === undefined ? undefined : projects.get(p.parent_id)
    const topLed = leads(seat, parent)
    if (scope.all && !leads(seat, p) && !topLed) continue
    // read with its top-level project, whose range the page reads too
    if (!(topLed && parent !== undefined && inScope(parent))) alone.push(p.id)
    cross.push(p.id)
  }
  return { tops, alone, cross }
}

/* -------------------------------------------------------------- the run */

/** One call's state: its budgets, what it found and how it stopped. */
type Run = {
  ctx: QueryCtx
  a: Asked
  call: Reads
  build: Reads
  find: Reads
  gather: Reads
  /** what the call must leave in `call` while project entries are read
   * before a task search, which then has `gather` */
  floor: Reads | null
  seats: Map<string, Seat>
  entries: Placed[]
  next: Place | null
  /** an unordered range or a seat's opening was cut, or the page went
   * past an entry whose row it could not build */
  reads: boolean
  /** the page has search terms, so matches may be missing */
  matches: boolean
  path: Path
}

/** An entry before its row is built: its seat, item and position, and the
 * tasks found in the item that may name it (a task item's matches, a
 * project item's one task). */
type Pending = { seat: Seat; item: Item; view: ItemView; at: At; tasks: Task[] }

/** An entry of the page, with the part it is in. */
type Placed = Pending & { part: Part }

/** Whether the run's reads must stop before the next item or range. */
const stopped = (run: Run): boolean =>
  spent(run.call) ||
  spent(run.find) ||
  (run.floor !== null &&
    (run.call.bytes <= run.floor.bytes ||
      run.call.rows <= run.floor.rows ||
      run.call.ranges <= run.floor.ranges))

const room = (run: Run): number => run.a.limit - run.entries.length

/** The seat of `me`, read once a call: its sight, which every item it
 * judges shares, spends `call`. */
async function seatOf(run: Run, me: Profile): Promise<Seat> {
  const known = run.seats.get(me.org_id)
  if (known !== undefined) return known
  const reader = spending(run.ctx, run.call)
  const sight = await sightOf(reader, me)
  const orgName = (await byId(reader, 'organizations', me.org_id))?.name ?? ''
  const seat = { me, sight, orgName, admin: me.org_role === 'admin' }
  run.seats.set(me.org_id, seat)
  return seat
}

/* ----------------------------------------------------------- the ranges */

/* Where a range of an index starts, newest first, on the deleted_at that
 * follows its equality prefix: at the range's start (null), from deleted_at
 * `at` down (`lte`), below it (`lt`), or within `at` from _creationTime
 * `ct` down (`eq`), the field every index orders by after its own. */
type Bound = null | { op: 'lte' | 'lt'; at: string } | { op: 'eq'; at: string; ct: number }

/* A range of documents in an index's order, deleted_at then _creationTime
 * and _id, all descending, from `bound` down, one index range. */
type Opener<D> = (ctx: QueryCtx, bound: Bound) => AsyncIterable<D>

/** An index range whose next field is deleted_at, as its equality prefix
 * leaves it. */
type AtRange = IndexRange & {
  lte(field: 'deleted_at', at: string): IndexRange
  lt(field: 'deleted_at', at: string): IndexRange
  eq(field: 'deleted_at', at: string): { lte(field: '_creationTime', ct: number): IndexRange }
}

/** The range `r` narrowed to `bound`. */
function bounded(r: AtRange, bound: Bound): IndexRange {
  if (bound === null) return r
  if (bound.op === 'eq') return r.eq('deleted_at', bound.at).lte('_creationTime', bound.ct)
  return bound.op === 'lt' ? r.lt('deleted_at', bound.at) : r.lte('deleted_at', bound.at)
}

/**
 * The documents of `open` after `from`, in index order, read through
 * `ctx`, whose meter counts each range it opens.
 *
 * With `seek` it starts at `from` itself: the documents of `from`'s
 * deleted_at from its _creationTime down, then, once those end, a second
 * range below that deleted_at. A later page then reads none of the rows
 * before its cursor however many share one deleted_at, as every task of a
 * project item does in deleted_tasks (assigneeEntries).
 *
 * Without `seek` it reads one range from `from`'s deleted_at down and
 * passes over the documents of that deleted_at that sort at or before
 * `from`, so each source of an item part costs one range on a later page,
 * as on the first, which DELETED_PAGE.find is sized for. An item's
 * deleted_at is when its own delete began, one item to a transaction
 * (model/deletedItems.ts insertItem), so items share one only as deletes
 * begun in the same millisecond do, and those are all it passes over.
 *
 * Either way it passes over the documents that share `from`'s
 * _creationTime and sort at or before it, which Convex can give two
 * documents.
 */
async function* rangeAfter<D extends { deleted_at?: string; _creationTime: number; _id: string }>(
  ctx: QueryCtx,
  open: Opener<D>,
  from: At | null,
  seek = false,
): AsyncGenerator<D> {
  if (from === null) {
    yield* open(ctx, null)
    return
  }
  const after = (doc: D) =>
    doc.deleted_at !== from.at ||
    doc._creationTime < from.ct ||
    (doc._creationTime === from.ct && doc._id < from.id)
  const first: Bound = seek ? { op: 'eq', at: from.at, ct: from.ct } : { op: 'lte', at: from.at }
  for await (const doc of open(ctx, first)) if (after(doc)) yield doc
  if (seek) yield* open(ctx, { op: 'lt', at: from.at })
}

const items = (ctx: QueryCtx) => ctx.db.query('deleted_items')

/** An organization's items of `kind`. */
const kindRange =
  (org: string, kind: DeletedItemKind): Opener<Item> =>
  (ctx, bound) =>
    items(ctx)
      .withIndex('by_org_kind_deleted', (q) => bounded(q.eq('org_id', org).eq('kind', kind), bound))
      .order('desc')

/** One person's deletes of `kind`, or of both kinds without one. */
const deleterRange =
  (org: string, by: string, kind?: DeletedItemKind): Opener<Item> =>
  (ctx, bound) =>
    kind === undefined
      ? items(ctx)
          .withIndex('by_org_deleter', (q) =>
            bounded(q.eq('org_id', org).eq('deleted_by', by), bound),
          )
          .order('desc')
      : items(ctx)
          .withIndex('by_org_deleter_kind_deleted', (q) =>
            bounded(q.eq('org_id', org).eq('deleted_by', by).eq('kind', kind), bound),
          )
          .order('desc')

/** The items of `kind` under top-level project `parent`, or of both kinds
 * without one: its deleted sub-projects, and the task items rooted in its
 * sub-projects. */
const parentRange =
  (org: string, parent: string, kind?: DeletedItemKind): Opener<Item> =>
  (ctx, bound) =>
    kind === undefined
      ? items(ctx)
          .withIndex('by_org_parent', (q) =>
            bounded(q.eq('org_id', org).eq('parent_project_id', parent), bound),
          )
          .order('desc')
      : items(ctx)
          .withIndex('by_org_parent_kind_deleted', (q) =>
            bounded(q.eq('org_id', org).eq('parent_project_id', parent).eq('kind', kind), bound),
          )
          .order('desc')

/** The items rooted in `project`, of either kind: the planner keeps task
 * items only, since a project item rooted there can be restoring. */
const projectRange =
  (org: string, project: string): Opener<Item> =>
  (ctx, bound) =>
    items(ctx)
      .withIndex('by_org_project', (q) =>
        bounded(q.eq('org_id', org).eq('project_id', project), bound),
      )
      .order('desc')

/** The tasks of one assignee in an organization, by delete, newest first.
 * A project item's tasks all share its deleted_at, so the admin's assignee
 * path reads it with `seek` (rangeAfter). */
const assigneeRange =
  (org: string, person: string): Opener<Task> =>
  (ctx, bound) =>
    ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_assignee', (q) =>
        bounded(q.eq('org_id', org).eq('assignee_id', person), bound),
      )
      .order('desc')

/* ------------------------------------------------------------ the plans */

/** Where one seat's items of a part come from (projectPlan, taskPlan):
 * ranges read newest first, the projects whose cross-project task rows
 * name more items, and whether the project items whose stored rows name
 * the person as lead count. `keeps` is what the scope and the kind keep of
 * what they read. */
type Plan = {
  ordered: Opener<Item>[]
  cross: string[]
  storedLead: boolean
  keeps: (item: Item) => boolean
}

/** The project entries' sources of `seat` for `scope` (null: no scope), or
 * too_wide. */
function projectPlan(run: Run, seat: Seat, scope: Scoped | null): Plan | 'too_wide' {
  const { a } = run
  const org = seat.me.org_id
  const keeps = (item: Item) => item.kind === 'project' && holdsProject(scope, item)
  const all = scope === null || scope.all
  if (seat.admin) {
    let ordered: Opener<Item>[]
    if (a.deletedBy !== undefined) ordered = [deleterRange(org, a.deletedBy, 'project')]
    else if (all || scope.tops.size > DELETED_PAGE.adminSources)
      ordered = [kindRange(org, 'project')]
    else ordered = [...scope.tops].map((top) => parentRange(org, top, 'project'))
    return { ordered, cross: [], storedLead: false, keeps }
  }
  const ordered = [deleterRange(org, seat.me.id, 'project')]
  for (const p of seat.sight.projects.values())
    if (p.type === 'meta' && leads(seat, p) && (all || scope.tops.has(p.id)))
      ordered.push(parentRange(org, p.id, 'project'))
  if (ordered.length > DELETED_PAGE.sources) return 'too_wide'
  return { ordered, cross: [], storedLead: true, keeps }
}

/** The task entries' sources of `seat` for `scope`: task items only, as a
 * browse lists them, or too_wide. With `projects`, for the assignee scan of
 * anyone but an admin (an admin's goes through assigneeEntries), its own
 * deletes and each led top-level project are one range of both kinds
 * rather than a range for each part, so each source counts once toward
 * DELETED_PAGE.sources, and the plan also reads the project items whose
 * stored rows name the person as lead and keeps the project items the
 * scope holds. Anyone but an admin reads the ranges of scopeRanges, with
 * some projects those of every project of the scope they see. */
function taskPlan(run: Run, seat: Seat, scope: Scoped, projects = false): Plan | 'too_wide' {
  const { a } = run
  const org = seat.me.org_id
  const keeps = (item: Item) => item.kind === 'task' && holdsTasks(scope, item)
  if (seat.admin) {
    const wide = { ordered: [kindRange(org, 'task')], cross: [], storedLead: false, keeps }
    if (a.deletedBy !== undefined)
      return { ...wide, ordered: [deleterRange(org, a.deletedBy, 'task')] }
    if (scope.all) return wide
    const ordered: Opener<Item>[] = []
    const cross: string[] = []
    for (const p of scope.named) {
      // a sub-project of a top-level project the scope names is read with it
      if (p.parent_id !== undefined && scope.tops.has(p.parent_id)) continue
      if (p.type === 'meta') {
        ordered.push(parentRange(org, p.id, 'task'))
        for (const sub of seat.sight.projects.values())
          if (sub.parent_id === p.id) cross.push(sub.id)
      } else {
        ordered.push(projectRange(org, p.id))
        cross.push(p.id)
      }
    }
    if (ordered.length + cross.length > DELETED_PAGE.adminSources) return wide
    return { ordered, cross, storedLead: false, keeps }
  }
  const kind = projects ? undefined : 'task'
  const { tops, alone, cross } = scopeRanges(seat, scope)
  const ordered = [
    deleterRange(org, seat.me.id, kind),
    ...tops.map((id) => parentRange(org, id, kind)),
    ...alone.map((id) => projectRange(org, id)),
  ]
  if (ordered.length > DELETED_PAGE.sources) return 'too_wide'
  if (!projects) return { ordered, cross, storedLead: false, keeps }
  return { ordered, cross, storedLead: true, keeps: (item) => holdsTasks(scope, item) }
}

/* ---------------------------------------------------- reading the items */

/** A merge of item streams in item order that hands out each item once. */
function mergeOf() {
  const streams: AsyncIterator<Item>[] = []
  const heads: (Item | null)[] = []
  const handed = new Set<string>()
  return {
    /** Opens `stream`, reading its first item. */
    async add(stream: AsyncIterator<Item>): Promise<void> {
      streams.push(stream)
      const step = await stream.next()
      heads.push(step.done === true ? null : step.value)
    },
    /** The next item in item order, or null once every stream ended. */
    async next(): Promise<Item | null> {
      for (;;) {
        let best = -1
        for (let i = 0; i < heads.length; i++) {
          const head = heads[i]
          const leader = best < 0 ? null : heads[best]
          if (head !== null && (leader === null || before(itemAt(head), itemAt(leader)))) best = i
        }
        const item = best < 0 ? null : heads[best]
        if (item === null) return null
        const step = await streams[best].next()
        heads[best] = step.done === true ? null : step.value
        if (handed.has(item.id)) continue
        handed.add(item.id)
        return item
      }
    },
    async close(): Promise<void> {
      for (const stream of streams) await stream.return?.(undefined)
    },
  }
}

/** Items sorted in item order, after `from`. */
async function* sortedAfter(found: Item[], from: At | null): AsyncGenerator<Item> {
  for (const item of found.sort((x, y) => order(itemAt(x), itemAt(y))))
    if (from === null || before(from, itemAt(item))) yield item
}

/** The items `plan`'s unordered ranges name for `seat`, read whole through
 * `reader`, each item by id once, until `stop` says the reads ran out.
 * `cut` then, since an item it did not read could sort anywhere. */
async function unorderedItems(
  reader: QueryCtx,
  seat: Seat,
  plan: Plan,
  known: Map<string, Item | null>,
  stop: () => boolean,
): Promise<{ found: Item[]; cut: boolean }> {
  const org = seat.me.org_id
  const ids = new Set<string>()
  const name = async (rows: AsyncIterable<{ item_id: string }>): Promise<boolean> => {
    for await (const row of rows) {
      ids.add(row.item_id)
      if (stop()) return false
    }
    return true
  }
  const ranges: (() => AsyncIterable<{ item_id: string }>)[] = []
  if (plan.storedLead)
    ranges.push(() =>
      reader.db
        .query('deleted_rows')
        .withIndex('by_org_lead', (q) => q.eq('org_id', org).eq('lead_id', seat.me.id)),
    )
  for (const project of plan.cross)
    ranges.push(() =>
      reader.db
        .query('deleted_tasks')
        .withIndex('by_org_cross_project', (q) =>
          q.eq('org_id', org).eq('cross_project_id', project),
        ),
    )
  for (const range of ranges) if (stop() || !(await name(range()))) return { found: [], cut: true }
  const found: Item[] = []
  for (const id of ids) {
    if (!known.has(id)) {
      if (stop()) return { found, cut: true }
      known.set(id, await byId(reader, 'deleted_items', id))
    }
    const item = known.get(id)
    if (item !== undefined && item !== null && item.org_id === org) found.push(item)
  }
  return { found, cut: false }
}

/** Opens the sources `plans` name, one plan for each seat, after `from`,
 * into one merge: each seat's unordered ranges first, read whole, then its
 * ordered ranges side by side. `cut` when the budget stopped the opening,
 * as an item of a source it did not open could sort anywhere. */
async function openPlans(
  run: Run,
  plans: { seat: Seat; plan: Plan }[],
  from: At | null,
): Promise<{ merge: ReturnType<typeof mergeOf>; cut: boolean }> {
  const merge = mergeOf()
  const reader = spending(run.ctx, run.find, run.call)
  const known = new Map<string, Item | null>()
  for (const { seat, plan } of plans) {
    if (stopped(run)) return { merge, cut: true }
    const unordered = await unorderedItems(reader, seat, plan, known, () => stopped(run))
    if (unordered.found.length > 0) await merge.add(sortedAfter(unordered.found, from))
    if (unordered.cut) return { merge, cut: true }
    for (const open of plan.ordered) {
      if (stopped(run)) return { merge, cut: true }
      await merge.add(rangeAfter(reader, open, from))
    }
  }
  return { merge, cut: false }
}

/** What a part makes of one item: its entries, none when it is hidden or
 * filtered out, and the last position it looked at, which is inside a
 * project item whose tasks it stopped reading. `from` is the number after
 * which a project item's tasks go on, 0 from its start. */
type Judge = (seat: Seat, item: Item, from: number) => Promise<{ pending: Pending[]; last: At }>

/** Reads one part through the merge of `plans` after `from`, judging each
 * item with `judge`, until the page is full, the part ends or the budget
 * stops it. A stop ends the page with next_cursor at the last position it
 * looked at, also with no entries. A part that cannot open all of its
 * sources looks at none of their items, since one of a source it did not
 * open could sort first. Having gone on inside a project item, it ends the
 * page at the last of that item's tasks it looked at, which the next page
 * goes on after. Otherwise a part that follows another on the page (`fresh`
 * false) ends the page with next_cursor at `from`, where the next page
 * reads it with the whole budget, and a fresh one ends it with no cursor
 * and sets `reads`. Answers whether the page goes on to the next part. */
async function readPart(
  run: Run,
  part: Part,
  plans: { seat: Seat; plan: Plan }[],
  from: At | null,
  judge: Judge,
  fresh: boolean,
): Promise<boolean> {
  const later = (): false => {
    run.next = { part, at: from }
    return false
  }
  const bySeat = new Map(plans.map((p) => [p.seat.me.org_id, p]))
  // the seat of an item its plan keeps and the deleter filters pass
  const kept = (item: Item | null): Seat | null => {
    if (item === null) return null
    const at = bySeat.get(item.org_id)
    if (at === undefined || !at.plan.keeps(item)) return null
    return deletedAsAsked(at.seat, run.a, item) ? at.seat : null
  }
  let looked: At | null = null
  // a page that stopped inside a project item's tasks goes on there first
  if (from !== null && from.num > 0) {
    const id = run.ctx.db.normalizeId('deleted_items', from.id)
    const item = id === null ? null : await spending(run.ctx, run.call).db.get(id)
    const seat = kept(item)
    if (item !== null && seat !== null) {
      const judged = await judge(seat, item, from.num)
      looked = judged.last
      if (take(run, part, judged.pending)) return false
    }
  }
  const { merge, cut } = await openPlans(run, plans, from)
  if (cut && looked === null) {
    if (!fresh) {
      await merge.close()
      return later()
    }
    run.reads = true
  }
  try {
    for (;;) {
      if (stopped(run)) {
        if (looked !== null) run.next = { part, at: looked }
        else if (!fresh) return later()
        else run.reads = true
        return false
      }
      const item = await merge.next()
      if (item === null) return true
      looked = itemAt(item)
      const seat = kept(item)
      if (seat === null) continue
      const judged = await judge(seat, item, 0)
      looked = judged.last
      if (take(run, part, judged.pending)) return false
    }
  } finally {
    await merge.close()
  }
}

/** Adds `pending` to the page in order while it has room. Answers true
 * once the page is full, with next_cursor at its last entry, since more
 * may follow. */
function take(run: Run, part: Part, pending: Pending[]): boolean {
  for (const p of pending) {
    run.entries.push({ ...p, part })
    if (room(run) === 0) {
      run.next = { part, at: p.at }
      return true
    }
  }
  return false
}

/* ------------------------------------------------------- judging items */

/** The names and keys a project entry's row shows for `projects` of the
 * item: the root's, and those of `projects`, with the names they carry
 * now, as rowOf shows them. */
function projectNames(seat: Seat, item: Item, projects: Item['projects']): string {
  const names = [item.name, item.key ?? '']
  for (const p of projects) {
    const live = seat.sight.projects.get(p.id)
    names.push(sameReference(live, item) ? `${live.name} ${live.key}` : `${p.name} ${p.key}`)
  }
  return names.join(' ')
}

/** Whether the names of `projects` of the item hold every term of the
 * search. */
const namesMatch = (run: Run, seat: Seat, item: Item, projects: Item['projects']): boolean =>
  matchesTerms(run.a.terms, { title: projectNames(seat, item, projects), description: '' })

/** A project entry for an item the seat sees whose names hold every term.
 * An organization admin's view of a project item holds every project of
 * the item (model/deletedItems.ts adminView), so their search compares the
 * names first and passes over an item that cannot match without the reads
 * of its view, which a search that matches little would otherwise make for
 * every project item of the organization. Anyone else's view may leave
 * projects out, so theirs is read first and only its names count, and what
 * the page reads and spends for them never depends on a name they may not
 * see. */
const projectEntry =
  (run: Run): Judge =>
  async (seat, item) => {
    const last = itemAt(item)
    const searching = run.a.terms.length > 0
    if (searching && seat.admin && !namesMatch(run, seat, item, item.projects))
      return { pending: [], last }
    const view = await viewOf(spending(run.ctx, run.call), seat.sight.memo, seat.me, item)
    if (view === null || item.state === 'purging') return { pending: [], last }
    if (searching && !namesMatch(run, seat, item, view.projects)) return { pending: [], last }
    return { pending: [{ seat, item, view, at: last, tasks: [] }], last }
  }

/** A task entry for a task item the seat sees in `scope`, as a browse
 * lists it. */
const taskEntry =
  (run: Run, scope: Scoped): Judge =>
  async (seat, item) => {
    const last = itemAt(item)
    const view = await viewOf(spending(run.ctx, run.call), seat.sight.memo, seat.me, item)
    if (view === null || item.state === 'purging') return { pending: [], last }
    if (!heldFor(seat, scope, item, view)) return { pending: [], last }
    return { pending: [{ seat, item, view, at: last, tasks: [] }], last }
  }

/** Whether `task` counts for the assignee filter: assigned to that person
 * while their profile is the one that existed when its item was deleted
 * (the reference predicate), so a seat that reuses a removed person's id
 * takes over none of their tasks. */
const assignedAsAsked = (seat: Seat, a: Asked, item: Item, task: Task): boolean =>
  a.assignee === undefined ||
  (task.assignee_id === a.assignee && sameReference(seat.sight.profiles.get(a.assignee), item))

/** Whether `view` lets its viewer read the project of `task`, so they may
 * be told about it. Every candidate of the search, task reference and
 * assignee entry passes it. */
const shows = (view: ItemView, task: Task): boolean =>
  view.readable.some((p) => p.id === task.project_id)

/** The entries of the assignee filter for an item the scan reached (anyone
 * but an admin) in `scope`: a task item once, with the tasks assigned in
 * projects the seat may read, and a project item once for each such task
 * after `from`, by number. */
const scanEntry =
  (run: Run, scope: Scoped): Judge =>
  async (seat, item, from) => {
    const done = { pending: [], last: itemAt(item) }
    const person = run.a.assignee
    if (person === undefined) return done
    const reader = spending(run.ctx, run.call)
    const view = await viewOf(reader, seat.sight.memo, seat.me, item)
    if (view === null || item.state === 'purging') return done
    if (!heldFor(seat, scope, item, view)) return done
    if (!sameReference(seat.sight.profiles.get(person), item)) return done
    const tasks = reader.db
      .query('deleted_tasks')
      .withIndex('by_item_assignee', (q) =>
        q.eq('item_id', item.id).eq('assignee_id', person).gt('num', from),
      )
    if (item.kind === 'task') {
      const assigned: Task[] = []
      for await (const task of tasks) if (shows(view, task)) assigned.push(task)
      if (assigned.length === 0) return done
      return { pending: [{ seat, item, view, at: itemAt(item), tasks: assigned }], last: done.last }
    }
    // a project item's tasks one at a time, each an entry, so a page full
    // or out of reads stops at the task it looked at last
    const pending: Pending[] = []
    for await (const task of tasks) {
      const at = itemAt(item, task.num)
      if (shows(view, task)) pending.push({ seat, item, view, at, tasks: [task] })
      if (pending.length >= room(run) || stopped(run)) return { pending, last: at }
    }
    return { pending, last: done.last }
  }

/* ------------------------------------------------- the admin's assignee */

/**
 * The assignee filter for an organization admin's seat without a search:
 * the person's tasks in the organization (deleted_tasks by_org_assignee),
 * newest delete first, in that index's order, after `from`. It seeks to
 * `from` itself (rangeAfter), as every task of a project item shares one
 * deleted_at, so a later page reads none of the rows before it. A task item
 * is one entry, at the first of its assigned tasks in that order that sits
 * in a project the admin may read (ItemView readable), so it shows once
 * however its rows fall across pages; a project item is an entry for each
 * such task. A budget stop ends the page at the last row it looked at.
 * After the admin access split the index also holds the person's tasks in
 * projects the admin cannot read, which it drops, so no entry, hit or count
 * comes from them; a stop can then end a short page at such a row, which
 * tells only that the person was assigned deleted work there, the owners
 * an admin keeps (owner, 2026-10-29).
 */
async function assigneeEntries(run: Run, seat: Seat, scope: Scoped, from: At | null) {
  const person = run.a.assignee
  if (person === undefined) return
  const reader = spending(run.ctx, run.call)
  const finder = spending(run.ctx, run.find, run.call)
  const org = seat.me.org_id
  const views = new Map<string, Promise<{ item: Item; view: ItemView; first?: Task } | null>>()
  const judged = (row: Task) => {
    let known = views.get(row.item_id)
    if (known === undefined) {
      known = (async () => {
        const item = await byId(reader, 'deleted_items', row.item_id)
        if (item === null || item.org_id !== org || item.state === 'purging') return null
        if (!holdsTasks(scope, item) || !deletedAsAsked(seat, run.a, item)) return null
        if (!sameReference(seat.sight.profiles.get(person), item)) return null
        const view = await viewOf(reader, seat.sight.memo, seat.me, item)
        if (view === null) return null
        if (item.kind === 'project') return { item, view }
        // the first visible row in this index's order: the newest created
        let first: Task | undefined
        const rows = reader.db
          .query('deleted_tasks')
          .withIndex('by_item_assignee', (q) => q.eq('item_id', item.id).eq('assignee_id', person))
        for await (const task of rows)
          if (
            shows(view, task) &&
            (first === undefined ||
              task._creationTime > first._creationTime ||
              (task._creationTime === first._creationTime && task._id > first._id))
          )
            first = task
        return { item, view, first }
      })()
      views.set(row.item_id, known)
    }
    return known
  }
  const rows = rangeAfter(finder, assigneeRange(org, person), from, true)
  let looked: At | null = null
  try {
    for (;;) {
      if (stopped(run)) {
        if (looked !== null) run.next = { part: 1, at: looked }
        else run.reads = true
        return
      }
      const step = await rows.next()
      if (step.done === true) return
      const row = step.value
      if (row.deleted_at === undefined) continue
      const at = { at: row.deleted_at, ct: row._creationTime, id: row._id, num: 0 }
      looked = at
      const found = await judged(row)
      if (found === null || !shows(found.view, row)) continue
      const { item, view } = found
      if (item.kind === 'task' && found.first?._id !== row._id) continue
      const tasks = item.kind === 'task' ? await assignedOf(reader, view, item, person) : [row]
      if (take(run, 1, [{ seat, item, view, at, tasks }])) return
    }
  } finally {
    await rows.return(undefined)
  }
}

/** The tasks of task item `item` assigned to `person` in projects `view`
 * lets the seat read (ItemView readable), by number. */
async function assignedOf(reader: QueryCtx, view: ItemView, item: Item, person: string) {
  const out: Task[] = []
  const rows = reader.db
    .query('deleted_tasks')
    .withIndex('by_item_assignee', (q) => q.eq('item_id', item.id).eq('assignee_id', person))
  for await (const task of rows) if (shows(view, task)) out.push(task)
  return out
}

/* ----------------------------------------------------------- the search */

/** A task's number, title and readable description, as the search reads
 * them from its row: search_text holds the title, a newline and the
 * description (model/descriptions.ts deletedSearchText). A row stored
 * before the page's release has its title only. */
function fieldsOf(task: Task): SearchFields {
  const text = task.search_text
  if (text === undefined) return { num: task.num, title: task.title, description: '' }
  const head = `${task.title}\n`
  return {
    num: task.num,
    title: task.title,
    description: text.startsWith(head) ? text.slice(head.length) : text,
  }
}

/** One search source of a seat: a search_text query filtered to the items
 * of one of its sources (`field` and `value`), or to its organization. */
type Query = {
  field?: 'deleted_by' | 'item_project_id' | 'item_parent_id' | 'item_id'
  value?: string
}

/** What a scoped seat's search reads: its queries, and the cross-project
 * items no query covers, which it reads whole. When the gathering's room
 * runs out while it reads the unordered ranges that name those items, it
 * holds those it read, and the page says `matches` as every search page
 * does. */
type SearchPlan = { queries: Query[]; crossItems: Item[] }

/** The search over a seat's whole organization, which judges every
 * candidate: an admin's All projects, an admin's search past the bounds,
 * and anyone else's past DELETED_PAGE.searches. */
const WHOLE: SearchPlan = { queries: [{}], crossItems: [] }

/**
 * The search sources of `seat` for `scope`. An admin's All projects is one
 * query over the organization, and narrowed to one deleter one query of
 * that deleter's tasks (deleted_by); some projects, a query for each
 * top-level project (item_parent_id) and each other project
 * (item_project_id) the scope names. Anyone else's are their own deletes
 * (deleted_by), the projects the browse reads for them (scopeRanges), so
 * with some projects every project of the scope they see, and each project
 * item their stored rows name as lead that no other query covers
 * (item_id). Each query finds every task of the items of its source,
 * wherever the task sits. The cross-project items the browse finds through
 * subtasks, whose roots no query holds, are read whole instead
 * (crossItems), as an item holds at most LIMITS.subtasks.max + 1 tasks,
 * once viewOf shows the item to the seat (gatherTasks).
 * Past DELETED_PAGE.adminSources for an admin, or DELETED_PAGE.searches
 * for anyone, the seat searches its organization whole (WHOLE).
 */
async function searchPlan(run: Run, seat: Seat, scope: Scoped): Promise<SearchPlan> {
  const { a } = run
  if (seat.admin && a.deletedBy !== undefined)
    return { queries: [{ field: 'deleted_by', value: a.deletedBy }], crossItems: [] }
  if (seat.admin && scope.all) return WHOLE
  const parents = new Set<string>()
  const projects = new Set<string>()
  const cross: string[] = []
  if (seat.admin) {
    for (const p of scope.named) {
      if (p.parent_id !== undefined && scope.tops.has(p.parent_id)) continue
      if (p.type !== 'meta') {
        projects.add(p.id)
        cross.push(p.id)
        continue
      }
      parents.add(p.id)
      for (const sub of seat.sight.projects.values()) if (sub.parent_id === p.id) cross.push(sub.id)
    }
    // past the browse's bounds the browse reads the organization's range too
    if (parents.size + projects.size + cross.length > DELETED_PAGE.adminSources) return WHOLE
  } else {
    const ranges = scopeRanges(seat, scope)
    for (const id of ranges.tops) parents.add(id)
    for (const id of ranges.alone) projects.add(id)
    cross.push(...ranges.cross)
    if (1 + parents.size + projects.size > DELETED_PAGE.searches) return WHOLE
  }
  const unordered: Plan = { ordered: [], cross, storedLead: !seat.admin, keeps: () => true }
  const queries: Query[] = []
  if (!seat.admin) queries.push({ field: 'deleted_by', value: seat.me.id })
  for (const id of parents) queries.push({ field: 'item_parent_id', value: id })
  for (const id of projects) queries.push({ field: 'item_project_id', value: id })
  // the items of the unordered ranges that no query covers
  const covered = (item: Item) =>
    (!seat.admin && item.deleted_by === seat.me.id) ||
    (item.parent_project_id !== undefined && parents.has(item.parent_project_id)) ||
    projects.has(item.project_id)
  const reader = spending(run.ctx, run.gather, run.call)
  const out = () => spent(run.gather) || spent(run.call)
  const { found } = await unorderedItems(reader, seat, unordered, new Map(), out)
  const crossItems: Item[] = []
  for (const item of found) {
    if (covered(item) || !holdsTasks(scope, item)) continue
    if (item.kind === 'project') queries.push({ field: 'item_id', value: item.id })
    else crossItems.push(item)
  }
  if (queries.length > DELETED_PAGE.searches) return WHOLE
  return { queries, crossItems }
}

/**
 * Gathers the task entries of a search, for the scoped seat (`scope`) or,
 * without a scope, for every seat by task reference only, and adds those
 * after `from` to the page.
 *
 * Its reads spend `gather`, the room the page keeps for it, so every page
 * gathers the same candidates. Before any source reads, the room for results
 * is split into equal allowances (DELETED_PAGE.results across the queries,
 * at most DELETED_PAGE.candidates each), and each lookup of a task number
 * counts as LOOKUP, so what one source reads does not change how many
 * results another may read. A candidate counts when its item passes
 * viewOf, is not purging and meets the scope and filters, its project is
 * one the seat may read in its view of the item (ItemView readable), and
 * its number, title and readable description hold every term
 * (matchesTerms). A row stored before v0.1.122 holds no search_text, so
 * only its number finds it (olderRows). A stop of the gathering adds
 * nothing to `missing`, since every search page says `matches` whatever it
 * read.
 */
async function gatherTasks(run: Run, seats: Seat[], scope: Scoped | null, from: At | null) {
  const { a } = run
  const text = convexText(a.terms)
  const refs = a.terms.filter((t) => t.num != null)
  const reader = spending(run.ctx, run.gather, run.call)
  const unmetered = run.ctx
  const groups = new Map<string, Pending>()
  const items = new Map<string, Promise<{ item: Item; view: ItemView } | null>>()
  const out = (): boolean => spent(run.gather) || spent(run.call)

  const judged = (seat: Seat, id: string, ctx: QueryCtx) => {
    let known = items.get(id)
    if (known === undefined) {
      known = (async () => {
        const item = await byId(ctx, 'deleted_items', id)
        if (item === null || item.org_id !== seat.me.org_id || item.state === 'purging') return null
        if (scope !== null && !holdsTasks(scope, item)) return null
        if (!deletedAsAsked(seat, a, item)) return null
        const view = await viewOf(ctx, seat.sight.memo, seat.me, item)
        if (view === null || (scope !== null && !heldFor(seat, scope, item, view))) return null
        return { item, view }
      })()
      items.set(id, known)
    }
    return known
  }
  const consider = async (seat: Seat, task: Task, ctx: QueryCtx) => {
    const found = await judged(seat, task.item_id, ctx)
    if (found === null || !shows(found.view, task)) return
    if (!assignedAsAsked(seat, a, found.item, task)) return
    if (!matchesTerms(a.terms, fieldsOf(task))) return
    const { item, view } = found
    const key = item.kind === 'task' ? item.id : `${item.id}:${task.task_id}`
    const known = groups.get(key)
    if (known === undefined)
      groups.set(key, {
        seat,
        item,
        view,
        at: itemAt(item, item.kind === 'project' ? task.num : 0),
        tasks: [task],
      })
    else if (!known.tasks.some((t) => t.task_id === task.task_id)) known.tasks.push(task)
  }

  // the plans first, so the allowances are set before any source reads
  const planned: { seat: Seat; plan: SearchPlan }[] = []
  if (scope !== null)
    for (const seat of seats) {
      if (out()) break
      planned.push({ seat, plan: await searchPlan(run, seat, scope) })
    }
  const sources = planned.reduce((n, p) => n + p.plan.queries.length, 0)
  const allowance = Math.max(
    1,
    Math.min(DELETED_PAGE.candidates, Math.floor(DELETED_PAGE.results / Math.max(1, sources))),
  )
  /* Reads `query` a result at a time up to the allowance, each result a
   * range more, as Convex counts it, or until the room runs out. */
  const readQuery = async (seat: Seat, query: AsyncIterable<Task>): Promise<void> => {
    let read = 0
    for await (const task of query) {
      run.gather.ranges -= 1
      run.call.ranges -= 1
      await consider(seat, task, reader)
      if (++read >= allowance || out()) return
    }
  }

  try {
    // the task numbers the text names, in every seat, at a fixed size each
    for (const seat of seats)
      for (const ref of refs) {
        if (out()) throw new Stop()
        for (const b of [run.gather, run.call]) {
          b.ranges -= LOOKUP.ranges
          b.rows -= LOOKUP.rows
          b.bytes -= LOOKUP.bytes
        }
        const rows = await unmetered.db
          .query('deleted_tasks')
          .withIndex('by_org_num', (q) => q.eq('org_id', seat.me.org_id).eq('num', ref.num ?? 0))
          .take(4)
        for (const task of rows) await consider(seat, task, unmetered)
      }
    for (const { seat, plan } of planned) {
      const org = seat.me.org_id
      for (const q of plan.queries) {
        if (out()) throw new Stop()
        const query = reader.db.query('deleted_tasks').withSearchIndex('search_text', (s) => {
          let f = s.search('search_text', text).eq('org_id', org)
          if (q.field !== undefined) f = f.eq(q.field, q.value)
          if (a.assignee !== undefined) f = f.eq('assignee_id', a.assignee)
          return f
        })
        await readQuery(seat, query)
      }
      for (const item of plan.crossItems) {
        if (out()) throw new Stop()
        // a family hidden from the seat, whose tasks it need not read
        if ((await judged(seat, item.id, reader)) === null) continue
        const tasks = reader.db
          .query('deleted_tasks')
          .withIndex('by_item', (q) => q.eq('item_id', item.id))
        for await (const task of tasks) {
          await consider(seat, task, reader)
          // each task's row holds its searchable text
          if (out()) throw new Stop()
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
  }
  const found = [...groups.values()]
    .filter((p) => from === null || before(from, p.at))
    .sort((x, y) => order(x.at, y.at))
  for (const [i, p] of found.entries()) {
    run.entries.push({ ...p, part: 1 })
    if (room(run) === 0) {
      if (i < found.length - 1) run.next = { part: 1, at: p.at }
      return
    }
  }
}

/** Ends the gathering early. */
class Stop extends Error {}

/* --------------------------------------------------------- older rows */

/**
 * Whether the page says that its search or assignee filter may miss tasks
 * stored before v0.1.122, the first release that wrote the page's fields
 * (`legacy`). Such rows hold none of them, so only their number finds
 * them, and no backfill writes the fields (owner, 2026-10-28). Items
 * expire in 30 days, but a stuck item never does, so no date stands in for
 * a look: an admin's page asks the organization once whether it holds such
 * a row (by_org_assignee with neither field), and anyone else's always says
 * so, as the look also sees rows hidden from them. This probe, `legacy` and
 * the read-only count (internal/olderDeletedTasks.ts count) go together
 * once a run of the count finds no such row on any deployment, the demo
 * included, after the last ready item's purge_after has passed (the
 * later-work entry on olderRows of 9 November 2026 in qivo-internal).
 */
async function olderRows(run: Run, seat: Seat): Promise<boolean> {
  if (!seat.admin) return true
  const row = await spending(run.ctx, run.call)
    .db.query('deleted_tasks')
    .withIndex('by_org_assignee', (q) =>
      q.eq('org_id', seat.me.org_id).eq('assignee_id', undefined).eq('deleted_at', undefined),
    )
    .first()
  return row !== null
}

/* ------------------------------------------------------------- the page */

/**
 * One page of Deleted items for the login whose active seats are `seats`
 * (deletedItems.page): see the file comment. Refuses a limit, scope,
 * search or cursor that is not one the page takes, an assignee without a
 * scope, `via` without `deleted_by` and `someone` with either. An
 * organization without the caller's seat, and a scope that names nothing
 * the seat sees, answer an empty last page, as do a search without a word
 * to match. `spend`, for tests, receives what the call spent of each
 * budget, as the page counts its reads.
 */
export async function pageFor(
  ctx: QueryCtx,
  seats: Map<string, Profile>,
  args: PageArgs,
  spend?: PageSpend,
): Promise<DeletedPage> {
  const a = asked(args)
  const key = await keyOf(a)
  const cursor = args.cursor === undefined ? null : await openCursor(args.cursor, key)
  if (args.cursor !== undefined && cursor === null)
    throw badRequest('cursor must be the next_cursor of an earlier page')
  const scopeMe = a.scope === undefined ? null : seats.get(a.scope.org)
  if (scopeMe === undefined) return EMPTY
  if (a.text !== '' && a.terms.length === 0)
    return a.scope === undefined && a.kind !== 'project' ? { ...EMPTY, scope_needed: true } : EMPTY
  const run: Run = {
    ctx,
    a,
    call: { ...DELETED_PAGE.call },
    build: { ...DELETED_PAGE.build },
    find: { ...DELETED_PAGE.find },
    gather: { ...DELETED_PAGE.gather },
    floor: null,
    seats: new Map(),
    entries: [],
    next: null,
    reads: false,
    matches: false,
    path: 'items',
  }
  const head: Partial<DeletedPage> = {}
  try {
    if (scopeMe === null) await unscoped(run, [...seats.values()], cursor, head)
    else {
      const answer = await scoped(run, scopeMe, cursor, head)
      if (answer !== null) return answer
    }
    return await answerOf(run, key, head)
  } finally {
    if (spend !== undefined)
      for (const part of ['call', 'build', 'find', 'gather'] as const)
        spend[part] = {
          bytes: DELETED_PAGE[part].bytes - run[part].bytes,
          rows: DELETED_PAGE[part].rows - run[part].rows,
          ranges: DELETED_PAGE[part].ranges - run[part].ranges,
        }
  }
}

/** What one page spent of each budget (pageFor), in the units it counts:
 * a range per query read, read by id and search result, and a row and its
 * estimated bytes per document. */
export type PageSpend = Partial<Record<'call' | 'build' | 'find' | 'gather', Reads>>

/** The page without a scope: every seat's project entries, and the tasks
 * a task reference names in every seat. */
async function unscoped(
  run: Run,
  profiles: Profile[],
  cursor: Cursor | null,
  head: Partial<DeletedPage>,
) {
  const { a } = run
  if (a.kind !== 'project') head.scope_needed = true
  if (cursor !== null && cursor.path !== 'items') throw notThisPath()
  const from = cursor?.place ?? null
  const refs = a.kind !== 'project' && a.terms.some((t) => t.num != null)
  // matches may be missing from every search page
  if (a.terms.length > 0) run.matches = true
  if (a.kind !== 'task' && (from === null || from.part === 0)) {
    if (refs) run.floor = DELETED_PAGE.gather
    const plans: { seat: Seat; plan: Plan }[] = []
    for (const me of profiles) {
      if (stopped(run)) {
        run.reads = true
        break
      }
      const seat = await seatOf(run, me)
      const plan = projectPlan(run, seat, null)
      if (plan === 'too_wide') {
        head.too_wide = true
        return
      }
      plans.push({ seat, plan })
    }
    const goesOn = await readPart(run, 0, plans, from?.at ?? null, projectEntry(run), true)
    run.floor = null
    if (!goesOn) return
  }
  if (!refs || room(run) === 0) return
  const all: Seat[] = []
  for (const me of profiles) {
    if (spent(run.call)) {
      run.reads = true
      break
    }
    all.push(await seatOf(run, me))
  }
  await gatherTasks(run, all, null, from?.part === 1 ? from.at : null)
}

/** The page of one scope in the seat `me`. Answers a whole answer of its
 * own (an empty page or too_wide), or null when the page is in `run`. */
async function scoped(
  run: Run,
  me: Profile,
  cursor: Cursor | null,
  head: Partial<DeletedPage>,
): Promise<DeletedPage | null> {
  const { a } = run
  const seat = await seatOf(run, me)
  const scope = scopedOf(seat, a.scope?.ids ?? null)
  if (scope === null) return EMPTY
  const projects = a.kind !== 'task' && a.assignee === undefined
  const tasks = a.kind !== 'project'
  const search = a.terms.length > 0
  const viaIndex = tasks && !search && a.assignee !== undefined && seat.admin
  run.path = viaIndex ? 'assignee' : 'items'
  if (cursor !== null && cursor.path !== run.path) throw notThisPath()
  const from = cursor?.place ?? null
  // the sources every part needs, before any of them reads
  const project = projects ? projectPlan(run, seat, scope) : null
  const scan =
    tasks && !search && !viaIndex ? taskPlan(run, seat, scope, a.assignee !== undefined) : null
  if (project === 'too_wide' || scan === 'too_wide') return { ...EMPTY, too_wide: true }
  // whether the search and the assignee filter may miss older rows: the
  // probe's answer for an admin, always for anyone else
  const legacy = tasks && (search || a.assignee !== undefined) && (await olderRows(run, seat))
  if (legacy) head.legacy = true
  // matches may be missing from every search page
  if (search) run.matches = true
  const first = project !== null && (from === null || from.part === 0)
  if (first) {
    if (tasks && search) run.floor = DELETED_PAGE.gather
    const goesOn = await readPart(
      run,
      0,
      [{ seat, plan: project }],
      from?.at ?? null,
      projectEntry(run),
      true,
    )
    run.floor = null
    if (!goesOn) return null
  }
  if (!tasks || room(run) === 0) return null
  const after = from?.part === 1 ? from.at : null
  if (search) await gatherTasks(run, [seat], scope, after)
  else if (viaIndex) await assigneeEntries(run, seat, scope, after)
  else if (scan !== null) {
    const judge = a.assignee === undefined ? taskEntry(run, scope) : scanEntry(run, scope)
    await readPart(run, 1, [{ seat, plan: scan }], after, judge, !first)
  }
  return null
}

/** The refusal of a cursor written on the other path, the admin's
 * assignee index or the item order, as when the caller's role changed. */
const notThisPath = () => badRequest('cursor must be the next_cursor of an earlier page')

/** The page `run` gathered: its entries with their hits, each item's row
 * once, and the cursor and notes. The rows spend `build`, checked before
 * each row and inside a redacted row's search for the task it shows
 * (deletedItemsRows.ts rowOf). Once it runs out the page ends before the
 * entry whose row it could not build, with next_cursor at the entry
 * before. When that is the page's first entry, whose row alone needs more
 * than `build`, the page goes past it with `reads`, rather than answer the
 * same page again on every call. */
async function answerOf(run: Run, key: string, head: Partial<DeletedPage>): Promise<DeletedPage> {
  if (head.too_wide === true)
    return {
      ...EMPTY,
      too_wide: true,
      ...(head.scope_needed === true ? { scope_needed: true as const } : {}),
    }
  const reader = spending(run.ctx, run.build)
  const out = () => spent(run.build)
  const rows = new Map<string, DeletedRow | null>()
  const entries: DeletedEntry[] = []
  for (const [i, p] of run.entries.entries()) {
    let row = rows.get(p.item.id)
    if (row === undefined) {
      const built = out()
        ? 'unread'
        : await rowOf(reader, p.seat.sight, p.seat.orgName, p.item, out)
      if (built === 'unread') {
        const last = i === 0 ? p : run.entries[i - 1]
        run.next = { part: last.part, at: last.at }
        if (i === 0) run.reads = true
        break
      }
      row = built
      rows.set(p.item.id, row)
    }
    if (row === null) continue
    const hit = hitOf(p, row)
    entries.push(hit === undefined ? { item_id: p.item.id } : { item_id: p.item.id, task: hit })
  }
  const page: DeletedPage = {
    entries,
    items: [...rows.values()].filter((row): row is DeletedRow => row !== null),
    next_cursor:
      run.next === null ? null : await cursorText(key, { path: run.path, place: run.next }),
  }
  if (head.scope_needed === true) page.scope_needed = true
  if (run.reads) page.missing = 'reads'
  else if (run.matches) page.missing = 'matches'
  if (head.legacy === true) page.legacy = true
  return page
}

/** What an entry says of the task it found: a project item's task, or the
 * first of a task item's matches by number when its row does not show one
 * of them already (the root, or the task a redacted row shows). The root's
 * key and title come with a subtask unless the item is redacted, as its
 * row never names the root then, and a hidden item's key alone, as its row
 * shows no title. */
function hitOf(p: Pending, row: DeletedRow): DeletedHit | undefined {
  if (p.tasks.length === 0) return undefined
  if (p.item.kind === 'task' && p.tasks.some((t) => issueKey(t.num) === row.key)) return undefined
  const task = [...p.tasks].sort((x, y) => x.num - y.num)[0]
  const project = p.view.readable.find((x) => x.id === task.project_id)
  if (project === undefined) return undefined
  const { item, view } = p
  const subtask = item.kind === 'task' && !view.redacted && task.task_id !== item.target_id
  const root = view.hidden ? {} : { root_title: item.name }
  return {
    key: issueKey(task.num),
    title: task.title,
    ...(subtask ? { root_key: issueKey(item.num), ...root } : {}),
    archived: task.archived,
    path: view.redacted ? [] : hitPath(p.seat.sight, item, project),
    ...(view.redacted ? { redacted: true as const } : {}),
  }
}
