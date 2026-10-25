import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { subscriptionFor } from './billingAccess'
import { isDemoDeployment } from './demo'
import type { OrgRole, ProfileKind } from './enums'

export type BillableUser = {
  profile_id: string
  name: string
  kind: ProfileKind
  org_role: OrgRole
  reason: 'member' | 'guest_without_home'
}

export type BillableUsers = {
  total: number
  members: number
  guests: number
  users: BillableUser[]
}

// Viewers hold paid memberships too. Keep this separate from isOrgStaff,
// which grants administrative capabilities to admins and standard users.
const hasHomeRole = (profile: Doc<'profiles'>): boolean =>
  profile.org_role === 'admin' || profile.org_role === 'user' || profile.org_role === 'viewer'

/** Active is the administrator-controlled switch, not recent login activity.
 * Invitations count immediately. A guest is exempt only while the same email
 * has an active home membership; claim state and subscription payment state
 * do not change that rule. All profile write paths normalize stored emails.
 * Callers must enforce billing access. Only the requested org's identities
 * leave this helper; foreign membership details never enter the breakdown. */
export async function getBillableUsers(ctx: QueryCtx, orgId: string): Promise<BillableUsers> {
  const users: BillableUser[] = []
  let members = 0
  let guests = 0
  const profiles = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const profile of profiles) {
    if (!profile.active) continue
    let reason: BillableUser['reason']
    if (hasHomeRole(profile)) {
      reason = 'member'
      members += 1
    } else if (profile.org_role === 'guest') {
      let hasActiveHome = false
      if (profile.email !== undefined) {
        const email = profile.email.toLowerCase()
        const matches = ctx.db.query('profiles').withIndex('by_email', (q) => q.eq('email', email))
        for await (const match of matches) {
          if (match.active && hasHomeRole(match)) {
            hasActiveHome = true
            break
          }
        }
      }
      if (hasActiveHome) continue
      reason = 'guest_without_home'
      guests += 1
    } else {
      continue
    }
    users.push({
      profile_id: profile.id,
      name: profile.name,
      kind: profile.kind,
      org_role: profile.org_role,
      reason,
    })
  }
  users.sort((a, b) => a.profile_id.localeCompare(b.profile_id))
  return { total: users.length, members, guests, users }
}

const reconcileBilling = makeFunctionReference<'action', { org_id: string }, null>(
  'billingSync:reconcile',
)

/** Makes the organization's reconciliation due by `at` (billingSync.ts
 * sweep), unless a time other than the safety pass already comes sooner. */
export async function billingDueBy(ctx: MutationCtx, orgId: string, at: string): Promise<void> {
  const sub = await subscriptionFor(ctx, orgId)
  if (sub && (sub.sync_due_at === undefined || sub.sync_due_at > at || sub.sync_safety))
    await ctx.db.patch(sub._id, { sync_due_at: at, sync_safety: undefined })
}

/** Asks for the organization's reconciliation with Polar now: marks its
 * billing due (billingSync.ts sweep) and schedules the reconciliation, in
 * the caller's transaction. The scheduled run is not retried if it fails
 * before it starts, so the mark makes the next minute's sweep run it then. */
export async function requestBillingSync(ctx: MutationCtx, orgId: string): Promise<void> {
  await billingDueBy(ctx, orgId, new Date().toISOString())
  await ctx.scheduler.runAfter(0, reconcileBilling, { org_id: orgId })
}

/** A home membership change can change the bills of guest organizations too.
 * Pass both old and new email after an address change, and the old email after
 * deletion. The request commits with the membership mutation; provider calls
 * happen separately. Demo workspaces never synchronize paid subscriptions. */
export async function markBillingMembershipChanged(
  ctx: MutationCtx,
  orgId: string,
  emails: string[] = [],
): Promise<void> {
  if (isDemoDeployment() || !process.env.POLAR_ACCESS_TOKEN) return
  const orgIds = new Set([orgId])
  for (const email of new Set(emails.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
    const profiles = ctx.db.query('profiles').withIndex('by_email', (q) => q.eq('email', email))
    for await (const profile of profiles) orgIds.add(profile.org_id)
  }
  for (const id of orgIds) await requestBillingSync(ctx, id)
}

/** Organization deletion removes profiles without the membership mutations
 * that call markBillingMembershipChanged. A deleted active home profile can
 * make the same email's guest profiles billable elsewhere
 * (getBillableUsers), so this marks those organizations due before the
 * profile goes, once per organization in `asked`, and the next minute's
 * sweep reconciles them. It schedules nothing itself, so a step that
 * deletes many such profiles stays within Convex's limits.
 *
 * It reads the email's profiles in order, from the _creationTime `from`
 * when given, and counts each profile it reads and each organization it
 * marks as one row of `budget`, the deletion step's. It answers null once it
 * has read them all, or the _creationTime of the last one it read when the
 * budget ran out, from which the next step goes on. That step reads that
 * profile again, so a profile that shares its time is not skipped, and
 * marking its organization again changes nothing that is still due. */
export async function markHomeProfileRemoved(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  asked: Set<string>,
  budget: { rows: number },
  from?: number,
): Promise<number | null> {
  if (isDemoDeployment() || !process.env.POLAR_ACCESS_TOKEN) return null
  if (!profile.active || !hasHomeRole(profile) || profile.email === undefined) return null
  const email = profile.email.toLowerCase()
  const now = new Date().toISOString()
  const matches = ctx.db
    .query('profiles')
    .withIndex('by_email', (q) =>
      from === undefined ? q.eq('email', email) : q.eq('email', email).gte('_creationTime', from),
    )
  for await (const match of matches) {
    budget.rows -= 1
    if (match.org_id !== profile.org_id && match.org_role === 'guest' && !asked.has(match.org_id)) {
      asked.add(match.org_id)
      budget.rows -= 1
      await billingDueBy(ctx, match.org_id, now)
    }
    if (budget.rows <= 0) return match._creationTime
  }
  return null
}
