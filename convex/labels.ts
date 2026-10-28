/* Labels (phase 5): the per-org vocabulary + the issue attach/detach.
 * The rules live in model/labels. Staff with User standing on a top-level
 * project may create labels (canWriteOrgLabels, which reads only the
 * caller's own rows and refuses when it cannot finish); renaming, recoloring
 * and deleting are for org admins only (canManageOrgLabels), as on the app's
 * admin-only Labels settings page. Names are trimmed, non-blank and within
 * LIMITS.labelName (lib/limits.ts), with the case-insensitive per-org uniqueness
 * carried by name_lower; colors are #rrggbb because clients render them as
 * CSS backgrounds.
 *
 * Settings > Labels (settingsPage) and the task label picker (picker) read
 * the labels a batch at a time in name order, with search over the whole
 * list on the server (model/labels.ts labelBatch), and byIds looks up the
 * labels a task shows that no batch holds.
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
import { badRequest, forbidden, notFound, orgMutation, orgQuery, rule } from './lib/functions'
import { BY_IDS_MAX } from './lib/limits'
import {
  assertLabelManager,
  createLabelCore,
  deleteLabelCore,
  type LabelBatch,
  type LabelRow,
  labelJson,
  pickerLabels,
  type SettingsLabelRow,
  setTaskLabel,
  settingsLabels,
  updateLabelCore,
  vLabelExpected,
} from './model/labels'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/** The arguments of a label list: an optional search, and the cursors of
 * the batch's start (`after`, none for the first batch) and, to keep a
 * loaded batch live, its end (`through`). */
const vListArgs = {
  search: v.optional(v.string()),
  after: v.optional(v.string()),
  through: v.optional(v.string()),
}

/* ------------------------------------------------------------ settingsPage
 * Settings > Labels, for organization admins only. */

/** One batch of the organization's labels for Settings > Labels, in name
 * order, each with `active_tasks`, the active tasks across the organization
 * that carry it (model/labelCounts.ts shownCount): null while the label is
 * not counted, never 0 for a missing count. `counting` is true while the
 * organization's counts are being prepared, when every count is null. The
 * batch, its search, `next`, `stopped` and `exact` are model/labels.ts
 * labelBatch's. Only active organization admins may read it, as only they
 * manage labels (model/labels.ts settingsLabels). */
export const settingsPage = orgQuery({
  args: vListArgs,
  handler: (ctx, a): Promise<LabelBatch<SettingsLabelRow> & { counting: boolean }> =>
    settingsLabels(ctx, ctx.me, a),
})

/* ------------------------------------------------------------------ picker
 * The task label picker, for every seat. */

/** One batch of the organization's labels for the task label picker, for
 * any active seat in the organization, guests and viewers included, as
 * every member reads the label list. The batch, its search, `next`,
 * `stopped` and `exact` are model/labels.ts labelBatch's. A first batch (no
 * `after`) also answers `can_create`, whether the caller may create a label
 * in this organization (lib/access.ts canWriteOrgLabels), or null when the
 * check could not finish in this request; later batches leave it out. The
 * picker offers creating a label only in the caller's home organization,
 * which the app decides, not this query (model/labels.ts pickerLabels). */
export const picker = orgQuery({
  args: vListArgs,
  handler: (ctx, a): Promise<LabelBatch<LabelRow> & { can_create?: boolean | null }> =>
    pickerLabels(ctx, ctx.me, a),
})

/* ------------------------------------------------------------------- byIds */

/** The labels of the organization among `ids`, each once, for labels a task
 * shows that no batch holds. An id of another organization, an unknown id
 * and a deleted label are left out, a definite answer, since each was looked
 * up. More than BY_IDS_MAX ids are refused. */
export const byIds = orgQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<{ rows: LabelRow[] }> => {
    if (ids.length > BY_IDS_MAX) {
      throw badRequest(`ids must name at most ${BY_IDS_MAX} labels`)
    }
    const labels = await Promise.all([...new Set(ids)].map((id) => byId(ctx, 'labels', id)))
    return {
      rows: labels.flatMap((label) =>
        label !== null && label.org_id === ctx.me.org_id ? [labelJson(label)] : [],
      ),
    }
  },
})

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
    expected: v.optional(vLabelExpected),
  },
  handler: async (ctx, { id, patch, expected }) => {
    assertLabelManager(ctx.me)
    const label = await myLabel(ctx, id)
    await updateLabelCore(ctx, {
      me: ctx.me,
      label,
      name: patch.name,
      color: patch.color,
      expected,
    })
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
  args: { id: v.string(), expected: v.optional(vLabelExpected) },
  handler: async (ctx, { id, expected }) => {
    const now = new Date().toISOString()
    assertLabelManager(ctx.me)
    const label = await myLabel(ctx, id)
    await deleteLabelCore(ctx, { me: ctx.me, label, now, expected })
    return null
  },
})

/* ----------------------------------------------------------------- toggle
 * P.toggleIssueLabel — landed HERE, absent from issues.ts. `on` names the
 * state the person asked for: attach = insert unless the pair exists,
 * detach = delete it, and a request for the current state writes nothing,
 * so a resent toggle cannot undo itself. `on` is required: every app since
 * v0.1.26 sends it, and the old flip without it is gone. Predicate is
 * has_project_level(project, 'user') (0010:65-69, member→user); the org
 * guard is issue_labels_check_org's sentence VERBATIM (0078:117) — in the
 * SQL a missing label read the same sentence as a foreign one, kept here.
 * The write is model/labels.ts setTaskLabel, which REST and MCP run too. */
export const toggle = orgMutation({
  args: { issue_id: v.string(), label_id: v.string(), on: v.boolean() },
  handler: async (ctx, { issue_id, label_id, on }) => {
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
    await setTaskLabel(ctx, { me: ctx.me, issue, label, on, now })
    return null
  },
})
