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

/* `period_kind` says which usage bucket the report shows: `paid` is the live
 * provider period, `pending` the interval after it while a renewal is
 * unconfirmed (no end yet), and `month` a UTC calendar month, used whenever
 * there is no live paid period. Month dates are UTC days; the end is the
 * month's last day. Allowances are null when no plan exists. */
export type BillingUsage = {
  period_kind: 'paid' | 'pending' | 'month'
  period_start: string
  period_end: string | null
  calls: number
  included_calls: number | null
  storage_bytes: number
  included_storage_bytes: number | null
  api_overage_cents: number
  storage_overage_cents: number
  waived: boolean
  delivery_unconfirmed: boolean
  users: {
    profile_id: string
    name: string
    calls: number
    keys: { id: string; name: string; calls: number }[]
  }[]
  projects: { project_id: string; name: string; storage_bytes: number }[]
}
