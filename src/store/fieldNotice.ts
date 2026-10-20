/* The notice for an edit the server refused because someone else changed
   the same field first (convex/model/expected.ts, reason `field_changed`).
   The store (store/planner.ts) owns when a notice shows; this module only
   words it, from the refusal's `changes` and what the store knows about the
   write. */

import type { FieldChange } from '../../convex/lib/functions'

/** What a refused write was and what became of the person's change. */
export type Refusal = {
  changes: readonly FieldChange[]
  /** A delete or a link removal, which the notice says was not done. */
  deletes?: boolean
  /** The draft stays in its editor, so the person can save it again. */
  kept?: boolean
  /** How many Roadmap changes the refused batch held. */
  batch?: number
  /** How many of the person's changes this one notice line stands for,
      later edits built on the refused one included. */
  count: number
  /** The write waited through a lost connection and the other change was
      made meanwhile. */
  offline?: boolean
}

/** Who wrote a value: the person's own seat elsewhere (`you`), a name, or
    unknown (null). */
export type Writer = 'you' | { name: string } | null

/** What the wording needs from the store. */
export type Lookup = {
  /** The record a change is about, as the notice names it: a task key, or
      `this comment on QN-12`, `Ana's access to Website` and so on. */
  record: (change: FieldChange) => string
  writer: (profileId: string) => Writer
}

/* How the notice names each field, by record kind. */
const WORDS: Partial<Record<FieldChange['record'], Record<string, string>>> = {
  task: {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    assignee_id: 'assignee',
    reviewer_id: 'reviewer',
    start_week: 'start date',
    end_week: 'end date',
    due_date: 'due date',
    remaining_hours: 'remaining time',
    paused: 'pause',
    parent_id: 'parent',
    project_id: 'project',
  },
  milestone: { name: 'name', week: 'date', date: 'date' },
  project: {
    name: 'name',
    description: 'description',
    key: 'key',
    track_delay: 'delay tracking',
    review_hours: 'review time',
    lead_id: 'lead',
  },
  team: {
    name: 'name',
    stale_days: 'stale-task days',
    archive_days: 'archive days',
    track_delay_default: 'default delay tracking',
  },
  label: { name: 'name', color: 'color' },
  profile: {
    org_role: 'role',
    active: 'status',
    name: 'name',
    email: 'email',
    can_create_projects: 'project creation right',
    plannable_hours: 'plannable hours',
    avatar_storage_id: 'profile picture',
  },
  organization: {
    name: 'name',
    date_format: 'date format',
    week_start: 'week start',
    week_one_rule: 'week-one rule',
    default_plannable_hours: 'default plannable hours',
    max_attachment_mb: 'attachment size limit',
    project_creators: 'project creators',
    slug: 'address',
  },
}

/* Records whose one checked field is the whole record, so the notice names
   the record alone: "Emil Berg changed this comment on QN-12". */
const WHOLE = new Set<FieldChange['record']>(['comment', 'grant', 'link'])

/** Joins words as people list them: "a", "a and b", "a, b and c". */
const listed = (words: readonly string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/* The fields of one record's changes as the notice names them. A task's
   start and end date together are its dates. */
function fieldWords(changes: readonly FieldChange[]): string[] {
  const fields = new Set(changes.map((c) => c.field))
  const record = changes[0]?.record
  const words: string[] = []
  for (const field of fields) {
    if (record === 'task' && fields.has('start_week') && fields.has('end_week')) {
      if (field === 'end_week') continue
      if (field === 'start_week') {
        words.push('dates')
        continue
      }
    }
    words.push((record && WORDS[record]?.[field]) ?? field.replaceAll('_', ' '))
  }
  return words
}

/** The one line a notice shows for refusal `r`. */
export function refusalLine(r: Refusal, look: Lookup): string {
  const first = r.changes[0]
  if (!first) return r.deletes ? 'Not deleted.' : 'Not saved.'
  const record = look.record(first)
  // one record per refusal: the server refuses the first record that conflicts
  const words = fieldWords(r.changes.filter((c) => c.id === first.id && c.of === first.of))
  const whole = WHOLE.has(first.record)
  const people = new Set(r.changes.map((c) => c.by))
  const by = people.size === 1 ? first.by : null
  const writer = by === null ? null : look.writer(by)
  const what = whole ? record : `the ${listed(words)} of ${record}`
  const offline = r.offline ? ' while you were offline' : ''
  const changed =
    writer === 'you'
      ? `You changed ${what} elsewhere${offline}.`
      : writer
        ? `${writer.name} changed ${what}${offline}.`
        : `${capital(what)} ${!whole && words.length > 1 ? 'were' : 'was'} changed elsewhere${offline}.`
  const tail = r.deletes
    ? 'Check it before you delete it again.'
    : r.kept
      ? 'Your text is still in the editor. Save again to replace their version.'
      : r.batch !== undefined && r.batch > 1
        ? `None of the ${r.batch} roadmap changes were saved.`
        : writer === 'you'
          ? r.count > 1
            ? `These ${r.count} changes were discarded.`
            : 'This change was discarded.'
          : r.count > 1
            ? `Your ${r.count} changes were discarded.`
            : 'Your change was discarded.'
  return `${r.deletes ? 'Not deleted.' : 'Not saved.'} ${changed} ${tail}`
}

/** The most lines one notice shows before it says how many more. */
export const NOTICE_LINES = 3

/** The text of a notice holding `lines`, newest last: up to NOTICE_LINES of
    them, then how many more. */
export function noticeText(lines: readonly string[]): string {
  const shown = lines.slice(0, NOTICE_LINES)
  const more = lines.length - shown.length
  return [...shown, ...(more > 0 ? [`And ${more} more not saved.`] : [])].join('\n')
}
