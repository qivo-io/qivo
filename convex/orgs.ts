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
import { adminMutation, badRequest, notFound, require } from './lib/functions'
import { assertSlugAvailable, narrateSlugChange } from './model/orgs'

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
 * is_org_admin (0081:108). Narrates nothing, name included. */
export const update = adminMutation({
  args: {
    patch: v.object({
      name: v.optional(v.string()),
      date_format: v.optional(vDateFormat),
      week_start: v.optional(v.number()),
      week_one_rule: v.optional(vWeekOneRule),
      default_plannable_hours: v.optional(v.number()),
      gravatar_avatars: v.optional(v.boolean()),
      max_attachment_mb: v.optional(v.number()),
      only_team_leads_manage_project_users: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { patch }) => {
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
        | 'gravatar_avatars'
        | 'max_attachment_mb'
        | 'only_team_leads_manage_project_users'
      >
    > = {}
    if (patch.name !== undefined) {
      if (patch.name.trim() === '') throw badRequest('an organization name cannot be blank')
      fields.name = patch.name
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
      // the client's clamp (bc022c2:3004), which the 0095 integer column and
      // its 1..168 CHECK bounded server-side
      const n = patch.default_plannable_hours
      if (!Number.isFinite(n)) throw badRequest('default_plannable_hours must be a number')
      fields.default_plannable_hours = Math.max(1, Math.min(168, Math.round(n)))
    }
    if (patch.gravatar_avatars !== undefined) fields.gravatar_avatars = patch.gravatar_avatars
    if (patch.only_team_leads_manage_project_users !== undefined) {
      fields.only_team_leads_manage_project_users = patch.only_team_leads_manage_project_users
    }
    if (patch.max_attachment_mb !== undefined) {
      const n = patch.max_attachment_mb
      if (!Number.isFinite(n)) throw badRequest('max_attachment_mb must be a number')
      fields.max_attachment_mb = Math.max(1, Math.min(20, Math.round(n)))
    }
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
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const now = new Date().toISOString()
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    if (slug === org.slug) return null
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
