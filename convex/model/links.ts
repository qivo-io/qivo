/* Task links, one rule for the app, REST and MCP. A link joins two tasks of
 * one organization, at most one link per pair. 'blocks' is stored directed,
 * source blocks target; 'relates' is stored with the lower uuid as source.
 * Machine callers name a link as seen from one of its tasks, so 'blocked_by'
 * exists only on the wire and is stored as the other task blocking this one.
 *
 * Who may add or remove a link is model/issues.ts linkAccess: sight of both
 * tasks and Edit on at least one. Each caller resolves the tasks and refuses
 * with its own sentences first; these cores repeat the check as defense in
 * depth. Adding writes a 'linked' activity row against the stored source,
 * removing writes none, as the app always did. */

import { literals } from 'convex-helpers/validators'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { LinkType } from '../lib/enums'
import { badRequest, forbidden, notFound, rule } from '../lib/functions'
import { issueKey } from '../lib/taskRefs'
import { logActivity, machineDetail } from './activity'
import { assertLinkableIssues, linkAccess } from './issues'
import { newUuid } from './orgs'

/** A link as seen from one of its tasks, the grammar REST and MCP use. */
export const TASK_LINK_KINDS = ['blocks', 'blocked_by', 'relates'] as const
export const vTaskLinkKind = literals(...TASK_LINK_KINDS)
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number]

export const isTaskLinkKind = (value: unknown): value is TaskLinkKind =>
  (TASK_LINK_KINDS as readonly unknown[]).includes(value)

/** The pair's unique key, the sorted `min:max` of the two task ids. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

/** The stored row for a link of `kind` from task `fromId` to task `toId`. */
export function storedLink(
  fromId: string,
  kind: TaskLinkKind,
  toId: string,
): { source_id: string; target_id: string; type: LinkType } {
  if (kind === 'blocks') return { source_id: fromId, target_id: toId, type: 'blocks' }
  if (kind === 'blocked_by') return { source_id: toId, target_id: fromId, type: 'blocks' }
  return fromId < toId
    ? { source_id: fromId, target_id: toId, type: 'relates' }
    : { source_id: toId, target_id: fromId, type: 'relates' }
}

/** What a stored link is as seen from the task with this id. */
export function linkKindFrom(
  link: Pick<Doc<'issue_links'>, 'source_id' | 'type'>,
  taskId: string,
): TaskLinkKind {
  if (link.type !== 'blocks') return 'relates'
  return link.source_id === taskId ? 'blocks' : 'blocked_by'
}

/** Every stored link of one task, whichever end it is. */
export async function linksOf(ctx: QueryCtx, taskId: string): Promise<Doc<'issue_links'>[]> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', taskId))
      .collect(),
    ctx.db
      .query('issue_links')
      .withIndex('by_target', (q) => q.eq('target_id', taskId))
      .collect(),
  ])
  const byId = new Map<string, Doc<'issue_links'>>()
  for (const link of [...asSource, ...asTarget]) byId.set(link.id, link)
  return [...byId.values()]
}

/**
 * Links two tasks as stored (source, target, type), stamped `now`. `id` is
 * the app's client-made id; machine callers omit it. The same link again is
 * a no-op that writes nothing and answers `added: false`; a different link
 * between the same tasks is refused. `provenance` signs a machine write's
 * activity row. Refuses a self link, a task the actor cannot see (in the
 * organization sentence, so no answer describes it) and an actor without
 * Edit on either task.
 */
export async function addLinkCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    id?: string
    source_id: string
    target_id: string
    type: LinkType
    now: string
    provenance?: string
  },
): Promise<{ link: Doc<'issue_links'>; added: boolean }> {
  const { me, source_id, target_id, type, now } = a
  if (source_id === target_id) throw badRequest('a task cannot be linked to itself')
  const { source, target } = await assertLinkableIssues(ctx, source_id, target_id)
  // a pair in someone else's organization, or an end the actor cannot see,
  // answers exactly like a mismatched pair
  const access = await linkAccess(ctx, me, source, target)
  if (access === 'hidden') throw rule('linked tasks must belong to the same organization')
  if (access === 'read') throw forbidden('no write access to these tasks')
  const key = pairKey(source_id, target_id)
  const existing = await ctx.db
    .query('issue_links')
    .withIndex('by_pair', (q) => q.eq('pair_key', key))
    .first()
  if (existing !== null) {
    const same =
      existing.source_id === source_id && existing.target_id === target_id && existing.type === type
    if (same) return { link: existing, added: false }
    throw badRequest('these tasks are already linked')
  }
  const docId = await ctx.db.insert('issue_links', {
    id: a.id ?? newUuid(),
    org_id: source.org_id,
    source_id,
    target_id,
    type,
    pair_key: key,
    created_at: now,
  })
  // model/activity.ts namedTaskNums reads this wording back; keep in step
  const named = `${type === 'blocks' ? '— blocks' : '— relates to'} ${issueKey(target.num)}`
  await logActivity(ctx, {
    org_id: source.org_id,
    actor_id: me.id,
    verb: 'linked',
    target_type: 'issue',
    target_id: source.id,
    label: source.title,
    detail: a.provenance === undefined ? named : machineDetail(named, a.provenance),
    project_id: source.project_id,
    ts: now,
  })
  return { link: (await ctx.db.get(docId)) as Doc<'issue_links'>, added: true }
}

/**
 * Removes the link between tasks `a` and `b`, or only one of `kind` as seen
 * from `a` when given, and answers how many rows went. No link is a no-op.
 * Either task missing, foreign or hidden answers 'task not found', so no
 * answer tells whether a task the actor cannot see exists; an actor without
 * Edit on either task is refused. Writes no activity row.
 */
export async function removeLinkCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    a: Doc<'issues'> | null
    b: Doc<'issues'> | null
    kind?: TaskLinkKind
  },
): Promise<number> {
  const { a: from, b: to } = a
  const access = await linkAccess(ctx, a.me, from, to)
  if (access === 'hidden' || from === null || to === null) throw notFound('task not found')
  if (access === 'read') throw forbidden('no write access to these tasks')
  const key = pairKey(from.id, to.id)
  let removed = 0
  const links = ctx.db.query('issue_links').withIndex('by_pair', (q) => q.eq('pair_key', key))
  for await (const link of links) {
    if (a.kind !== undefined && linkKindFrom(link, from.id) !== a.kind) continue
    await ctx.db.delete(link._id)
    removed += 1
  }
  return removed
}
