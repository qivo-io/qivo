/* Labels (phase 5): the per-org vocabulary + the issue attach/detach.
 * Curation rights are can_write_org_labels (0102 final, lib/access); the
 * name rules are 0010's CHECK (trimmed non-blank, ≤40 codepoints) with the
 * case-insensitive per-org uniqueness carried by name_lower.
 *
 * Narration is asymmetric on purpose (T8): create and delete write an
 * activity row, update writes NONE. toggle narrates against the ISSUE
 * ('labeled' / 'removed a label from'). No archived guard anywhere — labels
 * on archived issues were always writable (no such guard existed on
 * issue_labels). */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { canWriteOrgLabels, hasProjectLevel } from './lib/access'
import { byId, insertUnique } from './lib/db'
import { badRequest, forbidden, notFound, orgMutation, rule } from './lib/functions'
import { logActivity } from './model/activity'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

async function assertCurator(ctx: MeCtx): Promise<void> {
  if (!(await canWriteOrgLabels(ctx, ctx.me))) {
    throw forbidden('no label access in this organization')
  }
}

/* 0010's CHECK: btrim(name) <> '' and char_length(name) <= 40 — codepoints,
 * Postgres char_length semantics. */
function labelName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a label name cannot be blank')
  if ([...name].length > 40) throw badRequest('a label name is at most 40 characters')
  return name
}

async function myLabel(ctx: MeCtx, id: string): Promise<Doc<'labels'>> {
  const label = await byId(ctx, 'labels', id)
  if (label === null || label.org_id !== ctx.me.org_id) throw notFound('label not found')
  return label
}

/* ----------------------------------------------------------------- create
 * P.addLabel. The client's predictive dup toast stays client-side; the
 * server refusal below is what the REST/MCP surfaces will read too. */
export const create = orgMutation({
  args: { id: v.string(), name: v.string(), color: v.string() },
  handler: async (ctx, { id, name, color }) => {
    const now = new Date().toISOString()
    await assertCurator(ctx)
    const clean = labelName(name)
    if ((await byId(ctx, 'labels', id)) !== null) {
      throw badRequest('a label with this id already exists')
    }
    await insertUnique(
      ctx,
      'labels',
      'by_org_name_lower',
      { org_id: ctx.me.org_id, name_lower: clean.toLowerCase() },
      {
        id,
        org_id: ctx.me.org_id,
        name: clean,
        name_lower: clean.toLowerCase(),
        color,
        created_at: now,
      },
      rule('a label with that name already exists'),
    )
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'created label',
      target_type: 'org',
      target_id: id,
      label: clean,
      ts: now,
    })
    return null
  },
})

/* ----------------------------------------------------------------- update
 * P.updateLabel — narrates NOTHING (T8). name_lower stays in step; the
 * uniqueness probe excludes the row itself, so a case-only rename passes. */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({ name: v.optional(v.string()), color: v.optional(v.string()) }),
  },
  handler: async (ctx, { id, patch }) => {
    await assertCurator(ctx)
    const label = await myLabel(ctx, id)
    const fields: Partial<Pick<Doc<'labels'>, 'name' | 'name_lower' | 'color'>> = {}
    if (patch.name !== undefined) {
      const clean = labelName(patch.name)
      if (clean !== label.name) {
        const holder = await ctx.db
          .query('labels')
          .withIndex('by_org_name_lower', (q) =>
            q.eq('org_id', ctx.me.org_id).eq('name_lower', clean.toLowerCase()),
          )
          .first()
        if (holder !== null && holder.id !== label.id) {
          throw rule('a label with that name already exists')
        }
        fields.name = clean
        fields.name_lower = clean.toLowerCase()
      }
    }
    if (patch.color !== undefined && patch.color !== label.color) fields.color = patch.color
    if (Object.keys(fields).length > 0) await ctx.db.patch(label._id, fields)
    return null
  },
})

/* ----------------------------------------------------------------- remove
 * P.removeLabel. The issue_labels FK cascade, spelled out (by_label), then
 * the row; 'deleted label' narrated like the old client's. */
export const remove = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    await assertCurator(ctx)
    const label = await myLabel(ctx, id)
    const attached = ctx.db
      .query('issue_labels')
      .withIndex('by_label', (q) => q.eq('label_id', label.id))
    for await (const il of attached) await ctx.db.delete(il._id)
    await ctx.db.delete(label._id)
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'deleted label',
      target_type: 'org',
      target_id: label.id,
      label: label.name,
      ts: now,
    })
    return null
  },
})

/* ----------------------------------------------------------------- toggle
 * P.toggleIssueLabel — landed HERE, absent from issues.ts. Attach = insert
 * unless the pair exists, detach = delete
 * it; the server decides on ITS state, so a replay nets out. Predicate is
 * has_project_level(project, 'user') (0010:65-69, member→user); the org
 * guard is issue_labels_check_org's sentence VERBATIM (0078:117) — in the
 * SQL a missing label read the same sentence as a foreign one, kept here. */
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
    if (pair !== null) await ctx.db.delete(pair._id)
    else
      await ctx.db.insert('issue_labels', {
        org_id: issue.org_id,
        issue_id: issue.id,
        label_id: label.id,
      })
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: ctx.me.id,
      verb: pair !== null ? 'removed a label from' : 'labeled',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: `— ${label.name}`,
      project_id: issue.project_id,
      ts: now,
    })
    return null
  },
})
