import { makeFunctionReference } from 'convex/server'
import { streamIndexRange } from 'convex-helpers/server/stream'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import schema from '../schema'
import { subscriptionFor } from './billingAccess'
import { isDemoDeployment } from './demo'
import type { OrgRole, ProfileKind } from './enums'
import type { ReadGuard } from './namedPages'

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

/** Where one profile stands for the organization's bill:
 * - `member`, an active admin, standard user or Viewer, person or agent,
 *   claimed or an invitation, who counts;
 * - `guest_without_home`, an active guest whose email has no active home
 *   membership in any organization, who counts;
 * - `guest_with_home`, an active guest billed where that home membership
 *   is, who does not count here;
 * - `inactive`, a profile an admin deactivated, whatever its role, who
 *   does not count.
 * The four partition an organization's roster, since every role is one of
 * admin, user, viewer and guest. */
export type BillingStanding = 'member' | 'guest_without_home' | 'guest_with_home' | 'inactive'

/** The standings that count toward the bill. */
export const BILLABLE_STANDINGS: readonly BillingStanding[] = ['member', 'guest_without_home']

/** Where `profile` stands for its organization's bill (BillingStanding),
 * the one rule getBillableUsers, rosterCounts and Billing's name lists
 * (model/billingLists.ts) decide by, so the counters and the lists never
 * disagree. Active is the administrator-controlled switch, not recent login
 * activity, and an inactive guest is inactive whatever its home. A guest's
 * home check walks the profiles of its email across organizations
 * (profiles.by_email) until it finds an active home role; claim state and
 * subscription payment state do not change the rule, and all profile write
 * paths normalize stored emails. With `guard`, a name list's read guard
 * (lib/namedPages.ts), it counts that walk's index range and every profile
 * it reads, and always finishes the walk, so the standing is never a
 * guess and the list stops after the row once its share is spent. Nothing
 * of another organization's profile leaves this function. */
export async function billingStanding(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  guard?: ReadGuard,
): Promise<BillingStanding> {
  if (!profile.active) return 'inactive'
  switch (profile.org_role) {
    case 'admin':
    case 'user':
    case 'viewer':
      return 'member'
    case 'guest': {
      if (profile.email === undefined) return 'guest_without_home'
      const email = profile.email.toLowerCase()
      await guard?.range()
      const matches = ctx.db.query('profiles').withIndex('by_email', (q) => q.eq('email', email))
      for await (const match of matches) {
        await guard?.document(match)
        if (match.active && hasHomeRole(match)) return 'guest_with_home'
      }
      return 'guest_without_home'
    }
  }
}

/** The people and agents of organization `orgId` who count toward its
 * bill (billingStanding `member` or `guest_without_home`), in profile id
 * order, with the total and the member and guest counts.
 *
 * Organization deletion also clears `active` on a home profile whose
 * guest organizations it marks over several steps (markHomeProfileRemoved),
 * while the profile waits to be deleted. Invitations count immediately. A
 * guest is exempt only while the same email has an active home membership
 * (billingStanding). Callers must enforce billing access. Only the
 * requested org's identities leave this helper; foreign membership details
 * never enter the breakdown. It reads every profile of the organization, the
 * seat count's whole-roster read that enrollment, checkout, reconciliation
 * and a period's profile_ids need. */
export async function getBillableUsers(ctx: QueryCtx, orgId: string): Promise<BillableUsers> {
  const users: BillableUser[] = []
  let members = 0
  let guests = 0
  const profiles = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const profile of profiles) {
    const standing = await billingStanding(ctx, profile)
    if (standing === 'member') members += 1
    else if (standing === 'guest_without_home') guests += 1
    else continue
    users.push({
      profile_id: profile.id,
      name: profile.name,
      kind: profile.kind,
      org_role: profile.org_role,
      reason: standing,
    })
  }
  users.sort((a, b) => a.profile_id.localeCompare(b.profile_id))
  return { total: users.length, members, guests, users }
}

/** The counters of Billing's Users section: who counts toward the bill,
 * the active profiles, the inactive ones and the active guests billed in
 * their home organization. */
export type RosterCounts = {
  billable: number
  active: number
  inactive: number
  ownBilling: number
}

/** The counters Billing's Users section shows, from one walk of the
 * organization's profiles, each classified by billingStanding: the people
 * and agents who count toward the bill (`billable`, getBillableUsers'
 * total), the active ones whatever their standing (`active`), the
 * inactive ones and the active guests billed in their home organization
 * (`ownBilling`). It answers numbers only. At the design size it reads up
 * to 1,000 profiles, and each active guest's home check reads the
 * profiles of its email. */
export async function rosterCounts(ctx: QueryCtx, orgId: string): Promise<RosterCounts> {
  const counts = { billable: 0, active: 0, inactive: 0, ownBilling: 0 }
  const profiles = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const profile of profiles) {
    if (profile.active) counts.active += 1
    const standing = await billingStanding(ctx, profile)
    if (standing === 'inactive') counts.inactive += 1
    else if (standing === 'guest_with_home') counts.ownBilling += 1
    else counts.billable += 1
  }
  return counts
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

/** Where a step stopped in the profiles of a home profile's email: the
 * index key of the last profile it read, its _creationTime and _id. A
 * position stored before the _id was kept has none and stands for every
 * profile of that _creationTime, which the step then read in full. */
export type MarkingPosition = { through: number; through_id?: Id<'profiles'> }

/** Organization deletion removes profiles without the membership mutations
 * that call markBillingMembershipChanged. A deleted active home profile can
 * make the same email's guest profiles billable elsewhere
 * (getBillableUsers), so this marks those organizations due before the
 * profile goes, once per organization in `asked`, and the next minute's
 * sweep reconciles them. It schedules nothing itself, so a step that
 * deletes many such profiles stays within Convex's limits.
 *
 * It reads the email's profiles in index order, after `after` when given,
 * and counts each profile it reads and each organization it marks as one
 * row of `budget`, the deletion step's. It answers null once it has read
 * them all, or, when the budget ran out, the position of the last profile
 * it read, after which the next step goes on. Profiles that share a
 * _creationTime, as an import can leave, are told apart by their _id, so
 * a step stops inside such a group as anywhere else. Whatever the group's
 * size, one step reads at most one more of the email's profiles than its
 * budget has rows left (REMOVAL_BUDGET, 256 rows a step), in at most two
 * index ranges, and marks at most half as many organizations, each with one
 * read of its subscription and at most one write. When it stops early it also
 * ends the profile's exemption (active false) in the same transaction: a
 * reconciliation between the steps would otherwise still find the home
 * profile, count the guests of the organizations already marked as exempt
 * and use up their marks, and the next renewal would bill too few seats. A
 * step that goes on (`after` given) therefore reads a profile that is no
 * longer active. */
export async function markHomeProfileRemoved(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  asked: Set<string>,
  budget: { rows: number },
  after?: MarkingPosition,
): Promise<Required<MarkingPosition> | null> {
  if (isDemoDeployment() || !process.env.POLAR_ACCESS_TOKEN) return null
  if (!hasHomeRole(profile) || profile.email === undefined) return null
  if (after === undefined && !profile.active) return null
  const email = profile.email.toLowerCase()
  const now = new Date().toISOString()
  const matches =
    after === undefined
      ? ctx.db.query('profiles').withIndex('by_email', (q) => q.eq('email', email))
      : streamIndexRange(
          ctx.db,
          schema,
          'profiles',
          'by_email',
          {
            lowerBound:
              after.through_id === undefined
                ? [email, after.through]
                : [email, after.through, after.through_id],
            lowerBoundInclusive: false,
            upperBound: [email],
            upperBoundInclusive: true,
          },
          'asc',
        )
  // the last profile read, where the next step goes on
  let last: Required<MarkingPosition> | undefined
  for await (const match of matches) {
    if (last !== undefined && budget.rows <= 0) {
      if (profile.active) await ctx.db.patch(profile._id, { active: false })
      return last
    }
    budget.rows -= 1
    if (match.org_id !== profile.org_id && match.org_role === 'guest' && !asked.has(match.org_id)) {
      asked.add(match.org_id)
      budget.rows -= 1
      await billingDueBy(ctx, match.org_id, now)
    }
    last = { through: match._creationTime, through_id: match._id }
  }
  return null
}
