/* The reads of project navigation (projectNav.ts): a person's top-level
 * projects across every seat of their login, the favorites of every seat
 * first and then the rest of every seat (navPageOf, projectNav.page); one
 * top-level project's live sub-projects (navChildrenOf,
 * projectNav.children); one project resolved for navigation, by id or by
 * its organization and number (navResolveOf, projectNav.resolve); and the
 * directory's name search across the person's projects and sub-projects,
 * the favorites first (navSearchOf, projectNav.search). They read the rows
 * the writers in model/projectNav.ts (reach rows) and
 * model/projectFavorites.ts (favorites) keep, and no task. The Settings
 * project lists (model/projectSettingsLists.ts) judge every seat but an
 * organization admin's by the same rules, through seatSight, rootShows,
 * ownRoots, restCandidates, childRowShows, inheritedShows and
 * navChildrenOf, with cursors of their own and no favorites group.
 *
 * Who sees what. Every candidate is judged by ordinary access, lib/access.ts
 * accessOf of ordinaryOf(seat), so an organization admin's lists hold only
 * the projects their own leads, grants and team shares reach (coordinator,
 * 4 November 2026; the admin access split changes nothing here). A
 * top-level project shows when the seat sees it for a reason of its own
 * (accessible: its lead, a grant or a team share on it), or when a live
 * child reach row of the seat or of one of its teams under it names a live
 * sub-project the seat sees (visible) (seatSight shows). A project the seat
 * sees only through an archived sub-project, which lib/access.ts counts for
 * navigation, has nothing live to lead to and stays out of every read, the
 * search included (coordinator, 4 November 2026). A sub-project shows when
 * it and its parent are live and the seat sees it, which shows its parent
 * too.
 *
 * Where candidates come from. The page reads each seat's live favorites
 * (project_favorites by_profile_list) and the live root reach rows of the
 * seat and of its teams (project_reach by_grantee_list). children reads,
 * for a parent the seat sees for a reason of its own, the parent's live
 * sub-projects (projects by_org_parent_state_name), each of which inherits
 * that level, and otherwise only the live child reach rows of the seat and
 * its teams under it (by_grantee_root). The search reads what the page
 * reads, the live child reach rows of the seat and of its teams across
 * every top-level project (by_grantee_list), and the live sub-projects of
 * each top-level project the seat sees for a reason of its own. A source
 * on a top-level project writes its grantee one root row there (on_root)
 * and no child row for its sub-projects (model/projectNav.ts planReach),
 * so a person who holds a grant, a lead or a team share on a project finds
 * its sub-projects only through that project. Before its walk the search
 * reads every live root row of the seat and its teams, and asks accessible
 * of each top-level project such a row records a source on, and it reads
 * the sub-projects of only those that pass. A Viewer's lead, which writes
 * an on_root row and gives nothing, and a stale row thus open no
 * sub-project the seat cannot see. Each still costs every call its
 * project's read and accessible check, which, for a role that receives
 * team access, can read that project's team shares, at most
 * OWN_READS.projectShares + 1, and look up the person's membership in each
 * share's team, so how far a call's budget goes depends, within that
 * bound, on a project the seat does not see, as the page's check of such a
 * root row does when a batch reaches it. A row finds a candidate and
 * grants nothing. The reader reads and judges each candidate's live
 * project, and a reach row's copies must be its project's (organization,
 * kind, top-level project, name key against nameKey(project.name) and live
 * state, as model/projectNav.ts reachFollows compares them), else the
 * reader skips the row, so a project shows once and at its own name's
 * place. A missing or stale row narrows a list and never widens it. So
 * where a batch ends and how far its budget goes depend only on the
 * person's own rows and the projects they see, except for that bounded
 * check of a project one of their root rows names and they do not see
 * (above). A favorite on a project the seat lost costs a lookup of each of
 * its grantees' reach rows on it and nothing of that project
 * (model/projectFavorites.ts favoriteShows).
 *
 * The order. A list is in the byte order of the name key (lib/namedPages.ts
 * compareNamed), the project id breaking ties. The page's positions also
 * carry a group mark first, FAVORITES before REST (lib/namedPages.ts
 * inGroup), and the seat's organization after the project id, which every
 * row of one seat shares, so the positions of two seats never meet and
 * mergeNamed's guard keeps its meaning. The reach rows of one seat and of
 * its teams on one project share a position and name one project, which the
 * merge hands out once (mergeNamed's `ties`). Cursors are sealed with the
 * list's name and scope (an empty scope for the page, the project id for
 * children, the login, the organization asked for and the normalized
 * search for the search), so a cursor opens only for its own list,
 * project, login, organization and search. The search's positions are the
 * page's, a sub-project's in the group of the rest with its own id, and
 * the live sub-projects of a top-level project are tied as reach rows are,
 * so a sub-project's document and a child row of it share one position.
 *
 * Batches. LIST_BATCH (25) rows a batch, or every row up to `through` and
 * at most four times that, as model/projectSettings.ts lists answer
 * (lib/namedPages.ts listBatch), under NAMED_READ for the whole call. Past
 * the budget a batch answers `stopped` at the position it reached, never
 * `next: null`. A check a bound of OWN_READS or PROJECT_NAV stopped answers
 * the refusal `{ state: 'unavailable', reason: 'access_unchecked',
 * message }` whole, never a list missing a project and never a loss of
 * access; this includes OWN_READS.teamReads (roomSpent), which a batch
 * spends across every project it asks about, and the search's bounds of
 * the rows and projects it reads before its walk (PROJECT_NAV.rootRows,
 * PROJECT_NAV.roots). The lists answer `not_ready` until the
 * organization's reach rows and name keys are complete
 * (model/projectNav.ts navReady). */

import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  ACCESS_UNCHECKED,
  type Access,
  accessOf,
  accessUnchecked,
  inMetaTree,
  isAccessUnchecked,
  ordinaryOf,
  receivesTeamAccess,
} from '../lib/access'
import { byId } from '../lib/db'
import type { ArchiveState } from '../lib/enums'
import { badRequest, type Refusal } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  type BatchAsk,
  compareNamed,
  indexAfter,
  inGroup,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedAt,
  type NamedIndex,
  type NamedReads,
  type NamedStream,
  type NamedTie,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { type IdTie, readyRow } from './nameKeys'
import { type FavoriteSight, favoriteOf, favoriteShows, favoritesIndex } from './projectFavorites'
import { type Grantee, grantee, navReady } from './projectNav'

/** The bounds of the navigation reads' own lookups, which tests lower and
 * set back. `teams`: the most teams of one seat read; past it a read
 * answers the access_unchecked refusal, as Archived tasks
 * (lib/archivedTasks.ts ARCHIVED_SCOPE.teams) and main Search's project
 * names (model/projectNav.ts PROJECT_SIGHT.teams) bound them. `children`:
 * the most live child reach rows checked under one top-level project the
 * seat sees only for navigation; a row fails only for a sub-project a
 * Deleted items move or restore holds, a reused id or a lead a Viewer kept
 * from before the rule that Viewers lead nothing, so past it with none shown
 * the read refuses rather than answer no access.
 *
 * The search's reads before its walk (ownRoots), across every seat it
 * searches, past either of which it answers the access_unchecked refusal
 * whole before it reads a project. `rootRows`: the most live root reach
 * rows of the seats and their teams it reads, about four times what a
 * person at the design size holds (about 260, the projects figure's 200
 * with everyday teams). `roots`: the most distinct top-level projects those
 * rows record a source on (on_root) that it reads and asks accessible of,
 * each of which then costs a stream of its live sub-projects, whose first
 * row a batch reads before it hands out one (lib/namedPages.ts mergeNamed).
 * A seat holds at most its organization's live top-level projects, 200 at
 * the design size, so two seats each at that figure stay under it. A call
 * at the bound, past the design size, stays inside Convex's limits (below).
 *
 * What one call reads at the design size, one figure a case, measured in
 * convex/tests/projectNav.test.ts ("reads at the design size") under
 * Convex's transaction limits, in index ranges and documents as Convex
 * counts them:
 * - page, each batch for a person with grants on 200 top-level projects:
 *   104 ranges and 78 documents; a batch kept live to 100 rows: 337 ranges
 *   and 335 documents; the same 200 as favorites: 105 ranges and 104
 *   documents a batch;
 * - page, the first batch beside 300 archived top-level projects the
 *   person reaches, with one shown for navigation in it: 108 ranges and 79
 *   documents, the same as without the archived ones;
 * - page, the first batch for a member of 5 teams each sharing 20
 *   sub-projects, every parent shown for navigation only: 219 ranges and
 *   284 documents, the most of any batch of 25 rows, and 4 of the 128
 *   single-row reads of OWN_READS.teamReads (with 3 it refuses whole);
 * - page for one of the person's teams sharing 50 projects beside its 150
 *   archived shares: 108 ranges and 80 documents a batch;
 * - page for 200 sub-projects read through grants under 67 parents shown
 *   for navigation only: 187 ranges and 211 documents a batch, and each
 *   parent's children at most 16 ranges and 14 documents;
 * - page beside 500 archived sub-projects the person holds grants on under
 *   167 live parents, which lib/access.ts shows for navigation and these
 *   reads leave out: 599 ranges and 557 documents for its one batch of 20
 *   rows, which reads every parent's live root row and finds no live
 *   sub-project under it, the most of any batch;
 * - children of a project with 30 live sub-projects for a person with
 *   access on it: 55 ranges and 29 documents for the first of two batches,
 *   and 10 ranges for one who holds one of them; a project's own 3 beside
 *   40 archived sub-projects, or among 500 live or 1,000 archived
 *   sub-projects of the organization: 11 ranges and 6 documents;
 * - resolve of a sub-project of a project shared with 5 teams: 15 ranges
 *   and 14 documents.
 * No case reads the archived rows it leaves out: 500 archived sub-projects
 * under archived parents and 300 favorites on archived projects beside
 * live ones change no figure.
 * All of them far inside NAMED_READ (2,000 ranges, 8,000 documents).
 *
 * What one call of the search reads at the design size, measured in
 * convex/tests/projectNavSearch.test.ts ("reads at the design size") the
 * same way, for a search that matches nothing, which reads every candidate
 * in one batch, and for one that matches every name, every batch walked,
 * with a batch kept live to 100 rows from the start and one from the first
 * batch's end. A first call reads, before its walk, every live root row of
 * the person and asks accessible of each top-level project they hold a
 * source on, and every batch reads the first row of each such project's
 * live sub-projects, two ranges each after a cursor:
 * - grants on 200 top-level projects, 32 sub-projects under them: 640
 *   ranges and 995 documents matching nothing; batches of every name 665
 *   ranges and 794 documents first and at most 866 and 790 later; kept
 *   live to 100 rows, 740 and 864 from the start and 941 and 865 from the
 *   first batch's end. Beside 300 archived top-level projects with grants,
 *   the same;
 * - the same 200 as favorites: 640 and 1,195 matching nothing, and at most
 *   1,040 ranges and 1,155 documents in the batch that passes the 200 root
 *   rows the favorites leave out, the most of any batch;
 * - grants on 200 top-level projects and the 200 sub-projects they read
 *   under 67 of them, the sum of the two figures one search lists: 640 and
 *   1,163 matching nothing; batches 665 and 850 first and at most 866 and
 *   844 later; kept live 740 and 906, and 941 and 901;
 * - 200 sub-projects through grants on them under 67 parents shown for
 *   navigation only, beside 500 archived ones with grants under 167
 *   archived parents: 6 ranges and 335 documents matching nothing; batches
 *   at most 99 and 162; kept live 289 and 453, and 294 and 457; the same
 *   without the archived ones;
 * - the same 200 inherited through grants on their 67 parents, beside the
 *   500 archived ones under archived parents with grants on those: 240 and
 *   502; batches at most 333 and 317; kept live 341 and 507, and 409 and
 *   502; the same without the archived ones;
 * - 500 archived sub-projects with grants under 167 live parents, which
 *   lib/access.ts shows for navigation and these reads leave out, for a
 *   search that matches every parent: 601 ranges and 744 documents in one
 *   batch with no row;
 * - a member of 5 teams each sharing 20 sub-projects: 21 and 180; batches
 *   at most 154 and 141; kept live 280 and 455, and 321 and 459;
 * - one team sharing 50 projects of 3 sub-projects beside its 150 archived
 *   shares: 176 and 536; batches at most 236 and 382; kept live 201 and
 *   462, and 254 and 457;
 * - 30 live sub-projects under one project with a grant beside its 40
 *   archived ones: 59 ranges and 30 documents, then 24 and 11; an everyday
 *   person's search among 500 live or 1,000 archived sub-projects of the
 *   organization: 17 and 8, the same as without them; a sub-project of a
 *   project shared with 5 teams: 29 and 23.
 * Each top-level project the person holds a source on costs a first call
 * about 3.2 ranges and 5 documents before any row is judged (its read, its
 * check and the head of its sub-projects) and a later call about 4.2
 * ranges. At PROJECT_NAV.roots after a cursor that is about 2,200 ranges,
 * with a batch's own checks about 2,500, inside Convex's 4,096 ranges and
 * 32,000 documents; it passes NAMED_READ, so such a call answers `stopped`
 * after its first row and the next goes on from there. */
export const PROJECT_NAV = { teams: 64, children: 4, rootRows: 1000, roots: 512 }

/* --------------------------------------------------------------- the rows */

/** A project as navigation shows it: its name, its number to tell equal
 * names apart and to build its address (src/lib/router.ts), and its
 * organization. Nothing about the person's level, rights or sub-projects. */
export type NavProject = { id: string; org_id: string; name: string; num: number }

/** A row of projectNav.page, a top-level project, with whether it is one of
 * its seat's favorites by the reader rule (model/projectFavorites.ts). */
export type NavPageRow = NavProject & { favorite: boolean }

/** A row of projectNav.children, a live sub-project. */
export type NavChildRow = NavProject & { parent_id: string }

/** One batch of a navigation list (lib/namedPages.ts ListBatch): `next`
 * null at the end, and `stopped` where the read budget ended it before it
 * was full. */
export type NavBatch<Row> = { state: 'ok' } & ListBatch<Row>

/** A project or list the person cannot open: alike for every project they
 * cannot see, or, with `reason` access_unchecked and its sentence, a check
 * a bound stopped, which is never a loss of access. */
export type NavUnavailable = {
  state: 'unavailable'
  reason?: typeof ACCESS_UNCHECKED
  message?: string
}

/** What the lists answer when they cannot list: `not_ready` until the
 * organization's reach rows and name keys are complete, or unavailable. */
export type NavRefusal = { state: 'not_ready' } | NavUnavailable

/** What projectNav.page answers. Its unavailable answer always carries
 * access_unchecked, as the page names no project. */
export type NavPage = NavBatch<NavPageRow> | NavRefusal

/** What projectNav.children answers. */
export type NavChildren = NavBatch<NavChildRow> | NavRefusal

/** What projectNav.resolve answers: the project with its parent and its
 * favorite state, or unavailable. */
export type NavResolve =
  | {
      state: 'ok'
      project: NavProject & {
        /** the top-level project above a sub-project, null for a top-level one */
        parent: NavProject | null
        /** a top-level project's favorite state, null for a sub-project */
        favorite: boolean | null
      }
    }
  | NavUnavailable

const UNAVAILABLE = { state: 'unavailable' } as const

/* The refusal of a check a bound stopped, with its own sentence. */
const unchecked = (message: string): NavUnavailable => ({
  state: 'unavailable',
  reason: ACCESS_UNCHECKED,
  message,
})

/* `p` as a navigation row. */
const navProject = (p: Doc<'projects'>): NavProject => ({
  id: p.id,
  org_id: p.org_id,
  name: p.name,
  num: p.num,
})

/* ------------------------------------------------------------ the cursors */

/** The arguments of a navigation list: the cursors of the batch's start
 * (`after`, none for the first batch) and, to keep a loaded batch live, its
 * end (`through`). */
export type NavCursorArgs = { after?: string; through?: string }

/** The page's list name, which seals its cursors with an empty scope. The
 * search seals its own with SEARCH_LIST, so a cursor of one never opens
 * for the other. */
export const PAGE_LIST = 'projectNav.page'

/** The children list's name, which seals its cursors with the project id. */
export const CHILDREN_LIST = 'projectNav.children'

/** The page's and the search's group marks (lib/namedPages.ts inGroup): a
 * seat's favorites before the rest. */
export const FAVORITES = '0'
export const REST = '1'

/** The tie of a page or search position: the project id, then the seat's
 * organization. */
export type SeatTie = readonly [project_id: string, org_id: string]

const NOT_PAGE_CURSOR =
  'after and through must be cursors from an earlier answer of projectNav.page; start again from the first batch'

const NOT_CHILDREN_CURSOR =
  'after and through must be cursors from an earlier answer of projectNav.children for the same project; start again from the first batch'

/** The cursors of list `list` with scope `scope` opened. Refuses with
 * badRequest an `after` or `through` that is not a cursor this list gave
 * for the same scope, or whose position `tieOf` refuses (a tie of the
 * wrong shape, a key without a group mark), and a `through` that does not
 * come after `after`. */
async function openAsk<Tie extends NamedTie>(
  list: string,
  scope: readonly string[],
  a: NavCursorArgs,
  refusal: string,
  tieOf: (at: NamedAt) => Tie | null,
): Promise<BatchAsk & { after: NamedAt<Tie> | null; through: NamedAt<Tie> | null }> {
  const open = async (text: string | undefined): Promise<NamedAt<Tie> | null> => {
    if (text === undefined) return null
    const at = await openNamedCursor(text, list, scope)
    const tie = at === null ? null : tieOf(at)
    if (at === null || tie === null) throw badRequest(refusal)
    return { key: at.key, tie }
  }
  const after = await open(a.after)
  const through = await open(a.through)
  if (after !== null && through !== null && compareNamed(through, after) <= 0)
    throw badRequest('through must be a cursor after the one in after')
  return { list, scope, after, through }
}

/* A page or search position's tie, or null for any other shape. */
const seatTieOf = ({ key, tie }: NamedAt): SeatTie | null => {
  const [projectId, orgId] = tie
  if (tie.length !== 2 || typeof projectId !== 'string' || typeof orgId !== 'string') return null
  return key.startsWith(FAVORITES) || key.startsWith(REST) ? [projectId, orgId] : null
}

/* A children position's tie, or null for any other shape. */
const idTieOf = ({ tie }: NamedAt): IdTie | null => {
  const [id] = tie
  return tie.length === 1 && typeof id === 'string' ? [id] : null
}

/* ------------------------------------------------------------ the indexes */

/* The position of a row in name order, tied by `tie`. Readers refuse until
 * the organization is keyed, so a row without a key here passed that check
 * and is refused rather than placed first, as model/nameKeys.ts does. */
function keyed<Tie extends NamedTie>(key: string | undefined, tie: Tie): NamedAt<Tie> {
  if (key === undefined) throw new Error('an unkeyed project passed the readiness check')
  return { key, tie }
}

/** The live root reach rows of grantee `g` in name order
 * (project_reach by_grantee_list), the copied name key, then the project
 * id and then `orgId`, the organization of the seat they are read for. */
export function rootIndex(
  ctx: QueryCtx,
  g: Grantee,
  orgId: string,
): NamedIndex<Doc<'project_reach'>, SeatTie> {
  const rows = () => ctx.db.query('project_reach')
  return {
    all: () =>
      rows().withIndex('by_grantee_list', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('kind', 'root')
          .eq('live', true),
      ),
    // from the cursor's project id itself, as model/projectFavorites.ts
    // favoritesIndex reads, since another seat's cursor at the same key and
    // id lies before this seat's row there when its organization sorts first
    after: ({ key, tie: [projectId] }) => [
      () =>
        rows().withIndex('by_grantee_list', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('kind', 'root')
            .eq('live', true)
            .eq('name_key', key)
            .gte('project_id', projectId),
        ),
      () =>
        rows().withIndex('by_grantee_list', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('kind', 'root')
            .eq('live', true)
            .gt('name_key', key),
        ),
    ],
    at: (row) => ({ key: row.name_key, tie: [row.project_id, orgId] }),
  }
}

/** The live child reach rows of grantee `g` under top-level project
 * `rootId` in name order (project_reach by_grantee_root): copied name key,
 * then sub-project id. With `live` false, the archived ones, which the
 * Settings list of an archived project's sub-projects reads
 * (model/projectSettingsLists.ts). */
export function childIndex(
  ctx: QueryCtx,
  g: Grantee,
  rootId: string,
  live = true,
): NamedIndex<Doc<'project_reach'>, IdTie> {
  const rows = () => ctx.db.query('project_reach')
  return {
    all: () =>
      rows().withIndex('by_grantee_root', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('root_id', rootId)
          .eq('kind', 'child')
          .eq('live', live),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        rows().withIndex('by_grantee_root', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('root_id', rootId)
            .eq('kind', 'child')
            .eq('live', live)
            .eq('name_key', key)
            .gt('project_id', id),
        ),
      () =>
        rows().withIndex('by_grantee_root', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('root_id', rootId)
            .eq('kind', 'child')
            .eq('live', live)
            .gt('name_key', key),
        ),
    ],
    at: (row) => ({ key: row.name_key, tie: [row.project_id] }),
  }
}

/** The live sub-projects of top-level project `parent` in name order
 * (projects by_org_parent_state_name, archive_state live): name key, then
 * id. With `state` 'under', those archived beneath it, which the Settings
 * list of an archived project's sub-projects reads
 * (model/projectSettingsLists.ts). */
export function subProjectIndex(
  ctx: QueryCtx,
  parent: Pick<Doc<'projects'>, 'id' | 'org_id'>,
  state: ArchiveState = 'live',
): NamedIndex<Doc<'projects'>, IdTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects().withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', parent.org_id).eq('parent_id', parent.id).eq('archive_state', state),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', parent.org_id)
            .eq('parent_id', parent.id)
            .eq('archive_state', state)
            .eq('name_key', key)
            .gt('id', id),
        ),
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', parent.org_id)
            .eq('parent_id', parent.id)
            .eq('archive_state', state)
            .gt('name_key', key),
        ),
    ],
    at: (p) => keyed(p.name_key, [p.id] as const),
  }
}

/** The live child reach rows of grantee `g` across every top-level project
 * in name order (project_reach by_grantee_list, kind child): the copied
 * name key, then the sub-project id and then `orgId`, the organization of
 * the seat they are read for, as rootIndex ties a root row. The search
 * reads them, as does any list of a seat's sub-projects across parents. */
export function childListIndex(
  ctx: QueryCtx,
  g: Grantee,
  orgId: string,
): NamedIndex<Doc<'project_reach'>, SeatTie> {
  const rows = () => ctx.db.query('project_reach')
  return {
    all: () =>
      rows().withIndex('by_grantee_list', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('kind', 'child')
          .eq('live', true),
      ),
    // from the cursor's project id itself, as rootIndex reads
    after: ({ key, tie: [projectId] }) => [
      () =>
        rows().withIndex('by_grantee_list', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('kind', 'child')
            .eq('live', true)
            .eq('name_key', key)
            .gte('project_id', projectId),
        ),
      () =>
        rows().withIndex('by_grantee_list', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('kind', 'child')
            .eq('live', true)
            .gt('name_key', key),
        ),
    ],
    at: (row) => ({ key: row.name_key, tie: [row.project_id, orgId] }),
  }
}

/** The live sub-projects of top-level project `parent` in name order
 * (projects by_org_parent_state_name, archive_state live), tied as a
 * seat's reach rows are: the stored name key, then the id and then
 * `orgId`, the organization of the seat they are read for. A sub-project
 * and a child reach row of it then share one position, which a merge with
 * ties hands out once. subProjectIndex reads the same rows with the id
 * alone as their tie, for projectNav.children. */
export function seatSubProjectIndex(
  ctx: QueryCtx,
  parent: Pick<Doc<'projects'>, 'id' | 'org_id'>,
  orgId: string,
): NamedIndex<Doc<'projects'>, SeatTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects().withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', parent.org_id).eq('parent_id', parent.id).eq('archive_state', 'live'),
      ),
    // from the cursor's id itself, as rootIndex reads
    after: ({ key, tie: [id] }) => [
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', parent.org_id)
            .eq('parent_id', parent.id)
            .eq('archive_state', 'live')
            .eq('name_key', key)
            .gte('id', id),
        ),
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', parent.org_id)
            .eq('parent_id', parent.id)
            .eq('archive_state', 'live')
            .gt('name_key', key),
        ),
    ],
    at: (p) => keyed(p.name_key, [p.id, orgId] as const),
  }
}

/* ---------------------------------------------------------- the judgement */

/* The cached promise of `key`, read once. */
function once<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let known = cache.get(key)
  if (known === undefined) {
    known = read()
    // a rejection fails every answer that awaits it, and none unawaited
    known.catch(() => {})
    cache.set(key, known)
  }
  return known
}

/* accessUnchecked where the organization's reach rows are not complete
 * (org_ready nav_at) and lib/access.ts visible shows a top-level project
 * the seat sees for no reason of its own, which only a live sub-project
 * may show and only those rows tell (seatSight shows). resolve answers it
 * as the access_unchecked refusal and children as `not_ready`. */
class Unproven extends ConvexError<Refusal> {}

/** One seat's sight of its organization's projects for navigation, every
 * check of one call (seatSight). Beside the reader rule's questions
 * (model/projectFavorites.ts FavoriteSight) it holds the seat's access and
 * its grantees. */
export type SeatSight = FavoriteSight & {
  /** lib/access.ts accessOf of ordinaryOf(seat), for every check */
  access: Access
  /** the seat and, when its role receives team access, its teams
   * (team_members by_profile), the seat first, read once; rejects with
   * accessUnchecked past PROJECT_NAV.teams teams */
  grantees: () => Promise<readonly Grantee[]>
}

/**
 * The navigation sight of `seat`, read once a call. `reach` says whether
 * the organization's reach rows are complete (org_ready nav_at); `read`
 * holds projects the caller read already.
 *
 * `shows` answers whether the seat sees a live top-level meta of its
 * organization for navigation (module header). It does for a reason of
 * its own (accessible), or through the first PROJECT_NAV.children live
 * child reach rows of its teams and then its seat under it, one range a
 * grantee, each row's sub-project read and asked visible, past which with
 * none shown it rejects with accessUnchecked. With complete reach rows it
 * never asks lib/access.ts visible of a top-level project, which would
 * read every root row of the person. Without them a missing row proves
 * nothing, so for a project the seat sees for no reason of its own it asks
 * visible of the project, which takes lib/access.ts's bounded legacy path
 * through the parent's sub-projects. It answers false where visible does,
 * and where visible shows the project it rejects with Unproven, an
 * accessUnchecked, since only a live sub-project may show it and only the
 * rows tell which. projectNav.children, which waits for those rows anyway,
 * answers that rejection `not_ready`, and resolve the access_unchecked
 * refusal.
 *
 * `reached` answers whether the seat or one of its teams holds a reach row
 * on a project (project_reach by_project_grantee, one range a grantee, the
 * seat first), which every top-level project the seat sees holds once the
 * rows are complete, so the favorites verdict asks it before any read of
 * the project; without complete rows it answers true and leaves the
 * judgement to `shows`.
 */
export function seatSight(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  reach: boolean,
  read: readonly Doc<'projects'>[] = [],
): SeatSight {
  const access = accessOf(ctx, ordinaryOf(seat), read)
  const mine = new Map<string, Promise<readonly Grantee[]>>()
  const grantees = () =>
    once(mine, seat.id, async () => {
      const self = grantee.profile(seat.id)
      if (!receivesTeamAccess(seat)) return [self]
      const rows = await ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', seat.id))
        .take(PROJECT_NAV.teams + 1)
      if (rows.length > PROJECT_NAV.teams) throw accessUnchecked()
      return [self, ...rows.map((row) => grantee.team(row.team_id))]
    })
  const found = new Map<string, Promise<boolean>>()
  const reached = (projectId: string) =>
    once(found, projectId, async () => {
      if (!reach) return true
      for (const g of await grantees()) {
        const row = await ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) =>
            q
              .eq('project_id', projectId)
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id),
          )
          .first()
        if (row !== null) return true
      }
      return false
    })
  const shown = new Map<string, Promise<boolean>>()
  const shows = (p: Doc<'projects'>) =>
    once(shown, p.id, async () => {
      if (p.org_id !== seat.org_id || p.archived_at !== undefined || !inMetaTree(p, p)) return false
      access.seen(p)
      if (await access.accessible(p.id)) return true
      if (!reach) {
        if (!(await access.visible(p.id))) return false
        throw new Unproven(accessUnchecked().data)
      }
      const [self, ...teams] = await grantees()
      let left = PROJECT_NAV.children
      // the teams first and the seat last, as a lead a Viewer kept gives
      // the seat rows that show nothing
      for (const g of [...teams, self]) {
        const rows = await ctx.db
          .query('project_reach')
          .withIndex('by_grantee_root', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('root_id', p.id)
              .eq('kind', 'child')
              .eq('live', true),
          )
          .take(left + 1)
        for (const row of rows) {
          if (left === 0) throw accessUnchecked()
          left -= 1
          const sub = await access.project(row.project_id)
          // parent_id never changes, so a row naming another top-level
          // project's sub-project says nothing of this one
          if (
            sub !== null &&
            sub.org_id === seat.org_id &&
            sub.parent_id === p.id &&
            sub.archived_at === undefined &&
            (await access.visible(sub.id))
          )
            return true
        }
      }
      return false
    })
  return { seat, access, grantees, project: access.project, reached, shows }
}

/* Whether the seat opens `project` for navigation by the module's rule:
 * `{ parent }`, its top-level project or null for a top-level one, when it
 * does, and null when it does not, for a project of another organization,
 * an archived one, one whose parent is missing, archived or outside a
 * meta's tree, and one the seat does not see. A live sub-project the seat
 * sees shows its live parent for navigation (lib/access.ts levelUnder), so
 * the parent it names is one the seat sees. Rejects with accessUnchecked
 * where a check stopped. */
async function opened(
  sight: SeatSight,
  project: Doc<'projects'>,
): Promise<{ parent: Doc<'projects'> | null } | null> {
  if (project.org_id !== sight.seat.org_id || project.archived_at !== undefined) return null
  if (project.parent_id === undefined) return (await sight.shows(project)) ? { parent: null } : null
  const parent = await sight.project(project.parent_id)
  if (
    parent === null ||
    parent.org_id !== project.org_id ||
    parent.archived_at !== undefined ||
    !inMetaTree(project, parent)
  )
    return null
  return (await sight.access.visible(project.id)) ? { parent } : null
}

/* Whether top-level project `project`, which the seat sees, is one of its
 * favorites by the reader rule, which holds when its row on it (one, as
 * setFavoriteCore keeps it) passes favoriteShows. */
async function starred(
  ctx: QueryCtx,
  sight: FavoriteSight,
  project: Doc<'projects'>,
): Promise<boolean> {
  const row = await favoriteOf(ctx, sight.seat.id, project.id).first()
  return row !== null && (await favoriteShows(sight, row)) !== null
}

/**
 * The project root reach row `row` of one of `sight`'s grantees names, when
 * the seat sees it for navigation, else null: the row holds its project's
 * copies (organization, a root row of the project itself, its name key,
 * live) and the project is a live top-level meta of the seat's organization
 * that the seat sees for navigation (seatSight shows). Rejects with
 * accessUnchecked where a check stopped. restShows asks it for the page and
 * the search, and the Settings project lists (model/projectSettingsLists.ts),
 * which have no favorites group, ask it alone.
 */
export async function rootShows(
  sight: SeatSight,
  row: Doc<'project_reach'>,
): Promise<Doc<'projects'> | null> {
  const project = await rootRowProject(sight, row)
  return project !== null && (await sight.shows(project)) ? project : null
}

/** The live top-level project root reach row `row` of one of `sight`'s
 * grantees names, when the row holds its copies (rootShows), else null,
 * without asking whether the seat sees it. */
export async function rootRowProject(
  sight: Pick<SeatSight, 'seat' | 'project'>,
  row: Doc<'project_reach'>,
): Promise<Doc<'projects'> | null> {
  const { seat } = sight
  if (row.org_id !== seat.org_id || row.kind !== 'root' || row.root_id !== row.project_id)
    return null
  if (!row.live) return null
  const project = await sight.project(row.project_id)
  if (project === null || project.id !== row.project_id || project.org_id !== row.org_id)
    return null
  if (project.parent_id !== undefined || project.archived_at !== undefined) return null
  return row.name_key === nameKey(project.name) ? project : null
}

/**
 * The project root reach row `row` of one of `sight`'s grantees names, when
 * it belongs in the list of the rest of the page or of the search, else
 * null: it shows (rootShows), and it is not one of the seat's favorites by
 * the reader rule, which list it first. Rejects with accessUnchecked where
 * a check stopped. navSearchOf asks it too.
 */
export async function restShows(
  ctx: QueryCtx,
  sight: SeatSight,
  row: Doc<'project_reach'>,
): Promise<Doc<'projects'> | null> {
  const project = await rootShows(sight, row)
  if (project === null) return null
  // the seat's grantee holds this row on the project, so the verdict's
  // reach lookup is answered
  const held: FavoriteSight = { ...sight, reached: async () => true }
  return (await starred(ctx, held, project)) ? null : project
}

/* ------------------------------------------------------------- the reads */

/* The rows a page merges: a seat's favorites and the root reach rows of
 * its grantees. */
type PageRow = Doc<'project_favorites'> | Doc<'project_reach'>

/* Whether `row` is a reach row rather than a favorites row. */
const isReach = (row: PageRow): row is Doc<'project_reach'> => 'grantee_kind' in row

/**
 * projectNav.page for the login whose active seats are `myProfiles` (by
 * organization): one batch of the top-level projects the person sees for
 * navigation across every seat, the favorites of every seat first and then
 * the rest of every seat, each group in name key order with the project id
 * breaking ties, the seats' rows blended in that one order and told apart
 * by `org_id`.
 *
 * It answers `not_ready` when any seat's organization lacks its reach rows
 * or name keys (navReady), and the access_unchecked refusal whole when any
 * check stopped, a seat in more than PROJECT_NAV.teams teams included. A
 * login without a seat gets an empty last batch. The favorites stream of a
 * seat reads its live rows (favoritesIndex), and the rest stream the live
 * root reach rows of the seat and its teams (rootIndex), merged with their
 * ties collapsed; a project already kept in the batch is left out, so it
 * shows once. Every row is judged by favoriteShows or restShows, and the
 * batch settles its read guard after each, so the access checks' reads
 * count in NAMED_READ.
 */
export async function navPageOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavCursorArgs,
): Promise<NavPage> {
  const ask = await openAsk(PAGE_LIST, [], a, NOT_PAGE_CURSOR, seatTieOf)
  const ceiling = await namedCeiling(ctx)
  const seats = [...myProfiles.values()].sort((x, y) =>
    x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0,
  )
  for (const seat of seats) if (!(await navReady(ctx, seat.org_id))) return { state: 'not_ready' }
  try {
    const sights = new Map<string, SeatSight>()
    const streams: ((reads: NamedReads) => NamedStream<PageRow>)[] = []
    const rests: ((reads: NamedReads) => NamedStream<PageRow>)[] = []
    for (const seat of seats) {
      const sight = seatSight(ctx, seat, true)
      sights.set(seat.org_id, sight)
      streams.push(indexAfter(inGroup(favoritesIndex(ctx, seat), FAVORITES), ask.after))
      const grantees = await sight.grantees()
      rests.push((reads) =>
        mergeNamed(
          grantees.map((g) =>
            indexAfter(inGroup(rootIndex(ctx, g, seat.org_id), REST), ask.after)(reads),
          ),
          { ties: 'first', reads },
        ),
      )
    }
    const kept = new Set<string>()
    const keep = async (row: PageRow, guard: ReadGuard, at: NamedAt) => {
      // the seat whose stream holds the row, by its organization in the tie
      const sight = sights.get(String(at.tie[1]))
      if (sight === undefined || kept.has(row.project_id)) return null
      const reach = isReach(row)
      const project = reach ? await restShows(ctx, sight, row) : await favoriteShows(sight, row)
      await guard.settle()
      if (project === null || kept.has(project.id)) return null
      kept.add(project.id)
      return { ...navProject(project), favorite: !reach }
    }
    const batch = await listBatch(ctx, ask, {
      stream: (reads) => mergeNamed<PageRow>([...streams, ...rests].map((stream) => stream(reads))),
      keep,
      limit: LIST_BATCH,
      ceiling,
    })
    return { state: 'ok', ...batch }
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/** What projectNav.children is asked for: the project and the cursors. */
export type NavChildrenArgs = NavCursorArgs & { project_id: string }

/** A children list's cursors opened, with the list's name and scope that
 * seal the next one (lib/namedPages.ts BatchAsk), positions tied by the
 * sub-project id. */
export type ChildrenAsk = BatchAsk & {
  after: NamedAt<IdTie> | null
  through: NamedAt<IdTie> | null
}

/**
 * projectNav.children for the login whose active seats are `myProfiles`:
 * one batch of the live sub-projects of top-level project `project_id` the
 * person sees, in name key order with the id breaking ties, judged with
 * their seat in the project's organization.
 *
 * Any project the seat does not open answers `{ state: 'unavailable' }`
 * alike: an unknown id, one of an organization without the caller's seat,
 * one in Deleted items, an archived one, one outside a meta's tree, one
 * under an archived parent and one the seat does not see (opened). A check
 * a bound stopped answers the access_unchecked refusal. A sub-project the
 * seat sees answers an empty last batch, since it has no sub-projects. Then
 * `not_ready` without the organization's reach rows and name keys, also for
 * a parent the seat sees for no reason of its own that lib/access.ts
 * visible shows before the reach rows are complete, which only those rows
 * can tell apart from one shown through an archived sub-project (seatSight
 * shows); one visible does not show answers unavailable as above.
 *
 * Where the seat sees the project for a reason of its own (accessible),
 * every live sub-project inherits that level, so the batch reads the
 * project's live sub-projects (subProjectIndex). Otherwise it reads only
 * the live child reach rows of the seat and its teams under it
 * (childIndex), merged with their ties collapsed, so it reads no row of a
 * sub-project the seat cannot see. Both order alike, so a batch that
 * follows a cursor across a change of access reads on in the same order.
 * Each sub-project must be live, of the seat's organization, with the
 * project as its parent and, from a reach row, the row's copies, and pass
 * lib/access.ts visible.
 *
 * `asked` is the cursors of another list that answers through these
 * rules, opened by its caller, whose list name and scope then seal the
 * next cursor, so a cursor of projectNav.children never opens there and
 * none of that list opens here. Settings' list of a project's sub-projects
 * (model/projectSettingsLists.ts) passes its own.
 */
export async function navChildrenOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavChildrenArgs,
  asked?: ChildrenAsk,
): Promise<NavChildren> {
  const ask =
    asked ?? (await openAsk(CHILDREN_LIST, [a.project_id], a, NOT_CHILDREN_CURSOR, idTieOf))
  const ceiling = await namedCeiling(ctx)
  const project = await byId(ctx, 'projects', a.project_id)
  const seat = project === null ? undefined : myProfiles.get(project.org_id)
  if (project === null || seat === undefined) return UNAVAILABLE
  try {
    const ready = await readyRow(ctx, seat.org_id)
    const reach = ready?.nav_at !== undefined
    const sight = seatSight(ctx, seat, reach, [project])
    const open = await opened(sight, project)
    if (open === null) return UNAVAILABLE
    if (open.parent !== null) return { state: 'ok', rows: [], next: null, stopped: false }
    if (!reach || ready?.name_keys_at === undefined) return { state: 'not_ready' }
    const own = await sight.access.accessible(project.id)
    const grantees = own ? [] : await sight.grantees()
    const stream = (reads: NamedReads): NamedStream<Doc<'projects'> | Doc<'project_reach'>> =>
      own
        ? indexAfter(subProjectIndex(ctx, project), ask.after)(reads)
        : mergeNamed(
            grantees.map((g) => indexAfter(childIndex(ctx, g, project.id), ask.after)(reads)),
            { ties: 'first', reads },
          )
    const kept = new Set<string>()
    const keep = async (
      row: Doc<'projects'> | Doc<'project_reach'>,
      guard: ReadGuard,
    ): Promise<NavChildRow | null> => {
      const sub = 'grantee_kind' in row ? await rowProject(sight, project, row) : row
      if (sub === null || kept.has(sub.id)) return null
      if (sub.org_id !== seat.org_id || sub.parent_id !== project.id) return null
      if (sub.archived_at !== undefined) return null
      sight.access.seen(sub)
      const sees = await sight.access.visible(sub.id)
      await guard.settle()
      if (!sees) return null
      kept.add(sub.id)
      return { ...navProject(sub), parent_id: project.id }
    }
    const batch = await listBatch(ctx, ask, { stream, keep, limit: LIST_BATCH, ceiling })
    return { state: 'ok', ...batch }
  } catch (e) {
    // a parent the seat may see for navigation, which the reach rows decide
    if (e instanceof Unproven) return { state: 'not_ready' }
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/* The sub-project the live child reach row `row` under `parent` names, when
 * the row holds its copies (organization, a child row under `parent`, name
 * key, live), else null. */
async function rowProject(
  sight: SeatSight,
  parent: Doc<'projects'>,
  row: Doc<'project_reach'>,
): Promise<Doc<'projects'> | null> {
  if (row.org_id !== sight.seat.org_id || row.kind !== 'child' || row.root_id !== parent.id)
    return null
  if (!row.live) return null
  const sub = await sight.project(row.project_id)
  if (sub === null || sub.id !== row.project_id || row.name_key !== nameKey(sub.name)) return null
  return sub
}

/** What projectNav.resolve is asked for: `project_id` alone, or `org_id`
 * with `num`, the project's number in its organization, the address form
 * (src/lib/router.ts). */
export type NavResolveArgs = { project_id?: string; org_id?: string; num?: number }

/** The refusal of any other form of resolve's arguments. */
export const RESOLVE_FORM =
  'resolve takes project_id alone, or org_id with num, a whole number of at least 1'

/**
 * projectNav.resolve for the login whose active seats are `myProfiles`:
 * whether one project is open to the person for navigation, with its
 * parent and, for a top-level project, its favorite state by the reader
 * rule. Refuses with badRequest, before it reads anything, every form but
 * `project_id` alone and `org_id` with `num`, a whole number of at least 1.
 *
 * It reads the project by id, or by its number (projects by_org_num, which
 * the organization's counter keeps unique, so a second row throws rather
 * than choose one), and judges it with the person's seat in its
 * organization (opened), reading no list. Any project the seat does not
 * open answers `{ state: 'unavailable' }` alike, an organization without
 * the caller's seat included, also by number, so an answer tells nothing
 * of a project the person cannot see. A check a bound stopped answers the
 * access_unchecked refusal with its sentence instead, so startup never
 * reads an unfinished check as a loss. That refusal needs a person past
 * the bounds of their own rows (OWN_READS, PROJECT_NAV), and there it can
 * tell a hidden project's number from a free one, which a check that may
 * not answer no access cannot avoid. It needs no stamp of the
 * organization. Without complete reach rows a top-level project the seat
 * sees for a reason of its own still resolves, and one it would see only
 * for navigation answers the refusal or unavailable (seatSight shows).
 */
export async function navResolveOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavResolveArgs,
): Promise<NavResolve> {
  const byNumber = a.org_id !== undefined || a.num !== undefined
  if (a.project_id !== undefined ? byNumber : !wholeNumber(a.num) || a.org_id === undefined)
    throw badRequest(RESOLVE_FORM)
  let project: Doc<'projects'> | null = null
  let seat: Doc<'profiles'> | undefined
  if (a.project_id !== undefined) {
    project = await byId(ctx, 'projects', a.project_id)
    seat = project === null ? undefined : myProfiles.get(project.org_id)
  } else if (a.org_id !== undefined && a.num !== undefined) {
    const { org_id, num } = a
    seat = myProfiles.get(org_id)
    if (seat !== undefined)
      project = await ctx.db
        .query('projects')
        .withIndex('by_org_num', (q) => q.eq('org_id', org_id).eq('num', num))
        .unique()
  }
  if (project === null || seat === undefined) return UNAVAILABLE
  try {
    const ready = await readyRow(ctx, seat.org_id)
    const sight = seatSight(ctx, seat, ready?.nav_at !== undefined, [project])
    const open = await opened(sight, project)
    if (open === null) return UNAVAILABLE
    const favorite = open.parent === null ? await starred(ctx, sight, project) : null
    return {
      state: 'ok',
      project: {
        ...navProject(project),
        parent: open.parent === null ? null : navProject(open.parent),
        favorite,
      },
    }
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/* Whether `n` is a whole number of at least 1. */
const wholeNumber = (n: number | undefined): n is number =>
  n !== undefined && Number.isInteger(n) && n >= 1

/* ------------------------------------------------------------ the search */

/** A row of projectNav.search, a top-level project with its favorite
 * state and no parent, or a sub-project with its parent and no favorite
 * state, as projectNav.resolve answers one project. */
export type NavSearchRow = NavProject & {
  /** the top-level project above a sub-project, null for a top-level one */
  parent: NavProject | null
  /** a top-level project's favorite state, null for a sub-project */
  favorite: boolean | null
}

/** What projectNav.search answers. Its unavailable answer always carries
 * access_unchecked, as the search names no project. */
export type NavSearch = NavBatch<NavSearchRow> | NavRefusal

/** What projectNav.search is asked for: the search, the organization to
 * search in (every seat without it) and the cursors. */
export type NavSearchArgs = NavCursorArgs & { search: string; org_id?: string }

/** The search's list name, which seals its cursors with the login, the
 * organization asked for ('' for every seat) and the normalized search. */
export const SEARCH_LIST = 'projectNav.search'

/** The refusal of a search whose name key is empty, one of spaces and
 * accents only. */
export const BLANK_SEARCH =
  'search must hold a character besides spaces and accents; browse with projectNav.page'

/** The refusal of an empty org_id. */
export const EMPTY_ORG = 'org_id must name an organization, or be left out to search every seat'

const NOT_SEARCH_CURSOR =
  'after and through must be cursors from an earlier answer of projectNav.search for the same login, search and organization; start again from the first batch'

/* The rows of one seat's list of the rest (restCandidates): its
 * sub-projects' documents and its grantees' child and root reach rows. */
type RestRow = Doc<'projects'> | Doc<'project_reach'>

/* The rows the search merges: a seat's favorites and its rest. */
type SearchRow = Doc<'project_favorites'> | RestRow

/**
 * The candidates of one seat's list of the rest across its projects and
 * sub-projects in name order (projectNav.search), each stream past `after`
 * (lib/namedPages.ts indexAfter), with every key marked `mark` when given
 * (inGroup), in the order a merge with `ties: 'first'` must take them: the
 * live sub-projects of each top-level project in `own`
 * (seatSubProjectIndex), which must be projects the seat sees for a
 * reason of its own, then each grantee's live child reach rows
 * (childListIndex), then each grantee's live root reach rows (rootIndex),
 * every position tied with the seat's organization. A sub-project's
 * document and a child row of it share a position, as do the rows of the
 * seat and of its teams on one project, and the merge hands out the first
 * stream's row, so a sub-project of `own` comes as its document, which
 * needs no copies check. Usable without a group mark by a list of one
 * group.
 */
export function restCandidates(
  ctx: QueryCtx,
  seat: Pick<Doc<'profiles'>, 'org_id'>,
  grantees: readonly Grantee[],
  own: readonly Pick<Doc<'projects'>, 'id' | 'org_id'>[],
  after: NamedAt<SeatTie> | null,
  mark?: string,
): ((reads: NamedReads) => NamedStream<RestRow>)[] {
  const grouped = <Row>(index: NamedIndex<Row, SeatTie>) =>
    mark === undefined ? index : inGroup(index, mark)
  return [
    ...own.map((p) => indexAfter(grouped(seatSubProjectIndex(ctx, p, seat.org_id)), after)),
    ...grantees.map((g) => indexAfter(grouped(childListIndex(ctx, g, seat.org_id)), after)),
    ...grantees.map((g) => indexAfter(grouped(rootIndex(ctx, g, seat.org_id)), after)),
  ]
}

/**
 * The sub-project the live child reach row `row` of one of `sight`'s
 * grantees names, with its top-level project, when the row holds the
 * sub-project's copies and the seat opens it for navigation, else null.
 * The row must be a child row of the seat's organization, live, with the
 * sub-project's name key (nameKey of its name) and with the sub-project's
 * parent as its root_id, which never changes. Then opened reads the parent
 * once, checks it live and in a meta's tree, and asks visible of the
 * sub-project, so the parent it names is one the seat sees for
 * navigation. Rejects with accessUnchecked where a check stopped. The
 * search reads child rows across top-level projects with it; children
 * reads them under one parent (rowProject).
 */
export async function childRowShows(
  sight: SeatSight,
  row: Doc<'project_reach'>,
): Promise<{ project: Doc<'projects'>; parent: Doc<'projects'> } | null> {
  if (row.org_id !== sight.seat.org_id || row.kind !== 'child' || !row.live) return null
  const sub = await sight.project(row.project_id)
  if (sub === null || sub.id !== row.project_id || sub.org_id !== row.org_id) return null
  if (sub.parent_id !== row.root_id || row.name_key !== nameKey(sub.name)) return null
  const open = await opened(sight, sub)
  return open?.parent ? { project: sub, parent: open.parent } : null
}

/** Whether `sub`, read from the live sub-projects of `parent`, a top-level
 * project the seat sees for a reason of its own, shows for navigation. It
 * does when it is live, of the seat's organization and under `parent` in
 * its meta's tree, when its stored name key is nameKey of its name, so it
 * sits where a child row of it would and the search matched its name, and
 * when the seat sees it (visible), which it inherits from `parent`. The
 * Settings search (model/projectSettingsLists.ts) asks it too. */
export async function inheritedShows(
  sight: SeatSight,
  parent: Doc<'projects'>,
  sub: Doc<'projects'>,
): Promise<boolean> {
  if (sub.org_id !== sight.seat.org_id || sub.archived_at !== undefined) return false
  if (sub.parent_id !== parent.id || !inMetaTree(sub, parent)) return false
  if (sub.name_key !== nameKey(sub.name)) return false
  sight.access.seen(sub)
  return await sight.access.visible(sub.id)
}

/**
 * The top-level projects of each seat whose sub-projects the search reads,
 * by the seat's organization. Each is a live top-level meta of the seat's
 * organization that a live root reach row of the seat or of one of its
 * teams records a source on (on_root) and that the seat sees for a reason
 * of its own (accessible), and each is read once. It reads every live root
 * row of every seat's grantees first, at most PROJECT_NAV.rootRows in all,
 * counts the distinct projects those rows record a source on, at most
 * PROJECT_NAV.roots across the seats, and only then reads and asks about
 * each, so past either bound it rejects with accessUnchecked before it
 * reads a project. A row on a project the seat does not see for a reason
 * of its own, a Viewer's lead or a stale row, opens none of its
 * sub-projects. It still costs every call that project's read and
 * accessible check, which, for a role that receives team access, can read
 * the project's team shares, at most OWN_READS.projectShares + 1, and look
 * up the person's membership in each share's team, so how far a call's
 * budget goes depends, within that bound, on a project the seat does not
 * see, as the page's check of such a root row does when a batch reaches it.
 * The Settings search and Archived projects of a seat that is not an
 * organization admin (model/projectSettingsLists.ts) read the same
 * projects through it.
 */
export async function ownRoots(
  ctx: QueryCtx,
  sights: readonly SeatSight[],
): Promise<Map<string, Doc<'projects'>[]>> {
  let rowsLeft = PROJECT_NAV.rootRows
  let named = 0
  const sources = new Map<SeatSight, Set<string>>()
  for (const sight of sights) {
    const ids = new Set<string>()
    for (const g of await sight.grantees()) {
      const rows = await ctx.db
        .query('project_reach')
        .withIndex('by_grantee_list', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('kind', 'root')
            .eq('live', true),
        )
        .take(rowsLeft + 1)
      if (rows.length > rowsLeft) throw accessUnchecked()
      rowsLeft -= rows.length
      for (const row of rows)
        if (row.on_root && row.org_id === sight.seat.org_id && row.root_id === row.project_id)
          ids.add(row.project_id)
    }
    named += ids.size
    if (named > PROJECT_NAV.roots) throw accessUnchecked()
    sources.set(sight, ids)
  }
  const own = new Map<string, Doc<'projects'>[]>()
  for (const [sight, ids] of sources) {
    const mine: Doc<'projects'>[] = []
    for (const id of ids) {
      const p = await sight.project(id)
      if (p === null || p.id !== id || p.org_id !== sight.seat.org_id) continue
      if (p.archived_at !== undefined || !inMetaTree(p, p)) continue
      if (await sight.access.accessible(p.id)) mine.push(p)
    }
    own.set(sight.seat.org_id, mine)
  }
  return own
}

/**
 * projectNav.search for login `login`, whose active seats are `myProfiles`
 * (by organization): one batch of the projects and sub-projects the person
 * sees for navigation whose own name holds every word of `a.search`,
 * across every seat, or only the seat in `a.org_id` when given. The
 * matching favorites of every seat come first, then every other match,
 * top-level projects and sub-projects together, each group in name key
 * order with the project id and then the organization breaking ties, the
 * order applied across the whole permitted list before the batch is cut.
 *
 * Matching. It matches lib/search.ts allWordsMatcher of nameKey(a.search)
 * against the name key a row copies or stores, before any other read of
 * the row, so every word of the search must be in the name, in any order
 * and anywhere, ignoring case and accents, as Settings' lists match. A row that shows holds its
 * project's own key, so the match is exact for it. A parent's name never
 * makes its sub-projects match, and the organization's name matches
 * nothing.
 *
 * Refuses, before it reads anything, a search past LIMITS.search with that
 * limit's sentence, one whose name key is empty with badRequest
 * (BLANK_SEARCH), an empty org_id (EMPTY_ORG), and an `after` or `through`
 * that is not a cursor of this list for the same login, organization and
 * search, or a `through` not after `after`, with badRequest. An org_id
 * without the caller's seat answers an empty last batch. Then it answers
 * `not_ready` when a searched seat's organization lacks its reach rows or
 * name keys (navReady), and the access_unchecked refusal whole where any
 * check or bound stopped (ownRoots, PROJECT_NAV.teams, OWN_READS).
 *
 * The candidates of a seat: its live favorites (favoritesIndex) in the
 * first group, and in the second, merged with their ties collapsed
 * (restCandidates), the live sub-projects of each top-level project the
 * seat sees for a reason of its own (ownRoots), the live child reach rows
 * of the seat and its teams, and their live root reach rows. A favorites
 * row shows by favoriteShows, a root row by restShows, a child row by
 * childRowShows and a sub-project's document by inheritedShows, and the
 * batch settles its read guard after each row the search matched, so the
 * checks' reads count in NAMED_READ. A project already kept in the batch is
 * left out, so it shows once.
 */
export async function navSearchOf(
  ctx: QueryCtx,
  login: string,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavSearchArgs,
): Promise<NavSearch> {
  const term = nameKey(limitedText(LIMITS.search, a.search))
  if (term === '') throw badRequest(BLANK_SEARCH)
  if (a.org_id === '') throw badRequest(EMPTY_ORG)
  const scope = [login, a.org_id ?? '', term]
  const ask = await openAsk(SEARCH_LIST, scope, a, NOT_SEARCH_CURSOR, seatTieOf)
  const ceiling = await namedCeiling(ctx)
  const seats = [...myProfiles.values()]
    .filter((seat) => a.org_id === undefined || seat.org_id === a.org_id)
    .sort((x, y) => (x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0))
  for (const seat of seats) if (!(await navReady(ctx, seat.org_id))) return { state: 'not_ready' }
  const matches = allWordsMatcher(term)
  try {
    const sights = new Map<string, SeatSight>()
    for (const seat of seats) sights.set(seat.org_id, seatSight(ctx, seat, true))
    const own = await ownRoots(ctx, [...sights.values()])
    const parents = new Map<string, Doc<'projects'>>()
    const streams: ((reads: NamedReads) => NamedStream<SearchRow>)[] = []
    const rests: ((reads: NamedReads) => NamedStream<SearchRow>)[] = []
    for (const [orgId, sight] of sights) {
      const mine = own.get(orgId) ?? []
      for (const p of mine) parents.set(p.id, p)
      streams.push(indexAfter(inGroup(favoritesIndex(ctx, sight.seat), FAVORITES), ask.after))
      const rest = restCandidates(ctx, sight.seat, await sight.grantees(), mine, ask.after, REST)
      rests.push((reads) =>
        mergeNamed(
          rest.map((stream) => stream(reads)),
          { ties: 'first', reads },
        ),
      )
    }
    const kept = new Set<string>()
    const keep = async (
      row: SearchRow,
      guard: ReadGuard,
      at: NamedAt,
    ): Promise<NavSearchRow | null> => {
      // the seat whose stream holds the row, by its organization in the tie
      const sight = sights.get(String(at.tie[1]))
      if (sight === undefined || !matches(row.name_key ?? '')) return null
      const shown = await searchShows(ctx, sight, parents, row)
      await guard.settle()
      if (shown === null || kept.has(shown.id)) return null
      kept.add(shown.id)
      return shown
    }
    const batch = await listBatch(ctx, ask, {
      stream: (reads) => mergeNamed<SearchRow>([...streams, ...rests].map((s) => s(reads))),
      keep,
      limit: LIST_BATCH,
      ceiling,
    })
    return { state: 'ok', ...batch }
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/* The search's row for `row`, a candidate of `sight`'s seat whose key
 * matched, when it shows, else null. A favorites row shows by
 * favoriteShows, a root reach row by restShows, a child reach row by
 * childRowShows and a sub-project's document, read under one of `parents`,
 * by inheritedShows. Rejects with accessUnchecked where a check stopped. */
async function searchShows(
  ctx: QueryCtx,
  sight: SeatSight,
  parents: ReadonlyMap<string, Doc<'projects'>>,
  row: SearchRow,
): Promise<NavSearchRow | null> {
  if ('profile_id' in row) {
    const p = await favoriteShows(sight, row)
    return p === null ? null : { ...navProject(p), parent: null, favorite: true }
  }
  if ('grantee_kind' in row) {
    if (row.kind === 'root') {
      const p = await restShows(ctx, sight, row)
      return p === null ? null : { ...navProject(p), parent: null, favorite: false }
    }
    const shown = await childRowShows(sight, row)
    if (shown === null) return null
    return { ...navProject(shown.project), parent: navProject(shown.parent), favorite: null }
  }
  const parent = row.parent_id === undefined ? undefined : parents.get(row.parent_id)
  if (parent === undefined || !(await inheritedShows(sight, parent, row))) return null
  return { ...navProject(row), parent: navProject(parent), favorite: null }
}
