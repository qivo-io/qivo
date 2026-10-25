/* The /v1/* REST surface. Contracts are BYTE-PRESERVED: every
 * refusal sentence, the response field lists (explicit nulls, never omitted
 * keys) and the provenance string `via the REST API (<keyName>)` of an agent
 * key's writes. No route is an existence oracle. A project, sub-project or
 * task the caller cannot read answers exactly like an unknown ref (404 on
 * GETs, the 400 ref sentence on POST /v1/tasks). A readable project the
 * caller cannot write answers 403.
 *
 * Two credentials reach the organization routes: a `qva_` agent key, acting
 * as its agent, and a `qvt_` personal access token, acting as its person.
 * Every sentence that names the caller has an agent and a person form
 * (CALLER, which is machine/shared.ts REST_CALLER, and the 401 tables in
 * machine/auth.ts); the agent forms are the pinned bytes. A person's writes
 * narrate `via the REST API` with no token name.
 *
 * Layering: the httpAction shell owns auth (ordinary routes accept agent keys
 * and personal tokens; webhook management also accepts OAuth credentials),
 * the per-call last_used_at stamp, CORS, routing and the code→status map.
 * Routing is the ROUTES table, where each organization route is ONE registry
 * entry (machine/registry.ts) declaring its method, path, required read/write
 * `access` flag and success status, and a read route can only run queries.
 * Each endpoint is ONE internal fn —
 * resolve + rules + write + activity in one transaction — starting from
 * asMachineCaller(ctx, callerId, access), which first refuses a write from a
 * read-only credential (a Viewer agent or a read-only personal token), and
 * composing lib/core.ts + the
 * model layer with the trusted machine-narration override (model/issues.ts
 * `machine` arg): verbs created/changed/archived/restored/deleted, the
 * multi-field issueChanges diff, the provenance suffix. A PATCH carrying fields AND an
 * archived toggle folds into ONE row write, ONE notify fan-out, ONE activity
 * row plus the cascade (updateIssueCore owns the fold).
 *
 * Refusal mapping: ConvexError e.data.code → {not_found:404, forbidden:403,
 * bad_request:400, rule:400}, body {"error": message}; the CALLER_GONE /
 * CALLER_DEACTIVATED race reasons map back to the caller's own 401 sentences
 * BEFORE the code map, and a write that kept conflicting or running out of
 * time (WRITE_CONFLICT, machine/registry.ts retryConflicts) is a 503 with
 * Retry-After; anything
 * else → 500 {"error": "internal error"}, with the error itself only in the
 * deployment's log (shared.ts internalError). Every mutation the handler
 * runs, before dispatch too, retries write conflicts and time outs
 * (conflictRetrying). */

import type { HttpRouter } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalMutation, internalQuery } from '../_generated/server'
import { hasProjectLevel } from '../lib/access'
import { archiveCursorText } from '../lib/archivedTasks'
import { ORG_DELETING } from '../lib/billingAccess'
import {
  type AccessFlag,
  accessFlags,
  applyTaskUpdate,
  asMachineCaller,
  CALLER_DEACTIVATED,
  CALLER_GONE,
  type Caller,
  type Catalogue,
  commentOut,
  credentialVia,
  destinationOf,
  findIssue,
  findProjectRef,
  issueKey,
  listActiveIssuesCore,
  listArchivedIssuesCore,
  listCommentsCore,
  listProjectsCore,
  listProjectUsersCore,
  listUsersCore,
  loadCatalogue,
  type MeJson,
  meCore,
  projectCompletion,
  projectJson,
  type RestCommentJson,
  type RestIssueJson,
  type TaskAttachmentsJson,
  type TaskDetailJson,
  type TaskRefJson,
  taskListRequest,
  taskOut,
  taskRefOf,
  UUID,
  userJson,
} from '../lib/core'
import {
  type CredentialAccess,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueStatus,
  type ProfileKind,
  vCredentialAccess,
} from '../lib/enums'
import { badRequest, forbidden, notFound, type Refusal, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, serviceBusy, tooManyRequests } from '../lib/limits'
import { utcToday } from '../lib/machineDelay'
import { mcpResource } from '../lib/oauth'
import { answerAfterBody } from '../lib/requestBody'
import { type EventOwner, vEventOwner } from '../lib/taskEvents'
import { ingressShard, machineRetryAfter } from '../model/billingUsage'
import { postComment } from '../model/comments'
import { moveTasksToTrash } from '../model/deletedItems'
import { parseExpected, refuseCreateExpected, sentKeys } from '../model/expected'
import {
  assertAssignable,
  assertAssignableChange,
  assertLive,
  assertNoGroupDates,
  assertNoSubtasks,
  assertReporter,
  assertWeekPair,
  cleanTitle,
  createIssueCore,
  type IssuePatch,
  linkAccess,
  metaNeedsSub,
  pairRule,
  REPORTER_IMMUTABLE_SENTENCE,
  SUB_MUST_NAME,
  TASK_FIELDS,
  taskSentKeys,
} from '../model/issues'
import {
  assertLabelCreator,
  assertLabelManager,
  createLabelCore,
  findLabel,
  LABEL_FIELDS,
  labelChanges,
  labelJson,
  listLabelsCore,
  updateLabelCore,
} from '../model/labels'
import {
  addLinkCore,
  isTaskLinkKind,
  linkKindFrom,
  removeLinkCore,
  storedLink,
  TASK_LINK_KINDS,
  type TaskLinkKind,
} from '../model/links'
import { newUuid, PLANNABLE_HOURS_RIGHTS, setPlannableHoursCore } from '../model/orgs'
import { PLANNABLE_FIELDS } from '../model/people'
import { assertRemainingShape, cleanTaskDate } from '../model/taskValues'
import { authenticateSecret, goneWithDeletion, restAuth401, sha256hex } from './auth'
import { DISCUSSION_ROUTES } from './discussion'
import { PROJECT_ROUTES, projectDetailJson } from './projects'
import { RECORD_ROUTES } from './records'
import { conflictRetrying, type MachineEntry, type Principal, runEntry } from './registry'
import {
  REST_CALLER as CALLER,
  internalError,
  listOffset,
  needJson,
  optionalJson,
  pageLimit,
  restProvenance as provenanceOf,
  REST_NOT_UTF8,
  readBody,
  refuseUnknownFields,
  refuseUnknownParams,
  vKeyName,
  WRITE_CONFLICT,
  WRITE_CONFLICT_MESSAGE,
  WRITE_CONFLICT_RETRY_AFTER,
} from './shared'
import { TEAM_ROUTES } from './teams'

type RestProjectJson = ReturnType<typeof projectJson>
type RestProjectDetailJson = Awaited<ReturnType<typeof projectDetailJson>>
type RestUserJson = ReturnType<typeof userJson>
type RestProjectUserJson = Awaited<ReturnType<typeof listProjectUsersCore>>[number]
type RestTaskJson = RestIssueJson & TaskDetailJson & TaskAttachmentsJson
/** A page of archived tasks; `next_cursor` is null on the last one. */
type RestArchivedPage = { next_cursor: string | null; tasks: RestIssueJson[] }
type RestLabelJson = ReturnType<typeof labelJson>

/** The 403 for a readable project the caller cannot write. */
const noWrite = (me: Caller): ConvexError<Refusal> => forbidden(CALLER[me.kind].noWrite)

/* --------------------------------------------------------- shared plumbing */

/* The org project catalogue + the caller's flags on every project — ONE
 * indexed by_org scan per request. It resolves every ref in the org; nothing
 * here grants anything, and every disclosed id runs past the flags. */
type Access = {
  me: Caller
  cat: Catalogue
  flags: Map<string, AccessFlag>
  readable: (projectId: string) => boolean
  writable: (projectId: string) => boolean
}

/* Access for `callerId`, resolved to the live caller by asMachineCaller. */
async function withAccess(
  ctx: QueryCtx,
  callerId: string,
  access: CredentialAccess,
): Promise<Access> {
  return await accessOf(ctx, await asMachineCaller(ctx, callerId, access), access)
}

/* withAccess for a caller already resolved. */
async function accessOf(ctx: QueryCtx, me: Caller, access: CredentialAccess): Promise<Access> {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat, access)
  return {
    me,
    cat,
    flags,
    readable: (id) => flags.get(id)?.read === true,
    writable: (id) => flags.get(id)?.write === true,
  }
}

/* uuid → name over one org roster scan, for the list projections. */
async function orgNames(ctx: QueryCtx, orgId: string): Promise<Map<string, string>> {
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return new Map(profiles.map((p) => [p.id, p.name]))
}

/* The body fields of POST /v1/tasks. `archived`, `project_id` and
 * `parent_id` are refused with their own sentences first. */
const TASK_CREATE_FIELDS = [
  'project',
  'sub_project',
  'parent',
  'title',
  'description',
  'status',
  'priority',
  'assignee_id',
  'reviewer_id',
  'reporter_id',
  'start_week',
  'end_week',
  'due_date',
  'remaining_hours',
  'paused',
] as const

/* The body fields of PATCH /v1/tasks/{ref}. `reporter_id`, `project_id` and
 * `parent_id` are refused with their own sentences first. */
const TASK_UPDATE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assignee_id',
  'reviewer_id',
  'start_week',
  'end_week',
  'due_date',
  'remaining_hours',
  'paused',
  'archived',
  'archive_reason',
  'project',
  'sub_project',
  'parent',
  'add_labels',
  'remove_labels',
  'expected',
] as const

/* Validates + maps a request body onto issue columns (rest:267-302, sentences
 * verbatim). `forCreate` also requires title. remaining_hours gets the checks
 * that need no stored row here; the core applies the cap (cleanRemaining)
 * after the field check. The caller has refused unknown fields already. */
function issueFields(b: Record<string, unknown>, forCreate: boolean): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  if ('title' in b) f.title = cleanTitle(b.title)
  else if (forCreate) throw badRequest('title is required')
  if ('description' in b) {
    if (b.description !== null && typeof b.description !== 'string') {
      throw badRequest('description must be a string')
    }
    f.description = b.description ?? ''
  }
  if ('status' in b) {
    if (!(ISSUE_STATUSES as readonly unknown[]).includes(b.status)) {
      throw badRequest(`status must be one of ${ISSUE_STATUSES.join(', ')}`)
    }
    f.status = b.status
  }
  if ('priority' in b) {
    if (!(ISSUE_PRIORITIES as readonly unknown[]).includes(b.priority)) {
      throw badRequest(`priority must be one of ${ISSUE_PRIORITIES.join(', ')}`)
    }
    f.priority = b.priority
  }
  for (const d of ['start_week', 'end_week', 'due_date'] as const) {
    if (d in b) {
      f[d] = cleanTaskDate(b[d], d) ?? null
    }
  }
  if ('remaining_hours' in b) {
    assertRemainingShape(b.remaining_hours)
    f.remaining_hours = b.remaining_hours ?? null
  }
  if ('paused' in b) {
    if (typeof b.paused !== 'boolean') throw badRequest('paused must be a boolean')
    f.paused = b.paused
  }
  return f
}

/* The EFFECTIVE week pair — patch over current row (rest:306-311): setting
 * one when the other is already set is fine; a lone start_week on an
 * unscheduled row is the 400. */
function assertEffectiveWeekPair(f: Record<string, unknown>, current?: Doc<'issues'>): void {
  const start =
    'start_week' in f ? ((f.start_week as string | null) ?? undefined) : current?.start_week
  const end = 'end_week' in f ? ((f.end_week as string | null) ?? undefined) : current?.end_week
  assertWeekPair(start, end)
}

/* The assignee and the reviewer, validated the same way: present means set,
 * null clears. User references are lowercased before the by_uuid lookup
 * (stored uuids are lowercase; the SQL uuid type compared case-insensitively).
 * The shared model guards enforce that a selected user is eligible for work on
 * the project; only the last refusal sentence names the role. On PATCH,
 * `current` is the task. Resending its current assignee or reviewer is no
 * change and is not checked again, as in the app. */
async function applyPerson(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  b: Record<string, unknown>,
  f: Record<string, unknown>,
  field: 'assignee_id' | 'reviewer_id',
  current?: Doc<'issues'>,
): Promise<void> {
  if (!(field in b)) return
  const value = b[field]
  if (value === null) {
    f[field] = null
    return
  }
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw badRequest(`${field} must be a profile uuid or null`)
  }
  const id = value.toLowerCase()
  const role = field === 'reviewer_id' ? 'reviewer' : 'assignee'
  if (current === undefined) await assertAssignable(ctx, project, id, role)
  else await assertAssignableChange(ctx, project, current[field], id, role)
  f[field] = id
}

async function applyReporter(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  b: Record<string, unknown>,
  f: Record<string, unknown>,
): Promise<void> {
  if (!('reporter_id' in b)) return
  if (typeof b.reporter_id !== 'string' || !UUID.test(b.reporter_id)) {
    throw badRequest('reporter_id must be a profile uuid')
  }
  const id = b.reporter_id.toLowerCase()
  await assertReporter(ctx, project, id)
  f.reporter_id = id
}

/* Fields a task body may not write, each refused with where to go instead
 * rather than ignored, because each names something the response carries. */
function refuseReadOnlyFields(b: Record<string, unknown>): void {
  if ('project_id' in b) {
    throw badRequest('project_id cannot be written; move a task with project and sub_project')
  }
  if ('parent_id' in b) {
    throw badRequest('parent_id cannot be written; send parent, or null to detach')
  }
}

/* `parent` in a body: a task the caller can read, by key, number or uuid,
 * or null to detach. A task it cannot read answers like an unknown one.
 * Undefined when the body leaves the parent alone. */
async function parentFrom(
  ctx: QueryCtx,
  me: Caller,
  b: Record<string, unknown>,
): Promise<string | null | undefined> {
  if (!('parent' in b)) return undefined
  if (b.parent === null) return null
  if (typeof b.parent !== 'string')
    throw badRequest('parent must be a task key, number or uuid, or null')
  const parent = await findIssue(ctx, me, b.parent)
  if (parent === null) throw badRequest('parent task not found')
  return parent.id
}

/* add_labels / remove_labels in a body, each an array of label ids or names. */
function labelRefs(b: Record<string, unknown>, field: 'add_labels' | 'remove_labels'): string[] {
  if (!(field in b)) return []
  const refs = b[field]
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')) {
    throw badRequest(`${field} must be an array of label ids or names`)
  }
  return refs as string[]
}

/* archive_reason, posted as a comment when the same request archives the
 * task, as the app's archive dialog does. Undefined when absent. The length
 * check runs at parse time, before any write, also for a task that is
 * already archived and so posts no comment. */
function archiveReason(b: Record<string, unknown>): string | undefined {
  if (!('archive_reason' in b)) return undefined
  if (typeof b.archive_reason !== 'string') throw badRequest('archive_reason must be a string')
  if (b.archived !== true) throw badRequest('archive_reason needs archived set to true')
  return limitedText(LIMITS.archiveReason, b.archive_reason)
}

/* Presence-driven fields → the model's IssuePatch (a key's presence means
 * "set this field"; null clears). */
function patchFrom(fields: Record<string, unknown>): IssuePatch {
  const patch: IssuePatch = {}
  if ('title' in fields) patch.title = fields.title as string
  if ('description' in fields) patch.description = fields.description as string
  if ('status' in fields) patch.status = fields.status as IssueStatus
  if ('priority' in fields) patch.priority = fields.priority as IssuePriority
  if ('assignee_id' in fields) patch.assignee_id = fields.assignee_id as string | null
  if ('reviewer_id' in fields) patch.reviewer_id = fields.reviewer_id as string | null
  if ('start_week' in fields) patch.start_week = fields.start_week as string | null
  if ('end_week' in fields) patch.end_week = fields.end_week as string | null
  if ('due_date' in fields) patch.due_date = fields.due_date as string | null
  if ('remaining_hours' in fields) patch.remaining_hours = fields.remaining_hours as number | null
  if ('paused' in fields) patch.paused = fields.paused as boolean
  return patch
}

/* ------------------------------------------------------------- projects -- */

/* GET /v1/projects?archived= — readable projects on ONE side of the archived
 * axis, sorted by key, with the caller's access flags (rest:330-339). */
export const listProjects = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, archived: v.optional(v.string()) },
  handler: async (ctx, a): Promise<RestProjectJson[]> => {
    const { cat, flags, readable } = await withAccess(ctx, a.callerId, a.access)
    if (a.archived !== undefined && a.archived !== 'true' && a.archived !== 'false') {
      throw badRequest('archived must be true or false')
    }
    return listProjectsCore(cat, a.archived === 'true', readable).map((p) =>
      projectJson(p, flags.get(p.id) ?? { read: false, write: false }),
    )
  },
})

/* GET /v1/projects/{ref} — an explicit ref resolves an archived project too;
 * unknown OR unreadable answer the one 404 (NO oracle on GET, rest:341-347).
 * The list row gains the single read's fields: lead, review time, delay
 * tracking, completion, milestones and grants (machine/projects.ts
 * projectDetailJson). */
export const getProject = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a): Promise<RestProjectDetailJson> => {
    const { cat, flags, readable } = await withAccess(ctx, a.callerId, a.access)
    const p = findProjectRef(cat, a.ref)
    if (p === undefined || !readable(p.id)) throw notFound('project not found')
    return await projectDetailJson(
      ctx,
      p,
      flags.get(p.id) ?? { read: false, write: false },
      await projectCompletion(ctx, p, { cat, readable }),
    )
  },
})

/* GET /v1/projects/{ref}/users — the project-scoped identity resolver for
 * imports and user pickers. A caller may only enumerate a project it can
 * itself read. Reporter eligibility is membership in this result; assignee
 * eligibility additionally requires `assignable`. */
export const listProjectUsers = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a): Promise<RestProjectUserJson[]> => {
    const { me, cat, readable } = await withAccess(ctx, a.callerId, a.access)
    const project = findProjectRef(cat, a.ref)
    if (project === undefined || !readable(project.id)) throw notFound('project not found')
    return await listProjectUsersCore(ctx, me, project)
  },
})

/* ------------------------------------------------------------------- me -- */

/* GET /v1/me answers who this credential acts as, its organization's
 * settings, the billing pause and the credential itself (lib/core.ts meCore,
 * shared with MCP's get_me). Only this function takes the credential row. */
export const getMe = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, credential: vEventOwner },
  handler: async (ctx, a): Promise<MeJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return await meCore(ctx, me, a.access, a.credential)
  },
})

/* ---------------------------------------------------------------- users -- */

/* GET /v1/users — the org's roster, people and agents alike, ordered by name.
 * Not gated on a project grant (rest:350-360). */
export const listUsers = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, a): Promise<RestUserJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return (await listUsersCore(ctx, me)).map(userJson)
  },
})

/* GET /v1/users/{id} — exact match on the lowercased id (rest:361-364). */
export const getUser = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a): Promise<RestUserJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const rows = await listUsersCore(ctx, me)
    const one = rows.find((m) => m.id === a.ref.toLowerCase())
    if (one === undefined) throw notFound('user not found')
    return userJson(one)
  },
})

/* PATCH /v1/users/{id} sets plannable_hours, the one user field the API
 * changes, through setPlannableHoursCore (the rule of the app and of MCP's
 * update_user): an organization admin, or a leader of one of that person's
 * teams, and never an agent's hours. The core's rights refusal is a rule
 * sentence for the app's toast; REST answers it 403 like any missing right.
 * No activity row, as in the app. */
export const updateUser = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestUserJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const target = (await listUsersCore(ctx, me)).find((m) => m.id === a.ref.toLowerCase())
    if (target === undefined) throw notFound('user not found')
    const b = needJson(a.body)
    refuseUnknownFields(b, ['plannable_hours', 'expected'])
    const expected = parseExpected(PLANNABLE_FIELDS, b.expected, sentKeys(PLANNABLE_FIELDS, b))
    if (!('plannable_hours' in b)) throw badRequest('no recognized fields to update')
    // the shape first, as MCP's integer schema does; the core checks the
    // range after the rights, with the same sentence
    if (typeof b.plannable_hours !== 'number' || !Number.isInteger(b.plannable_hours)) {
      throw rule(LIMITS.plannableHours.refusal)
    }
    try {
      const fresh = await setPlannableHoursCore(ctx, {
        me,
        profile_id: target.id,
        hours: b.plannable_hours,
        expected,
      })
      return userJson(fresh)
    } catch (e) {
      if (e instanceof ConvexError && (e.data as Refusal).message === PLANNABLE_HOURS_RIGHTS) {
        throw forbidden(PLANNABLE_HOURS_RIGHTS)
      }
      throw e
    }
  },
})

/* --------------------------------------------------------------- issues -- */

/* GET /v1/tasks — filters + scope expansion (rest:368-403). Query params
 * arrive as raw strings. `limit` and `offset` follow MCP list_tasks's rules
 * (shared.ts pageLimit, pageOffset), so a value out of range is refused
 * rather than changed. Active tasks answer an array paged with `offset`.
 * Archived tasks need `project` and answer `{next_cursor, tasks}`, paged
 * with `cursor` (lib/core.ts listArchivedIssuesCore), and refuse any
 * `offset` but 0. `today` is the HTTP action's UTC day, which active rows'
 * delay is judged by. */
export const listIssues = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    today: v.string(),
    project: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    assignee: v.optional(v.string()),
    owner: v.optional(v.string()),
    search: v.optional(v.string()),
    archived: v.optional(v.string()),
    limit: v.optional(v.string()),
    offset: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<RestIssueJson[] | RestArchivedPage> => {
    const { me, cat, readable } = await withAccess(ctx, a.callerId, a.access)
    const project = a.project ? findProjectRef(cat, a.project) : undefined
    if (a.project && (project === undefined || !readable(project.id))) {
      throw notFound('project not found')
    }
    if (a.archived !== undefined && a.archived !== 'true' && a.archived !== 'false') {
      throw badRequest('archived must be true or false')
    }
    // one status, or several separated by commas
    const statuses = a.status ? a.status.split(',').map((x) => x.trim()) : []
    if (statuses.some((x) => !(ISSUE_STATUSES as readonly string[]).includes(x))) {
      throw badRequest(`status must be one of ${ISSUE_STATUSES.join(', ')}`)
    }
    if (a.priority && !(ISSUE_PRIORITIES as readonly string[]).includes(a.priority)) {
      throw badRequest(`priority must be one of ${ISSUE_PRIORITIES.join(', ')}`)
    }
    if (a.assignee && !UUID.test(a.assignee)) throw badRequest('assignee must be a profile uuid')
    if (a.owner && !UUID.test(a.owner)) throw badRequest('owner must be a profile uuid')
    const limit = pageLimit(LIMITS.listTasks, a.limit)
    const archived = a.archived === 'true'
    const offset = listOffset(a.offset, archived)
    const filters = {
      statuses: statuses as IssueStatus[],
      priority: a.priority ? (a.priority as IssuePriority) : undefined,
      assignee: a.assignee ? a.assignee.toLowerCase() : undefined,
      owner: a.owner ? a.owner.toLowerCase() : undefined,
      search: a.search ? a.search : undefined,
      stars: true, // REST's `*` wildcard, REST only
      limit,
    }
    const view = { surface: 'rest', cat, readable } as const
    /* Naming a LIVE meta asks for its active tasks as it stands, so a
     * sub-project archived out of it stays out; naming an ARCHIVED one asks
     * for it as it was put away, and everything under it comes
     * (rest:374-386). Archived tasks come one project at a time
     * (taskListScope). */
    const req = await taskListRequest(view, {
      flag: 'archived=true',
      archived,
      project,
      offset,
      // an empty cursor, like any empty filter, counts as absent
      cursor: a.cursor ? a.cursor : undefined,
    })
    if (req.archived === false) {
      return await listActiveIssuesCore(
        ctx,
        me,
        { ...filters, scope: req.scope, offset: req.offset, today: a.today },
        view,
      )
    }
    const page = await listArchivedIssuesCore(
      ctx,
      me,
      { ...filters, scope: req.scope, cursor: req.cursor },
      view,
    )
    return {
      next_cursor: page.next === null ? null : await archiveCursorText(page.next, req.project),
      tasks: page.rows,
    }
  },
})

/* GET /v1/tasks/{ref} — the ref grammar resolves archived issues too. The
 * single-task shape adds labels, subtasks, links, a group's remaining
 * hours, followers and attachments (lib/core.ts taskOut). `today` is the
 * HTTP action's UTC day, which the task's delay is judged by. */
export const getIssue = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, today: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestTaskJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    return await taskOut(ctx, issue, { surface: 'rest', me, today: a.today })
  },
})

/* POST /v1/tasks — the order-sensitive dance (rest:440-471). A project or
 * sub_project the key cannot read answers exactly like an unknown ref, so no
 * answer reveals that a hidden project exists. The body's own refusals,
 * which name no project, come first. */
export const createIssue = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, keyName: vKeyName, body: v.string() },
  handler: async (ctx, a): Promise<RestTaskJson> => {
    const { me, cat, readable, writable } = await withAccess(ctx, a.callerId, a.access)
    const b = needJson(a.body)
    if ('archived' in b)
      throw badRequest('tasks are created active, so archive with PATCH after creating')
    refuseReadOnlyFields(b)
    refuseCreateExpected(b, 'task')
    refuseUnknownFields(b, TASK_CREATE_FIELDS)
    const proj = findProjectRef(cat, typeof b.project === 'string' ? b.project : '')
    // A project the key cannot read reads like an unknown one (writable
    // implies readable), before any pair validation.
    if (proj === undefined || !readable(proj.id)) {
      throw badRequest('project must name a project by uuid, number or key')
    }
    assertLive(proj)
    // an explicit null sub_project means "not provided"
    let target = proj
    if ('sub_project' in b && b.sub_project !== null) {
      const sp = findProjectRef(cat, typeof b.sub_project === 'string' ? b.sub_project : '')
      // A sub_project the key cannot read, including a sibling under a parent
      // it sees only for navigation, reads exactly like an unknown one (as on
      // MCP).
      if (sp === undefined || !readable(sp.id)) throw badRequest(SUB_MUST_NAME)
      pairRule(proj, sp)
      target = sp
    } else if (proj.type === 'meta') {
      metaNeedsSub(
        proj,
        cat.projects.filter((c) => c.parent_id === proj.id && c.archived_at === undefined),
        { readable, writable },
      )
    }
    // a sub can be archived alone, so proj being live proves nothing
    assertLive(target)
    if (!writable(target.id)) throw noWrite(me)
    const fields = issueFields(b, true)
    assertEffectiveWeekPair(fields)
    await applyPerson(ctx, target, b, fields, 'assignee_id')
    await applyPerson(ctx, target, b, fields, 'reviewer_id')
    await applyReporter(ctx, target, b, fields)
    // a subtask: the model checks the parent chain, sight and Edit on it
    const parent = await parentFrom(ctx, me, b)
    const now = new Date().toISOString()
    /* `paused` is forwarded on create like every other field (the deployed
     * edge once validated the old blocked flag and then dropped it from the
     * INSERT; docs/rest-api.md promises the field on create). */
    const issue = await createIssueCore(ctx, {
      me,
      now,
      machine: { provenance: provenanceOf(a.keyName) },
      args: {
        id: newUuid(),
        project_id: target.id,
        title: fields.title as string,
        description: 'description' in fields ? (fields.description as string) : undefined,
        status: 'status' in fields ? (fields.status as IssueStatus) : undefined,
        priority: 'priority' in fields ? (fields.priority as IssuePriority) : undefined,
        assignee_id: 'assignee_id' in fields ? (fields.assignee_id as string | null) : undefined,
        reviewer_id: 'reviewer_id' in fields ? (fields.reviewer_id as string | null) : undefined,
        reporter_id: 'reporter_id' in fields ? (fields.reporter_id as string) : undefined,
        start_week: 'start_week' in fields ? (fields.start_week as string | null) : undefined,
        end_week: 'end_week' in fields ? (fields.end_week as string | null) : undefined,
        due_date: 'due_date' in fields ? (fields.due_date as string | null) : undefined,
        remaining_hours:
          'remaining_hours' in fields ? (fields.remaining_hours as number | null) : undefined,
        paused: 'paused' in fields ? (fields.paused as boolean) : undefined,
        parent_id: parent ?? undefined,
      },
    })
    return await taskOut(ctx, issue, {
      surface: 'rest',
      me,
      readable,
      project: target,
      today: now.slice(0, 10),
    })
  },
})

/* PATCH /v1/tasks/{ref} (rest:474-506). A PATCH carrying fields
 * AND the archived toggle folds into ONE row write + ONE fan-out + ONE
 * activity row (updateIssueCore's machine seam); `archived` matching the
 * current state is a clean no-op 200 with the full row.
 *
 * One request may also move the task (`project`, `sub_project`, create's
 * grammar, with Edit on both ends), set or clear its parent (`parent`), add
 * or remove labels and give an `archive_reason`. This handler parses and
 * checks them, a new assignee or reviewer against the destination, and
 * lib/core.ts applyTaskUpdate writes them all or nothing, in the order MCP's
 * update_task uses too. */
export const updateIssue = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a): Promise<RestTaskJson> => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) throw noWrite(me)
    const b = needJson(a.body)
    if ('reporter_id' in b) throw badRequest(REPORTER_IMMUTABLE_SENTENCE)
    refuseReadOnlyFields(b)
    refuseUnknownFields(b, TASK_UPDATE_FIELDS)
    const fields = issueFields(b, false)
    const expected = parseExpected(TASK_FIELDS, b.expected, taskSentKeys(b))
    // a group's dates come from its subtasks, so any date key on one is
    // refused, null and unchanged values included
    if ('start_week' in fields || 'end_week' in fields) await assertNoGroupDates(ctx, issue)
    assertEffectiveWeekPair(fields, issue)
    let archive: boolean | undefined
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') throw badRequest('archived must be a boolean')
      archive = b.archived
    }
    const reason = archiveReason(b)
    const project = await ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', issue.project_id))
      .unique()
    if (project === null) throw notFound('task not found')
    // a move names its destination with create's grammar; an explicit null
    // sub_project means "not provided", as on create
    let destination: Doc<'projects'> | undefined
    if ('project' in b || 'sub_project' in b) {
      const { cat, readable, writable } = await accessOf(ctx, me, a.access)
      const unknown = () => badRequest('project must name a project by uuid, number or key')
      if (typeof b.project !== 'string') throw unknown()
      const sub =
        'sub_project' in b && b.sub_project !== null
          ? typeof b.sub_project === 'string'
            ? b.sub_project
            : ''
          : undefined
      destination = destinationOf(
        cat,
        { readable, writable },
        { project: b.project, sub_project: sub },
        unknown,
      )
      if (!writable(destination.id)) throw noWrite(me)
    }
    await applyPerson(ctx, destination ?? project, b, fields, 'assignee_id', issue)
    await applyPerson(ctx, destination ?? project, b, fields, 'reviewer_id', issue)
    const parent = await parentFrom(ctx, me, b)
    const labels = await labelChanges(ctx, me.org_id, {
      add: labelRefs(b, 'add_labels'),
      remove: labelRefs(b, 'remove_labels'),
    })
    const toggles = archive !== undefined && archive !== (issue.archived_at !== undefined)
    const other =
      destination !== undefined || parent !== undefined || 'add_labels' in b || 'remove_labels' in b
    if (Object.keys(fields).length === 0 && !toggles && !other) {
      // archived matching the current state is a clean no-op, not an error
      if ('archived' in b) {
        return await taskOut(ctx, issue, { surface: 'rest', me, today: now.slice(0, 10) })
      }
      throw badRequest('no recognized fields to update')
    }
    // machine pre-check twin — fires on any non-null value; null clear passes
    if (fields.remaining_hours != null) await assertNoSubtasks(ctx, issue)
    const task = await applyTaskUpdate(ctx, {
      me,
      issue,
      destination,
      parent,
      patch: patchFrom(fields),
      archive,
      labels,
      reason,
      now,
      provenance: provenanceOf(a.keyName),
      expected,
    })
    return await taskOut(ctx, task, {
      surface: 'rest',
      me,
      today: now.slice(0, 10),
    })
  },
})

/* DELETE /v1/tasks/{ref}, which takes no body, moves the task to Deleted
 * items as the app's delete does (model/deletedItems.ts moveTasksToTrash), where a person can
 * restore it in the app. Its comments, follows, labels, links and
 * attachments go with it, its messages are deleted, and its subtasks stay,
 * detached and touched, and their followers told moments later. The item
 * records the credential (`via`), and the 'deleted' narration's detail is
 * exactly the provenance. */
export const deleteIssue = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    credential: vEventOwner,
    ref: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ deleted: boolean; id: string; key: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const via = await credentialVia(ctx, me, a.credential)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    refuseUnknownFields(optionalJson(a.body ?? ''), [])
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) throw noWrite(me)
    const now = new Date().toISOString()
    await moveTasksToTrash(ctx, {
      actor: me,
      root: issue,
      subtasks: [],
      now,
      provenance: provenanceOf(a.keyName),
      via,
    })
    return { deleted: true, id: issue.id, key: issueKey(issue.num) }
  },
})

/* ------------------------------------------------------------- comments -- */

/* GET /v1/tasks/{ref}/comments?limit=&before= answers the newest comments
 * of the discussion thread, or those before the comment `before` names,
 * oldest first (lib/core.ts listCommentsCore). */
export const listComments = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    limit: v.optional(v.string()),
    before: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<RestCommentJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    const rows = await listCommentsCore(ctx, issue.id, {
      limit: pageLimit(LIMITS.listComments, a.limit),
      before: a.before,
    })
    const names = await orgNames(ctx, me.org_id)
    return (await Promise.all(
      rows.map((c) => commentOut(ctx, c, { surface: 'rest', names })),
    )) as RestCommentJson[]
  },
})

/* POST /v1/tasks/{ref}/comments (rest:425-437), authored by the CALLER (the
 * agent or the person the credential acts as). Attribution cannot be forged,
 * the id is server-generated (§5), and there is deliberately NO activity row
 * (the comment IS its own feed entry; model/comments.ts postComment, shared
 * with the app and MCP). An issue outside the caller's reach is not found
 * BEFORE the write gate is consulted, never a 403 that would confirm it
 * exists. */
export const addComment = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestCommentJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) throw noWrite(me)
    const b = needJson(a.body)
    if ('author' in b || 'author_id' in b) throw badRequest(CALLER[me.kind].commentAuthor)
    refuseCreateExpected(b, 'comment')
    refuseUnknownFields(b, ['body'])
    if (typeof b.body !== 'string') throw badRequest('body must be a non-empty string')
    const trimmed = b.body.trim()
    if (trimmed === '') throw badRequest('comment body must not be blank')
    const now = new Date().toISOString()
    const comment = await postComment(ctx, { issue, author: me, body: trimmed, now })
    return (await commentOut(ctx, comment, { surface: 'rest' })) as RestCommentJson
  },
})

/* ---------------------------------------------------------------- links -- */

type RestLinkJson = TaskRefJson & { kind: TaskLinkKind }

const linkKindSentence = `kind must be one of ${TASK_LINK_KINDS.join(', ')}`

/* POST /v1/tasks/{ref}/links {task, kind} links the task to another, kind
 * as seen from {ref} (model/links.ts addLinkCore, the app's rule: sight of
 * both tasks and Edit on either). The same link again is a no-op; another
 * link between the two tasks is refused. Answers the link as seen from
 * {ref}. */
export const addLink = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a): Promise<RestLinkJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    const b = needJson(a.body)
    refuseUnknownFields(b, ['task', 'kind'])
    if (!isTaskLinkKind(b.kind)) throw badRequest(linkKindSentence)
    const other = typeof b.task === 'string' ? await findIssue(ctx, me, b.task) : null
    if (other === null) throw badRequest('task must name a task by key, number or uuid')
    if ((await linkAccess(ctx, me, issue, other)) !== 'write') throw noWrite(me)
    const { link } = await addLinkCore(ctx, {
      me,
      ...storedLink(issue.id, b.kind, other.id),
      now: new Date().toISOString(),
      provenance: provenanceOf(a.keyName),
    })
    return { kind: linkKindFrom(link, issue.id), ...taskRefOf(other) }
  },
})

/* DELETE /v1/tasks/{ref}/links/{kind}/{other}, which takes no body, removes
 * that link, kind as seen from {ref}. No such link answers removed: false.
 * Writes no activity row, as in the app. */
export const removeLink = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    kind: v.string(),
    other: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<RestLinkJson & { removed: boolean }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    const other = await findIssue(ctx, me, a.other)
    if (issue === null || other === null) throw notFound('task not found')
    refuseUnknownFields(optionalJson(a.body ?? ''), [])
    if (!isTaskLinkKind(a.kind)) throw badRequest(linkKindSentence)
    if ((await linkAccess(ctx, me, issue, other)) !== 'write') throw noWrite(me)
    const removed = await removeLinkCore(ctx, { me, a: issue, b: other, kind: a.kind })
    return { removed: removed > 0, kind: a.kind, ...taskRefOf(other) }
  },
})

/* --------------------------------------------------------------- labels -- */

/* GET /v1/labels — the organization's labels, ordered by name. */
export const listLabels = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, a): Promise<RestLabelJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return (await listLabelsCore(ctx, me.org_id)).map(labelJson)
  },
})

/* A label body's name and color: strings when present, `required` names
 * the ones that must be. Any other field is refused. */
function labelFields(
  b: Record<string, unknown>,
  required: boolean,
): { name?: string; color?: string } {
  if (required) refuseCreateExpected(b, 'label')
  refuseUnknownFields(b, required ? ['name', 'color'] : ['name', 'color', 'expected'])
  const out: { name?: string; color?: string } = {}
  for (const field of ['name', 'color'] as const) {
    if (!(field in b)) {
      if (required) throw badRequest(`${field} is required`)
      continue
    }
    if (typeof b[field] !== 'string') throw badRequest(`${field} must be a string`)
    out[field] = b[field] as string
  }
  return out
}

/* POST /v1/labels {name, color} adds a label to the organization, by the
 * app's rule (model/labels.ts createLabelCore): an organization admin, or
 * a person or agent with the User role and Edit on a top-level project. */
export const createLabel = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, keyName: vKeyName, body: v.string() },
  handler: async (ctx, a): Promise<RestLabelJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    await assertLabelCreator(ctx, me)
    const f = labelFields(needJson(a.body), true)
    const label = await createLabelCore(ctx, {
      me,
      id: newUuid(),
      name: f.name as string,
      color: f.color as string,
      now: new Date().toISOString(),
      provenance: provenanceOf(a.keyName),
    })
    return labelJson(label)
  },
})

/* PATCH /v1/labels/{id} {name?, color?} renames or recolors a label, for
 * organization admins only, checked before the lookup so a refusal says
 * nothing about which labels exist. {id} is a label id or name. No activity
 * row, as in the app. */
export const updateLabel = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestLabelJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    assertLabelManager(me)
    const label = await findLabel(ctx, me.org_id, a.ref)
    if (label === null) throw notFound('label not found')
    const b = needJson(a.body)
    const f = labelFields(b, false)
    const expected = parseExpected(LABEL_FIELDS, b.expected, sentKeys(LABEL_FIELDS, b))
    if (f.name === undefined && f.color === undefined) {
      throw badRequest('no recognized fields to update')
    }
    return labelJson(await updateLabelCore(ctx, { me, label, ...f, expected }))
  },
})

/* -------------------------------------------------------- the HTTP shell -- */

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const err = (message: string, status: number): Response => json({ error: message }, status)

/* The 413 for a body over BODY_MAX_BYTES (shared.ts readBody). */
const tooLarge = (): Response => err(LIMITS.requestBody.refusal, 413)

/* The 429 for a request past the rate limit, which names the seconds left
 * in the minute's window in its sentence and in Retry-After. The
 * per-profile limit answers tooManyRequests; the deployment-wide ingress
 * limit answers serviceBusy, which does not blame the caller's own rate. */
const rateLimited = (sentence: (seconds: number) => string = tooManyRequests): Response => {
  const seconds = machineRetryAfter()
  return new Response(JSON.stringify({ error: sentence(seconds) }), {
    status: 429,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
  })
}

/* The 503 for a write that kept conflicting with other writes, or kept
 * running out of time, and changed nothing (WRITE_CONFLICT), which the
 * caller can send again. `message` is the refusal's sentence. */
const writeConflict = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Retry-After': String(WRITE_CONFLICT_RETRY_AFTER),
    },
  })

/* hex-valid-but-non-UTF-8 sequences (e.g. %C0) make decodeURIComponent throw;
 * fall back to the raw segment, which then just fails to match anything (404). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/* ----------------------------------------------------------- route table --
 * Every organization route is ONE registry entry (machine/registry.ts): method,
 * path, the required read/write `access` flag, the success status and the
 * `run` that calls its internal fn. `path` lists the segments after /v1.
 * `:name` captures one decoded segment, which `run` reads with `param(name)`,
 * and every other segment must match the raw request segment exactly.
 * Declaring a route through route() types `param` from its own path, so a
 * `run` that asks for a name its path does not declare does not compile.
 * `query` lists the query parameters the route reads, the only names its
 * `run` can ask for, and the shell refuses any other parameter with 400
 * before the route runs. A route that reads a body refuses a field it does
 * not take in its internal function, after the caller's own refusals
 * (shared.ts refuseUnknownFields). Webhook routes are not here, because
 * they also accept OAuth credentials and are served before the agent key
 * and personal token auth (webhookResponse). */

/** The `:name` placeholders of a route path, as a union of names. */
type ParamName<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never

/** What a route's `run` receives once auth and routing are done. */
type RouteInput<Name extends string, Query extends string> = Principal & {
  /** the credential row that authenticated the request, for GET /v1/me and
   * the delete, which records it in Deleted items */
  credential: EventOwner
  /** the agent key's name, or null for a personal token */
  keyName: string | null
  /** One decoded `:name` segment of the request path. */
  param: (name: Name) => string
  /** One query parameter the route declares, absent when not sent. */
  query: (name: Query) => string | undefined
  body: string
}

/** A route's fields besides its registry entry. */
type RouteFields<Path extends string, Query extends string> = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: Path
  status: 200 | 201
  /** The query parameters the route takes; none when left out. */
  query?: readonly Query[]
}

/** One REST route. `run` answers the JSON body sent with `status`. */
type RestRoute = RouteFields<string, string> & MachineEntry<RouteInput<string, string>, unknown>

/** Declares a route whose `run` may only read the params its path names and
 * the query parameters it lists. */
export function route<Path extends string, const Query extends string = never>(
  declared: RouteFields<Path, Query> & MachineEntry<RouteInput<ParamName<Path>, Query>, unknown>,
): RestRoute {
  return declared
}

export const ROUTES: RestRoute[] = [
  route({
    method: 'GET',
    path: 'me',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, credential }) =>
      r.runQuery(internal.machine.rest.getMe, { callerId, access, credential }),
  }),
  route({
    method: 'GET',
    path: 'projects',
    access: 'read',
    status: 200,
    query: ['archived'],
    run: (r, { callerId, access, query }) =>
      r.runQuery(internal.machine.rest.listProjects, {
        callerId,
        access,
        archived: query('archived'),
      }),
  }),
  route({
    method: 'GET',
    path: 'projects/:ref',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.rest.getProject, { callerId, access, ref: param('ref') }),
  }),
  route({
    method: 'GET',
    path: 'projects/:ref/users',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.rest.listProjectUsers, { callerId, access, ref: param('ref') }),
  }),
  route({
    method: 'GET',
    path: 'users',
    access: 'read',
    status: 200,
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.rest.listUsers, { callerId, access }),
  }),
  route({
    method: 'GET',
    path: 'users/:ref',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.rest.getUser, { callerId, access, ref: param('ref') }),
  }),
  route({
    method: 'PATCH',
    path: 'users/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.rest.updateUser, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'tasks',
    access: 'read',
    status: 200,
    query: [
      'project',
      'status',
      'priority',
      'assignee',
      'owner',
      'search',
      'archived',
      'limit',
      'offset',
      'cursor',
    ],
    run: (r, { callerId, access, query }) =>
      r.runQuery(internal.machine.rest.listIssues, {
        callerId,
        access,
        today: utcToday(),
        project: query('project'),
        status: query('status'),
        priority: query('priority'),
        assignee: query('assignee'),
        owner: query('owner'),
        search: query('search'),
        archived: query('archived'),
        limit: query('limit'),
        offset: query('offset'),
        cursor: query('cursor'),
      }),
  }),
  route({
    method: 'POST',
    path: 'tasks',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, body }) =>
      r.runMutation(internal.machine.rest.createIssue, { callerId, access, keyName, body }),
  }),
  route({
    method: 'GET',
    path: 'tasks/:ref',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.rest.getIssue, {
        callerId,
        access,
        today: utcToday(),
        ref: param('ref'),
      }),
  }),
  route({
    method: 'PATCH',
    path: 'tasks/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.rest.updateIssue, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'tasks/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, credential, param, body }) =>
      r.runMutation(internal.machine.rest.deleteIssue, {
        callerId,
        access,
        keyName,
        credential,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'tasks/:ref/comments',
    access: 'read',
    status: 200,
    query: ['limit', 'before'],
    run: (r, { callerId, access, param, query }) =>
      r.runQuery(internal.machine.rest.listComments, {
        callerId,
        access,
        ref: param('ref'),
        limit: query('limit'),
        before: query('before'),
      }),
  }),
  route({
    method: 'POST',
    path: 'tasks/:ref/comments',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.rest.addComment, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'POST',
    path: 'tasks/:ref/links',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.rest.addLink, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'tasks/:ref/links/:kind/:other',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.rest.removeLink, {
        callerId,
        access,
        ref: param('ref'),
        kind: param('kind'),
        other: param('other'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'labels',
    access: 'read',
    status: 200,
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.rest.listLabels, { callerId, access }),
  }),
  route({
    method: 'POST',
    path: 'labels',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, body }) =>
      r.runMutation(internal.machine.rest.createLabel, { callerId, access, keyName, body }),
  }),
  route({
    method: 'PATCH',
    path: 'labels/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.rest.updateLabel, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  ...RECORD_ROUTES,
  ...DISCUSSION_ROUTES,
  ...PROJECT_ROUTES,
  ...TEAM_ROUTES,
]

/**
 * The route for a method and the path segments after /v1, with its decoded
 * `:name` params, or null when nothing matches (the unknown-route 404).
 */
export function findRoute(
  method: string,
  segments: string[],
): { route: RestRoute; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue
    const pattern = route.path.split('/')
    if (pattern.length !== segments.length) continue
    const params: Record<string, string> = {}
    const matches = pattern.every((part, i) => {
      if (!part.startsWith(':')) return part === segments[i]
      params[part.slice(1)] = safeDecode(segments[i])
      return true
    })
    if (matches) return { route, params }
  }
  return null
}

const STATUS_OF: Partial<Record<string, number>> = {
  not_found: 404,
  forbidden: 403,
  bad_request: 400,
  rule: 400, // readable beats a 500; machine pre-checks fire first in practice
  // a field changed since the caller read it (model/expected.ts); the
  // retryable write_conflict is answered 503 before this map
  conflict: 409,
}

/* The REST response for an error a route threw. A caller gone or
 * deactivated since auth gets its own 401 sentence, a write that kept
 * conflicting gets the retryable 503, a refusal whose code STATUS_OF maps
 * gets that status and its message, and anything else is a 500 with
 * INTERNAL_ERROR, because its own text can hold a stack trace. */
function refusalResponse(e: unknown, kind: ProfileKind): Response {
  if (e instanceof ConvexError) {
    const data = e.data as Partial<Refusal>
    // the auth-to-dispatch race: the profile flipped between lookup and
    // dispatch, so answer the caller's own 401 sentence BEFORE the code map
    if (data.reason === CALLER_GONE) return err(CALLER[kind].gone, 401)
    if (data.reason === CALLER_DEACTIVATED) return err(CALLER[kind].deactivated, 401)
    if (data.reason === WRITE_CONFLICT) return writeConflict(data.message ?? WRITE_CONFLICT_MESSAGE)
    const status = data.code !== undefined ? STATUS_OF[data.code] : undefined
    if (status !== undefined && data.message !== undefined) return err(data.message, status)
  }
  return err(internalError(e), 500)
}

/* The body fields of POST /v1/webhooks, MCP's events/subscribe params. */
const WEBHOOK_SUBSCRIBE_FIELDS = ['name', 'arguments', 'delivery', 'cursor', 'ttlMs'] as const

/** Webhook lifecycle and inspection, the only REST routes that also accept
 *  OAuth credentials. */
async function webhookResponse(
  ctx: ActionCtx,
  req: Request,
  seg: string[],
  secret: string,
): Promise<Response> {
  const runMutation = conflictRetrying(ctx)
  let owner: EventOwner
  if (secret.startsWith('qvo_')) {
    const tokenHash = await sha256hex(secret.slice(4))
    const resource = mcpResource()
    const credential = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
      tokenHash,
      resource,
    })
    if (
      !credential ||
      !(await runMutation(internal.oauthConnections.touch, { id: credential.connectionId }))
    )
      // a grant its organization's deletion stopped, also between the lookup
      // and the stamp, says so
      return (await ctx.runQuery(internal.oauthConnections.refusedForDeletion, {
        tokenHash,
        resource,
      }))
        ? err(ORG_DELETING, 403)
        : err('OAuth connection is invalid, expired or disconnected', 401)
    if (
      !credential.scopes.includes('qivo:read') ||
      (seg[2] === 'organization' &&
        req.method === 'DELETE' &&
        !credential.scopes.includes('qivo:write'))
    )
      return err('OAuth connection does not have the required scope', 403)
    if (
      !(await runMutation(internal.billingMetering.oauthCall, {
        connection_id: credential.connectionId,
      }))
    )
      return rateLimited()
    owner = {
      profile_id: credential.profileId,
      credential_table: 'oauth_connections',
      credential_id: credential.connectionId,
      credential_row_id: credential.connectionRowId,
    }
  } else {
    const authenticated = await authenticateSecret(ctx, secret)
    if (authenticated.ok === false)
      return authenticated.why === 'org_deleting'
        ? err(ORG_DELETING, 403)
        : err('Webhook credential is invalid or inactive', 401)
    const credential = authenticated.cred
    const table = credential.isAgent ? 'agent_keys' : 'mcp_tokens'
    const allowed = await runMutation(internal.machine.auth.touchCredential, {
      table,
      tokenId: credential.tokenId,
      rowId: credential.rowId,
      profileId: credential.profileId,
      now: new Date().toISOString(),
    })
    if (allowed === null)
      return (await goneWithDeletion(ctx, secret))
        ? err(ORG_DELETING, 403)
        : err('Webhook credential is no longer valid', 401)
    if (!allowed) return rateLimited()
    owner = {
      profile_id: credential.profileId,
      credential_table: table,
      credential_id: credential.tokenId,
      credential_row_id: credential.rowId,
    }
  }

  const route =
    seg.length === 3 && seg[2] === 'organization' && req.method === 'GET'
      ? 'list organization'
      : seg.length === 4 && seg[2] === 'organization' && req.method === 'DELETE'
        ? 'remove organization'
        : seg.length === 2 && req.method === 'GET'
          ? 'list'
          : seg.length === 2 && req.method === 'POST'
            ? 'subscribe'
            : seg.length === 3 && req.method === 'DELETE'
              ? 'remove'
              : null
  if (route === null) return err('unknown webhook route', 404)
  // no webhook route takes a query parameter, and only POST takes a body
  refuseUnknownParams(new URL(req.url).searchParams.keys(), [])
  if (req.method === 'DELETE') {
    const read = await readBody(req)
    if (read === null) return tooLarge()
    if (!read.utf8) return err(REST_NOT_UTF8, 400)
    refuseUnknownFields(optionalJson(read.text), [])
  }
  if (route === 'list organization')
    return json(await ctx.runQuery(internal.webhooks.listOrganization, { owner }), 200)
  if (route === 'remove organization') {
    await runMutation(internal.webhooks.removeOrganization, { owner, id: safeDecode(seg[3]) })
    return new Response(null, { status: 204, headers: CORS })
  }
  if (route === 'list') return json(await ctx.runQuery(internal.webhooks.list, { owner }), 200)
  if (route === 'remove') {
    await runMutation(internal.webhooks.remove, { owner, id: safeDecode(seg[2]) })
    return new Response(null, { status: 204, headers: CORS })
  }
  const read = await readBody(req)
  if (read === null) return tooLarge()
  if (!read.utf8) return err(REST_NOT_UTF8, 400)
  // the body rules of every other REST route, so a bad body answers with
  // their sentences rather than the JSON parser's. manage reads the text as
  // sent: parsing it again keeps a number too large for a double as
  // Infinity, which manage refuses, where writing the parsed body back out
  // would turn it into null ("not set")
  refuseUnknownFields(needJson(read.text), WEBHOOK_SUBSCRIBE_FIELDS)
  const reply = await ctx.runAction(internal.webhookActions.manage, {
    owner,
    method: 'events/subscribe',
    params_json: read.text,
  })
  if ('error' in reply) {
    // a quota stays full until a subscription is deleted, so it is a 409
    // that waiting cannot clear, not a 429
    const status =
      reply.error.code === -32603
        ? 500
        : reply.error.code === -32013
          ? 409
          : reply.error.code === -32012
            ? 403
            : reply.error.code === -32011
              ? 404
              : 400
    return err(reply.error.message, status)
  }
  return json(reply.result, 201)
}

const restHandler = answerAfterBody(async (ctx, req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // who the credential acts as, once it is known; the race sentences use it
  let kind: ProfileKind = 'agent'
  const runMutation = conflictRetrying(ctx)
  try {
    if (!(await runMutation(internal.billingMetering.ingress, { shard: ingressShard() })))
      return rateLimited(serviceBusy)
    // ---- authenticate the agent key (qva_) or personal token (qvt_) --------
    const auth = req.headers.get('Authorization') ?? ''
    const secret = auth.startsWith('Bearer ')
      ? auth.slice(7).trim()
      : (req.headers.get('X-Api-Key') ?? '').trim()
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') // /v1/tasks/ === /v1/tasks
    const seg = path.split('/').filter(Boolean)
    if (seg[0] === 'v1' && seg[1] === 'webhooks')
      return await webhookResponse(ctx, req, seg, secret)
    const res = await authenticateSecret(ctx, secret)
    // `=== false` (not `!res.ok`): the root tsconfig typechecks this file via
    // _generated/api.d.ts under strict:false, where truthiness narrowing of
    // the discriminant does not apply
    if (res.ok === false)
      return res.why === 'org_deleting' ? err(ORG_DELETING, 403) : err(restAuth401(res), 401)
    kind = res.cred.isAgent ? 'agent' : 'person'
    const table = res.cred.isAgent ? 'agent_keys' : 'mcp_tokens'
    // per-call last_used_at stamp — before any routing/work, even requests
    // that then 404 or 400 (the published contract; no throttle)
    const allowed = await runMutation(internal.machine.auth.touchCredential, {
      table,
      tokenId: res.cred.tokenId,
      rowId: res.cred.rowId,
      profileId: res.cred.profileId,
      now: new Date().toISOString(),
    })
    if (allowed === null)
      return (await goneWithDeletion(ctx, secret))
        ? err(ORG_DELETING, 403)
        : err(CALLER[kind].gone, 401)
    if (!allowed) return rateLimited()
    const callerId = res.cred.profileId
    const access = res.cred.access
    // null for a personal token, whose writes name no token
    const keyName = res.cred.isAgent ? res.cred.keyName : null

    if (seg[0] !== 'v1') return err('unknown route (expected /v1/…)', 404)
    // every method but GET may carry a body; DELETE's is optional. One over
    // BODY_MAX_BYTES answers 413 here, after the call was counted, and one
    // whose bytes are not UTF-8 answers 400
    const read = req.method === 'GET' ? { text: '', utf8: true } : await readBody(req)
    if (read === null) return tooLarge()
    if (!read.utf8) return err(REST_NOT_UTF8, 400)
    // other methods on a known path (PATCH …/comments, PUT on a task) fall
    // to the unknown-route 404, as deployed
    const found = findRoute(req.method, seg.slice(1))
    if (found === null) return err('unknown route', 404)
    refuseUnknownParams(url.searchParams.keys(), found.route.query ?? [])
    const result = await runEntry(ctx, found.route, {
      callerId,
      access,
      credential: {
        profile_id: callerId,
        credential_table: table,
        credential_id: res.cred.tokenId,
        credential_row_id: res.cred.rowId,
      },
      keyName,
      param: (name) => found.params[name],
      query: (name) => url.searchParams.get(name) ?? undefined,
      body: read.text,
    })
    return json(result, found.route.status)
  } catch (e) {
    return refusalResponse(e, kind)
  }
})

/* Registration — http.ts calls this ONCE at its bolt-on seam and is never
 * edited from here. Per-method routes: httpRouter has no wildcard method, and
 * pathPrefix '/v1/' does not match bare /v1. PUT serves the task following,
 * project access and team member routes and answers the deployed
 * auth-then-404 everywhere else; HEAD cannot be registered (accepted edge).
 * Requests outside /v1/* get Convex's default 404, not the in-handler
 * sentence (an accepted delta, because a root catch-all would collide with
 * the auth + file-gateway prefixes). */
export function registerRestRoutes(http: HttpRouter): void {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'] as const) {
    http.route({ path: '/v1', method, handler: restHandler })
    http.route({ pathPrefix: '/v1/', method, handler: restHandler })
  }
}
