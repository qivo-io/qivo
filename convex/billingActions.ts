import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, internalQuery } from './_generated/server'
import { getBillableUsers } from './lib/billableUsers'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { billingPlanFields } from './lib/billingTypes'
import { byId } from './lib/db'
import { badRequest, notFound, orgAction, platformAction, require, rule } from './lib/functions'
import {
  createPolarCheckout,
  createPolarPortal,
  getPolarCheckout,
  listPolarSubscriptions,
  polarConfigured,
  validatePolarProduct,
} from './lib/polar'
import { enrollOrganization, isoNow, validatePlan } from './model/billing'
import { newUuid } from './model/orgs'

type PlanInput = Omit<
  Doc<'billing_plans'>,
  '_id' | '_creationTime' | 'id' | 'archived' | 'created_at'
>
const planRef = makeFunctionReference<'query', { plan_id: string }, Doc<'billing_plans'>>(
  'billingActions:planForOperator',
)
const insertRef = makeFunctionReference<
  'mutation',
  { plan: PlanInput; actor: string; email: string },
  string
>('adminBilling:insertPlan')
const connectRef = makeFunctionReference<
  'mutation',
  {
    plan_id: string
    polar_product_id: string
    api_meter_id: string
    storage_meter_id: string
    actor: string
    email: string
  },
  null
>('adminBilling:connectPlan')

export const planForOperator = internalQuery({
  args: { plan_id: v.string() },
  handler: async (ctx, { plan_id }) => {
    const plan = await byId(ctx, 'billing_plans', plan_id)
    require(plan, notFound('plan not found'))
    return plan
  },
})

async function validateProduct(plan: PlanInput) {
  validatePlan(plan)
  if (!plan.polar_product_id) return
  require(plan.api_meter_id && plan.storage_meter_id, badRequest('Configure both overage meters.'))
  await validatePolarProduct(plan.polar_product_id, {
    unitAmount: plan.seat_price_cents,
    currency: plan.currency,
    minimumSeats: plan.minimum_seats,
    meters: [
      {
        id: plan.api_meter_id,
        unitAmount: plan.api_block_price_cents,
        eventName: 'qivo_api_overage',
      },
      {
        id: plan.storage_meter_id,
        unitAmount: plan.storage_block_price_cents,
        eventName: 'qivo_storage_overage',
      },
    ],
  })
}

export const createPlan = platformAction({
  args: { plan: v.object(billingPlanFields) },
  handler: async (ctx, { plan }): Promise<string> => {
    await validateProduct(plan)
    return await ctx.runMutation(insertRef, {
      plan,
      actor: ctx.operator.auth_user_id,
      email: ctx.operator.email,
    })
  },
})

export const connectPlan = platformAction({
  args: {
    plan_id: v.string(),
    polar_product_id: v.string(),
    api_meter_id: v.string(),
    storage_meter_id: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const plan = await ctx.runQuery(planRef, { plan_id: args.plan_id })
    require(!plan.polar_product_id, rule('This plan is already connected.'))
    await validateProduct({ ...plan, ...args })
    return await ctx.runMutation(connectRef, {
      ...args,
      actor: ctx.operator.auth_user_id,
      email: ctx.operator.email,
    })
  },
})

type Reservation = {
  token: string
  plan: Doc<'billing_plans'>
  seats: number
  url?: string
  checkout_id?: string
}
const reserveRef = makeFunctionReference<'mutation', { org_id: string }, Reservation>(
  'billingActions:reserveCheckout',
)
const finishRef = makeFunctionReference<
  'mutation',
  { org_id: string; token: string; checkout_id?: string; url?: string; expires_at?: string },
  null
>('billingActions:finishCheckout')
const clearEndedRef = makeFunctionReference<
  'mutation',
  { org_id: string; checkout_id: string },
  null
>('billingActions:clearEndedCheckout')

export const reserveCheckout = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<Reservation> => {
    require(billingEnabled() && polarConfigured(), rule('Billing is not available yet.'))
    const sub = await enrollOrganization(ctx, org_id)
    require(sub, rule('No billing plan has been configured.'))
    const plan = await byId(ctx, 'billing_plans', sub.plan_id)
    require(plan?.polar_product_id, rule('This plan is not connected to checkout yet.'))
    const now = isoNow()
    require(!sub.complimentary_until || sub.complimentary_until <= now, rule(
      'Your free access is still active. Subscribe when it ends.',
    ))
    require(!sub.polar_subscription_id || sub.status === 'canceled', rule(
      'This organization already has a subscription. Use Manage billing.',
    ))
    const seats = Math.max(plan.minimum_seats, (await getBillableUsers(ctx, org_id)).total)
    require(seats <= 1000, rule('Online billing supports up to 1,000 active billable users.'))
    if (
      sub.checkout_id &&
      sub.checkout_url &&
      sub.checkout_expires_at &&
      sub.checkout_expires_at > now
    )
      return { token: '', plan, seats, url: sub.checkout_url, checkout_id: sub.checkout_id }
    require(!sub.checkout_lock_until || sub.checkout_lock_until <= now, rule(
      'Checkout is being prepared. Try again in a moment.',
    ))
    const token = newUuid()
    await ctx.db.patch(sub._id, {
      checkout_lock: token,
      checkout_lock_until: new Date(Date.now() + 60_000).toISOString(),
    })
    return { token, plan, seats }
  },
})

export const finishCheckout = internalMutation({
  args: {
    org_id: v.string(),
    token: v.string(),
    checkout_id: v.optional(v.string()),
    url: v.optional(v.string()),
    expires_at: v.optional(v.string()),
  },
  handler: async (ctx, { org_id, token, checkout_id, url, expires_at }) => {
    const sub = await subscriptionFor(ctx, org_id)
    require(sub?.checkout_lock === token, rule('Checkout preparation expired. Try again.'))
    await ctx.db.patch(sub._id, {
      checkout_lock: undefined,
      checkout_lock_until: undefined,
      ...(checkout_id && url && expires_at
        ? {
            checkout_id,
            checkout_url: url,
            checkout_expires_at: expires_at,
          }
        : {}),
    })
    return null
  },
})

// The action calls this only after fetching an expired/failed session from
// Polar. Compare the ID so a stale action cannot clear a newer checkout.
export const clearEndedCheckout = internalMutation({
  args: { org_id: v.string(), checkout_id: v.string() },
  handler: async (ctx, { org_id, checkout_id }) => {
    const sub = await subscriptionFor(ctx, org_id)
    if (sub?.checkout_id !== checkout_id) return null
    await ctx.db.patch(sub._id, {
      checkout_id: undefined,
      checkout_url: undefined,
      checkout_expires_at: undefined,
    })
    return null
  },
})

function billingUrl(slug: string): string {
  const base = process.env.SITE_URL
  if (!base) throw rule('Billing is not configured.')
  const url = new URL(base)
  if (
    url.origin !== base.replace(/\/$/, '') ||
    (!base.startsWith('https://') && !base.startsWith('http://localhost:'))
  )
    throw badRequest('Invalid billing return origin.')
  return `${url.origin}/app/${encodeURIComponent(slug)}/settings/org-billing`
}

export const checkout = orgAction({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    let reservation = await ctx.runMutation(reserveRef, { org_id: ctx.orgId })
    if (reservation.checkout_id) {
      const session = await getPolarCheckout(reservation.checkout_id)
      require(session.externalCustomerId === ctx.orgId &&
        session.productId === reservation.plan.polar_product_id, badRequest(
        'Checkout ownership mismatch.',
      ))
      if (session.status === 'expired' || session.status === 'failed') {
        await ctx.runMutation(clearEndedRef, { org_id: ctx.orgId, checkout_id: session.id })
        reservation = await ctx.runMutation(reserveRef, { org_id: ctx.orgId })
        require(!reservation.checkout_id, rule(
          'Checkout is being prepared. Try again in a moment.',
        ))
      } else {
        require(session.status === 'open' && session.expiresAt > Date.now(), rule(
          'Checkout is already processing or has ended. Refresh Billing in a moment.',
        ))
        require(session.seats === reservation.seats, rule(
          'The organization user count changed after checkout opened. Let this checkout expire, then subscribe again.',
        ))
        return { url: session.url }
      }
    }
    try {
      // Recover a successful checkout whose webhook was delayed before allowing
      // another purchase. The external customer ID is the authenticated org UUID.
      const existing = await listPolarSubscriptions(ctx.orgId)
      require(!existing.some((s) =>
        ['active', 'trialing', 'past_due', 'incomplete', 'paused', 'unpaid'].includes(s.status),
      ), rule(
        'This organization already has a subscription. Refresh Billing or use Manage billing.',
      ))
      await validateProduct(reservation.plan)
      require(reservation.plan.polar_product_id, rule(
        'This plan is not connected to checkout yet.',
      ))
      const url = billingUrl(ctx.org_slug)
      const session = await createPolarCheckout({
        externalCustomerId: ctx.orgId,
        customerEmail: ctx.email || undefined,
        customerName: ctx.org_name,
        productId: reservation.plan.polar_product_id,
        seats: reservation.seats,
        successUrl: `${url}?checkout=complete`,
        returnUrl: url,
      })
      await ctx.runMutation(finishRef, {
        org_id: ctx.orgId,
        token: reservation.token,
        checkout_id: session.id,
        url: session.url,
        expires_at: new Date(session.expiresAt).toISOString(),
      })
      return { url: session.url }
    } catch (error) {
      await ctx
        .runMutation(finishRef, { org_id: ctx.orgId, token: reservation.token })
        .catch(() => {})
      throw error
    }
  },
})

export const portal = orgAction({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    require(billingEnabled() && polarConfigured(), rule('Billing is not available yet.'))
    return await createPolarPortal({
      externalCustomerId: ctx.orgId,
      returnUrl: billingUrl(ctx.org_slug),
    })
  },
})
