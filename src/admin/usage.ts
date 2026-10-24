/* The Usage view's columns, month picker and CSV export
   (views/Usage.tsx), kept apart so the view file exports only components. */
import { monthOf, type UsageField } from '../../convex/lib/usage'
import { fmtBytes, type UsageMonth } from './api'

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

/** The months the picker offers: this month and the 26 before it, newest
 * first, as stored rows are kept for 800 days. */
export function pickerMonths(now: number): string[] {
  const d = new Date(now)
  return Array.from({ length: 27 }, (_, i) =>
    monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)),
  )
}

export const fmtValue = (column: Column, value: number | null): string =>
  value === null ? '—' : column.bytes ? fmtBytes(value) : value.toLocaleString()

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
export const fmtMonth = (month: string): string =>
  MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`))

/** The month as CSV: one line per organization with every count in whole
 * units (bytes, not formatted sizes). */
export function usageCsv(table: UsageMonth): string {
  const cell = (value: string | number | boolean | null) => {
    const text = value === null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const head = [
    'month',
    'org_id',
    'organization',
    ...USAGE_COLUMNS.map((c) => c.key),
    'api_estimated',
    'computed_at',
  ]
  const lines = table.rows.map((row) =>
    [
      table.month,
      row.org_id,
      row.name,
      ...USAGE_COLUMNS.map((c) => row.counts[c.key]),
      row.api_estimated,
      row.computed_at,
    ]
      .map(cell)
      .join(','),
  )
  return `${[head.join(','), ...lines].join('\r\n')}\r\n`
}
