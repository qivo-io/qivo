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
 * + write + activity in one transaction). Shared RULES live in model/issues.ts
 * (cleanTitle, pairRule, metaNeedsSub, assertLive, assertAssignable,
 * assertNoSubtasks, assertWeekPair, SUB_MUST_NAME) and model/orgs.ts
 * (setPlannableHoursCore); this file adds only what the model does not own:
 * the caller shape, the ref grammar, the catalogue, the access flags, the
 * shared list reads and the wire projections.
 *
 * Refusal grammar: helpers here throw the shipped ConvexError {code, message,
 * reason?} values (lib/functions.ts). REST maps code → status (not_found 404,
 * forbidden 403, bad_request 400, rule 400 — readable beats a 500); MCP
 * collapses every refusal into the one isError sentence. */

import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { machineDetail } from '../model/activity'
import { hasSubtasks, subtaskParentIds } from '../model/issues'
import { canSeeProject, hasProjectLevel } from './access'
import { assertBillingWritable } from './billingAccess'
import { byId } from './db'
import { refuseDemoFeature } from './demo'
import type { IssuePriority, IssueStatus, OrgRole, ProfileKind, ProjectType } from './enums'
import { badRequest, notFound, type Refusal } from './functions'
import { allWordsMatcher } from './search'
import { ISSUE_PREFIX, issueKey } from './taskRefs'

export { machineDetail }

/* ------------------------------------------------------------------ caller
 * Uuid convention: machine internal fns take `callerId: v.string()` (the
 * profile uuid the auth query resolved) and start with asMachineCaller. The
 * model layer takes the loaded doc everywhere, so the Caller IS the doc. */

export type Caller = Doc<'profiles'>

/* Sentinel `reason` marks for the auth-to-dispatch race (auth runs in a
 * SEPARATE query, so the profile can flip between lookup and dispatch — the
 * Deno single-transaction never had the window; re-asserting closes it).
 * The surface HTTP action maps these back to its own 401 sentence: REST
 * 'unknown agent key' / 'this agent has been deactivated'; MCP its per-leg
 * sentence (machine/auth.ts mcpAuth401). The messages here are REST's, as
 * the fallback if a surface skips the mapping. */
export const CALLER_GONE = 'caller_gone'
export const CALLER_DEACTIVATED = 'caller_deactivated'

export async function asMachineCaller(ctx: QueryCtx, callerId: string): Promise<Caller> {
  refuseDemoFeature()
  const me = await byId(ctx, 'profiles', callerId)
  if (me === null) {
    throw new ConvexError<Refusal>({
      code: 'forbidden',
      message: 'unknown agent key',
      reason: CALLER_GONE,
    })
  }
  if (!me.active) {
    throw new ConvexError<Refusal>({
      code: 'forbidden',
      message: 'this agent has been deactivated',
      reason: CALLER_DEACTIVATED,
    })
  }
  if ('insert' in ctx.db) await assertBillingWritable(ctx, me.org_id)
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
 * visible; each surface phrases that itself. */
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
  return (await canSeeProject(ctx, me, project)) ? issue : null
}

/* Project refs: uuid, per-org project number, or KEY. Digit-only project keys
 * are legal (^[A-Z0-9]{1,5}$), so an all-digit ref resolves as a number first
 * and falls back to the key on a miss — numbers are the durable grammar and
 * win a collision. Resolves archived projects (refs must keep working).
 *
 * Visibility is deliberately NOT applied here: REST resolves against the
 * whole org catalogue (its one 403-oracle must name projects the caller
 * cannot see), MCP wraps this with canSeeProject → null → its uniform
 * "not found (or not visible to you)". Each surface layers its own fence. */
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
 * (never N point reads) — the naming service (rest-api/index.ts:162-189):
 * REST resolves refs against it so it can name projects the caller cannot
 * see; MCP reuses it for list scopes. Nothing here grants anything — every
 * disclosed id runs past accessFlags. */

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
 * What the caller holds on each named project (core.ts:307-318's successor):
 * read = canSeeProject, write = hasProjectLevel 'user'. hasProjectLevel
 * already applies the viewer ceiling (cappedLevel) — the 0102 "viewer agent
 * writes nothing" rule comes for free on BOTH the grant-viewer and the
 * org-role-viewer agent. Here code sees everything and CHOOSES what to
 * disclose; these flags are that choice's only input. */

export type AccessFlag = { read: boolean; write: boolean }

export async function accessFlags(
  ctx: QueryCtx,
  me: Caller,
  projects: Doc<'projects'>[],
): Promise<Map<string, AccessFlag>> {
  const out = new Map<string, AccessFlag>()
  for (const p of projects) {
    out.set(p.id, {
      read: await canSeeProject(ctx, me, p),
      write: await hasProjectLevel(ctx, me, p.id, 'user'),
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

export type ListIssueOpts = {
  /** explicit project ids (the surface's scope expansion), or null for
   *  "everything readable" — which then excludes issues whose PROJECT is
   *  archived (0106's two archive axes: naming the project is what asks) */
  scope: string[] | null
  archived: boolean
  status?: IssueStatus
  priority?: IssuePriority
  /** profile uuid, already lowercased by the surface */
  assignee?: string
  search?: string
  /** REST lets `*` widen; MCP does not — a literal `*` must stay literal */
  stars: boolean
  limit: number
  offset: number
  /** REST paginates by creation order; MCP reads by project key then num */
  order: 'created' | 'key'
}

/* Each fragment may match the task ID, title or description, in any order.
 * REST retains explicit `*` wildcards; all other punctuation stays literal. */
export function searchMatcher(term: string, stars: boolean): (i: Doc<'issues'>) => boolean {
  const matches = allWordsMatcher(term, stars)
  return (i) => matches(`${ISSUE_PREFIX}-${i.num}\n${i.title}\n${i.description}`)
}

export async function listIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ListIssueOpts,
  cat: Catalogue,
  readable: (projectId: string) => boolean,
): Promise<Doc<'issues'>[]> {
  const scope = o.scope === null ? null : new Set(o.scope)
  const match = o.search ? searchMatcher(o.search, o.stars) : null
  const out: Doc<'issues'>[] = []
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const groupIds = o.status ? subtaskParentIds(rows, o.archived) : null
  for (const i of rows) {
    if ((i.archived_at !== undefined) !== o.archived) continue
    if (!readable(i.project_id)) continue // RLS's successor — always, scope or not
    if (scope !== null) {
      if (!scope.has(i.project_id)) continue
    } else if (cat.byUuid.get(i.project_id)?.archived_at !== undefined) {
      continue // an archived project's tasks are not the working set (0106)
    }
    if (o.status && (groupIds?.has(i.id) || i.status !== o.status)) continue
    if (o.priority && i.priority !== o.priority) continue
    if (o.assignee && i.assignee_id !== o.assignee) continue
    if (match !== null && !match(i)) continue
    out.push(i)
  }
  if (o.order === 'created') {
    out.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.num - b.num,
    )
  } else {
    const keyOf = (i: Doc<'issues'>): string => cat.byUuid.get(i.project_id)?.key ?? ''
    out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.num - b.num)
  }
  return out.slice(o.offset, o.offset + o.limit)
}

const byKeyOrder = (a: Doc<'projects'>, b: Doc<'projects'>): number => a.key.localeCompare(b.key)

/* core.ts listProjects: the caller-visible projects on ONE side of the
 * archived axis — (archived_at set) === archived — ordered by key. */
export async function listProjectsCore(
  ctx: QueryCtx,
  me: Caller,
  archived: boolean,
  readable: (projectId: string) => boolean,
): Promise<Doc<'projects'>[]> {
  const out: Doc<'projects'>[] = []
  const rows = ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', me.org_id))
  for await (const p of rows) {
    if ((p.archived_at !== undefined) !== archived) continue
    if (!readable(p.id)) continue
    out.push(p)
  }
  return out.sort(byKeyOrder)
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

/* A task's discussion thread, oldest first (ties keep insertion order —
 * Array.prototype.sort is stable). Visibility rides the issue: callers reach
 * this only through findIssue. */
export async function listCommentsCore(ctx: QueryCtx, issueId: string): Promise<Doc<'comments'>[]> {
  const rows = await ctx.db
    .query('comments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect()
  return rows.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  )
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
  reporter_id: string | null
  reporter_name: string | null
  project_id: string
  project_key: string
  project_num: number
  due_date: string | null
  remaining_hours: number | null
  remaining_set_at: string | null
  paused: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

/* REST issueJson (rest:240-254): superset minus project_name; the plan weeks,
 * the parent link and the `archived` boolean are REST-only. */
export type RestIssueJson = IssueOutCommon & {
  parent_id: string | null
  start_week: string | null
  end_week: string | null
  archived: boolean
}

/* MCP issueOut (mcp:93-102): superset minus start_week/end_week/parent_id and
 * minus the boolean (archived_at only); names the project. */
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
  /** profile uuid → name, for list calls (skips per-row point reads) */
  names?: ReadonlyMap<string, string>
}

export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & { surface: 'rest' },
): Promise<RestIssueJson>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & { surface: 'mcp' },
): Promise<McpIssueOut>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & { surface: 'rest' | 'mcp' },
): Promise<RestIssueJson | McpIssueOut> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  const is_group = await hasSubtasks(ctx, issue.id, issue.archived_at !== undefined)
  const assignee_name = await profileName(ctx, issue.assignee_id, opts.names)
  const reviewer_name = await profileName(ctx, issue.reviewer_id, opts.names)
  const reporter_name = await profileName(ctx, issue.reporter_id, opts.names)
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
      reporter_id: issue.reporter_id ?? null,
      reporter_name,
      parent_id: issue.parent_id ?? null,
      start_week: issue.start_week ?? null,
      end_week: issue.end_week ?? null,
      due_date: issue.due_date ?? null,
      remaining_hours: issue.remaining_hours ?? null,
      remaining_set_at: issue.remaining_set_at ?? null,
      paused: issue.paused,
      archived: issue.archived_at !== undefined,
      archived_at: issue.archived_at ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
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
    reporter_id: issue.reporter_id ?? null,
    reporter_name,
    project_id: issue.project_id,
    project_key: project.key,
    project_num: project.num,
    project_name: project.name,
    due_date: issue.due_date ?? null,
    remaining_hours: issue.remaining_hours ?? null,
    remaining_set_at: issue.remaining_set_at ?? null,
    paused: issue.paused,
    archived_at: issue.archived_at ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  }
}

/* REST projectJson (rest:215-220) — the caller's flags ride along. */
export const restProjectJson = (
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

/* MCP projectOut (mcp:110-114): no flags, no boolean. */
export const mcpProjectOut = (
  p: Doc<'projects'>,
): {
  id: string
  key: string
  num: number
  name: string
  type: ProjectType
  parent_id: string | null
  team_id: string | null
  description: string
  archived_at: string | null
} => ({
  id: p.id,
  key: p.key,
  num: p.num,
  name: p.name,
  type: p.type,
  parent_id: p.parent_id ?? null,
  team_id: p.team_id ?? null,
  description: p.description,
  archived_at: p.archived_at ?? null,
})

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
