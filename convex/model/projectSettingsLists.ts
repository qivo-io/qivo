/* The project lists of Settings (projectSettings.ts): Settings › Projects,
 * one batch of the top-level projects a seat lists, with search across its
 * projects and sub-projects (settingsProjectsOf, projectSettings.projects);
 * one top-level project's live sub-projects on expand (settingsSubProjectsOf,
 * projectSettings.subProjects); Archived projects, newest archived first
 * (settingsArchivedOf, projectSettings.archived); and the archived
 * sub-projects beneath one archived top-level project, its chips, on
 * request (settingsArchivedChildrenOf, projectSettings.archivedSubProjects).
 * Each reads one organization, the caller's seat in it, and no task,
 * comment, file or milestone.
 *
 * Two kinds of sight, kept apart. An active organization admin's seat
 * (lib/access.ts managesEveryProject) lists by management sight: every
 * project of its organization in a top-level meta's tree (inMetaTree),
 * live or archived, read from the organization's own indexes
 * (projects by_org_parent_state_name, by_org_state_name and
 * by_org_state_archived). It never asks ordinary access (accessOf,
 * projectLevelsOf, seatSight), so an admin with no lead, grant or share
 * lists every project, and these reads must not go through accessOf, which
 * gives an admin only their own rows. Every other seat lists
 * by ordinary sight, what it sees today, navigation included, judged by
 * the navigation reads' rules (model/projectNavReads.ts: seatSight,
 * rootShows, ownRoots, restCandidates, childRowShows, inheritedShows and
 * navChildrenOf), reading only its own and its teams' reach rows, the
 * projects they find and the sub-projects of the projects it sees for a
 * reason of its own. Such a seat never reads an organization-wide range,
 * so where a batch ends and how far its budget goes depend only on its own
 * rows and the projects they find (archived pages fail closed, 29 October
 * 2026). An archived top-level project shows to it when it sees it for a
 * reason of its own (accessible), or through an archived sub-project
 * beneath it that it sees (archivedSight), as lib/access.ts counts archived
 * sub-projects for navigation.
 *
 * Rights. Each row's rights are the writes' rule, lib/access.ts managesIn
 * of the project in its tree, never the sight that found it: an admin
 * manages every project, a lead the projects they lead, anyone else none.
 * `can_create_sub_project` is projects.create of a sub-project under a live
 * top-level row, and `can_restore` and `can_delete` are projects.unarchive
 * and projects.deleteDeep of an Archived projects entry. A sub-project
 * beneath an archived parent, which only a search lists, carries its
 * parent's `can_restore`, the action a search hit takes (restoring the
 * parent brings it back when `with_parent`), and no right of its own
 * (coordinator, 5 November 2026). Before the admin access split these
 * equal the writes' level rule (hasProjectLevel 'lead'), as only an admin
 * or the effective lead holds 'lead'; the split moves the writes onto
 * managesIn, so they stay the writes' rule after it.
 *
 * Orders and cursors. Settings › Projects and its search are in name key
 * byte order (lib/namedPages.ts compareNamed), tied by the project id and
 * then the organization, as the navigation page ties a seat's rows, on
 * both sights alike, so a cursor stays good when a seat's role changes
 * between batches. Sub-project lists are in name key order tied by the id.
 * Archived projects are newest archived first, equal archive times in the
 * index's own order (_creationTime, then _id), read descending. Cursors are
 * sealed with the list's name and a scope of the organization, the
 * project where a list has one, the filter and the normalized search
 * (model/projectSettings.ts orderedListAsk), so a cursor opens only for its
 * own list, organization, project, filter and search.
 *
 * Batches and refusals. LIST_BATCH (25) rows a batch, or every row up to
 * `through` and at most four times that (lib/namedPages.ts listBatch),
 * under NAMED_READ for the walk. Past the budget a batch answers `stopped`
 * at the position it reached, never `next: null`. A check a bound of the
 * seat's own rows stopped (OWN_READS, PROJECT_NAV, PROJECT_ADMIN) answers
 * `{ state: 'unavailable', reason: 'access_unchecked', message }` whole,
 * never a list missing a project, as the navigation reads answer it; this
 * differs from a project's own Settings reads (model/projectSettings.ts),
 * which answer such a stopped check `unavailable` without a reason.
 * Management sight reads none of the seat's own rows and never meets it.
 * Every list answers `not_ready` until the organization's reach rows and
 * name keys are complete (model/projectNav.ts navReady), since both sights
 * read archive_state and name_key. A list that names a project answers
 * `unavailable` alike for every project the seat may not list under.
 *
 * Settings › Projects, Archived projects and a project page's Sub-projects
 * section read them (src/panels/settings/ProjectLists.tsx and
 * ProjectSettings.tsx), and the New sub-project dialog reads its parents
 * from projects with sub_project_parents (src/panels/Modals.tsx). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  ACCESS_UNCHECKED,
  accessUnchecked,
  inMetaTree,
  isAccessUnchecked,
  managesEveryProject,
  managesIn,
} from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import type { ArchiveState } from '../lib/enums'
import { LIST_BATCH, MIB } from '../lib/limits'
import {
  compareIn,
  indexAfter,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedAt,
  type NamedIndex,
  type NamedReads,
  type NamedStream,
  type NamedTie,
  namedCeiling,
  type ReadGuard,
  readGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { archiveStateOf, type Grantee, grantee, navReady } from './projectNav'
import {
  childIndex,
  childRowShows,
  inheritedShows,
  type NavChildRow,
  type NavUnavailable,
  navChildrenOf,
  ownRoots,
  PROJECT_NAV,
  restCandidates,
  rootIndex,
  rootRowProject,
  rootShows,
  type SeatSight,
  type SeatTie,
  seatSight,
  subProjectIndex,
} from './projectNavReads'
import { idTieOf, type ListArgs, type ListAsk, orderedListAsk } from './projectSettings'

/** The bounds of Archived projects for a seat that is not an organization
 * admin, which tests lower and set back. Reach rows hold no archive time,
 * so no stream of the seat's own rows comes newest first: the read
 * collects the seat's archived candidates whole, reads each one's project
 * for its archive time, sorts them and hands them to the batch as one
 * stream (settingsArchivedOf). `collect` is what that collection may read,
 * every index range, document and byte as Convex counts them, its access
 * checks included, past which the read answers the access_unchecked
 * refusal whole, never a part of the archive. The walk then takes
 * NAMED_READ of its own, which namedCeiling keeps inside what the request
 * has left. The collection's largest read at the design size is about
 * 1,540 ranges, 2,660 documents and 790 KB (below), and `collect` is about
 * twice that. A call at it reads at most these 3,000 ranges, with one more
 * step's reads past them, and ownRoots, which reads first under its own
 * bounds (PROJECT_NAV.rootRows and roots), counts inside them; the walk
 * then has at most the 1,080 ranges Convex's 4,096 leave less
 * NAMED_RESERVE, which a batch's checks of 25 rows, or of 100 kept live,
 * stay well inside. In documents and bytes a call at the bound reads at
 * most 6,000 and 4 MiB here and NAMED_READ's 8,000 and 4 MiB in the walk,
 * inside Convex's 32,000 documents and 16 MiB.
 *
 * What one call reads at the design size, one figure a case, measured in
 * convex/tests/projectSettingsLists.test.ts ("reads at the design size")
 * under Convex's transaction limits, in index ranges and documents as
 * Convex counts them, every call answered whole. An admin reads only the
 * organization's indexes:
 * - projects, 200 top-level projects and 500 sub-projects: at most 3
 *   ranges and 27 documents a batch, 102 kept live to 100 rows; a search
 *   matching nothing 2 and 701 in one batch; a search matching all 700, at
 *   most 10 and 34 a batch, 29 and 128 kept live;
 * - subProjects of 30: 3 and 28, then 4 and 7; archivedSubProjects of 40:
 *   3 and 28, then 4 and 17;
 * - archived, 300 archived top-level projects: at most 29 and 27 a batch,
 *   103 and 103 kept live, 3 and 301 for a search matching nothing; the
 *   projects list reads the same with or without them;
 * - archived at its sum, 300 archived top-level projects and 1,000
 *   archived sub-projects, half entries under live parents and half beneath
 *   archived ones: at most 29 and 52 a batch, 37 and 137 kept live, 3 and
 *   1,301 for a search matching nothing, at most 15 and 37 a batch for one
 *   matching all 500 beneath archived parents.
 * Anyone else, every call with its pre-walk and checks:
 * - projects, grants on 200 top-level projects: at most 79 and 78 a batch,
 *   237 and 336 kept live; a search matching nothing 639 and 995; matching
 *   all, 658 and 794 first and at most 854 and 790 later, 854 and 865 kept
 *   live from the first batch's end; with the 200 sub-projects under them
 *   the person reads, the two figures' sum, 639 and 1,163 matching
 *   nothing, at most 860 and 844 a batch, 916 and 901 kept live; archived
 *   beside 3 archived projects, 648 and 772, the pre-walk of the 200 root
 *   rows;
 * - projects, 200 sub-projects through grants under 67 parents shown for
 *   navigation only: at most 162 and 211 a batch, 5 and 335 matching
 *   nothing, at most 108 and 196 a batch matching all, 309 and 600 kept
 *   live; subProjects of one parent 18 and 16;
 * - archived at its sum, 200 live and 300 archived top-level projects and
 *   500 archived sub-projects, half entries under live parents and half
 *   beneath archived ones, inherited through grants on the top-level
 *   projects: at most 989 and 1,638 a batch, 1,039 and 1,613 kept live,
 *   1,539 and 2,163 matching nothing, 1,551 and 2,663 a batch matching all
 *   250 beneath archived parents, the most of any call; through grants on
 *   the sub-projects themselves, under parents seen only through them: at
 *   most 1,037 and 2,070, 1,105 and 2,079 kept live, 1,035 and 1,827
 *   matching nothing, 1,328 and 2,111 matching all 250; archivedSubProjects
 *   of one parent 16 and 14;
 * - one team sharing 50 live and 150 archived projects of 3 sub-projects:
 *   projects at most 83 and 80 a batch, 175 and 536 matching nothing, at
 *   most 229 and 401 matching all 200; archived at most 350 and 661 a
 *   batch, 425 and 736 kept live, 475 and 1,086 matching nothing;
 * - a member of 5 teams each sharing 20 sub-projects: projects at most 193
 *   and 284 a batch, 20 and 180 matching nothing, at most 139 and 250
 *   matching all 100; archived 20 and 43. */
export const PROJECT_ADMIN: { collect: ReadCeiling } = {
  collect: { ranges: 3000, documents: 6000, bytes: 4 * MIB },
}

/* --------------------------------------------------------------- the rows */

/** What a Settings project list answers: `not_ready` until the
 * organization's reach rows and name keys are complete; unavailable, alike
 * for every project the seat may not list under (subProjects,
 * archivedSubProjects), or with `reason` access_unchecked and its sentence
 * where a check or a bound of the seat's own rows stopped; else one batch
 * (lib/namedPages.ts ListBatch), `next` null at the end and `stopped`
 * where the read budget ended it before it was full. */
export type SettingsListAnswer<Row> =
  | { state: 'not_ready' }
  | NavUnavailable
  | ({ state: 'ready' } & ListBatch<Row>)

/** A project as a row names its parent: its name, and its number to tell
 * equal names apart and to build its address. */
export type ProjectRef = { id: string; name: string; num: number }

/** A row of Settings › Projects: a live top-level project, or with a
 * search also a live sub-project with its parent. */
export type SettingsProjectRow = {
  id: string
  name: string
  num: number
  /** the top-level project above a sub-project, null for a top-level one */
  parent: ProjectRef | null
  /** projects.create of a sub-project under it would pass for the caller
   * (lib/access.ts managesIn, as model/projectSettings.ts settingsRights
   * can_create_sub_project); false for a sub-project */
  can_create_sub_project: boolean
}

/** A row of Archived projects: an entry, an archived top-level project or
 * an archived sub-project of a live parent, or with a search an archived
 * sub-project beneath an archived parent (`under`). */
export type ArchivedProjectRow = {
  id: string
  name: string
  num: number
  /** when it was archived, an ISO string */
  archived_at: string
  /** the top-level project above a sub-project, live for an entry, archived
   * for a row beneath it; a project the caller sees (lib/access.ts
   * visible), as today's page names it; null for a top-level project */
  parent: ProjectRef | null
  /** beneath an archived parent (archive_state 'under'), so not an entry */
  under: boolean
  /** for a row beneath its parent, whether it was archived with it and so
   * comes back with it; null otherwise */
  with_parent: boolean | null
  /** for a top-level entry, whether archived sub-projects sit beneath it;
   * null otherwise */
  has_sub_projects: boolean | null
  /** projects.unarchive would pass for the caller: of the entry itself
   * (managesIn), or for a row beneath an archived parent, of that parent,
   * which brings the row back when `with_parent` */
  can_restore: boolean
  /** projects.deleteDeep of the entry would pass for the caller; false for
   * a row beneath an archived parent */
  can_delete: boolean
}

/** A chip of an archived entry: an archived sub-project beneath it, and
 * whether it was archived with it. */
export type ArchivedChildRow = { id: string; name: string; num: number; with_parent: boolean }

const NOT_READY = { state: 'not_ready' } as const

const UNAVAILABLE = { state: 'unavailable' } as const

/* The refusal of a check a bound stopped, with its own sentence. */
const unchecked = (message: string): NavUnavailable => ({
  state: 'unavailable',
  reason: ACCESS_UNCHECKED,
  message,
})

/* `answer()`, or the access_unchecked refusal whole where a check stopped. */
async function judged<Row>(
  answer: () => Promise<SettingsListAnswer<Row>>,
): Promise<SettingsListAnswer<Row>> {
  try {
    return await answer()
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return unchecked(e.data.message)
  }
}

const refOf = (p: Doc<'projects'>): ProjectRef => ({ id: p.id, name: p.name, num: p.num })

/* `sub`, a live sub-project of `parent`, as a sub-project list's row. */
const childRow = (sub: Doc<'projects'>, parent: Doc<'projects'>): NavChildRow => ({
  id: sub.id,
  org_id: sub.org_id,
  name: sub.name,
  num: sub.num,
  parent_id: parent.id,
})

/* ------------------------------------------------------------ the cursors */

/** The lists' names, which seal their cursors. */
export const PROJECTS_LIST = 'projectSettings.projects'
export const SUB_PROJECTS_LIST = 'projectSettings.subProjects'
export const ARCHIVED_LIST = 'projectSettings.archived'
export const ARCHIVED_CHILDREN_LIST = 'projectSettings.archivedSubProjects'

/** The refusal of an `after` or `through` that is not a cursor of the
 * list for the same arguments. */
export const NOT_SETTINGS_LIST_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same organization, project, search and sub_project_parents; start again from the first batch'

/** The tie of an Archived projects position: the project's _creationTime,
 * then its _id, the fields by_org_state_archived orders equal archive
 * times by. */
export type ArchiveTie = readonly [created: number, id: string]

/* A Settings › Projects position's tie, the project id and then the seat's
 * organization `orgId`, or null for any other shape. */
const seatTieIn =
  (orgId: string) =>
  ({ tie }: NamedAt): SeatTie | null => {
    const [id, org] = tie
    return tie.length === 2 && typeof id === 'string' && org === orgId ? [id, org] : null
  }

/* An Archived projects position's tie, or null for any other shape. */
const archiveTieOf = ({ tie }: NamedAt): ArchiveTie | null => {
  const [created, id] = tie
  return tie.length === 2 && typeof created === 'number' && typeof id === 'string'
    ? [created, id]
    : null
}

/* The position of a project in name order, tied by `tie`. Readers refuse
 * until the organization is keyed (navReady), so a row without a key here
 * passed that check and is refused rather than placed first. */
function keyed<Tie extends NamedTie>(key: string | undefined, tie: Tie): NamedAt<Tie> {
  if (key === undefined) throw new Error('an unkeyed project passed the readiness check')
  return { key, tie }
}

/* The position of an archived project in Archived projects. */
function archivedAt(p: Doc<'projects'>): NamedAt<ArchiveTie> {
  if (p.archived_at === undefined) throw new Error('a live project in the archive')
  return { key: p.archived_at, tie: [p._creationTime, p._id] }
}

/* ------------------------------------------------------------ the indexes */

/** The live top-level projects of organization `orgId` in name order
 * (projects by_org_parent_state_name, parent_id absent, archive_state
 * live), tied as Settings › Projects ties a position: the id, then
 * `orgId`, which every row shares, so the rows past a cursor's id at its
 * key are those with a greater id. Management sight only. */
function topIndex(ctx: QueryCtx, orgId: string): NamedIndex<Doc<'projects'>, SeatTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects().withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', orgId).eq('parent_id', undefined).eq('archive_state', 'live'),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', orgId)
            .eq('parent_id', undefined)
            .eq('archive_state', 'live')
            .eq('name_key', key)
            .gt('id', id),
        ),
      () =>
        projects().withIndex('by_org_parent_state_name', (q) =>
          q
            .eq('org_id', orgId)
            .eq('parent_id', undefined)
            .eq('archive_state', 'live')
            .gt('name_key', key),
        ),
    ],
    at: (p) => keyed(p.name_key, [p.id, orgId] as const),
  }
}

/** Every live project and sub-project of organization `orgId` in name order
 * (projects by_org_state_name, archive_state live), tied as topIndex.
 * Management sight's search only. */
function nameIndex(ctx: QueryCtx, orgId: string): NamedIndex<Doc<'projects'>, SeatTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects().withIndex('by_org_state_name', (q) =>
        q.eq('org_id', orgId).eq('archive_state', 'live'),
      ),
    after: ({ key, tie: [id] }) => [
      () =>
        projects().withIndex('by_org_state_name', (q) =>
          q.eq('org_id', orgId).eq('archive_state', 'live').eq('name_key', key).gt('id', id),
        ),
      () =>
        projects().withIndex('by_org_state_name', (q) =>
          q.eq('org_id', orgId).eq('archive_state', 'live').gt('name_key', key),
        ),
    ],
    at: (p) => keyed(p.name_key, [p.id, orgId] as const),
  }
}

/** The archived projects of organization `orgId` in archive state `state`,
 * newest archived first (projects by_org_state_archived read descending):
 * the archive time, then _creationTime and _id, Convex's implicit last
 * fields. After a position it reads the rest of its instant, leaving out
 * the rows not past it (lib/namedPages.ts indexAfter), the rest of its
 * archive time, then every earlier one. Management sight only. */
function archiveIndex(
  ctx: QueryCtx,
  orgId: string,
  state: Exclude<ArchiveState, 'live'>,
): NamedIndex<Doc<'projects'>, ArchiveTie> {
  const projects = () => ctx.db.query('projects')
  return {
    all: () =>
      projects()
        .withIndex('by_org_state_archived', (q) => q.eq('org_id', orgId).eq('archive_state', state))
        .order('desc'),
    after: ({ key, tie: [created] }) => [
      () =>
        projects()
          .withIndex('by_org_state_archived', (q) =>
            q
              .eq('org_id', orgId)
              .eq('archive_state', state)
              .eq('archived_at', key)
              .eq('_creationTime', created),
          )
          .order('desc'),
      () =>
        projects()
          .withIndex('by_org_state_archived', (q) =>
            q
              .eq('org_id', orgId)
              .eq('archive_state', state)
              .eq('archived_at', key)
              .lt('_creationTime', created),
          )
          .order('desc'),
      () =>
        projects()
          .withIndex('by_org_state_archived', (q) =>
            q.eq('org_id', orgId).eq('archive_state', state).lt('archived_at', key),
          )
          .order('desc'),
    ],
    at: archivedAt,
  }
}

/* The first archived sub-project beneath archived top-level project `p`,
 * one range, for an entry's has_sub_projects. */
const firstUnder = (ctx: QueryCtx, p: Doc<'projects'>) =>
  ctx.db
    .query('projects')
    .withIndex('by_org_parent_state_name', (q) =>
      q.eq('org_id', p.org_id).eq('parent_id', p.id).eq('archive_state', 'under'),
    )
    .first()

/* A cache of `ctx`'s projects by id, each looked up once with the guard of
 * the batch that first asks for it. */
function projectCache(ctx: QueryCtx) {
  const known = new Map<string, Promise<Doc<'projects'> | null>>()
  return (guard: ReadGuard, id: string) => {
    let found = known.get(id)
    if (found === undefined) {
      found = guard.lookup(() => byId(ctx, 'projects', id))
      known.set(id, found)
    }
    return found
  }
}

/* -------------------------------------------------- Settings › Projects */

/** What projectSettings.projects is asked for: the list's arguments and,
 * with `sub_project_parents`, only the projects under which the caller may
 * create a sub-project. */
export type SettingsProjectsArgs = ListArgs & { sub_project_parents?: boolean }

/**
 * projectSettings.projects for `me`, the caller's seat: one batch of the
 * live top-level projects Settings › Projects lists, in name key order with
 * the id breaking ties, each with whether the caller may create a
 * sub-project under it. An organization admin's seat lists every live
 * top-level meta of its organization (topIndex); any other seat the ones
 * it sees for navigation, from the live root reach rows of the seat and its
 * teams (rootIndex) merged with their ties collapsed, each judged by
 * rootShows.
 *
 * With a search, every word matched against the stored or copied name key
 * before any other read of the row, it lists the matching live projects
 * and sub-projects together, each sub-project with its parent: for an
 * admin one range of the organization's live projects (nameIndex), each
 * sub-project's parent read once; for anyone else the candidates of
 * projectNav.search's rest group (restCandidates over ownRoots), each
 * judged as that search judges it, with rootShows for a root row and no
 * favorites group. A parent's name makes no sub-project match. A blank
 * search browses.
 *
 * With `sub_project_parents` it lists only the live top-level projects
 * under which the caller may create a sub-project (managesIn), the search
 * matched against them alone: every one for an admin; for anyone else the
 * projects they lead, read from the seat's own root rows that record a
 * source on the project, since a seat's lead writes it one (model/projectNav.ts
 * planReach) and leading a project shows it, so no access check is asked.
 * Such a batch may hold few rows, or none, and answer `stopped`.
 *
 * Refuses, before it reads anything, a search past LIMITS.search with that
 * limit's sentence and a cursor of another list, organization, search or
 * filter, or a `through` not after `after`, with badRequest. Then
 * `not_ready` without the organization's stamps, and the access_unchecked
 * refusal whole where a check or a bound of the seat's own rows stopped.
 */
export async function settingsProjectsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: SettingsProjectsArgs,
): Promise<SettingsListAnswer<SettingsProjectRow>> {
  const parentsOnly = a.sub_project_parents === true
  const ask = await orderedListAsk(PROJECTS_LIST, [me.org_id, parentsOnly ? 'parents' : ''], a, {
    tieOf: seatTieIn(me.org_id),
    refusal: NOT_SETTINGS_LIST_CURSOR,
  })
  const ceiling = await namedCeiling(ctx)
  if (!(await navReady(ctx, me.org_id))) return NOT_READY
  const term = nameKey(ask.search)
  const matches = allWordsMatcher(term)
  const top = (p: Doc<'projects'>): SettingsProjectRow => ({
    ...refOf(p),
    parent: null,
    can_create_sub_project: managesIn(me, p, p),
  })
  const sub = (p: Doc<'projects'>, parent: Doc<'projects'>): SettingsProjectRow => ({
    ...refOf(p),
    parent: refOf(parent),
    can_create_sub_project: false,
  })
  const batchOf = async <Row extends Doc<'projects'> | Doc<'project_reach'>>(
    stream: (reads: NamedReads) => NamedStream<Row>,
    keep: (row: Row, guard: ReadGuard) => Promise<SettingsProjectRow | null>,
  ): Promise<SettingsListAnswer<SettingsProjectRow>> => {
    const kept = new Set<string>()
    const batch = await listBatch(ctx, ask, {
      stream,
      keep: async (row: Row, guard: ReadGuard) => {
        if (!matches(row.name_key ?? '')) return null
        const shown = await keep(row, guard)
        if (shown === null || kept.has(shown.id)) return null
        kept.add(shown.id)
        return shown
      },
      limit: LIST_BATCH,
      ceiling,
    })
    return { state: 'ready', ...batch }
  }
  if (managesEveryProject(me)) {
    if (term === '' || parentsOnly)
      return await batchOf(indexAfter(topIndex(ctx, me.org_id), ask.after), async (p) =>
        p.org_id === me.org_id && p.archived_at === undefined && inMetaTree(p, p) ? top(p) : null,
      )
    const parentOf = projectCache(ctx)
    return await batchOf(indexAfter(nameIndex(ctx, me.org_id), ask.after), async (p, guard) => {
      if (p.org_id !== me.org_id || p.archived_at !== undefined) return null
      if (p.parent_id === undefined) return inMetaTree(p, p) ? top(p) : null
      const parent = await parentOf(guard, p.parent_id)
      if (parent === null || parent.org_id !== me.org_id || parent.archived_at !== undefined)
        return null
      return inMetaTree(p, parent) ? sub(p, parent) : null
    })
  }
  return await judged(async () => {
    const sight = seatSight(ctx, me, true)
    if (parentsOnly)
      return await batchOf(
        indexAfter(rootIndex(ctx, grantee.profile(me.id), me.org_id), ask.after),
        async (row, guard) => {
          const p = row.on_root ? await rootRowProject(sight, row) : null
          await guard.settle()
          return p !== null && managesIn(me, p, p) ? top(p) : null
        },
      )
    const grantees = await sight.grantees()
    if (term === '')
      return await batchOf(
        (reads) =>
          mergeNamed(
            grantees.map((g) => indexAfter(rootIndex(ctx, g, me.org_id), ask.after)(reads)),
            { ties: 'first', reads },
          ),
        async (row, guard) => {
          const p = await rootShows(sight, row)
          await guard.settle()
          return p === null ? null : top(p)
        },
      )
    const own = (await ownRoots(ctx, [sight])).get(me.org_id) ?? []
    const parents = new Map(own.map((p) => [p.id, p]))
    const streams = restCandidates(ctx, me, grantees, own, ask.after)
    return await batchOf(
      (reads) =>
        mergeNamed(
          streams.map((stream) => stream(reads)),
          { ties: 'first', reads },
        ),
      async (row, guard) => {
        const shown = await ordinaryMatch(sight, parents, row)
        await guard.settle()
        if (shown === null) return null
        return shown.parent === null ? top(shown.project) : sub(shown.project, shown.parent)
      },
    )
  })
}

/* The project a candidate of the ordinary search shows, with its parent
 * for a sub-project, else null: a root reach row by rootShows, a child
 * reach row by childRowShows and a sub-project's document, read under one
 * of `parents`, the top-level projects the seat sees for a reason of its
 * own, by inheritedShows, as model/projectNavReads.ts navSearchOf judges
 * the rest. Rejects with accessUnchecked where a check stopped. */
async function ordinaryMatch(
  sight: SeatSight,
  parents: ReadonlyMap<string, Doc<'projects'>>,
  row: Doc<'projects'> | Doc<'project_reach'>,
): Promise<{ project: Doc<'projects'>; parent: Doc<'projects'> | null } | null> {
  if ('grantee_kind' in row) {
    if (row.kind === 'root') {
      const p = await rootShows(sight, row)
      return p === null ? null : { project: p, parent: null }
    }
    return await childRowShows(sight, row)
  }
  const parent = row.parent_id === undefined ? undefined : parents.get(row.parent_id)
  if (parent === undefined || !(await inheritedShows(sight, parent, row))) return null
  return { project: row, parent }
}

/* ------------------------------------------------------ the sub-projects */

/** What a Settings list of one project's sub-projects is asked for. */
export type SettingsChildrenArgs = { project_id: string; after?: string; through?: string }

/**
 * projectSettings.subProjects for `me`: one batch of the live sub-projects
 * of top-level project `project_id` Settings lists on expand, in name key
 * order with the id breaking ties, as projectNav.children answers its rows.
 * The project must be a live top-level meta of the seat's organization,
 * else `unavailable`. An organization admin's seat lists every live
 * sub-project in its tree (model/projectNavReads.ts subProjectIndex); any
 * other seat the ones it sees, through model/projectNavReads.ts
 * navChildrenOf with its rules unchanged, which answers `unavailable` alike
 * for a project the seat does not see. Both sights seal their cursors as
 * this list, with the organization and the project, so a cursor carried
 * across a change of the seat's role keeps reading, and no cursor of
 * projectNav.children opens here. Refuses another cursor with badRequest
 * before it reads anything, then answers `not_ready` without the
 * organization's stamps.
 */
export async function settingsSubProjectsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: SettingsChildrenArgs,
): Promise<SettingsListAnswer<NavChildRow>> {
  const ask = await orderedListAsk(
    SUB_PROJECTS_LIST,
    [me.org_id, a.project_id],
    { after: a.after, through: a.through },
    { tieOf: idTieOf, refusal: NOT_SETTINGS_LIST_CURSOR },
  )
  if (!(await navReady(ctx, me.org_id))) return NOT_READY
  const project = await byId(ctx, 'projects', a.project_id)
  if (
    project === null ||
    project.org_id !== me.org_id ||
    project.archived_at !== undefined ||
    !inMetaTree(project, project)
  )
    return UNAVAILABLE
  if (managesEveryProject(me)) {
    const batch = await listBatch(ctx, ask, {
      stream: indexAfter(subProjectIndex(ctx, project), ask.after),
      keep: async (sub: Doc<'projects'>) =>
        sub.org_id === me.org_id &&
        sub.parent_id === project.id &&
        sub.archived_at === undefined &&
        inMetaTree(sub, project)
          ? childRow(sub, project)
          : null,
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx),
    })
    return { state: 'ready', ...batch }
  }
  const answer = await navChildrenOf(
    ctx,
    new Map([[me.org_id, me]]),
    { project_id: project.id },
    ask,
  )
  return answer.state === 'ok' ? { ...answer, state: 'ready' as const } : answer
}

/* ----------------------------------------------------- Archived projects */

/** How a seat that is not an organization admin sees an archived top-level
 * project: for a reason of its own (accessible), so every archived
 * sub-project beneath it inherits that sight; only through an archived
 * sub-project beneath it that it sees; or not at all (null). */
type ArchivedSight = 'own' | 'through' | null

/**
 * Whether the seat of `sight` sees archived top-level project `p`, the
 * archived counterpart of model/projectNavReads.ts seatSight shows: `p`
 * must be an archived top-level meta of the seat's organization, which the
 * seat sees for a reason of its own (accessible), or through one of the
 * first PROJECT_NAV.children archived child reach rows of its teams and
 * then its seat under it, one range a grantee, whose sub-project is beneath
 * `p`, archived and seen (visible, which has no legacy path for a
 * sub-project). Past those rows with none seen it rejects with
 * accessUnchecked, as a row fails only for a sub-project a Deleted items
 * move or restore holds, a reused id or a Viewer's old lead, so it never
 * reads a sub-project the seat cannot see and never answers no access for
 * a check it could not finish.
 */
async function archivedSight(
  ctx: QueryCtx,
  sight: SeatSight,
  grantees: readonly Grantee[],
  p: Doc<'projects'>,
): Promise<ArchivedSight> {
  const { seat, access } = sight
  if (p.org_id !== seat.org_id || p.archived_at === undefined || !inMetaTree(p, p)) return null
  access.seen(p)
  if (await access.accessible(p.id)) return 'own'
  const [self, ...teams] = grantees
  let left = PROJECT_NAV.children
  // the teams first and the seat last, as a lead a Viewer kept gives the
  // seat rows that show nothing
  for (const g of [...teams, self]) {
    const rows = await ctx.db
      .query('project_reach')
      .withIndex('by_grantee_root', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('root_id', p.id)
          .eq('kind', 'child')
          .eq('live', false),
      )
      .take(left + 1)
    for (const row of rows) {
      if (left === 0) throw accessUnchecked()
      left -= 1
      const sub = await access.project(row.project_id)
      if (
        sub !== null &&
        sub.org_id === seat.org_id &&
        sub.parent_id === p.id &&
        sub.archived_at !== undefined &&
        (await access.visible(sub.id))
      )
        return 'through'
    }
  }
  return null
}

/* `p`, an archived project in the tree of `parent` (null for a top-level
 * one), as an Archived projects row for `me`, with `has` the entry's
 * has_sub_projects. */
function archivedRow(
  me: Doc<'profiles'>,
  p: Doc<'projects'>,
  parent: Doc<'projects'> | null,
  has: boolean | null,
): ArchivedProjectRow {
  const base = { ...refOf(p), archived_at: archivedAt(p).key }
  if (parent === null) {
    const manages = managesIn(me, p, p)
    return {
      ...base,
      parent: null,
      under: false,
      with_parent: null,
      has_sub_projects: has,
      can_restore: manages,
      can_delete: manages,
    }
  }
  if (parent.archived_at === undefined) {
    const manages = managesIn(me, p, parent)
    return {
      ...base,
      parent: refOf(parent),
      under: false,
      with_parent: null,
      has_sub_projects: null,
      can_restore: manages,
      can_delete: manages,
    }
  }
  return {
    ...base,
    parent: refOf(parent),
    under: true,
    with_parent: p.archived_at === parent.archived_at,
    has_sub_projects: null,
    can_restore: managesIn(me, parent, parent),
    can_delete: false,
  }
}

/* The parent of archived sub-project `p` when it is a top-level meta of
 * `p`'s organization whose tree holds `p` and whose archive state agrees
 * with `p`'s (model/projectNav.ts archiveStateOf), else null. */
function treeParent(p: Doc<'projects'>, parent: Doc<'projects'> | null): Doc<'projects'> | null {
  if (parent === null || parent.org_id !== p.org_id || !inMetaTree(p, parent)) return null
  return archiveStateOf(p, parent) === p.archive_state ? parent : null
}

/**
 * projectSettings.archived for `me`: one batch of Archived projects, the
 * entries (an archived top-level project, or an archived sub-project of a
 * live parent), newest archived first, equal archive times in the index's
 * order (_creationTime, then _id). Each entry carries its parent where it
 * is a sub-project, whether the caller may restore and delete it and, for
 * a top-level one, whether archived sub-projects sit beneath it. With a
 * search, every word matched against the stored or copied name key before
 * the row's project is read, it lists the matching entries and the
 * matching sub-projects beneath an archived parent (`under`), each with
 * that parent and whether it comes back with it, in the same order, so a
 * sub-project archived with its parent sits beside it.
 *
 * An organization admin's seat reads the organization's entries
 * (projects by_org_state_archived, 'listed', descending), with a search
 * merged with its 'under' rows, each sub-project's parent read once, and
 * has_sub_projects is one range of the archived sub-projects beneath it.
 *
 * Any other seat's candidates come from its own rows, collected whole
 * under PROJECT_ADMIN.collect and sorted (archiveCandidates). Each is then
 * judged in the batch: a top-level project by archivedSight, a sub-project
 * by lib/access.ts visible, with its parent, so a parent seen only through
 * an archived sub-project shows as an entry. has_sub_projects is one range
 * for a project the seat sees for a reason of its own, and true for one it
 * sees only through an archived sub-project, which sits beneath it.
 *
 * Refuses, before it reads anything, a search past LIMITS.search and a
 * cursor of another list, organization or search, or a `through` not after
 * `after` in this order, with badRequest. Then `not_ready` without the
 * organization's stamps, and the access_unchecked refusal whole where a
 * check or a bound of the seat's own rows stopped, the collection's
 * included.
 */
export async function settingsArchivedOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: ListArgs,
): Promise<SettingsListAnswer<ArchivedProjectRow>> {
  const ask = await orderedListAsk(ARCHIVED_LIST, [me.org_id], a, {
    tieOf: archiveTieOf,
    order: 'desc',
    refusal: NOT_SETTINGS_LIST_CURSOR,
  })
  if (!(await navReady(ctx, me.org_id))) return NOT_READY
  const term = nameKey(ask.search)
  const matches = allWordsMatcher(term)
  if (managesEveryProject(me)) return await managedArchive(ctx, me, ask, term, matches)
  return await judged(() => ordinaryArchive(ctx, me, ask, term, matches))
}

/* Archived projects for an organization admin's seat (settingsArchivedOf). */
async function managedArchive(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  ask: ListAsk<ArchiveTie>,
  term: string,
  matches: (key: string) => boolean,
): Promise<SettingsListAnswer<ArchivedProjectRow>> {
  const states = term === '' ? (['listed'] as const) : (['listed', 'under'] as const)
  const streams = states.map((state) =>
    indexAfter(archiveIndex(ctx, me.org_id, state), ask.after, 'desc'),
  )
  const parentOf = projectCache(ctx)
  const batch = await listBatch(ctx, ask, {
    stream: (reads) =>
      mergeNamed(
        streams.map((stream) => stream(reads)),
        { order: 'desc' },
      ),
    keep: async (p: Doc<'projects'>, guard) => {
      if (!matches(p.name_key ?? '')) return null
      if (p.org_id !== me.org_id || p.archived_at === undefined) return null
      if (p.parent_id === undefined) {
        if (!inMetaTree(p, p) || p.archive_state !== 'listed') return null
        return archivedRow(me, p, null, (await guard.lookup(() => firstUnder(ctx, p))) !== null)
      }
      const parent = treeParent(p, await parentOf(guard, p.parent_id))
      return parent === null ? null : archivedRow(me, p, parent, null)
    },
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
    order: 'desc',
  })
  return { state: 'ready', ...batch }
}

/* What the collection of a seat's archive found for one project: the
 * project, with its archive position. */
type ArchiveCandidate = { project: Doc<'projects'>; at: NamedAt<ArchiveTie> }

/**
 * The archived candidates of the seat of `sight` for Archived projects, by
 * project id, each read once, every read counted under
 * PROJECT_ADMIN.collect from the collection's start, past which it rejects
 * with accessUnchecked:
 *
 * 1. the archived entries ('listed') among the sub-projects of each live
 *    top-level project the seat sees for a reason of its own
 *    (model/projectNavReads.ts ownRoots, under its own bounds, whose reads
 *    the budget counts once it ends), one range each;
 * 2. the archived root reach rows of the seat and its teams
 *    (project_reach by_grantee_list, kind root, live false) whose copies
 *    name an archived top-level project of the organization;
 * 3. their archived child reach rows (kind child, live false), each row's
 *    sub-project when it is archived under that top-level project and, while
 *    browsing, an entry ('listed'); a row under a top-level project step 2
 *    found archived is beneath an archived parent, so browsing skips it
 *    without reading it;
 * 4. with a search, the sub-projects beneath each archived top-level
 *    project one of those root rows records a source on (on_root) that the
 *    seat sees for a reason of its own (accessible), one range each.
 *
 * A row finds a candidate and grants nothing: the batch judges each. With
 * a search a row whose key does not match is left out before its project
 * is read, except a root row that records a source (on_root), whose
 * project step 4 reads to decide whether to read the sub-projects beneath
 * it.
 */
async function archiveCandidates(
  ctx: QueryCtx,
  sight: SeatSight,
  grantees: readonly Grantee[],
  matches: (key: string) => boolean,
  searching: boolean,
): Promise<Map<string, ArchiveCandidate>> {
  const { seat, access } = sight
  const guard = readGuard(ctx, await namedCeiling(ctx, PROJECT_ADMIN.collect))
  const room = (ok: boolean) => {
    if (!ok) throw accessUnchecked()
  }
  /* every document of a range, each counted */
  const all = async <D extends Doc<'projects'> | Doc<'project_reach'>>(
    range: AsyncIterable<D>,
  ): Promise<D[]> => {
    room(await guard.range())
    const rows: D[] = []
    for await (const row of range) {
      room(await guard.document(row))
      rows.push(row)
    }
    return rows
  }
  const found = new Map<string, ArchiveCandidate>()
  const add = (p: Doc<'projects'>) => {
    if (!found.has(p.id)) found.set(p.id, { project: p, at: archivedAt(p) })
  }
  /* the project with this id, read and counted once */
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const read = (id: string) => {
    let known = projects.get(id)
    if (known === undefined) {
      known = (async () => {
        room(await guard.range())
        const p = await access.project(id)
        if (p !== null) room(await guard.document(p))
        return p
      })()
      known.catch(() => {})
      projects.set(id, known)
    }
    return known
  }
  const reach = (g: Grantee, kind: 'root' | 'child') =>
    ctx.db
      .query('project_reach')
      .withIndex('by_grantee_list', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('kind', kind)
          .eq('live', false),
      )
  const subsOf = (p: Doc<'projects'>, state: 'listed' | 'under') =>
    ctx.db
      .query('projects')
      .withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', p.org_id).eq('parent_id', p.id).eq('archive_state', state),
      )
  // 1. the archived sub-projects of the live projects the seat sees for a
  // reason of its own, whose reads before the walk count in the budget too
  const own = (await ownRoots(ctx, [sight])).get(seat.org_id) ?? []
  room(await guard.settle())
  for (const p of own)
    for (const sub of await all(subsOf(p, 'listed'))) if (matches(sub.name_key ?? '')) add(sub)
  // 2. the archived top-level projects the seat's rows name; a search reads
  // those whose key matches and those a row records a source on, for step 4
  const archivedRoots = new Set<string>()
  const sources = new Set<string>()
  for (const g of grantees)
    for (const row of await all(reach(g, 'root'))) {
      if (row.org_id !== seat.org_id || row.root_id !== row.project_id) continue
      const named = matches(row.name_key)
      if (!named && !(searching && row.on_root)) continue
      const p = await read(row.project_id)
      if (p === null || p.id !== row.project_id || p.org_id !== seat.org_id) continue
      if (p.archived_at === undefined || !inMetaTree(p, p)) continue
      archivedRoots.add(p.id)
      if (row.name_key !== nameKey(p.name)) continue
      if (row.on_root) sources.add(p.id)
      if (named) add(p)
    }
  // 3. the archived sub-projects the seat's child rows name
  for (const g of grantees)
    for (const row of await all(reach(g, 'child'))) {
      if (row.org_id !== seat.org_id) continue
      if (!searching && archivedRoots.has(row.root_id)) continue
      if (!matches(row.name_key)) continue
      const sub = await read(row.project_id)
      if (sub === null || sub.id !== row.project_id || sub.org_id !== seat.org_id) continue
      if (sub.parent_id !== row.root_id || row.name_key !== nameKey(sub.name)) continue
      if (sub.archived_at === undefined) continue
      if (searching ? sub.archive_state !== 'live' : sub.archive_state === 'listed') add(sub)
    }
  // 4. with a search, those beneath the archived projects it sees for a
  // reason of its own
  if (searching)
    for (const id of sources) {
      const p = await read(id)
      if (p === null) continue
      const mine = await access.accessible(p.id)
      room(await guard.settle())
      if (!mine) continue
      for (const sub of await all(subsOf(p, 'under'))) if (matches(sub.name_key ?? '')) add(sub)
    }
  room(await guard.settle())
  return found
}

/* Archived projects for a seat that is not an organization admin
 * (settingsArchivedOf). */
async function ordinaryArchive(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  ask: ListAsk<ArchiveTie>,
  term: string,
  matches: (key: string) => boolean,
): Promise<SettingsListAnswer<ArchivedProjectRow>> {
  const searching = term !== ''
  const sight = seatSight(ctx, me, true)
  const grantees = await sight.grantees()
  const found = await archiveCandidates(ctx, sight, grantees, matches, searching)
  const sorted = [...found.values()].sort((x, y) => compareIn('desc', x.at, y.at))
  const after = ask.after
  const stream = (): NamedStream<Doc<'projects'>> =>
    (async function* () {
      for (const { project, at } of sorted)
        if (after === null || compareIn('desc', at, after) > 0) yield { row: project, at }
    })()
  const sights = new Map<string, Promise<ArchivedSight>>()
  const sees = (p: Doc<'projects'>) => {
    let known = sights.get(p.id)
    if (known === undefined) {
      known = archivedSight(ctx, sight, grantees, p)
      known.catch(() => {})
      sights.set(p.id, known)
    }
    return known
  }
  const keep = async (p: Doc<'projects'>, guard: ReadGuard): Promise<ArchivedProjectRow | null> => {
    const row = await ordinaryRow(ctx, me, sight, sees, p, guard, searching)
    await guard.settle()
    return row
  }
  const batch = await listBatch(ctx, ask, {
    stream,
    keep,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
    order: 'desc',
  })
  return { state: 'ready', ...batch }
}

/* The Archived projects row of candidate `p` for `me`, an ordinary seat,
 * when the seat sees it, else null: a top-level project by archivedSight,
 * with has_sub_projects; a sub-project by lib/access.ts visible, with its
 * parent, an entry under a live parent or, while `searching`, a row
 * beneath an archived one. */
async function ordinaryRow(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  sight: SeatSight,
  sees: (p: Doc<'projects'>) => Promise<ArchivedSight>,
  p: Doc<'projects'>,
  guard: ReadGuard,
  searching: boolean,
): Promise<ArchivedProjectRow | null> {
  if (p.org_id !== me.org_id || p.archived_at === undefined) return null
  if (p.parent_id === undefined) {
    if (p.archive_state !== 'listed') return null
    const how = await sees(p)
    if (how === null) return null
    const has = how === 'through' || (await guard.lookup(() => firstUnder(ctx, p))) !== null
    return archivedRow(me, p, null, has)
  }
  const parent = treeParent(p, await sight.project(p.parent_id))
  if (parent === null || (!searching && parent.archived_at !== undefined)) return null
  sight.access.seen(p)
  return (await sight.access.visible(p.id)) ? archivedRow(me, p, parent, null) : null
}

/**
 * projectSettings.archivedSubProjects for `me`: one batch of the archived
 * sub-projects beneath archived top-level project `project_id`, its chips,
 * in name key order with the id breaking ties, each with whether it was
 * archived with it (equal archive times). The project must be an archived
 * top-level meta of the seat's organization, an entry ('listed'), that the
 * seat lists (archivedSight for a seat that is not an organization admin),
 * else `unavailable` alike. An admin's seat, and a seat that sees the
 * project for a reason of its own, read its archived sub-projects
 * (projects by_org_parent_state_name, 'under'); a seat that sees it only
 * through an archived sub-project reads only the archived child reach rows
 * of the seat and its teams under it (by_grantee_root), merged with their
 * ties collapsed, each sub-project read and asked visible, as
 * projectNav.children reads live ones. Both order alike, so a cursor
 * carried across a change of access or role keeps reading. Refuses another
 * cursor with badRequest before it reads anything, then answers
 * `not_ready` without the organization's stamps, and the access_unchecked
 * refusal whole where a check stopped.
 */
export async function settingsArchivedChildrenOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: SettingsChildrenArgs,
): Promise<SettingsListAnswer<ArchivedChildRow>> {
  const ask = await orderedListAsk(
    ARCHIVED_CHILDREN_LIST,
    [me.org_id, a.project_id],
    { after: a.after, through: a.through },
    { tieOf: idTieOf, refusal: NOT_SETTINGS_LIST_CURSOR },
  )
  if (!(await navReady(ctx, me.org_id))) return NOT_READY
  const project = await byId(ctx, 'projects', a.project_id)
  if (
    project === null ||
    project.org_id !== me.org_id ||
    project.archived_at === undefined ||
    project.archive_state !== 'listed' ||
    !inMetaTree(project, project)
  )
    return UNAVAILABLE
  const chip = (sub: Doc<'projects'>): ArchivedChildRow => ({
    ...refOf(sub),
    with_parent: sub.archived_at === project.archived_at,
  })
  /* whether `sub` is an archived sub-project beneath `project` */
  const beneath = (sub: Doc<'projects'>) =>
    sub.org_id === me.org_id &&
    sub.parent_id === project.id &&
    sub.archived_at !== undefined &&
    sub.archive_state === 'under' &&
    inMetaTree(sub, project)
  if (managesEveryProject(me)) {
    const batch = await listBatch(ctx, ask, {
      stream: indexAfter(subProjectIndex(ctx, project, 'under'), ask.after),
      keep: async (sub: Doc<'projects'>) => (beneath(sub) ? chip(sub) : null),
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx),
    })
    return { state: 'ready', ...batch }
  }
  return await judged(async () => {
    const sight = seatSight(ctx, me, true, [project])
    const grantees = await sight.grantees()
    const how = await archivedSight(ctx, sight, grantees, project)
    if (how === null) return UNAVAILABLE
    const stream = (reads: NamedReads): NamedStream<Doc<'projects'> | Doc<'project_reach'>> =>
      how === 'own'
        ? indexAfter(subProjectIndex(ctx, project, 'under'), ask.after)(reads)
        : mergeNamed(
            grantees.map((g) =>
              indexAfter(childIndex(ctx, g, project.id, false), ask.after)(reads),
            ),
            { ties: 'first', reads },
          )
    const kept = new Set<string>()
    const keep = async (
      row: Doc<'projects'> | Doc<'project_reach'>,
      guard: ReadGuard,
    ): Promise<ArchivedChildRow | null> => {
      const sub = 'grantee_kind' in row ? await archivedRowProject(sight, project, row) : row
      if (sub === null || kept.has(sub.id) || !beneath(sub)) return null
      sight.access.seen(sub)
      const seen = await sight.access.visible(sub.id)
      await guard.settle()
      if (!seen) return null
      kept.add(sub.id)
      return chip(sub)
    }
    const batch = await listBatch(ctx, ask, {
      stream,
      keep,
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx),
    })
    return { state: 'ready', ...batch }
  })
}

/* The sub-project the archived child reach row `row` under `parent` names,
 * when the row holds its copies (organization, a child row under `parent`,
 * name key, archived), else null. */
async function archivedRowProject(
  sight: SeatSight,
  parent: Doc<'projects'>,
  row: Doc<'project_reach'>,
): Promise<Doc<'projects'> | null> {
  if (row.org_id !== sight.seat.org_id || row.kind !== 'child' || row.root_id !== parent.id)
    return null
  if (row.live) return null
  const sub = await sight.project(row.project_id)
  if (sub === null || sub.id !== row.project_id || row.name_key !== nameKey(sub.name)) return null
  return sub
}
