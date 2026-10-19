import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { ActivityTarget, IssuePriority, IssueStatus } from '../lib/enums'
import { notFound } from '../lib/functions'
import { ISSUE_PREFIX, PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { newUuid } from './orgs'

/* ----------------------------------------------------------------- retention
 * Every reader takes an organization's newest ACTIVITY_CAP rows by the
 * by_org_ts index order (ts, then creation time). Writers only insert. A
 * background trim (activityRetention.ts) deletes the older rows a few minutes
 * later, so concurrent writers in one organization never conflict over
 * deleting the oldest row. Storage holds the cap plus about the last
 * ACTIVITY_TRIM_DELAY_MS of writes, or up to ACTIVITY_TRIM_STALE_MS of them
 * when a trim is lost, so code that walks an organization's activity in one
 * transaction reads only the newest ACTIVITY_CAP rows or works in bounded
 * steps. The organization's activity_retention row records a pending trim,
 * so writes schedule at most one at a time. */

/** The newest rows of an organization's activity that every reader shows.
 * The feed displays 30 of them. */
export const ACTIVITY_CAP = 500
/** How long an organization's activity may run past the cap before a trim. */
export const ACTIVITY_TRIM_DELAY_MS = 5 * 60_000
/** A pending trim this far past due is assumed lost and scheduled again. */
export const ACTIVITY_TRIM_STALE_MS = 60 * 60_000
/** Rows newer than this stay for a later trim, which only counts the oldest
 * of them, so a trim seldom reads the range that writes in flight insert
 * into. */
const TRIM_SETTLE_MS = 10_000
/** Rows one trim step deletes before it schedules the next. Tests lower it. */
export const ACTIVITY_TRIM_BUDGET = { rows: 1_000 }

/** The trim step (activityRetention.ts), by name, since that module imports
 * this one. */
export const activityTrimRef = makeFunctionReference<'mutation', { org_id: string }, null>(
  'activityRetention:trim',
)

/** The organization's activity_retention row, or null before its first
 * activity write or after the organization is deleted. */
export const retentionRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('activity_retention')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** Creates the organization's activity_retention row with no trim pending,
 * when it has none. Returns whether it did. */
export async function ensureActivityRetention(ctx: MutationCtx, orgId: string): Promise<boolean> {
  if ((await retentionRow(ctx, orgId)) !== null) return false
  await ctx.db.insert('activity_retention', { org_id: orgId })
  return true
}

/** Schedules a trim of the organization's activity unless one is pending.
 * While one is, a write only reads the state row, so concurrent writers do
 * not conflict, and the several writes of one mutation schedule one trim.
 * Code that inserts activity rows directly calls it once afterwards. */
export async function requestActivityTrim(ctx: MutationCtx, orgId: string): Promise<void> {
  const state = await retentionRow(ctx, orgId)
  const now = Date.now()
  if (state?.trim_due_at !== undefined && state.trim_due_at > now - ACTIVITY_TRIM_STALE_MS) return
  const due = now + ACTIVITY_TRIM_DELAY_MS
  await ctx.scheduler.runAt(due, activityTrimRef, { org_id: orgId })
  if (state === null) await ctx.db.insert('activity_retention', { org_id: orgId, trim_due_at: due })
  else await ctx.db.patch(state._id, { trim_due_at: due })
}

/** One trim step. Deletes, oldest first and at most ACTIVITY_TRIM_BUDGET.rows,
 * the rows beyond the newest ACTIVITY_CAP among those older than the settle
 * time. Readers order rows the same way, so the kept rows include every row
 * they show. Returns 'more' when such rows remain, 'later' when rows newer
 * than the settle time still hold the organization past the cap, and 'done'
 * when it holds at most ACTIVITY_CAP rows. */
export async function trimActivity(
  ctx: MutationCtx,
  orgId: string,
): Promise<'done' | 'more' | 'later'> {
  const cutoff = new Date(Date.now() - TRIM_SETTLE_MS).toISOString()
  const kept = await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', orgId).lt('ts', cutoff))
    .order('desc')
    .take(ACTIVITY_CAP)
  if (kept.length === ACTIVITY_CAP) {
    const oldestKept = kept[kept.length - 1]
    let deleted = 0
    for await (const row of ctx.db
      .query('activity_events')
      .withIndex('by_org_ts', (q) => q.eq('org_id', orgId).lte('ts', oldestKept.ts))
      .order('asc')) {
      if (row._id === oldestKept._id) break
      if (deleted === ACTIVITY_TRIM_BUDGET.rows) return 'more'
      await ctx.db.delete(row._id)
      deleted++
    }
  }
  // Only as many newer rows as would pass the cap are read, so the read
  // stops short of the newest rows, where writes in flight insert, whenever
  // the organization has more.
  const room = ACTIVITY_CAP - kept.length
  const unsettled = await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', orgId).gte('ts', cutoff))
    .take(room + 1)
  return unsettled.length > room ? 'later' : 'done'
}

/** One activity row as its writers describe it. */
export type ActivityEntry = {
  org_id: string
  actor_id: string | undefined
  verb: string
  target_type: ActivityTarget
  target_id: string
  label: string
  detail?: string
  ts: string
  project_id?: string
  related_project_id?: string
  team_id?: string
}

// Activity commits with the mutation it describes. Retention runs later in
// the background (requestActivityTrim), so a write never reads the feed.
export async function logActivity(ctx: MutationCtx, e: ActivityEntry): Promise<void> {
  await insertActivity(ctx, e)
  // A read only. The organization row changes rarely (settings, the slug,
  // an export record), so this check seldom makes a write retry.
  const org = await byId(ctx, 'organizations', e.org_id)
  if (org === null) throw notFound('organization not found')
  await requestActivityTrim(ctx, e.org_id)
}

/** Inserts one activity row, without logActivity's organization check and
 * trim request. A mutation that writes a row for each of many tasks inserts
 * them with this and calls requestActivityTrim once afterwards, so it reads
 * the retention row once rather than once per row. */
export async function insertActivity(ctx: MutationCtx, e: ActivityEntry): Promise<void> {
  await ctx.db.insert('activity_events', {
    id: newUuid(),
    org_id: e.org_id,
    ts: e.ts,
    actor_id: e.actor_id,
    verb: e.verb,
    target_type: e.target_type,
    target_id: e.target_id,
    label: e.label,
    detail: e.detail,
    project_id: e.project_id,
    related_project_id: e.related_project_id,
    team_id: e.team_id,
  })
}

/* Task rows that name other tasks by key: a parent change written by
 * model/issues.ts browserVerbDetail ('moved' under QN-n (from QN-m),
 * 'detached' from QN-m) and a link written by model/links.ts addLinkCore
 * ('linked' (blocks QN-n)). A REST or MCP write appends its provenance
 * (machineDetail below), which names no task. Returns the task numbers the
 * row names, [] when it names none, and null when the wording is not one
 * these writers produce, so the reader can fail closed. Keep in step with
 * those two writers.
 *
 * Rows written before October 2026 joined the provenance with ' — ' and
 * wrote a link as '— blocks QN-n'. Stored rows keep that text, so both
 * forms are read. */
const KEY = `${ISSUE_PREFIX}-(\\d+)`
const SIGNED = '(?:(?: —|,) via (?:MCP|the REST API(?: \\(.*\\))?))?'
const NAMED_PARENT_CHANGE = new RegExp(
  `^under (?:${KEY}|its parent)(?: \\(from ${KEY}\\))?${SIGNED}$`,
)
const NAMED_DETACH = new RegExp(`^from (?:${KEY}|its parent)${SIGNED}$`)
const NAMED_LINK = new RegExp(
  `^(?:— (?:blocks|relates to) ${KEY}|\\((?:blocks|relates to) ${KEY}\\))${SIGNED}$`,
)
export function namedTaskNums(
  ev: Pick<Doc<'activity_events'>, 'target_type' | 'verb' | 'detail'>,
): number[] | null {
  if (ev.target_type !== 'issue') return []
  const detail = ev.detail ?? ''
  const grammar =
    ev.verb === 'moved' && detail.startsWith('under ')
      ? NAMED_PARENT_CHANGE
      : ev.verb === 'detached'
        ? NAMED_DETACH
        : ev.verb === 'linked'
          ? NAMED_LINK
          : undefined
  if (grammar === undefined) return []
  const m = grammar.exec(detail)
  if (m === null) return null
  return m
    .slice(1)
    .filter((n): n is string => n !== undefined)
    .map(Number)
}

// Stable narration order and labels.
const DIFF_FIELDS = [
  ['title', 'title'],
  ['status', 'status'],
  ['priority', 'priority'],
  ['assignee_id', 'assignee'],
  ['reviewer_id', 'reviewer'],
  ['reporter_id', 'reporter'],
  ['due_date', 'due date'],
  ['start_week', 'start week'],
  ['end_week', 'end week'],
  ['remaining_hours', 'remaining'],
  ['paused', 'paused'],
  ['description', 'description'],
] as const

// Strip diff delimiters to prevent forged clauses; truncate by codepoint.
const clean = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').replace(/[“”]/g, "'").replace(/→/g, '-').trim()
  const cp = [...t]
  return cp.length > 80 ? `${cp.slice(0, 79).join('')}…` : t
}

/** Appends a machine write's provenance to a detail, after a comma, or is
 * the provenance alone when there is no detail. namedTaskNums reads the
 * joined form back. */
export const machineDetail = (extra: string | undefined, provenance: string): string =>
  (extra !== undefined && extra !== '' ? `${extra}, ` : '') + provenance

/** An activity detail signed with a machine write's provenance, or the
 * detail alone for an app write, which passes none. */
export const signedDetail = (
  detail: string | undefined,
  provenance: string | undefined,
): string | undefined => (provenance === undefined ? detail : machineDetail(detail, provenance))

// Narrate stored before/after values, resolving profile names when available.
// No changed narratable fields means no detail string.
export function issueChanges(
  before: Doc<'issues'>,
  after: Doc<'issues'>,
  names?: ReadonlyMap<string, string>,
): string | undefined {
  const fmt = (col: (typeof DIFF_FIELDS)[number][0], v: unknown): string => {
    if (v === undefined || v === null || v === '') return 'unset'
    if (col === 'status') return STATUS_NAMES[v as IssueStatus] ?? String(v)
    if (col === 'priority') return PRIORITY_NAMES[v as IssuePriority] ?? String(v)
    if (col === 'assignee_id' || col === 'reviewer_id' || col === 'reporter_id') {
      return names?.get(String(v)) ?? String(v)
    }
    if (col === 'remaining_hours') return `${String(v)} h`
    if (col === 'paused') return v ? 'yes' : 'no'
    if (col === 'title' || col === 'description') {
      return `“${clean(String(v))}”`
    }
    return String(v) // the date columns keep their ISO grammar
  }
  const parts: string[] = []
  for (const [col, label] of DIFF_FIELDS) {
    const a = before[col]
    const b = after[col]
    if ((a ?? '') === (b ?? '')) continue
    parts.push(`${label} ${fmt(col, a)} → ${fmt(col, b)}`)
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : undefined
}
