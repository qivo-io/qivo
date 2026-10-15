/* Shared label rules. Every write to the organization's label list goes
 * through these checks, so the app and the machine surfaces agree on who may
 * change labels and what a stored name or color may be. The writes the app,
 * REST and MCP share live here too: creating and editing a label, and
 * putting one on a task or taking it off. Each caller resolves what it names
 * and refuses with its own sentences first. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { canManageOrgLabels, canWriteOrgLabels } from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import { badRequest, forbidden, rule } from '../lib/functions'
import { logActivity, signedDetail } from './activity'
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

/** Trims the name and refuses it when blank or longer than 40 codepoints
 * (0010's CHECK, Postgres char_length semantics). */
export function labelName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a label name cannot be blank')
  if ([...name].length > 40) throw badRequest('a label name is at most 40 characters')
  return name
}

/** True for a `#rrggbb` color, in either case. Clients render the stored
 * value as a CSS background, so nothing else may be stored. */
export function isLabelColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/** The color as given, refused unless it is `#rrggbb`. */
export function labelColor(raw: string): string {
  if (!isLabelColor(raw)) {
    throw badRequest('a label color must be # followed by six hex digits, like #4C9AFF')
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
 * app's client-made id; machine callers pass a new one. Refuses a caller who
 * may not add labels, a blank or long name, a color that is not #rrggbb, a
 * used id and a name the organization already has in any case.
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
  await assertLabelCreator(ctx, me)
  const name = labelName(a.name)
  const color = labelColor(a.color)
  if ((await byId(ctx, 'labels', id)) !== null) {
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

/**
 * Renames or recolors `label`, for organization admins only. It writes no
 * activity row, as the app never did. A name another label already has, in
 * any case, is refused; a case-only rename of the label itself passes.
 */
export async function updateLabelCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; label: Doc<'labels'>; name?: string; color?: string },
): Promise<Doc<'labels'>> {
  const { me, label } = a
  assertLabelManager(me)
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

/**
 * Puts `label` on `issue` (`on`) or takes it off, and answers whether that
 * changed anything. A change writes the task's 'labeled' or 'removed a label
 * from' activity row, signed with `provenance` for a machine caller; asking
 * for the current state writes nothing. Refuses an actor without Edit on the
 * task's project and a label of another organization.
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
  else
    await ctx.db.insert('issue_labels', {
      org_id: issue.org_id,
      issue_id: issue.id,
      label_id: label.id,
    })
  const named = `— ${label.name}`
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
