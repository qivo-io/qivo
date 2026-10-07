/* The /v1/* REST surface. Contracts are BYTE-PRESERVED: every
 * refusal sentence, the response field lists (explicit nulls, never omitted
 * keys), the provenance string `via the REST API (<keyName>)`, and the
 * 403-vs-404 oracle asymmetry — the ONE deliberate existence oracle is POST
 * /v1/tasks' top-level `project` ref (a named project the key can't write
 * answers 403, admitting it exists); every sub_project ref and all GETs are
 * strict 404/400-no-oracle.
 *
 * Layering: the httpAction shell owns auth (ordinary routes accept agent keys;
 * webhook management also accepts personal and OAuth credentials), the per-call last_used_at stamp,
 * CORS, routing and the code→status map. Each endpoint is ONE internal fn —
 * resolve + rules + write + activity in one transaction — starting from
 * asMachineCaller(ctx, callerId) and composing lib/core.ts + the model layer
 * with the trusted machine-narration override (model/issues.ts `machine` arg):
 * verbs created/changed/archived/restored/deleted, the multi-field
 * issueChanges diff, the provenance suffix. A PATCH carrying fields AND an
 * archived toggle folds into ONE row write, ONE notify fan-out, ONE activity
 * row plus the cascade (updateIssueCore owns the fold).
 *
 * Refusal mapping: ConvexError e.data.code → {not_found:404, forbidden:403,
 * bad_request:400, rule:400}, body {"error": message}; the CALLER_GONE /
 * CALLER_DEACTIVATED race reasons map back to their 401 sentences BEFORE the
 * code map; anything else → 500 {"error": String(e)}. */

import type { HttpRouter } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { httpAction, internalMutation, internalQuery } from '../_generated/server'
import { hasProjectLevel, profileCanBeAssigned, profileCanSeeProject } from '../lib/access'
import {
  type AccessFlag,
  accessFlags,
  asMachineCaller,
  CALLER_DEACTIVATED,
  CALLER_GONE,
  type Caller,
  type Catalogue,
  commentOut,
  findIssue,
  findProjectRef,
  issueKey,
  issueOut,
  listCommentsCore,
  listIssuesCore,
  listUsersCore,
  loadCatalogue,
  type RestCommentJson,
  type RestIssueJson,
  restProjectJson,
  UUID,
  userJson,
} from '../lib/core'
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueStatus,
} from '../lib/enums'
import { badRequest, forbidden, notFound, type Refusal } from '../lib/functions'
import { mcpResource } from '../lib/oauth'
import type { EventOwner } from '../lib/taskEvents'
import { logActivity } from '../model/activity'
import { deleteIssueDeep } from '../model/cascade'
import {
  assertAssignable,
  assertLive,
  assertNoSubtasks,
  assertReporter,
  assertWeekPair,
  cleanTitle,
  createIssueCore,
  type IssuePatch,
  type MachineUpdate,
  metaNeedsSub,
  pairRule,
  REPORTER_IMMUTABLE_SENTENCE,
  SUB_MUST_NAME,
  updateIssueCore,
} from '../model/issues'
import { notifyCommentInsert } from '../model/messages'
import { newUuid } from '../model/orgs'
import { cleanRemaining, cleanTaskDate } from '../model/taskValues'
import { authenticateSecret, REST_AUTH_401, sha256hex } from './auth'

type RestProjectJson = ReturnType<typeof restProjectJson>
type RestUserJson = ReturnType<typeof userJson>
type RestProjectUserJson = RestUserJson & { assignable: boolean }

const provenanceOf = (keyName: string): string => `via the REST API (${keyName})`

/* --------------------------------------------------------- shared plumbing */

/* The org project catalogue + the caller's flags on every project — ONE
 * indexed by_org scan per request (rest-api/index.ts:162-189). Org-wide on
 * purpose: this surface's one oracle has to be able to resolve a ref
 * visibility would hide. Nothing here grants anything — every disclosed id
 * runs past the flags. */
type Access = {
  me: Caller
  cat: Catalogue
  flags: Map<string, AccessFlag>
  readable: (projectId: string) => boolean
  writable: (projectId: string) => boolean
}

async function withAccess(ctx: QueryCtx, callerId: string): Promise<Access> {
  const me = await asMachineCaller(ctx, callerId)
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat.projects)
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

/* Body tolerance (rest:196-198, 323-326): no Content-Type check, invalid JSON
 * → null → this 400; arrays pass typeof 'object' and fail field-wise. */
function needJson(raw: string): Record<string, unknown> {
  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  if (body === null || typeof body !== 'object') throw badRequest('request body must be JSON')
  return body as Record<string, unknown>
}

/* Validates + maps a request body onto issue columns (rest:267-302, sentences
 * verbatim). `forCreate` also requires title. Unknown fields are ignored. */
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
    f.remaining_hours = cleanRemaining(b.remaining_hours) ?? null
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
 * the project; only the last refusal sentence names the role. */
async function applyPerson(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  b: Record<string, unknown>,
  f: Record<string, unknown>,
  field: 'assignee_id' | 'reviewer_id',
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
  await assertAssignable(ctx, project, id, field === 'reviewer_id' ? 'reviewer' : 'assignee')
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
  args: { callerId: v.string(), archived: v.optional(v.string()) },
  handler: async (ctx, a): Promise<RestProjectJson[]> => {
    const { cat, flags, readable } = await withAccess(ctx, a.callerId)
    if (a.archived !== undefined && a.archived !== 'true' && a.archived !== 'false') {
      throw badRequest('archived must be true or false')
    }
    return cat.projects
      .filter((p) => readable(p.id) && (p.archived_at !== undefined) === (a.archived === 'true'))
      .sort((x, y) => x.key.localeCompare(y.key))
      .map((p) => restProjectJson(p, flags.get(p.id) ?? { read: false, write: false }))
  },
})

/* GET /v1/projects/{ref} — an explicit ref resolves an archived project too;
 * unknown OR unreadable answer the one 404 (NO oracle on GET, rest:341-347). */
export const getProject = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestProjectJson> => {
    const { cat, flags, readable } = await withAccess(ctx, a.callerId)
    const p = findProjectRef(cat, a.ref)
    if (p === undefined || !readable(p.id)) throw notFound('project not found')
    return restProjectJson(p, flags.get(p.id) ?? { read: false, write: false })
  },
})

/* GET /v1/projects/{ref}/users — the project-scoped identity resolver for
 * imports and user pickers. A caller may only enumerate a project it can
 * itself read. Reporter eligibility is membership in this result; assignee
 * eligibility additionally requires `assignable`. */
export const listProjectUsers = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestProjectUserJson[]> => {
    const { me, cat, readable } = await withAccess(ctx, a.callerId)
    const project = findProjectRef(cat, a.ref)
    if (project === undefined || !readable(project.id)) throw notFound('project not found')
    const out: RestProjectUserJson[] = []
    for (const profile of await listUsersCore(ctx, me)) {
      if (!(await profileCanSeeProject(ctx, profile, project))) continue
      out.push({
        ...userJson(profile),
        assignable: await profileCanBeAssigned(ctx, profile, project),
      })
    }
    return out
  },
})

/* ---------------------------------------------------------------- users -- */

/* GET /v1/users — the org's roster, people and agents alike, ordered by name.
 * Not gated on a project grant (rest:350-360). */
export const listUsers = internalQuery({
  args: { callerId: v.string() },
  handler: async (ctx, a): Promise<RestUserJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId)
    return (await listUsersCore(ctx, me)).map(userJson)
  },
})

/* GET /v1/users/{id} — exact match on the lowercased id (rest:361-364). */
export const getUser = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestUserJson> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const rows = await listUsersCore(ctx, me)
    const one = rows.find((m) => m.id === a.ref.toLowerCase())
    if (one === undefined) throw notFound('user not found')
    return userJson(one)
  },
})

/* --------------------------------------------------------------- issues -- */

/* GET /v1/tasks — filters + scope expansion (rest:368-403). Query params
 * arrive as raw strings so the parsing quirks stay byte-faithful: limit 0/NaN
 * → 100, limit -5 → 1, offset NaN → 0, `archived=maybe` → 400. */
export const listIssues = internalQuery({
  args: {
    callerId: v.string(),
    project: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    assignee: v.optional(v.string()),
    search: v.optional(v.string()),
    archived: v.optional(v.string()),
    limit: v.optional(v.string()),
    offset: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<RestIssueJson[]> => {
    const { me, cat, readable } = await withAccess(ctx, a.callerId)
    /* Naming a LIVE meta asks for the project as it stands, so a sub-project
     * archived out of it stays out; naming an ARCHIVED one asks for it as it
     * was put away, and everything under it comes (rest:374-386). */
    let scope: string[] | null = null
    if (a.project) {
      const p = findProjectRef(cat, a.project)
      if (p === undefined || !readable(p.id)) throw notFound('project not found')
      scope =
        p.type === 'meta'
          ? [
              p.id,
              ...cat.projects
                .filter(
                  (c) =>
                    c.parent_id === p.id &&
                    readable(c.id) &&
                    (p.archived_at !== undefined || c.archived_at === undefined),
                )
                .map((c) => c.id),
            ]
          : [p.id]
    }
    if (a.archived !== undefined && a.archived !== 'true' && a.archived !== 'false') {
      throw badRequest('archived must be true or false')
    }
    if (a.status && !(ISSUE_STATUSES as readonly string[]).includes(a.status)) {
      throw badRequest(`status must be one of ${ISSUE_STATUSES.join(', ')}`)
    }
    if (a.priority && !(ISSUE_PRIORITIES as readonly string[]).includes(a.priority)) {
      throw badRequest(`priority must be one of ${ISSUE_PRIORITIES.join(', ')}`)
    }
    if (a.assignee && !UUID.test(a.assignee)) throw badRequest('assignee must be a profile uuid')
    const limit = Math.min(Math.max(Number(a.limit ?? 100) || 100, 1), 200)
    const offset = Math.max(Number(a.offset ?? 0) || 0, 0)
    const rows = await listIssuesCore(
      ctx,
      me,
      {
        scope,
        archived: a.archived === 'true',
        status: a.status ? (a.status as IssueStatus) : undefined,
        priority: a.priority ? (a.priority as IssuePriority) : undefined,
        assignee: a.assignee ? a.assignee.toLowerCase() : undefined,
        search: a.search ? a.search : undefined,
        stars: true, // REST's `*` wildcard — REST-only
        limit,
        offset,
        order: 'created',
      },
      cat,
      readable,
    )
    const names = await orgNames(ctx, me.org_id)
    return await Promise.all(
      rows.map((i) =>
        issueOut(ctx, i, { surface: 'rest', project: cat.byUuid.get(i.project_id), names }),
      ),
    )
  },
})

/* GET /v1/tasks/{ref} — the ref grammar resolves archived issues too. */
export const getIssue = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestIssueJson> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    return await issueOut(ctx, issue, { surface: 'rest' })
  },
})

/* POST /v1/tasks — the order-sensitive dance (rest:440-471).
 * Step 3 is the surface's ONE deliberate existence oracle: a named top-level
 * project the key can't reach answers 403 before any pair validation. */
export const createIssue = internalMutation({
  args: { callerId: v.string(), keyName: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestIssueJson> => {
    const { me, cat, readable, writable } = await withAccess(ctx, a.callerId)
    const b = needJson(a.body)
    const proj = findProjectRef(cat, typeof b.project === 'string' ? b.project : '')
    if (proj === undefined) throw badRequest('project must name a project by uuid, number or key')
    // authorize BEFORE validating the pair: an ungranted key gets the same
    // 403 it always got, not a hierarchy oracle
    if (!readable(proj.id) && !writable(proj.id)) {
      throw forbidden('this agent has no write access to that project')
    }
    if ('archived' in b)
      throw badRequest('tasks are created active — archive with PATCH after creating')
    assertLive(proj)
    // an explicit null sub_project means "not provided"
    let target = proj
    if ('sub_project' in b && b.sub_project !== null) {
      const sp = findProjectRef(cat, typeof b.sub_project === 'string' ? b.sub_project : '')
      // a sub_project outside the key's grants (and not proj's own child)
      // stays indistinguishable from an unknown one — no oracle here
      const known =
        sp !== undefined &&
        (readable(sp.id) || writable(sp.id) || sp.id === proj.id || sp.parent_id === proj.id)
      if (!known || sp === undefined) throw badRequest(SUB_MUST_NAME)
      pairRule(proj, sp)
      target = sp
    } else if (proj.type === 'meta') {
      metaNeedsSub(
        proj,
        cat.projects.filter((c) => c.parent_id === proj.id && c.archived_at === undefined),
        writable,
      )
    }
    // a sub can be archived alone, so proj being live proves nothing
    assertLive(target)
    if (!writable(target.id)) throw forbidden('this agent has no write access to that project')
    const fields = issueFields(b, true)
    assertEffectiveWeekPair(fields)
    await applyPerson(ctx, target, b, fields, 'assignee_id')
    await applyPerson(ctx, target, b, fields, 'reviewer_id')
    await applyReporter(ctx, target, b, fields)
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
      },
    })
    return await issueOut(ctx, issue, { surface: 'rest', project: target })
  },
})

/* PATCH /v1/tasks/{ref} (rest:474-506). A PATCH carrying fields
 * AND the archived toggle folds into ONE row write + ONE fan-out + ONE
 * activity row (updateIssueCore's machine seam); `archived` matching the
 * current state is a clean no-op 200 with the full row. */
export const updateIssue = internalMutation({
  args: { callerId: v.string(), keyName: v.string(), ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestIssueJson> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) {
      throw forbidden('this agent has no write access to that project')
    }
    const b = needJson(a.body)
    if ('reporter_id' in b) throw badRequest(REPORTER_IMMUTABLE_SENTENCE)
    // a move attempt with other fields alongside is rejected whole, never a
    // silent drop
    if ('project' in b || 'project_id' in b || 'sub_project' in b) {
      throw badRequest('moving a task between projects is not supported over the API')
    }
    const fields = issueFields(b, false)
    assertEffectiveWeekPair(fields, issue)
    let archive: boolean | undefined
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') throw badRequest('archived must be a boolean')
      archive = b.archived
    }
    const project = await ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', issue.project_id))
      .unique()
    if (project === null) throw notFound('task not found')
    await applyPerson(ctx, project, b, fields, 'assignee_id')
    await applyPerson(ctx, project, b, fields, 'reviewer_id')
    const toggles = archive !== undefined && archive !== (issue.archived_at !== undefined)
    if (Object.keys(fields).length === 0 && !toggles) {
      // archived matching the current state is a clean no-op, not an error
      if ('archived' in b) return await issueOut(ctx, issue, { surface: 'rest' })
      throw badRequest('no recognized fields to update')
    }
    // machine pre-check twin — fires on any non-null value; null clear passes
    if (fields.remaining_hours != null) await assertNoSubtasks(ctx, issue.id)
    const now = new Date().toISOString()
    const machine: MachineUpdate = { provenance: provenanceOf(a.keyName) }
    if (toggles) machine.archive = archive
    const after = await updateIssueCore(ctx, { me, issue, patch: patchFrom(fields), now, machine })
    return await issueOut(ctx, after, { surface: 'rest' })
  },
})

/* DELETE /v1/tasks/{ref} (rest:479-484) — deleteIssueDeep (detached children
 * are touched AND notified; attachment bytes die in the same transaction) +
 * the 'deleted' narration whose detail is exactly the provenance. */
export const deleteIssue = internalMutation({
  args: { callerId: v.string(), keyName: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<{ deleted: boolean; id: string; key: string }> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) {
      throw forbidden('this agent has no write access to that project')
    }
    const now = new Date().toISOString()
    await deleteIssueDeep(ctx, { issue, actor: me, now })
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: me.id,
      verb: 'deleted',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: provenanceOf(a.keyName),
      project_id: issue.project_id,
      ts: now,
    })
    return { deleted: true, id: issue.id, key: issueKey(issue.num) }
  },
})

/* ------------------------------------------------------------- comments -- */

/* GET /v1/tasks/{ref}/comments — the discussion thread, oldest first. */
export const listComments = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, a): Promise<RestCommentJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    const rows = await listCommentsCore(ctx, issue.id)
    const names = await orgNames(ctx, me.org_id)
    return (await Promise.all(
      rows.map((c) => commentOut(ctx, c, { surface: 'rest', names })),
    )) as RestCommentJson[]
  },
})

/* POST /v1/tasks/{ref}/comments (rest:425-437) — authored by the AGENT;
 * attribution cannot be forged; the id is server-generated (§5); deliberately
 * NO activity row (the comment IS its own feed entry). An issue outside this
 * agent's reach is not found BEFORE the write gate is consulted — never a
 * 403 that would confirm it exists. */
export const addComment = internalMutation({
  args: { callerId: v.string(), ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestCommentJson> => {
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, me, issue.project_id, 'user'))) {
      throw forbidden('this agent has no write access to that project')
    }
    const b = needJson(a.body)
    if ('author' in b || 'author_id' in b) {
      throw badRequest(
        'comments cannot be attributed over the API — a comment is always authored by the agent posting it',
      )
    }
    if (typeof b.body !== 'string') throw badRequest('body must be a non-empty string')
    const trimmed = b.body.trim()
    if (trimmed === '') throw badRequest('comment body must not be blank')
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('comments', {
      id: newUuid(),
      issue_id: issue.id,
      author: me.id,
      body: trimmed,
      created_at: now,
    })
    const comment = (await ctx.db.get(docId)) as Doc<'comments'>
    await notifyCommentInsert(ctx, { comment, issue, actor: me, now })
    return (await commentOut(ctx, comment, { surface: 'rest' })) as RestCommentJson
  },
})

/* -------------------------------------------------------- the HTTP shell -- */

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const err = (message: string, status: number): Response => json({ error: message }, status)

const rateLimited = (): Response =>
  new Response(JSON.stringify({ error: 'Too many requests. Try again in 60 seconds.' }), {
    status: 429,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' },
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

const STATUS_OF: Partial<Record<string, number>> = {
  not_found: 404,
  forbidden: 403,
  bad_request: 400,
  rule: 400, // readable beats a 500; machine pre-checks fire first in practice
}

function refusalResponse(e: unknown): Response {
  if (e instanceof ConvexError) {
    const data = e.data as Partial<Refusal>
    // the auth-to-dispatch race: the profile flipped between lookup and
    // dispatch — answer the surface's own 401 sentence, BEFORE the code map
    if (data.reason === CALLER_GONE) return err('unknown agent key', 401)
    if (data.reason === CALLER_DEACTIVATED) return err('this agent has been deactivated', 401)
    const status = data.code !== undefined ? STATUS_OF[data.code] : undefined
    if (status !== undefined && data.message !== undefined) return err(data.message, status)
  }
  return err(String(e), 500)
}

/** Broader credential support is confined to webhook lifecycle and inspection. */
async function webhookResponse(
  ctx: ActionCtx,
  req: Request,
  seg: string[],
  secret: string,
): Promise<Response> {
  let owner: EventOwner
  if (secret.startsWith('qvo_')) {
    const credential = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
      tokenHash: await sha256hex(secret.slice(4)),
      resource: mcpResource(),
    })
    if (
      !credential ||
      !(await ctx.runMutation(internal.oauthConnections.touch, { id: credential.connectionId }))
    )
      return err('OAuth connection is invalid, expired or disconnected', 401)
    if (
      !credential.scopes.includes('qivo:read') ||
      (seg[2] === 'organization' &&
        req.method === 'DELETE' &&
        !credential.scopes.includes('qivo:write'))
    )
      return err('OAuth connection does not have the required scope', 403)
    if (
      !(await ctx.runMutation(internal.billingMetering.oauthCall, {
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
    const authenticated = await authenticateSecret(ctx, secret, { person: true })
    if (authenticated.ok === false) return err('Webhook credential is invalid or inactive', 401)
    const credential = authenticated.cred
    const table = credential.isAgent ? 'agent_keys' : 'mcp_tokens'
    const allowed = await ctx.runMutation(internal.machine.auth.touchCredential, {
      table,
      tokenId: credential.tokenId,
      rowId: credential.rowId,
      profileId: credential.profileId,
      now: new Date().toISOString(),
    })
    if (allowed === null) return err('Webhook credential is no longer valid', 401)
    if (!allowed) return rateLimited()
    owner = {
      profile_id: credential.profileId,
      credential_table: table,
      credential_id: credential.tokenId,
      credential_row_id: credential.rowId,
    }
  }

  if (seg.length === 3 && seg[2] === 'organization' && req.method === 'GET')
    return json(await ctx.runQuery(internal.webhooks.listOrganization, { owner }), 200)
  if (seg.length === 4 && seg[2] === 'organization' && req.method === 'DELETE') {
    await ctx.runMutation(internal.webhooks.removeOrganization, { owner, id: safeDecode(seg[3]) })
    return new Response(null, { status: 204, headers: CORS })
  }
  if (seg.length === 2 && req.method === 'GET')
    return json(await ctx.runQuery(internal.webhooks.list, { owner }), 200)
  if (seg.length === 2 && req.method === 'POST') {
    const reply = await ctx.runAction(internal.webhookActions.manage, {
      owner,
      method: 'events/subscribe',
      params_json: await req.text(),
    })
    if ('error' in reply) {
      const status =
        reply.error.code === -32603
          ? 500
          : reply.error.code === -32013
            ? 429
            : reply.error.code === -32012
              ? 403
              : reply.error.code === -32011
                ? 404
                : 400
      return err(reply.error.message, status)
    }
    return json(reply.result, 201)
  }
  if (seg.length === 3 && req.method === 'DELETE') {
    await ctx.runMutation(internal.webhooks.remove, { owner, id: safeDecode(seg[2]) })
    return new Response(null, { status: 204, headers: CORS })
  }
  return err('unknown webhook route', 404)
}

const restHandler = httpAction(async (ctx, req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!(await ctx.runMutation(internal.billingMetering.ingress, {}))) return rateLimited()
    // ---- authenticate the agent key (qva_ only — a qvt_ here is `missing`) --
    const auth = req.headers.get('Authorization') ?? ''
    const secret = auth.startsWith('Bearer ')
      ? auth.slice(7).trim()
      : (req.headers.get('X-Api-Key') ?? '').trim()
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') // /v1/tasks/ === /v1/tasks
    const seg = path.split('/').filter(Boolean)
    if (seg[0] === 'v1' && seg[1] === 'webhooks')
      return await webhookResponse(ctx, req, seg, secret)
    const res = await authenticateSecret(ctx, secret, { person: false })
    // `=== false` (not `!res.ok`): the root tsconfig typechecks this file via
    // _generated/api.d.ts under strict:false, where truthiness narrowing of
    // the discriminant does not apply
    if (res.ok === false) return err(REST_AUTH_401[res.why], 401)
    // per-call last_used_at stamp — before any routing/work, even requests
    // that then 404 or 400 (the published contract; no throttle)
    const allowed = await ctx.runMutation(internal.machine.auth.touchCredential, {
      table: 'agent_keys',
      tokenId: res.cred.tokenId,
      rowId: res.cred.rowId,
      profileId: res.cred.profileId,
      now: new Date().toISOString(),
    })
    if (allowed === null) return err('unknown agent key', 401)
    if (!allowed) return rateLimited()
    const callerId = res.cred.profileId
    const keyName = res.cred.keyName ?? ''

    if (seg[0] !== 'v1') return err('unknown route (expected /v1/…)', 404)
    const q = (name: string): string | undefined => {
      const raw = url.searchParams.get(name)
      return raw === null ? undefined : raw
    }
    const body = req.method === 'POST' || req.method === 'PATCH' ? await req.text() : ''

    // -- projects --
    if (seg[1] === 'projects' && req.method === 'GET') {
      if (seg.length === 2) {
        return json(
          await ctx.runQuery(internal.machine.rest.listProjects, {
            callerId,
            archived: q('archived'),
          }),
          200,
        )
      }
      if (seg.length === 3) {
        return json(
          await ctx.runQuery(internal.machine.rest.getProject, {
            callerId,
            ref: safeDecode(seg[2]),
          }),
          200,
        )
      }
      if (seg.length === 4 && seg[3] === 'users') {
        return json(
          await ctx.runQuery(internal.machine.rest.listProjectUsers, {
            callerId,
            ref: safeDecode(seg[2]),
          }),
          200,
        )
      }
    }

    // -- users (read only: REST has no user write route) --
    if (seg[1] === 'users' && req.method === 'GET' && seg.length <= 3) {
      if (seg.length === 2)
        return json(await ctx.runQuery(internal.machine.rest.listUsers, { callerId }), 200)
      return json(
        await ctx.runQuery(internal.machine.rest.getUser, { callerId, ref: safeDecode(seg[2]) }),
        200,
      )
    }

    // -- tasks --
    if (seg[1] === 'tasks' && seg.length === 2 && req.method === 'GET') {
      return json(
        await ctx.runQuery(internal.machine.rest.listIssues, {
          callerId,
          project: q('project'),
          status: q('status'),
          priority: q('priority'),
          assignee: q('assignee'),
          search: q('search'),
          archived: q('archived'),
          limit: q('limit'),
          offset: q('offset'),
        }),
        200,
      )
    }
    if (seg[1] === 'tasks' && seg.length === 3 && req.method === 'GET') {
      return json(
        await ctx.runQuery(internal.machine.rest.getIssue, { callerId, ref: safeDecode(seg[2]) }),
        200,
      )
    }

    // -- comments --
    if (seg[1] === 'tasks' && seg.length === 4 && seg[3] === 'comments') {
      if (req.method === 'GET') {
        return json(
          await ctx.runQuery(internal.machine.rest.listComments, {
            callerId,
            ref: safeDecode(seg[2]),
          }),
          200,
        )
      }
      if (req.method === 'POST') {
        return json(
          await ctx.runMutation(internal.machine.rest.addComment, {
            callerId,
            ref: safeDecode(seg[2]),
            body,
          }),
          201,
        )
      }
      // other methods fall through to the unknown-route 404, as deployed
    }

    if (seg[1] === 'tasks' && seg.length === 2 && req.method === 'POST') {
      return json(
        await ctx.runMutation(internal.machine.rest.createIssue, { callerId, keyName, body }),
        201,
      )
    }
    if (
      seg[1] === 'tasks' &&
      seg.length === 3 &&
      (req.method === 'PATCH' || req.method === 'DELETE')
    ) {
      const ref = safeDecode(seg[2])
      if (req.method === 'DELETE') {
        return json(
          await ctx.runMutation(internal.machine.rest.deleteIssue, { callerId, keyName, ref }),
          200,
        )
      }
      return json(
        await ctx.runMutation(internal.machine.rest.updateIssue, { callerId, keyName, ref, body }),
        200,
      )
    }

    return err('unknown route', 404)
  } catch (e) {
    return refusalResponse(e)
  }
})

/* Registration — http.ts calls this ONCE at its bolt-on seam and is never
 * edited from here. Per-method routes: httpRouter has no wildcard method, and
 * pathPrefix '/v1/' does not match bare /v1. PUT is registered so it answers
 * the deployed auth-then-404 behavior; HEAD cannot be registered (accepted
 * edge). Requests outside /v1/* get Convex's default 404, not the in-handler
 * sentence (accepted delta — no root catch-all, it would collide with the
 * auth + file-gateway prefixes). */
export function registerRestRoutes(http: HttpRouter): void {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'] as const) {
    http.route({ path: '/v1', method, handler: restHandler })
    http.route({ pathPrefix: '/v1/', method, handler: restHandler })
  }
}
