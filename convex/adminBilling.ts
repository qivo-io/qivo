import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { addCalendarMonths, subscriptionFor } from './lib/billingAccess'
import { billingPlanFields } from './lib/billingTypes'
import { byId } from './lib/db'
import {
  badRequest,
  notFound,
  platformMutation,
  platformQuery,
  require,
  rule,
} from './lib/functions'
import { audit } from './model/admin'
import {
  billingSummary,
  defaultPlan,
  enrollOrganization,
  hasPendingCheckout,
  isoNow,
  planRow,
  validatePlan,
} from './model/billing'
import { newUuid } from './model/orgs'

export const listPlans = platformQuery({
  args: {},
  handler: async (ctx) => ({
    plans: (await ctx.db.query('billing_plans').collect()).map(planRow),
    default_plan_id: (await defaultPlan(ctx))?.id ?? null,
  }),
})

export const orgBilling = platformQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }) => await billingSummary(ctx, org_id),
})

// Called only after the platform action validates the provider's actual terms.
export const insertPlan = internalMutation({
  args: { plan: v.object(billingPlanFields), actor: v.string(), email: v.string() },
  handler: async (ctx, { plan, actor, email }) => {
    validatePlan(plan)
    const id = newUuid()
    await ctx.db.insert('billing_plans', {
      id,
      ...plan,
      name: plan.name.trim(),
      archived: false,
      created_at: isoNow(),
    })
    await audit(ctx, {
      actor_auth_id: actor,
      actor_email: email,
      action: 'billing.create_plan',
      detail: { plan_id: id, name: plan.name },
    })
    return id
  },
})

export const connectPlan = internalMutation({
  args: {
    plan_id: v.string(),
    polar_product_id: v.string(),
    api_meter_id: v.string(),
    storage_meter_id: v.string(),
    actor: v.string(),
    email: v.string(),
  },
  handler: async (ctx, { plan_id, actor, email, ...ids }) => {
    const plan = await byId(ctx, 'billing_plans', plan_id)
    require(plan && !plan.archived, notFound('plan not found'))
    require(!plan.polar_product_id, rule(
      'This plan is already connected. Create a new plan version to change its product.',
    ))
    await ctx.db.patch(plan._id, ids)
    await audit(ctx, {
      actor_auth_id: actor,
      actor_email: email,
      action: 'billing.connect_plan',
      detail: { plan_id, ...ids },
    })
    return null
  },
})

export const setDefaultPlan = platformMutation({
  args: { plan_id: v.string() },
  handler: async (ctx, { plan_id }) => {
    const plan = await byId(ctx, 'billing_plans', plan_id)
    require(plan && !plan.archived, notFound('plan not found'))
    const settings = await ctx.db
      .query('billing_settings')
      .withIndex('by_key', (q) => q.eq('key', 'default'))
      .unique()
    if (settings) await ctx.db.patch(settings._id, { default_plan_id: plan_id })
    else await ctx.db.insert('billing_settings', { key: 'default', default_plan_id: plan_id })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: 'operator',
      action: 'billing.set_default_plan',
      detail: { plan_id },
    })
    return null
  },
})

export const assignPlan = platformMutation({
  args: { org_id: v.string(), plan_id: v.string() },
  handler: async (ctx, { org_id, plan_id }) => {
    require(await byId(ctx, 'organizations', org_id), notFound('organization not found'))
    const plan = await byId(ctx, 'billing_plans', plan_id)
    require(plan && !plan.archived, notFound('plan not found'))
    const sub = await subscriptionFor(ctx, org_id)
    require(!sub?.polar_subscription_id && !hasPendingCheckout(sub), rule(
      'An existing checkout or subscription keeps its assigned plan.',
    ))
    if (sub)
      await ctx.db.patch(sub._id, {
        plan_id,
        updated_at: isoNow(),
        checkout_id: undefined,
        checkout_url: undefined,
        checkout_expires_at: undefined,
        checkout_lock: undefined,
        checkout_lock_until: undefined,
      })
    else await enrollOrganization(ctx, org_id, plan_id)
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: 'operator',
      action: 'billing.assign_plan',
      target_org_id: org_id,
      detail: { plan_id, previous_plan_id: sub?.plan_id ?? null },
    })
    return null
  },
})

export const grantComplimentary = platformMutation({
  args: { org_id: v.string(), months: v.number() },
  handler: async (ctx, { org_id, months }) => {
    if (!Number.isInteger(months) || months < 1 || months > 24)
      throw badRequest('Choose 1–24 calendar months.')
    require(await byId(ctx, 'organizations', org_id), notFound('organization not found'))
    const sub = await enrollOrganization(ctx, org_id)
    require(sub, rule('Create and select a default billing plan first.'))
    require(!sub.polar_subscription_id && !hasPendingCheckout(sub), rule(
      'Complimentary access must be granted before checkout. Manage an existing paid promotion in Polar.',
    ))
    const now = isoNow()
    const from =
      sub.complimentary_until && sub.complimentary_until > now ? sub.complimentary_until : now
    const until = addCalendarMonths(from, months)
    await ctx.db.patch(sub._id, {
      complimentary_start: sub.complimentary_start ?? now,
      complimentary_until: until,
      updated_at: now,
      checkout_id: undefined,
      checkout_url: undefined,
      checkout_expires_at: undefined,
      checkout_lock: undefined,
      checkout_lock_until: undefined,
    })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: 'operator',
      action: 'billing.grant_complimentary',
      target_org_id: org_id,
      detail: { months, until, plan_id: sub.plan_id },
    })
    return null
  },
})
