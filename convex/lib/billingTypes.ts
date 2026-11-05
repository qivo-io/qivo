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

export type BillingSummary = {
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
  billable_accounts: { profile_id: string; name: string; reason: 'member' | 'guest_without_home' }[]
  non_billable_accounts: {
    profile_id: string
    name: string
    reason: 'inactive' | 'guest_with_home'
  }[]
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

/* `period_kind` says which usage bucket Billing shows: `paid` is the live
 * provider period, `pending` the interval after it while a renewal is
 * unconfirmed (no end yet), and `month` a UTC calendar month, used whenever
 * there is no live paid period. Month dates are UTC days; the end is the
 * month's last day. `period_key` is the bucket's stored key
 * (model/billingUsage.ts usagePeriod), which View credentials hands to API
 * access. Allowances are null when no plan exists. These are the fields
 * both of Billing's usage answers hold besides storage. */
export type BillingUsageHead = {
  period_kind: 'paid' | 'pending' | 'month'
  period_key: string
  period_start: string
  period_end: string | null
  calls: number
  included_calls: number | null
  included_storage_bytes: number | null
  api_overage_cents: number
  storage_overage_cents: number
  waived: boolean
  delivery_unconfirmed: boolean
  users: { profile_id: string; name: string; calls: number }[]
}

/* Billing's usage (billing.currentUsage) with its two storage figures,
 * which differ. `storage_bytes` is current storage, the organization's
 * stored-byte totals (model/storageTotals.ts), files in Deleted items
 * included until they are deleted for good, or null while the totals are
 * not complete, which the page shows as being counted and never as 0.
 * `sampled_storage_bytes` is what a paid period's sample measured at its
 * start, which the period's storage charge uses and which leaves files in
 * Deleted items out, or null for any other bucket and for a period whose
 * sample has not finished. */
export type BillingUsage = BillingUsageHead & {
  storage_bytes: number | null
  sampled_storage_bytes: number | null
}

/* The answer of the legacy billing.usageReport, which tabs loaded before
 * billing.currentUsage shipped still read: storage from a scan of the
 * attachment rows of live tasks, files in Deleted items left out, with the
 * whole project breakdown, largest first. */
export type BillingUsageReport = BillingUsageHead & {
  storage_bytes: number
  projects: { project_id: string; name: string; storage_bytes: number }[]
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
