/* The reads of project navigation (projectNav.ts): a person's top-level
 * projects across every seat of their login, each seat's favorites first
 * and then the rest (navPageOf, projectNav.page); one top-level project's
 * live sub-projects (navChildrenOf, projectNav.children); and one project
 * resolved for navigation, by id or by its organization and number
 * (navResolveOf, projectNav.resolve). They read the rows the writers in
 * model/projectNav.ts (reach rows) and model/projectFavorites.ts
 * (favorites) keep, and no task.
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
 * navigation, has nothing live to lead to and stays out of all three reads
 * (coordinator, 4 November 2026). A sub-project shows when it and its
 * parent are live and the seat sees it, which shows its parent too.
 *
 * Where candidates come from. The page reads each seat's live favorites
 * (project_favorites by_profile_list) and the live root reach rows of the
 * seat and of its teams (project_reach by_grantee_list). children reads,
 * for a parent the seat sees for a reason of its own, the parent's live
 * sub-projects (projects by_org_parent_state_name), each of which inherits
 * that level, and otherwise only the live child reach rows of the seat and
 * its teams under it (by_grantee_root). A row finds a candidate and grants
 * nothing. The reader reads and judges each candidate's live project, and
 * a reach row's copies must be its project's (organization, kind,
 * top-level project, name key against nameKey(project.name) and live
 * state, as model/projectNav.ts reachFollows compares them), else the
 * reader skips the row, so a project shows once and at its own name's
 * place. A missing or stale row narrows a list and never widens it. So
 * where a batch ends and how far its budget goes depend only on the
 * person's own rows and the projects they see. A favorite on a project the
 * seat lost costs a lookup of each of its grantees' reach rows on it and
 * nothing of that project (model/projectFavorites.ts favoriteShows).
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
 * children), so a cursor opens only for its own list and project.
 *
 * Batches. LIST_BATCH (25) rows a batch, or every row up to `through` and
 * at most four times that, as model/projectSettings.ts lists answer
 * (lib/namedPages.ts listBatch), under NAMED_READ for the whole call. Past
 * the budget a batch answers `stopped` at the position it reached, never
 * `next: null`. A check a bound of OWN_READS or PROJECT_NAV stopped answers
 * the refusal `{ state: 'unavailable', reason: 'access_unchecked',
 * message }` whole, never a list missing a project and never a loss of
 * access; this includes OWN_READS.teamReads (roomSpent), which a batch
 * spends across every project it asks about. The lists answer `not_ready`
 * until the organization's reach rows and name keys are complete
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
import { badRequest, type Refusal } from '../lib/functions'
import { LIST_BATCH } from '../lib/limits'
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
 * All of them far inside NAMED_READ (2,000 ranges, 8,000 documents). */
export const PROJECT_NAV = { teams: 64, children: 4 }

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

/** The page's list name, which seals its cursors. The search stage's list
 * puts its normalized search in the scope beside it. */
export const PAGE_LIST = 'projectNav.page'

/** The children list's name, which seals its cursors with the project id. */
export const CHILDREN_LIST = 'projectNav.children'

/** The page's group marks (lib/namedPages.ts inGroup): a seat's favorites
 * before the rest. */
export const FAVORITES = '0'
export const REST = '1'

/** The tie of a page position: the project id, then the seat's
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

/* A page position's tie, or null for any other shape. */
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
 * then sub-project id. */
export function childIndex(
  ctx: QueryCtx,
  g: Grantee,
  rootId: string,
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
          .eq('live', true),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        rows().withIndex('by_grantee_root', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('root_id', rootId)
            .eq('kind', 'child')
            .eq('live', true)
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
            .eq('live', true)
            .gt('name_key', key),
        ),
    ],
    at: (row) => ({ key: row.name_key, tie: [row.project_id] }),
  }
}

/** The live sub-projects of top-level project `parent` in name order
 * (projects by_org_parent_state_name, archive_state live): name key, then
 * id. */
export function subProjectIndex(
  ctx: QueryCtx,
  parent: Pick<Doc<'projects'>, 'id' | 'org_id'>,
): NamedIndex<Doc<'projects'>, IdTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects().withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', parent.org_id).eq('parent_id', parent.id).eq('archive_state', 'live'),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', parent.org_id)
            .eq('parent_id', parent.id)
            .eq('archive_state', 'live')
            .eq('name_key', key)
            .gt('id', id),
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
    at: (p) => keyed(p.name_key, [p.id] as const),
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
 * it belongs in the page's list of the rest, else null: the row holds its
 * project's copies (organization, a root row of the project itself, its
 * name key, live), the project is a live top-level meta of the seat's
 * organization that the seat sees for navigation (seatSight shows), and it
 * is not one of the seat's favorites by the reader rule, which list it
 * first. Rejects with accessUnchecked where a check stopped. The search
 * stage asks it too.
 */
export async function restShows(
  ctx: QueryCtx,
  sight: SeatSight,
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
  if (row.name_key !== nameKey(project.name)) return null
  if (!(await sight.shows(project))) return null
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
 * navigation across every seat, each seat's favorites first and then the
 * rest, each group in name key order with the project id breaking ties,
 * the seats' rows blended in that one order and told apart by `org_id`.
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
 */
export async function navChildrenOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  a: NavChildrenArgs,
): Promise<NavChildren> {
  const ask = await openAsk(CHILDREN_LIST, [a.project_id], a, NOT_CHILDREN_CURSOR, idTieOf)
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
