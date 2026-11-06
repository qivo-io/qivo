/* The whole readers of a task's related lists that REST and MCP used before
 * the lists paged (lib/core.ts relatedPage), kept as the oracles the pages
 * are pinned against: every link of a task, every follower and every
 * attachment, each read whole and sorted, and the details a single-task
 * read answers when everything is read whole over the organization's
 * catalogue (wholeDetails). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { type Caller, type ChildIndex, taskRefOf } from '../lib/core'
import { byId } from '../lib/db'
import { DEFAULT_PAGE_SIZE } from '../lib/limits'
import type { ProjectLive } from '../lib/liveTasks'
import { compareNamed } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { groupRemainingHours, linkShown } from '../lib/workingSet'
import { type AttachmentJson, attachmentsJson } from '../model/attachments'
import { labelJson } from '../model/labels'
import { linkKindFrom } from '../model/links'

/** Every stored link of one task, whichever end it is. */
export async function linksOf(ctx: QueryCtx, taskId: string): Promise<Doc<'issue_links'>[]> {
  const asSource = await ctx.db
    .query('issue_links')
    .withIndex('by_source', (q) => q.eq('source_id', taskId))
    .collect()
  const asTarget = await ctx.db
    .query('issue_links')
    .withIndex('by_target', (q) => q.eq('target_id', taskId))
    .collect()
  const unique = new Map<string, Doc<'issue_links'>>()
  for (const link of [...asSource, ...asTarget]) unique.set(link.id, link)
  return [...unique.values()]
}

/** The profiles of `issue`'s organization following it, by the name key's
 * bytes and then id, the order REST and MCP list them in. */
export async function followersOf(
  ctx: QueryCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<Doc<'profiles'>[]> {
  const out: Doc<'profiles'>[] = []
  const rows = await ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id))
    .collect()
  for (const row of rows) {
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (profile !== null && profile.org_id === issue.org_id) out.push(profile)
  }
  return out.sort((a, b) =>
    compareNamed({ key: nameKey(a.name), tie: [a.id] }, { key: nameKey(b.name), tie: [b.id] }),
  )
}

/** Every attachment of `issue` that counts toward its limit, oldest first
 * and then by id, with links minted for `reader`. */
export async function taskAttachments(
  ctx: QueryCtx,
  reader: Doc<'profiles'>,
  issue: Doc<'issues'>,
): Promise<AttachmentJson[]> {
  const rows = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue_dropped', (q) => q.eq('issue_id', issue.id).eq('dropped_at', undefined))
    .collect()
  rows.sort((x, y) =>
    compareNamed({ key: x.created_at, tie: [x.id] }, { key: y.created_at, tie: [y.id] }),
  )
  return await attachmentsJson(ctx, reader, rows)
}

/** What wholeDetails answers for a cursor that is not null, since a sealed
 * cursor cannot be worked out without the read under test
 * (cursorsShown). */
export const SOME_CURSOR = '(a cursor)'

/* `rows`' first page, and what its cursor is: null when it holds them all,
 * else SOME_CURSOR. */
const firstOf = <Row>(rows: readonly Row[]) => ({
  rows: rows.slice(0, DEFAULT_PAGE_SIZE),
  cursor: rows.length > DEFAULT_PAGE_SIZE ? SOME_CURSOR : null,
})

/** `details` with each of its four cursors that is not null as SOME_CURSOR,
 * to compare with wholeDetails. */
export const cursorsShown = <D extends Record<string, unknown>>(details: D): D => {
  const out: Record<string, unknown> = { ...details }
  for (const list of ['subtasks', 'links', 'followers', 'attachments']) {
    const key = `${list}_next_cursor`
    if (typeof out[key] === 'string') out[key] = SOME_CURSOR
  }
  return out as D
}

/**
 * What a single-task read adds to the row, read whole: the labels, whether
 * `me` follows the task, the group's remaining hours over `children`, the
 * whole subtree, and the first DEFAULT_PAGE_SIZE rows of each related list
 * read whole, each cursor null when its list ends there and SOME_CURSOR
 * otherwise. `readable` is the caller's read flag from the organization's
 * catalogue (lib/core.ts accessFlags) and `projectOf` its projects, so the
 * oracle asks no question the read under test asks.
 */
export async function wholeDetails(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  o: {
    children: ChildIndex
    live: ProjectLive
    isGroup: boolean
    readable: (projectId: string) => boolean
    projectOf: (projectId: string) => Doc<'projects'> | undefined
  },
) {
  const shown = (task: Doc<'issues'>) => task.org_id === me.org_id && o.readable(task.project_id)
  const allArchived = issue.archived_at !== undefined
  const kids = (o.children.get(issue.id) ?? [])
    .filter((kid) => (allArchived || kid.archived_at === undefined) && shown(kid))
    .sort((a, b) => a.num - b.num)
    .map(taskRefOf)
  // groupCounter's rule, said again
  const rootProject = o.projectOf(issue.project_id)
  const counts = (task: Doc<'issues'>) => {
    if (task.org_id !== me.org_id || (!allArchived && task.archived_at !== undefined)) return false
    const p = o.projectOf(task.project_id)
    if (p === undefined) return false
    if (rootProject?.archived_at === undefined && p.archived_at !== undefined) return false
    return o.readable(p.id)
  }
  const tasks = new Map([...o.children.values()].flat().map((t) => [t.id, t]))
  const group_remaining_hours = o.isGroup
    ? groupRemainingHours(
        issue,
        (id) => o.children.get(id) ?? [],
        (id) => {
          const task = tasks.get(id)
          return task !== undefined && counts(task)
        },
        o.live,
      )
    : null
  const links = []
  for (const link of await linksOf(ctx, issue.id)) {
    const other = await byId(
      ctx,
      'issues',
      link.source_id === issue.id ? link.target_id : link.source_id,
    )
    if (other === null) continue
    const sees = (id: string) => id === issue.id || (id === other.id && shown(other))
    if (!linkShown(link, sees)) continue
    links.push({ link, other })
  }
  links.sort((a, b) => a.other.num - b.other.num || (a.link.id < b.link.id ? -1 : 1))
  const labels: Doc<'labels'>[] = []
  for (const row of await ctx.db
    .query('issue_labels')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
    .collect()) {
    const label = await byId(ctx, 'labels', row.label_id)
    if (label !== null && label.org_id === issue.org_id) labels.push(label)
  }
  labels.sort((a, b) => a.name_lower.localeCompare(b.name_lower) || a.id.localeCompare(b.id))
  const followers = await followersOf(ctx, issue)
  const subtasks = firstOf(kids)
  const linked = firstOf(
    links.map(({ link, other }) => ({ kind: linkKindFrom(link, issue.id), ...taskRefOf(other) })),
  )
  const following = firstOf(followers.map((p) => ({ id: p.id, name: p.name })))
  const attachments = firstOf(await taskAttachments(ctx, me, issue))
  return {
    group_remaining_hours,
    labels: labels.map(labelJson),
    subtasks_next_cursor: subtasks.cursor,
    subtasks: subtasks.rows,
    has_more_subtasks: subtasks.cursor !== null,
    links_next_cursor: linked.cursor,
    links: linked.rows,
    following: followers.some((p) => p.id === me.id),
    followers_next_cursor: following.cursor,
    followers: following.rows,
    attachments_next_cursor: attachments.cursor,
    attachments: attachments.rows,
  }
}
