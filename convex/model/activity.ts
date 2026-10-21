import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { ActivityTarget, IssuePriority, IssueStatus } from '../lib/enums'
import { notFound } from '../lib/functions'
import { cutText } from '../lib/limits'
import { PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { newUuid } from './orgs'

/* ------------------------------------------------------------------- history
 * Every row stays until its subject is deleted for good, as Deleted items
 * deletes a task's history (model/deletedItems.ts purgeActivity) and an
 * organization's deletion its own. Readers ask for one subject's rows through
 * the by_target index, which orders them by insertion, and read a task's
 * history a page at a time (lib/activityVisibility.ts taskHistoryPage). */

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
  /** On a task row, the prints of the fields the write changed
   * (model/expected.ts changedPrints). */
  field_prints?: Record<string, string>
}

/** One activity row as its writers describe it. A task row lists the numbers
 * of the other tasks its detail names, [] when none, so visibility never
 * reads the text (lib/activityVisibility.ts). */
export type ActivityEntry =
  | (EntryFields & { target_type: 'issue'; named_task_nums: readonly number[] })
  | (EntryFields & { target_type: Exclude<ActivityTarget, 'issue'>; named_task_nums?: never })

/** Inserts `e` as a new row of its subject's history. A subject is one
 * (target_type, target_id): a task, project, milestone or person, or under
 * 'org' the organization or one of its labels. Team rows are rows about the
 * person they name. It reads nothing, so writers about one subject never
 * conflict over its history. `opts.id` fixes the row id, for the Northstar
 * seed only. It does not check the organization; logActivity does. */
export async function insertActivity(
  ctx: MutationCtx,
  e: ActivityEntry,
  opts: { id?: string } = {},
): Promise<void> {
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
    named_task_nums: e.target_type === 'issue' ? [...e.named_task_nums] : undefined,
    field_prints: e.field_prints,
  })
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

/** `s` as plain activity text: trimmed, each run of whitespace (line
 * breaks included) one space, the → arrow `-` and curly double quotes `'`.
 * Activity diffs use those characters as delimiters, and the app reads
 * status and reviewer clauses out of them (src/lib/teamSync.ts
 * statusMoveOf), so free text written through this cannot add or hide one. */
export const plainText = (s: string): string =>
  s.replace(/\s+/g, ' ').replace(/[“”]/g, "'").replace(/→/g, '-').trim()

/** The longest excerpt of a title or description an activity line quotes,
 * in UTF-16 code units with its "…". A display length, not a limit: a
 * longer text is cut, never refused. */
const EXCERPT_MAX = 80

/** `s` as plain activity text (plainText), cut to EXCERPT_MAX with "…"
 * when longer, without splitting an emoji. */
export const excerpt = (s: string): string => {
  const t = plainText(s)
  return t.length > EXCERPT_MAX ? `${cutText(t, EXCERPT_MAX - 1)}…` : t
}

/** Appends a machine write's provenance to a detail, after a comma, or is
 * the provenance alone when there is no detail. */
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
      return `“${excerpt(String(v))}”`
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
