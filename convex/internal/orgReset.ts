/* The one-time reset of a deployment's organizations (owner, 18 November
 * 2026): on development and staging every organization but Northstar Labs
 * is deleted and Northstar Labs is reset from the seed, and on production
 * every organization is deleted. docs/deployment.md, the release after
 * v0.1.168, has the commands. A later release removes both functions.
 *
 * `orgs` lists the organizations a page at a time, with what an operator
 * needs to choose: the organization's id, name, address and creation time,
 * how many people, projects and tasks it holds, whether it is the Northstar
 * fixture's (its marketing_demo receipt), its deletion if one is pending or
 * running, and its billing state. It answers no email address and no other
 * personal data, and writes nothing.
 *
 * `deleteOrg` deletes one organization now through the organization
 * deletion an admin's request starts (orgRemovals.ts, model/orgDeletion.ts):
 * it records the removal as requested and due now, without the read-only
 * period and the admins' email that a request queues, and begins it
 * (orgRemovals.ts beginDeletion). The existing steps delete everything the
 * organization owns, and `recover` restarts one that stalls. `confirm` must
 * be the organization's address, as an admin's request asks. It refuses an
 * unknown organization, a wrong address, the fixture's organization unless
 * `allow_fixture` is true, and while billing runs an organization whose
 * stored Polar subscription bills or can still bill, a pending one included,
 * or that holds an open checkout; it cancels nothing, so an operator ends
 * such a subscription in Polar first.
 * Billing is read from Qivo's own record, which Polar's webhooks keep, as a
 * mutation cannot ask Polar. For an organization being deleted it answers
 * that the deletion runs. It writes the audit row an admin's request
 * writes, with an operator's deploy-key run as its actor. Internal only, so
 * only a deploy key can call either function. */
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server'
import { billingEnabled, orgRemovalFor, subscriptionFor } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { notFound, require, rule } from '../lib/functions'
import { audit } from '../model/admin'
import { hasPendingCheckout } from '../model/billing'
import { countersRow } from '../model/orgs'
import { beginDeletion } from '../orgRemovals'

/** The organizations one page lists, and how many of an organization's
 * people, and of its projects and tasks where no stored count holds them,
 * a page reads at most before it answers the count as capped. People are
 * read up to the design size's 1,000. Tests lower them. */
export const ORG_RESET = { page: 5, people: 1000, projects: 500, tasks: 500 }

/** The actor of the audit row a deploy-key deletion writes. */
export const RESET_ACTOR = 'operator (deploy key)'

/** A count a page answers: `capped` when there are more than `count`. */
type Count = { count: number; capped: boolean }

/** One organization as `orgs` lists it. */
export type OrgRow = {
  id: string
  name: string
  slug: string
  created_at: string
  /** profiles, agents and inactive ones included */
  people: Count
  /** projects and sub-projects in the live tables, archived ones included */
  projects: Count
  /** active tasks, from the stored count when it holds them, else read */
  active_tasks: Count
  fixture: boolean
  deletion: { reason: string; phase: string | null; delete_after: string } | null
  billing: { enabled: boolean; live_subscription: boolean; open_checkout: boolean }
}

/* The stored statuses of a subscription that bills or can still bill.
 * billingSync.ts stores Polar's live statuses (lib/polar.ts
 * LIVE_POLAR_STATUSES) as they are, except `incomplete`, which it stores as
 * `pending`, as it stores `incomplete_expired`. A stored `pending` cannot
 * tell the two apart, so it counts as live. Of the stored statuses
 * (lib/billingTypes.ts vBillingStatus) only `canceled` is left out. */
const BILLABLE_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'paused',
  'unpaid',
  'pending',
] as const satisfies readonly Doc<'billing_subscriptions'>['status'][]

/* Whether the stored subscription is a Polar subscription that bills or can
 * still bill: it has a provider id, a status of BILLABLE_STATUSES and has
 * not ended. Fails closed, so a deletion never starts under one. */
const billable = (sub: Doc<'billing_subscriptions'> | null, now = Date.now()): boolean =>
  !!sub?.polar_subscription_id &&
  BILLABLE_STATUSES.some((status) => status === sub.status) &&
  !(sub.ended_at && Date.parse(sub.ended_at) <= now)

/* At most `cap` + 1 rows of a range, answered as a Count. */
async function counted(rows: Promise<unknown[]>, cap: number): Promise<Count> {
  const got = (await rows).length
  return { count: Math.min(got, cap), capped: got > cap }
}

/* The organization ids the Northstar fixture's receipts name. The table
 * holds one row per fixture key. */
const fixtureOrgs = async (ctx: QueryCtx): Promise<Set<string>> =>
  new Set((await ctx.db.query('marketing_demo').collect()).map((r) => r.org_id))

/** `org` as `orgs` lists it. */
async function rowOf(ctx: QueryCtx, org: Doc<'organizations'>, fixtures: Set<string>) {
  const counters = await countersRow(ctx, org.id)
  const stored = counters !== null && counters.counted === undefined
  const removal = await orgRemovalFor(ctx, org.id)
  const sub = await subscriptionFor(ctx, org.id)
  const row: OrgRow = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    created_at: org.created_at,
    people: await counted(
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .take(ORG_RESET.people + 1),
      ORG_RESET.people,
    ),
    projects:
      stored && counters.live_projects !== undefined
        ? { count: counters.live_projects, capped: false }
        : await counted(
            ctx.db
              .query('projects')
              .withIndex('by_org', (q) => q.eq('org_id', org.id))
              .take(ORG_RESET.projects + 1),
            ORG_RESET.projects,
          ),
    active_tasks:
      stored && counters.active_tasks !== undefined
        ? { count: counters.active_tasks, capped: false }
        : await counted(
            ctx.db
              .query('issues')
              .withIndex('by_org_archived', (q) =>
                q.eq('org_id', org.id).eq('archived_at', undefined),
              )
              .take(ORG_RESET.tasks + 1),
            ORG_RESET.tasks,
          ),
    fixture: fixtures.has(org.id),
    deletion: removal
      ? { reason: removal.reason, phase: removal.phase ?? null, delete_after: removal.delete_after }
      : null,
    billing: {
      enabled: billingEnabled(),
      live_subscription: billable(sub),
      open_checkout: hasPendingCheckout(sub),
    },
  }
  return row
}

/** One page of the deployment's organizations from `cursor` on (see the
 * header), and the cursor of the next page, null after the last. */
export const orgs = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<{ orgs: OrgRow[]; cursor: string | null }> => {
    const page = await ctx.db
      .query('organizations')
      .paginate({ cursor: cursor ?? null, numItems: ORG_RESET.page })
    const fixtures = await fixtureOrgs(ctx)
    const rows: OrgRow[] = []
    for (const org of page.page) rows.push(await rowOf(ctx, org, fixtures))
    return { orgs: rows, cursor: page.isDone ? null : page.continueCursor }
  },
})

/** Deletes organization `org_id` now (see the header). Answers `started`
 * with the removal's time, or `running` with the phase of a deletion that
 * has begun. */
export const deleteOrg = internalMutation({
  args: { org_id: v.string(), confirm: v.string(), allow_fixture: v.optional(v.boolean()) },
  handler: async (
    ctx,
    a,
  ): Promise<{ state: 'started'; delete_after: string } | { state: 'running'; phase: string }> => {
    const removal = await orgRemovalFor(ctx, a.org_id)
    const org = await byId(ctx, 'organizations', a.org_id)
    // its last steps delete what the deletion recorded after the organization
    if (org === null) {
      if (removal?.phase !== undefined) return { state: 'running', phase: removal.phase }
      throw notFound('organization not found')
    }
    require(a.confirm.trim().toLowerCase() === org.slug, rule(
      "confirm must be the organization's address",
    ))
    if (removal?.phase !== undefined) return { state: 'running', phase: removal.phase }
    require(!(await fixtureOrgs(ctx)).has(org.id) || a.allow_fixture === true, rule(
      "this is the Northstar fixture's organization; pass allow_fixture: true to delete it",
    ))
    if (billingEnabled()) {
      const sub = await subscriptionFor(ctx, org.id)
      require(!billable(sub), rule(
        'this organization has a Polar subscription that bills or can still bill; end it in Polar first, nothing was changed',
      ))
      require(!hasPendingCheckout(sub), rule(
        'this organization has an open checkout; let it end or clear it first, nothing was changed',
      ))
    }
    const now = new Date().toISOString()
    if (removal === null)
      await ctx.db.insert('org_removals', {
        org_id: org.id,
        reason: 'requested',
        ended_at: now,
        delete_after: now,
        created_at: now,
      })
    else await ctx.db.patch(removal._id, { reason: 'requested', delete_after: now })
    await beginDeletion(ctx, org.id)
    await audit(ctx, {
      actor_email: RESET_ACTOR,
      action: 'org.deletion_requested',
      target_org_id: org.id,
      detail: { delete_after: now },
    })
    return { state: 'started', delete_after: now }
  },
})
