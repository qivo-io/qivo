/* The organization's public surface (phase 5): settings and the address.
 *
 * Narration is deliberately lopsided (0108): only a REAL slug change writes
 * an activity row — renaming the org, and every settings write, narrates
 * NOTHING (the old client logged none of them and no SQL trigger did either).
 * A same-value slug write is a silent no-op: the 0108 probe proves an
 * unchanged address must not narrate, so the handler returns before writing.
 * Billing owns the subscription independently of organization settings. */

import { v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import type { Doc } from './_generated/dataModel'
import { byId } from './lib/db'
import { vProjectCreators } from './lib/enums'
import { adminMutation, badRequest, notFound, require, rule } from './lib/functions'
import { limitedWhole } from './lib/limitRules'
import { LIMITS } from './lib/limits'
import { assertWeekStartFits } from './model/milestones'
import {
  assertOrgExpected,
  assertSlugAvailable,
  cleanOrgName,
  narrateSlugChange,
  vOrgExpected,
} from './model/orgs'

/* organizations_date_format_check (0020) / organizations_week_one_rule_check
 * (0039), member-for-member. */
const vDateFormat = literals(
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD.MM.YYYY',
  'D MMM YYYY',
  'MMM D, YYYY',
)
const vWeekOneRule = literals('jan1', 'first4day', 'firstfull')

/* ----------------------------------------------------------------- update
 * P.setOrg — organization settings folded into one patch (they had no
 * ordering interplay; each was an independent UPDATE). org_update was
 * is_org_admin (0081:108). Narrates nothing, name included. A new first day
 * of the week is checked against every milestone in this transaction
 * (model/milestones.ts assertWeekStartFits), which refuses the whole patch
 * when it would put two milestones of one project in one week. */
export const update = adminMutation({
  args: {
    patch: v.object({
      name: v.optional(v.string()),
      date_format: v.optional(vDateFormat),
      week_start: v.optional(v.number()),
      week_one_rule: v.optional(vWeekOneRule),
      default_plannable_hours: v.optional(v.number()),
      max_attachment_mb: v.optional(v.number()),
      project_creators: v.optional(vProjectCreators),
    }),
    expected: v.optional(vOrgExpected),
  },
  handler: async (ctx, { patch, expected }) => {
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    const fields: Partial<
      Pick<
        Doc<'organizations'>,
        | 'name'
        | 'date_format'
        | 'week_start'
        | 'week_one_rule'
        | 'default_plannable_hours'
        | 'max_attachment_mb'
        | 'project_creators'
      >
    > = {}
    if (patch.name !== undefined) {
      fields.name = cleanOrgName(patch.name)
      if (fields.name === '') throw rule('an organization name cannot be blank')
    }
    if (patch.date_format !== undefined) fields.date_format = patch.date_format
    if (patch.week_start !== undefined) {
      // organizations_week_start_check (0039): Date#getDay numbering
      if (!Number.isInteger(patch.week_start) || patch.week_start < 0 || patch.week_start > 6) {
        throw badRequest('week_start must be a whole number from 0 (Sunday) to 6 (Saturday)')
      }
      fields.week_start = patch.week_start
    }
    if (patch.week_one_rule !== undefined) fields.week_one_rule = patch.week_one_rule
    if (patch.default_plannable_hours !== undefined) {
      fields.default_plannable_hours = limitedWhole(
        LIMITS.plannableHours,
        patch.default_plannable_hours,
      )
    }
    if (patch.project_creators !== undefined) fields.project_creators = patch.project_creators
    if (patch.max_attachment_mb !== undefined) {
      fields.max_attachment_mb = limitedWhole(LIMITS.attachmentLimit, patch.max_attachment_mb)
    }
    await assertOrgExpected(ctx, { me: ctx.me, org, expected, next: fields })
    // new weeks must not put two milestones of one project in one week
    if (fields.week_start !== undefined && fields.week_start !== org.week_start)
      await assertWeekStartFits(ctx, { me: ctx.me, org, weekStart: fields.week_start })
    if (Object.keys(fields).length > 0) await ctx.db.patch(org._id, fields)
    return null
  },
})

/* ---------------------------------------------------------------- setSlug
 * P.setOrgSlug — awaited by the client (the address bar must not move to a
 * slug the server never accepted). Trim/lowercase happen client-side; a
 * malformed value lands in assertSlugAvailable's `slug_shape` conflict.
 * The three conflict reasons map 1:1 onto the client's three sentences;
 * a non-admin dies at the wrapper's `forbidden` and reads the client's
 * "You don't have permission to change the address." */
export const setSlug = adminMutation({
  args: { slug: v.string(), expected: v.optional(v.object({ slug: v.string() })) },
  handler: async (ctx, { slug, expected }) => {
    const now = new Date().toISOString()
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    if (slug === org.slug) return null
    await assertOrgExpected(ctx, { me: ctx.me, org, expected, next: { slug } })
    await assertSlugAvailable(ctx, slug, org.id)
    await ctx.db.patch(org._id, { slug })
    await narrateSlugChange(ctx, org, {
      old_slug: org.slug,
      new_slug: slug,
      actor_id: ctx.me.id,
      now,
    })
    return null
  },
})
