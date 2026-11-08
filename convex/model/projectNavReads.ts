/* The reads of project navigation (projectNav.ts): a person's top-level
 * projects across every seat of their login, the favorites of every seat
 * first and then the rest of every seat, or of one seat, or a team's own
 * shares (navPageOf and navTeamOf, projectNav.page); the sub-projects a
 * person may add tasks to (navTargetsOf, projectNav.targets); whether they
 * see any project and any sub-project (navHoldsOf, projectNav.holds); up
 * to 100 projects by id with the caller's level (navByIdsOf,
 * projectNav.byIds); one
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
 * navChildrenOf, with cursors of their own and no favorites group. REST
 * GET /v1/projects and MCP list_projects (machine/projects.ts projectPage)
 * read the same rows in key order instead (rootKeyIndex, childKeyIndex and
 * subKeyIndex), with seatSight's access and grantees and a rule of their
 * own for a top-level project, lib/access.ts visible, which also lists one
 * seen only through an archived sub-project.
 *
 * Who sees what. Every candidate is judged by ordinary access, lib/access.ts
 * accessOf of the seat, so an organization admin's lists hold only the
 * projects their own leads, grants and team shares reach, as anyone's. A
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
  receivesTeamAccess,
} from '../lib/access'
import { byId } from '../lib/db'
import type { AccessLevel, ArchiveState } from '../lib/enums'
import { badRequest, type Refusal } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { BY_IDS_MAX, LIMITS, LIST_BATCH } from '../lib/limits'
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
  readGuard,
  STOPPED,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { resolveReviewHours } from '../lib/review'
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
 * access_unchecked, as the page names no project. With `team_id` its rows
 * are the team's shares, top-level projects and sub-projects together,
 * each with `parent_id` (null for a top-level project) and `favorite`
 * false. */
export type NavPage = NavBatch<NavPageRow & { parent_id?: string | null }> | NavRefusal

/** What projectNav.page is asked for beside its cursors: `org_id`, the one
 * seat to list, and with it `team_id`, a team of that organization whose
 * own shares it lists. */
export type NavPageArgs = NavCursorArgs & { org_id?: string; team_id?: string }

/** The team list's name, which seals its cursors with the organization and
 * the team. */
export const TEAM_LIST = 'projectNav.page.team'

/** The refusal of a team_id without the org_id of its organization. */
export const TEAM_WITHOUT_ORG = 'team_id needs org_id, the organization of the team'

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

const NOT_TEAM_CURSOR =
  'after and through must be cursors from an earlier answer of projectNav.page for the same organization and team; start again from the first batch'

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

/* A team list position's tie, the project id and the organization, or null
 * for any other shape. */
const teamTieOf = ({ tie }: NamedAt): SeatTie | null => {
  const [projectId, orgId] = tie
  return tie.length === 2 && typeof projectId === 'string' && typeof orgId === 'string'
    ? [projectId, orgId]
    : null
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

/** The root reach rows of grantee `g` of one live state in key order
 * (project_reach by_grantee_key, kind root): the copied key, then the
 * project id. REST GET /v1/projects and MCP list_projects read them for
 * the top-level projects a caller reaches (machine/projects.ts
 * projectPage), the live ones for active projects and both for archived
 * ones. */
export function rootKeyIndex(
  ctx: QueryCtx,
  g: Grantee,
  live: boolean,
): NamedIndex<Doc<'project_reach'>, IdTie> {
  const rows = () =>
    ctx.db
      .query('project_reach')
      .withIndex('by_grantee_key', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('kind', 'root')
          .eq('live', live),
      )
  return {
    all: rows,
    after: ({ key, tie: [id] }) => [
      () =>
        ctx.db
          .query('project_reach')
          .withIndex('by_grantee_key', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('kind', 'root')
              .eq('live', live)
              .eq('key', key)
              .gt('project_id', id),
          ),
      () =>
        ctx.db
          .query('project_reach')
          .withIndex('by_grantee_key', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('kind', 'root')
              .eq('live', live)
              .gt('key', key),
          ),
    ],
    at: (row) => ({ key: row.key, tie: [row.project_id] }),
  }
}

/** The child reach rows of grantee `g` under top-level project `rootId` of
 * one live state in key order (project_reach by_grantee_root_key): the
 * copied key, then the sub-project id, for the same lists as
 * rootKeyIndex. */
export function childKeyIndex(
  ctx: QueryCtx,
  g: Grantee,
  rootId: string,
  live: boolean,
): NamedIndex<Doc<'project_reach'>, IdTie> {
  const rows = () =>
    ctx.db
      .query('project_reach')
      .withIndex('by_grantee_root_key', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('root_id', rootId)
          .eq('kind', 'child')
          .eq('live', live),
      )
  return {
    all: rows,
    after: ({ key, tie: [id] }) => [
      () =>
        ctx.db
          .query('project_reach')
          .withIndex('by_grantee_root_key', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('root_id', rootId)
              .eq('kind', 'child')
              .eq('live', live)
              .eq('key', key)
              .gt('project_id', id),
          ),
      () =>
        ctx.db
          .query('project_reach')
          .withIndex('by_grantee_root_key', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('root_id', rootId)
              .eq('kind', 'child')
              .eq('live', live)
              .gt('key', key),
          ),
    ],
    at: (row) => ({ key: row.key, tie: [row.project_id] }),
  }
}

/** The sub-projects of top-level project `parent` of one archive state in
 * key order (projects by_org_parent_state_key): key, then id, for the same
 * lists as rootKeyIndex, where the caller sees `parent` for a reason of
 * their own and so every sub-project of it. */
export function subKeyIndex(
  ctx: QueryCtx,
  parent: Pick<Doc<'projects'>, 'id' | 'org_id'>,
  state: ArchiveState,
): NamedIndex<Doc<'projects'>, IdTie> {
  const projects = () =>
    ctx.db
      .query('projects')
      .withIndex('by_org_parent_state_key', (q) =>
        q.eq('org_id', parent.org_id).eq('parent_id', parent.id).eq('archive_state', state),
      )
  return {
    all: projects,
    after: ({ key, tie: [id] }) => [
      () =>
        ctx.db
          .query('projects')
          .withIndex('by_org_parent_state_key', (q) =>
            q
              .eq('org_id', parent.org_id)
              .eq('parent_id', parent.id)
              .eq('archive_state', state)
              .eq('key', key)
              .gt('id', id),
          ),
      () =>
        ctx.db
          .query('projects')
          .withIndex('by_org_parent_state_key', (q) =>
            q
              .eq('org_id', parent.org_id)
              .eq('parent_id', parent.id)
              .eq('archive_state', state)
              .gt('key', key),
          ),
    ],
    at: (p) => ({ key: p.key, tie: [p.id] }),
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
  /** lib/access.ts accessOf of the seat, for every check */
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
  const access = accessOf(ctx, seat, read)
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
  a: NavPageArgs,
): Promise<NavPage> {
  if (a.team_id !== undefined) return await navTeamOf(ctx, myProfiles, a)
  // the page of every seat seals its cursors with an empty scope, and the
  // page of one organization with that organization
  const scope = a.org_id === undefined ? [] : [a.org_id]
  const ask = await openAsk(PAGE_LIST, scope, a, NOT_PAGE_CURSOR, seatTieOf)
  const ceiling = await namedCeiling(ctx)
  const seats = [...myProfiles.values()]
    .filter((seat) => a.org_id === undefined || seat.org_id === a.org_id)
    .sort((x, y) => (x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0))
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

/* ------------------------------------------------------------ by id */

/** A row of projectNav.byIds: a project the caller opens for navigation,
 * with its top-level project's id (null for a top-level one), the caller's
 * level on it, whether its tasks track delay, its own lead (`lead_id`,
 * which the Board's lane heads and the Overview's Lead read through the
 * store's project cache) and the time a task gets on entering Review in it
 * (`review_hours`: its own, else its parent's, else DEFAULT_REVIEW_HOURS,
 * lib/review.ts resolveReviewHours, for the views' Review paint of a
 * project the workspace does not hold, store/planner.ts
 * reviewHoursForProject). A reader of the project's Settings page reads the
 * same lead and Review time (model/projectSettings.ts settingsGate). */
export type NavByIdRow = NavProject & {
  parent_id: string | null
  level: AccessLevel
  track_delay: boolean
  lead_id: string | null
  review_hours: number
}

/** What projectNav.byIds answers: the rows of the projects asked that the
 * caller opens, with the top-level project of each such sub-project, each
 * project once; the asked ids whose check a bound stopped (`unchecked`),
 * never left out as no access; and the refusal's sentence for them,
 * `message`, null when `unchecked` is empty. */
export type NavByIds = { rows: NavByIdRow[]; unchecked: string[]; message: string | null }

/** The refusal of a byIds call that names more projects than it answers. */
export const BY_IDS_LIMIT = `ids must name at most ${BY_IDS_MAX} projects`

/**
 * projectNav.byIds for the login whose active seats are `myProfiles`: the
 * projects of `ids` the person opens for navigation, each with the
 * caller's level on it, and the top-level project of every sub-project it
 * answers as a row of its own. The project cache (src/store/projectCache.ts)
 * reads it for the projects the open views name.
 *
 * It refuses more than BY_IDS_MAX (100) ids on the raw length, repeats
 * included, with badRequest before it reads any project, as people.byIds
 * and labels.byIds do. It reads each distinct id once (byId) and judges each
 * project with the person's seat in its own organization
 * (`myProfiles.get(project.org_id)`), one seatSight a seat a call, so the
 * checks of one call share one access instance and its bounds. An id is
 * answered when the seat opens its project for navigation (opened): a live
 * project of that organization in a meta's tree, a top-level one the seat
 * sees for a reason of its own or through a live sub-project it sees, a
 * sub-project the seat sees under a live parent. An unknown id, a project in
 * Deleted items, an archived project, one under an archived parent, one of
 * an organization without the caller's seat, one the seat does not see and
 * a top-level project seen only through an archived sub-project are left
 * out alike, so an answer tells nothing of a project the person cannot open.
 * The last of these lib/access.ts counts for navigation and the workspace's
 * projects part sends; byIds leaves it out as the directory, the sidebar
 * and resolve do.
 *
 * Every asked id is judged first, then the parent of each opened
 * sub-project is added whatever its own verdict in the call, so the answer
 * does not depend on the order of the ids, and a row wins over `unchecked`
 * for the same id. A row's level is lib/access.ts level where the seat
 * reaches the project for a reason of its own (accessible), which needs no
 * walk of navigation, and else `viewer`, the level lib/access.ts gives a
 * top-level project seen only for navigation and what resolve already
 * discloses. A level of null where accessible holds cannot arise by the
 * rules; such a row is left out, which fails closed.
 *
 * A check a bound stopped (OWN_READS and PROJECT_NAV, roomSpent included,
 * and Unproven for a top-level project seen only for navigation while the
 * organization's reach rows are not complete) lists the asked id in
 * `unchecked` with the refusal's sentence, and the call goes on with the
 * next id. Where the check of the parent a sub-project brings stops, the
 * sub-project is listed, so `unchecked` names only ids the caller asked
 * for. The call settles against NAMED_READ between ids (namedCeiling), and
 * an id it reaches with no room left is listed the same way, so no call
 * reads past that share; a single check that still passes Convex's limits
 * fails the call, which the cache shows as failed. Any other error throws.
 *
 * It reads no task, no favorite and no list, and needs no readiness stamp
 * except for a top-level project seen only for navigation, which waits for
 * the organization's reach rows. As a live query it reruns on a rename, an
 * archive, a move or an access change of the projects it names, never on
 * a task write.
 *
 * What one call of 100 ids reads at the design size, one figure a case,
 * measured in convex/tests/projectNavByIds.test.ts ("reads at the design
 * size") under Convex's transaction limits, in index ranges and documents
 * as Convex counts them, every answer whole with nothing in `unchecked`:
 * - 100 of 200 sub-projects the person reads through grants under 67
 *   parents, answered with their 34 parents: 303 ranges and 397 documents;
 * - the 67 parents of those 200 sub-projects, each seen only for
 *   navigation, with 33 of the sub-projects: 415 ranges and 608 documents,
 *   the most of any case;
 * - 100 of 200 top-level projects with grants: 234 ranges and 234
 *   documents;
 * - the 100 sub-projects 5 of the person's teams share, 20 each, with
 *   their parents: 211 ranges and 270 documents;
 * - 100 projects each shared with 5 teams, the person in 3 teams reaching
 *   each through one and the other shares from teams of 20 projects each:
 *   182 ranges and 365 documents;
 * - 50 live projects one of the person's teams shares and 50 of its 150
 *   archived shares, which it leaves out: 168 ranges and 335 documents;
 * - 100 projects the person does not see, each with other people's child
 *   reach rows: 266 ranges and 101 documents;
 * - 100 of 167 live parents shown only through 500 archived sub-projects
 *   with grants, all left out: 335 ranges and 134 documents; 100 of those
 *   archived sub-projects: 101 ranges and 101 documents.
 * Every case stays far inside NAMED_READ (2,000 ranges, 8,000 documents),
 * so a chunk of 100 ids answers whole at the design size. Past it a call
 * that reaches the share lists the rest apart; at PROJECT_NAV.teams teams a
 * top-level project seen only for navigation can cost a range a grantee,
 * and the settling between ids keeps such a call inside Convex's limits.
 */
export async function navByIdsOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  ids: readonly string[],
): Promise<NavByIds> {
  if (ids.length > BY_IDS_MAX) throw badRequest(BY_IDS_LIMIT)
  const asked = [...new Set(ids)]
  if (asked.length === 0) return { rows: [], unchecked: [], message: null }
  const guard = readGuard(ctx, await namedCeiling(ctx))
  const found: Doc<'projects'>[] = []
  for (const id of asked) {
    const project = await byId(ctx, 'projects', id)
    if (project !== null && myProfiles.has(project.org_id)) found.push(project)
  }
  const sights = new Map<string, SeatSight>()
  const sightOf = async (seat: Doc<'profiles'>) => {
    let sight = sights.get(seat.org_id)
    if (sight === undefined) {
      const ready = await readyRow(ctx, seat.org_id)
      const read = found.filter((p) => p.org_id === seat.org_id)
      sight = seatSight(ctx, seat, ready?.nav_at !== undefined, read)
      sights.set(seat.org_id, sight)
    }
    return sight
  }
  const rows = new Map<string, NavByIdRow>()
  const unchecked = new Map<string, string>()
  // each opened sub-project with its parent, in the order asked
  const brought: { sub: Doc<'projects'>; parent: Doc<'projects'>; sight: SeatSight }[] = []
  const stop = (id: string, message: string) => {
    if (!rows.has(id)) unchecked.set(id, message)
  }
  for (const project of found) {
    const seat = myProfiles.get(project.org_id)
    if (seat === undefined) continue
    if (!(await guard.settle())) {
      stop(project.id, accessUnchecked().data.message)
      continue
    }
    try {
      const sight = await sightOf(seat)
      const open = await opened(sight, project)
      if (open === null) continue
      const row = await byIdRow(sight, project)
      if (row === null) continue
      rows.set(project.id, row)
      if (open.parent !== null) brought.push({ sub: project, parent: open.parent, sight })
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      stop(project.id, e.data.message)
    }
  }
  for (const { sub, parent, sight } of brought) {
    if (rows.has(parent.id)) continue
    const fail = (message: string) => {
      rows.delete(sub.id)
      stop(sub.id, message)
    }
    if (!(await guard.settle())) {
      fail(accessUnchecked().data.message)
      continue
    }
    try {
      const row = await byIdRow(sight, parent)
      if (row === null) {
        // a parent a live sub-project the seat sees shows for navigation;
        // without its row the sub-project is not answered either
        rows.delete(sub.id)
        continue
      }
      rows.set(parent.id, row)
      unchecked.delete(parent.id)
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      fail(e.data.message)
    }
  }
  const out: NavByIdRow[] = []
  const given = new Set<string>()
  const give = (id: string) => {
    const row = rows.get(id)
    if (row === undefined || given.has(id)) return
    given.add(id)
    out.push(row)
  }
  for (const project of found) {
    give(project.id)
    const parent = rows.get(project.id)?.parent_id
    if (parent) give(parent)
  }
  const left = [...unchecked.keys()].filter((id) => !rows.has(id))
  return {
    rows: out,
    unchecked: left,
    message: left.length === 0 ? null : (unchecked.get(left[0]) ?? null),
  }
}

/* The byIds row of `project`, which the seat opens: the caller's level
 * where the seat reaches it for a reason of its own, else `viewer`, or null
 * where that level is null (navByIdsOf). Rejects with accessUnchecked where
 * a check stopped. */
async function byIdRow(sight: SeatSight, project: Doc<'projects'>): Promise<NavByIdRow | null> {
  const level: AccessLevel | null = (await sight.access.accessible(project.id))
    ? await sight.access.level(project.id)
    : 'viewer'
  if (level === null) return null
  // a sub-project's parent, which its check read already
  const parent = project.parent_id === undefined ? null : await sight.project(project.parent_id)
  return {
    ...navProject(project),
    parent_id: project.parent_id ?? null,
    level,
    track_delay: project.track_delay,
    lead_id: project.lead_id ?? null,
    review_hours: resolveReviewHours(project.review_hours, parent?.review_hours),
  }
}

/* --------------------------------------------------------- a team's shares */

/**
 * projectNav.page with `team_id` (navPageOf): one batch of the projects and
 * sub-projects team `team_id` of organization `org_id` holds a share on
 * that the person sees for navigation with their seat there, in name key
 * order with the project id breaking ties, which Team sync's notes read to
 * offer a team meeting's smaller scopes (src/views/teamSync/SyncNote.tsx).
 *
 * Its candidates are the team's own shares: its live root reach rows that
 * record a source on the top-level project (on_root) and its live child
 * rows, each a share on that sub-project (project_reach by_grantee_list),
 * so a top-level project the team only reaches through a share of one of
 * its sub-projects is not listed, and the list says no more than the
 * project's Settings team list says to the same person. Each is judged by
 * `opened` on the shared project itself with the caller's seat, whether or
 * not the caller is in the team; a reach row finds a candidate and grants
 * nothing. A team of another organization, an unknown team and an org_id
 * without the caller's seat answer an empty last batch; a team_id without
 * org_id is a bad_request. Its cursors are sealed with TEAM_LIST, the
 * organization and the team, so a cursor of one list opens only for its
 * own. `not_ready`, `stopped` and the refusal answer as the page's do.
 *
 * At the design size, measured in convex/tests/projectNavPageScope.test.ts
 * under Convex's transaction limits: one team sharing 50 live and 150
 * archived projects, for a caller in another team, 80 ranges and 103
 * documents for the first batch and 82 and 103 for the second. The page
 * with `org_id` alone, 200 live and 300 archived top-level projects of the
 * home organization beside a guest seat: 104 ranges and 77 documents for
 * the first batch and the eighth.
 */
async function navTeamOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavPageArgs,
): Promise<NavPage> {
  const orgId = a.org_id
  const teamId = a.team_id
  if (orgId === undefined || teamId === undefined) throw badRequest(TEAM_WITHOUT_ORG)
  const ask = await openAsk(TEAM_LIST, [orgId, teamId], a, NOT_TEAM_CURSOR, teamTieOf)
  const ceiling = await namedCeiling(ctx)
  const seat = myProfiles.get(orgId)
  const empty: NavPage = { state: 'ok', rows: [], next: null, stopped: false }
  if (seat === undefined) return empty
  const team = await byId(ctx, 'teams', teamId)
  if (team === null || team.org_id !== orgId) return empty
  if (!(await navReady(ctx, orgId))) return { state: 'not_ready' }
  try {
    const sight = seatSight(ctx, seat, true)
    const g = grantee.team(teamId)
    const stream = (reads: NamedReads) =>
      mergeNamed<Doc<'project_reach'>>(
        [
          indexAfter(rootIndex(ctx, g, orgId), ask.after)(reads),
          indexAfter(childListIndex(ctx, g, orgId), ask.after)(reads),
        ],
        { ties: 'first', reads },
      )
    const keep = async (row: Doc<'project_reach'>, guard: ReadGuard) => {
      // a root row for navigation to a sub-project records no share
      if (row.kind === 'root' && !row.on_root) return null
      if (row.org_id !== orgId || !row.live) return null
      const project = await sight.project(row.project_id)
      if (project === null || project.id !== row.project_id) return null
      if (row.name_key !== nameKey(project.name)) return null
      const open = await opened(sight, project)
      await guard.settle()
      if (open === null) return null
      return { ...navProject(project), favorite: false, parent_id: open.parent?.id ?? null }
    }
    const batch = await listBatch(ctx, ask, { stream, keep, limit: LIST_BATCH, ceiling })
    return { state: 'ok', ...batch }
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/* ------------------------------------------------------------ the holds */

/** What projectNav.holds answers: whether the caller sees some live
 * top-level project (`top`) and some live sub-project under a live parent
 * (`sub`) for navigation, `stopped` where the read share ended the walk
 * before both were known, or a refusal, never an unknown read as false. */
export type NavHolds =
  | { state: 'ok'; top: boolean; sub: boolean }
  | { state: 'stopped' }
  | NavRefusal

/**
 * projectNav.holds for the login whose active seats are `myProfiles`, or
 * only the seat in `org_id`: whether the person sees any live top-level
 * project and any live sub-project for navigation, which the "no project"
 * and "no sub-project" notes read and say so only on this confirmed answer
 * (src/components/useHolds.ts).
 *
 * Its candidates are the navigation reads' own: the live root reach rows
 * of each seat and its teams (rootIndex), each judged by rootShows, never a
 * row alone, so a stale row or one of a source the seat lost shows nothing;
 * and under each top-level project that shows, its live sub-projects where
 * the seat sees it for a reason of its own (each inherits that level, so
 * the first is enough), else the live child rows of the seat and its teams
 * under it, each judged by lib/access.ts visible. A grant on a top-level
 * project writes no child row for its sub-projects, so the first path finds
 * them. It stops at the first of each it finds. An org_id without the
 * caller's seat answers both false. `not_ready` until the asked
 * organizations' reach rows and name keys are complete, the
 * access_unchecked refusal where a bound of the caller's own reads stops a
 * check, and `stopped` where NAMED_READ ends the walk, which the app reads
 * as unknown.
 *
 * At the design size, one figure a case, measured in
 * convex/tests/projectNavTargets.test.ts under Convex's transaction
 * limits: 200 live top-level projects with grants and no sub-project, so
 * `sub` walks every root, 833 ranges and 760 documents; 167 live parents
 * seen only through 500 archived sub-projects with grants, both false, 538
 * and 497; a member of 5 teams whose shares are all archived sub-projects,
 * both false, 315 and 182; sub-projects each shared with 5 teams, 19 and
 * 16. Every case answers whole inside NAMED_READ.
 */
export async function navHoldsOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: { org_id?: string },
): Promise<NavHolds> {
  const seats = [...myProfiles.values()].filter(
    (seat) => a.org_id === undefined || seat.org_id === a.org_id,
  )
  for (const seat of seats) if (!(await navReady(ctx, seat.org_id))) return { state: 'not_ready' }
  const guard = readGuard(ctx, await namedCeiling(ctx))
  let top = false
  let sub = false
  try {
    for (const seat of seats) {
      const sight = seatSight(ctx, seat, true)
      const grantees = await sight.grantees()
      const judged = new Set<string>()
      for (const g of grantees) {
        const index = rootIndex(ctx, g, seat.org_id)
        for await (const row of index.all()) {
          if (!(await guard.document(row))) return { state: 'stopped' }
          // each row is judged at its own position, as the page judges it,
          // so a stale row of one grantee never hides a fresh row of
          // another on the same project; the seat's sight keeps each
          // project's verdict, so a repeat costs little
          const project = await rootShows(sight, row)
          if (!(await guard.settle())) return { state: 'stopped' }
          if (project === null || judged.has(project.id)) continue
          judged.add(project.id)
          top = true
          if (!sub) sub = await holdsSub(ctx, sight, grantees, project)
          if (!(await guard.settle())) return { state: 'stopped' }
          if (top && sub) return { state: 'ok', top, sub }
        }
      }
    }
    return { state: 'ok', top, sub }
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

/* Whether the seat of `sight` sees a live sub-project of top-level project
 * `parent`, which it sees for navigation (navHoldsOf). */
async function holdsSub(
  ctx: QueryCtx,
  sight: SeatSight,
  grantees: readonly Grantee[],
  parent: Doc<'projects'>,
): Promise<boolean> {
  if (await sight.access.accessible(parent.id))
    for await (const child of subProjectIndex(ctx, parent).all())
      if (child.archived_at === undefined && child.org_id === parent.org_id) return true
  for (const g of grantees)
    for await (const row of childIndex(ctx, g, parent.id).all()) {
      const child = await rowProject(sight, parent, row)
      if (child === null || child.parent_id !== parent.id || child.archived_at !== undefined)
        continue
      if (await sight.access.visible(child.id)) return true
    }
  return false
}

/* ---------------------------------------------------------- the targets */

/** A row of projectNav.targets: a live sub-project the caller may write in,
 * with its top-level project's id, name and number for the picker's
 * groups. */
export type NavTargetRow = NavProject & {
  parent_id: string
  parent_name: string
  parent_num: number
}

/** What projectNav.targets answers. */
export type NavTargets = NavBatch<NavTargetRow> | NavRefusal

/** What projectNav.targets is asked for: the cursors, the one seat to list
 * (`org_id`) and a search of the sub-project's or its parent's name. */
export type NavTargetsArgs = NavCursorArgs & { org_id?: string; search?: string }

/** The targets list's name, which seals its cursors with the login, the
 * organization asked for and the search's name key. */
export const TARGETS_LIST = 'projectNav.targets'

const NOT_TARGETS_CURSOR =
  'after and through must be cursors from an earlier answer of projectNav.targets for the same organization and search; start again from the first batch'

/* The tie of a target's position: its parent's id, its own name key and
 * id, and its seat's organization. */
type TargetTie = readonly [parent_id: string, child_key: string, child_id: string, org_id: string]

/* A target's position: its parent's name key, then the tie, so the four
 * fields order as fields whatever characters a name holds. */
const targetAt = (
  parent: Pick<Doc<'projects'>, 'id'>,
  parentKey: string,
  childKey: string,
  childId: string,
  orgId: string,
): NamedAt<TargetTie> => ({ key: parentKey, tie: [parent.id, childKey, childId, orgId] })

/* A targets position's tie, or null for any other shape. */
const targetTieOf = ({ tie }: NamedAt): TargetTie | null => {
  if (tie.length !== 4 || tie.some((part) => typeof part !== 'string')) return null
  const [parentId, childKey, childId, orgId] = tie as readonly string[]
  return [parentId, childKey, childId, orgId]
}

/* A target position's parts. */
const targetParts = ({ key, tie: [parentId, childKey, childId, orgId] }: NamedAt<TargetTie>) => ({
  parentKey: key,
  parentId,
  childKey,
  childId,
  orgId,
})

/**
 * projectNav.targets for the login whose active seats are `myProfiles`:
 * one batch of the live sub-projects under a live parent the person may
 * add tasks to, Edit (User) or Lead by lib/access.ts level, across every
 * seat or only the seat in `org_id` (an org_id without the caller's seat
 * answers an empty last batch, as the search does), which the New task
 * dialog, the Move window (src/components/TargetPicker.tsx) and the task
 * window's Link task offer read.
 *
 * The order is the parent's name key, the parent's id, the sub-project's
 * name key and its id, the positions of page and children joined: the
 * candidates are the page's walk without its favorites group (each seat's
 * and its teams' live root reach rows, judged by rootShows), and under each
 * parent that shows, children's walk (its live sub-projects where the seat
 * sees the parent for a reason of its own, else the live child rows of the
 * seat and its teams under it), each judged by `opened` and then by its
 * level, a read-only one skipped before the batch is cut, so a batch is
 * never short of a row a later one would hold. An organization Viewer's
 * seat writes nothing and adds no candidate. `search` keeps a row whose own
 * name or whose parent's name holds every word, in any order, ignoring case
 * and accents, matched before the cut, and is refused past LIMITS.search.
 *
 * Cursors are sealed with TARGETS_LIST, the login, the organization asked
 * for and the search's name key. `not_ready` until the asked
 * organizations' reach rows and name keys are complete, `stopped` where
 * NAMED_READ ends a batch, never `next: null`, and the access_unchecked
 * refusal whole where a bound of the caller's own reads stops a check.
 *
 * At the design size, one figure a case, measured in
 * convex/tests/projectNavTargets.test.ts under Convex's transaction
 * limits: 20 writable among the 200 sub-projects a person reads under 67
 * parents, every tenth writable, so one batch walks all 200, 705 ranges and
 * 1,097 documents, the most of any case; 30 live sub-projects beside 40
 * archived ones under one project the person edits, 57 ranges and 30
 * documents, then 19 and 9; the 100 sub-projects 5 of a member's teams
 * share with Edit, 180 and 237 for the first batch; the sub-projects of 50
 * live projects a team of the person's shares beside its 150 archived
 * shares, 89 and 257; 30 sub-projects each shared with 5 teams, 162 and
 * 255; each of the three batches beside 200 top-level projects with
 * grants, every tenth with 3 sub-projects, so the person reads 62
 * sub-projects, at most 336 ranges and 333 documents, the second. Every
 * batch answers inside NAMED_READ.
 */
export async function navTargetsOf(
  ctx: QueryCtx,
  authUserId: string,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavTargetsArgs,
): Promise<NavTargets> {
  // refused past LIMITS.search with its sentence
  const text = limitedText(LIMITS.search, a.search ?? '')
  const term = text === '' ? '' : nameKey(text)
  if (text !== '' && term === '') throw badRequest(BLANK_SEARCH)
  if (a.org_id === '') throw badRequest(EMPTY_ORG)
  const ask = await openAsk(
    TARGETS_LIST,
    [authUserId, a.org_id ?? '', term],
    a,
    NOT_TARGETS_CURSOR,
    targetTieOf,
  )
  const ceiling = await namedCeiling(ctx)
  const seats = [...myProfiles.values()]
    .filter((seat) => a.org_id === undefined || seat.org_id === a.org_id)
    .filter((seat) => seat.org_role !== 'viewer')
    .sort((x, y) => (x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0))
  for (const seat of seats) if (!(await navReady(ctx, seat.org_id))) return { state: 'not_ready' }
  const matches = term === '' ? null : allWordsMatcher(term)
  const resume = ask.after === null ? null : targetParts(ask.after)
  try {
    const sights = new Map<string, SeatSight>()
    const parents = new Map<string, Doc<'projects'>>()
    const streams: ((reads: NamedReads) => NamedStream<TargetRow>)[] = []
    for (const seat of seats) {
      const sight = seatSight(ctx, seat, true)
      sights.set(seat.org_id, sight)
      const grantees = await sight.grantees()
      // the parent a cursor stopped under, read again from its start, the
      // org-less tie placing it before its own position
      const parentAfter: NamedAt<SeatTie> | null =
        resume === null ? null : { key: resume.parentKey, tie: [resume.parentId, ''] }
      streams.push(
        targetStream(ctx, sight, grantees, parentAfter, resume, (p) => parents.set(p.id, p)),
      )
    }
    const kept = new Set<string>()
    const keep = async (
      row: TargetRow,
      guard: ReadGuard,
      at: NamedAt,
    ): Promise<NavTargetRow | null> => {
      const place = targetTieOf(at)
      const sight = place === null ? undefined : sights.get(place[3])
      const parent = place === null ? undefined : parents.get(place[0])
      if (sight === undefined || parent === undefined) return null
      const sub = 'grantee_kind' in row ? await rowProject(sight, parent, row) : row
      if (sub === null || kept.has(sub.id)) return null
      if (sub.org_id !== sight.seat.org_id || sub.parent_id !== parent.id) return null
      if (sub.archived_at !== undefined) return null
      if (matches && !matches(nameKey(sub.name)) && !matches(nameKey(parent.name))) return null
      sight.access.seen(sub)
      const level = await sight.access.level(sub.id)
      await guard.settle()
      if (level !== 'user' && level !== 'lead') return null
      kept.add(sub.id)
      return {
        ...navProject(sub),
        parent_id: parent.id,
        parent_name: parent.name,
        parent_num: parent.num,
      }
    }
    const batch = await listBatch(ctx, ask, {
      stream: (reads) => mergeNamed<TargetRow>(streams.map((stream) => stream(reads))),
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

/* The rows a targets stream hands out: a parent's live sub-projects or the
 * child reach rows under it. */
type TargetRow = Doc<'projects'> | Doc<'project_reach'>

/* One seat's targets in their order (navTargetsOf): each top-level project
 * its and its teams' live root rows name that shows (rootShows), from
 * `parentAfter` on, each told to `found`, then its sub-projects, the
 * parent's own where the seat reaches it for a reason of its own, else the
 * child rows under it, each at its position (targetAt), after `resume`'s
 * sub-project under the parent the cursor stopped under. */
function targetStream(
  ctx: QueryCtx,
  sight: SeatSight,
  grantees: readonly Grantee[],
  parentAfter: NamedAt<SeatTie> | null,
  resume: { parentKey: string; parentId: string; childKey: string; childId: string } | null,
  found: (parent: Doc<'projects'>) => void,
): (reads: NamedReads) => NamedStream<TargetRow> {
  const orgId = sight.seat.org_id
  return async function* (reads) {
    const roots = mergeNamed(
      grantees.map((g) => indexAfter(rootIndex(ctx, g, orgId), parentAfter)(reads)),
      { ties: 'first', reads },
    )
    for await (const item of roots) {
      if (item === STOPPED) {
        yield STOPPED
        return
      }
      const parent = await rootShows(sight, item.row)
      if (parent === null) continue
      found(parent)
      const parentKey = item.at.key
      // under the parent a cursor stopped under, the children after it
      const childAfter: NamedAt<IdTie> | null =
        resume !== null && resume.parentId === parent.id && resume.parentKey === parentKey
          ? { key: resume.childKey, tie: [resume.childId] }
          : null
      const own = await sight.access.accessible(parent.id)
      const children: NamedStream<TargetRow> = own
        ? indexAfter(subProjectIndex(ctx, parent), childAfter)(reads)
        : mergeNamed<Doc<'project_reach'>>(
            grantees.map((g) => indexAfter(childIndex(ctx, g, parent.id), childAfter)(reads)),
            { ties: 'first', reads },
          )
      for await (const child of children) {
        if (child === STOPPED) {
          yield STOPPED
          return
        }
        yield {
          row: child.row,
          at: targetAt(parent, parentKey, child.at.key, String(child.at.tie[0]), orgId),
        }
      }
    }
  }
}

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
