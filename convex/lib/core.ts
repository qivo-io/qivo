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
 * catalogue, the access flags, the shared list reads, the wire projections
 * and applyTaskUpdate, the write order of a task update on both surfaces.
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
import { postArchiveReason } from '../model/comments'
import {
  assertLive,
  type IssuePatch,
  type LaterPeople,
  metaNeedsSub,
  moveIssueCore,
  pairRule,
  SUB_MUST_NAME,
  subtaskParentIds,
  updateIssueCore,
} from '../model/issues'
import { labelJson, setTaskLabel } from '../model/labels'
import { linkKindFrom, linksOf, type TaskLinkKind } from '../model/links'
import { followersOf } from '../model/messages'
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
import { taskOwnerId } from './review'
import { allWordsMatcher, searchPieces, taskSearchText } from './search'
import type { EventOwner } from './taskEvents'
import { ISSUE_PREFIX, issueKey } from './taskRefs'
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
 * can change between auth and dispatch. Then the billing pause applies.
 *
 * It does not read the caller's login for a platform ban. Each request
 * dispatches one call, and its credential lookup already refused a banned
 * login (machine/auth.ts lookupCredential for personal tokens,
 * oauthConnections.lookupAccess for OAuth before every call). Rereading it
 * here would add a Better Auth query to every call, so a ban that lands
 * mid-request lets that request finish, like a revocation does. Agent keys
 * belong to no login.
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
  /** any of these statuses; status filters leave groups out */
  statuses?: readonly IssueStatus[]
  priority?: IssuePriority
  /** profile uuid, already lowercased by the surface */
  assignee?: string
  /** profile uuid of the owner (lib/review.ts taskOwnerId), lowercased */
  owner?: string
  search?: string
  /** REST lets `*` widen; MCP does not — a literal `*` must stay literal */
  stars: boolean
  limit: number
  offset: number
  /** REST paginates by creation order; MCP reads by project key then num */
  order: 'created' | 'key'
}

/* The organization's label names by task, for only the labels whose name
 * contains one of the search's `pieces` (lib/search.ts searchPieces). No
 * other label can change whether a task matches, so its assignments are not
 * read, and a search whose pieces no label name contains reads none. Labels
 * keep the organization's label order, and each is read through its own
 * assignments (by_label), so that assignments stored without an
 * organization are found too. */
async function labelNamesByTask(
  ctx: QueryCtx,
  orgId: string,
  pieces: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (pieces.length === 0) return out
  const labels = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const label of labels) {
    const name = label.name.toLowerCase()
    if (!pieces.some((piece) => name.includes(piece))) continue
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
  const labels = await labelNamesByTask(ctx, me.org_id, searchPieces(o.term, o.stars))
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
  const statuses = o.statuses !== undefined && o.statuses.length > 0 ? o.statuses : null
  const groupIds = statuses !== null ? subtaskParentIds(rows, o.archived) : null
  for (const i of rows) {
    if ((i.archived_at !== undefined) !== o.archived) continue
    if (!readable(i.project_id)) continue // RLS's successor — always, scope or not
    if (scope !== null) {
      if (!scope.has(i.project_id)) continue
    } else if (cat.byUuid.get(i.project_id)?.archived_at !== undefined) {
      continue // an archived project's tasks are not the working set (0106)
    }
    if (statuses !== null && (groupIds?.has(i.id) || !statuses.includes(i.status))) continue
    if (o.priority && i.priority !== o.priority) continue
    if (o.assignee && i.assignee_id !== o.assignee) continue
    // a group stays with its assignee, as in the app
    if (o.owner && taskOwnerId(i, hasSubtasksIn(children, i)) !== o.owner) continue
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
  remaining_hours: number | null
  remaining_set_at: string | null
  paused: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
  /** the app's Copy link address, null when SITE_URL is unset */
  url: string | null
}

/* REST issueJson (rest:240-254): superset minus project_name, plus the
 * `archived` boolean. A group's plan weeks are calculated (groupWeeks) on
 * both surfaces, never its dormant stored pair. */
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
  /** profile uuid → name, for list calls (skips per-row point reads) */
  names?: ReadonlyMap<string, string>
  /** the organization's slug, for list calls (task links) */
  orgSlug?: string
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

/* --------------------------------------------- what a read says of others
 * A machine read is shown the tasks whose project the caller can read
 * (findIssue's rule), archived ones included. Every task a read names
 * besides the one asked for (parent, subtasks, links, group totals) passes
 * lib/workingSet.ts with this Shown, as the app's snapshot passes its
 * working set. */

/** The caller's project read access, from the surface's flags when it holds
 * them, else canSeeProject, read once per project. */
export function projectReader(
  ctx: QueryCtx,
  me: Caller,
  readable?: (projectId: string) => boolean,
): (projectId: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>()
  return (projectId) => {
    let result = known.get(projectId)
    if (result === undefined) {
      result =
        readable !== undefined
          ? Promise.resolve(readable(projectId))
          : byId(ctx, 'projects', projectId).then(
              async (p) => p !== null && (await canSeeProject(ctx, me, p)),
            )
      known.set(projectId, result)
    }
    return result
  }
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
 * already holds them, which saves the visibility walk per row. */
async function parentOut(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  readable?: (projectId: string) => boolean,
): Promise<{ parent_id: string | null; has_hidden_parent: boolean }> {
  const parent = issue.parent_id === undefined ? null : await byId(ctx, 'issues', issue.parent_id)
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

/* How many tasks a single-task read walks, one by_parent read at a time,
 * before it reads the organization's tasks once instead (the read a REST
 * list makes anyway). The read walks the subtree once (subtreeIndex) and
 * every group total uses that one index, which keeps both Convex limits in
 * reach. Index ranges stay far below 4,096, and only a group with more
 * tasks that count under it than this pays a full read. */
const SUBTREE_WALK_BUDGET = 1000

/* The subtasks a single-task read of `root` uses, indexed by parent. They
 * are the root's own and those of every task under it that counts toward
 * its totals (`counts`, groupCounter). is_group and the subtask list need
 * only the root's subtasks, and the totals' walks enter only tasks that
 * count and need each one's subtasks to tell a leaf from a group, so a
 * branch that cannot count is never read below its top. It reads one level
 * at a time and stops at the depth assertParentChain allows; past
 * SUBTREE_WALK_BUDGET reads it reads the organization's tasks once
 * instead. */
async function subtreeIndex(
  ctx: QueryCtx,
  root: Doc<'issues'>,
  counts: GroupCounter,
): Promise<ChildIndex> {
  const index = new Map<string, Doc<'issues'>[]>()
  const seen = new Set<string>([root.id])
  let frontier = [root.id]
  let reads = 0
  for (let depth = 0; frontier.length > 0 && depth <= 20; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      if (++reads > SUBTREE_WALK_BUDGET) {
        const rows = await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', root.org_id))
          .collect()
        return childIndexOf(rows)
      }
      const kids = await ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', id))
        .collect()
      index.set(id, kids)
      for (const kid of kids) {
        if (seen.has(kid.id) || !(await counts(kid))) continue
        seen.add(kid.id)
        next.push(kid.id)
      }
    }
    frontier = next
  }
  return index
}

/** Whether a task under a group counts toward the group's totals. */
type GroupCounter = (task: Doc<'issues'>) => Promise<boolean>

/**
 * The one rule for which tasks under `group` count toward its calculated
 * plan weeks and remaining hours, for `me`. A task counts when the caller
 * can read its project. Like is_group, an active group counts only active
 * subtasks and an archived one its whole subtree. Under a group in an active
 * project, subtasks in archived projects do not count. The totals' walks
 * never enter a task that does not count, so nothing under it counts either.
 * `readable` is the caller's project flags when the surface already holds
 * them. Each project is read once.
 */
function groupCounter(
  ctx: QueryCtx,
  me: Caller,
  group: Doc<'issues'>,
  groupProject: Doc<'projects'>,
  readable?: (projectId: string) => boolean,
): GroupCounter {
  const allArchived = group.archived_at !== undefined
  const liveProject = groupProject.archived_at === undefined
  const byProject = new Map<string, Promise<boolean>>()
  return async (task) => {
    if (task.org_id !== me.org_id) return false
    if (!allArchived && task.archived_at !== undefined) return false
    let known = byProject.get(task.project_id)
    if (known === undefined) {
      known = (async () => {
        const p = await byId(ctx, 'projects', task.project_id)
        if (p === null || (liveProject && p.archived_at !== undefined)) return false
        return readable !== undefined ? readable(p.id) : await canSeeProject(ctx, me, p)
      })()
      byProject.set(task.project_id, known)
    }
    return await known
  }
}

/* On REST and MCP a group's plan weeks run from the earliest start to the
 * latest end of the scheduled leaves under it that count (groupCounter), at
 * any depth. A nested group counts only through its own leaves; its stored
 * dates are dormant. A leaf without an end counts as its start week. Done
 * leaves count. Both weeks are null when no such leaf is scheduled.
 * `children` holds the group's subtree by parent. A list passes the index it
 * built from the rows it already read, and a single-task read passes its
 * subtreeIndex. Each visited task's children decide whether it is a group
 * (hasSubtasks' rule, whoever can read them) and what the walk enters next. */
async function groupWeeks(
  group: Doc<'issues'>,
  children: ChildIndex,
  counts: GroupCounter,
): Promise<{ start_week: string | null; end_week: string | null }> {
  let start: string | undefined
  let end: string | undefined
  const seen = new Set<string>([group.id])
  let frontier: Doc<'issues'>[] = [group]
  // assertParentChain bounds chains at 20 tasks, so the walk stops there
  for (let depth = 0; frontier.length > 0 && depth <= 20; depth++) {
    const next: Doc<'issues'>[] = []
    for (const task of frontier) {
      if (task !== group && !hasSubtasksIn(children, task)) {
        if (task.start_week === undefined) continue
        const leafEnd = task.end_week ?? task.start_week
        if (start === undefined || task.start_week < start) start = task.start_week
        if (end === undefined || leafEnd > end) end = leafEnd
        continue
      }
      // a group, the root included, counts only through its subtasks
      for (const c of children.get(task.id) ?? []) {
        if (seen.has(c.id) || !(await counts(c))) continue
        seen.add(c.id)
        next.push(c)
      }
    }
    frontier = next
  }
  return { start_week: start ?? null, end_week: end ?? null }
}

/** Who reads a task, and through which surface's shape. `readable` is the
 * caller's project flags when the surface already holds them. */
type Reader = {
  surface: 'rest' | 'mcp'
  me: Caller
  readable?: (projectId: string) => boolean
}

/** The tasks by parent that a row's group facts come from. A list passes the
 * organization's tasks, and a single-task read the task's subtreeIndex with
 * the groupCounter that walk used, which the totals then share. */
type Subtree = { children: ChildIndex; counts?: GroupCounter }

export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree & { surface: 'rest' },
): Promise<RestIssueJson>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree & { surface: 'mcp' },
): Promise<McpIssueOut>
export async function issueOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & Subtree,
): Promise<RestIssueJson | McpIssueOut> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  const is_group = hasSubtasksIn(opts.children, issue)
  const assignee_name = await profileName(ctx, issue.assignee_id, opts.names)
  const reviewer_name = await profileName(ctx, issue.reviewer_id, opts.names)
  const reporter_name = await profileName(ctx, issue.reporter_id, opts.names)
  const weeks = is_group
    ? await groupWeeks(
        issue,
        opts.children,
        opts.counts ?? groupCounter(ctx, opts.me, issue, project, opts.readable),
      )
    : { start_week: issue.start_week ?? null, end_week: issue.end_week ?? null }
  const parent = await parentOut(ctx, opts.me, issue, opts.readable)
  const owner_id = taskOwnerId(issue, is_group) ?? null
  const orgSlug = opts.orgSlug ?? (await byId(ctx, 'organizations', issue.org_id))?.slug ?? '~'
  const url = taskUrl(orgSlug, issue.num)
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
      remaining_hours: issue.remaining_hours ?? null,
      remaining_set_at: issue.remaining_set_at ?? null,
      paused: issue.paused,
      archived: issue.archived_at !== undefined,
      archived_at: issue.archived_at ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
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
    remaining_hours: issue.remaining_hours ?? null,
    remaining_set_at: issue.remaining_set_at ?? null,
    paused: issue.paused,
    archived_at: issue.archived_at ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
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
  /** a group's remaining hours as the app shows them, null for a leaf */
  group_remaining_hours: number | null
  labels: ReturnType<typeof labelJson>[]
  /** the subtasks the caller can read, active ones for an active task */
  subtasks: TaskRefJson[]
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

/**
 * The single-task read's extra fields for `issue`, read by `me`. `isGroup`,
 * `project`, `children` (its subtreeIndex) and `counts` (the groupCounter
 * that walk used) are what taskOut already holds. The group total counts
 * what groupCounter counts, as the plan weeks do.
 */
export async function taskDetail(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  o: {
    project: Doc<'projects'>
    isGroup: boolean
    children: ChildIndex
    counts?: GroupCounter
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
  if (o.isGroup) {
    const counts = o.counts ?? groupCounter(ctx, me, issue, o.project, o.readable)
    const counted = new Set<string>()
    for (const task of [...o.children.values()].flat()) {
      if (await counts(task)) counted.add(task.id)
    }
    group_remaining_hours = groupRemainingHours(issue, childrenOf, (id) => counted.has(id))
  }
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
  const followers = await followersOf(ctx, issue)
  return {
    group_remaining_hours,
    labels: labels.map(labelJson),
    subtasks,
    links,
    following: followers.some((p) => p.id === me.id),
    followers: followers.map((p) => ({ id: p.id, name: p.name })),
  }
}

/** The task's attachments with download links minted for the reader
 * (model/attachments.ts taskAttachments), inline images included. */
export type TaskAttachmentsJson = { attachments: AttachmentJson[] }

/** issueOut plus taskDetail and the attachments, the shape of every
 * single-task read. */
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & { surface: 'rest' },
): Promise<RestIssueJson & TaskDetailJson & TaskAttachmentsJson>
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader & { surface: 'mcp' },
): Promise<McpIssueOut & TaskDetailJson & TaskAttachmentsJson>
export async function taskOut(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  opts: IssueOutPre & Reader,
): Promise<(RestIssueJson | McpIssueOut) & TaskDetailJson & TaskAttachmentsJson> {
  const project = opts.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) throw notFound('task not found') // unreachable: every issue joins a project
  // one walk of the subtree serves the row's group facts and the detail,
  // and one counter its pruning and both totals
  const counts = groupCounter(ctx, opts.me, issue, project, opts.readable)
  const children = await subtreeIndex(ctx, issue, counts)
  const row =
    opts.surface === 'rest'
      ? await issueOut(ctx, issue, { ...opts, surface: 'rest', project, children, counts })
      : await issueOut(ctx, issue, { ...opts, surface: 'mcp', project, children, counts })
  const detail = await taskDetail(ctx, opts.me, issue, {
    project,
    isGroup: row.is_group,
    children,
    counts,
    readable: opts.readable,
  })
  return { ...row, ...detail, attachments: await taskAttachments(ctx, opts.me, issue) }
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
 * the place of the current ones (model/issues.ts LaterPeople). Answers the
 * task as written.
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
  },
): Promise<Doc<'issues'>> {
  const { me, now, provenance } = a
  const archives = a.archive === true && a.issue.archived_at === undefined
  const toggles = a.archive !== undefined && a.archive !== (a.issue.archived_at !== undefined)
  // the people the field patch sets, which that write checks itself
  const later: LaterPeople = {}
  if ('assignee_id' in a.patch) later.assignee_id = a.patch.assignee_id
  if ('reviewer_id' in a.patch) later.reviewer_id = a.patch.reviewer_id
  let task = a.issue
  if (a.destination !== undefined) {
    task = await moveIssueCore(ctx, {
      me,
      issue: task,
      project_id: a.destination.id,
      now,
      machine: { provenance, later },
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
  }
  // one row write, one notify fan-out and one activity row for the fields
  // and the toggle (updateIssueCore's machine seam)
  if (Object.keys(a.patch).length > 0 || toggles) {
    task = await updateIssueCore(ctx, {
      me,
      issue: task,
      patch: a.patch,
      now,
      machine: { provenance, archive: a.archive },
    })
  }
  for (const [list, on] of [
    [a.labels.add, true],
    [a.labels.remove, false],
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
