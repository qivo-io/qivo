/* The Usage view's columns, month picker and CSV export
   (views/Usage.tsx), kept apart so the view file exports only components. */
import { monthOf, retentionCutoff, type UsageField } from '../../convex/lib/usage'
import type { UsageMonth } from './api'

/** One column of the usage table, in the order shown. */
export type Column = { key: UsageField; label: string; bytes?: boolean; hint: string }

export const USAGE_COLUMNS: readonly Column[] = [
  { key: 'billable', label: 'Billable', hint: 'Seats billed when the row was computed' },
  { key: 'guests', label: 'Guests', hint: 'Active guests' },
  { key: 'agents', label: 'Agents', hint: 'Active agents' },
  {
    key: 'active_people',
    label: 'Active',
    hint: 'People who signed in, made a change, commented or called the API',
  },
  { key: 'active_tasks', label: 'Tasks', hint: 'Active tasks' },
  { key: 'live_projects', label: 'Projects', hint: 'Projects, archived ones included' },
  { key: 'changes', label: 'Changes', hint: 'Logged changes' },
  { key: 'comments', label: 'Comments', hint: 'Comments written' },
  { key: 'api_calls', label: 'API calls', hint: 'REST and MCP calls' },
  { key: 'file_bytes', label: 'Files', bytes: true, hint: 'Task attachments' },
  { key: 'image_bytes', label: 'Images', bytes: true, hint: 'Description images' },
  {
    key: 'deleted_file_bytes',
    label: 'Deleted files',
    bytes: true,
    hint: 'Attachments held in Deleted items',
  },
  { key: 'avatar_bytes', label: 'Pictures', bytes: true, hint: 'Profile pictures' },
  { key: 'webhook_deliveries', label: 'Webhooks', hint: 'Webhook deliveries finished' },
  { key: 'webhook_attempts', label: 'Requests', hint: 'Webhook requests sent' },
  { key: 'mail_invitations', label: 'Invites', hint: 'Invitation emails' },
  { key: 'mail_billing_reminders', label: 'Billing mail', hint: 'Billing reminders' },
  { key: 'mail_deletion_notices', label: 'Deletion mail', hint: 'Deletion notices' },
]

/** The months the picker offers, newest first: this month back to the
 * oldest one retention keeps (convex/lib/usage.ts retentionCutoff). */
export function pickerMonths(now: number): string[] {
  const d = new Date(now)
  const oldest = retentionCutoff(now)
  const months: string[] = []
  for (let i = 0; ; i++) {
    const month = monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
    if (month < oldest) return months
    months.push(month)
  }
}

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
export const fmtMonth = (month: string): string =>
  MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`))

/** The figures that belong to no organization, in the order shown. */
export const UNATTRIBUTED_COLUMNS = [
  'background_bytes',
  'mail_verification',
  'mail_password_reset',
  'mail_account_notes',
] as const satisfies readonly (keyof UsageMonth['unattributed'])[]

/* Text a spreadsheet would read as a formula: an organization's name is
   chosen by its admins, and the operator opens the file. */
const FORMULA = /^[=+\-@\t\r]/

/** One CSV cell. Text that starts like a formula gets a leading
 * apostrophe, so a spreadsheet shows it as text. */
function cell(value: string | number | boolean | null): string {
  let text = value === null ? '' : String(value)
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The months the people breakdown offers, newest first: the picker's
 * months and any other month the organization's figures hold, such as a
 * month that began after the picker was built. */
export function peopleMonths(choices: readonly string[], months: readonly string[]): string[] {
  return [...new Set([...choices, ...months])].sort().reverse()
}

/** The month as CSV: one line per organization with every count in whole
 * units (bytes, not formatted sizes), one line without counts per
 * organization whose current figures failed to load (`failed`), then one
 * line for what belongs to no organization, in columns of its own.
 * `month_partial` marks a month whose counters began during it
 * (convex/model/usage.ts monthStatus) and `month_unfinished` a closed month
 * whose run has not finished, so some organizations may be missing. It
 * starts with a byte order mark, so a spreadsheet reads it as UTF-8. */
export function usageCsv(table: UsageMonth): string {
  const head = [
    'month',
    'org_id',
    'organization',
    ...USAGE_COLUMNS.map((c) => c.key),
    ...UNATTRIBUTED_COLUMNS,
    'api_estimated',
    'computed_at',
    'month_partial',
    'month_unfinished',
    'failed',
  ]
  const { partial, run } = table.status
  const unfinished = !table.current && run !== null && run.finished_at === null
  const blank = (n: number) => Array.from({ length: n }, () => null)
  const lines = table.rows.map((row) => [
    table.month,
    row.org_id,
    row.name,
    ...USAGE_COLUMNS.map((c) => row.counts[c.key]),
    ...blank(UNATTRIBUTED_COLUMNS.length),
    row.api_estimated,
    row.computed_at,
    partial,
    unfinished,
    false,
  ])
  for (const org of table.failed)
    lines.push([
      table.month,
      org.org_id,
      org.name,
      ...blank(USAGE_COLUMNS.length + UNATTRIBUTED_COLUMNS.length + 2),
      partial,
      unfinished,
      true,
    ])
  lines.push([
    table.month,
    null,
    'No organization',
    ...blank(USAGE_COLUMNS.length),
    ...UNATTRIBUTED_COLUMNS.map((key) => table.unattributed[key]),
    null,
    null,
    partial,
    unfinished,
    null,
  ])
  return `\ufeff${[head, ...lines].map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`
}
