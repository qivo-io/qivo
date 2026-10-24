/* The monthly usage figures of an organization (convex/usage.ts), their
 * validators and the pure helpers Qivo Admin's Usage page shares with the
 * server: UTC month keys and the spread of a column across organizations.
 * Nothing here reads the database. */

import { type Infer, v } from 'convex/values'
import { literals } from 'convex-helpers/validators'

/** A UTC calendar month, `YYYY-MM`. */
export const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The month `ms` falls in, as `YYYY-MM` (UTC). */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/** The first instant of `month` and of the month after it, in milliseconds,
 * or null for a key that is not a month. */
export function monthRange(month: string): { start: number; end: number } | null {
  const m = MONTH.exec(month)
  if (m === null) return null
  const year = Number(m[1])
  const index = Number(m[2]) - 1
  return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) }
}

/** The month before the one `ms` falls in. */
export function previousMonth(ms: number): string {
  const d = new Date(ms)
  return monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
}

/* The counts one usage row holds. Members are counted when the row is
 * computed, which for a closed month is just after it ended; the rest count
 * what happened during the month.
 * - billable: the seats Qivo bills (lib/billableUsers.ts), agents included
 * - guests, agents: active guest and agent profiles
 * - active_people: profiles that made a change, wrote a comment, made a REST
 *   or MCP call or had a sign-in session created or refreshed in the month
 * - active_tasks, live_projects: org_counters, null until it is counted
 * - changes: activity rows; comments: comments stored in the month
 * - api_calls: REST and MCP calls (see api_estimated on the row)
 * - file_bytes, image_bytes: task attachments and description images
 * - deleted_file_bytes: attachments held in Deleted items
 * - avatar_bytes: profile pictures
 * - webhook_deliveries, webhook_attempts: deliveries finished in the month
 *   and the requests they took
 * - mail_*: mail the provider accepted for the organization */
export const vUsageCounts = v.object({
  billable: v.number(),
  guests: v.number(),
  agents: v.number(),
  active_people: v.number(),
  active_tasks: v.union(v.number(), v.null()),
  live_projects: v.union(v.number(), v.null()),
  changes: v.number(),
  comments: v.number(),
  api_calls: v.number(),
  file_bytes: v.number(),
  image_bytes: v.number(),
  deleted_file_bytes: v.number(),
  avatar_bytes: v.number(),
  webhook_deliveries: v.number(),
  webhook_attempts: v.number(),
  mail_invitations: v.number(),
  mail_billing_reminders: v.number(),
  mail_deletion_notices: v.number(),
})
export type UsageCounts = Infer<typeof vUsageCounts>
export type UsageField = keyof UsageCounts

/* What usage_counts rows count (convex/usage.ts countUsage). The mail kinds
 * of an organization and the deliveries the webhook retention deleted share
 * their names with the row's counts. Mail that belongs to a person, not an
 * organization, is counted without one. */
export const ORG_METRICS = [
  'mail_invitations',
  'mail_billing_reminders',
  'mail_deletion_notices',
  'webhook_deliveries',
  'webhook_attempts',
] as const satisfies readonly UsageField[]
export const PERSON_MAIL = [
  'mail_verification',
  'mail_password_reset',
  'mail_account_notes',
] as const
export const vUsageMetric = literals(...ORG_METRICS, ...PERSON_MAIL)
export type UsageMetric = Infer<typeof vUsageMetric>

/** A kind of mail sent to a person rather than for an organization. */
export type PersonMailMetric = (typeof PERSON_MAIL)[number]

/** Mail sent to a person rather than for an organization, by kind. */
export type PersonMail = Record<PersonMailMetric, number>

/** The value below which `p` of `sorted` (ascending) falls, by the nearest
 * rank, or null for an empty list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** The median, 90th and 99th percentile and maximum of `values`, leaving out
 * nulls. Limits and add-on prices are set from these. */
export function spread(values: readonly (number | null)[]) {
  const sorted = values.filter((n): n is number => n !== null).sort((a, b) => a - b)
  return {
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  }
}

/** The share of `[from, to)` that lies inside `[start, end)`, 0 for an empty
 * span. An API bucket that crosses a month boundary is split by it. */
export function overlapShare(from: number, to: number, start: number, end: number): number {
  if (to <= from) return from >= start && from < end ? 1 : 0
  const inside = Math.min(to, end) - Math.max(from, start)
  return inside <= 0 ? 0 : inside / (to - from)
}
