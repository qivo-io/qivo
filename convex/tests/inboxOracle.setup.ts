/* A test oracle of what a seat's Inbox holds, folded whole from its stored
 * messages by the rule the removed workspace inbox part followed, with no
 * walk, cap or budget of its own: every message to the seat about a task of
 * its working set (lib/access.ts accessOf holds), unread rows newest first
 * and read rows most recently read first, grouped by task. The parity
 * cases of the unread summary (inboxReads.test.ts) and the Inbox pages
 * (inboxPage.test.ts) compare with it, and t3/limits-machine-inbox's
 * parity takes it next. It reads every message of the seat, so it serves
 * only fixtures of everyday size, such as Northstar.
 *
 * Named *.setup.ts, as two dots in the basename is the Convex CLI's skip
 * rule (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import { accessOf } from '../lib/access'
import { byId } from '../lib/db'
import { newestFirst } from '../lib/inbox'
import type { T } from './helpers.setup'

/** A seat's Inbox as the oracle folds it. */
export type OracleInbox = {
  /** unread messages about shown tasks, newest first */
  unread: Doc<'messages'>[]
  /** read messages about shown tasks, most recently read first */
  read: Doc<'messages'>[]
  /** every shown message, unread first, by task */
  byTask: Map<string, Doc<'messages'>[]>
}

/* Most recently read first, then newest first. */
const recentlyRead = (a: Doc<'messages'>, b: Doc<'messages'>): number => {
  const ra = a.read_at ?? ''
  const rb = b.read_at ?? ''
  if (ra !== rb) return ra < rb ? 1 : -1
  return newestFirst(a, b)
}

/** What seat `me`'s Inbox holds, read whole in one transaction. */
export async function oracleInbox(t: T, me: Doc<'profiles'>): Promise<OracleInbox> {
  const kept = await t.run(async (ctx) => {
    const access = accessOf(ctx, me)
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
      .collect()
    const shown = new Map<string, boolean>()
    for (const id of new Set(rows.map((m) => m.issue_id))) {
      const task = await byId(ctx, 'issues', id)
      shown.set(id, task !== null && task.org_id === me.org_id && (await access.holds(task)))
    }
    return rows.filter((m) => shown.get(m.issue_id))
  })
  const unread = kept.filter((m) => m.read_at === undefined).sort(newestFirst)
  const read = kept.filter((m) => m.read_at !== undefined).sort(recentlyRead)
  const byTask = new Map<string, Doc<'messages'>[]>()
  for (const m of [...unread, ...read])
    byTask.set(m.issue_id, [...(byTask.get(m.issue_id) ?? []), m])
  return { unread, read, byTask }
}
