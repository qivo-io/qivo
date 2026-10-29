/* Main Search's task results, the server half of Search in the left menu
 * (search.ts page). One call answers one page of up to MAIN_SEARCH.rows
 * results for a search text, across every organization where the login
 * holds a seat, or the scope the caller narrows it to, with or without
 * archived tasks.
 *
 * Each seat searches its places, which are the live projects the caller
 * can see, one by one, when they are few (searchPlaces), and otherwise the
 * whole organization. The task numbers the text names come first, one
 * read each in every seat (issues by_org_num), then for each place task
 * titles (issues search_title) and descriptions (issue_descriptions
 * search_description), where a task number matches a whole word of its
 * digits.
 * Convex's search matches any term of the text, in its own relevance
 * order, so each source is read in that order up to
 * MAIN_SEARCH.candidates, and every candidate is judged here. It counts only when the caller may see it (ordinary project
 * access, lib/access.ts accessOf, so an organization admin follows
 * projectLevel like everyone else) and every term matches its number, title
 * or readable description (lib/searchTerms.ts, lib/md.ts readableText). The
 * matches of every seat are ranked together (lib/searchTerms.ts scoreOf,
 * then comparePositions), and a page is the rows after the cursor's
 * position in that order. Every page gathers the same candidates, so the
 * order is the same on every page.
 *
 * The reads stop within MAIN_SEARCH's budget, counted with Convex's own
 * transaction metrics. A stop never fails the call. The answer's coverage
 * then says the search did not cover everything (coverageOf), which is
 * apart from whether more pages follow (next_cursor).
 *
 * Description rows hold copies of their task's project and archived state
 * (model/descriptions.ts), which ranking may use. A rollback can leave them
 * stale, so a description match goes out only after its live task row is
 * judged again. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { hasSubtasks } from '../model/issues'
import { type Access, accessOf, OWN_READS, receivesTeamAccess } from './access'
import { openCursorText, sealCursorText } from './archiveCursorSeal'
import { type ReadCeiling, roomOf } from './archivedTasks'
import { byId } from './db'
import type { IssueStatus } from './enums'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { LIMITS } from './limits'
import type { Liveness } from './liveTasks'
import { hidesWords, MAX_PARSE, readableText } from './md'
import {
  convexTakesAll,
  convexText,
  matchesTerms,
  type SearchFields,
  type SearchTerm,
  scoreOf,
  searchTerms,
} from './searchTerms'

/** Main Search's budget for one call. `rows` results a page. `candidates`
 * documents read from each search source in each place, below the 1,024
 * results one Convex search query can scan, as reading one past them
 * throws. A seat that sees at most `projects` live projects searches them
 * one by one, listed from reads of at most `listing` rows each, and a seat
 * that sees more searches its organization. At most `seats` seats and
 * `searches` search queries a call, two of them kept for each seat not
 * planned yet. Gathering the candidates stops after `ranges` index ranges,
 * `documents` documents and `bytes` bytes, counted from the call's start,
 * and after parsing `parse` characters of descriptions that hide words
 * (lib/md.ts hidesWords). The page parses up to `pageParse` more, a page of
 * descriptions at LIMITS.description, and always its first row. Every
 * search result costs an index range, so `ranges` binds first. On a local
 * backend (2026-10-29) 2,000 results took 0.25 to 0.45 s of the 1 s Convex
 * gives a query's own code, and parsing 1,000,000 characters of
 * descriptions full of links took 0.1 to 0.2 s. A seat that sees 32
 * projects runs 64 search queries; its pages there read 400 to 630
 * documents in about 0.1 s of that time, and its heaviest page stopped at
 * `ranges` after 0.24 s. Tests lower these. */
export const MAIN_SEARCH = {
  rows: 25,
  candidates: 512,
  projects: 32,
  listing: 64,
  seats: 8,
  searches: 96,
  ranges: 2_000,
  documents: 16_000,
  bytes: 8 << 20,
  parse: 1_000_000,
  pageParse: 500_000,
}

/** What a call keeps back from Convex's limits for the reads its budget
 * does not count one by one: the caller's own access rows that one access
 * check may read at once (lib/access.ts OWN_READS, at most its teams and a
 * few ranges, its rows and the organization's teams). The listing reads
 * its rows one at a time under the budget. The page's rows read up to the
 * rest, so a page of large tasks ends early instead. What no budget bounds
 * is accessOf's own reads when it asks whether a top-level project shows
 * for navigation: all of the person's grants, memberships and team shares,
 * and the teams those name, which lib/access.ts reads whole, and a team row
 * can hold a legacy icon of any size. A separate repair of legacy icons is
 * planned. Tests lower it. */
export const SEARCH_RESERVE: ReadCeiling = {
  ranges: OWN_READS.teams + 64,
  documents: 2 * OWN_READS.rows + OWN_READS.orgTeamsMost,
  bytes: OWN_READS.bytes + (2 << 20),
}

/** How the search sources filter archived tasks while the toggle is off.
 * `byIndex` filters them in the search query (archived_at absent, which the
 * Convex documentation allows); without it the queries read archived tasks
 * too and the judging leaves them out, at a cost in candidates. One switch,
 * should hosted Convex refuse an absent value in a search filter. */
export const ARCHIVED_FILTER = { byIndex: true }

/** A narrower scope than every seat: one organization, and in it one
 * project, a sub-project or a top-level project with its sub-projects. */
export type SearchScope = { org_id: string; project_id?: string }

/** One task result as main Search shows it. `status` is null for a group,
 * whose own status is dormant. `parent` is the top-level project above
 * the task's project. */
export type TaskResult = {
  kind: 'task'
  org_id: string
  id: string
  num: number
  title: string
  status: IssueStatus | null
  is_group: boolean
  archived: boolean
  project: { id: string; name: string }
  parent: { id: string; name: string } | null
}

/** Whether a search covered everything it was asked to (coverageOf), and
 * if not, why, and how many of the seats asked about it searched. */
export type Coverage =
  | { complete: true }
  | {
      complete: false
      stopped: 'projects' | 'reads' | 'candidates' | 'organizations'
      searched: number
      of: number
    }

/** One page of main Search. A page can hold fewer than MAIN_SEARCH.rows
 * rows, even none, while `next_cursor` says that more follow: its reads
 * ran out, or the live tasks of matches it looked at no longer show. */
export type MainSearchPage = {
  rows: TaskResult[]
  next_cursor: string | null
  coverage: Coverage
}

/** What one call did, for tests: how many search queries it ran. */
export type SearchStats = { searches: number }

/* ------------------------------------------------------------ the order */

/** Where a result sorts: by `score` (lib/searchTerms.ts scoreOf), highest
 * first; then by `kind`, tasks (0) before projects (1); then by `seat`, the
 * caller's home seat first and then the others by organization id
 * (seatKey); then by `tie`, a task's number, newest first, and 0 for a
 * match only in its description, whose task the search does not read before
 * the page; then by `id`. */
export type Position = { score: number; kind: number; seat: string; tie: number; id: string }

/** The order of main Search's results (Position). */
export function comparePositions(a: Position, b: Position): number {
  return (
    b.score - a.score ||
    a.kind - b.kind ||
    (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0) ||
    b.tie - a.tie ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** The order key of seat `me`: the home seat (any role but guest) first,
 * then the others, each by organization id. */
export const seatKey = (me: Pick<Doc<'profiles'>, 'org_role' | 'org_id'>): string =>
  `${me.org_role === 'guest' ? 1 : 0}~${me.org_id}`

/* ----------------------------------------------------------- the cursor */

/* The version a search cursor carries outside and inside its sealed text.
 * Every sealed cursor shares one key and AAD (lib/archiveCursorSeal.ts), so
 * the version inside keeps a body sealed for another list from opening as
 * a search cursor. */
const CURSOR_PREFIX = 's1~'
const CURSOR_VERSION = 'main-search-1'

/* The longest cursor text that may open: far above what a 200-character
 * search writes, so only junk is refused unopened. */
const CURSOR_MAX = 64 << 10

/** The key of a search a cursor belongs to: its terms, its toggle and its
 * scope. A cursor from another key is refused. */
export const searchKey = (
  terms: readonly SearchTerm[],
  includeArchived: boolean,
  scope: SearchScope | undefined,
): string =>
  JSON.stringify([
    terms.map((t) => [t.word, t.prefix, t.num === undefined ? 'w' : t.num]),
    includeArchived,
    scope?.org_id ?? null,
    scope?.project_id ?? null,
  ])

/** The cursor of the position after `position` for the search of `key`. */
export const searchCursorText = async (key: string, p: Position): Promise<string> =>
  `${CURSOR_PREFIX}${await sealCursorText(
    JSON.stringify([CURSOR_VERSION, key, p.score, p.kind, p.seat, p.tie, p.id]),
  )}`

/** The position `text` names for the search of `key`, or null when it is
 * not a cursor searchCursorText wrote for that key. */
export async function parseSearchCursor(text: string, key: string): Promise<Position | null> {
  if (!text.startsWith(CURSOR_PREFIX) || text.length > CURSOR_MAX) return null
  const opened = await openCursorText(text.slice(CURSOR_PREFIX.length))
  if (opened === null) return null
  let body: unknown
  try {
    body = JSON.parse(opened)
  } catch {
    return null
  }
  if (!Array.isArray(body) || body.length !== 7) return null
  const [version, from, score, kind, seat, tie, id] = body
  if (version !== CURSOR_VERSION || from !== key) return null
  const whole = (n: unknown): n is number => Number.isSafeInteger(n)
  if (!whole(score) || !whole(kind) || !whole(tie)) return null
  if (typeof seat !== 'string' || typeof id !== 'string') return null
  return { score, kind, seat, tie, id }
}

/* ---------------------------------------------------------- the coverage */

/** What made a search stop short: a seat that does not see every project
 * of its organization searched it whole (`wide`), a source returned
 * MAIN_SEARCH.candidates (`candidates`), the budget stopped a source or the
 * judging (`reads`), and how many of the seats asked about began to read
 * (`searched` of `of`). */
type Stops = {
  wide: boolean
  candidates: boolean
  reads: boolean
  searched: number
  of: number
}

/**
 * The coverage a search reports for its stops, the one place that decides
 * it. It never depends on tasks the caller cannot see, as Qivo's access
 * rule fails closed, and it says nothing of how many candidates a source
 * judged or left out (owner decision, 2026-10-28).
 *
 * A source read over a whole organization returns tasks the caller cannot
 * see too, and they count toward its cap and the budget, so its stops
 * would tell whether, and with padding how many, hidden tasks hold a word.
 * So a search of the whole organization for a seat that does not see every
 * project of it (seesEveryProject) is always reported incomplete, as
 * `projects`, whatever it read: choosing a project searches that project
 * fully. A seat searched project by project reads only tasks of projects it
 * sees, and a seat that sees every project hides nothing from itself, so
 * their stops are reported exactly. They are searched first, and each seat
 * searched whole reads within an equal share of what they left, counted at
 * the reads' real size, so how far a seat gets does not depend on what a
 * whole-organization search read. A step of reads may pass its share by
 * the documents it reads, three at most, and the gathering's own limit
 * still holds every share, so only rows near Convex's 1 MiB document size,
 * of tasks or projects, could make one seat's reads felt in another's, and
 * never in the room the page reads in.
 *
 * `stopped` names `projects` first, then the budget (`reads`), then a
 * source's cap (`candidates`), each of which means that matches in the
 * seats searched may be missing, so the palette shows its note that some
 * results might be missing; else it names the seats left out
 * (`organizations`). `searched` of `of` seats says whether seats were left
 * out, also beside another stop.
 *
 * What remains. The number source reads the task each reference names in
 * each seat's organization, whichever project holds it, and that task's
 * size counts toward the budget, which only a task near Convex's 1 MiB
 * document size could make felt. And the rows, not the coverage, of a
 * whole-organization search can differ with hidden tasks, which take
 * candidates a visible match would have had; its coverage always says that
 * results may be missing.
 */
export function coverageOf(stops: Stops): Coverage {
  const left = stops.searched < stops.of
  if (!stops.wide && !stops.reads && !stops.candidates && !left) return { complete: true }
  return {
    complete: false,
    stopped: stops.wide
      ? 'projects'
      : stops.reads
        ? 'reads'
        : stops.candidates
          ? 'candidates'
          : 'organizations',
    searched: stops.searched,
    of: stops.of,
  }
}

/* ------------------------------------------------------------ the budget */

/* Thrown when a read does not fit, which ends the gathering or the page. */
class OutOfRoom extends Error {}

/* A read budget under `ceiling`, asked before each read whether it fits.
 * It counts each index range as one and each document at Convex's size
 * limit, so the reads it is asked about never pass the ceiling. It looks at
 * the request's metrics only when the reads since its last look could have
 * used what was left, and after recount, which follows reads it was not
 * asked about, such as an access check. lib/archivedTasks.ts ceilingGuard
 * is asked after each read instead, so it lets one document past its
 * ceiling, which its callers' reserves hold; main Search reads up to three
 * documents after one check, so it asks before.
 *
 * With `share`, the reads also stop once they have reached it, counted at
 * their real size from the request's metrics before each step, so a share
 * smaller than a few documents at Convex's size limit still reads and
 * judges small documents, and a step may pass it by what it reads, never
 * `ceiling`. */
function readBudget(ctx: QueryCtx, ceiling: ReadCeiling, share?: ReadCeiling) {
  // what was left at the last look, less what was asked for since
  let ranges = 0
  let documents = 0
  return {
    /** Throws OutOfRoom unless `r` more index ranges and `d` more documents
     * of any size fit. */
    async need(r: number, d: number): Promise<void> {
      if (share !== undefined) {
        const m = await ctx.meta.getTransactionMetrics()
        if (
          m.databaseQueries.used + r > share.ranges ||
          m.documentsRead.used + d > share.documents ||
          m.bytesRead.used >= share.bytes
        )
          throw new OutOfRoom()
      }
      if (ranges < r || documents < d) {
        const m = await ctx.meta.getTransactionMetrics()
        ranges = ceiling.ranges - m.databaseQueries.used
        documents = Math.min(
          ceiling.documents - m.documentsRead.used,
          Math.floor((ceiling.bytes - m.bytesRead.used) / DOCUMENT_MAX_BYTES),
        )
        if (ranges < r || documents < d) throw new OutOfRoom()
      }
      ranges -= r
      documents -= d
    },
    recount() {
      ranges = 0
      documents = 0
    },
  }
}

type ReadBudget = ReturnType<typeof readBudget>

/* A parse allowance of `limit` characters. Each call adds what parsing one
 * text costs and throws OutOfRoom once the total passes the limit, unless
 * `always`. */
function parseAllowance(limit: number) {
  let used = 0
  return (chars: number, always = false): void => {
    used += chars
    if (used > limit && !always) throw new OutOfRoom()
  }
}

/* ------------------------------------------------------------ the places */

/** Whether `me` sees every project of their organization, so that listing
 * their own projects finds nothing smaller and a search of the whole
 * organization hides nothing from them. That is an organization admin,
 * until the admin access split changes projectLevel (lib/access.ts
 * levelUnder). */
const seesEveryProject = (me: Doc<'profiles'>): boolean => me.org_role === 'admin'

/* Waits for room for one access check, which the budget counts once it has
 * run (SEARCH_RESERVE holds its own rows). */
async function step(budget: ReadBudget): Promise<void> {
  budget.recount()
  await budget.need(1, 1)
}

/* The rows of `query`, read one at a time under `budget`, so a row of any
 * size fits, or null once it holds more than MAIN_SEARCH.listing. */
async function listed<R>(budget: ReadBudget, query: AsyncIterable<R>): Promise<R[] | null> {
  await budget.need(1, 1)
  const rows: R[] = []
  for await (const row of query) {
    if (rows.length === MAIN_SEARCH.listing) return null
    rows.push(row)
    await budget.need(0, 1)
  }
  return rows
}

/* Whether project `projectId` holds a task the search can find: an active
 * one, or with `include` any. Tasks live in sub-projects, but a task stored
 * before that rule can sit directly under a top-level project. */
async function holdsTask(
  ctx: QueryCtx,
  budget: ReadBudget,
  projectId: string,
  include: boolean,
): Promise<boolean> {
  await budget.need(1, 1)
  const task = include
    ? await ctx.db
        .query('issues')
        .withIndex('by_project', (q) => q.eq('project_id', projectId))
        .first()
    : await ctx.db
        .query('issues')
        .withIndex('by_project_archived', (q) =>
          q.eq('project_id', projectId).eq('archived_at', undefined),
        )
        .first()
  return task !== null
}

/* The ids of the projects `me`'s own rows name, of their organization and
 * live, each top-level one with its sub-projects, or null once they are
 * more than MAIN_SEARCH.listing: the projects they lead (projects by_lead),
 * their grants and the shares of their teams of their organization. Every
 * project row it reads goes into `read`. */
async function ownProjects(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  budget: ReadBudget,
  read: Map<string, Doc<'projects'>>,
): Promise<string[] | null> {
  const led = await listed(
    budget,
    ctx.db.query('projects').withIndex('by_lead', (q) => q.eq('lead_id', me.id)),
  )
  if (led === null) return null
  const grants = await listed(
    budget,
    ctx.db.query('project_access').withIndex('by_profile', (q) => q.eq('profile_id', me.id)),
  )
  if (grants === null) return null
  for (const p of led) read.set(p.id, p)
  const named = new Set([...led.map((p) => p.id), ...grants.map((g) => g.project_id)])
  if (receivesTeamAccess(me)) {
    const memberships = await listed(
      budget,
      ctx.db.query('team_members').withIndex('by_profile', (q) => q.eq('profile_id', me.id)),
    )
    if (memberships === null) return null
    for (const membership of memberships) {
      if (named.size > MAIN_SEARCH.listing) return null
      await budget.need(1, 1)
      const team = await byId(ctx, 'teams', membership.team_id)
      if (team === null || team.org_id !== me.org_id) continue
      const shares = await listed(
        budget,
        ctx.db.query('project_team_access').withIndex('by_team', (q) => q.eq('team_id', team.id)),
      )
      if (shares === null) return null
      for (const share of shares) named.add(share.project_id)
    }
  }
  if (named.size > MAIN_SEARCH.listing) return null
  const ids = new Set<string>()
  for (const id of named) {
    let p = read.get(id) ?? null
    if (p === null) {
      await budget.need(1, 1)
      p = await byId(ctx, 'projects', id)
      if (p !== null) read.set(p.id, p)
    }
    if (p === null || p.org_id !== me.org_id || p.archived_at !== undefined) continue
    ids.add(p.id)
    if (p.parent_id === undefined) {
      const kids = await listed(
        budget,
        ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', p.id)),
      )
      if (kids === null) return null
      for (const kid of kids) {
        read.set(kid.id, kid)
        ids.add(kid.id)
      }
    }
    if (ids.size > MAIN_SEARCH.listing) return null
  }
  return [...ids]
}

/**
 * Where main Search searches seat `me`: the live projects they can see,
 * one by one, at most `most` of them, or null when it searches their
 * organization instead, because they see more, one of the reads that list
 * them holds more than MAIN_SEARCH.listing rows, `most` is 0, or `me` sees
 * every project (seesEveryProject). Narrowed to `scope`, a top-level
 * project of `me`'s organization they can see, it lists that project and
 * its sub-projects instead. The list comes from the person's own rows
 * (ownProjects), and each listed project is then checked with
 * projectLevel's rule and its liveness, so the list only narrows what
 * access allows. A top-level project is searched only while it holds a
 * task (holdsTask). Every read goes through `budget`, which throws
 * OutOfRoom once the call's reads are spent. Answers the seat's access
 * too, which holds every project row the listing read.
 */
export async function searchPlaces(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  scope: Doc<'projects'> | null,
  budget: ReadBudget,
  most: number,
  include: boolean,
): Promise<{ access: Access; places: string[] | null }> {
  const read = new Map<string, Doc<'projects'>>()
  let candidates: string[] | null = null
  if (scope !== null) {
    read.set(scope.id, scope)
    const kids = await listed(
      budget,
      ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', scope.id)),
    )
    if (kids !== null) {
      for (const kid of kids) read.set(kid.id, kid)
      candidates = [scope.id, ...kids.map((kid) => kid.id)]
    }
  } else if (!seesEveryProject(me) && most > 0)
    candidates = await ownProjects(ctx, me, budget, read)
  const access = accessOf(ctx, me, [...read.values()])
  if (candidates === null || most <= 0) return { access, places: null }
  const places: string[] = []
  for (const id of candidates) {
    await step(budget)
    const p = await access.project(id)
    if (p === null || p.org_id !== me.org_id || !(await access.live(id))) continue
    if (!(await access.visible(id))) continue
    budget.recount()
    if (p.parent_id === undefined && !(await holdsTask(ctx, budget, id, include))) continue
    places.push(id)
    if (places.length > most) return { access, places: null }
  }
  budget.recount()
  return { access, places }
}

/* ------------------------------------------------------------- the search */

/* A task as a match keeps it, without its text. */
type TaskKeys = Pick<
  Doc<'issues'>,
  'id' | 'org_id' | 'num' | 'title' | 'status' | 'archived_at' | 'project_id'
>

/* One seat's search: its profile, its access, where it searches and which
 * of its projects the search may show. */
type Seat = {
  me: Doc<'profiles'>
  key: string
  access: Access
  /** the projects it searches one by one, or its whole organization
   * (undefined) */
  places: (string | undefined)[]
  /** whether it searches its whole organization without seeing every
   * project of it (coverageOf) */
  wide: boolean
  /** the tasks its number and title sources returned */
  returned: Set<string>
  /** whether its search began to read */
  started: boolean
  /** Whether a task of the project with this id may show: the project is
   * the organization's, live, inside the scope and visible. Each project
   * is asked once. */
  shows(projectId: string, budget: ReadBudget): Promise<boolean>
}

/* A match, as the page needs it. A match only in a task's description
 * holds no task, as the search judged it from the description row. */
type Match = Position & {
  at: Seat
  task: TaskKeys | null
}

/* The Seat of `me`, who sees through `access` and searches `places`,
 * inside `scope`, a project of their organization, when given. */
function seatOf(
  me: Doc<'profiles'>,
  access: Access,
  scope: Doc<'projects'> | null,
  places: (string | undefined)[],
  wide: boolean,
): Seat {
  const asked = new Map<string, Promise<boolean>>()
  return {
    me,
    key: seatKey(me),
    access,
    places,
    wide,
    returned: new Set(),
    started: false,
    async shows(projectId, budget) {
      const known = asked.get(projectId)
      if (known !== undefined) return await known
      // the project and the top-level project above it, at most
      await budget.need(0, 2)
      const answer = (async () => {
        const p = await access.project(projectId)
        if (p === null || !(await access.live(projectId))) return false
        if (scope !== null && p.id !== scope.id && p.parent_id !== scope.id) return false
        return await access.visible(projectId)
      })()
      asked.set(projectId, answer)
      const shows = await answer
      // the access rows it read, which the budget did not count
      budget.recount()
      return shows
    },
  }
}

const keysOf = (task: Doc<'issues'>): TaskKeys => ({
  id: task.id,
  org_id: task.org_id,
  num: task.num,
  title: task.title,
  status: task.status,
  archived_at: task.archived_at,
  project_id: task.project_id,
})

/* The kind order of a task result (Position). */
const TASK_KIND = 0

/* The score below which a match is only in a task's description, so its
 * position does not use the task's number (scoreOf's tiers). */
const TITLE_TIERS = 2e7

/**
 * One page of main Search for the caller, whose active profiles are
 * `myProfiles` keyed by organization. A text past LIMITS.search is refused
 * with its sentence, and a cursor that is not the next_cursor of an earlier
 * page of the same text, toggle and scope with bad_request. A blank text, a
 * text without words, and a scope the caller cannot use (an organization
 * without a seat, or a project that is unknown, of another organization,
 * archived or not visible) answer an empty, complete page alike. `stats`,
 * when given, gets what the call did.
 *
 * It plans each seat's places first (searchPlaces), keeping two searches
 * for each seat after it, then reads every seat's task numbers, then
 * searches the seats it searches exactly and last the seats it searches
 * whole (coverageOf).
 */
export async function mainSearchPage(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { text: string; include_archived: boolean; scope?: SearchScope; cursor?: string },
  stats: SearchStats = { searches: 0 },
): Promise<MainSearchPage> {
  const terms = searchTerms(limitedText(LIMITS.search, args.text))
  const include = args.include_archived
  const key = searchKey(terms, include, args.scope)
  const after = args.cursor === undefined ? null : await parseSearchCursor(args.cursor, key)
  if (args.cursor !== undefined && after === null)
    throw badRequest('cursor must be the next_cursor of an earlier page')
  const empty: MainSearchPage = { rows: [], next_cursor: null, coverage: { complete: true } }
  if (terms.length === 0) return empty
  const seats = [...myProfiles.values()]
    .filter((me) => args.scope === undefined || me.org_id === args.scope.org_id)
    .sort((a, b) => (seatKey(a) < seatKey(b) ? -1 : 1))
  if (seats.length === 0) return empty

  // the gathering's budget, inside the room the page's rows read up to
  const start = await ctx.meta.getTransactionMetrics()
  const room = roomOf(start, SEARCH_RESERVE)
  const ceiling: ReadCeiling = {
    ranges: Math.min(room.ranges, start.databaseQueries.used + MAIN_SEARCH.ranges),
    documents: Math.min(room.documents, start.documentsRead.used + MAIN_SEARCH.documents),
    bytes: Math.min(room.bytes, start.bytesRead.used + MAIN_SEARCH.bytes),
  }
  let gather = readBudget(ctx, ceiling)
  const stops: Stops = {
    wide: false,
    candidates: false,
    reads: false,
    searched: 0,
    of: seats.length,
  }

  // the scope's project, which must be live and visible to its one seat,
  // asked under the budget
  let scoped: Doc<'projects'> | null = null
  if (args.scope?.project_id !== undefined) {
    const scopeId = args.scope.project_id
    const access = accessOf(ctx, seats[0])
    try {
      await step(gather)
      const p = await access.project(scopeId)
      if (
        p !== null &&
        p.org_id === seats[0].org_id &&
        (await access.live(p.id)) &&
        (await access.visible(p.id))
      )
        scoped = p
      gather.recount()
    } catch (e) {
      if (!(e instanceof OutOfRoom)) throw e
      stops.reads = true
      return { rows: [], next_cursor: null, coverage: coverageOf(stops) }
    }
    if (scoped === null) return empty
  }

  const matches = new Map<string, Match>()
  const text = convexText(terms)
  // the task numbers the text names, which every seat reads first
  const numbers = terms.flatMap((term) => (term.num == null ? [] : [term.num]))
  // whether the search queries leave archived tasks out themselves
  const activeByIndex = !include && ARCHIVED_FILTER.byIndex
  // whether a text no search source returned holds none of the terms
  const sourcesTakeAll = convexTakesAll(terms)
  const gatherParse = parseAllowance(MAIN_SEARCH.parse)

  /* The readable text of description `raw` when a task with `fields` and
   * that text matches every term, else null, its parse counted by `spend`.
   * The readable text holds only words of the stored text, so a stored text
   * that lacks a term is not parsed, and nor is one that hides no words
   * (lib/md.ts hidesWords). A text past MAX_PARSE is answered in plain
   * paragraphs, unparsed, so only MAX_PARSE of it counts. */
  const matchedText = (
    fields: SearchFields,
    raw: string,
    spend: (chars: number) => void = gatherParse,
  ): string | null => {
    if (!matchesTerms(terms, { ...fields, description: raw })) return null
    if (!hidesWords(raw)) return raw
    spend(Math.min(raw.length, MAX_PARSE))
    const readable = readableText(raw)
    return matchesTerms(terms, { ...fields, description: readable }) ? readable : null
  }

  const add = (match: Match) => {
    const known = matches.get(match.id)
    // a match judged from the task row wins over one from a description row
    if (known === undefined || (known.task === null && match.task !== null))
      matches.set(match.id, match)
  }

  /* Counts `seat` as searched once its search begins to read. */
  const begin = (seat: Seat) => {
    if (seat.started) return
    seat.started = true
    stops.searched++
    if (seat.wide) stops.wide = true
  }

  /* Judges task `task` for `seat` and adds it when it matches, reading its
   * text (descriptionOf) when its title and number do not hold every
   * term. */
  const judgeTask = async (seat: Seat, task: Doc<'issues'>) => {
    if (task.org_id !== seat.me.org_id) return
    if (!include && task.archived_at !== undefined) return
    if (!(await seat.shows(task.project_id, gather))) return
    const fields: SearchFields = { num: task.num, title: task.title, description: '' }
    if (!matchesTerms(terms, fields)) {
      await gather.need(1, 2)
      const readable = matchedText(fields, await descriptionOf(ctx.db, task))
      if (readable === null) return
      fields.description = readable
    }
    const score = scoreOf(terms, fields)
    add({
      score,
      kind: TASK_KIND,
      seat: seat.key,
      tie: score >= TITLE_TIERS ? task.num : 0,
      id: task.id,
      at: seat,
      task: keysOf(task),
    })
  }

  /* Judges description row `row`, which neither the number nor the title
   * source returned, for `seat`. While the title source read every
   * candidate of the place (`titlesRead`) and took every term, the task's
   * title holds no term, so the row's copies and text decide, and the page
   * judges the task again (rowOf). Else, and for a row without copies, the
   * task row and the text readers show (descriptionOf) decide now. */
  const judgeRow = async (seat: Seat, row: Doc<'issue_descriptions'>, titlesRead: boolean) => {
    if (row.project_id === undefined || !titlesRead || !sourcesTakeAll) {
      await gather.need(1, 1)
      const task = await byId(ctx, 'issues', row.issue_id)
      if (task !== null) await judgeTask(seat, task)
      return
    }
    if (row.org_id !== seat.me.org_id) return
    if (!include && row.archived_at !== undefined) return
    if (!(await seat.shows(row.project_id, gather))) return
    const readable = matchedText({ title: '', description: '' }, row.description)
    if (readable === null) return
    add({
      score: scoreOf(terms, { title: '', description: readable }),
      kind: TASK_KIND,
      seat: seat.key,
      tie: 0,
      id: row.issue_id,
      at: seat,
      task: null,
    })
  }

  /* Reads search source `query` of `seat` in Convex's order, a document at
   * a time, judging each, and answers whether it read every candidate the
   * source had. Convex reads a search query's documents as they are asked
   * for, and counts each as an index range, as it fetches each by id (both
   * checked on a local backend), so each document needs a range and a
   * document. */
  const readSource = async <D>(
    seat: Seat,
    query: AsyncIterable<D>,
    judge: (doc: D) => Promise<void>,
  ) => {
    await gather.need(1, 1)
    begin(seat)
    stats.searches++
    let read = 0
    for await (const doc of query) {
      await judge(doc)
      if (++read >= MAIN_SEARCH.candidates) {
        stops.candidates = true
        return false
      }
      await gather.need(1, 1)
    }
    return true
  }

  /* Searches the places of `seat` and adds its matches. */
  const searchSeat = async (seat: Seat) => {
    const { me } = seat
    try {
      for (const place of seat.places) {
        const titles = ctx.db.query('issues').withSearchIndex('search_title', (q) => {
          let f = q.search('title', text).eq('org_id', me.org_id)
          if (place !== undefined) f = f.eq('project_id', place)
          if (activeByIndex) f = f.eq('archived_at', undefined)
          return f
        })
        const titlesRead = await readSource(seat, titles, async (task) => {
          if (seat.returned.has(task.id)) return
          seat.returned.add(task.id)
          await judgeTask(seat, task)
        })
        const descriptions = ctx.db
          .query('issue_descriptions')
          .withSearchIndex('search_description', (q) => {
            let f = q.search('description', text).eq('org_id', me.org_id)
            if (place !== undefined) f = f.eq('project_id', place)
            if (activeByIndex) f = f.eq('archived_at', undefined)
            return f
          })
        await readSource(seat, descriptions, async (row) => {
          if (seat.returned.has(row.issue_id) || matches.has(row.issue_id)) return
          await judgeRow(seat, row, titlesRead)
        })
      }
      // a seat with nothing to read at all searched all it had
      if (seat.places.length === 0 && numbers.length === 0) begin(seat)
    } catch (e) {
      if (!(e instanceof OutOfRoom)) throw e
      stops.reads = true
    }
  }

  // the places of each seat, keeping two searches for each seat after it
  const considered = seats.slice(0, MAIN_SEARCH.seats)
  const planned: Seat[] = []
  let searches = 0
  try {
    for (const [i, me] of considered.entries()) {
      const free = MAIN_SEARCH.searches - searches - 2 * (considered.length - i - 1)
      if (free < 2) break
      let seat: Seat
      if (scoped !== null && scoped.parent_id !== undefined)
        seat = seatOf(me, accessOf(ctx, me, [scoped]), scoped, [scoped.id], false)
      else {
        const most = Math.min(MAIN_SEARCH.projects, Math.floor(free / 2))
        const { access, places } = await searchPlaces(ctx, me, scoped, gather, most, include)
        const whole = places === null
        seat = seatOf(me, access, scoped, places ?? [undefined], whole && !seesEveryProject(me))
      }
      searches += 2 * seat.places.length
      planned.push(seat)
    }
  } catch (e) {
    if (!(e instanceof OutOfRoom)) throw e
    stops.reads = true
  }

  // every seat's task numbers first, one read each, the surest matches
  try {
    for (const seat of planned)
      for (const num of numbers) {
        await gather.need(1, 1)
        begin(seat)
        const task = await ctx.db
          .query('issues')
          .withIndex('by_org_num', (q) => q.eq('org_id', seat.me.org_id).eq('num', num))
          .first()
        if (task === null || seat.returned.has(task.id)) continue
        seat.returned.add(task.id)
        await judgeTask(seat, task)
      }
  } catch (e) {
    if (!(e instanceof OutOfRoom)) throw e
    stops.reads = true
  }

  // the seats searched exactly, then each seat searched whole within an
  // equal share of what they left, counted at the reads' real size, under
  // the gathering's own limit, so the page keeps its room (coverageOf)
  for (const seat of planned) if (!seat.wide) await searchSeat(seat)
  const wide = planned.filter((seat) => seat.wide)
  if (wide.length > 0) {
    const m = await ctx.meta.getTransactionMetrics()
    const share = {
      ranges: Math.floor((ceiling.ranges - m.databaseQueries.used) / wide.length),
      documents: Math.floor((ceiling.documents - m.documentsRead.used) / wide.length),
      bytes: Math.floor((ceiling.bytes - m.bytesRead.used) / wide.length),
    }
    for (const seat of wide) {
      const now = await ctx.meta.getTransactionMetrics()
      gather = readBudget(ctx, ceiling, {
        ranges: now.databaseQueries.used + share.ranges,
        documents: now.documentsRead.used + share.documents,
        bytes: now.bytesRead.used + share.bytes,
      })
      await searchSeat(seat)
    }
  }

  // the page holds the matches after the cursor, each judged again from
  // its live task row before it goes out, with its own parse allowance, of
  // which its first row may take any
  const order = [...matches.values()].sort(comparePositions)
  let at = after === null ? 0 : order.findIndex((m) => comparePositions(m, after) > 0)
  if (at < 0) at = order.length
  const rows: TaskResult[] = []
  const reads = readBudget(ctx, room)
  const pageParse = parseAllowance(MAIN_SEARCH.pageParse)
  let last: Match | null = null
  let ranOut = false
  for (; at < order.length && rows.length < MAIN_SEARCH.rows; at++) {
    const first = last === null
    try {
      const row = await rowOf(ctx, order[at], include, reads, (fields, raw) =>
        matchedText(fields, raw, (chars) => pageParse(chars, first)),
      )
      if (row !== null) rows.push(row)
      last = order[at]
    } catch (e) {
      if (!(e instanceof OutOfRoom)) throw e
      ranOut = true
      break
    }
  }
  // a page that could not read even its first row covers nothing
  if (ranOut && last === null) stops.reads = true
  const next = last !== null && at < order.length ? last : null
  return {
    rows,
    next_cursor: next === null ? null : await searchCursorText(key, next),
    coverage: coverageOf(stops),
  }
}

/**
 * The result row of match `m`, or null when its live task no longer
 * shows. A match only in a description reads its task row now and is
 * judged again from it and from the text readers show (descriptionOf), as
 * a rollback can leave the copies of the row it matched by stale, and a
 * second row can hold another text: its organization, archived state,
 * project, access and terms (`matched`, the gathering's matchedText under
 * the page's parse allowance). Every read goes through `reads`, which
 * throws OutOfRoom when the row does not fit.
 */
async function rowOf(
  ctx: QueryCtx,
  m: Match,
  include: boolean,
  reads: ReadBudget,
  matched: (fields: SearchFields, raw: string) => string | null,
): Promise<TaskResult | null> {
  const { access } = m.at
  let task = m.task
  if (task === null) {
    await reads.need(1, 1)
    const live = await byId(ctx, 'issues', m.id)
    if (live === null || live.org_id !== m.at.me.org_id) return null
    if (!include && live.archived_at !== undefined) return null
    if (!(await m.at.shows(live.project_id, reads))) return null
    await reads.need(1, 2)
    const raw = await descriptionOf(ctx.db, live)
    if (matched({ num: live.num, title: live.title, description: '' }, raw) === null) return null
    task = keysOf(live)
  }
  // the project, the top-level project above it, and a first subtask
  await reads.need(3, 3)
  const project = await access.project(task.project_id)
  if (project === null) return null
  const parent = project.parent_id === undefined ? null : await access.project(project.parent_id)
  const live: Liveness = async (projectId) => {
    // each later subtask the walk reads, and its project
    await reads.need(1, 2)
    const p = await access.project(projectId)
    return p !== null && p.archived_at === undefined
  }
  const isGroup = await hasSubtasks(ctx, task, live)
  return {
    kind: 'task',
    org_id: task.org_id,
    id: task.id,
    num: task.num,
    title: task.title,
    status: isGroup ? null : task.status,
    is_group: isGroup,
    archived: task.archived_at !== undefined,
    project: { id: project.id, name: project.name },
    parent: parent === null ? null : { id: parent.id, name: parent.name },
  }
}
