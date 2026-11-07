import { v } from 'convex/values'
import type { OrgRemovalReason } from './enums'

// Commercial terms are immutable. Changing the default chooses a version for
// future assignments; it never rewrites a customer's existing agreement.
export const billingPlanFields = {
  name: v.string(),
  currency: v.string(),
  seat_price_cents: v.number(),
  minimum_seats: v.number(),
  storage_gb_per_seat: v.number(),
  minimum_storage_gb: v.number(),
  api_calls_per_seat: v.number(),
  storage_block_price_cents: v.number(),
  api_block_price_cents: v.number(),
  api_block_size: v.number(),
  polar_product_id: v.optional(v.string()),
  api_meter_id: v.optional(v.string()),
  storage_meter_id: v.optional(v.string()),
}

export const vBillingStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('unpaid'),
  v.literal('paused'),
)

export type BillingPlan = {
  id: string
  name: string
  currency: string
  seat_price_cents: number
  minimum_seats: number
  storage_gb_per_seat: number
  minimum_storage_gb: number
  api_calls_per_seat: number
  storage_block_price_cents: number
  api_block_price_cents: number
  api_block_size: number
  polar_product_id?: string
  api_meter_id?: string
  storage_meter_id?: string
  created_at: string
  archived: boolean
}

/* What an admin's Billing page shows of the organization's subscription
 * and its people (billing.details), live: the plan, status, the payment
 * actions available, the last export, any pending deletion and the
 * counters of the roster, from one walk of the organization's profiles
 * (lib/billableUsers.ts rosterCounts). It names nobody. The names of who
 * counts toward the bill and who does not come from billing.accountList,
 * 25 at a time, only while a list is open. */
export type BillingDetails = {
  enabled: boolean
  configured: boolean
  plan: BillingPlan | null
  plan_assigned: boolean
  can_assign_plan: boolean
  can_grant_complimentary: boolean
  status:
    | 'unconfigured'
    | 'pending'
    | 'complimentary'
    | 'active'
    | 'trialing'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused'
  writable: boolean
  active_users: number
  inactive_users: number
  invited_users_with_own_billing: number
  billable_users: number
  billed_seats: number
  next_seats: number
  next_seat_amount_cents: number
  current_period_start: string | null
  current_period_end: string | null
  complimentary_until: string | null
  cancel_at_period_end: boolean
  checkout_available: boolean
  portal_available: boolean
  // An admin can stop a renewing subscription from the Billing page. It
  // ends when the paid period does.
  cancel_available: boolean
  // When an organization that never completed checkout is deleted.
  checkout_due_at: string | null
  last_export_at: string | null
  // Present while the organization is read-only before its deletion.
  deletion: { reason: OrgRemovalReason; delete_after: string } | null
  sync_pending: boolean
  sync_error: string | null
}

/* The usage bucket Billing shows and what it has recorded, without its
 * calls. `period_kind` says which bucket it is: `paid` is the live
 * provider period, `pending` the interval after it while a renewal is
 * unconfirmed (no end yet), and `month` a UTC calendar month, used
 * whenever there is no live paid period. Month dates are UTC days; the end
 * is the month's last day. `period_key` is the bucket's stored key
 * (model/billingUsage.ts usagePeriod), which API calls by account reads
 * and View credentials hands to API access. Allowances are null when no
 * plan exists. */
export type BillingPeriodHead = {
  period_kind: 'paid' | 'pending' | 'month'
  period_key: string
  period_start: string
  period_end: string | null
  included_calls: number | null
  included_storage_bytes: number | null
  api_overage_cents: number
  storage_overage_cents: number
  waived: boolean
  delivery_unconfirmed: boolean
}

/* Billing's usage figures (billing.usageFigures), read once on opening and
 * on each Refresh. `calls` is the bucket's calls from its aggregates
 * (model/billingUsage.ts periodCalls), the figure API access shows, or
 * null while they are not complete, which the page shows as being counted
 * and never as 0. `storage_bytes` is current storage, the organization's
 * stored-byte totals (model/storageTotals.ts), files in Deleted items
 * included until they are deleted for good, or null while the totals are
 * not complete, which the page shows as being counted too.
 * `storage_basis` says how a paid period's storage is charged, `start` on
 * the sample at its start, `daily` on the average of its daily samples
 * (convex/billingSync.ts finalizeStorage), and null for any other bucket
 * and a paid period without a row. An answer from a backend before this
 * field reads as `start`.
 * `sampled_storage_bytes` is what a period's sample at its start measured,
 * which its storage charge uses. It is the totals when the sample read
 * them, files in Deleted items included, or null for any other bucket, a
 * daily period, and a period whose sample has not finished.
 * `sampled_storage_at` is when the sample read them, normally within a
 * second of the period's start. A sample that waited, as while the totals
 * were counted again, or that was started again later measures storage
 * when it runs, files stored during the wait included. It is null without
 * a sample and for one an earlier release finished, which scanned the
 * attachment rows of live tasks stored before the period began and left
 * the files in Deleted items out.
 * `storage_average` is a daily period's, null for any other. It is `final`
 * once the period is recorded, with the average its charge uses, or null
 * for a period recorded without any storage measurement, which has no
 * storage charge; before that, the average so far over its days up to
 * today, null until one resolves. `days` is the period's days, `measured` those with
 * their own sample, `estimated` those that copied another day's sample,
 * of them `estimated_earlier` an earlier day's at the cutoff, the others
 * the next measured day's. While the period is open a day with no later
 * sample yet is in none of them and not in the average, never 0.
 * The answer holds no account; billing.apiAccounts lists the bucket's
 * accounts 25 at a time. */
export type BillingUsageFigures = BillingPeriodHead & {
  calls: number | null
  storage_bytes: number | null
  storage_basis: 'start' | 'daily' | null
  sampled_storage_bytes: number | null
  sampled_storage_at: string | null
  storage_average: {
    bytes: number | null
    days: number
    measured: number
    estimated: number
    estimated_earlier: number
    final: boolean
  } | null
}

/* One project of Billing's Storage by project list
 * (billing.storageProjects), always a sub-project, since tasks live in one.
 * `num` is the project's number as its totals row holds it, null when the
 * backfill found no copy of the project, so the project id and the number
 * name one row. `key` is the project's key from the live project or the
 * copy Deleted items stores, null for a removed one, and `name` is null
 * when no copy of its name is left. `status` says where the project is
 * now: active, archived, in Deleted items, or removed for good while files
 * of its tasks still count, such as a subtask a task item keeps in Deleted
 * items. */
export type StorageProjectRow = {
  project_id: string
  num: number | null
  key: string | null
  name: string | null
  status: 'active' | 'archived' | 'deleted' | 'removed'
  bytes: number
  files: number
}

/* One batch of Storage by project: `counting` while the organization's
 * totals are not complete, else its rows largest first, the cursor of the
 * next batch (null at the end) and whether the read share stopped the
 * batch before it was full (lib/namedPages.ts ListBatch). */
export type StorageProjects =
  | { state: 'counting' }
  | { state: 'ready'; rows: StorageProjectRow[]; next: string | null; stopped: boolean }

/* One account of Billing's API calls by account (billing.apiAccounts): its
 * calls in the bucket over all its credentials, and its name, or "Removed
 * user" with `removed` when its profile is gone or belongs to another
 * organization. */
export type ApiAccountRow = { profile_id: string; name: string; removed: boolean; calls: number }

/* One batch of API calls by account: `counting` while the bucket's usage
 * rows are not all ranked, so its account rows would leave calls out, else
 * its accounts with calls, most calls first, the cursor of the next batch
 * (null at the end) and whether the read share stopped the batch before it
 * was full (lib/namedPages.ts ListBatch). */
export type ApiAccounts =
  | { state: 'counting' }
  | { state: 'ready'; rows: ApiAccountRow[]; next: string | null; stopped: boolean }

/* One name of Billing's Who counts toward your bill or Who does not count
 * toward your bill (billing.accountList): a profile of the organization,
 * its id and its name only. */
export type AccountNameRow = { profile_id: string; name: string }

/* One batch of an account name list: `not_ready` while the organization's
 * profiles do not all hold their name keys (model/nameKeys.ts
 * nameKeysReady), else its names in name order, the cursor of the next
 * batch (null at the end) and whether the read share stopped the batch
 * before it was full. */
export type AccountNames =
  | { state: 'not_ready' }
  | { state: 'ready'; rows: AccountNameRow[]; next: string | null; stopped: boolean }
