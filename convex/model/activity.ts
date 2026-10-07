import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { ActivityTarget, IssuePriority, IssueStatus } from '../lib/enums'
import { notFound } from '../lib/functions'
import { newUuid } from './orgs'

// Shared display names for activity and inbox narration.
export const STATUS_NAMES: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
}

export const PRIORITY_NAMES: Record<IssuePriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

// The feed displays 30 rows; snapshot and retention allow 500.
const ACTIVITY_CAP = 500

// Activity and retention commit with the mutation they describe. The counter
// avoids reading the retained feed on every write; imported rows bootstrap it.
export async function logActivity(
  ctx: MutationCtx,
  e: {
    org_id: string
    actor_id: string | undefined
    verb: string
    target_type: ActivityTarget
    target_id: string
    label: string
    detail?: string
    ts: string
    project_id?: string
    team_id?: string
  },
): Promise<void> {
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
    team_id: e.team_id,
  })
  const org = await byId(ctx, 'organizations', e.org_id)
  if (org === null) throw notFound('organization not found')
  if (org.activity_count === undefined) {
    // One complete pass also repairs a bulk import larger than the cap.
    let kept = 0
    for await (const row of ctx.db
      .query('activity_events')
      .withIndex('by_org_ts', (q) => q.eq('org_id', e.org_id))
      .order('desc')) {
      if (++kept > ACTIVITY_CAP) await ctx.db.delete(row._id)
    }
    await ctx.db.patch(org._id, { activity_count: Math.min(kept, ACTIVITY_CAP) })
    return
  }
  const count = org.activity_count + 1
  if (count > ACTIVITY_CAP) {
    // Ascending order is the exact reverse of retention's descending index,
    // including equal timestamps and a newly inserted backdated event.
    const expired = await ctx.db
      .query('activity_events')
      .withIndex('by_org_ts', (q) => q.eq('org_id', e.org_id))
      .order('asc')
      .take(count - ACTIVITY_CAP)
    for (const row of expired) await ctx.db.delete(row._id)
    if (org.activity_count !== ACTIVITY_CAP)
      await ctx.db.patch(org._id, { activity_count: ACTIVITY_CAP })
  } else {
    await ctx.db.patch(org._id, { activity_count: count })
  }
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

// Append machine provenance, with or without a field diff.
export const machineDetail = (extra: string | undefined, provenance: string): string =>
  (extra !== undefined && extra !== '' ? `${extra} — ` : '') + provenance

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
