/* Labels (phase 5): the per-org vocabulary + the issue attach/detach.
 * The rules live in model/labels. Staff with User standing on a top-level
 * project may create labels (canWriteOrgLabels); renaming, recoloring and
 * deleting are for org admins only (canManageOrgLabels), as on the app's
 * admin-only Labels settings page. Names follow 0010's CHECK (trimmed
 * non-blank, ≤40 codepoints) with the case-insensitive per-org uniqueness
 * carried by name_lower; colors are #rrggbb because clients render them as
 * CSS backgrounds.
 *
 * Narration is asymmetric on purpose (T8): create and delete write an
 * activity row, update writes NONE. toggle narrates against the ISSUE
 * ('labeled' / 'removed a label from'). No archived guard anywhere — labels
 * on archived issues were always writable (no such guard existed on
 * issue_labels). */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { hasProjectLevel } from './lib/access'
import { byId } from './lib/db'
import { forbidden, notFound, orgMutation, rule } from './lib/functions'
import {
  assertLabelManager,
  createLabelCore,
  deleteLabelCore,
  setTaskLabel,
  updateLabelCore,
} from './model/labels'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

async function myLabel(ctx: MeCtx, id: string): Promise<Doc<'labels'>> {
  const label = await byId(ctx, 'labels', id)
  if (label === null || label.org_id !== ctx.me.org_id) throw notFound('label not found')
  return label
}

/* ----------------------------------------------------------------- create
 * P.addLabel. The client's predictive dup toast stays client-side; the
 * server refusal in model/labels.ts createLabelCore is what REST and MCP
 * read too. */
export const create = orgMutation({
  args: { id: v.string(), name: v.string(), color: v.string() },
  handler: async (ctx, { id, name, color }) => {
    const now = new Date().toISOString()
    await createLabelCore(ctx, { me: ctx.me, id, name, color, now })
    return null
  },
})

/* ----------------------------------------------------------------- update
 * P.updateLabel, for org admins only, checked before the lookup so a
 * refusal says nothing about which ids exist. It narrates NOTHING (T8).
 * name_lower stays in step; the uniqueness probe excludes the row itself, so
 * a case-only rename passes (model/labels.ts updateLabelCore). */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({ name: v.optional(v.string()), color: v.optional(v.string()) }),
  },
  handler: async (ctx, { id, patch }) => {
    assertLabelManager(ctx.me)
    const label = await myLabel(ctx, id)
    await updateLabelCore(ctx, { me: ctx.me, label, name: patch.name, color: patch.color })
    return null
  },
})

/* ----------------------------------------------------------------- remove
 * P.removeLabel, for org admins only, checked before the lookup. It deletes
 * the row and narrates 'deleted label' like the old client. The
 * issue_labels FK cascade runs in this transaction up to a bound and in
 * background steps past it (model/labels.ts deleteLabelCore,
 * labelRemovals.ts). */
export const remove = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    assertLabelManager(ctx.me)
    const label = await myLabel(ctx, id)
    await deleteLabelCore(ctx, { me: ctx.me, label, now })
    return null
  },
})

/* ----------------------------------------------------------------- toggle
 * P.toggleIssueLabel — landed HERE, absent from issues.ts. Attach = insert
 * unless the pair exists, detach = delete
 * it; the server decides on ITS state, so a replay nets out. Predicate is
 * has_project_level(project, 'user') (0010:65-69, member→user); the org
 * guard is issue_labels_check_org's sentence VERBATIM (0078:117) — in the
 * SQL a missing label read the same sentence as a foreign one, kept here.
 * The write is model/labels.ts setTaskLabel, which REST and MCP run too. */
export const toggle = orgMutation({
  args: { issue_id: v.string(), label_id: v.string() },
  handler: async (ctx, { issue_id, label_id }) => {
    const now = new Date().toISOString()
    const issue = await byId(ctx, 'issues', issue_id)
    if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
    if (!(await hasProjectLevel(ctx, ctx.me, issue.project_id, 'user'))) {
      throw forbidden('no write access to this project')
    }
    const label = await byId(ctx, 'labels', label_id)
    if (label === null || label.org_id !== issue.org_id) {
      throw rule('label and task must belong to the same organization')
    }
    const pair = await ctx.db
      .query('issue_labels')
      .withIndex('by_issue_label', (q) => q.eq('issue_id', issue.id).eq('label_id', label.id))
      .unique()
    await setTaskLabel(ctx, { me: ctx.me, issue, label, on: pair === null, now })
    return null
  },
})
