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
 * assertWeekPair, SUB_MUST_NAME, deleteIssueCore), model/comments.ts
 * (postComment) and model/orgs.ts (setPlannableHoursCore); the task search
 * text is lib/search.ts taskSearchText, as in the app. This file adds only
 * what the model does not own: the caller shape, the ref grammar, the
 * catalogue, the access flags, the shared list reads and the wire
 * projections.
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
import { attachmentLimitMb } from '../model/orgs'
import {
  canAccessProject,
  canSeeProject,
  hasProjectLevel,
  liveCredentialRow,
  machineAccess,
  profileCanBeAssigned,
  readOnlyRefusal,
} from './access'
import { assertBillingWritable, BILLING_READ_ONLY, billingReadOnly } from './billingAccess'
import { byId } from './db'
import { refuseDemoFeature } from './demo'
import type {
  CredentialAccess,
  IssuePriority,
  IssueStatus,
  OrgRole,
  ProfileKind,
  ProjectType,
} from './enums'
import { badRequest, notFound, type Refusal } from './functions'
import { canCreateProjects } from './projectCreators'
import { allWordsMatcher, taskSearchText } from './search'
import type { EventOwner } from './taskEvents'
import { ISSUE_PREFIX, issueKey } from './taskRefs'

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
 * can change between auth and dispatch. Then the billing pause applies.
 */
export async function asMachineCaller(
  ctx: QueryCtx,
  callerId: string,
  access: CredentialAccess,
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
  if ('insert' in ctx.db) {
    if (machineAccess(me, access) !== 'write') throw readOnlyRefusal(me)
    await assertBillingWritable(ctx, me.org_id)
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
 * What the caller holds on each named project (core.ts:307-318's successor):
 * read = canSeeProject, write = hasProjectLevel 'user' through a credential
 * that may write (machineAccess). hasProjectLevel already applies the viewer
 * ceiling (cappedLevel), so an org-role-viewer agent and a grant-viewer agent
 * both get `write: false`, and so does every project seen through a
 * read-only credential. (asMachineCaller refuses those writes before they get
 * this far.) Here code sees everything and CHOOSES what to disclose; these
 * flags are that choice's only input. */

export type AccessFlag = { read: boolean; write: boolean }

export async function accessFlags(
  ctx: QueryCtx,
  me: Caller,
  projects: Doc<'projects'>[],
  access: CredentialAccess,
): Promise<Map<string, AccessFlag>> {
  const writes = machineAccess(me, access) === 'write'
  const out = new Map<string, AccessFlag>()
  for (const p of projects) {
    out.set(p.id, {
      read: await canSeeProject(ctx, me, p),
      write: writes && (await hasProjectLevel(ctx, me, p.id, 'user')),
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

/* The organization's label names by task, read through each label so that
 * assignments stored without an organization are found too. */
async function labelNamesByTask(ctx: QueryCtx, orgId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const labels = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const label of labels) {
    const rows = ctx.db
      .query('issue_labels')
      .withIndex('by_label', (q) => q.eq('label_id', label.id))
    for await (const row of rows) {
      const names = out.get(row.issue_id)
      if (names === undefined) out.set(row.issue_id, [label.name])
      else names.push(label.name)
    }
  }
  return out
}

/* Each fragment may match any field of the app's task filter (lib/search.ts
 * taskSearchText), in any order: the task ID, title, description, status
 * name (not on a task with subtasks), priority name, assignee name or a
 * label name. REST retains explicit `*` wildcards; all other punctuation
 * stays literal. `children` is the organization's tasks by parent, which
 * tells whether a task has subtasks. */
async function searchMatcher(
  ctx: QueryCtx,
  me: Caller,
  o: { term: string; stars: boolean; children: ChildIndex },
): Promise<(i: Doc<'issues'>) => boolean> {
  const matches = allWordsMatcher(o.term, o.stars)
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const labels = await labelNamesByTask(ctx, me.org_id)
  return (i) =>
    matches(
      taskSearchText({
        key: issueKey(i.num),
        title: i.title,
        description: i.description,
        status: i.status,
        group: hasSubtasksIn(o.children, i),
        priority: i.priority,
        assigneeName: i.assignee_id === undefined ? null : names.get(i.assignee_id),
        labelNames: labels.get(i.id) ?? [],
      }),
    )
}

/* The page of matching tasks, plus the organization's tasks indexed by
 * parent from the same read, so group dates need no further queries. */
export async function listIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ListIssueOpts,
  cat: Catalogue,
  readable: (projectId: string) => boolean,
): Promise<{ page: Doc<'issues'>[]; children: ChildIndex }> {
  const scope = o.scope === null ? null : new Set(o.scope)
  const out: Doc<'issues'>[] = []
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const children = childIndexOf(rows)
  const match = o.search
    ? await searchMatcher(ctx, me, { term: o.search, stars: o.stars, children })
    : null
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
  return { page: out.slice(o.offset, o.offset + o.limit), children }
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

/* A project's people for the machine surfaces' project roster (REST
 * GET /v1/projects/{ref}/users, MCP list_project_users), ordered by name.
 * The caller must already have resolved a project it can read. A parent's
 * people are those with standing on the parent itself; someone who sees it
 * only through a sub-project is listed under that sub-project. A reporter
 * may be anyone listed; an assignee or reviewer needs `assignable`. */
export async function listProjectUsersCore(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
): Promise<(ReturnType<typeof userJson> & { assignable: boolean })[]> {
  const out = []
  for (const profile of await listUsersCore(ctx, me)) {
    if (!(await canAccessProject(ctx, profile, project))) continue
    out.push({
      ...userJson(profile),
      assignable: await profileCanBeAssigned(ctx, profile, project),
    })
  }
  return out
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
 * the parent link (null unless the caller can read the parent) and the
 * `archived` boolean are REST-only. A group's plan weeks are calculated
 * (groupWeeks), never its dormant stored pair. */
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
  /** the organization's tasks by parent, for list calls (group dates) */
  children?: ChildIndex
}

/** An organization's tasks, archived ones included, keyed by parent id. */
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

/** hasSubtasks over an index: an archived task also counts archived ones. */
const hasSubtasksIn = (index: ChildIndex, task: Doc<'issues'>): boolean =>
  (index.get(task.id) ?? []).some(
    (kid) => task.archived_at !== undefined || kid.archived_at === undefined,
  )

/* REST's parent link: the parent's uuid only when this caller could read the
 * parent (findIssue's rule), else null, which reads like a top-level task.
 * `readable` is the caller's project flags when the surface already holds
 * them, which saves the visibility walk per row. */
async function parentIdFor(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  readable?: (projectId: string) => boolean,
): Promise<string | null> {
  if (issue.parent_id === undefined) return null
  if (readable === undefined) return (await findIssue(ctx, me, issue.parent_id))?.id ?? null
  const parent = await byId(ctx, 'issues', issue.parent_id)
  return parent !== null && parent.org_id === me.org_id && readable(parent.project_id)
    ? parent.id
    : null
}

/* How many tasks a single group read walks one by_parent read at a time
 * before it reads the organization's tasks once instead (the read a REST
 * list makes anyway). It keeps both Convex limits in reach: index ranges
 * stay far below 4,096, and only a very large group pays a full read. */
const SUBTREE_WALK_BUDGET = 1000

/* On REST a group's plan weeks run from the earliest start to the latest
 * end of the scheduled leaves under it that the caller can read, at any
 * depth. A nested group counts only through its own leaves; its stored
 * dates are dormant. The walk passes only through readable tasks, so a
 * subtask under one the caller cannot read never counts. Like is_group, an
 * active group counts only active subtasks and an archived one its whole
 * subtree. Under a group in an active project, subtasks in archived projects
 * do not count. A leaf without an end counts as its start week. Done leaves
 * count. Both weeks are null when no such leaf is scheduled. `readable` is
 * the caller's project flags when the surface already holds them. A list
 * passes `children`, the index built from the rows it already read. A single
 * task walks its own subtree, one by_parent read per task it visits, and
 * reads the organization's tasks once instead when the subtree passes
 * SUBTREE_WALK_BUDGET. */
export async function groupWeeks(
  ctx: QueryCtx,
  group: Doc<'issues'>,
  groupProject: Doc<'projects'>,
  me: Caller,
  readable?: (projectId: string) => boolean,
  children?: ChildIndex,
): Promise<{ start_week: string | null; end_week: string | null }> {
  const allArchived = group.archived_at !== undefined
  const liveProject = groupProject.archived_at === undefined
  // whether a subtask in this project may count, read once per project
  const counted = new Map<string, Promise<boolean>>()
  const countsIn = (projectId: string): Promise<boolean> => {
    let known = counted.get(projectId)
    if (known === undefined) {
      known = (async () => {
        const p = await byId(ctx, 'projects', projectId)
        if (p === null || (liveProject && p.archived_at !== undefined)) return false
        return readable !== undefined ? readable(p.id) : await canSeeProject(ctx, me, p)
      })()
      counted.set(projectId, known)
    }
    return known
  }
  /* One walk; null when it would read more than `budget` tasks' children.
   * Each visited task's children are read once: they decide whether it is
   * a group (hasSubtasks' rule, whoever can read them) and what the walk
   * enters next. */
  const walk = async (
    childrenOf: (id: string) => Promise<readonly Doc<'issues'>[]>,
    budget: number,
  ): Promise<{ start_week: string | null; end_week: string | null } | null> => {
    let start: string | undefined
    let end: string | undefined
    let reads = 0
    const seen = new Set<string>([group.id])
    let frontier: Doc<'issues'>[] = [group]
    // assertParentChain bounds chains at 20 tasks, so the walk stops there
    for (let depth = 0; frontier.length > 0 && depth <= 20; depth++) {
      const next: Doc<'issues'>[] = []
      for (const task of frontier) {
        if (++reads > budget) return null
        const kids = await childrenOf(task.id)
        const isGroup = kids.some(
          (kid) => task.archived_at !== undefined || kid.archived_at === undefined,
        )
        if (task !== group && !isGroup) {
          if (task.start_week === undefined) continue
          const leafEnd = task.end_week ?? task.start_week
          if (start === undefined || task.start_week < start) start = task.start_week
          if (end === undefined || leafEnd > end) end = leafEnd
          continue
        }
        // a group, the root included, counts only through its subtasks
        for (const c of kids) {
          if (seen.has(c.id)) continue
          if (!allArchived && c.archived_at !== undefined) continue
          if (!(await countsIn(c.project_id))) continue
          seen.add(c.id)
          next.push(c)
        }
      }
      frontier = next
    }
    return { start_week: start ?? null, end_week: end ?? null }
  }
  const NONE = { start_week: null, end_week: null }
  // an index walk has no budget, so it always answers
  const fromIndex = async (index: ChildIndex) =>
    (await walk(async (id) => index.get(id) ?? [], Infinity)) ?? NONE
  if (children !== undefined) return await fromIndex(children)
  const bySubtree = await walk(
    (id) =>
      ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', id))
        .collect(),
    SUBTREE_WALK_BUDGET,
  )
  if (bySubtree !== null) return bySubtree
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', group.org_id))
    .collect()
  return await fromIndex(childIndexOf(rows))
}

type RestOut = { surface: 'rest'; me: Caller; readable?: (projectId: string) => boolean }

export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & RestOut,
): Promise<RestIssueJson>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & { surface: 'mcp' },
): Promise<McpIssueOut>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & (RestOut | { surface: 'mcp' }),
): Promise<RestIssueJson | McpIssueOut> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  const is_group =
    opts.children !== undefined
      ? hasSubtasksIn(opts.children, issue)
      : await hasSubtasks(ctx, issue.id, issue.archived_at !== undefined)
  const assignee_name = await profileName(ctx, issue.assignee_id, opts.names)
  const reviewer_name = await profileName(ctx, issue.reviewer_id, opts.names)
  const reporter_name = await profileName(ctx, issue.reporter_id, opts.names)
  if (opts.surface === 'rest') {
    const weeks = is_group
      ? await groupWeeks(ctx, issue, project, opts.me, opts.readable, opts.children)
      : { start_week: issue.start_week ?? null, end_week: issue.end_week ?? null }
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
      parent_id: await parentIdFor(ctx, opts.me, issue, opts.readable),
      start_week: weeks.start_week,
      end_week: weeks.end_week,
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
  const readOnly = await billingReadOnly(ctx, org.id)
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
    billing: { read_only: readOnly, reason: readOnly ? BILLING_READ_ONLY : null },
    credential: {
      kind: CREDENTIAL_KIND[credential.credential_table],
      access: machineAccess(me, access),
      expires_at: 'token_hash' in row ? (row.expires_at ?? null) : null,
      name: 'client_name' in row ? row.client_name : row.name,
    },
  }
}

/** What get_me and GET /v1/me answer. */
export type MeJson = Awaited<ReturnType<typeof meCore>>
