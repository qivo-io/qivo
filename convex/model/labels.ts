/* Shared label rules. Every write to the organization's label list goes
 * through these checks, so the app and the machine surfaces agree on who may
 * change labels and what a stored name or color may be. The writes the app,
 * REST and MCP share live here too: creating and editing a label, and
 * putting one on a task or taking it off. Each caller resolves what it names
 * and refuses with its own sentences first. Deleting a label is app only
 * (labels.remove), and its bounded cascade, deleteLabelCore, lives here with
 * the other writes. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { canManageOrgLabels, canWriteOrgLabels } from '../lib/access'
import { assertNewRowId, byId, insertUnique } from '../lib/db'
import { trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS } from '../lib/limits'
import { logActivity, signedDetail } from './activity'
import { assertExpected, DELETES, type Fields, filledText, type Next } from './expected'
import { assertCanEdit } from './issues'

/** Refuses a caller who may not add labels to the organization's list. */
export async function assertLabelCreator(ctx: QueryCtx, me: Doc<'profiles'>): Promise<void> {
  if (!(await canWriteOrgLabels(ctx, me))) {
    throw forbidden('no label access in this organization')
  }
}

/** Refuses a caller who may not rename, recolor or delete labels. Checked
 * before any label lookup, so a refusal says nothing about which ids exist. */
export function assertLabelManager(me: Doc<'profiles'>): void {
  if (!canManageOrgLabels(me)) {
    throw forbidden('only organization admins can rename, recolor or delete labels')
  }
}

/** Trims the name and refuses it when blank or past LIMITS.labelName. */
export function labelName(raw: string): string {
  const name = limitedText(LIMITS.labelName, raw)
  if (name === '') throw rule('a label name cannot be blank')
  return name
}

/** True for a `#rrggbb` color, in either case. Clients render the stored
 * value as a CSS background, so nothing else may be stored. */
export function isLabelColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/* A label color's rule in words. */
const LABEL_COLOR_SHAPE = '# followed by six hex digits, like #4C9AFF'

/** The color as given, refused unless it is `#rrggbb`. */
export function labelColor(raw: string): string {
  if (!isLabelColor(raw)) {
    throw badRequest(`a label color must be ${LABEL_COLOR_SHAPE}`)
  }
  return raw
}

/** The palette's gray, sent in place of a stored color that breaks the rule. */
const FALLBACK_LABEL_COLOR = '#8A8F98'

/** The color to send a client. Rows saved before the `#rrggbb` rule may hold
 * any text, so every read that hands a label to a client uses this and sends
 * gray instead. The stored value stays until an admin recolors the label. */
export function shownLabelColor(stored: string): string {
  return isLabelColor(stored) ? stored : FALLBACK_LABEL_COLOR
}

/** A label as REST and MCP send it, with the color a client may paint. */
export const labelJson = (label: Doc<'labels'>): { id: string; name: string; color: string } => ({
  id: label.id,
  name: label.name,
  color: shownLabelColor(label.color),
})

/** The organization's labels, ordered by name. Every member may read them. */
export async function listLabelsCore(ctx: QueryCtx, orgId: string): Promise<Doc<'labels'>[]> {
  const rows = await ctx.db
    .query('labels')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return rows.sort((a, b) => a.name_lower.localeCompare(b.name_lower) || a.id.localeCompare(b.id))
}

/** The organization's label with this id, or with this name in any case;
 * null when none matches. */
export async function findLabel(
  ctx: QueryCtx,
  orgId: string,
  ref: string,
): Promise<Doc<'labels'> | null> {
  const byUuid = await byId(ctx, 'labels', ref.toLowerCase())
  if (byUuid !== null) return byUuid.org_id === orgId ? byUuid : null
  return await ctx.db
    .query('labels')
    .withIndex('by_org_name_lower', (q) =>
      q.eq('org_id', orgId).eq('name_lower', ref.trim().toLowerCase()),
    )
    .first()
}

/**
 * Adds a label to `me`'s organization and writes its 'created label'
 * activity row, signed with `provenance` for a machine caller. `id` is the
 * app's client-made id; machine callers pass a new one. Refuses an id that
 * is not a lowercase UUID (lib/db.ts assertNewRowId), a caller who may not
 * add labels, a blank or long name, a color that is not #rrggbb, a used id
 * and a name the organization already has in any case.
 */
export async function createLabelCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    id: string
    name: string
    color: string
    now: string
    provenance?: string
  },
): Promise<Doc<'labels'>> {
  const { me, id, now } = a
  assertNewRowId(id)
  await assertLabelCreator(ctx, me)
  const name = labelName(a.name)
  const color = labelColor(a.color)
  // A deleted label's id stays taken until its assignments are gone, or the
  // new label would inherit them. The sentence is the same either way.
  if ((await byId(ctx, 'labels', id)) !== null || (await pendingLabelRemoval(ctx, id)) !== null) {
    throw badRequest('a label with this id already exists')
  }
  const docId = await insertUnique(
    ctx,
    'labels',
    'by_org_name_lower',
    { org_id: me.org_id, name_lower: name.toLowerCase() },
    { id, org_id: me.org_id, name, name_lower: name.toLowerCase(), color, created_at: now },
    rule('a label with that name already exists'),
  )
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'created label',
    target_type: 'org',
    target_id: id,
    label: name,
    detail: a.provenance,
    ts: now,
  })
  return (await ctx.db.get(docId)) as Doc<'labels'>
}

/** The keys of a label's `expected`, the color in the form every read
 * shows it (shownLabelColor). */
export const LABEL_FIELDS: Fields<Doc<'labels'>> = {
  // labelName's rule
  name: { sends: 'name', type: filledText(LIMITS.labelName), form: trimmedForm },
  color: {
    sends: 'color',
    // the rule of the field itself (labelColor)
    type: {
      ok: (v) => typeof v === 'string' && isLabelColor(v),
      says: LABEL_COLOR_SHAPE,
      schema: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    },
    form: (value) => (value == null ? null : shownLabelColor(String(value)).toLowerCase()),
  },
}

/** The app's `expected` for a label edit or delete. */
export const vLabelExpected = v.object({
  name: v.optional(v.string()),
  color: v.optional(v.string()),
})

/** Refuses a label edit or delete over a field someone else changed since
 * `expected` was read (model/expected.ts). `next` holds what the edit
 * stores, or DELETES. */
async function assertLabelExpected(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  label: Doc<'labels'>,
  expected: Readonly<Record<string, unknown>> | undefined,
  next: Next,
): Promise<void> {
  await assertExpected({
    read: { ctx, me, view: 'app' },
    fields: LABEL_FIELDS,
    record: 'label',
    id: label.id,
    label: `label "${label.name}"`,
    row: label,
    expected,
    next,
  })
}

/**
 * Renames or recolors `label`, for organization admins only. It writes no
 * activity row, as the app never did. A name another label already has, in
 * any case, is refused; a case-only rename of the label itself passes.
 * `expected` holds what the caller read (model/expected.ts).
 */
export async function updateLabelCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    label: Doc<'labels'>
    name?: string
    color?: string
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<Doc<'labels'>> {
  const { me, label } = a
  assertLabelManager(me)
  await assertLabelExpected(ctx, me, label, a.expected, {
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.color !== undefined ? { color: a.color } : {}),
  })
  const fields: Partial<Pick<Doc<'labels'>, 'name' | 'name_lower' | 'color'>> = {}
  if (a.name !== undefined) {
    const name = labelName(a.name)
    if (name !== label.name) {
      const holder = await ctx.db
        .query('labels')
        .withIndex('by_org_name_lower', (q) =>
          q.eq('org_id', label.org_id).eq('name_lower', name.toLowerCase()),
        )
        .first()
      if (holder !== null && holder.id !== label.id) {
        throw rule('a label with that name already exists')
      }
      fields.name = name
      fields.name_lower = name.toLowerCase()
    }
  }
  if (a.color !== undefined) {
    const color = labelColor(a.color)
    if (color !== label.color) fields.color = color
  }
  if (Object.keys(fields).length > 0) await ctx.db.patch(label._id, fields)
  return (await ctx.db.get(label._id)) as Doc<'labels'>
}

/** The task assignments a label delete removes in its own transaction, and
 * the most one background step removes (labelRemovals.ts). Convex reads a
 * row by id before deleting it, so each deleted row uses one of the 4,096
 * index ranges a transaction may read. A full step measured 2,048 ranges on
 * a local backend, half the limit. convex-test does not count these reads.
 * Tests lower both values. */
export const LABEL_REMOVAL = { inline: 1000, step: 2000 }

const removalStepRef = makeFunctionReference<'mutation', { label_id: string }, null>(
  'labelRemovals:step',
)

/** The unfinished background removal of the deleted label `labelId`, or
 * null. While it exists, the id stays reserved (createLabelCore). */
export function pendingLabelRemoval(ctx: QueryCtx, labelId: string) {
  return ctx.db
    .query('label_removals')
    .withIndex('by_label', (q) => q.eq('label_id', labelId))
    .unique()
}

/** Deletes up to `n` task assignments of `labelId`, archived tasks included,
 * and answers whether any are left. */
export async function deleteLabelAssignments(
  ctx: MutationCtx,
  labelId: string,
  n: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query('issue_labels')
    .withIndex('by_label', (q) => q.eq('label_id', labelId))
    .take(n + 1)
  for (const row of rows.slice(0, n)) await ctx.db.delete(row._id)
  return rows.length > n
}

/**
 * Deletes `label` for an organization admin and writes its 'deleted label'
 * activity row. Up to LABEL_REMOVAL.inline of its task assignments go in the
 * same transaction. A label on more tasks gets a label_removals row, which
 * reserves the id, and background steps remove the rest (labelRemovals.ts).
 * Every reader skips an assignment whose label is gone, so the label leaves
 * every task at once either way.
 */
export async function deleteLabelCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    label: Doc<'labels'>
    now: string
    /** The name and color the caller read: Deleted items cannot bring a
     * label back, so a delete over a change since is refused. */
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<void> {
  const { me, label, now } = a
  assertLabelManager(me)
  await assertLabelExpected(ctx, me, label, a.expected, DELETES)
  const more = await deleteLabelAssignments(ctx, label.id, LABEL_REMOVAL.inline)
  await ctx.db.delete(label._id)
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'deleted label',
    target_type: 'org',
    target_id: label.id,
    label: label.name,
    ts: now,
  })
  if (!more) return
  const scheduled_id = await ctx.scheduler.runAfter(0, removalStepRef, { label_id: label.id })
  const job = { label_id: label.id, removed_at: now, progress_at: now, scheduled_id }
  // A row is left only when a fixture planted a label with a reserved id.
  // Its assignments cannot be told apart from these, so one job takes both.
  const earlier = await pendingLabelRemoval(ctx, label.id)
  if (earlier) await ctx.db.replace(earlier._id, job)
  else await ctx.db.insert('label_removals', job)
}

/**
 * Puts `label` on `issue` (`on`) or takes it off, and answers whether that
 * changed anything. A change writes the task's 'labeled' or 'removed a label
 * from' activity row, signed with `provenance` for a machine caller; asking
 * for the current state writes nothing. Refuses an actor without Edit on the
 * task's project, a label of another organization and a new label on a task
 * that carries LIMITS.labels.max already.
 */
export async function setTaskLabel(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    label: Doc<'labels'>
    on: boolean
    now: string
    provenance?: string
  },
): Promise<boolean> {
  const { me, issue, label, now } = a
  await assertCanEdit(ctx, me, issue.project_id)
  if (label.org_id !== issue.org_id) {
    throw rule('label and task must belong to the same organization')
  }
  const pair = await ctx.db
    .query('issue_labels')
    .withIndex('by_issue_label', (q) => q.eq('issue_id', issue.id).eq('label_id', label.id))
    .unique()
  if ((pair !== null) === a.on) return false
  if (pair !== null) await ctx.db.delete(pair._id)
  else {
    const held = await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
      .take(LIMITS.labels.max)
    if (held.length >= LIMITS.labels.max) throw rule(LIMITS.labels.refusal)
    await ctx.db.insert('issue_labels', {
      org_id: issue.org_id,
      issue_id: issue.id,
      label_id: label.id,
    })
  }
  const named = `“${label.name}”`
  await logActivity(ctx, {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: a.on ? 'labeled' : 'removed a label from',
    target_type: 'issue',
    target_id: issue.id,
    label: issue.title,
    detail: signedDetail(named, a.provenance),
    project_id: issue.project_id,
    ts: now,
    named_task_nums: [],
  })
  return true
}

/** The organization's labels that `refs` name by id or name, each once.
 * Refuses a ref that names none. */
export async function labelsByRef(
  ctx: QueryCtx,
  orgId: string,
  refs: readonly string[],
): Promise<Doc<'labels'>[]> {
  const out = new Map<string, Doc<'labels'>>()
  for (const ref of refs) {
    const label = await findLabel(ctx, orgId, ref)
    if (label === null) throw badRequest(`label "${ref}" not found`)
    out.set(label.id, label)
  }
  return [...out.values()]
}

/**
 * The labels a task update adds and removes, resolved from label ids or
 * names in the organization. Refuses an unknown label and one named in both
 * lists.
 */
export async function labelChanges(
  ctx: QueryCtx,
  orgId: string,
  refs: { add: readonly string[]; remove: readonly string[] },
): Promise<{ add: Doc<'labels'>[]; remove: Doc<'labels'>[] }> {
  const add = await labelsByRef(ctx, orgId, refs.add)
  const remove = await labelsByRef(ctx, orgId, refs.remove)
  const both = add.find((label) => remove.some((other) => other.id === label.id))
  if (both !== undefined) {
    throw badRequest(`label "${both.name}" cannot be both added and removed`)
  }
  return { add, remove }
}
