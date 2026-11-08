/* Projects over REST and MCP: the project lists a page at a time
 * (projectPage), reading one project, creating projects and
 * sub-projects, changing their settings and lead, archiving and restoring
 * them, giving and removing access one person or one team at a time, and
 * milestones.
 *
 * PROJECT_TOOLS and PROJECT_ROUTES are registry entries (machine/registry.ts)
 * that machine/mcp.ts TOOLS and machine/rest.ts ROUTES spread in, so
 * tools/list, the OAuth step-up and REST routing treat them like the rest.
 * This module imports only types from those two, so neither is loaded
 * through it. The provenance, key name validator, body parsers and MCP text
 * it shares with them come from machine/shared.ts. machine/rest.ts uses
 * projectPage for GET /v1/projects and projectRead for GET
 * /v1/projects/{ref}, and machine/mcp.ts projectPage for list_projects.
 * No project route reads the organization's catalogue (lib/core.ts
 * loadCatalogue): the lists read the caller's own reach rows and the
 * projects they name, and the single read and the write answers one
 * lib/access.ts accessOf instance asked about the project they name.
 *
 * Each action is one shared model function the app runs too
 * (model/projects.ts createProjectCore, updateProjectCore, archiveProjectCore
 * and unarchiveProjectCore, model/projectAccess.ts setProjectGrantCore and
 * removeProjectGrantCore, model/milestones.ts). The internal functions below
 * are thin per-surface wrappers, `mcp*` and `rest*`: each starts from
 * asMachineCaller, which refuses a read-only credential before anything
 * resolves, parses its surface's input, calls the model and encodes the
 * result. MCP answers pretty-printed text, stringified here so the key order
 * survives the function boundary; REST answers objects.
 *
 * Visibility: the management actions (get_project and its REST read,
 * update_project and PATCH with archive and restore, set_project_access and
 * the access routes, and a create's parent) resolve a project the caller
 * reads or manages (managedProject), as the app's Settings pages do, and
 * so do the user and team grant lists (GET /v1/projects/{ref}/access/users
 * and /access/teams, list_project_related), whose first pages the details
 * show; a project the caller neither reads nor manages answers like an
 * unknown one.
 * An organization admin manages every project of their organization, and
 * anyone else only what they lead, which they read, so management reveals
 * no project to anyone it does not already show. A project the caller
 * manages without reading answers its row with `read` false, its lead,
 * settings and grants, and neither its milestones nor its completion
 * (projectDetailJson). The milestone tools and routes, which change
 * planning data, resolve only a project the caller reads, and so do a
 * milestone on it and the milestone list (GET
 * /v1/projects/{ref}/milestones, list_project_related). Machine creation takes no grant maps; access changes one
 * person or team at a time, and only a person may change it (lib/access.ts
 * canChangeAccess). */

import { ConvexError, type ObjectType, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import {
  accessOf,
  canManageOwnProjectAccess,
  canSeeProject,
  inMetaTree,
  isAccessUnchecked,
  rootMetaOf,
} from '../lib/access'
import { type ReadCeiling, readsUnder } from '../lib/archivedTasks'
import {
  type AccessFlag,
  asMachineCaller,
  type Caller,
  type CompletionJson,
  findProject,
  flagOf,
  issueKey,
  NO_TASKS,
  PROJECT_DETAILS,
  projectCompletion,
  projectJson,
  UNAVAILABLE_COMPLETION,
  UUID,
} from '../lib/core'
import { byId } from '../lib/db'
import {
  type ArchiveState,
  type CredentialAccess,
  type GrantLevel,
  vCredentialAccess,
  vGrantLevel,
} from '../lib/enums'
import { badRequest, notFound, type Refusal, rule } from '../lib/functions'
import { DEFAULT_PAGE_SIZE, LIMITS, type Limit } from '../lib/limits'
import {
  CURSOR_REFUSAL,
  listCursorText,
  NAMES_NOT_READY,
  namedScope,
  openListCursor,
  PROJECTS_NOT_READY,
} from '../lib/listCursor'
import {
  indexAfter,
  listBatch,
  mergeNamed,
  type Named,
  type NamedAt,
  type NamedReads,
  type NamedStream,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
  STOPPED,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import {
  createExpectedSentence,
  EXPECTED_DELETE_SENTENCE,
  EXPECTED_SENTENCE,
  expectedSchema,
  parseExpected,
  refuseCreateExpected,
  sentKeys,
  vExpected,
} from '../model/expected'
import {
  addMilestoneCore,
  changeableMilestone,
  cleanMilestoneDate,
  MILESTONE_MACHINE_FIELDS,
  MILESTONE_READ_TOO_LARGE,
  readMilestones,
  removeMilestoneCore,
  updateMilestoneCore,
} from '../model/milestones'
import { type IdTie, idTieOf, nameKeysReady } from '../model/nameKeys'
import { newUuid } from '../model/orgs'
import {
  type AccessRemoval,
  type AccessSubject,
  GRANT_FIELDS,
  type HeldTasks,
  type Holding,
  ON_HELD_TASKS_SCHEMA,
  parseHeldTasks,
  removeProjectGrantCore,
  setProjectGrantCore,
  vHeldTasks,
} from '../model/projectAccess'
import { reachReady, settleFavorites, treeBudget } from '../model/projectNav'
import { childKeyIndex, rootKeyIndex, seatSight, subKeyIndex } from '../model/projectNavReads'
import {
  type ListAsk,
  teamShareBatch,
  UNKEYED_MOST,
  userGrantBatch,
} from '../model/projectSettings'
import {
  archiveProjectCore,
  createProjectCore,
  PROJECT_MACHINE_FIELDS,
  type ProjectPatch,
  reviewHoursFor,
  unarchiveProjectCore,
  updateProjectCore,
} from '../model/projects'
import { ACCESS_PUT_FIELDS, HELD_TASKS_FIELDS } from './bodyFields'
import type { TOOLS } from './mcp'
import type { ROUTES, route as restRoute } from './rest'
import {
  cursorPaging,
  MCP_PROVENANCE,
  needJson,
  optionalJson,
  pretty,
  refuseUnknownFields,
  restProvenance,
  vKeyName,
} from './shared'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* --------------------------------------------------------------- reading */

type MilestoneJson = { id: string; name: string; date: string }
type GrantJson = { id: string; name: string; level: GrantLevel }

/** What the single-project read adds to a project row. MCP's text keeps
 * this order, each cursor right before what it continues; REST's answer
 * crosses the Convex value boundary, which sorts keys. */
type ProjectDetailJson = {
  lead_id: string | null
  lead_name: string | null
  review_hours: number | null
  effective_review_hours: number
  track_delay: boolean
  /** the app Overview's Completion from the stored counts, null for an
   * archived project, `unavailable` for a live one the caller manages
   * without reading */
  completion: CompletionJson | null
  /** the cursor of `milestones`' next page, null where the list ends on
   * this one and for a project the caller manages without reading */
  milestones_next_cursor: string | null
  /** the first page of the top-level project's milestones by date, null
   * for a project the caller manages without reading, as milestones are
   * planning data */
  milestones: MilestoneJson[] | null
  /** the cursor of `grants.users`' next page, null where it ends here */
  user_grants_next_cursor: string | null
  /** the cursor of `grants.teams`' next page, null where it ends here */
  team_grants_next_cursor: string | null
  /** the first page of the project's own user grants and of its team
   * grants */
  grants: { users: GrantJson[]; teams: GrantJson[] }
}

/* A milestone as REST and MCP send it, its stored `week` day as `date`. */
const milestoneJson = (m: Doc<'milestones'>): MilestoneJson => ({
  id: m.id,
  name: m.name,
  date: m.week,
})

/** A project's lists that its details hold a first page of and that page
 * on their own, as MCP list_project_related names them and REST GET
 * /v1/projects/{ref}/milestones, /access/users and /access/teams route
 * them, in the order the details read them. */
export const PROJECT_RELATED_LISTS = ['milestones', 'user_grants', 'team_grants'] as const

/** One of PROJECT_RELATED_LISTS. */
export type ProjectRelatedList = (typeof PROJECT_RELATED_LISTS)[number]

/** The list name each related list seals its cursors with
 * (lib/listCursor.ts). The details and both surfaces answer the same rows,
 * so a cursor of the details continues on the list call, and one of REST on
 * MCP. */
export const PROJECT_LIST_NAMES: Record<ProjectRelatedList, string> = {
  milestones: 'machine.project_milestones',
  user_grants: 'machine.project_user_grants',
  team_grants: 'machine.project_team_grants',
}

/* What a related list's cursor seals: the organization, the caller and the
 * project the call names. */
const relatedScope = (me: Caller, project: Doc<'projects'>): string[] => [
  me.org_id,
  me.id,
  project.id,
]

/* Each list's position before its first row: a milestone's position is its
 * stored day with a tie of its name key and id, a grant's its holder's name
 * key copy with a tie of the holder's id. */
const LIST_START: Record<ProjectRelatedList, NamedAt> = {
  milestones: { key: '', tie: ['', ''] },
  user_grants: { key: '', tie: [''] },
  team_grants: { key: '', tie: [''] },
}

/* A cursor at the start of `list`, for a first page the details had no
 * room for. */
const startOf = (me: Caller, project: Doc<'projects'>, list: ProjectRelatedList) =>
  listCursorText(PROJECT_LIST_NAMES[list], relatedScope(me, project), LIST_START[list])

/** The position `cursor` names in `list` of `project` for `me`, refused
 * with CURSOR_REFUSAL unless it is one of that list's own: a cursor of
 * another list, project, caller or organization, a changed one, junk, and a
 * position of another shape. */
export async function openRelated(
  me: Caller,
  project: Doc<'projects'>,
  list: ProjectRelatedList,
  cursor: string,
): Promise<NamedAt> {
  const at = await openListCursor(
    cursor,
    PROJECT_LIST_NAMES[list],
    relatedScope(me, project),
    list === 'milestones' ? 2 : 1,
  )
  if (!at.tie.every((field) => typeof field === 'string')) throw badRequest(CURSOR_REFUSAL)
  return at
}

/** One page of a related list: its rows and the sealed cursor of the
 * next, null only where the list ends. */
type RelatedPage<Row> = { rows: Row[]; next: string | null }

/* One page of the milestones of `project`'s top-level project after
 * `after`, at most `limit`, in the app's order of stored day, name key and
 * id (model/milestones.ts readMilestones), within MILESTONE_READ and
 * `ceiling` when one is given. A sub-project's are its parent's, and a
 * milestone stored on a sub-project before 14 October 2026 is left out;
 * an archived project's are listed. */
async function milestonePage(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  limit: number,
  after: NamedAt | null,
  ceiling?: ReadCeiling,
): Promise<RelatedPage<MilestoneJson>> {
  const root = await rootMetaOf(ctx, project)
  const batch = await readMilestones(ctx, [root.id], {
    span: { order: 'asc' },
    after:
      after === null
        ? null
        : { week: after.key, key: String(after.tie[0]), id: String(after.tie[1]) },
    search: '',
    limit,
    ...(ceiling === undefined ? {} : { ceiling }),
  })
  const next =
    batch.next === null
      ? null
      : await listCursorText(PROJECT_LIST_NAMES.milestones, relatedScope(me, project), {
          key: batch.next.week,
          tie: [batch.next.key, batch.next.id],
        })
  return { rows: batch.rows.map(milestoneJson), next }
}

/* One page of `project`'s own user grants or team grants after `after`, at
 * most `limit`, in the order of their copies of the holder's name key, the
 * holder's id breaking ties, as Settings' Project access lists show them
 * (model/projectSettings.ts userGrantBatch and teamShareBatch, whose rows
 * hold only holders of the project's organization), within `ceiling`. Null
 * while the organization's name keys are not ready. */
async function grantPage(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  list: 'user_grants' | 'team_grants',
  limit: number,
  after: NamedAt | null,
  ceiling: ReadCeiling,
): Promise<RelatedPage<GrantJson> | null> {
  const tie = after === null ? null : idTieOf(after)
  const ask: ListAsk = {
    list: PROJECT_LIST_NAMES[list],
    scope: relatedScope(me, project),
    search: '',
    after: after === null || tie === null ? null : { key: after.key, tie },
    through: null,
  }
  const batch =
    list === 'user_grants'
      ? await userGrantBatch(ctx, project, ask, { limit, ceiling })
      : await teamShareBatch(ctx, project, ask, { limit, ceiling })
  if (batch.state === 'not_ready') return null
  return {
    rows: batch.rows.map((row) => ({ id: row.id, name: row.name, level: row.level })),
    next: batch.next,
  }
}

/* What a grant list's first page reads outside its batch's guard, the
 * organization's readiness and up to UNKEYED_MOST.rows grants or shares
 * without a name key, one lookup each (model/projectSettings.ts
 * unkeyedOrphans), so the details check that it fits before they ask. */
const preambleOf = (): { ranges: number; documents: number } => ({
  ranges: UNKEYED_MOST.rows + 2,
  documents: 2 * UNKEYED_MOST.rows + 2,
})

/**
 * The fields a single-project read adds: the lead (a sub-project without
 * its own is led by its parent's), the review time it sets and the one its
 * tasks get, delay tracking, its `completion` (lib/core.ts
 * projectCompletion), and the first page of each of its related lists, at
 * most DEFAULT_PAGE_SIZE rows each, with its cursor: the milestones of the
 * top-level project that stores them, by date, and the project's own user
 * grants and team grants by name, as the app's project settings show them
 * to anyone who can read or manage the project. A sub-project also
 * inherits its parent's grants. A grants page is not a description of
 * effective access, which the project user list answers.
 *
 * The three first pages read in that order within one bound,
 * lib/core.ts PROJECT_DETAILS, taken as transaction totals before the
 * first, so a write's answer reads them in the room its write left. A list
 * that finds the bound reached, a grants list whose readiness checks would
 * not fit, a grants list of an organization whose name keys are not ready
 * and a milestones list whose first day does not fit the request
 * (MILESTONE_READ_TOO_LARGE) answer no rows and a cursor at the list's
 * start, never a short list as complete, so neither a read nor a write
 * fails for them. Two grant rows of one holder on the project, which no
 * writer makes, fail the read as the grant lists do
 * (lib/namedPages.ts readBatch).
 *
 * `reads` false, a project the caller manages without reading, answers
 * `milestones` and their cursor null and reads no milestone.
 *
 * The read at the design size's sum, 1,000 user grants and 5 team shares
 * under 260 weekly milestones, is measured in lib/core.ts PROJECT_DETAILS'
 * docstring.
 */
async function projectDetail(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  completion: CompletionJson | null,
  reads: boolean,
): Promise<ProjectDetailJson> {
  const root = await rootMetaOf(ctx, project)
  const leadId = project.lead_id ?? root.lead_id
  const lead = leadId === undefined ? null : await byId(ctx, 'profiles', leadId)
  const effective = await reviewHoursFor(ctx, project)
  const ceiling = await namedCeiling(ctx, PROJECT_DETAILS)
  // the first page of `list`, or no rows and a cursor at its start where
  // the bound leaves no room for it (with `before` more read outside its
  // guard) or it cannot be read now
  const first = async <Row>(
    list: ProjectRelatedList,
    read: () => Promise<RelatedPage<Row> | null>,
    before = { ranges: 0, documents: 0 },
  ): Promise<RelatedPage<Row>> => {
    const room = await readsUnder(ctx, {
      ranges: ceiling.ranges - before.ranges,
      documents: ceiling.documents - before.documents,
      bytes: ceiling.bytes,
    })
    return (room ? await read() : null) ?? { rows: [], next: await startOf(me, project, list) }
  }
  const milestones = reads
    ? await first('milestones', async () => {
        try {
          return await milestonePage(ctx, me, project, DEFAULT_PAGE_SIZE, null, ceiling)
        } catch (e) {
          if (e instanceof ConvexError && (e.data as Refusal).reason === MILESTONE_READ_TOO_LARGE)
            return null
          throw e
        }
      })
    : null
  const users = await first(
    'user_grants',
    () => grantPage(ctx, me, project, 'user_grants', DEFAULT_PAGE_SIZE, null, ceiling),
    preambleOf(),
  )
  const teams = await first(
    'team_grants',
    () => grantPage(ctx, me, project, 'team_grants', DEFAULT_PAGE_SIZE, null, ceiling),
    preambleOf(),
  )
  return {
    lead_id: lead?.id ?? null,
    lead_name: lead?.name ?? null,
    review_hours: project.review_hours ?? null,
    effective_review_hours: effective,
    track_delay: project.track_delay,
    completion,
    milestones_next_cursor: milestones?.next ?? null,
    milestones: milestones?.rows ?? null,
    user_grants_next_cursor: users.next,
    team_grants_next_cursor: teams.next,
    grants: { users: users.rows, teams: teams.rows },
  }
}

/** The single-project read of REST GET /v1/projects/{ref} and MCP
 * get_project, which is the list row with the caller's `flag` plus the
 * single read's fields (projectDetail). `completion` reads the caller's
 * Completion, asked only where `flag.read` holds. A project the caller
 * manages without reading (`read` false) answers `completion`
 * UNAVAILABLE_COMPLETION, or null where it is archived, as for anyone, and
 * `milestones` null, never 0 of 0 or an empty list, and keeps its lead,
 * settings and grants, the management data the app's Settings page shows. */
export async function projectDetailJson(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  flag: AccessFlag,
  completion: () => Promise<CompletionJson | null>,
): Promise<ReturnType<typeof projectJson> & ProjectDetailJson> {
  const known = flag.read
    ? await completion()
    : project.archived_at === undefined
      ? UNAVAILABLE_COMPLETION
      : null
  return {
    ...projectJson(project, flag),
    ...(await projectDetail(ctx, me, project, known, flag.read)),
  }
}

/** The limit each related list's page takes and the noun its offset
 * refusal names (machine/shared.ts cursorPaging). */
const RELATED_PAGING: Record<ProjectRelatedList, { range: Limit; noun: string }> = {
  milestones: { range: LIMITS.listMilestones, noun: 'milestones' },
  user_grants: { range: LIMITS.listUserGrants, noun: 'user grants' },
  team_grants: { range: LIMITS.listTeamGrants, noun: 'team grants' },
}

/**
 * One page of the milestones of `project` for REST GET
 * /v1/projects/{ref}/milestones and MCP list_project_related, `paging`
 * checked (cursorPaging) and the project resolved afresh by the call. A
 * cursor of another list, project, caller or organization is refused with
 * CURSOR_REFUSAL. The page reads within MILESTONE_READ, so it can hold fewer
 * than `paging.limit` rows, or none, while its cursor is set, and next is
 * null only where the list ends. It reads no other list of the project.
 * Over 260 weekly milestones a page reads 2 index ranges and 202 documents
 * at limit 200 and 53 at 50 (convex/tests/projectDetails.test.ts, "reads at
 * the design size").
 */
export async function milestoneRows(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  paging: { limit: number; cursor: string | null },
): Promise<RelatedPage<MilestoneJson>> {
  const after =
    paging.cursor === null ? null : await openRelated(me, project, 'milestones', paging.cursor)
  return await milestonePage(ctx, me, project, paging.limit, after)
}

/**
 * One page of the user grants or team grants of `project` for REST GET
 * /v1/projects/{ref}/access/users and /access/teams and MCP
 * list_project_related, as milestoneRows pages milestones, within
 * NAMED_READ. Refused with NAMES_NOT_READY until the organization's names
 * are keyed, before the cursor is opened. Over 1,000 user grants a page
 * reads at most 205 index ranges and 403 documents at limit 200, one lookup
 * a holder, and 55 and 103 at 50; 5 team shares read 9 and 12
 * (convex/tests/projectDetails.test.ts, "reads at the design size").
 */
export async function grantRows(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  list: 'user_grants' | 'team_grants',
  paging: { limit: number; cursor: string | null },
): Promise<RelatedPage<GrantJson>> {
  if (!(await nameKeysReady(ctx, me.org_id))) throw rule(NAMES_NOT_READY)
  const after = paging.cursor === null ? null : await openRelated(me, project, list, paging.cursor)
  const page = await grantPage(ctx, me, project, list, paging.limit, after, await namedCeiling(ctx))
  if (page === null) throw rule(NAMES_NOT_READY)
  return page
}

/** projectDetailJson for one project the caller resolved itself, such as
 * one it just changed, for REST GET /v1/projects/{ref}, MCP get_project and
 * the answers of project creates and updates. It reads the project and the
 * caller's access to it alone, through one lib/access.ts accessOf
 * instance: the flag from the caller's level on it (lib/core.ts flagOf),
 * `read` false for a project the caller manages without reading, and the
 * completion from what that instance shows (lib/core.ts
 * projectCompletion). A check a bound of OWN_READS stopped while it reads
 * the level rejects with accessUnchecked, which refuses the whole call and
 * rolls back a write, since a flag cannot be guessed; one inside the
 * completion answers it `unavailable`. A project the call `created` holds
 * no tasks, so its completion reads none. What it reads does not grow with
 * the organization. A lead's read of a top-level project with two
 * sub-projects, and a PATCH that archives and then restores it, read the
 * same ranges and documents in an organization at the catalogue's sum as
 * in an everyday one (convex/tests/machineProjects.test.ts, "reads at the
 * design size"). */
export async function projectRead(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  access: CredentialAccess,
  o: { created?: boolean } = {},
) {
  const sight = accessOf(ctx, me, [project])
  const flag = flagOf(me, access, await sight.level(project.id))
  return await projectDetailJson(ctx, me, project, flag, async () =>
    o.created === true ? NO_TASKS : await projectCompletion(ctx, project, sight),
  )
}

/* ------------------------------------------------------------- the lists */

/** The list name REST GET /v1/projects and MCP list_projects seal their
 * cursors with (lib/listCursor.ts). Both answer the same rows, so a cursor
 * of one continues on the other. */
export const PROJECTS_LIST = 'machine.projects'

/** A position's tie in the project list: the top-level project's id and,
 * inside its sub-projects, a sub-project's key and id, else two empty
 * strings, so a top-level project comes before its sub-projects. */
export type ProjectTie = readonly [rootId: string, subKey: string, subId: string]

/** The tie of position `at` of the project list, or null where it is not
 * one. A tie is three strings, the last two both empty or both set. This
 * checks the shape alone, as model/nameKeys.ts idTieOf does for the other
 * lists. The cursor is sealed, so only this list's own positions open, and
 * they hold stored project ids, which app creates once wrote in any form
 * the client sent (lib/db.ts assertNewRowId came later), so a position at
 * an id that is not a UUID still continues its list. */
export function projectTieOf({ tie }: NamedAt): ProjectTie | null {
  if (tie.length !== 3) return null
  const [rootId, subKey, subId] = tie
  if (typeof rootId !== 'string' || typeof subKey !== 'string' || typeof subId !== 'string')
    return null
  return (subKey === '') === (subId === '') ? [rootId, subKey, subId] : null
}

/** What a page of the project list is asked, checked (machine/shared.ts
 * namedPaging and the archived flag). */
export type ProjectPageArgs = {
  archived: boolean
  search: string
  limit: number
  cursor: string | null
}

/** One page of the project list, as REST GET /v1/projects and MCP
 * list_projects answer it, the cursor first. */
export type ProjectsPageJson = {
  next_cursor: string | null
  projects: ReturnType<typeof projectJson>[]
}

/* A top-level project the walk passed, with whether the caller sees it for
 * a reason of their own (lib/access.ts accessible), which decides where its
 * sub-projects come from. */
type WalkRoot = { project: Doc<'projects'>; own: boolean }

/* A row the walk hands out: a reach row of the caller or one of their
 * teams, or a sub-project of a top-level project they see for a reason of
 * their own. */
type WalkRow = Doc<'project_reach'> | Doc<'projects'>

/* `stream`'s rows at the positions `at` gives them. */
async function* placed<Row>(
  stream: NamedStream<Row>,
  at: (inner: NamedAt) => NamedAt,
): AsyncGenerator<Named<Row> | typeof STOPPED> {
  for await (const item of stream)
    yield item === STOPPED ? STOPPED : { row: item.row, at: at(item.at) }
}

/**
 * One page of the projects `me` can see for REST GET /v1/projects and MCP
 * list_projects, on one side of the archive axis, after `p.cursor`, the
 * next_cursor of an earlier page, at most `p.limit` of them, each as
 * lib/core.ts projectJson with the caller's flags (flagOf, through a
 * credential of `access`).
 *
 * The order is the tree's: each top-level project by key, followed by its
 * sub-projects on the list by key, the project ids breaking ties (owner,
 * 28 October 2026). Keys compare by their UTF-8 bytes (lib/namedPages.ts
 * compareNamed), so digits come before capital letters and a key before
 * the longer keys it begins. A position is the top-level project's key
 * with a tie of its id and, inside its sub-projects, a sub-project's key
 * and id (ProjectTie).
 *
 * Who is listed. The active list (`archived` false) holds every live
 * top-level project the caller sees by lib/access.ts canSeeProject's rule
 * (accessOf visible), navigation included, so also one seen only through
 * an archived sub-project, and every live sub-project they see. The
 * archived list holds every archived top-level project they see, each
 * followed by its archived sub-projects they see, and the archived
 * sub-projects they see of a live top-level project, at that project's
 * place without its row. That is the membership the organization's
 * catalogue gave (lib/core.ts accessFlags), so an organization admin's
 * pages hold only what their own leads, grants and team shares reach, as
 * anyone's.
 *
 * `p.search`, when not blank, keeps the projects whose own name holds
 * every whitespace-separated word of it in any order, ignoring case and
 * accents (lib/search.ts allWordsMatcher over lib/nameKey.ts nameKey of
 * both), or whose key is the whole search, ignoring case, over the whole
 * list on the server before the page is cut. Each row is matched on its
 * own, so a matching top-level project brings none of its sub-projects and
 * a matching sub-project shows at its place without its parent's row. It
 * reads no task and no file.
 *
 * What a page reads. The organization's readiness (model/projectNav.ts
 * reachReady, refused with PROJECTS_NOT_READY until its reach rows and
 * archive states are written), the seat's memberships (seatSight, refused
 * past PROJECT_NAV.teams), and the root reach rows of the seat and of its
 * teams in key order (model/projectNavReads.ts rootKeyIndex), the live
 * ones and in the archived list the archived ones too, merged with one row
 * for a project several of them reach. Each row is handed out at its
 * position and judged in `keep`, which reads its project, checks that the
 * row holds its copies (organization, a root row of a top-level meta, live
 * state, key and name key), asks accessible and, for one seen only for
 * navigation, visible, so a failing row shows nothing and still moves the
 * page. Then that project's sub-projects of the list's archive state:
 * where the caller sees it for a reason of their own every one of them
 * inherits that level, so they come from the project's own index
 * (subKeyIndex); otherwise only from the child reach rows of the seat and
 * its teams under it (childKeyIndex), each row's project read and its
 * copies checked, so the walk never reads a sub-project the caller cannot
 * see. Every row on a page passes visible on this call, whatever the
 * cursor and the reach rows say. It never reads the organization's project
 * set or a task.
 *
 * The page reads within NAMED_READ past what the call read before it
 * (lib/namedPages.ts namedCeiling), always reads its first row, and stops
 * early with a cursor once the budget is spent, so a short or empty page
 * is never the end and next_cursor is null only once the walk ended. A
 * check a bound of OWN_READS stopped rejects with accessUnchecked, which
 * refuses the whole call, never a page missing a project. Where a page
 * stops can reflect how many top-level projects the caller reaches
 * through their own and their teams' rows, including projects whose check
 * says no, as for the navigation reads; never a project they do not reach.
 *
 * The cursor is sealed with the organization, `me`, the side and the
 * search's name key (lib/listCursor.ts namedScope), so it opens only for
 * that list, on either surface, and "Café" and "cafe" share cursors; any
 * other cursor, or a changed one, is refused with CURSOR_REFUSAL. Pages
 * are not a snapshot: a project created, renamed in its key, archived,
 * restored, shared or unshared while a caller pages can be missed or shown
 * on a later page until the caller starts again. A cursor's own top-level
 * project is read again by id and its sub-projects after the cursor
 * follow; one gone, no longer a top-level meta of the organization, given
 * another key or archived under the active list is passed over.
 *
 * What a page read at the design size, in index ranges and documents as
 * Convex counts them (convex/tests/machineProjects.test.ts, "reads at the
 * design size"), every page answered and none refused:
 * - grants on 200 top-level projects and the 200 sub-projects the person
 *   reads beneath 67 of them: at limit 200, 337 ranges and 464 documents,
 *   then 542 and 665; at 50, at most 190 and 187 a page; a search that
 *   matches nothing, one page of 637 and 963;
 * - 200 sub-projects through grants on them beneath 67 projects seen only
 *   for navigation: at 200, 589 ranges and 982 documents, then 228 and 354;
 *   a search that matches nothing, 437 and 568;
 * - the archived list at its sum, 200 live and 300 archived top-level
 *   projects with grants and 500 archived sub-projects, half beneath each:
 *   at 200, at most 638 ranges and 761 documents a page; a search that
 *   matches nothing, one page of 1,538 and 2,163, the most of any case;
 *   through grants on the 500 sub-projects alone, at most 738 and 1,166, and
 *   1,288 and 1,663 for a search that matches nothing;
 * - one team sharing 50 live and 150 archived projects of 3 sub-projects
 *   each: at 200, 171 ranges and 463 documents active, at most 273 and 587
 *   archived;
 * - a member of 5 teams each sharing 20 sub-projects: 495 and 578, and 415
 *   and 382 for a search that matches nothing;
 * - one project with 30 live and 40 archived sub-projects: at most 10
 *   ranges a page of one, 67 and 70 at 200;
 * - an everyday person reads the same in an organization at the
 *   catalogue's sum (2,000 projects) as in an everyday one, 33 ranges and
 *   19 documents active and 16 and 10 archived.
 * The largest answer, 200 rows, is about 57 KB on REST and 82 KB as MCP's
 * pretty text.
 */
export async function projectPage(
  ctx: QueryCtx,
  me: Caller,
  access: CredentialAccess,
  p: ProjectPageArgs,
): Promise<ProjectsPageJson> {
  if (!(await reachReady(ctx, me.org_id))) throw rule(PROJECTS_NOT_READY)
  const scope = await namedScope(me, p.search, [p.archived ? 'archived' : 'active'])
  let after: NamedAt<ProjectTie> | null = null
  if (p.cursor !== null) {
    const at = await openNamedCursor(p.cursor, PROJECTS_LIST, scope)
    const tie = at === null ? null : projectTieOf(at)
    if (at === null || tie === null) throw badRequest(CURSOR_REFUSAL)
    after = { key: at.key, tie }
  }
  const sight = seatSight(ctx, me, true)
  const words = allWordsMatcher(nameKey(p.search))
  const whole = nameKey(p.search.trim())
  const matches = (q: Doc<'projects'>) =>
    words(nameKey(q.name)) || (whole !== '' && whole === nameKey(q.key))
  const onSide = (q: Doc<'projects'>) => (q.archived_at !== undefined) === p.archived
  // the top-level projects the walk passed, recorded as they are judged
  const roots = new Map<string, WalkRoot>()
  const judge = async (project: Doc<'projects'>): Promise<WalkRoot> => {
    const root = { project, own: await sight.access.accessible(project.id) }
    roots.set(project.id, root)
    return root
  }
  // the sub-projects on the list of `root` after `subAfter`, at their
  // places, or null where it has none on this side
  const subs = (
    root: WalkRoot,
    subAfter: NamedAt<IdTie> | null,
    reads: NamedReads,
  ): NamedStream<WalkRow> | null => {
    const parent = root.project
    const live = parent.archived_at === undefined
    // a live project never sits under an archived one
    if (!p.archived && !live) return null
    const state: ArchiveState = !p.archived ? 'live' : live ? 'listed' : 'under'
    const inner: NamedStream<WalkRow> = root.own
      ? indexAfter(subKeyIndex(ctx, parent, state), subAfter)(reads)
      : (async function* () {
          const grantees = await sight.grantees()
          yield* mergeNamed(
            grantees.map((g) =>
              indexAfter(childKeyIndex(ctx, g, parent.id, !p.archived), subAfter)(reads),
            ),
            { ties: 'first', reads },
          )
        })()
    return placed(inner, (at) => ({ key: parent.key, tie: [parent.id, at.key, ...at.tie] }))
  }
  const stream = (reads: NamedReads): NamedStream<WalkRow> =>
    (async function* () {
      if (after !== null) {
        // the cursor's own top-level project, read again and never handed
        // out again, then its sub-projects after the cursor
        const [rootId, subKey, subId] = after.tie
        const r0 = await sight.project(rootId)
        if (
          r0 !== null &&
          r0.org_id === me.org_id &&
          inMetaTree(r0, r0) &&
          r0.key === after.key &&
          (p.archived || r0.archived_at === undefined)
        ) {
          const subAfter = subKey === '' ? null : { key: subKey, tie: [subId] as const }
          const rest = subs(await judge(r0), subAfter, reads)
          if (rest !== null)
            for await (const item of rest) {
              yield item
              if (item === STOPPED) return
            }
        }
      }
      const rootAfter = after === null ? null : { key: after.key, tie: [after.tie[0]] as const }
      const lives = p.archived ? [true, false] : [true]
      const grantees = await sight.grantees()
      const rows = mergeNamed(
        grantees.flatMap((g) =>
          lives.map((live) => indexAfter(rootKeyIndex(ctx, g, live), rootAfter)(reads)),
        ),
        { ties: 'first', reads },
      )
      for await (const item of rows) {
        if (item === STOPPED) {
          yield STOPPED
          return
        }
        const row = item.row
        yield { row, at: { key: row.key, tie: [row.project_id, '', ''] } }
        // keep judged the row before the batch asked for more (readBatch)
        const root = roots.get(row.project_id)
        const rest = root === undefined ? null : subs(root, null, reads)
        if (rest !== null)
          for await (const sub of rest) {
            yield sub
            if (sub === STOPPED) return
          }
      }
    })()
  // the project a root reach row names, when the row holds its copies
  const rootOf = async (row: Doc<'project_reach'>): Promise<Doc<'projects'> | null> => {
    if (row.org_id !== me.org_id || row.kind !== 'root' || row.root_id !== row.project_id)
      return null
    const project = await sight.project(row.project_id)
    if (project === null || project.id !== row.project_id || project.org_id !== row.org_id)
      return null
    if (!inMetaTree(project, project) || (project.archived_at === undefined) !== row.live)
      return null
    return project.key === row.key && nameKey(project.name) === row.name_key ? project : null
  }
  // the sub-project a child reach row under `parent` names, when the row
  // holds its copies
  const childOf = async (
    parent: Doc<'projects'>,
    row: Doc<'project_reach'>,
  ): Promise<Doc<'projects'> | null> => {
    if (row.org_id !== me.org_id || row.kind !== 'child' || row.root_id !== parent.id) return null
    const sub = await sight.project(row.project_id)
    if (sub === null || sub.id !== row.project_id || (sub.archived_at === undefined) !== row.live)
      return null
    return sub.key === row.key && nameKey(sub.name) === row.name_key ? sub : null
  }
  const shown = async (q: Doc<'projects'>) =>
    projectJson(q, flagOf(me, access, await sight.access.level(q.id)))
  const judged = async (row: WalkRow, at: NamedAt) => {
    if (at.tie[1] === '') {
      // a top-level project's own row, always a root reach row
      if (!('grantee_kind' in row)) return null
      const project = await rootOf(row)
      if (project === null) return null
      const root = await judge(project)
      if (!onSide(project) || !matches(project)) return null
      if (!root.own && !(await sight.access.visible(project.id))) return null
      return await shown(project)
    }
    const root = roots.get(String(at.tie[0]))
    if (root === undefined) return null
    const sub = 'grantee_kind' in row ? await childOf(root.project, row) : row
    if (sub === null || sub.org_id !== me.org_id || sub.parent_id !== root.project.id) return null
    if (!onSide(sub) || !matches(sub)) return null
    sight.access.seen(sub)
    return (await sight.access.visible(sub.id)) ? await shown(sub) : null
  }
  const keep = async (row: WalkRow, guard: ReadGuard, at: NamedAt) => {
    const out = await judged(row, at)
    // the access checks' reads are not counted one at a time
    await guard.settle()
    return out
  }
  const batch = await listBatch(
    ctx,
    { list: PROJECTS_LIST, scope, after, through: null },
    { stream, keep, limit: p.limit, ceiling: await namedCeiling(ctx) },
  )
  return { next_cursor: batch.next, projects: batch.rows }
}

/* ------------------------------------------------------------------ refs */

/* The project `ref` names (uuid, number or key) when the caller can read it,
 * else null. The milestone tools and routes resolve with it. */
async function readableProject(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<Doc<'projects'> | null> {
  const project = await findProject(ctx, me, ref)
  return project !== null && (await canSeeProject(ctx, me, project)) ? project : null
}

/** The project `ref` names (uuid, number or key) in the caller's
 * organization when the caller manages it (lib/access.ts
 * canManageOwnProjectAccess: an active seat in a meta tree, an organization
 * admin or the project's effective lead) or can read it, else null. The
 * management actions resolve with it, as the app's Settings pages reach a
 * project by management; it asks management first, which reads the root
 * alone, and the level only of a project the caller does not manage. */
export async function managedProject(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<Doc<'projects'> | null> {
  const project = await findProject(ctx, me, ref)
  if (project === null) return null
  if (await canManageOwnProjectAccess(ctx, me, project)) return project
  return (await canSeeProject(ctx, me, project)) ? project : null
}

/** A profile uuid in the caller's organization, else null. */
export async function orgProfile(ctx: QueryCtx, me: Caller, ref: string) {
  if (!UUID.test(ref)) return null
  const profile = await byId(ctx, 'profiles', ref.toLowerCase())
  return profile !== null && profile.org_id === me.org_id ? profile : null
}

/** A team uuid in the caller's organization, else null. */
export async function orgTeam(ctx: QueryCtx, me: Caller, ref: string) {
  if (!UUID.test(ref)) return null
  const team = await byId(ctx, 'teams', ref.toLowerCase())
  return team !== null && team.org_id === me.org_id ? team : null
}

/* The milestone `ref` on `project`'s top-level project, which the caller may
 * change, else null when there is no such milestone there. */
async function milestoneOn(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  ref: string,
): Promise<Doc<'milestones'> | null> {
  const root = await rootMetaOf(ctx, project)
  const row = UUID.test(ref) ? await byId(ctx, 'milestones', ref.toLowerCase()) : null
  if (row === null || row.project_id !== root.id) return null
  return (await changeableMilestone(ctx, me, row.id)).milestone
}

/* --------------------------------------------------------------- changes */

/* What a create carries, once each surface has parsed and resolved it. */
type CreateInput = {
  name: string
  parent?: Doc<'projects'>
  lead_id?: string
  description?: string | null
}

/* A new project or, under `parent`, sub-project, by createProjectCore. */
const createFrom = (ctx: MutationCtx, me: Caller, input: CreateInput, provenance: string) =>
  createProjectCore(ctx, {
    me,
    now: new Date().toISOString(),
    provenance,
    project: {
      id: newUuid(),
      type: input.parent === undefined ? 'meta' : 'project',
      parent_id: input.parent?.id,
      name: input.name,
      lead_id: input.lead_id,
      description: input.description,
    },
  })

/* The fields update_project and PATCH /v1/projects/{ref} change, and what
 * the caller read of them (model/expected.ts). */
type UpdateInput = Pick<
  ProjectPatch,
  'name' | 'description' | 'review_hours' | 'track_delay' | 'lead_id'
> & { archived?: boolean; expected?: Readonly<Record<string, unknown>> }

/**
 * Applies an update in one transaction. The restore or archive runs first,
 * while the caller still holds the Lead access that a lead handover in the
 * same update gives away, so a restore also lets the rest land on an active
 * project. The fields and the lead follow (updateProjectCore). Each step keeps
 * its own rule and activity row. Returns the project as stored.
 */
async function applyUpdate(
  ctx: MutationCtx,
  me: Caller,
  project: Doc<'projects'>,
  input: UpdateInput,
  provenance: string,
): Promise<Doc<'projects'>> {
  const now = new Date().toISOString()
  const { archived, expected, ...patch } = input
  // the archive or restore and the rename share one tree budget
  // (model/projectNav.ts TreeBudget), as one transaction runs both, and
  // the favorites they read are written once, after both
  const budget = treeBudget()
  let current = project
  if (archived !== undefined) {
    const step = { me, project: current, now, provenance, budget }
    if (archived) await archiveProjectCore(ctx, step)
    else await unarchiveProjectCore(ctx, step)
    current = (await ctx.db.get(current._id)) ?? current
  }
  if (Object.keys(patch).length > 0) {
    current = await updateProjectCore(ctx, {
      me,
      project: current,
      patch,
      now,
      provenance,
      expected,
      view: 'machine',
      budget,
    })
  }
  await settleFavorites(ctx, budget)
  return current
}

export type HoldingJson = {
  id: string
  key: string
  title: string
  user_id: string
  role: 'assignee' | 'reviewer'
}

/** One open task someone holds, as removalJson's `stranded` and
 * `reassigned` lists name it, for a caller who can see its project. */
export const holdingJson = (h: Holding): HoldingJson => ({
  id: h.task.id,
  key: issueKey(h.task.num),
  title: h.task.title,
  user_id: h.profile_id,
  role: h.role,
})

/* The subject as the result names it. */
const subjectJson = (subject: AccessSubject) =>
  'team' in subject
    ? { team: { id: subject.team.id, name: subject.team.name } }
    : { user: { id: subject.profile.id, name: subject.profile.name } }

/** The open tasks of a removal's result that the caller cannot see: how
 * many distinct tasks, and their holders' ids, never a task's id, key or
 * title. */
export type HiddenHoldingsJson = { tasks: number; user_ids: string[] }

/** A removal's result fields, for REST and MCP project access and team
 * member removals. `stranded` and `reassigned` list only the holdings whose
 * task's project `me` can see once the removal is written, which for a
 * caller who removed their own access leaves out what they no longer see,
 * and `hidden` counts the distinct tasks left out and names their holders,
 * so a caller without access learns the counts and the owners and no
 * title (the owner's rule for an admin without Edit). The sight is one
 * lib/access.ts accessOf instance asked about the distinct projects of the
 * holdings, at most the projects the removal reaches: a top-level project
 * and its sub-projects for a project grant, 70 at the design size, or for
 * a team member every project the team shares and their sub-projects, up
 * to 50 live projects shared with one team at the design size. A check
 * that stops (accessUnchecked) counts its task as hidden, so nothing shows
 * that may not be seen. */
export async function removalJson(
  ctx: QueryCtx,
  me: Caller,
  r: Pick<AccessRemoval, 'stranded' | 'kept_as_viewer' | 'reassigned'>,
): Promise<{
  stranded: HoldingJson[]
  kept_as_viewer: string[]
  reassigned: HoldingJson[]
  hidden: HiddenHoldingsJson
}> {
  const access = accessOf(ctx, me)
  const sight = new Map<string, Promise<boolean>>()
  const sees = (projectId: string) => {
    let known = sight.get(projectId)
    if (known === undefined) {
      known = access.visible(projectId).catch((e: unknown) => {
        if (isAccessUnchecked(e)) return false
        throw e
      })
      sight.set(projectId, known)
    }
    return known
  }
  const hiddenTasks = new Set<string>()
  const holders = new Set<string>()
  const shown = async (holdings: readonly Holding[]) => {
    const out: HoldingJson[] = []
    for (const h of holdings) {
      if (await sees(h.task.project_id)) out.push(holdingJson(h))
      else {
        hiddenTasks.add(h.task.id)
        holders.add(h.profile_id)
      }
    }
    return out
  }
  const stranded = await shown(r.stranded)
  const reassigned = await shown(r.reassigned)
  return {
    stranded,
    kept_as_viewer: r.kept_as_viewer,
    reassigned,
    hidden: { tasks: hiddenTasks.size, user_ids: [...holders] },
  }
}

/* --------------------------------------------------------- MCP sentences */

const mcpProjectMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`project "${ref}" not found (or not visible to you)`)
const mcpMilestoneMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`milestone "${ref}" not found (or not visible to you)`)
const mcpUserMissing = (ref: string): ConvexError<Refusal> =>
  badRequest(`user "${ref}" not found in your organization`)
const mcpTeamMissing = (ref: string): ConvexError<Refusal> =>
  badRequest(`team "${ref}" not found in your organization`)

/* An MCP project ref the caller can read, for the milestone tools. */
async function mcpProject(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await readableProject(ctx, me, ref)
  if (project === null) throw mcpProjectMissing(ref)
  return project
}

/* An MCP project ref the caller reads or manages (managedProject), for the
 * management tools. */
async function mcpManaged(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await managedProject(ctx, me, ref)
  if (project === null) throw mcpProjectMissing(ref)
  return project
}

/* An MCP lead_id, lowercased, when it names someone in the organization. */
async function mcpLead(ctx: QueryCtx, me: Caller, ref: string | undefined) {
  if (ref === undefined) return undefined
  const profile = await orgProfile(ctx, me, ref)
  if (profile === null) throw mcpUserMissing(ref)
  return profile.id
}

/* The one user or team set_project_access names, in the organization. */
async function mcpSubject(
  ctx: QueryCtx,
  me: Caller,
  a: { user_id?: string; team_id?: string },
): Promise<AccessSubject> {
  if (a.user_id !== undefined && a.team_id === undefined) {
    const profile = await orgProfile(ctx, me, a.user_id)
    if (profile === null) throw mcpUserMissing(a.user_id)
    return { profile }
  }
  if (a.team_id !== undefined && a.user_id === undefined) {
    const team = await orgTeam(ctx, me, a.team_id)
    if (team === null) throw mcpTeamMissing(a.team_id)
    return { team }
  }
  throw badRequest('name exactly one of user_id and team_id')
}

/* ------------------------------------------------------ MCP internal fns */

/* get_project: one project the caller reads or manages, with the caller's
 * access, its lead, settings, milestones and grants, and for a project they
 * only manage neither milestones nor completion (projectDetailJson). */
export const mcpGetProject = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, project: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpManaged(ctx, me, a.project)
    return pretty(await projectRead(ctx, me, project, a.access))
  },
})

/* list_project_related: one page of a project's milestones (a project the
 * caller reads, as the milestone tools resolve it) or of its user or team
 * grants (one the caller reads or manages, as get_project resolves it),
 * the cursor first (milestoneRows and grantRows). */
export const mcpProjectRelated = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    list: v.union(v.literal('milestones'), v.literal('user_grants'), v.literal('team_grants')),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const { range, noun } = RELATED_PAGING[a.list]
    const paging = cursorPaging(range, noun, a)
    const project =
      a.list === 'milestones'
        ? await mcpProject(ctx, me, a.project)
        : await mcpManaged(ctx, me, a.project)
    const page =
      a.list === 'milestones'
        ? await milestoneRows(ctx, me, project, paging)
        : await grantRows(ctx, me, project, a.list, paging)
    return pretty({ next_cursor: page.next, [a.list]: page.rows })
  },
})

/* create_project: a project, or a sub-project under `parent`. */
export const mcpCreateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    name: v.string(),
    parent: v.optional(v.string()),
    lead_id: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    let parent: Doc<'projects'> | undefined
    if (a.parent !== undefined) {
      const found = await managedProject(ctx, me, a.parent)
      if (found === null) {
        throw notFound(`parent project "${a.parent}" not found (or not visible to you)`)
      }
      parent = found
    }
    const lead_id = await mcpLead(ctx, me, a.lead_id)
    const input = { name: a.name, parent, lead_id, description: a.description }
    const project = await createFrom(ctx, me, input, MCP_PROVENANCE)
    return pretty(await projectRead(ctx, me, project, a.access, { created: true }))
  },
})

/* update_project: settings, the lead and archive/restore of one project.
 * An argument the schema does not know, such as an `archive_reason` only
 * tasks take, is refused before this runs (mcp.ts validateArgs). */
export const mcpUpdateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    review_hours: v.optional(v.union(v.number(), v.null())),
    track_delay: v.optional(v.boolean()),
    lead_id: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpManaged(ctx, me, a.project)
    const { callerId: _caller, access: _access, project: _ref, lead_id, expected, ...fields } = a
    const input: UpdateInput = fields
    if (lead_id !== undefined) input.lead_id = await mcpLead(ctx, me, lead_id)
    if (Object.keys(input).length === 0) throw badRequest('no fields to update')
    if (expected !== undefined) input.expected = expected
    const after = await applyUpdate(ctx, me, project, input, MCP_PROVENANCE)
    return pretty(await projectRead(ctx, me, after, a.access))
  },
})

/* set_project_access: one user's or one team's access, or its removal. A
 * removal is an access removal for the read-only gate (asMachineCaller), as
 * in the app. */
export const mcpSetProjectAccess = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    user_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    level: v.union(vGrantLevel, v.null()),
    on_held_tasks: v.optional(vHeldTasks),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const write = a.level === null ? 'access_removal' : 'change'
    const me = await asMachineCaller(ctx, a.callerId, a.access, write)
    if (a.level !== null && a.on_held_tasks !== undefined) {
      throw badRequest('on_held_tasks applies only when level is null')
    }
    if (a.level === null && a.expected !== undefined) {
      throw badRequest('expected applies only when level is not null')
    }
    const project = await mcpManaged(ctx, me, a.project)
    const subject = await mcpSubject(ctx, me, a)
    const now = new Date().toISOString()
    const base = { project: project.key, ...subjectJson(subject) }
    if (a.level !== null) {
      const { changed } = await setProjectGrantCore(ctx, {
        me,
        project,
        subject,
        level: a.level,
        now,
        provenance: MCP_PROVENANCE,
        expected: a.expected,
      })
      return pretty({ ...base, level: a.level, changed })
    }
    const removal = await removeProjectGrantCore(ctx, {
      me,
      project,
      subject,
      held: a.on_held_tasks ?? 'leave',
      now,
      provenance: MCP_PROVENANCE,
    })
    return pretty({
      ...base,
      level: null,
      changed: removal.removed,
      ...(await removalJson(ctx, me, removal)),
    })
  },
})

/* set_milestone: add a milestone, or rename or move one. */
export const mcpSetMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    milestone: v.optional(v.string()),
    name: v.optional(v.string()),
    date: v.optional(v.string()),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    if (a.milestone === undefined && a.expected !== undefined) {
      throw badRequest(createExpectedSentence('milestone'))
    }
    const project = await mcpProject(ctx, me, a.project)
    const week = a.date === undefined ? undefined : cleanMilestoneDate(a.date)
    const now = new Date().toISOString()
    if (a.milestone === undefined) {
      if (a.name === undefined || week === undefined) {
        throw badRequest('a new milestone needs name and date')
      }
      const m = await addMilestoneCore(ctx, {
        me,
        id: newUuid(),
        projectId: project.id,
        name: a.name,
        week,
        now,
        provenance: MCP_PROVENANCE,
      })
      return pretty({ ...milestoneJson(m), project_id: m.project_id, created: true })
    }
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw mcpMilestoneMissing(a.milestone)
    if (a.name === undefined && week === undefined) throw badRequest('no fields to update')
    const m = await updateMilestoneCore(ctx, {
      me,
      milestone,
      patch: { name: a.name, week },
      now,
      provenance: MCP_PROVENANCE,
      expected: a.expected,
      view: 'machine',
    })
    return pretty({ ...milestoneJson(m), project_id: m.project_id, created: false })
  },
})

/* delete_milestone: remove one milestone. */
export const mcpDeleteMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    milestone: v.string(),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw mcpMilestoneMissing(a.milestone)
    await removeMilestoneCore(ctx, {
      me,
      milestone,
      now: new Date().toISOString(),
      provenance: MCP_PROVENANCE,
      expected: a.expected,
      view: 'machine',
    })
    return pretty({ deleted: true, id: milestone.id })
  },
})

/* -------------------------------------------------------- REST parsing */

/* A REST project path ref the caller can read, else the one 404, for the
 * milestone routes. */
async function restProject(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await readableProject(ctx, me, ref)
  if (project === null) throw notFound('project not found')
  return project
}

/* A REST project path ref the caller reads or manages (managedProject),
 * else the one 404, for the management routes. */
async function restManaged(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await managedProject(ctx, me, ref)
  if (project === null) throw notFound('project not found')
  return project
}

/* The paging of a REST list of a project, as text. */
const vRestPaging = {
  limit: v.optional(v.string()),
  cursor: v.optional(v.string()),
  offset: v.optional(v.string()),
}

/* GET /v1/projects/{ref}/milestones: one page of the top-level project's
 * milestones of a project the caller reads, `{next_cursor, milestones}`
 * (milestoneRows). An empty cursor is taken as absent. */
export const restListMilestones = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), ...vRestPaging },
  handler: async (ctx, a): Promise<{ next_cursor: string | null; milestones: MilestoneJson[] }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const paging = cursorPaging(LIMITS.listMilestones, 'milestones', {
      ...a,
      cursor: a.cursor || undefined,
    })
    const project = await restProject(ctx, me, a.ref)
    const page = await milestoneRows(ctx, me, project, paging)
    return { next_cursor: page.next, milestones: page.rows }
  },
})

/* GET /v1/projects/{ref}/access/users: one page of the user grants of a
 * project the caller reads or manages, `{next_cursor, user_grants}`. */
export const restListUserGrants = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), ...vRestPaging },
  handler: async (ctx, a): Promise<{ next_cursor: string | null; user_grants: GrantJson[] }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const paging = cursorPaging(LIMITS.listUserGrants, 'user grants', {
      ...a,
      cursor: a.cursor || undefined,
    })
    const project = await restManaged(ctx, me, a.ref)
    const page = await grantRows(ctx, me, project, 'user_grants', paging)
    return { next_cursor: page.next, user_grants: page.rows }
  },
})

/* GET /v1/projects/{ref}/access/teams: one page of the team grants of a
 * project the caller reads or manages, `{next_cursor, team_grants}`. */
export const restListTeamGrants = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), ...vRestPaging },
  handler: async (ctx, a): Promise<{ next_cursor: string | null; team_grants: GrantJson[] }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const paging = cursorPaging(LIMITS.listTeamGrants, 'team grants', {
      ...a,
      cursor: a.cursor || undefined,
    })
    const project = await restManaged(ctx, me, a.ref)
    const page = await grantRows(ctx, me, project, 'team_grants', paging)
    return { next_cursor: page.next, team_grants: page.rows }
  },
})

/* A project's parent never changes. A subtask stays in its parent task's
 * top-level project (model/issues.ts parentChainCheck), so allowing a
 * sub-project to change parent would have to carry that rule along, because
 * its tasks' families can span its siblings. */
const PARENT_AT_CREATION = "a project's parent is set when it is created, with parent"

/* Projects have no comment thread, so archiving one takes no reason. */
const NO_PROJECT_ARCHIVE_REASON =
  'only tasks take an archive reason; archive a project with archived alone'

/* Fields a project body may not write, each refused with where to go
 * instead rather than ignored. */
function refuseProjectFields(b: Record<string, unknown>): void {
  if ('access' in b || 'team_access' in b) {
    throw badRequest('give access one user or team at a time, under /v1/projects/{ref}/access')
  }
  if ('key' in b) throw badRequest("a project's key comes from its name and cannot be written")
  if ('parent_id' in b || 'type' in b) throw badRequest(PARENT_AT_CREATION)
}

/* A REST body's lead_id: a profile uuid in the organization, lowercased. */
async function restLead(ctx: QueryCtx, me: Caller, b: Record<string, unknown>) {
  if (!('lead_id' in b)) return undefined
  if (typeof b.lead_id !== 'string' || !UUID.test(b.lead_id)) {
    throw badRequest('lead_id must be a profile uuid')
  }
  const profile = await orgProfile(ctx, me, b.lead_id)
  if (profile === null) throw badRequest(`user "${b.lead_id}" not found in your organization`)
  return profile.id
}

/* A REST body's description: a string, or null for none. */
function restDescription(b: Record<string, unknown>): string | null | undefined {
  if (!('description' in b)) return undefined
  const description = b.description
  if (description === null) return null
  if (typeof description === 'string') return description
  throw badRequest('description must be a string')
}

/* A REST body's `level`: user or viewer. */
function restLevel(b: Record<string, unknown>): GrantLevel {
  if (b.level === 'user' || b.level === 'viewer') return b.level
  throw badRequest('level must be user or viewer; DELETE removes access')
}

/* A REST access path's person or team, else its 404. */
async function restSubject(
  ctx: QueryCtx,
  me: Caller,
  kind: 'users' | 'teams',
  ref: string,
): Promise<AccessSubject> {
  if (kind === 'users') {
    const profile = await orgProfile(ctx, me, ref)
    if (profile === null) throw notFound('user not found')
    return { profile }
  }
  const team = await orgTeam(ctx, me, ref)
  if (team === null) throw notFound('team not found')
  return { team }
}

/* ----------------------------------------------------- REST internal fns */

/* POST /v1/projects {name, parent?, lead_id?, description?}. */
export const restCreateProject = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, keyName: vKeyName, body: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const b = needJson(a.body)
    refuseProjectFields(b)
    refuseCreateExpected(b, 'project')
    refuseUnknownFields(b, ['name', 'parent', 'lead_id', 'description'])
    if (!('name' in b)) throw badRequest('name is required')
    if (typeof b.name !== 'string') throw badRequest('name must be a string')
    let parent: Doc<'projects'> | undefined
    if ('parent' in b && b.parent !== null) {
      // an unknown parent and one the caller neither reads nor manages
      // answer alike
      const found = typeof b.parent === 'string' ? await managedProject(ctx, me, b.parent) : null
      if (found === null) throw badRequest('parent project not found')
      parent = found
    }
    const input = {
      name: b.name,
      parent,
      lead_id: await restLead(ctx, me, b),
      description: restDescription(b),
    }
    const project = await createFrom(ctx, me, input, restProvenance(a.keyName))
    return await projectRead(ctx, me, project, a.access, { created: true })
  },
})

/* PATCH /v1/projects/{ref} {name?, description?, review_hours?,
 * track_delay?, lead_id?, archived?}. The fields refuseProjectFields names,
 * `parent` and `archive_reason` are refused with their own sentences, and
 * any other unknown field after them. */
export const restUpdateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restManaged(ctx, me, a.ref)
    const b = needJson(a.body)
    refuseProjectFields(b)
    // POST takes `parent`; a project keeps the parent it was created with
    if ('parent' in b) throw badRequest(PARENT_AT_CREATION)
    // a task's archive reason, refused rather than dropped without a word
    if ('archive_reason' in b) throw badRequest(NO_PROJECT_ARCHIVE_REASON)
    refuseUnknownFields(b, [
      'name',
      'description',
      'review_hours',
      'track_delay',
      'lead_id',
      'archived',
      'expected',
    ])
    const expected = parseExpected(
      PROJECT_MACHINE_FIELDS,
      b.expected,
      sentKeys(PROJECT_MACHINE_FIELDS, b),
    )
    const input: UpdateInput = {}
    if ('name' in b) {
      if (typeof b.name !== 'string') throw badRequest('name must be a string')
      input.name = b.name
    }
    const description = restDescription(b)
    if (description !== undefined) input.description = description
    if ('review_hours' in b) {
      const hours = b.review_hours
      if (hours !== null && typeof hours !== 'number') throw rule(LIMITS.reviewHours.refusal)
      input.review_hours = hours as number | null
    }
    if ('track_delay' in b) {
      if (typeof b.track_delay !== 'boolean') throw badRequest('track_delay must be a boolean')
      input.track_delay = b.track_delay
    }
    const lead = await restLead(ctx, me, b)
    if (lead !== undefined) input.lead_id = lead
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') throw badRequest('archived must be a boolean')
      input.archived = b.archived
    }
    if (Object.keys(input).length === 0) throw badRequest('no recognized fields to update')
    if (expected !== undefined) input.expected = expected
    const after = await applyUpdate(ctx, me, project, input, restProvenance(a.keyName))
    return await projectRead(ctx, me, after, a.access)
  },
})

/* The arguments of each access route's function: the project and subject
 * from the path, and the body ({level} on PUT, an optional {on_held_tasks}
 * on DELETE). A body field the route does not take is refused
 * (refuseUnknownFields), so a misspelled one never falls back to a
 * default. Both routes check the body before they resolve the path, so a
 * bad body answers 400 whatever the path names. */
const vRestAccessArgs = {
  callerId: v.string(),
  access: vCredentialAccess,
  keyName: vKeyName,
  ref: v.string(),
  subject: v.string(),
  body: v.string(),
}

type RestAccessArgs = ObjectType<typeof vRestAccessArgs>

/* PUT /v1/projects/{ref}/access/{users|teams}/{id} {level}, which each
 * kind's own internal function below runs, so every route reaches exactly
 * one function. */
async function restSetAccess(ctx: MutationCtx, a: RestAccessArgs, kind: 'users' | 'teams') {
  const me = await asMachineCaller(ctx, a.callerId, a.access)
  const b = needJson(a.body)
  refuseUnknownFields(b, ACCESS_PUT_FIELDS)
  const level = restLevel(b)
  const expected = parseExpected(GRANT_FIELDS, b.expected, ['level'])
  const project = await restManaged(ctx, me, a.ref)
  const subject = await restSubject(ctx, me, kind, a.subject)
  const { changed } = await setProjectGrantCore(ctx, {
    me,
    project,
    subject,
    level,
    now: new Date().toISOString(),
    provenance: restProvenance(a.keyName),
    expected,
  })
  return { project_id: project.id, ...subjectJson(subject), level, changed }
}

/* DELETE /v1/projects/{ref}/access/{users|teams}/{id}, with an optional
 * body {on_held_tasks}, which each kind's own internal function below runs.
 * An access removal for the read-only gate (asMachineCaller), as in the
 * app. */
async function restRemoveAccess(ctx: MutationCtx, a: RestAccessArgs, kind: 'users' | 'teams') {
  const me = await asMachineCaller(ctx, a.callerId, a.access, 'access_removal')
  const b = optionalJson(a.body)
  refuseUnknownFields(b, HELD_TASKS_FIELDS)
  const held: HeldTasks = parseHeldTasks(b.on_held_tasks)
  const project = await restManaged(ctx, me, a.ref)
  const subject = await restSubject(ctx, me, kind, a.subject)
  const removal = await removeProjectGrantCore(ctx, {
    me,
    project,
    subject,
    held,
    now: new Date().toISOString(),
    provenance: restProvenance(a.keyName),
  })
  return {
    project_id: project.id,
    ...subjectJson(subject),
    removed: removal.removed,
    ...(await removalJson(ctx, me, removal)),
  }
}

/* PUT /v1/projects/{ref}/access/users/{id}. */
export const restSetUserAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restSetAccess(ctx, a, 'users'),
})

/* PUT /v1/projects/{ref}/access/teams/{id}. */
export const restSetTeamAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restSetAccess(ctx, a, 'teams'),
})

/* DELETE /v1/projects/{ref}/access/users/{id}. */
export const restRemoveUserAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restRemoveAccess(ctx, a, 'users'),
})

/* DELETE /v1/projects/{ref}/access/teams/{id}. */
export const restRemoveTeamAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restRemoveAccess(ctx, a, 'teams'),
})

/* A REST milestone body's name and date: strings when present, `required`
 * names the ones that must be. Any other field is refused. */
function milestoneFields(
  b: Record<string, unknown>,
  required: boolean,
): { name?: string; week?: string } {
  if (required) refuseCreateExpected(b, 'milestone')
  refuseUnknownFields(b, required ? ['name', 'date'] : ['name', 'date', 'expected'])
  const out: { name?: string; week?: string } = {}
  if ('name' in b) {
    if (typeof b.name !== 'string') throw badRequest('name must be a string')
    out.name = b.name
  } else if (required) throw badRequest('name is required')
  if ('date' in b) out.week = cleanMilestoneDate(b.date)
  else if (required) throw badRequest('date is required')
  return out
}

/* POST /v1/projects/{ref}/milestones {name, date}. */
export const restAddMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const f = milestoneFields(needJson(a.body), true)
    const m = await addMilestoneCore(ctx, {
      me,
      id: newUuid(),
      projectId: project.id,
      name: f.name as string,
      week: f.week as string,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { ...milestoneJson(m), project_id: m.project_id }
  },
})

/* PATCH /v1/projects/{ref}/milestones/{id} {name?, date?}. */
export const restUpdateMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    milestone: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw notFound('milestone not found')
    const b = needJson(a.body)
    const patch = milestoneFields(b, false)
    const expected = parseExpected(
      MILESTONE_MACHINE_FIELDS,
      b.expected,
      sentKeys(MILESTONE_MACHINE_FIELDS, b),
    )
    if (patch.name === undefined && patch.week === undefined) {
      throw badRequest('no recognized fields to update')
    }
    const m = await updateMilestoneCore(ctx, {
      me,
      milestone,
      patch,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
      expected,
      view: 'machine',
    })
    return { ...milestoneJson(m), project_id: m.project_id }
  },
})

/* DELETE /v1/projects/{ref}/milestones/{id}, with an optional body
 * {expected}: the name and date the caller read, because Deleted items
 * cannot bring a milestone back. */
export const restDeleteMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    milestone: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ deleted: true; id: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw notFound('milestone not found')
    const b = optionalJson(a.body ?? '')
    refuseUnknownFields(b, ['expected'])
    const expected = parseExpected(
      MILESTONE_MACHINE_FIELDS,
      b.expected,
      Object.keys(MILESTONE_MACHINE_FIELDS),
    )
    await removeMilestoneCore(ctx, {
      me,
      milestone,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
      expected,
      view: 'machine',
    })
    return { deleted: true, id: milestone.id }
  },
})

/* ------------------------------------------------------- registry entries */

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

/** The MCP tools of this domain, in tools/list order after mcp.ts's own. */
export const PROJECT_TOOLS: McpTool[] = [
  {
    access: 'read',
    def: {
      name: 'get_project',
      title: 'Get project',
      description:
        'One project you can see or manage, by number, key or uuid: its lead, review time, delay tracking, its completion (done and total tasks, `status: "counting"` with null counts for a moment after any project is archived or restored, so ask again later, or `status: "unavailable"` in a project with very many sub-projects), the first 50 of its milestones (kept on the top-level project, by date) and the first 50 of the users and of the teams given access to it (`grants`, by name). Each list has its cursor right before it, `milestones_next_cursor`, `user_grants_next_cursor` and `team_grants_next_cursor` (which continues `grants.teams`), null where the list ends there; pass it to list_project_related for the rest. A project you manage without reading it, as an organization admin who takes no part in it, has `access.read` false, completion `unavailable` and milestones and their cursor null.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.projects.mcpGetProject, {
        callerId,
        access,
        ...(args as { project: string }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'list_project_related',
      title: 'List project related',
      description: `One page of one of a project's lists, which \`list\` names as "milestones", "user_grants" or "team_grants". get_project answers the first ${DEFAULT_PAGE_SIZE} of each with a cursor, such as \`user_grants_next_cursor\`; pass it as \`cursor\` with the same \`project\` and \`list\`, then this tool's \`next_cursor\`, until it is null. Milestones are the top-level project's, by date; grants are the project's own, people or teams by name, each with its \`level\`; a sub-project also inherits its parent's grants, and who can work in a project is list_project_users. A page holds at most \`limit\` rows (${DEFAULT_PAGE_SIZE} by default, at most ${LIMITS.listMilestones.max}) and can hold fewer, even none, while \`next_cursor\` is set. \`offset\` is refused unless 0.`,
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          list: {
            type: 'string',
            enum: [...PROJECT_RELATED_LISTS],
          },
          limit: {
            type: 'integer',
            minimum: LIMITS.listMilestones.min,
            maximum: LIMITS.listMilestones.max,
          },
          offset: {
            type: 'integer',
            minimum: 0,
            maximum: 0,
          },
          cursor: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['project', 'list'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.projects.mcpProjectRelated, {
        callerId,
        access,
        ...(args as {
          project: string
          list: ProjectRelatedList
          limit?: number
          offset?: number
          cursor?: string
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'create_project',
      title: 'Create project',
      description:
        "Create a top-level project, or with `parent` (a project number, key or uuid) a sub-project under it. A top-level project follows the organization's project creation setting (get_me `can_create_projects`); a sub-project needs managing its parent, as its lead or an organization admin. `lead_id` defaults to you, and only a person may name someone else. Tasks go in sub-projects.",
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          name: {
            type: 'string',
            maxLength: LIMITS.projectName.max,
          },
          parent: {
            type: 'string',
          },
          lead_id: {
            type: 'string',
          },
          description: {
            type: 'string',
            maxLength: LIMITS.projectDescription.max,
          },
        },
        required: ['name'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.projects.mcpCreateProject, {
        callerId,
        access,
        ...(args as { name: string; parent?: string; lead_id?: string; description?: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'update_project',
      title: 'Update project',
      description:
        'Change a project you manage, as its lead or an organization admin: `name`, `description`, `review_hours` (null uses the parent or default), `track_delay`, or `archived: true/false` to archive or restore it. `lead_id` hands the lead to another user, which only a person may do; the old lead keeps User access. Only tasks take an archive reason. ' +
        EXPECTED_SENTENCE +
        ' Its `lead_id` is the lead get_project shows.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          name: {
            type: 'string',
            maxLength: LIMITS.projectName.max,
          },
          description: {
            type: 'string',
            maxLength: LIMITS.projectDescription.max,
          },
          review_hours: {
            anyOf: [
              {
                type: 'number',
                minimum: LIMITS.reviewHours.min,
                maximum: LIMITS.reviewHours.max,
              },
              { type: 'null' },
            ],
          },
          track_delay: {
            type: 'boolean',
          },
          lead_id: {
            type: 'string',
          },
          archived: {
            type: 'boolean',
          },
          expected: expectedSchema(PROJECT_MACHINE_FIELDS),
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        name?: string
        description?: string
        review_hours?: number | null
        track_delay?: boolean
        lead_id?: string
        archived?: boolean
        expected?: unknown
      }
      return r.runMutation(internal.machine.projects.mcpUpdateProject, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          PROJECT_MACHINE_FIELDS,
          expected,
          sentKeys(PROJECT_MACHINE_FIELDS, rest),
        ),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'set_project_access',
      title: 'Set project access',
      description:
        'Give one user (`user_id`) or one team (`team_id`) `user` or `viewer` access to a project, or with `level: null` remove it. `on_held_tasks` settles open tasks a removal hides from the people working on them: `leave` (the default; the result lists those you can see and counts the others in `hidden`), `keep_as_viewer`, or `{"reassign_to": user id or null}`. Needs managing the project, as its lead or an organization admin, and only a person may change access. ' +
        EXPECTED_SENTENCE +
        ' Its `level` is the access get_project or list_project_related shows, null for none, and takes no removal.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          user_id: {
            type: 'string',
          },
          team_id: {
            type: 'string',
          },
          level: {
            anyOf: [{ type: 'string', enum: ['user', 'viewer'] }, { type: 'null' }],
          },
          on_held_tasks: ON_HELD_TASKS_SCHEMA,
          expected: expectedSchema(GRANT_FIELDS),
        },
        required: ['project', 'level'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { on_held_tasks, expected, ...rest } = args as {
        project: string
        user_id?: string
        team_id?: string
        level: GrantLevel | null
        on_held_tasks?: unknown
        expected?: unknown
      }
      if (rest.level === null && expected !== undefined) {
        throw badRequest('expected applies only when level is not null')
      }
      return r.runMutation(internal.machine.projects.mcpSetProjectAccess, {
        callerId,
        access,
        ...rest,
        ...(on_held_tasks === undefined ? {} : { on_held_tasks: parseHeldTasks(on_held_tasks) }),
        expected: parseExpected(GRANT_FIELDS, expected, ['level']),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'set_milestone',
      title: 'Set milestone',
      description:
        "Without `milestone`, add one to `project` from `name` and `date` (YYYY-MM-DD); a sub-project's goes on its top-level project. With `milestone` (an id from get_project or list_project_related), rename or move it. Needs Edit access on the top-level project. A top-level project holds at most one milestone in each calendar week of its organization, so a `date` in a week that holds another of its milestones is refused. " +
        EXPECTED_SENTENCE,
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          milestone: {
            type: 'string',
          },
          name: {
            type: 'string',
            maxLength: LIMITS.milestoneName.max,
          },
          date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          expected: expectedSchema(MILESTONE_MACHINE_FIELDS),
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        milestone?: string
        name?: string
        date?: string
        expected?: unknown
      }
      if (rest.milestone === undefined && expected !== undefined) {
        throw badRequest(createExpectedSentence('milestone'))
      }
      return r.runMutation(internal.machine.projects.mcpSetMilestone, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          MILESTONE_MACHINE_FIELDS,
          expected,
          sentKeys(MILESTONE_MACHINE_FIELDS, rest),
        ),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'delete_milestone',
      title: 'Delete milestone',
      description:
        'Delete a milestone (an id from get_project or list_project_related) of `project`. Needs Edit access on the top-level project. ' +
        EXPECTED_DELETE_SENTENCE,
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          milestone: {
            type: 'string',
          },
          expected: expectedSchema(MILESTONE_MACHINE_FIELDS),
        },
        required: ['project', 'milestone'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        milestone: string
        expected?: unknown
      }
      return r.runMutation(internal.machine.projects.mcpDeleteMilestone, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          MILESTONE_MACHINE_FIELDS,
          expected,
          Object.keys(MILESTONE_MACHINE_FIELDS),
        ),
      })
    },
  },
]

/** The REST routes of this domain, matched after machine/rest.ts's own. GET
 * /v1/projects/{ref} stays there, with projectDetailJson's fields. */
export const PROJECT_ROUTES: RestRoute[] = [
  route({
    method: 'POST',
    path: 'projects',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, body }) =>
      r.runMutation(internal.machine.projects.restCreateProject, {
        callerId,
        access,
        keyName,
        body,
      }),
  }),
  route({
    method: 'PATCH',
    path: 'projects/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restUpdateProject, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'projects/:ref/access/users',
    access: 'read',
    status: 200,
    query: ['limit', 'cursor', 'offset'],
    run: (r, { callerId, access, param, query }) =>
      r.runQuery(internal.machine.projects.restListUserGrants, {
        callerId,
        access,
        ref: param('ref'),
        limit: query('limit'),
        cursor: query('cursor'),
        offset: query('offset'),
      }),
  }),
  route({
    method: 'GET',
    path: 'projects/:ref/access/teams',
    access: 'read',
    status: 200,
    query: ['limit', 'cursor', 'offset'],
    run: (r, { callerId, access, param, query }) =>
      r.runQuery(internal.machine.projects.restListTeamGrants, {
        callerId,
        access,
        ref: param('ref'),
        limit: query('limit'),
        cursor: query('cursor'),
        offset: query('offset'),
      }),
  }),
  route({
    method: 'PUT',
    path: 'projects/:ref/access/users/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restSetUserAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/access/users/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restRemoveUserAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'PUT',
    path: 'projects/:ref/access/teams/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restSetTeamAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/access/teams/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restRemoveTeamAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'projects/:ref/milestones',
    access: 'read',
    status: 200,
    query: ['limit', 'cursor', 'offset'],
    run: (r, { callerId, access, param, query }) =>
      r.runQuery(internal.machine.projects.restListMilestones, {
        callerId,
        access,
        ref: param('ref'),
        limit: query('limit'),
        cursor: query('cursor'),
        offset: query('offset'),
      }),
  }),
  route({
    method: 'POST',
    path: 'projects/:ref/milestones',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restAddMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'PATCH',
    path: 'projects/:ref/milestones/:milestone',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restUpdateMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        milestone: param('milestone'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/milestones/:milestone',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restDeleteMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        milestone: param('milestone'),
        body,
      }),
  }),
]
