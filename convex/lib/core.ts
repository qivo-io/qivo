/* The machine core (phase 8): what the two machine surfaces — /v1/* REST and
 * /mcp — share once auth (machine/auth.ts) has resolved a caller. Visibility
 * is MANUAL here: nothing enforces it below this layer.
 * Every read below that answers with rows filters
 * through canSeeProject, because Convex code sees everything — the org fence
 * alone is NOT enough (an invisible issue must read "not found").
 *
 * Layering: the surface files (convex/machine/{rest,mcp}.ts) own the wire —
 * routes, status codes, per-surface refusal sentences, JSON key subsets — and
 * compose these helpers inside ONE internal fn per endpoint (resolve + rules
 * + write + activity in one transaction). Each organization REST route and
 * MCP tool is declared once as a registry entry (machine/registry.ts) with a
 * required read/write `access` flag; a read entry can only run queries, so
 * its internal fn is a query. The /v1/webhooks routes and the MCP events/*
 * methods are served outside it. Shared RULES live in model/issues.ts
 * (cleanTitle, pairRule, metaNeedsSub, assertLive, assertAssignable,
 * assertAssignableChange, assertNoSubtasks, assertNoGroupDates,
 * assertWeekPair, SUB_MUST_NAME), model/deletedItems.ts (moveTasksToTrash,
 * the task delete), model/comments.ts (postComment, newestComments) and
 * model/orgs.ts (setPlannableHoursCore); the task search text is
 * lib/search.ts taskSearchText, as in the app. This file adds only what the
 * model does not own: the caller shape, the ref grammar, the catalogue, the
 * access flags, the shared list reads, the wire projections and
 * applyTaskUpdate, the write order of a task update on both surfaces.
 *
 * Refusal grammar: helpers here throw the shipped ConvexError {code, message,
 * reason?} values (lib/functions.ts). REST maps code → status (not_found 404,
 * forbidden 403, bad_request 400, rule 400 — readable beats a 500); MCP
 * collapses every refusal into the one isError sentence. */

import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { machineDetail } from '../model/activity'
import { type AttachmentJson, taskAttachments } from '../model/attachments'
import {
  commentAnchor,
  DOCUMENT_MAX_BYTES,
  latestComment,
  newestComments,
  postArchiveReason,
} from '../model/comments'
import type { Via } from '../model/deletedItems'
import {
  assertLive,
  assertTaskExpected,
  type IssuePatch,
  type LaterPeople,
  metaNeedsSub,
  moveIssueCore,
  pairRule,
  SUB_MUST_NAME,
  updateIssueCore,
} from '../model/issues'
import { labelJson, setTaskLabel } from '../model/labels'
import { linkKindFrom, linksOf, type TaskLinkKind } from '../model/links'
import { followersOf } from '../model/messages'
import { attachmentLimitMb } from '../model/orgs'
import {
  canChangeAccess,
  canHoldWork,
  canSeeProject,
  levelRank,
  liveCredentialRow,
  machineAccess,
  projectLevelsForOrg,
  projectLevelsForProfiles,
  readOnlyRefusal,
} from './access'
import {
  type ArchiveCursor,
  archivedTaskMatcher,
  archivedTasksPage,
  ceilingGuard,
  matchingLabels,
  namesOf,
  parseArchiveCursor,
  type ReadCeiling,
  rangesLeft,
  readsUnder,
  roomOf,
  rosterNames,
  rosterOf,
  searchFields,
} from './archivedTasks'
import { assertOrgAvailable, assertOrgWritable, orgWriteBlock } from './billingAccess'
import { byId } from './db'
import { refuseDemoFeature } from './demo'
import {
  type CredentialAccess,
  type IssuePriority,
  type IssueStatus,
  LEVEL_RANK,
  type OrgRole,
  type ProfileKind,
  type ProjectType,
} from './enums'
import { badRequest, notFound, type Refusal } from './functions'
import {
  countsAsSubtask,
  groupTest,
  layerOf,
  liveIn,
  liveTasksOf,
  type ProjectLive,
  projectLiveness,
} from './liveTasks'
import {
  type DelayJson,
  delayClock,
  type Forecaster,
  listForecaster,
  noForecast,
  taskForecaster,
} from './machineDelay'
import { canCreateProjects } from './projectCreators'
import { taskOwnerId } from './review'
import { allWordsMatcher, searchPieces, taskSearchText } from './search'
import type { EventOwner } from './taskEvents'
import { ISSUE_PREFIX, issueKey } from './taskRefs'
import { cutName } from './textLimits'
import { groupRemainingHours, linkShown, parentLink, type Shown } from './workingSet'

export { machineDetail }

/* ------------------------------------------------------------------ caller
 * Uuid convention: machine internal fns take `callerId: v.string()` (the
 * profile uuid the auth query resolved) and `access: vCredentialAccess` (what
 * that credential may do, from lib/access.ts credentialAccess), and start
 * with asMachineCaller. The model layer takes the loaded doc everywhere, so
 * the Caller IS the doc. */

export type Caller = Doc<'profiles'>

/* Sentinel `reason` marks for the auth-to-dispatch race (auth runs in a
 * SEPARATE query, so the profile can flip between lookup and dispatch — the
 * Deno single-transaction never had the window; re-asserting closes it).
 * The surface HTTP action maps these back to its own 401 sentence: REST
 * the caller's (machine/rest.ts CALLER, 'unknown agent key' / 'this agent
 * has been deactivated' for an agent key); MCP its per-leg sentence
 * (machine/auth.ts mcpAuth401). The messages here are REST's agent ones, as
 * the fallback if a surface skips the mapping. */
export const CALLER_GONE = 'caller_gone'
export const CALLER_DEACTIVATED = 'caller_deactivated'

/* The refusal for a caller, or its credential, that is gone by dispatch. */
const callerGone = (): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'forbidden', message: 'unknown agent key', reason: CALLER_GONE })

/**
 * The live caller profile. In a mutation it also refuses a credential that
 * can only read, before any ref resolves, so a read-only caller learns
 * nothing about what exists. An agent's access follows its live role, which
 * can change between auth and dispatch. Then the read-only gate of a billing
 * pause or a pending deletion applies.
 *
 * `write: 'access_removal'` mirrors the app's accessRemovalMutation. An
 * organization admin passes that gate, and the removal core meets it for
 * anything a removal also writes (model/projectAccess.ts
 * removeProjectGrantCore, model/teams.ts removeTeamMemberCore). Pass it only
 * from a handler whose only write is an access removal. Only a
 * person changes access (lib/access.ts canChangeAccess), so the exception is
 * a person's.
 *
 * It does not read the caller's login for a platform ban. Each request
 * dispatches one call, and its credential lookup already refused a banned
 * or missing login (machine/auth.ts lookupCredential for personal tokens,
 * oauthConnections.lookupAccess for OAuth before every call). Rereading it
 * here would add a Better Auth query to every call, so a ban that lands
 * mid-request lets that request finish, like a revocation does. Agent keys
 * belong to no login.
 */
export async function asMachineCaller(
  ctx: QueryCtx,
  callerId: string,
  access: CredentialAccess,
  write: 'change' | 'access_removal' = 'change',
): Promise<Caller> {
  refuseDemoFeature()
  const me = await byId(ctx, 'profiles', callerId)
  if (me === null) throw callerGone()
  if (!me.active) {
    throw new ConvexError<Refusal>({
      code: 'forbidden',
      message: 'this agent has been deactivated',
      reason: CALLER_DEACTIVATED,
    })
  }
  await assertOrgAvailable(ctx, me.org_id)
  if ('insert' in ctx.db) {
    if (machineAccess(me, access) !== 'write') throw readOnlyRefusal(me)
    const adminRemoval =
      write === 'access_removal' && me.org_role === 'admin' && canChangeAccess(me)
    if (!adminRemoval) await assertOrgWritable(ctx, me.org_id)
  }
  return me
}

/* ------------------------------------------------------------- ref grammar
 * core.ts:43,251-291. Stored uuids are lowercase and by_uuid is exact-match,
 * so caller-supplied uuid refs are lowercased before every lookup; keys are
 * uppercased. Numeric refs are int4-bounded — out of range is a clean miss,
 * never a crash (verify-mcp pins QN-3000000000 → not-found). */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const INT4_MAX = 2147483647
const ISSUE_REF = new RegExp(`^(?:${ISSUE_PREFIX}-)?(\\d+)$`, 'i')

export { issueKey } from './taskRefs'

/* "QN-482" / bare "482" (org-scoped num) / uuid. null = nothing it could be. */
export function parseIssueRef(ref: string): { uuid: string } | { num: number } | null {
  if (UUID.test(ref)) return { uuid: ref.toLowerCase() }
  const m = ref.match(ISSUE_REF)
  if (m === null) return null
  const num = Number(m[1])
  return num >= 1 && num <= INT4_MAX ? { num } : null
}

/* Resolve an issue ref inside the caller's org — org-fenced (numbers are
 * org-scoped and a login can span orgs since 0081; the fence is the
 * credential's own), then canSeeProject-filtered: the NEW obligation RLS used
 * to carry — without it the machine surface leaks invisible issues. Resolves
 * archived issues too (no archived filter here). null = not found / not
 * visible; each surface phrases that itself. A task whose project has a
 * missing parent or sits in a cycle (lib/access.ts rootMetaOf) is not
 * visible, as accessFlags gives such a project no read flag. */
export async function findIssue(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<Doc<'issues'> | null> {
  const parsed = parseIssueRef(ref)
  if (parsed === null) return null
  let issue: Doc<'issues'> | null
  if ('uuid' in parsed) {
    issue = await byId(ctx, 'issues', parsed.uuid)
    if (issue !== null && issue.org_id !== me.org_id) issue = null
  } else {
    issue = await ctx.db
      .query('issues')
      .withIndex('by_org_num', (q) => q.eq('org_id', me.org_id).eq('num', parsed.num))
      .unique()
  }
  if (issue === null) return null
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null) return null
  return (await seesProject(ctx, me, project)) ? issue : null
}

/* canSeeProject, with a project whose parent is missing or that sits in a
 * cycle (lib/access.ts rootMetaOf) not visible rather than refused, as
 * accessFlags gives such a project no read flag. */
async function seesProject(ctx: QueryCtx, me: Caller, project: Doc<'projects'>): Promise<boolean> {
  try {
    return await canSeeProject(ctx, me, project)
  } catch (e) {
    if (e instanceof ConvexError && (e.data as Refusal).code === 'not_found') return false
    throw e
  }
}

/* Project refs: uuid, per-org project number, or KEY. Digit-only project keys
 * are legal (^[A-Z0-9]{1,5}$), so an all-digit ref resolves as a number first
 * and falls back to the key on a miss — numbers are the durable grammar and
 * win a collision. Resolves archived projects (refs must keep working).
 *
 * Visibility is deliberately NOT applied here: REST resolves against the
 * whole org catalogue and checks the caller's flags itself, MCP wraps this
 * with canSeeProject → null → its uniform "not found (or not visible to
 * you)". Each surface layers its own fence. */
export async function findProject(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<Doc<'projects'> | null> {
  if (UUID.test(ref)) {
    const p = await byId(ctx, 'projects', ref.toLowerCase())
    return p !== null && p.org_id === me.org_id ? p : null
  }
  if (/^\d+$/.test(ref)) {
    const n = Number(ref)
    if (n >= 1 && n <= INT4_MAX) {
      const p = await ctx.db
        .query('projects')
        .withIndex('by_org_num', (q) => q.eq('org_id', me.org_id).eq('num', n))
        .unique()
      if (p !== null) return p
    }
  }
  const key = ref.toUpperCase()
  return await ctx.db
    .query('projects')
    .withIndex('by_org_key', (q) => q.eq('org_id', me.org_id).eq('key', key))
    .unique()
}

/* --------------------------------------------------------------- catalogue
 * The org's whole project set, read in ONE indexed by_org scan per request
 * (never N point reads), is the naming service. REST resolves refs against
 * it and MCP reuses it for list scopes. Nothing here grants anything, and
 * every disclosed id runs past accessFlags. */

export type Catalogue = {
  projects: Doc<'projects'>[]
  byUuid: Map<string, Doc<'projects'>>
  byKey: Map<string, Doc<'projects'>>
  byNum: Map<number, Doc<'projects'>>
}

export async function loadCatalogue(ctx: QueryCtx, me: Caller): Promise<Catalogue> {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  return {
    projects,
    byUuid: new Map(projects.map((p) => [p.id, p])),
    byKey: new Map(projects.map((p) => [p.key, p])),
    byNum: new Map(projects.map((p) => [p.num, p])),
  }
}

/* findProject's catalogue twin (rest:180-183) — identical grammar, no reads. */
export function findProjectRef(cat: Catalogue, ref: string): Doc<'projects'> | undefined {
  if (UUID.test(ref)) return cat.byUuid.get(ref.toLowerCase())
  if (/^\d+$/.test(ref)) return cat.byNum.get(Number(ref)) ?? cat.byKey.get(ref.toUpperCase())
  return cat.byKey.get(ref.toUpperCase())
}

/* ------------------------------------------------------------ access flags
 * What the caller holds on each project of its organization (core.ts:307-318's
 * successor). `read` is canSeeProject and `write` is hasProjectLevel 'user'
 * through a credential that may write (machineAccess). projectLevelsForOrg,
 * the snapshot's batched form of those rules, answers both for every project
 * from the caller's grants and team shares, a few index ranges in all. Asking
 * the predicates project by project read about three ranges per project for
 * a writer who is not an admin, so such a writer's every call passed Convex's
 * 4,096 at about 1,300 projects. A project outside a top-level meta, such as
 * one whose parent is missing, gets neither flag. The level carries the
 * viewer ceiling (cappedLevel), so an org-role-viewer agent and a grant-viewer
 * agent both get `write: false`, and so does every project seen through a
 * read-only credential. (asMachineCaller refuses those writes before they get
 * this far.) Here code sees everything and CHOOSES what to disclose; these
 * flags are that choice's only input. */

export type AccessFlag = { read: boolean; write: boolean }

/** The caller's flags on every project of `cat`, which must be its
 * organization's whole catalogue, because a sub-project's level comes from
 * its parent's row. */
export async function accessFlags(
  ctx: QueryCtx,
  me: Caller,
  cat: Catalogue,
  access: CredentialAccess,
): Promise<Map<string, AccessFlag>> {
  const writes = machineAccess(me, access) === 'write'
  const { levelOf } = await projectLevelsForOrg(ctx, me, cat.projects)
  const out = new Map<string, AccessFlag>()
  for (const p of cat.projects) {
    const level = levelOf(p)
    out.set(p.id, {
      read: level !== null,
      write: writes && levelRank(level) >= LEVEL_RANK.user,
    })
  }
  return out
}

/* ------------------------------------------------------------ shared rules */

/* core.ts:327-331, standalone — MCP update_user must NOT bundle the
 * active/viewer checks (assertAssignable in model/issues does): a viewer's or
 * inactive person's hours are settable, only the setter's own rules apply.
 * The sentence echoes the caller's spelling; the lookup lowercases (stored
 * uuids are lowercase). Returns the row for the caller's follow-up checks. */
export async function assertOwnUser(
  ctx: QueryCtx,
  me: Caller,
  profileId: string,
): Promise<Doc<'profiles'>> {
  const p = await byId(ctx, 'profiles', profileId.toLowerCase())
  if (p === null || p.org_id !== me.org_id) {
    throw badRequest(`user "${profileId}" not found in your organization`)
  }
  return p
}

/* ------------------------------------------------------------ shared reads
 * Each takes the surface's `readable` predicate (built from accessFlags over
 * the catalogue) — the RLS filter said in code, required on purpose so no
 * caller can forget the fence. */

/** The filters both list modes share. */
type ListFilters = {
  /** any of these statuses; status filters leave groups out */
  statuses?: readonly IssueStatus[]
  priority?: IssuePriority
  /** profile uuid, already lowercased by the surface */
  assignee?: string
  /** profile uuid of the owner (lib/review.ts taskOwnerId), lowercased */
  owner?: string
  search?: string
  /** REST lets `*` widen; MCP does not, so a literal `*` stays literal */
  stars: boolean
}

export type ActiveListOpts = ListFilters & {
  /** project ids from taskListScope, or null for every readable project that
   *  is not archived (0106's two archive axes; naming the project is what
   *  asks for an archived one) */
  scope: string[] | null
  limit: number
  offset: number
  /** the request's UTC day (YYYY-MM-DD), which delay verdicts are judged by */
  today: string
}

export type ArchivedListOpts = ListFilters & {
  /** project ids from taskListScope; archived tasks are listed one project
   *  at a time */
  scope: string[]
  limit: number
  /** where the previous page stopped, or null for the first page */
  cursor: ArchiveCursor | null
}

/** What a list knows about the caller's projects, and the shape it answers
 * in. `readable` is the caller's project flags (accessFlags). */
export type ListView = {
  surface: 'rest' | 'mcp'
  cat: Catalogue
  readable: (projectId: string) => boolean
}

/* The names of `labels` that the task carries, in their order, read through
 * the task's own assignment of each (by_issue_label), archive marks
 * included. One index range and at most one document per label, however
 * many other labels the task carries. */
async function labelNamesOf(
  ctx: QueryCtx,
  taskId: string,
  labels: readonly Doc<'labels'>[],
): Promise<string[]> {
  const held = await Promise.all(
    labels.map((label) =>
      ctx.db
        .query('issue_labels')
        .withIndex('by_issue_label', (q) => q.eq('issue_id', taskId).eq('label_id', label.id))
        .first(),
    ),
  )
  return labels.filter((_, i) => held[i] !== null).map((label) => label.name)
}

/* The names of `labels` that the task carries, in their order, read through
 * all the task's own assignments (by_issue) in one index range, archive
 * marks included, for a task restored so recently that its assignments are
 * still marked. */
async function markedLabelNamesOf(
  ctx: QueryCtx,
  taskId: string,
  labels: readonly Doc<'labels'>[],
): Promise<string[]> {
  const held = new Set<string>()
  const rows = ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', taskId))
  for await (const row of rows) held.add(row.label_id)
  return labels.filter((label) => held.has(label.id)).map((label) => label.name)
}

/** How many reads of one task's assignment of one matching label
 * (labelNamesOf) a search makes before it reads each matching label's
 * active assignments instead. Tests lower `reads`. */
export const LABEL_TASK_READS = { reads: 1000 }

/** What a search's label reads keep back from the request's limits for the
 * page after them, its parents and newest comments. They check the request's
 * reads before each index range and every LABEL_ROWS_PER_CHECK rows, so the
 * documents and bytes also hold that many rows, or one restored task's
 * assignments. Tests lower these. */
export const LABEL_READS_RESERVE = { ranges: 416, documents: 1024, bytes: 2 * DOCUMENT_MAX_BYTES }

/* How many label assignments a search reads between two checks of the
 * request's reads. */
const LABEL_ROWS_PER_CHECK = 256

/** The refusal for a search whose label assignments do not fit in one
 * request. */
export const SEARCH_TOO_LARGE =
  'this search reads too many label assignments to answer in one request; name a project or add a filter'

/* The names of `labels` by task, for the active `tasks` a search still
 * needs them for. While the tasks times the labels are at most
 * LABEL_TASK_READS and leave LABEL_READS_RESERVE ranges and documents, each
 * task's assignment of each label is read on its own (labelNamesOf), at most
 * one document each. Past that each label's assignments are read through
 * by_label without the archive mark, so the read follows active work, not
 * every task ever archived with the label (schema.ts taskArchived), within
 * the request's room less LABEL_READS_RESERVE. A search whose assignments do
 * not fit is refused with SEARCH_TOO_LARGE. Assignments stored without an
 * organization are found too. A task restored from the archive keeps marked
 * assignments until background steps clear them and carries relations_marked
 * meanwhile, so each such task is read through its own assignments
 * instead. */
async function activeLabelNames(
  ctx: QueryCtx,
  labels: readonly Doc<'labels'>[],
  tasks: readonly Doc<'issues'>[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (labels.length === 0 || tasks.length === 0) return out
  const m = await ctx.meta.getTransactionMetrics()
  const pairs = tasks.length * labels.length
  if (
    pairs <= LABEL_TASK_READS.reads &&
    pairs < m.databaseQueries.remaining - LABEL_READS_RESERVE.ranges &&
    pairs < m.documentsRead.remaining - LABEL_READS_RESERVE.documents
  ) {
    const names = await Promise.all(tasks.map((task) => labelNamesOf(ctx, task.id, labels)))
    for (const [i, task] of tasks.entries()) out.set(task.id, names[i] ?? [])
    return out
  }
  const ceiling = roomOf(m, LABEL_READS_RESERVE)
  const wanted = new Set(tasks.map((task) => task.id))
  const restored = tasks.filter((task) => task.relations_marked === true)
  const own = new Set(restored.map((task) => task.id))
  let read = 0
  for (const label of labels) {
    if (!(await readsUnder(ctx, ceiling))) throw badRequest(SEARCH_TOO_LARGE)
    const rows = ctx.db
      .query('issue_labels')
      .withIndex('by_label', (q) => q.eq('label_id', label.id).eq('task_archived', undefined))
    for await (const row of rows) {
      if (++read % LABEL_ROWS_PER_CHECK === 0 && !(await readsUnder(ctx, ceiling))) {
        throw badRequest(SEARCH_TOO_LARGE)
      }
      if (!wanted.has(row.issue_id) || own.has(row.issue_id)) continue
      const names = out.get(row.issue_id)
      if (names === undefined) out.set(row.issue_id, [label.name])
      else names.push(label.name)
    }
  }
  for (const task of restored) {
    if (!(await readsUnder(ctx, ceiling))) throw badRequest(SEARCH_TOO_LARGE)
    out.set(task.id, await markedLabelNamesOf(ctx, task.id, labels))
  }
  return out
}

/* The list row of `task` in the reader's shape. */
async function listRow(
  ctx: QueryCtx,
  task: Doc<'issues'>,
  o: IssueOutPre & Reader & Subtree & Forecast,
): Promise<RestIssueJson | McpIssueOut> {
  return o.surface === 'rest'
    ? await issueOut(ctx, task, { ...o, surface: 'rest' })
    : await issueOut(ctx, task, { ...o, surface: 'mcp' })
}

/* Orders tasks by creation, oldest first, then by number. */
const byCreation = (a: Doc<'issues'>, b: Doc<'issues'>): number =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.num - b.num

export { LIVE_PROJECT_READS } from './liveTasks'

/* The active tasks an active list reads (listActiveIssuesCore), oldest
 * first by creation. Those of the active projects (lib/liveTasks.ts
 * liveTasksOf) hold every subtask that makes a task in an active project a
 * group and every task that carries load, so the active tasks that archived
 * projects keep forever are not read, until the organization has more
 * active projects than LIVE_PROJECT_READS. A
 * list that names an archived project reads all the organization's active
 * tasks (by_org_archived), because a task there counts every active
 * subtask, in any project (countsAsSubtask). */
async function listedActiveTasks(
  ctx: QueryCtx,
  me: Caller,
  cat: Catalogue,
  scope: readonly string[] | null,
): Promise<Doc<'issues'>[]> {
  const archived = scope?.some((id) => cat.byUuid.get(id)?.archived_at !== undefined) ?? false
  if (!archived) return await liveTasksOf(ctx, cat.projects)
  return await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', me.org_id).eq('archived_at', undefined))
    .collect()
}

/**
 * One page of the active tasks a list asks for, as list rows, oldest first
 * by creation with ties by number, so `offset` pages through them. It reads
 * the active tasks once (listedActiveTasks), never an archived one. That
 * read also decides which rows are groups, their plan weeks and their
 * progress, because an active task's subtasks that count are active too,
 * and in an active project they are in active projects. It holds the rows'
 * parents too, except a parent in an archived project under a list of
 * active projects, which is read on its own before the comments. With the
 * roster it also holds every input of the rows' delay verdicts
 * (lib/machineDelay.ts listForecaster), judged on `o.today`. Each row's
 * newest comment is one more read (lastCommentTimes). A page whose comments
 * do not fit in what the request has left is refused with PAGE_TOO_LARGE,
 * and with ACTIVE_TASKS_TOO_LARGE or ACTIVE_LIST_TOO_WIDE when the reads
 * before them leave no room at all.
 *
 * In a search, each fragment may match any field of the app's task filter
 * (lib/search.ts taskSearchText), in any order. Those are the task ID,
 * title, description, status name (not on a task with subtasks), priority
 * name, assignee name and label names. REST retains explicit `*` wildcards;
 * all other punctuation stays literal. Label names are read only for the
 * tasks the other fields miss (activeLabelNames), and a search whose label
 * assignments do not fit in one request is refused with SEARCH_TOO_LARGE.
 */
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView & { surface: 'rest' },
): Promise<RestIssueJson[]>
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView & { surface: 'mcp' },
): Promise<McpIssueOut[]>
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView,
): Promise<(RestIssueJson | McpIssueOut)[]> {
  const { cat, readable } = view
  const scope = o.scope === null ? null : new Set(o.scope)
  const active = await listedActiveTasks(ctx, me, cat, o.scope)
  const children = childIndexOf(active)
  const live = liveIn(cat.byUuid)
  const isGroup = (task: Doc<'issues'>): boolean => isGroupIn(children, task, live)
  const profiles = await rosterOf(ctx, me.org_id)
  const names = namesOf(profiles)
  const statuses = o.statuses !== undefined && o.statuses.length > 0 ? o.statuses : null
  let found: Doc<'issues'>[] = []
  for (const i of active) {
    if (!readable(i.project_id)) continue // RLS's successor — always, scope or not
    if (scope !== null) {
      if (!scope.has(i.project_id)) continue
    } else if (cat.byUuid.get(i.project_id)?.archived_at !== undefined) {
      continue // an archived project's tasks are not the working set (0106)
    }
    if (statuses !== null && (isGroup(i) || !statuses.includes(i.status))) continue
    if (o.priority && i.priority !== o.priority) continue
    if (o.assignee && i.assignee_id !== o.assignee) continue
    // a group stays with its assignee, as in the app
    if (o.owner && taskOwnerId(i, isGroup(i)) !== o.owner) continue
    found.push(i)
  }
  if (o.search) {
    const matches = allWordsMatcher(o.search, o.stars)
    const pieces = searchPieces(o.search, o.stars)
    const text = (i: Doc<'issues'>, labelNames: readonly string[]) =>
      taskSearchText({ ...searchFields(i, names), group: isGroup(i), labelNames })
    // more text never unmatches, so only the tasks that miss without their
    // labels need them read
    const plain = new Set(found.filter((i) => matches(text(i, []))).map((i) => i.id))
    const labels = await activeLabelNames(
      ctx,
      await matchingLabels(ctx, me.org_id, pieces),
      found.filter((i) => !plain.has(i.id)),
    )
    found = found.filter((i) => plain.has(i.id) || matches(text(i, labels.get(i.id) ?? [])))
  }
  found.sort(byCreation)
  const page = found.slice(o.offset, o.offset + o.limit)
  const tasks = new Map(active.map((t) => [t.id, t]))
  // parents outside the read, read within the room left like the comments
  const absent = new Set<string>()
  for (const task of page) {
    if (task.parent_id !== undefined && !tasks.has(task.parent_id)) absent.add(task.parent_id)
  }
  const parents = await pageReads(ctx, [...absent], (id) => byId(ctx, 'issues', id), null)
  for (const parent of parents) if (parent !== null) tasks.set(parent.id, parent)
  const org = await byId(ctx, 'organizations', me.org_id)
  const projectOf = (id: string) => cat.byUuid.get(id)
  const forecast = listForecaster({
    clock: delayClock(org, o.today),
    me,
    active,
    view: { byUuid: cat.byUuid, visible: readable },
    profiles,
  })
  const lastComments = await lastCommentTimes(ctx, page, absent.size > 0 ? PAGE_TOO_LARGE : null)
  return await Promise.all(
    page.map((task) =>
      listRow(ctx, task, {
        surface: view.surface,
        me,
        readable,
        project: projectOf(task.project_id),
        projectOf,
        names,
        orgSlug: org?.slug,
        tasks,
        lastComments,
        children,
        forecast,
        live,
      }),
    ),
  )
}

/** What an active page's parent and newest-comment reads leave of the
 * request's limits, for the one document a read may take past its room
 * (pageReads). Tests lower these. */
export const COMMENT_READS_RESERVE = { ranges: 16, documents: 16, bytes: DOCUMENT_MAX_BYTES }

/** The refusal for an active page whose tasks' parents outside the active
 * read and newest comments do not fit in what the request has left to
 * read. */
export const PAGE_TOO_LARGE =
  'this page of tasks is too large to read at once; ask for a smaller limit'

/** The refusal for an active list whose reads before its rows' comments
 * leave no documents or bytes for even one, which the organization's active
 * tasks fill, so a smaller limit cannot help. */
export const ACTIVE_TASKS_TOO_LARGE =
  "this organization's active tasks are too large to list in one request"

/** The refusal for an active list whose reads before its rows' comments
 * leave no index ranges for even one. Ranges run out through the caller's
 * team memberships, the labels a search matches and the active projects,
 * not through the tasks themselves, so a smaller limit cannot help. */
export const ACTIVE_LIST_TOO_WIDE =
  'this organization has too many projects, teams or labels to list its tasks in one request'

/* `read` of each of `items`, in order, for an active page. Each read is one
 * index range and at most one document, and they run a few at a time, never
 * more than the request's unspent room could hold at Convex's document size
 * limit, so they pass that room by one document at most and the request
 * stays inside its limits. When the room runs out first, the page is
 * refused with PAGE_TOO_LARGE, or with `first` when no room was left before
 * the first read. A null `first` names what the list read before the page:
 * ACTIVE_TASKS_TOO_LARGE when documents or bytes ran out, else
 * ACTIVE_LIST_TOO_WIDE. */
async function pageReads<T, R>(
  ctx: QueryCtx,
  items: readonly T[],
  read: (item: T) => Promise<R>,
  first: string | null,
): Promise<R[]> {
  const out: R[] = []
  while (out.length < items.length) {
    const m = await ctx.meta.getTransactionMetrics()
    const ranges = m.databaseQueries.remaining - COMMENT_READS_RESERVE.ranges
    const documents = m.documentsRead.remaining - COMMENT_READS_RESERVE.documents
    const bytes = m.bytesRead.remaining - COMMENT_READS_RESERVE.bytes
    if (ranges <= 0 || documents <= 0 || bytes <= 0) {
      if (out.length > 0) throw badRequest(PAGE_TOO_LARGE)
      const filled = documents <= 0 || bytes <= 0 ? ACTIVE_TASKS_TOO_LARGE : ACTIVE_LIST_TOO_WIDE
      throw badRequest(first ?? filled)
    }
    const fits = Math.max(1, Math.floor(bytes / DOCUMENT_MAX_BYTES))
    const batch = items.slice(out.length, out.length + Math.min(fits, ranges, documents))
    out.push(...(await Promise.all(batch.map(read))))
  }
  return out
}

/* When the newest comment on each of `tasks` was posted, or null for a task
 * without comments (model/comments.ts latestComment), by task id, read
 * within the request's room (pageReads), never answered with a wrong null.
 * `first` is the refusal when no room was left before the first read: null
 * for what the list read before (pageReads), or PAGE_TOO_LARGE once the
 * page read more of its own, such as parents. */
async function lastCommentTimes(
  ctx: QueryCtx,
  tasks: readonly Doc<'issues'>[],
  first: string | null,
): Promise<Map<string, string | null>> {
  const latest = await pageReads(ctx, tasks, (task) => latestComment(ctx, task.id), first)
  return new Map(tasks.map((task, i) => [task.id, latest[i]?.created_at ?? null]))
}

/* The first subtask stored under `task`, whoever can read it. */
const firstSubtask = (ctx: QueryCtx, task: Doc<'issues'>): Promise<Doc<'issues'> | null> =>
  ctx.db
    .query('issues')
    .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
    .first()

/** One page of archived tasks, with its rows and where the next page
 * starts, or null when no archived task follows. */
export type ArchivedPage<Row> = { rows: Row[]; next: ArchiveCursor | null }

/**
 * One page of the archived tasks of `o.scope` after `o.cursor`, as list
 * rows, most recently archived first and tasks archived at the same moment
 * newest created first (lib/archivedTasks.ts). A page stops at `o.limit`
 * rows or once it has spent ARCHIVE_PAGE, so it can hold fewer rows than
 * `o.limit`, even none, while `next` is set. `next` is the last task the page
 * looked at, not the last row, so the next page never rereads tasks the
 * filters left out.
 *
 * Each row walks its own subtree (subtreeIndex), as an archived task's group
 * facts need its archived subtasks, and never reads the organization's
 * tasks instead. A walk that does not fit the rest of the page ends the page
 * before that task, so the next page starts with it. The first task a page
 * looks at may walk everything the request has left. A group whose subtree
 * does not fit even that is listed with null plan weeks and a partial
 * progress that counts nothing, so every page moves on. Each row's newest
 * comment is one more read, which ARCHIVE_RESERVE leaves room for.
 */
export async function listArchivedIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ArchivedListOpts,
  view: ListView & { surface: 'rest' },
): Promise<ArchivedPage<RestIssueJson>>
export async function listArchivedIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ArchivedListOpts,
  view: ListView & { surface: 'mcp' },
): Promise<ArchivedPage<McpIssueOut>>
export async function listArchivedIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ArchivedListOpts,
  view: ListView,
): Promise<ArchivedPage<RestIssueJson | McpIssueOut>> {
  const { cat, readable } = view
  const names = await rosterNames(ctx, me.org_id)
  const orgSlug = (await byId(ctx, 'organizations', me.org_id))?.slug
  const projectOf = (id: string) => cat.byUuid.get(id)
  const live = liveIn(cat.byUuid)
  const statuses = o.statuses !== undefined && o.statuses.length > 0 ? o.statuses : null
  const matches = o.search
    ? await archivedTaskMatcher(ctx, me.org_id, o.search, {
        stars: o.stars,
        names: async () => names,
      })
    : null
  const page = await archivedTasksPage(
    ctx,
    { orgId: me.org_id, projectIds: o.scope },
    o.cursor,
    o.limit,
    {
      /* Whether the filters keep `task`. An archived task is a group while it
       * has any subtask, which is read only when a filter still needs it after
       * the stored fields, such as a status that matches. The project's
       * readability is checked again to fail closed. */
      keeps: async (task, facts) => {
        const project = projectOf(task.project_id)
        if (project === undefined || !readable(project.id)) return false
        if (o.priority && task.priority !== o.priority) return false
        if (o.assignee && task.assignee_id !== o.assignee) return false
        if (statuses !== null && (!statuses.includes(task.status) || (await facts.isGroup())))
          return false
        if (o.owner && taskOwnerId(task, await facts.isGroup()) !== o.owner) return false
        return matches === null || (await matches(task, facts))
      },
      row: async (task, _facts, ceiling, first) => {
        // keeps found the project in the catalogue
        const project = projectOf(task.project_id) as Doc<'projects'>
        const counts = groupCounter(ctx, me, task, project, readable, projectOf)
        const walk = await subtreeIndex(ctx, task, counts, ceiling)
        let children = walk.children
        let partial = false
        if (!walk.whole) {
          // the walk does not fit this page, so the next page starts with it
          if (!first) return null
          // nor any page, so the group is listed without its plan weeks
          // and progress
          const kid = await firstSubtask(ctx, task)
          children = new Map(kid === null ? [] : [[task.id, [kid]]])
          partial = true
        }
        return await listRow(ctx, task, {
          surface: view.surface,
          me,
          readable,
          project,
          projectOf,
          names,
          orgSlug,
          children,
          live,
          counts,
          partial,
          // an archived task has no delay
          forecast: noForecast,
        })
      },
    },
  )
  return { rows: page.rows, next: page.next }
}

const byKeyOrder = (a: Doc<'projects'>, b: Doc<'projects'>): number => a.key.localeCompare(b.key)

/** The catalogue's readable projects on ONE side of the archived axis,
 * (archived_at set) === archived, ordered by key. REST GET /v1/projects and
 * MCP list_projects both list them. */
export function listProjectsCore(
  cat: Catalogue,
  archived: boolean,
  readable: (projectId: string) => boolean,
): Doc<'projects'>[] {
  return cat.projects
    .filter((p) => (p.archived_at !== undefined) === archived && readable(p.id))
    .sort(byKeyOrder)
}

/* core.ts childProjects, visibility applied (the Deno one ran under RLS):
 * the readable children of a meta, ordered by key. includeArchived follows
 * the meta's own state at the call sites — a live meta offers only its live
 * kids, an archived one everything it was put away with. */
export async function childProjectsCore(
  ctx: QueryCtx,
  parentId: string,
  o: { includeArchived: boolean; readable: (projectId: string) => boolean },
): Promise<Doc<'projects'>[]> {
  const out: Doc<'projects'>[] = []
  const kids = ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', parentId))
  for await (const c of kids) {
    if (!o.includeArchived && c.archived_at !== undefined) continue
    if (!o.readable(c.id)) continue
    out.push(c)
  }
  return out.sort(byKeyOrder)
}

/** The project ids a task list that names `project` covers. A meta adds its
 * readable sub-projects. For active tasks a live meta adds only its live
 * ones, asking for the project as it stands, and an archived meta all of
 * them, as it was put away (0106). For archived tasks it adds all of them,
 * archived ones included. The app's Archived tasks page leaves out a
 * sub-project archived on its own (lib/archivedTasks.ts archiveFamily). */
export function taskListScope(
  cat: Catalogue,
  project: Doc<'projects'>,
  readable: (projectId: string) => boolean,
  archivedTasks: boolean,
): string[] {
  if (project.type !== 'meta') return [project.id]
  const every = archivedTasks || project.archived_at !== undefined
  const subs = cat.projects.filter(
    (c) => c.parent_id === project.id && readable(c.id) && (every || c.archived_at === undefined),
  )
  return [project.id, ...subs.sort(byKeyOrder).map((c) => c.id)]
}

/** What a task list reads, either active tasks paged with `offset` or
 * archived ones paged with `cursor`, with the project ids it covers
 * (taskListScope), or null for every readable project that is not
 * archived. An archived list also names its project, whose list its cursors
 * belong to (archiveCursorText). */
export type TaskListRequest =
  | { archived: false; scope: string[] | null; offset: number }
  | { archived: true; project: string; scope: string[]; cursor: ArchiveCursor | null }

/**
 * A task list's paging arguments, checked by the rule REST and MCP share.
 * Archived tasks are listed one project at a time and page with a cursor,
 * so `archived` needs `project` and refuses an `offset` other than 0, and
 * only an archived list takes `cursor`. `flag` is how the surface spells
 * the archived flag in its refusals. `project` is already resolved and
 * readable.
 */
export async function taskListRequest(
  view: Pick<ListView, 'cat' | 'readable'>,
  a: {
    flag: 'archived=true' | 'archived: true'
    archived: boolean
    project: Doc<'projects'> | undefined
    offset: number
    cursor: string | undefined
  },
): Promise<TaskListRequest> {
  if (!a.archived) {
    if (a.cursor !== undefined) throw badRequest(`cursor works only with ${a.flag}`)
    const scope =
      a.project === undefined ? null : taskListScope(view.cat, a.project, view.readable, false)
    return { archived: false, scope, offset: a.offset }
  }
  if (a.project === undefined) {
    throw badRequest(
      `${a.flag} needs project, because archived tasks are listed one project at a time`,
    )
  }
  if (a.offset !== 0) {
    throw badRequest('offset does not apply to archived tasks; pass next_cursor as cursor')
  }
  const cursor = a.cursor === undefined ? null : await parseArchiveCursor(a.cursor, a.project.id)
  if (cursor === null && a.cursor !== undefined) {
    throw badRequest('cursor must be the next_cursor of an earlier page')
  }
  return {
    archived: true,
    project: a.project.id,
    scope: taskListScope(view.cat, a.project, view.readable, true),
    cursor,
  }
}

/* The organization's roster — people and agents alike, ordered by name. Not
 * gated on a project grant on either surface: the roster belongs to the org
 * the credential authenticates, and it is how an agent learns its own id. */
export async function listUsersCore(ctx: QueryCtx, me: Caller): Promise<Doc<'profiles'>[]> {
  const rows = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/* A project's people for the machine surfaces' project roster (REST
 * GET /v1/projects/{ref}/users, MCP list_project_users), ordered by name.
 * The caller must already have resolved a project it can read. A parent's
 * people are those with standing on the parent itself; someone who sees it
 * only through a sub-project is listed under that sub-project. A reporter
 * may be anyone listed; an assignee or reviewer needs `assignable`. Listed
 * and `assignable` are canAccessProject and profileCanBeAssigned, answered
 * for the whole roster from the project's grants (projectLevelsForProfiles),
 * so the read costs the same few index ranges however large the
 * organization is. */
export async function listProjectUsersCore(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
): Promise<(ReturnType<typeof userJson> & { assignable: boolean })[]> {
  const levelOf = await projectLevelsForProfiles(ctx, project)
  return (await listUsersCore(ctx, me)).flatMap((profile) => {
    const level = levelOf(profile)
    if (level === null) return []
    return [
      {
        ...userJson(profile),
        assignable: canHoldWork(profile) && levelRank(level) >= LEVEL_RANK.user,
      },
    ]
  })
}

/* The most comments one REST or MCP read answers, and how many it answers
 * unless the caller asks for fewer, and the refusal for a `before` that
 * names no comment on the task read (model/comments.ts). */
export { BEFORE_NOT_A_COMMENT, COMMENT_PAGE_MAX } from '../model/comments'

/* A page of a task's discussion thread for REST and MCP. It holds the
 * newest `limit` comments (model/comments.ts newestComments), or with
 * `before`, a comment's id, the newest ones the thread holds before that
 * comment. Answers them oldest first in the thread's order, the order they
 * were posted, in which the app's task window pages them. A caller reads
 * further back by passing the first comment's id as `before`, which is the
 * page's oldest, so no page repeats or skips a comment, and an empty page
 * means it reached the start. Comments imported with a created_at out of
 * that order stay in it. Refuses a `before` that is not a comment on this
 * task, unknown ids included. Visibility rides the issue, because callers
 * reach this only through findIssue. */
export async function listCommentsCore(
  ctx: QueryCtx,
  issueId: string,
  page: { limit: number; before?: string },
): Promise<Doc<'comments'>[]> {
  const before =
    page.before === undefined ? undefined : await commentAnchor(ctx, issueId, page.before)
  const rows = await newestComments(ctx, issueId, { limit: page.limit, before })
  return rows.reverse()
}

/* ------------------------------------------------------------- projections
 * One superset feeds both surfaces; each publishes its subset in ITS deployed
 * key order (the MCP body is 2-space pretty-printed — key order is the wire).
 * Every optional column is emitted as explicit `null`, never omitted: Convex
 * stores ABSENT, JSON.stringify drops undefined keys, and the published
 * shapes always carry the keys. A projection missing one `?? null` ships a
 * field-dropping regression invisible to typecheck — every null below is
 * load-bearing. Dates stay YYYY-MM-DD strings, timestamps full ISO strings,
 * remaining_hours a JSON number (on MCP this is the migration's DELIBERATE
 * wire delta vs the deployed driver pass-through — do not "fix" it back;
 * docs/mcp.md follows in phase 11). Reporter, assignee and reviewer are the
 * task's people fields on both machine surfaces. */

type IssueOutCommon = {
  id: string
  key: string
  num: number
  title: string
  description: string
  status: IssueStatus
  is_group: boolean
  priority: IssuePriority
  assignee_id: string | null
  assignee_name: string | null
  reviewer_id: string | null
  reviewer_name: string | null
  /** whose work it is: the reviewer while In Review, else the assignee */
  owner_id: string | null
  reporter_id: string | null
  reporter_name: string | null
  project_id: string
  project_key: string
  project_num: number
  /** null unless the caller can read the parent (has_hidden_parent) */
  parent_id: string | null
  has_hidden_parent: boolean
  start_week: string | null
  end_week: string | null
  due_date: string | null
  /** the app's projected delay, null when its project does not track delay
   *  or the app shows no verdict (lib/machineDelay.ts) */
  delay: DelayJson | null
  /** null for an active group, whose time is its subtasks'
   *  (group_remaining_hours on the single-task read), even while it still
   *  stores hours of its own */
  remaining_hours: number | null
  /** null for an active group, like remaining_hours */
  remaining_set_at: string | null
  paused: boolean
  /** a group's done and total leaves, null for a task without subtasks */
  progress: ProgressJson | null
  archived_at: string | null
  created_at: string
  updated_at: string
  /** when the newest comment was posted, null without comments */
  last_comment_at: string | null
  /** the app's Copy link address, null when SITE_URL is unset */
  url: string | null
}

/** A group's Progress as the app's task window shows it (src/lib/issueGroups.ts
 * groupProgress). It counts `done` of `total` leaves under it that the
 * reader is shown, with `percent` rounded and 0 without leaves. `partial` is
 * the app's "Completion unknown" (GroupFacts). */
export type ProgressJson = { done: number; total: number; percent: number; partial: boolean }

/* REST issueJson (rest:240-254): superset minus project_name, plus the
 * `archived` boolean. A group's plan weeks and progress are calculated
 * (groupFacts) on both surfaces, never from its dormant stored fields. */
export type RestIssueJson = IssueOutCommon & { archived: boolean }

/* MCP issueOut (mcp:93-102): superset minus the boolean (archived_at only);
 * names the project. */
export type McpIssueOut = IssueOutCommon & { project_name: string }

/* A people field's display name: from the caller's roster map on list calls,
 * else one point read. null when the field is unset or the profile is gone. */
async function profileName(
  ctx: QueryCtx,
  id: string | undefined,
  names: ReadonlyMap<string, string> | undefined,
): Promise<string | null> {
  if (id === undefined) return null
  if (names !== undefined) return names.get(id) ?? null
  return (await byId(ctx, 'profiles', id))?.name ?? null
}

export type IssueOutPre = {
  /** the issue's project, when the caller already holds it */
  project?: Doc<'projects'>
  /** the organization's projects by id, for list calls (skips per-project
   *  point reads) */
  projectOf?: (projectId: string) => Doc<'projects'> | undefined
  /** profile uuid → name, for list calls (skips per-row point reads) */
  names?: ReadonlyMap<string, string>
  /** the organization's slug, for list calls (task links) */
  orgSlug?: string
  /** tasks by id a list already read; a parent found here is not read again */
  tasks?: ReadonlyMap<string, Doc<'issues'>>
  /** each task's newest comment time a list already read (lastCommentTimes);
   *  a task missing here is read on its own */
  lastComments?: ReadonlyMap<string, string | null>
}

/** Tasks keyed by parent id, from whatever rows the caller read. */
export type ChildIndex = ReadonlyMap<string, readonly Doc<'issues'>[]>

export function childIndexOf(rows: Iterable<Doc<'issues'>>): ChildIndex {
  const index = new Map<string, Doc<'issues'>[]>()
  for (const row of rows) {
    if (row.parent_id === undefined) continue
    const kids = index.get(row.parent_id)
    if (kids === undefined) index.set(row.parent_id, [row])
    else kids.push(row)
  }
  return index
}

/** model/issues.ts hasSubtasks over an index (lib/liveTasks.ts
 * countsAsSubtask). An active task needs its active subtasks in the index,
 * an archived one all of them. */
const isGroupIn = (index: ChildIndex, task: Doc<'issues'>, live: ProjectLive): boolean => {
  const parent = layerOf(task, live)
  return (index.get(task.id) ?? []).some((kid) => countsAsSubtask(parent, layerOf(kid, live)))
}

/* How many projects taskOut reads one by one to tell which are live, before
 * it reads the organization's projects at once instead. */
const LIVENESS_POINT_READS = 16

/* Which projects are live, for the tasks of a single-task read's subtree
 * index and its root. It answers from `projectOf` when the caller holds the
 * organization's projects, else from each project read once, or from the
 * organization's projects at once when the index names more than
 * LIVENESS_POINT_READS of them, as the index of a subtree too large to walk
 * does. */
async function indexLiveness(
  ctx: QueryCtx,
  root: Doc<'issues'>,
  children: ChildIndex,
  projectOf?: (projectId: string) => Doc<'projects'> | undefined,
): Promise<ProjectLive> {
  if (projectOf !== undefined) {
    return (id) => {
      const project = projectOf(id)
      return project !== undefined && project.archived_at === undefined
    }
  }
  const ids = new Set([root.project_id])
  for (const kids of children.values()) for (const kid of kids) ids.add(kid.project_id)
  if (ids.size > LIVENESS_POINT_READS) {
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', root.org_id))
      .collect()
    return liveIn(new Map(projects.map((p) => [p.id, p])))
  }
  const reads = projectLiveness(ctx)
  const known = new Map<string, boolean>()
  for (const id of ids) known.set(id, await reads(id))
  return (id) => known.get(id) ?? false
}

/* --------------------------------------------- what a read says of others
 * A machine read is shown the tasks whose project the caller can read
 * (findIssue's rule), archived ones included. Every task a read names
 * besides the one asked for (parent, subtasks, links, group totals) passes
 * lib/workingSet.ts with this Shown, as the app's snapshot passes its
 * working set. */

/** How many projects a read without the surface's flags checks one at a
 * time (lazyReach) before it answers for the whole organization at once
 * (orgReach). A check costs about three index ranges for a caller who is not
 * an admin, and orgReach reads the organization's projects. Tests change
 * `checks`. */
export const ACCESS_POINT_CHECKS = { checks: 16 }

/** Each project and whether the caller can read it, for a read without the
 * surface's flags. */
type ProjectReach = {
  project: (projectId: string) => Promise<Doc<'projects'> | null>
  reads: (projectId: string) => Promise<boolean>
}

/* A ProjectReach that reads each project and checks it (seesProject),
 * once each, until it has met ACCESS_POINT_CHECKS projects, and answers the
 * rest from the organization's projects and the caller's levels at once
 * (orgReach), the same rule (accessFlags), which a link or a family with
 * many sub-projects needs. */
function lazyReach(ctx: QueryCtx, me: Caller): ProjectReach {
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const reads = new Map<string, Promise<boolean>>()
  let reach: ReturnType<typeof orgReach> | undefined
  const project = (projectId: string) => {
    let result = projects.get(projectId)
    if (result === undefined) {
      if (projects.size >= ACCESS_POINT_CHECKS.checks) reach ??= orgReach(ctx, me)
      result =
        reach !== undefined
          ? reach.then((r) => r.projectOf(projectId) ?? null)
          : byId(ctx, 'projects', projectId)
      projects.set(projectId, result)
    }
    return result
  }
  return {
    project,
    reads: (projectId) => {
      let result = reads.get(projectId)
      if (result === undefined) {
        result = project(projectId).then(async (p) => {
          if (p === null) return false
          if (reach !== undefined) return (await reach).readable(p.id)
          return await seesProject(ctx, me, p)
        })
        reads.set(projectId, result)
      }
      return result
    },
  }
}

/** The caller's project read access, from the surface's flags when it holds
 * them, else canSeeProject, read once per project, or past
 * ACCESS_POINT_CHECKS projects from the caller's levels in the whole
 * organization (lazyReach). */
export function projectReader(
  ctx: QueryCtx,
  me: Caller,
  readable?: (projectId: string) => boolean,
): (projectId: string) => Promise<boolean> {
  if (readable !== undefined) return async (projectId) => readable(projectId)
  return lazyReach(ctx, me).reads
}

/** The Shown of a machine read over these tasks: the ones in the caller's
 * organization whose project it can read. */
export async function machineShown(
  tasks: Iterable<Doc<'issues'>>,
  me: Caller,
  reads: (projectId: string) => Promise<boolean>,
): Promise<Shown> {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (task.org_id === me.org_id && (await reads(task.project_id))) ids.add(task.id)
  }
  return (taskId) => ids.has(taskId)
}

/* The parent link on both surfaces (lib/workingSet.ts parentLink): the
 * parent's uuid only when this caller can read the parent, else only that a
 * parent exists. `readable` is the caller's project flags when the surface
 * already holds them, which saves the visibility walk per row, and `tasks`
 * the rows a list already read, which saves the parent's read. */
async function parentOut(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  readable?: (projectId: string) => boolean,
  tasks?: ReadonlyMap<string, Doc<'issues'>>,
): Promise<{ parent_id: string | null; has_hidden_parent: boolean }> {
  const parent =
    issue.parent_id === undefined
      ? null
      : (tasks?.get(issue.parent_id) ?? (await byId(ctx, 'issues', issue.parent_id)))
  const shown = await machineShown(
    parent === null ? [] : [parent],
    me,
    projectReader(ctx, me, readable),
  )
  const link = parentLink(issue, shown)
  return { parent_id: link.parent_id ?? null, has_hidden_parent: link.has_hidden_parent }
}

/** The app's Copy link address of a task (src/lib/router.ts issueLink), or
 * null when the deployment names no SITE_URL. */
export function taskUrl(orgSlug: string, num: number): string | null {
  const site = process.env.SITE_URL?.trim().replace(/\/+$/, '')
  if (!site) return null
  return `${site}/app/${orgSlug}/tasks/${encodeURIComponent(issueKey(num).toLowerCase())}`
}

/* How many tasks a single-task read of an active task walks, one by_parent
 * read at a time, before it reads the active tasks once instead
 * (activeTasksUnder), the read an active list makes anyway. The read walks
 * the subtree once (subtreeIndex) and every group total uses that one
 * index, which keeps both Convex limits in reach. Index ranges stay far
 * below 4,096, and only a group with more tasks that count under it than
 * this pays a full read. An archived task's walk stops at a ceiling instead
 * (TASK_READ_RESERVE). Tests lower `reads`. */
export const SUBTREE_WALK = { reads: 1000 }

/** What a single-task read of an archived task keeps back from the
 * request's limits for the reads after its subtree walk, which stops short
 * of them. They are the task's parent, people and newest comment. What has
 * no fixed count is read before the walk: the access to every project of
 * the organization, answered at once (orgReach), and the task's links,
 * labels, followers and attachments (taskRelations). Tests lower these. */
export const TASK_READ_RESERVE = {
  ranges: 1024,
  documents: 4096,
  bytes: 4 * DOCUMENT_MAX_BYTES,
}

/* A subtree index, whether the walk read all of it, and whether it read
 * all of the root's own subtasks (`rootWhole`). A walk that a ceiling
 * stopped holds the subtasks of each task whose read it finished, the
 * root's first, or the root's subtasks it read before it stopped. */
type Walk = { children: ChildIndex; whole: boolean; rootWhole: boolean }

/* The subtasks a single-task read of `root` uses, indexed by parent. They
 * are the root's own and those of every task under it that counts toward
 * its totals (`counts`, groupCounter). is_group and the subtask list need
 * only the root's subtasks, and the totals' walks enter only tasks that
 * count and need each one's subtasks to tell a leaf from a group, so a
 * branch that cannot count is never read below its top. It reads one level
 * at a time, and the seen set stops a corrupt cycle. Each task a level
 * enters takes one read. An active root's walk reads only active subtasks
 * (by_parent_archived), because an active group counts nothing else and
 * lists nothing else, so each read holds at most SUBTASK_MAX tasks however
 * many archived subtasks have gathered. An active root's walk that would
 * pass SUBTREE_WALK reads reads the organization's active tasks once
 * instead, as soon as a level shows it. It enters only active tasks, and
 * each decision about one needs only its active subtasks (isGroupIn), so
 * the organization's active tasks are all it needs.
 *
 * An archived root's walk needs a `ceiling`, because it can enter the
 * task's whole history, and it never reads the organization's tasks. It
 * keeps the request's reads under the ceiling before each by_parent read
 * and after each task, since one read can hold many large tasks
 * (lib/archivedTasks.ts ceilingGuard, which needs a `counts` that reads
 * nothing, as the readable flags and projectOf together give it). Once they
 * reach the ceiling, or
 * a level holds more tasks than the ceiling leaves ranges for, it stops,
 * with the subtasks of each task whose read it finished, or the root's
 * subtasks it read so far when it stops in the root's own read. */
async function subtreeIndex(
  ctx: QueryCtx,
  root: Doc<'issues'>,
  counts: GroupCounter,
  ceiling?: ReadCeiling,
): Promise<Walk> {
  if (ceiling === undefined && root.archived_at !== undefined) {
    throw new Error('an archived task walks its subtree under a ceiling')
  }
  const index = new Map<string, Doc<'issues'>[]>()
  // a walk that stops has read the root's own subtasks whole once their
  // range is in the index, unless it stopped inside that range
  const stopped = (): Walk => ({ children: index, whole: false, rootWhole: index.has(root.id) })
  const guard = ceiling === undefined ? null : ceilingGuard(ctx, ceiling)
  const seen = new Set<string>([root.id])
  let frontier = [root.id]
  let reads = 0
  while (frontier.length > 0) {
    // a level that cannot be read whole ends the walk before its first read
    reads += frontier.length
    if (ceiling !== undefined) {
      if (frontier.length > (await rangesLeft(ctx, ceiling))) return stopped()
    } else if (reads > SUBTREE_WALK.reads) {
      // the root's own subtasks are read first, so they are in the index
      return {
        children: await activeTasksUnder(ctx, root, index.get(root.id) ?? []),
        whole: true,
        rootWhole: true,
      }
    }
    const next: string[] = []
    for (const id of frontier) {
      if (guard !== null && !(await guard.range())) return stopped()
      const kids: Doc<'issues'>[] = []
      const read =
        root.archived_at === undefined
          ? ctx.db
              .query('issues')
              .withIndex('by_parent_archived', (q) =>
                q.eq('parent_id', id).eq('archived_at', undefined),
              )
          : ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parent_id', id))
      for await (const kid of read) {
        kids.push(kid)
        if (guard !== null && !(await guard.document())) {
          if (id !== root.id) return stopped()
          index.set(id, kids)
          return { children: index, whole: false, rootWhole: false }
        }
      }
      index.set(id, kids)
      for (const kid of kids) {
        if (seen.has(kid.id) || !(await counts(kid))) continue
        seen.add(kid.id)
        next.push(kid.id)
      }
    }
    frontier = next
  }
  return { children: index, whole: true, rootWhole: true }
}

/* The subtasks an active root's walk uses once it passes SUBTREE_WALK,
 * indexed by parent, with the root's own subtasks `kids`. Under a root in
 * an active project only subtasks in active projects count
 * (countsAsSubtask), so the active projects' tasks hold every one the walk
 * would enter, as an active list reads them (listedActiveTasks), and `kids`
 * keep the root's subtasks in archived projects for its subtask list. A
 * root in an archived project counts every active subtask, so it reads the
 * organization's active tasks. */
async function activeTasksUnder(
  ctx: QueryCtx,
  root: Doc<'issues'>,
  kids: readonly Doc<'issues'>[],
): Promise<ChildIndex> {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', root.org_id))
    .collect()
  if (projects.some((p) => p.id === root.project_id && p.archived_at === undefined)) {
    const index = new Map(childIndexOf(await liveTasksOf(ctx, projects)))
    index.set(root.id, kids)
    return index
  }
  const active = await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', root.org_id).eq('archived_at', undefined))
    .collect()
  return childIndexOf(active)
}

/* The subtree index of a single-task read of `root` (subtreeIndex),
 * whether the group's facts went unread (Subtree.partial), and whether the
 * root has subtasks the index leaves out (`more`). An archived task's walk
 * takes what the request has left less TASK_READ_RESERVE, so no read of it,
 * a write's answer included, passes Convex's limits however many long
 * archived subtasks it has. When that stops the walk, the index keeps only
 * the root's own subtasks, which it reads first, as many as fit. When not
 * even one fit, it reads the first, within the reserve, so the read still
 * tells a group from a leaf, and it reads one past the last listed, so
 * `more` is set only when a subtask is left out. Active subtasks number at
 * most SUBTASK_MAX, so an active task's read lists them all. */
async function taskSubtree(
  ctx: QueryCtx,
  root: Doc<'issues'>,
  counts: GroupCounter,
): Promise<{ children: ChildIndex; partial: boolean; more: boolean }> {
  if (root.archived_at === undefined) {
    const { children } = await subtreeIndex(ctx, root, counts)
    return { children, partial: false, more: false }
  }
  const room = roomOf(await ctx.meta.getTransactionMetrics(), TASK_READ_RESERVE)
  const walk = await subtreeIndex(ctx, root, counts, room)
  if (walk.whole) return { children: walk.children, partial: false, more: false }
  let kids = walk.children.get(root.id) ?? []
  if (walk.rootWhole) return { children: new Map([[root.id, kids]]), partial: true, more: false }
  // the first subtask in by_parent order that is not among `read`: the
  // first of all when none was read, and past them all whether any is left
  // out. Subtasks created at the same moment as the last one read are
  // looked at too, past those already read.
  const after = async (read: readonly Doc<'issues'>[]): Promise<Doc<'issues'> | null> => {
    const last = read.at(-1)
    // those read at the last one's moment, which the range starts with
    const tied = read.filter((kid) => kid._creationTime === last?._creationTime)
    const seen = new Set(tied.map((kid) => kid.id))
    const rest = await ctx.db
      .query('issues')
      .withIndex('by_parent', (q) =>
        last === undefined
          ? q.eq('parent_id', root.id)
          : q.eq('parent_id', root.id).gte('_creationTime', last._creationTime),
      )
      .take(tied.length + 1)
    return rest.find((kid) => !seen.has(kid.id)) ?? null
  }
  if (kids.length === 0) {
    const first = await after([])
    kids = first === null ? [] : [first]
  }
  const more = kids.length > 0 && (await after(kids)) !== null
  return { children: new Map([[root.id, kids]]), partial: true, more }
}

/** Whether a task under a group counts toward the group's totals. */
type GroupCounter = (task: Doc<'issues'>) => Promise<boolean>

/**
 * The one rule for which tasks under `group` count toward its calculated
 * plan weeks, progress and remaining hours, for `me`. A task counts when the
 * caller can read its project. Like is_group, an active group counts only active
 * subtasks and an archived one its whole subtree. Under a group in an active
 * project, subtasks in archived projects do not count. The totals' walks
 * never enter a task that does not count, so nothing under it counts either,
 * and they also enter only subtasks that make the task above them a group
 * (lib/liveTasks.ts countsAsSubtask).
 * `readable` is the caller's project flags when the surface already holds
 * them, and `projectOf` its catalogue. Without them each project is read
 * and checked once, or past ACCESS_POINT_CHECKS answered with the rest of
 * the organization (lazyReach).
 */
function groupCounter(
  ctx: QueryCtx,
  me: Caller,
  group: Doc<'issues'>,
  groupProject: Doc<'projects'>,
  readable?: (projectId: string) => boolean,
  projectOf?: (projectId: string) => Doc<'projects'> | undefined,
): GroupCounter {
  const allArchived = group.archived_at !== undefined
  const liveProject = groupProject.archived_at === undefined
  const byProject = new Map<string, Promise<boolean>>()
  // reads nothing until a project is missing from what the surface holds
  const reach = lazyReach(ctx, me)
  return async (task) => {
    if (task.org_id !== me.org_id) return false
    if (!allArchived && task.archived_at !== undefined) return false
    let known = byProject.get(task.project_id)
    if (known === undefined) {
      known = (async () => {
        const p =
          projectOf !== undefined
            ? (projectOf(task.project_id) ?? null)
            : await reach.project(task.project_id)
        if (p === null || (liveProject && p.archived_at !== undefined)) return false
        return readable !== undefined ? readable(p.id) : await reach.reads(p.id)
      })()
      byProject.set(task.project_id, known)
    }
    return await known
  }
}

/** What a group's subtree says about it to one reader, over the tasks
 * groupCounter counts. It holds the calculated plan weeks (the app's
 * groupSpan) and how many of its leaves are done (the app's groupProgress).
 * `partial` is the app's "Completion unknown". It is set when a subtask that
 * makes a task a group does not count for the reader (hidden from it), or
 * when the walk meets a task twice (a cycle). A subtask in an archived
 * project under a task in an active one makes it no group, so it leaves
 * nothing unknown. */
export type GroupFacts = {
  start_week: string | null
  end_week: string | null
  done: number
  total: number
  partial: boolean
}

/* The facts of a group whose subtree is too large to read (Subtree.partial). */
const UNREAD_SUBTREE: GroupFacts = {
  start_week: null,
  end_week: null,
  done: 0,
  total: 0,
  partial: true,
}

/* On REST and MCP a group's plan weeks run from the earliest start to the
 * latest end of the scheduled leaves under it that count (groupCounter), at
 * any depth, and its progress counts those leaves, scheduled or not, and the
 * Done ones among them. A nested group counts only through its own leaves;
 * its stored dates and status are dormant. A leaf without an end counts as
 * its start week. Done leaves count. Both weeks are null when no such leaf
 * is scheduled. `children` holds the group's subtree by parent. An active
 * list passes the index of the active tasks it already read, and an
 * archived list and a single-task read pass the row's subtreeIndex. Each
 * visited task's children decide whether it is a group (hasSubtasks' rule,
 * whoever can read them, with `live` telling which projects are active)
 * and what the walk enters next. */
async function groupFacts(
  group: Doc<'issues'>,
  children: ChildIndex,
  counts: GroupCounter,
  live: ProjectLive,
): Promise<GroupFacts> {
  let start: string | undefined
  let end: string | undefined
  let done = 0
  let total = 0
  let partial = false
  const seen = new Set<string>([group.id])
  let frontier: Doc<'issues'>[] = [group]
  // one level of subtasks, so the walk ends a level below the group; the
  // seen set stops a corrupt cycle
  while (frontier.length > 0) {
    const next: Doc<'issues'>[] = []
    for (const task of frontier) {
      if (task !== group && !isGroupIn(children, task, live)) {
        total++
        if (task.status === 'done') done++
        if (task.start_week === undefined) continue
        const leafEnd = task.end_week ?? task.start_week
        if (start === undefined || task.start_week < start) start = task.start_week
        if (end === undefined || leafEnd > end) end = leafEnd
        continue
      }
      // a group, the root included, counts only through the subtasks that
      // make it one. One that is not entered leaves part of it unknown to
      // the reader, as a hidden subtask does in the app
      const above = layerOf(task, live)
      for (const c of children.get(task.id) ?? []) {
        if (!countsAsSubtask(above, layerOf(c, live))) continue
        if (seen.has(c.id) || !(await counts(c))) {
          partial = true
          continue
        }
        seen.add(c.id)
        next.push(c)
      }
    }
    frontier = next
  }
  return { start_week: start ?? null, end_week: end ?? null, done, total, partial }
}

/* A group's facts as the Progress the rows send. */
const progressOf = (facts: GroupFacts): ProgressJson => ({
  done: facts.done,
  total: facts.total,
  percent: facts.total === 0 ? 0 : Math.round((facts.done / facts.total) * 100),
  partial: facts.partial,
})

/** Who reads a task, and through which surface's shape. `readable` is the
 * caller's project flags when the surface already holds them. */
type Reader = {
  surface: 'rest' | 'mcp'
  me: Caller
  readable?: (projectId: string) => boolean
}

/** The tasks by parent that a row's group facts come from. An active list
 * passes the active tasks it read, and an archived list and a single-task
 * read the task's subtreeIndex with the groupCounter that walk used, which
 * the totals then share. `live` tells which of their projects are active.
 * `partial` says the subtree was too large to read and `children` holds
 * only the root's subtasks (a single-task read) or one of them (an archived
 * list), so a group answers null plan weeks and a partial progress that
 * counts nothing. */
type Subtree = {
  children: ChildIndex
  live: ProjectLive
  counts?: GroupCounter
  partial?: boolean
}

/** How a row gets its delay verdict, from its group facts (lib/machineDelay.ts). */
type Forecast = { forecast: Forecaster }

export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree & Forecast & { surface: 'rest' },
): Promise<RestIssueJson>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree & Forecast & { surface: 'mcp' },
): Promise<McpIssueOut>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree & Forecast,
): Promise<RestIssueJson | McpIssueOut> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  const is_group = isGroupIn(opts.children, issue, opts.live)
  const assignee_name = await profileName(ctx, issue.assignee_id, opts.names)
  const reviewer_name = await profileName(ctx, issue.reviewer_id, opts.names)
  const reporter_name = await profileName(ctx, issue.reporter_id, opts.names)
  const facts = !is_group
    ? null
    : opts.partial === true
      ? UNREAD_SUBTREE
      : await groupFacts(
          issue,
          opts.children,
          opts.counts ?? groupCounter(ctx, opts.me, issue, project, opts.readable, opts.projectOf),
          opts.live,
        )
  // An active group can still store hours from before its subtasks counted,
  // until convex/regroup.ts clears them. They are stale, so neither surface
  // shows them. An archived task counts its archived subtasks as a group but
  // keeps its own hours for its restore, and the remaining-time writes take
  // them (model/issues.ts hasActiveSubtasks), so it shows them.
  const hours =
    is_group && issue.archived_at === undefined
      ? { remaining_hours: null, remaining_set_at: null }
      : {
          remaining_hours: issue.remaining_hours ?? null,
          remaining_set_at: issue.remaining_set_at ?? null,
        }
  const weeks =
    facts === null
      ? { start_week: issue.start_week ?? null, end_week: issue.end_week ?? null }
      : { start_week: facts.start_week, end_week: facts.end_week }
  const progress = facts === null ? null : progressOf(facts)
  const delay = await opts.forecast(issue, project, facts)
  const parent = await parentOut(ctx, opts.me, issue, opts.readable, opts.tasks)
  const owner_id = taskOwnerId(issue, is_group) ?? null
  const orgSlug = opts.orgSlug ?? (await byId(ctx, 'organizations', issue.org_id))?.slug ?? '~'
  const url = taskUrl(orgSlug, issue.num)
  const last_comment_at = opts.lastComments?.has(issue.id)
    ? (opts.lastComments.get(issue.id) ?? null)
    : ((await latestComment(ctx, issue.id))?.created_at ?? null)
  if (opts.surface === 'rest') {
    return {
      id: issue.id,
      key: issueKey(issue.num),
      num: issue.num,
      project_id: issue.project_id,
      project_key: project.key,
      project_num: project.num,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      is_group,
      priority: issue.priority,
      assignee_id: issue.assignee_id ?? null,
      assignee_name,
      reviewer_id: issue.reviewer_id ?? null,
      reviewer_name,
      owner_id,
      reporter_id: issue.reporter_id ?? null,
      reporter_name,
      parent_id: parent.parent_id,
      has_hidden_parent: parent.has_hidden_parent,
      start_week: weeks.start_week,
      end_week: weeks.end_week,
      due_date: issue.due_date ?? null,
      delay,
      remaining_hours: hours.remaining_hours,
      remaining_set_at: hours.remaining_set_at,
      paused: issue.paused,
      progress,
      archived: issue.archived_at !== undefined,
      archived_at: issue.archived_at ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      last_comment_at,
      url,
    }
  }
  return {
    id: issue.id,
    key: issueKey(issue.num),
    num: issue.num,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    is_group,
    priority: issue.priority,
    assignee_id: issue.assignee_id ?? null,
    assignee_name,
    reviewer_id: issue.reviewer_id ?? null,
    reviewer_name,
    owner_id,
    reporter_id: issue.reporter_id ?? null,
    reporter_name,
    project_id: issue.project_id,
    project_key: project.key,
    project_num: project.num,
    project_name: project.name,
    parent_id: parent.parent_id,
    has_hidden_parent: parent.has_hidden_parent,
    start_week: weeks.start_week,
    end_week: weeks.end_week,
    due_date: issue.due_date ?? null,
    delay,
    remaining_hours: hours.remaining_hours,
    remaining_set_at: hours.remaining_set_at,
    paused: issue.paused,
    progress,
    archived_at: issue.archived_at ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    last_comment_at,
    url,
  }
}

/* --------------------------------------------------- the single-task read
 * GET /v1/tasks/{ref} (and the REST create and update answers) and MCP
 * get_task add what a list row leaves out: the task's labels, its subtasks,
 * its links, for a group its remaining hours, who follows it (taskDetail)
 * and its attachments (taskOut). Each names other tasks only through
 * lib/workingSet.ts with the machine Shown. */

/** Another task as a read names it. */
export type TaskRefJson = { id: string; key: string; title: string; status: IssueStatus }

export type TaskDetailJson = TaskFollowJson & {
  /** a group's remaining hours as the app shows them, null for a leaf and
   * for a group whose subtree is too large to read */
  group_remaining_hours: number | null
  labels: ReturnType<typeof labelJson>[]
  /** the subtasks the caller can read, active ones for an active task */
  subtasks: TaskRefJson[]
  /** whether an archived task has more subtasks than one read could list */
  has_more_subtasks: boolean
  /** the links whose other task the caller can read, as seen from this one */
  links: (TaskRefJson & { kind: TaskLinkKind })[]
}

/** Whether the reader follows the task, and who does (model/messages.ts
 * followersOf, the app's follower list). */
export type TaskFollowJson = {
  following: boolean
  followers: { id: string; name: string }[]
}

/** Another task as a read names it: id, key, title and status. */
export const taskRefOf = (t: Doc<'issues'>): TaskRefJson => ({
  id: t.id,
  key: issueKey(t.num),
  title: t.title,
  status: t.status,
})

/* Orders tasks by number, lowest first. */
const byNum = (a: Doc<'issues'>, b: Doc<'issues'>): number => a.num - b.num

/* The single-task read's fields that do not depend on the subtree: the
 * links and labels `me` can see and the followers. */
export type TaskRelations = Pick<TaskDetailJson, 'labels' | 'links'> & {
  followers: Doc<'profiles'>[]
}

/* The links, labels and followers of `issue` as `me` reads them. A
 * single-task read takes them before its subtree walk (taskOut), because
 * none of them has a fixed count. */
export async function taskRelations(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  readable?: (projectId: string) => boolean,
): Promise<TaskRelations> {
  const reads = projectReader(ctx, me, readable)
  const links: TaskDetailJson['links'] = []
  const linked: { link: Doc<'issue_links'>; other: Doc<'issues'> }[] = []
  for (const link of await linksOf(ctx, issue.id)) {
    const other = await byId(
      ctx,
      'issues',
      link.source_id === issue.id ? link.target_id : link.source_id,
    )
    if (other !== null) linked.push({ link, other })
  }
  const linkSees = await machineShown([issue, ...linked.map((l) => l.other)], me, reads)
  for (const { link, other } of linked.sort((a, b) => byNum(a.other, b.other))) {
    if (!linkShown(link, linkSees)) continue
    links.push({ kind: linkKindFrom(link, issue.id), ...taskRefOf(other) })
  }
  const labels: Doc<'labels'>[] = []
  const attached = ctx.db
    .query('issue_labels')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
  for await (const row of attached) {
    const label = await byId(ctx, 'labels', row.label_id)
    if (label !== null && label.org_id === issue.org_id) labels.push(label)
  }
  labels.sort((a, b) => a.name_lower.localeCompare(b.name_lower) || a.id.localeCompare(b.id))
  return { labels: labels.map(labelJson), links, followers: await followersOf(ctx, issue) }
}

/**
 * The single-task read's extra fields for `issue`, read by `me`, with the
 * `relations` taskOut read first. `isGroup`, `project`, `children` (its
 * subtreeIndex), `live`, `counts` (the groupCounter that walk used) and
 * `partial` (the subtree was too large to read) are what taskOut already
 * holds, and `more` that the root has subtasks `children` leaves out. The
 * group total counts what groupCounter counts, as the plan weeks do, and is
 * null when the subtree went unread.
 */
export async function taskDetail(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  relations: TaskRelations,
  o: {
    project: Doc<'projects'>
    isGroup: boolean
    children: ChildIndex
    live: ProjectLive
    counts?: GroupCounter
    partial?: boolean
    more?: boolean
    readable?: (projectId: string) => boolean
  },
): Promise<TaskDetailJson> {
  const reads = projectReader(ctx, me, o.readable)
  const allArchived = issue.archived_at !== undefined
  const childrenOf = (id: string): readonly Doc<'issues'>[] => o.children.get(id) ?? []
  const kids = childrenOf(issue.id)
  const shown = await machineShown(kids, me, reads)
  const subtasks = kids
    .filter((kid) => (allArchived || kid.archived_at === undefined) && shown(kid.id))
    .sort(byNum)
    .map(taskRefOf)
  let group_remaining_hours: number | null = null
  if (o.isGroup && o.partial !== true) {
    const counts = o.counts ?? groupCounter(ctx, me, issue, o.project, o.readable)
    const counted = new Set<string>()
    for (const task of [...o.children.values()].flat()) {
      if (await counts(task)) counted.add(task.id)
    }
    group_remaining_hours = groupRemainingHours(issue, childrenOf, (id) => counted.has(id), o.live)
  }
  const { labels, links, followers } = relations
  return {
    group_remaining_hours,
    labels,
    subtasks,
    has_more_subtasks: o.more === true,
    links,
    following: followers.some((p) => p.id === me.id),
    followers: followers.map((p) => ({ id: p.id, name: p.name })),
  }
}

/** The task's attachments with download links minted for the reader
 * (model/attachments.ts taskAttachments), inline images included. */
export type TaskAttachmentsJson = { attachments: AttachmentJson[] }

/** The request's UTC day (YYYY-MM-DD), which a single-task read judges the
 * task's delay by (the HTTP action's for a query, the mutation's own for a
 * REST write answer). */
type Clock = { today: string }

/** issueOut plus taskDetail and the attachments, the shape of every
 * single-task read. */
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Clock & { surface: 'rest' },
): Promise<RestIssueJson & TaskDetailJson & TaskAttachmentsJson>
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Clock & { surface: 'mcp' },
): Promise<McpIssueOut & TaskDetailJson & TaskAttachmentsJson>
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Clock,
): Promise<(RestIssueJson | McpIssueOut) & TaskDetailJson & TaskAttachmentsJson> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  // an archived task's walk can meet many projects, so their access is
  // answered for the whole organization at once, and the walk and the reads
  // after it check none of them one at a time
  const reach =
    issue.archived_at !== undefined && opts.readable === undefined
      ? await orgReach(ctx, opts.me)
      : undefined
  const readable = opts.readable ?? reach?.readable
  const projectOf = opts.projectOf ?? reach?.projectOf
  // what does not depend on the subtree is read first, so an archived
  // task's walk takes only the room those reads leave (taskSubtree)
  const relations = await taskRelations(ctx, opts.me, issue, readable)
  const attachments = await taskAttachments(ctx, opts.me, issue)
  // one walk of the subtree serves the row's group facts and the detail,
  // and one counter its pruning and both totals
  const counts = groupCounter(ctx, opts.me, issue, project, readable, projectOf)
  const { children, partial, more } = await taskSubtree(ctx, issue, counts)
  const live = await indexLiveness(ctx, issue, children, projectOf)
  const subtree = { project, children, live, counts, partial }
  const org = await byId(ctx, 'organizations', issue.org_id)
  const read = {
    ...subtree,
    orgSlug: opts.orgSlug ?? org?.slug,
    forecast: taskForecaster(ctx, opts.me, delayClock(org, opts.today)),
  }
  const row =
    opts.surface === 'rest'
      ? await issueOut(ctx, issue, { ...opts, readable, projectOf, ...read, surface: 'rest' })
      : await issueOut(ctx, issue, { ...opts, readable, projectOf, ...read, surface: 'mcp' })
  const detail = await taskDetail(ctx, opts.me, issue, relations, {
    ...subtree,
    more,
    isGroup: row.is_group,
    readable,
  })
  return { ...row, ...detail, attachments }
}

/* Which projects `me` can read, and each of the organization's projects by
 * id, from one read of its projects and the caller's grants and team
 * shares (projectLevelsForOrg), the read flag accessFlags gives lists. */
async function orgReach(
  ctx: QueryCtx,
  me: Caller,
): Promise<{
  readable: (projectId: string) => boolean
  projectOf: (projectId: string) => Doc<'projects'> | undefined
}> {
  const cat = await loadCatalogue(ctx, me)
  const { levelOf } = await projectLevelsForOrg(ctx, me, cat.projects)
  const projectOf = (projectId: string) => cat.byUuid.get(projectId)
  return {
    readable: (projectId) => {
      const p = projectOf(projectId)
      return p !== undefined && levelOf(p) !== null
    },
    projectOf,
  }
}

/* ------------------------------------------------------------ destinations
 * Where a REST or MCP move sends a task, named with create's grammar:
 * `project` names a sub-project, or a project whose sub-project
 * `sub_project` names. A project or sub-project the caller cannot read
 * answers like an unknown one; an archived one takes no tasks; a project
 * named without its sub-project lists the ones the caller can write. The
 * caller checks write access to the answer with its own sentence. */
export function destinationOf(
  cat: Catalogue,
  can: { readable: (id: string) => boolean; writable: (id: string) => boolean },
  ref: { project: string; sub_project?: string },
  unknownProject: (ref: string) => ConvexError<Refusal>,
): Doc<'projects'> {
  const project = findProjectRef(cat, ref.project)
  if (project === undefined || !can.readable(project.id)) throw unknownProject(ref.project)
  assertLive(project)
  let target = project
  if (ref.sub_project !== undefined) {
    const sub = ref.sub_project.trim() !== '' ? findProjectRef(cat, ref.sub_project) : undefined
    if (sub === undefined || !can.readable(sub.id)) throw badRequest(SUB_MUST_NAME)
    pairRule(project, sub)
    target = sub
  } else if (project.type === 'meta') {
    metaNeedsSub(
      project,
      cat.projects.filter((c) => c.parent_id === project.id && c.archived_at === undefined),
      can,
    )
  }
  // a sub can be archived on its own
  assertLive(target)
  return target
}

/* ------------------------------------------------------------ task updates
 * A REST PATCH /v1/tasks/{ref} and an MCP update_task can change several
 * things about a task at once. Each surface parses the request, runs its
 * own pre-checks in its pinned order with its own sentences, and then hands
 * the checked change to applyTaskUpdate, which writes it the same way for
 * both. */

/**
 * Writes one machine task update in a fixed order: the move to
 * `destination`, the new `parent` (null detaches), the field `patch` with
 * the `archive` toggle folded into the same write, the `labels` to add and
 * remove, then `reason` as a comment when this update archived the task. A
 * parent that is already the task's parent and an `archive` that matches
 * the task's state change nothing. Each step that changes something writes
 * its own activity row signed with `provenance`, and each runs the model's
 * own rules and write gate, so a refusal at any step undoes the whole
 * update. The move and the parent are checked with the assignee and
 * reviewer the task ends up with, so the ones `patch` sets or clears take
 * the place of the current ones (model/issues.ts LaterPeople). A subtask
 * moved to another top-level project must leave its parent in the same
 * update, so the move is told the `parent` that follows it
 * (MachineMove.laterParent). Answers the task as written.
 */
export async function applyTaskUpdate(
  ctx: MutationCtx,
  a: {
    me: Caller
    issue: Doc<'issues'>
    destination?: Doc<'projects'>
    parent?: string | null
    patch: IssuePatch
    archive?: boolean
    labels: { add: readonly Doc<'labels'>[]; remove: readonly Doc<'labels'>[] }
    reason?: string
    now: string
    provenance: string
    /** What the caller read, as REST and MCP show it (model/expected.ts). */
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<Doc<'issues'>> {
  const { me, now, provenance } = a
  // against the task as it is before the move changes it
  await assertTaskExpected(ctx, {
    me,
    issue: a.issue,
    view: 'machine',
    expected: a.expected,
    next: {
      ...a.patch,
      ...(a.parent !== undefined ? { parent_id: a.parent, has_hidden_parent: null } : {}),
      ...(a.destination !== undefined ? { project_id: a.destination.id } : {}),
    },
    destination: a.destination,
  })
  const archives = a.archive === true && a.issue.archived_at === undefined
  const toggles = a.archive !== undefined && a.archive !== (a.issue.archived_at !== undefined)
  // the people the field patch sets, which that write checks itself
  const later: LaterPeople = {}
  if ('assignee_id' in a.patch) later.assignee_id = a.patch.assignee_id
  if ('reviewer_id' in a.patch) later.reviewer_id = a.patch.reviewer_id
  let task = a.issue
  // whether the parent step below gives the task a parent it did not have
  let parentChosen = false
  if (a.destination !== undefined) {
    task = await moveIssueCore(ctx, {
      me,
      issue: task,
      project_id: a.destination.id,
      now,
      // a subtask may leave its parent's top-level project only when this
      // update also gives it another parent, or none
      machine: { provenance, later, laterParent: a.parent },
    })
  }
  if (a.parent !== undefined && (a.parent ?? undefined) !== task.parent_id) {
    task = await updateIssueCore(ctx, {
      me,
      issue: task,
      patch: { parent_id: a.parent },
      now,
      machine: { provenance, appGrammar: true, later },
    })
    parentChosen = a.parent !== null
  }
  // one row write, one notify fan-out and one activity row for the fields
  // and the toggle (updateIssueCore's machine seam)
  if (Object.keys(a.patch).length > 0 || toggles) {
    task = await updateIssueCore(ctx, {
      me,
      issue: task,
      patch: a.patch,
      now,
      machine: {
        provenance,
        archive: a.archive,
        // naming the current parent asks to keep it (model/issues.ts)
        keepParent: a.parent !== undefined && a.parent !== null && a.parent === task.parent_id,
        parentChosen,
      },
    })
  }
  // removals first, so a task at LABEL_MAX can swap labels in one update
  for (const [list, on] of [
    [a.labels.remove, false],
    [a.labels.add, true],
  ] as const) {
    for (const label of list) {
      await setTaskLabel(ctx, { me, issue: task, label, on, now, provenance })
    }
  }
  if (archives) await postArchiveReason(ctx, { issue: task, author: me, reason: a.reason, now })
  return task
}

/** The project row of REST GET /v1/projects and MCP list_projects, in MCP's
 * key order (REST's answer crosses the Convex value boundary, which sorts
 * keys). `access` is the caller's flags on the project (accessFlags), so a
 * read-only credential shows `write: false` everywhere. `archived` is
 * `archived_at` as a boolean. */
export const projectJson = (
  p: Doc<'projects'>,
  access: AccessFlag,
): {
  id: string
  key: string
  num: number
  name: string
  type: ProjectType
  parent_id: string | null
  team_id: string | null
  description: string
  archived: boolean
  archived_at: string | null
  access: AccessFlag
} => ({
  id: p.id,
  key: p.key,
  num: p.num,
  name: p.name,
  type: p.type,
  parent_id: p.parent_id ?? null,
  team_id: p.team_id ?? null,
  description: p.description,
  archived: p.archived_at !== undefined,
  archived_at: p.archived_at ?? null,
  access: { read: access.read, write: access.write },
})

/** A project's Completion as REST and MCP send it, `done` of `total` tasks
 * with `percent` rounded and 0 without tasks. */
export type CompletionJson = { done: number; total: number; percent: number }

/** The completion of a project that holds no tasks, such as a new one. */
export const NO_TASKS: CompletionJson = { done: 0, total: 0, percent: 0 }

/**
 * The Completion the app's Overview shows for `project` (src/store/planner.ts
 * progressIn over scopeInfo's sub-projects), as the caller sees it. It
 * counts how many of the active tasks without subtasks are Done, in the
 * project, or for a top-level project in its sub-projects that the caller
 * can read (`view.readable`) and that are not archived. A task with an
 * active subtask in an active project is a group and does not count, even
 * when the caller cannot read the subtask, as in the app. Null for an archived
 * project, whose tasks are outside the working plan.
 *
 * Reads the active tasks of the project's family only, its top-level project
 * and that project's active sub-projects (lib/liveTasks.ts liveTasksOf),
 * because a subtask stays in its parent's top-level project. In an
 * update_project mutation the read conflicts only with writes to the
 * family's tasks.
 */
export async function projectCompletion(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  view: Pick<ListView, 'cat' | 'readable'>,
): Promise<CompletionJson | null> {
  if (project.archived_at !== undefined) return null
  const subs =
    project.type === 'meta'
      ? view.cat.projects.filter((c) => c.parent_id === project.id && c.archived_at === undefined)
      : [project]
  const scope = new Set(subs.filter((p) => view.readable(p.id)).map((p) => p.id))
  if (scope.size === 0) return NO_TASKS
  const root =
    project.parent_id === undefined ? project : (view.cat.byUuid.get(project.parent_id) ?? project)
  const family = [root, ...view.cat.projects.filter((c) => c.parent_id === root.id)]
  const active = await liveTasksOf(ctx, family)
  const isGroup = groupTest(active, liveIn(view.cat.byUuid))
  let done = 0
  let total = 0
  for (const task of active) {
    if (!scope.has(task.project_id) || isGroup(task)) continue
    total++
    if (task.status === 'done') done++
  }
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/* REST userJson (rest:229-234) == the MCP list_users row: NO email, auth id
 * or avatar. plannable_hours is null for an agent — never 0, which would read
 * as "none left this week" (0103). */
export const userJson = (
  m: Doc<'profiles'>,
): {
  id: string
  name: string
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  plannable_hours: number | null
} => ({
  id: m.id,
  name: m.name,
  org_role: m.org_role,
  kind: m.kind,
  active: m.active,
  plannable_hours: m.plannable_hours ?? null,
})

export type CommentOutCommon = {
  id: string
  author_id: string | null
  author_name: string | null
  body: string
  created_at: string
  edited_at: string | null
  edited_by_id: string | null
  edited_by_name: string | null
}
export type RestCommentJson = CommentOutCommon & { task_id: string }

/* REST commentJson (rest:256-262) / MCP commentOut (mcp:104-108) — MCP drops
 * task_id and leads with body after id; each key order is its wire's. */
export async function commentOut(
  ctx: QueryCtx,
  c: Doc<'comments'>,
  opts: { surface: 'rest' | 'mcp'; names?: ReadonlyMap<string, string> },
): Promise<CommentOutCommon | RestCommentJson> {
  const author_name = await profileName(ctx, c.author, opts.names)
  const edited_by_name = await profileName(ctx, c.edited_by, opts.names)
  if (opts.surface === 'rest') {
    return {
      id: c.id,
      task_id: c.issue_id,
      author_id: c.author ?? null,
      author_name,
      body: c.body,
      created_at: c.created_at,
      edited_at: c.edited_at ?? null,
      edited_by_id: c.edited_by ?? null,
      edited_by_name,
    }
  }
  return {
    id: c.id,
    body: c.body,
    author_id: c.author ?? null,
    author_name,
    created_at: c.created_at,
    edited_at: c.edited_at ?? null,
    edited_by_id: c.edited_by ?? null,
    edited_by_name,
  }
}

/* --------------------------------------------------------------- who am I
 * get_me (MCP) and GET /v1/me (REST) answer with the caller's own seat, the
 * settings of its organization that shape every request (the calendar, the
 * upload cap, who may create projects), whether billing pauses editing, and
 * the credential the request came with. One read and one projection serve both
 * surfaces; each surface only encodes it. Nothing here grants anything, and
 * no secret, hash or display prefix leaves it. */

/* The wire name of each credential table. */
const CREDENTIAL_KIND = {
  agent_keys: 'agent_key',
  mcp_tokens: 'personal_token',
  oauth_connections: 'oauth',
} as const satisfies Record<EventOwner['credential_table'], string>

/* A credential's name: a key's or token's own, or the connected app's. */
const credentialName = (row: Doc<EventOwner['credential_table']>): string =>
  'client_name' in row ? row.client_name : row.name

/**
 * The credential a REST or MCP delete came through, as Deleted items records
 * it (`via`): its table, uuid and current name. A name longer than NAME_MAX,
 * which only a key, token or connection named before that cap has, is cut
 * as restProvenance cuts a key's name (lib/textLimits.ts cutName), so every
 * item the credential deletes does not repeat it. `credential` names the
 * exact row that authenticated the request. One revoked or expired since then
 * still names itself, because a request already accepted may finish; one
 * deleted since then, or of another profile, answers like a caller gone
 * between lookup and dispatch.
 */
export async function credentialVia(
  ctx: QueryCtx,
  me: Caller,
  credential: EventOwner,
): Promise<Via> {
  const row = await byId(ctx, credential.credential_table, credential.credential_id)
  if (row === null || row._id !== credential.credential_row_id || row.profile_id !== me.id)
    throw callerGone()
  return {
    table: credential.credential_table,
    id: credential.credential_id,
    name: cutName(credentialName(row)),
  }
}

/**
 * Who the caller is acting as, through which credential, with what access.
 * `credential` names the exact row that authenticated the request, in the
 * shape webhook ownership uses; the HTTP action passes it to get_me alone.
 * `access` is what asMachineCaller enforces (machineAccess), so a client can
 * learn whether it may write before it tries. A credential that has stopped
 * authorizing (lib/access.ts liveCredentialRow) or belongs to another profile
 * answers like a caller gone between lookup and dispatch.
 */
export async function meCore(
  ctx: QueryCtx,
  me: Caller,
  access: CredentialAccess,
  credential: EventOwner,
) {
  const row = await liveCredentialRow(ctx, credential, Date.now())
  if (row === null || row.profile_id !== me.id) throw callerGone()
  const org = await byId(ctx, 'organizations', me.org_id)
  if (org === null) throw callerGone()
  const block = await orgWriteBlock(ctx, org.id)
  return {
    user: { ...userJson(me), email: me.kind === 'person' ? (me.email ?? null) : null },
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      date_format: org.date_format,
      week_start: org.week_start,
      week_one_rule: org.week_one_rule,
      default_plannable_hours: org.default_plannable_hours,
      max_attachment_mb: attachmentLimitMb(org),
      project_creators: org.project_creators ?? 'users',
      can_create_projects: canCreateProjects(me, org.project_creators),
    },
    billing: { read_only: block !== null, reason: block?.message ?? null },
    credential: {
      kind: CREDENTIAL_KIND[credential.credential_table],
      access: machineAccess(me, access),
      expires_at: 'token_hash' in row ? (row.expires_at ?? null) : null,
      name: credentialName(row),
    },
  }
}

/** What get_me and GET /v1/me answer. */
export type MeJson = Awaited<ReturnType<typeof meCore>>
