import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { ActivityTarget, IssuePriority, IssueStatus } from '../lib/enums'
import { notFound } from '../lib/functions'
import { ISSUE_PREFIX, PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { plainText } from '../lib/textLimits'
import { newUuid } from './orgs'

/* ----------------------------------------------------------------- retention
 * Each subject keeps its own newest SUBJECT_ACTIVITY_CAP rows. The writer
 * (insertActivity) numbers a subject's rows through seq and deletes the one
 * row a new row pushes past the cap, so writes about one subject never remove
 * another's history. Readers ask for one subject's rows through the by_target
 * index. Rows stored before numbering have no seq; they sort first and stay
 * until their task is deleted for good. */

type EntryFields = {
  org_id: string
  actor_id: string | undefined
  verb: string
  target_id: string
  label: string
  detail?: string
  ts: string
  project_id?: string
  related_project_id?: string
  team_id?: string
}

/** One activity row as its writers describe it. A task row lists the numbers
 * of the other tasks its detail names, [] when none, so visibility never
 * reads the text (lib/activityVisibility.ts). */
export type ActivityEntry =
  | (EntryFields & { target_type: 'issue'; named_task_nums: readonly number[] })
  | (EntryFields & { target_type: Exclude<ActivityTarget, 'issue'>; named_task_nums?: never })

/** Rows each subject keeps. A subject is one (target_type, target_id): a
 * task, project, milestone or person, or under 'org' the organization or one
 * of its labels. Team rows are rows about the person they name. Writes about
 * other subjects never remove them. */
export const SUBJECT_ACTIVITY_CAP = 500

/** Inserts `e` as its subject's next row, one past the subject's newest
 * numbered row, and deletes the row this pushes past SUBJECT_ACTIVITY_CAP.
 * It reads only the subject's own newest row, so writers about different
 * subjects never conflict. Rows written earlier in the same mutation count,
 * so rows about one subject written one after another get consecutive
 * numbers. Never run two calls for one subject at the same time, as in
 * Promise.all: both would read the same newest row. Rows stored before
 * numbering have no seq, sort first and are neither counted nor deleted.
 * `opts.id` fixes the row id, for the Northstar seed only. It does not check
 * the organization; logActivity does. */
export async function insertActivity(
  ctx: MutationCtx,
  e: ActivityEntry,
  opts: { id?: string } = {},
): Promise<void> {
  const newest = await ctx.db
    .query('activity_events')
    .withIndex('by_target', (q) =>
      q.eq('org_id', e.org_id).eq('target_type', e.target_type).eq('target_id', e.target_id),
    )
    .order('desc')
    .first()
  const seq = (newest?.seq ?? 0) + 1
  await ctx.db.insert('activity_events', {
    id: opts.id ?? newUuid(),
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
    seq,
    named_task_nums: e.target_type === 'issue' ? [...e.named_task_nums] : undefined,
  })
  if (seq <= SUBJECT_ACTIVITY_CAP) return
  // first, not unique: a duplicate seq must not make every later write fail
  const dropped = await ctx.db
    .query('activity_events')
    .withIndex('by_target', (q) =>
      q
        .eq('org_id', e.org_id)
        .eq('target_type', e.target_type)
        .eq('target_id', e.target_id)
        .eq('seq', seq - SUBJECT_ACTIVITY_CAP),
    )
    .first()
  if (dropped !== null) await ctx.db.delete(dropped._id)
}

/** Inserts one activity row with the mutation it describes and checks that
 * the organization exists. */
export async function logActivity(ctx: MutationCtx, e: ActivityEntry): Promise<void> {
  await insertActivity(ctx, e)
  // A read only. The organization row changes rarely (settings, the slug,
  // an export record), so this check seldom makes a write retry.
  const org = await byId(ctx, 'organizations', e.org_id)
  if (org === null) throw notFound('organization not found')
}

/* The task numbers a task row stored before named_task_nums existed names
 * by key, read from its text: a parent change written by model/issues.ts
 * browserVerbDetail ('moved' under QN-n (from QN-m), 'detached' from QN-m)
 * and a link written by model/links.ts addLinkCore ('linked' (blocks QN-n)).
 * A REST or MCP write appended its provenance (machineDetail below), which
 * names no task. Returns [] when the row names none, and null when the
 * wording is not one those writers produced, so the reader can fail closed.
 * Newer rows store the numbers instead, so their wording no longer needs to
 * match this parser.
 *
 * Rows written before October 2026 joined the provenance with ' — ' and
 * wrote a link as '— blocks QN-n'; later ones use ', ' and '(blocks QN-n)'.
 * Stored rows keep their text, so both forms are read. */
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

/** Whether a task write changed anything its history narrates: a DIFF_FIELDS
 * column, the parent or the archive state. It compares the stored rows, so a
 * trimmed title, cleanRemaining and the unchanged-parent drop count as no
 * change. */
export function narratedChange(before: Doc<'issues'>, after: Doc<'issues'>): boolean {
  return (
    DIFF_FIELDS.some(([col]) => (before[col] ?? '') !== (after[col] ?? '')) ||
    before.parent_id !== after.parent_id ||
    before.archived_at !== after.archived_at
  )
}

// Strip diff delimiters to prevent forged clauses; truncate by codepoint.
const clean = (s: string): string => {
  const t = plainText(s)
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
