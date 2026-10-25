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

/** The months from the one `from` falls in to the one `to` falls in, oldest
 * first, or none when `to` is earlier. */
export function monthsBetween(from: number, to: number): string[] {
  const out: string[] = []
  const d = new Date(from)
  for (let i = 0; ; i++) {
    const month = monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1))
    if (month > monthOf(to)) return out
    out.push(month)
  }
}

/** One day in milliseconds. */
export const DAY_MS = 86_400_000

/** Days a usage_months, usage_counts, usage_runs or usage_sign_ins row is
 * kept after its month. */
export const USAGE_RETENTION_DAYS = 800

/** The oldest month whose rows are kept at `now`. Older ones are deleted
 * (usage.ts expire). */
export const retentionCutoff = (now: number): string => monthOf(now - USAGE_RETENTION_DAYS * DAY_MS)

/* The counts one usage row holds. Seats, guests, agents, tasks, projects
 * and stored bytes are counted when the row is computed, which for a closed
 * month is just after it ended; the rest count what happened during the
 * month.
 * - billable: the seats Qivo bills (lib/billableUsers.ts), agents included
 * - guests, agents: active guest and agent profiles
 * - active_people: profiles that made a change, wrote a comment or made a
 *   REST or MCP call in the month, and active profiles whose login had a
 *   sign-in session created or refreshed in it while it held the seat. A
 *   session names no organization, so a sign-in counts in every
 *   organization where the login holds an active seat.
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
/* The bytes of the files that belong to a login rather than an
 * organization, account backgrounds and their previews, when the month's
 * rows were stored. Unlike the others it is set, not added to (usage.ts
 * closeMonth). */
export const PERSON_FILES = 'background_bytes'
/* The bytes of the deleted files Qivo still holds so a restore can bring
 * them back (model/fileHolds.ts), when the month's rows were stored. No row
 * names a held file, so it belongs to no organization and no organization's
 * stored bytes include it. Set like PERSON_FILES. */
export const HELD_FILES = 'held_file_bytes'
export const vUsageMetric = literals(...ORG_METRICS, ...PERSON_MAIL, PERSON_FILES, HELD_FILES)
export type UsageMetric = Infer<typeof vUsageMetric>

/** A kind of mail sent to a person rather than for an organization. */
export type PersonMailMetric = (typeof PERSON_MAIL)[number]

/** Mail sent to a person rather than for an organization, by kind. */
export type PersonMail = Record<PersonMailMetric, number>

/** The byte totals a month stores outside every organization. */
export type MonthBytes = typeof PERSON_FILES | typeof HELD_FILES

/** What a month holds outside every organization: account mail by kind,
 * the bytes of account backgrounds and of deleted files held for a restore,
 * each null for a closed month stored without it. */
export type Unattributed = PersonMail & Record<MonthBytes, number | null>

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
