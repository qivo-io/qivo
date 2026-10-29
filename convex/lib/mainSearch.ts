/* Main Search's task and project results, the server half of Search in the
 * left menu (search.ts page). One call answers one page of up to
 * MAIN_SEARCH.rows results for a search text, across every organization
 * where the login holds a seat, or the scope the caller narrows it to, with
 * or without archived tasks.
 *
 * Each seat searches its places, which are the live projects the caller
 * can see, one by one, when they are few (searchPlaces), and otherwise the
 * whole organization. The task numbers the text names come first, one
 * read each in every seat (issues by_org_num), then for each place task
 * titles (issues search_title) and descriptions (issue_descriptions
 * search_description), where a task number matches a whole word of its
 * digits. A project result matches the project's own name only, never its
 * key, number or description, its parent's name or its tasks, and a task's
 * project name is no part of the task's text. A seat searched project by
 * project matches the names of the projects its planning read and found it
 * sees, with no query; a seat searched whole asks the names of its
 * organization's live projects (projects search_name) after its numbers
 * and before its places, once its organization's reach rows are complete
 * (model/projectNav.ts reachReady), and judges each with
 * model/projectNav.ts projectSight.
 * Convex's search matches any term of the text, in its own relevance
 * order, so each source is read in that order up to its cap
 * (MAIN_SEARCH.candidates, MAIN_SEARCH.names for names), and every
 * candidate is judged here. It counts only when the caller may see it
 * (ordinary project access, lib/access.ts accessOf, so an organization
 * admin follows projectLevel like everyone else) and every term matches its
 * number, title or readable description, or a project's name
 * (lib/searchTerms.ts, lib/md.ts readableText). The matches of every seat
 * and both kinds are ranked together (lib/searchTerms.ts scoreOf, then
 * comparePositions), and a page is the rows after the cursor's position in
 * that order. Every page gathers the same candidates, so the order is the
 * same on every page.
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

import type { TransactionMetrics } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { hasSubtasks } from '../model/issues'
import { projectSight, reachReady } from '../model/projectNav'
import {
  type Access,
  accessOf,
  isAccessUnchecked,
  OWN_READS,
  type OwnReads,
  receivesTeamAccess,
} from './access'
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
 * planned yet. The seats together read at most `ranges` index ranges,
 * `documents` documents and `bytes` bytes, counted from the call's start,
 * and parse at most `parse` characters of descriptions that hide words
 * (lib/md.ts hidesWords), split into equal allowances (allowancesOf). The
 * page parses up to `pageParse` more, a page of descriptions at
 * LIMITS.description, and always its first row. Every
 * search result costs an index range, so `ranges` binds first. On a local
 * backend (2026-10-29) 2,000 results took 0.25 to 0.45 s of the 1 s Convex
 * gives a query's own code, and parsing 1,000,000 characters of
 * descriptions full of links took 0.1 to 0.2 s. A seat that sees 32
 * projects runs 64 search queries; its pages there read 400 to 630
 * documents in about 0.1 s of that time, and its heaviest page stopped at
 * `ranges` after 0.24 s.
 *
 * A seat searched whole also asks its organization's project names, at
 * most `names` candidates, in one more search query outside `searches`, so
 * a call runs at most `searches` and one name query for each of at most
 * `seats` seats, and the planning of task sources stays as it was. Convex
 * bills a search query by the size of its index, and the projects index is
 * far smaller than the tasks'. Reserving the name query inside `searches`
 * would lower `most` for later seats instead, so a later seat that sees a
 * few more projects than the lowered `most` would be searched whole. The
 * name source runs before the seat's task places, within its own part of
 * the seat's allowance (NAME_SHARE), which bounds what reading and judging
 * the names may read, and once that part is spent the seat stops its names
 * with `reads` and goes on to its places with the rest. So in a large
 * organization whose project names match the text, a seat searched whole
 * has up to a quarter fewer reads left for its task sources than before,
 * and can stop with `reads` sooner. Measured in convex-test (2026-10-29) in
 * an organization of 300 projects whose names all held the text, the 256
 * candidates cost an admin's seat and a member's seat searched whole each
 * about 255 documents and 95 KB more than one candidate did, and on Convex,
 * which counts each search result as a range, as many ranges: about an
 * eighth of a lone seat's ranges. The member's check of hidden candidates
 * read no more, as their reach rows left those out (model/projectNav.ts
 * projectSight). Tests lower these. */
export const MAIN_SEARCH = {
  rows: 25,
  candidates: 512,
  names: 256,
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

/* The part of a seat's allowance its project names may read, on every
 * count: a quarter. The name query, the readiness read and every read of
 * the names' check (model/projectNav.ts projectSight) count against it, and
 * against what is left of the seat's allowance after its number lookups,
 * so the names never read past the seat's allowance, and its task sources
 * keep the rest however the names' check reads, also when many seats share
 * the call and each allowance is small. */
const NAME_SHARE = 4

/** The least allowance a seat is searched with (allowancesOf). When what
 * the seats may read cannot give each this much, the later ones in seat
 * order are left unsearched. Tests raise and lower it. */
export const SEAT_SHARE: ReadCeiling = { ranges: 32, documents: 32, bytes: 256 << 10 }

/** What the page may read for its rows, counted at the reads' real size
 * from its own start: a page of rows whose tasks and descriptions are at
 * LIMITS.description, with their projects and first subtasks. Tests lower
 * it. */
export const PAGE_READS: ReadCeiling = { ranges: 300, documents: 1_000, bytes: 3 << 20 }

/* The most one step of a seat or of the page reserves, which it reserves
 * against the real limit before it reads (readBudget): two documents at
 * Convex's size limit, a task's two description rows, which text stored
 * before the caps can make that large, or a project and the top-level
 * project above it, at most twice lib/limits.ts PROJECT_ROW_MAX_BYTES, and
 * the access rows a project's first check reads after the reservation. */
const STEP: ReadCeiling = {
  ranges: 16,
  documents: 64,
  bytes: 2 * DOCUMENT_MAX_BYTES + (64 << 10),
}

/* What the seats' allowances leave under their real limit besides STEP:
 * room for each allowance to be passed by the one step that crosses it,
 * at the sizes rows have under the caps. Only steps whose rows are near
 * Convex's 1 MiB document size pass it, and only those can make the real
 * limit stop a seat before its own allowance does. */
const SLACK: ReadCeiling = { ranges: 64, documents: 256, bytes: 512 << 10 }

/** What a number lookup counts against its seat's allowance, from before its
 * read to the verdict of whether the seat may be shown the task it found:
 * whether a task the seat cannot see holds the number, one it can, or none,
 * it costs the same, so what it read changes no decision. It holds what
 * such a lookup reads at the sizes rows have under the caps: the task row,
 * the project and top-level project the verdict reads, and their access
 * rows. With both projects at lib/limits.ts PROJECT_ROW_MAX_BYTES and a
 * task row as the third release of the description move writes it,
 * without its text, a lookup by a seat without team access reads about 13
 * KB (measured). A task row that still holds its text's copy until the
 * description backfill's clear, about 61 KB at the cap in a three-byte
 * script, makes it about 73 KB, and a seat in teams that share the projects
 * reads about 9 KB more a share at the name caps; that difference falls to
 * the real limit, as coverageOf says of a lookup that reads more than
 * LOOKUP holds. Tests read it. */
export const LOOKUP: ReadCeiling = { ranges: 16, documents: 64, bytes: 64 << 10 }

/** What a call keeps back from Convex's limits for the reads its budget
 * does not count one by one: one access check past the budget's last look,
 * with every read of the caller's own rows it may start, at searchReads'
 * bounds (lib/access.ts OWN_READS states the figures). That is one
 * question's project, parent, grants and team shares and its navigation
 * from reach rows, at most 23 ranges and 411 documents; the instance's
 * memberships asked team by team (17 ranges), its teams asked one by one
 * past projectShares (32) and each team of the caller's a share names (at
 * most 64); and its shared reads, at most 139 ranges and 4,956 documents on
 * either path, or 64 ranges more where the organization's teams are past
 * their bounds. So at most 275 ranges and about 5,500 documents, or 339
 * ranges in that one case, which passes 320 by at most 19, while convex-test
 * counts a range the transaction read before again and a deployment does
 * not. The listing reads its rows one at a time under the budget, and the
 * seats and the page read within their own allowances (allowancesOf). Each
 * team read costs at most lib/limits.ts TEAM_ROW_MAX_BYTES. Tests lower
 * it. */
export const SEARCH_RESERVE: ReadCeiling = {
  ranges: OWN_READS.teams + 64,
  documents: 2 * OWN_READS.rows + OWN_READS.orgTeamsMost,
  bytes: OWN_READS.bytes + (2 << 20),
}

/** The bounds of each seat's access reads (lib/access.ts OWN_READS), below
 * the workspace parts' where theirs would not fit SEARCH_RESERVE: one check
 * and every read of the person's own rows it may start, past the budget's
 * last look, stay inside it (OWN_READS states the figures). A person past
 * them is not checked in full here, which stops the search's reads
 * (endsReads), never shows less as complete. Computed from OWN_READS when
 * a seat is read, so tests that lower it lower these too. */
export const searchReads = (): OwnReads => ({
  ...OWN_READS,
  teams: Math.min(OWN_READS.teams, 64),
  lookups: Math.min(OWN_READS.lookups, 16),
  members: Math.min(OWN_READS.members, 64),
  roots: Math.min(OWN_READS.roots, 512),
  subProjects: Math.min(OWN_READS.subProjects, 512),
  subBytes: Math.min(OWN_READS.subBytes, 512 << 10),
  shareLookups: Math.min(OWN_READS.shareLookups, 32),
})

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

/** One project result as main Search shows it, a live project the caller
 * sees whose name matches. `parent` is the top-level project above a
 * sub-project, so equal names can be told apart, and null for a top-level
 * project. */
export type ProjectResult = {
  kind: 'project'
  org_id: string
  id: string
  name: string
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

/** One page of main Search, task and project results ranked together. A
 * page can hold fewer than MAIN_SEARCH.rows rows, even none, while
 * `next_cursor` says that more follow: its reads ran out, the live tasks of
 * matches it looked at no longer show, or a project's parent is gone. */
export type MainSearchPage = {
  rows: (TaskResult | ProjectResult)[]
  next_cursor: string | null
  coverage: Coverage
}

/** What one call did, for tests: how many search queries it ran. */
export type SearchStats = { searches: number }

/* ------------------------------------------------------------ the order */

/** Where a result sorts: by `score` (lib/searchTerms.ts scoreOf, a
 * project's name scored as a title without a number), highest first; then
 * by `kind`, tasks (0) before projects (1); then by `seat`, the caller's
 * home seat first and then the others by organization id (seatKey); then
 * by `tie`, a task's or a project's number, newest first, and 0 for a match
 * only in a task's description, whose task the search does not read before
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
 * of its organization searched it whole (`wide`), a seat searched whole
 * left its project names out because its organization's reach rows are not
 * complete (`unready`, model/projectNav.ts reachReady), a source returned
 * its cap (`candidates`), the budget stopped a source or the judging
 * (`reads`), and how many of the seats asked about began their search
 * (`searched` of `of`): matched the names of the projects they see, which
 * reads nothing, or began to read. */
type Stops = {
  wide: boolean
  unready: boolean
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
 * A source read over a whole organization returns tasks and projects the
 * caller cannot see too, and they count toward its cap and the budget, so
 * its stops would tell whether, and with padding how many, hidden tasks or
 * project names hold a word. So a search of the whole organization for a
 * seat that does not see every project of it (seesEveryProject) is always
 * reported incomplete, as `projects`, whatever it read: choosing a project
 * searches that project fully. A seat searched project by project reads
 * only tasks of projects it sees and matches only the names of projects it
 * sees, and a seat that sees every project hides nothing from itself, so
 * their stops are reported exactly. A seat searched whole whose
 * organization's reach rows are not complete searches no project names
 * (`unready`), and is reported as `projects` too: choosing a project lists
 * its projects from their rows, with no name query.
 *
 * Across seats, what one seat reads never changes what another or the
 * page may read (allowancesOf). Right after planning, whose reads are of
 * what the caller can see, and before any read that can reach a hidden
 * task, the search splits what the transaction may still read into fixed
 * allowances, one for each seat it searches and one for the page, from the
 * reads up to that point alone. Each seat and the page count their reads
 * against their own allowance from their own start, at the reads' real
 * size; no unused part passes on. The page's room is set aside first, so
 * no seat reads into it. The seats left out count as not searched. Each
 * number lookup counts as LOOKUP from before its read to the verdict of
 * whether the seat may be shown its task, so whether a task the caller
 * cannot see holds the number, and how large it is, change no decision.
 *
 * `stopped` names `projects` first, then the budget (`reads`), then a
 * source's cap (`candidates`), each of which means that matches in the
 * seats searched may be missing, so the palette shows its note that some
 * results might be missing; else it names the seats left out
 * (`organizations`). `searched` of `of` seats says whether seats were left
 * out, also beside another stop.
 *
 * What can still depend on tasks or projects the caller cannot see, and
 * nothing else:
 * - Inside one seat searched whole, its rows and stops, as its
 *   organization's hidden tasks and hidden projects' names take candidates
 *   and reads a visible match would have had, and so which rows of other
 *   seats fit on a page beside its rows, and whether a cursor follows. The
 *   names' check (model/projectNav.ts projectSight) reads the person's
 *   reach rows, and for a hidden top-level candidate the person's reach
 *   rows reach, its grants and team shares and their child rows under it,
 *   all within the names' part of that seat's allowance (NAME_SHARE). A
 *   top-level project the person sees only for navigation, whose first
 *   child rows of each grantee all fail (a viewer's lead, a project in a
 *   Deleted items move), or, past PROJECT_SIGHT's bounds, one seen only
 *   through a team's source on a sub-project, stays out there, a missed
 *   match. An organization admin's whole seat also reads projects
 *   outside any meta's tree, which no writer makes now and no one sees.
 *   Such a seat's coverage, and so the search's, is always `projects`,
 *   except an admin's, whose seat hides nothing.
 * - The real limit, which every allowance shares: the transaction's, less
 *   the page's room for the seats. Each step reserves its documents at
 *   Convex's 1 MiB size against it, and the allowances leave STEP and
 *   SLACK under it, so it stops a read before the read's own allowance
 *   does only once earlier reads passed what they were counted at by more
 *   than SLACK holds: rows near Convex's 1 MiB document size (a task, or a
 *   project with a description stored before the caps), a number
 *   lookup that reads more than LOOKUP holds (a hidden task or project row
 *   over the caps), or an access check that reads many rows, for a person
 *   in many teams or a project shared with many.
 * - A description row a rollback left with stale copies, which name a
 *   project the seat sees while the row's live task is hidden. The seat
 *   reads and parses the row as one of its candidates, and the seat or the
 *   page reads the live task to judge it, each in its own allowances.
 * - The page's walk for whether a result is a group (rowOf), as Qivo's
 *   group rule counts active subtasks in any project, hidden ones too
 *   (model/issues.ts hasSubtasks). The walk reads them and their projects
 *   in the page's own allowance, and finds a project the seat already read
 *   for free.
 * Planning reads hidden projects, never tasks, in one case: whether a
 * top-level project of the scope shows only for navigation reads the reach
 * rows of the seat and its teams under it and the sub-projects those name,
 * and, only for an organization without nav_at or a seat past searchReads'
 * reach bounds, its sub-projects. An access check a bound stops ends the
 * search as a read that does not fit does (endsReads), so its coverage is
 * never complete after one. A seat searched project by project matches only the names
 * of projects planning found it sees, so it reads no name of a project it
 * cannot see.
 */
export function coverageOf(stops: Stops): Coverage {
  const left = stops.searched < stops.of
  if (!stops.wide && !stops.unready && !stops.reads && !stops.candidates && !left)
    return { complete: true }
  return {
    complete: false,
    stopped:
      stops.wide || stops.unready
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

/* Whether `e` ends the gathering or the page as a read that does not fit
 * does: OutOfRoom, or an access check a bound stopped (lib/access.ts
 * accessUnchecked), so a search that met one never reports complete
 * coverage. */
const endsReads = (e: unknown): boolean => e instanceof OutOfRoom || isAccessUnchecked(e)

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
 * With `share`, an allowance as transaction totals, the reads also stop
 * once they have reached it, counted at their real size from the request's
 * metrics before each step, so a share smaller than a few documents at
 * Convex's size limit still reads and judges small documents, and a step
 * may pass it by what it reads, never `ceiling`. `hold` counts a step at a
 * fixed size instead of its real one. */
function readBudget(ctx: QueryCtx, ceiling: ReadCeiling, share?: ReadCeiling) {
  // what was left at the last look, less what was asked for since
  let ranges = 0
  let documents = 0
  // what the share counts apart from the request's metrics (hold)
  const credit: ReadCeiling = { ranges: 0, documents: 0, bytes: 0 }
  // the step held at a fixed size: the request's totals when it began, and
  // its size
  let held: { from: ReadCeiling; fixed: ReadCeiling } | undefined
  return {
    /** Throws OutOfRoom unless `r` more index ranges and `d` more documents
     * of any size fit. While a step is held, only `ceiling` counts. */
    async need(r: number, d: number): Promise<void> {
      if (share !== undefined && held === undefined) {
        const m = countsOf(await ctx.meta.getTransactionMetrics())
        if (
          m.ranges - credit.ranges + r > share.ranges ||
          m.documents - credit.documents + d > share.documents ||
          m.bytes - credit.bytes >= share.bytes
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
    /** Begins a step that counts as `fixed` against the share whatever it
     * reads: throws OutOfRoom unless it fits now, as a step of that size,
     * and until release lets only `ceiling` stop a read, so nothing the step
     * reads changes what it may read. */
    async hold(fixed: ReadCeiling): Promise<void> {
      const m = countsOf(await ctx.meta.getTransactionMetrics())
      if (
        share !== undefined &&
        (m.ranges - credit.ranges + fixed.ranges > share.ranges ||
          m.documents - credit.documents + fixed.documents > share.documents ||
          m.bytes - credit.bytes >= share.bytes)
      )
        throw new OutOfRoom()
      held = { from: m, fixed }
    },
    /** Ends the held step, counting what it read as its fixed size. */
    async release(): Promise<void> {
      if (held === undefined) return
      const now = countsOf(await ctx.meta.getTransactionMetrics())
      credit.ranges += now.ranges - held.from.ranges - held.fixed.ranges
      credit.documents += now.documents - held.from.documents - held.fixed.documents
      credit.bytes += now.bytes - held.from.bytes - held.fixed.bytes
      held = undefined
      this.recount()
    },
  }
}

type ReadBudget = ReturnType<typeof readBudget>

/* What a reader asks of a budget: room before each read, and a look at the
 * request's metrics after reads it was not asked about. */
type Reads = Pick<ReadBudget, 'need' | 'recount'>

/* A transaction's reads so far, in the units of a ReadCeiling. */
const countsOf = (m: TransactionMetrics): ReadCeiling => ({
  ranges: m.databaseQueries.used,
  documents: m.documentsRead.used,
  bytes: m.bytesRead.used,
})

/* `a` plus `b`, count by count. */
const plus = (a: ReadCeiling, b: ReadCeiling): ReadCeiling => ({
  ranges: a.ranges + b.ranges,
  documents: a.documents + b.documents,
  bytes: a.bytes + b.bytes,
})

/**
 * How many of `planned` seats the search reads, in seat order, and what
 * each and the page may read, decided right after planning from the
 * request's reads up to then (`now`) alone (coverageOf). The page gets
 * PAGE_READS, and the seats' real limit (`limit`) is the transaction's
 * (`room`) less the page's allowance and STEP, so no seat reads into the
 * page's room. The seats share equally what is left of MAIN_SEARCH's
 * totals, counted from the call's `start`, and of their real limit less
 * STEP and SLACK: as many seats as get at least SEAT_SHARE each, and each an
 * equal part of MAIN_SEARCH.parse.
 */
export function allowancesOf(
  planned: number,
  start: ReadCeiling,
  now: ReadCeiling,
  room: ReadCeiling,
): { seats: number; seat: ReadCeiling; parse: number; limit: ReadCeiling } {
  const counts = ['ranges', 'documents', 'bytes'] as const
  const limit = (count: (typeof counts)[number]) => room[count] - PAGE_READS[count] - STEP[count]
  const total = (count: (typeof counts)[number]) =>
    Math.min(
      start[count] + MAIN_SEARCH[count] - now[count],
      limit(count) - now[count] - STEP[count] - SLACK[count],
    )
  let seats = planned
  while (seats > 0 && counts.some((count) => Math.floor(total(count) / seats) < SEAT_SHARE[count]))
    seats--
  const each = (count: (typeof counts)[number]) =>
    seats === 0 ? 0 : Math.floor(total(count) / seats)
  return {
    seats,
    seat: { ranges: each('ranges'), documents: each('documents'), bytes: each('bytes') },
    parse: seats === 0 ? 0 : Math.floor(MAIN_SEARCH.parse / seats),
    limit: { ranges: limit('ranges'), documents: limit('documents'), bytes: limit('bytes') },
  }
}

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
 * live, each top-level one with its sub-projects (`ids`), or null once they
 * are more than MAIN_SEARCH.listing: the projects they lead (projects
 * by_lead), their grants and the shares of their teams of their
 * organization. The archived sub-projects of their organization those rows
 * name go apart (`archived`), as a source on one shows its top-level
 * project for navigation. Every project row it reads goes into `read`. */
async function ownProjects(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  budget: ReadBudget,
  read: Map<string, Doc<'projects'>>,
): Promise<{ ids: string[]; archived: string[] } | null> {
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
  const archived: string[] = []
  for (const id of named) {
    let p = read.get(id) ?? null
    if (p === null) {
      await budget.need(1, 1)
      p = await byId(ctx, 'projects', id)
      if (p !== null) read.set(p.id, p)
    }
    if (p === null || p.org_id !== me.org_id) continue
    if (p.archived_at !== undefined) {
      if (p.parent_id !== undefined) archived.push(p.id)
      continue
    }
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
  return { ids: [...ids], archived }
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
 *
 * With listed places it also answers the live projects of the organization
 * the seat sees among those it read (`shown`), whose names the seat's
 * search matches with no query: each listed project that passed the checks,
 * a top-level project without tasks among them; the top-level project above
 * each sub-project that passed them; and, outside a scope, the top-level
 * project above each archived sub-project the person's own rows name that
 * they see, as a source on it shows its parent for navigation. Each such
 * parent must be live and of the organization, and the check of its
 * sub-project already read it. Outside an admin seat projectLevel gives a
 * level only through a lead, a grant or a team share the listing reads,
 * on the project or on the top-level project above, whose sub-projects the
 * listing adds, and navigation shows a top-level project only for a
 * sub-project the person sees through such a source, so `shown` holds every
 * project canSeeProject lets the seat see, and only those. No organization
 * readiness is needed, as these are read from project rows, leads, grants
 * and shares, which archive states and reach rows do not change.
 */
export async function searchPlaces(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  scope: Doc<'projects'> | null,
  budget: ReadBudget,
  most: number,
  include: boolean,
): Promise<{ access: Access; places: string[] | null; shown: Doc<'projects'>[] }> {
  const read = new Map<string, Doc<'projects'>>()
  let candidates: string[] | null = null
  let archived: string[] = []
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
  } else if (!seesEveryProject(me) && most > 0) {
    const own = await ownProjects(ctx, me, budget, read)
    if (own !== null) ({ ids: candidates, archived } = own)
  }
  const access = accessOf(ctx, me, [...read.values()], searchReads())
  if (candidates === null || most <= 0) return { access, places: null, shown: [] }
  const places: string[] = []
  const shown = new Map<string, Doc<'projects'>>()
  /* Keeps the live top-level project of the organization above `p`, which
   * the check of `p` read. */
  const showParent = async (p: Doc<'projects'>) => {
    if (p.parent_id === undefined || shown.has(p.parent_id)) return
    const above = await access.project(p.parent_id)
    if (above !== null && above.org_id === me.org_id && above.archived_at === undefined)
      shown.set(above.id, above)
  }
  for (const id of candidates) {
    await step(budget)
    const p = await access.project(id)
    if (p === null || p.org_id !== me.org_id || !(await access.live(id))) continue
    if (!(await access.visible(id))) continue
    shown.set(p.id, p)
    await showParent(p)
    budget.recount()
    if (p.parent_id === undefined && !(await holdsTask(ctx, budget, id, include))) continue
    places.push(id)
    if (places.length > most) return { access, places: null, shown: [] }
  }
  for (const id of archived) {
    const p = read.get(id)
    if (p?.parent_id === undefined || shown.has(p.parent_id)) continue
    await step(budget)
    if (await access.visible(id)) await showParent(p)
  }
  budget.recount()
  return { access, places, shown: [...shown.values()] }
}

/* ------------------------------------------------------------- the search */

/* A task as a match keeps it, without its text. */
type TaskKeys = Pick<
  Doc<'issues'>,
  'id' | 'org_id' | 'num' | 'title' | 'status' | 'archived_at' | 'project_id'
>

/* A project as a match keeps it, without its description. */
type ProjectKeys = Pick<Doc<'projects'>, 'id' | 'org_id' | 'num' | 'name' | 'parent_id'>

/* One seat's search: its profile, its access, where it searches and which
 * of its projects the search may show. */
type Seat = {
  me: Doc<'profiles'>
  key: string
  access: Access
  /** the projects it searches one by one, or its whole organization
   * (undefined) */
  places: (string | undefined)[]
  /** the live projects it sees whose names it matches with no query
   * (searchPlaces `shown`), or null when it asks its organization's names
   * (projects search_name) */
  names: Doc<'projects'>[] | null
  /** whether it searches its whole organization without seeing every
   * project of it (coverageOf) */
  wide: boolean
  /** the tasks its number and title sources returned */
  returned: Set<string>
  /** whether its search began: it matched the names of the projects it
   * sees, which reads nothing, or a read of it fitted (begin) */
  started: boolean
  /** Whether a task of the project with this id may show: the project is
   * the organization's, live, inside the scope and visible. Each project
   * is asked once. */
  shows(projectId: string, budget: ReadBudget): Promise<boolean>
}

/* A task match, as the page needs it. A match only in a task's description
 * holds no task, as the search judged it from the description row. */
type Match = Position & {
  at: Seat
  task: TaskKeys | null
}

/* A project match, judged from its live row in this transaction. */
type NameMatch = Position & {
  at: Seat
  project: ProjectKeys
}

/* The Seat of `me`, who sees through `access` and searches `places`,
 * inside `scope`, a project of their organization, when given, matching
 * the names of `names` or, for null, of its organization. */
function seatOf(
  me: Doc<'profiles'>,
  access: Access,
  scope: Doc<'projects'> | null,
  places: (string | undefined)[],
  names: Doc<'projects'>[] | null,
  wide: boolean,
): Seat {
  const asked = new Map<string, Promise<boolean>>()
  return {
    me,
    key: seatKey(me),
    access,
    places,
    names,
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

/* The kind order of a task and of a project result (Position). */
const TASK_KIND = 0
const PROJECT_KIND = 1

const projectKeysOf = (p: Doc<'projects'>): ProjectKeys => ({
  id: p.id,
  org_id: p.org_id,
  num: p.num,
  name: p.name,
  parent_id: p.parent_id,
})

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
 * for each seat after it, then splits what is left to read into fixed
 * allowances (allowancesOf), then searches each seat in seat order within
 * its own allowance, and reads the page's rows within the page's
 * (coverageOf). A seat searched project by project matches the names of the
 * projects it sees first, with no read, then its task numbers and places;
 * a seat searched whole reads its task numbers, then its organization's
 * readiness and project names (searchNames), then its places.
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

  // the planning's budget, MAIN_SEARCH's totals inside the transaction's
  // real limit less the reserve (room)
  const start = await ctx.meta.getTransactionMetrics()
  const room = roomOf(start, SEARCH_RESERVE)
  const opening = countsOf(start)
  let gather = readBudget(ctx, {
    ranges: Math.min(room.ranges, opening.ranges + MAIN_SEARCH.ranges),
    documents: Math.min(room.documents, opening.documents + MAIN_SEARCH.documents),
    bytes: Math.min(room.bytes, opening.bytes + MAIN_SEARCH.bytes),
  })
  const stops: Stops = {
    wide: false,
    unready: false,
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
    const access = accessOf(ctx, seats[0], [], searchReads())
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
      if (!endsReads(e)) throw e
      stops.reads = true
      return { rows: [], next_cursor: null, coverage: coverageOf(stops) }
    }
    if (scoped === null) return empty
  }

  // the task matches and, apart from them, the project matches, by id
  const matches = new Map<string, Match>()
  const named = new Map<string, NameMatch>()
  const text = convexText(terms)
  // the task numbers the text names, which every seat reads first
  const numbers = terms.flatMap((term) => (term.num == null ? [] : [term.num]))
  // whether the search queries leave archived tasks out themselves
  const activeByIndex = !include && ARCHIVED_FILTER.byIndex
  // whether a text no search source returned holds none of the terms
  const sourcesTakeAll = convexTakesAll(terms)
  // the parse allowance of the seat searched now
  let seatParse = parseAllowance(0)
  // what the names of the seat searched now may read (NAME_SHARE), and the
  // seats' real limit
  let seatNames: ReadCeiling = { ranges: 0, documents: 0, bytes: 0 }
  let seatLimit: ReadCeiling = seatNames

  /* The readable text of description `raw` when a task with `fields` and
   * that text matches every term, else null, its parse counted by `spend`.
   * The readable text holds only words of the stored text, so a stored text
   * that lacks a term is not parsed, and nor is one that hides no words
   * (lib/md.ts hidesWords). A text past MAX_PARSE is answered in plain
   * paragraphs, unparsed, so only MAX_PARSE of it counts. */
  const matchedText = (
    fields: SearchFields,
    raw: string,
    spend: (chars: number) => void = seatParse,
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

  /* Whether project `p` is inside the scope and its name holds every term,
   * matched as a title without a number, so neither its key nor its number
   * is any part of it. */
  const nameFits = (p: Doc<'projects'>): boolean =>
    (scoped === null || p.id === scoped.id || p.parent_id === scoped.id) &&
    matchesTerms(terms, { title: p.name, description: '' })

  /* Adds project `p`, which `seat` sees and whose name fits. */
  const addName = (seat: Seat, p: Doc<'projects'>) => {
    named.set(p.id, {
      score: scoreOf(terms, { title: p.name, description: '' }),
      kind: PROJECT_KIND,
      seat: seat.key,
      tie: p.num,
      id: p.id,
      at: seat,
      project: projectKeysOf(p),
    })
  }

  /* Counts `seat` as searched once its search begins: when it matches the
   * names of the projects it sees, all of which it then searched with no
   * read, or at its first read that fits. A seat that matches no listed
   * names and whose first read does not fit counts as not searched. */
  const begin = (seat: Seat) => {
    if (seat.started) return
    seat.started = true
    stops.searched++
    if (seat.wide) stops.wide = true
  }

  /* Whether `seat` may be shown task `task`: of its organization, active
   * unless the toggle is on, and in a project that shows (Seat.shows). */
  const showsTask = async (seat: Seat, task: Doc<'issues'>): Promise<boolean> =>
    task.org_id === seat.me.org_id &&
    (include || task.archived_at === undefined) &&
    (await seat.shows(task.project_id, gather))

  /* Judges task `task`, which `seat` may be shown, and adds it when it
   * matches, reading its text (descriptionOf) when its title and number do
   * not hold every term. */
  const judgeShown = async (seat: Seat, task: Doc<'issues'>) => {
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

  /* Judges task `task` for `seat` and adds it when it matches. */
  const judgeTask = async (seat: Seat, task: Doc<'issues'>) => {
    if (await showsTask(seat, task)) await judgeShown(seat, task)
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
   * a time under `budget`, the seat's own unless given, judging each, up to
   * `cap` candidates, and answers whether it read every candidate the source
   * had. Convex reads a search query's documents as they are asked for, and
   * counts each as an index range, as it fetches each by id (both checked on
   * a local backend), so each document needs a range and a document. */
  const readSource = async <D>(
    seat: Seat,
    query: AsyncIterable<D>,
    judge: (doc: D) => Promise<void>,
    { cap = MAIN_SEARCH.candidates, budget = gather }: { cap?: number; budget?: Reads } = {},
  ) => {
    await budget.need(1, 1)
    begin(seat)
    stats.searches++
    let read = 0
    for await (const doc of query) {
      await judge(doc)
      if (++read >= cap) {
        stops.candidates = true
        return false
      }
      await budget.need(1, 1)
    }
    return true
  }

  /* Searches the names of the live projects of `seat`'s organization, a
   * seat searched whole, and adds those it sees. It first reads whether the
   * organization's archive states and reach rows are complete
   * (model/projectNav.ts reachReady): the query filters by archive_state,
   * which a project stored before it has none of until internal/navBackfill
   * runs, and the check reads reach rows. Without them it asks no names
   * (`unready`), failing closed. Each candidate is matched first, so one
   * whose name lacks a term costs no check, then judged by
   * model/projectNav.ts projectSight. Everything it reads, the readiness
   * included, must fit both the names' own part of the seat's allowance
   * (NAME_SHARE) and what is left of the seat's allowance itself (`gather`,
   * whose held number lookups count at LOOKUP), so the names never read past
   * the seat's allowance; once either is spent the names stop with `reads`,
   * and the seat goes on to its places with what is left. */
  const searchNames = async (seat: Seat) => {
    const { me, access } = seat
    const now = countsOf(await ctx.meta.getTransactionMetrics())
    const share = readBudget(ctx, seatLimit, plus(now, seatNames))
    const seatBudget = gather
    const budget: Reads = {
      async need(ranges, documents) {
        await seatBudget.need(ranges, documents)
        await share.need(ranges, documents)
      },
      recount() {
        seatBudget.recount()
        share.recount()
      },
    }
    try {
      await budget.need(1, 1)
      begin(seat)
      if (!(await reachReady(ctx, me.org_id))) {
        stops.unready = true
        return
      }
      const sees = projectSight(ctx, me, access, budget)
      const names = ctx.db
        .query('projects')
        .withSearchIndex('search_name', (q) =>
          q.search('name', text).eq('org_id', me.org_id).eq('archive_state', 'live'),
        )
      await readSource(
        seat,
        names,
        async (p) => {
          if (nameFits(p) && (await sees(p))) addName(seat, p)
        },
        { cap: MAIN_SEARCH.names, budget },
      )
    } catch (e) {
      if (!endsReads(e)) throw e
      stops.reads = true
    } finally {
      // the seat's budget looks at what the names read before its next read
      gather.recount()
    }
  }

  /* Searches `seat` and adds its matches: the names of the projects it
   * sees when they are listed, its task numbers, its organization's project
   * names when it is searched whole, and then its places. Each number
   * lookup, from before its read to the verdict of whether the seat may be
   * shown its task, counts as LOOKUP (held), so what it found changes no
   * decision; only a task shown is judged further at its real size. */
  const searchSeat = async (seat: Seat) => {
    const { me } = seat
    try {
      // names it sees, all searched with no read
      if (seat.names !== null && seat.names.length > 0) {
        begin(seat)
        for (const p of seat.names) if (nameFits(p)) addName(seat, p)
      }
      for (const num of numbers) {
        await gather.hold(LOOKUP)
        let shown: Doc<'issues'> | null = null
        try {
          await gather.need(1, 1)
          // a seat that matched no listed names counts as searched once a
          // read fits, not before
          begin(seat)
          const task = await ctx.db
            .query('issues')
            .withIndex('by_org_num', (q) => q.eq('org_id', me.org_id).eq('num', num))
            .first()
          if (task !== null && !seat.returned.has(task.id)) {
            seat.returned.add(task.id)
            if (await showsTask(seat, task)) shown = task
          }
        } finally {
          await gather.release()
        }
        if (shown !== null) await judgeShown(seat, shown)
      }
      if (seat.names === null) await searchNames(seat)
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
      if (!endsReads(e)) throw e
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
        seat = seatOf(
          me,
          accessOf(ctx, me, [scoped], searchReads()),
          scoped,
          [scoped.id],
          [scoped],
          false,
        )
      else {
        const most = Math.min(MAIN_SEARCH.projects, Math.floor(free / 2))
        const listing = await searchPlaces(ctx, me, scoped, gather, most, include)
        const whole = listing.places === null
        seat = seatOf(
          me,
          listing.access,
          scoped,
          listing.places ?? [undefined],
          whole ? null : listing.shown,
          whole && !seesEveryProject(me),
        )
      }
      searches += 2 * seat.places.length
      planned.push(seat)
    }
  } catch (e) {
    if (!endsReads(e)) throw e
    stops.reads = true
  }

  // what is left to read, split right after planning into the seats'
  // allowances and the page's, each seat searched within its own, under
  // the seats' real limit (coverageOf)
  const allowances = allowancesOf(
    planned.length,
    opening,
    countsOf(await ctx.meta.getTransactionMetrics()),
    room,
  )
  for (const seat of planned.slice(0, allowances.seats)) {
    const now = countsOf(await ctx.meta.getTransactionMetrics())
    gather = readBudget(ctx, allowances.limit, plus(now, allowances.seat))
    seatParse = parseAllowance(allowances.parse)
    seatLimit = allowances.limit
    seatNames = {
      ranges: Math.floor(allowances.seat.ranges / NAME_SHARE),
      documents: Math.floor(allowances.seat.documents / NAME_SHARE),
      bytes: Math.floor(allowances.seat.bytes / NAME_SHARE),
    }
    await searchSeat(seat)
  }

  // the page holds the matches of both kinds after the cursor, each task
  // judged again from its live task row before it goes out, within its own
  // allowance and parse allowance, of which its first row may take any
  const order = [...matches.values(), ...named.values()].sort(comparePositions)
  let at = after === null ? 0 : order.findIndex((m) => comparePositions(m, after) > 0)
  if (at < 0) at = order.length
  const rows: (TaskResult | ProjectResult)[] = []
  const reads = readBudget(
    ctx,
    room,
    plus(countsOf(await ctx.meta.getTransactionMetrics()), PAGE_READS),
  )
  const pageParse = parseAllowance(MAIN_SEARCH.pageParse)
  let last: Match | NameMatch | null = null
  let ranOut = false
  for (; at < order.length && rows.length < MAIN_SEARCH.rows; at++) {
    const first = last === null
    const m = order[at]
    try {
      const row =
        'project' in m
          ? await projectRowOf(m, reads)
          : await rowOf(ctx, m, include, reads, (fields, raw) =>
              matchedText(fields, raw, (chars) => pageParse(chars, first)),
            )
      if (row !== null) rows.push(row)
      last = m
    } catch (e) {
      if (!endsReads(e)) throw e
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
 * The result row of project match `m`, which the gathering judged from the
 * project's live row in this transaction, with the top-level project above
 * a sub-project, read through the seat's access (which read it to judge the
 * project) under `reads`. Null when that project is gone, of another
 * organization or archived, which fails closed.
 */
async function projectRowOf(m: NameMatch, reads: ReadBudget): Promise<ProjectResult | null> {
  const { project } = m
  let parent: ProjectResult['parent'] = null
  if (project.parent_id !== undefined) {
    await reads.need(1, 1)
    const above = await m.at.access.project(project.parent_id)
    if (above === null || above.org_id !== project.org_id || above.archived_at !== undefined)
      return null
    parent = { id: above.id, name: above.name }
  }
  return { kind: 'project', org_id: project.org_id, id: project.id, name: project.name, parent }
}

/**
 * The task result row of task match `m`, or null when its live task no
 * longer shows. A match only in a description reads its task row now and is
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
  // the project, the top-level project above it, and a first subtask, each
  // reserved as it is read, so no step reserves more than STEP
  await reads.need(1, 1)
  const project = await access.project(task.project_id)
  if (project === null) return null
  await reads.need(1, 1)
  const parent = project.parent_id === undefined ? null : await access.project(project.parent_id)
  await reads.need(1, 1)
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
