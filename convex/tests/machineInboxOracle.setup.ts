/* The oracle of the machine Inbox suite (machineInbox.test.ts): the read REST
 * GET /v1/inbox and MCP list_inbox made before they paged through the
 * Inbox walk, folded from the caller's messages read whole
 * (messages.by_recipient), so it is complete for any inbox a test plants.
 * A task is shown by the old rule: of the caller's organization, not
 * archived, in a project the caller can see (lib/access.ts canSeeProject)
 * that is not archived (lib/workingSet.ts inWorkingSet). Actors are named from the organization's profiles. Two
 * dots in the basename keep the Convex CLI from deploying this module, as
 * helpers.setup.ts. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canSeeProject } from '../lib/access'
import { taskRefOf } from '../lib/core'
import { byId } from '../lib/db'
import { inWorkingSet } from '../lib/workingSet'

/** One message of an inbox item, as REST and MCP answer it. */
export type OracleMessage = {
  id: string
  kind: Doc<'messages'>['kind']
  detail: string
  actor_id: string | null
  actor_name: string | null
  created_at: string
  read_at: string | null
}

/** One inbox item, as REST and MCP answer it. */
export type OracleItem = {
  task: ReturnType<typeof taskRefOf>
  unread_count: number
  dropped_count: number
  latest_at: string
  snoozed_until: string | null
  messages: OracleMessage[]
}

/* (created_at, id), the total order the app and the prune use. */
const newerThan = (a: Doc<'messages'>, b: Doc<'messages'>): boolean =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id)

/**
 * Every inbox item of `me` the old read listed, under its filters, in the
 * walk's order: `latest_at` newest first, equal times by task id descending
 * (the old read sorted those ascending, which the pages cannot keep across
 * a cursor). Each item holds every message the caller holds about its task,
 * oldest first, its snooze from the newest message, `dropped_count` the sum
 * of the unread messages' `dropped`, and `latest_at` the newest message's
 * time or a later wake, as the old read folded them.
 */
export async function machineInboxItems(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  o: { unreadOnly: boolean; includeSnoozed: boolean },
): Promise<OracleItem[]> {
  const rows = await ctx.db
    .query('messages')
    .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
    .collect()
  const byTask = new Map<string, Doc<'messages'>[]>()
  for (const row of rows) {
    const list = byTask.get(row.issue_id)
    if (list === undefined) byTask.set(row.issue_id, [row])
    else list.push(row)
  }
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const items: OracleItem[] = []
  for (const [taskId, list] of byTask) {
    const task = await byId(ctx, 'issues', taskId)
    if (task === null || task.org_id !== me.org_id || task.archived_at !== undefined) continue
    const project = (await byId(ctx, 'projects', task.project_id)) ?? undefined
    const visible = project !== undefined && (await canSeeProject(ctx, me, project))
    if (!inWorkingSet(task, project, visible)) continue
    list.sort((a, b) => (newerThan(a, b) ? 1 : newerThan(b, a) ? -1 : 0))
    const latest = list[list.length - 1]
    // every row of an item carries the same stamp; the newest decides
    const snoozed_until = latest.snoozed_until ?? null
    if (snoozed_until !== null && !o.includeSnoozed) continue
    const unread = list.filter((m) => m.read_at === undefined)
    if (o.unreadOnly && unread.length === 0) continue
    let latest_at = latest.created_at
    for (const m of list) {
      if (m.woke_at !== undefined && m.woke_at > latest_at) latest_at = m.woke_at
    }
    items.push({
      task: taskRefOf(task),
      unread_count: unread.length,
      dropped_count: unread.reduce((n, m) => n + (m.dropped ?? 0), 0),
      latest_at,
      snoozed_until,
      messages: list.map((m) => ({
        id: m.id,
        kind: m.kind,
        detail: m.detail,
        actor_id: m.actor_id ?? null,
        actor_name: m.actor_id === undefined ? null : (names.get(m.actor_id) ?? null),
        created_at: m.created_at,
        read_at: m.read_at ?? null,
      })),
    })
  }
  return items.sort((a, b) =>
    a.latest_at !== b.latest_at
      ? a.latest_at < b.latest_at
        ? 1
        : -1
      : a.task.id < b.task.id
        ? 1
        : a.task.id > b.task.id
          ? -1
          : 0,
  )
}
