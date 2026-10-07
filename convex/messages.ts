/* Inbox writes (phase 5): read_at, snoozed_until and delete — the client's
 * WHOLE message write surface (rows are created only by model/messages'
 * notify family; everything else is immutable by not appearing in any
 * validator).
 *
 * Own rows only, silently: the RLS filter's successor skips non-own and
 * unknown ids without a trace (the client pre-filters anyway), so a probe
 * learns nothing and a stale id is not an error.
 *
 * markRead then restores 0109's invariant per DISTINCT (recipient, issue)
 * pair among the rows it marked — the statement trigger fired once per
 * pair. markUnread prunes nothing ("Mark-as-unread … correctly does
 * nothing", 0109:122). markAllRead visits bounded batches beyond the
 * snapshot cap, keeping the first batch's server-selected cutoff.
 * There is no boot sweep_my_read_messages; the nightly sweep is phase 9's
 * cron. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { badRequest, orgMutation } from './lib/functions'
import { pruneReadMessages, wakeSnoozedItem } from './model/messages'

/* P.markMessagesRead. One `now` stamps every row of the act. */
export const markRead = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = new Date().toISOString()
    const seen = new Set<string>()
    const issues = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const row = await byId(ctx, 'messages', id)
      if (row === null || row.recipient_id !== ctx.me.id) continue
      if (row.read_at !== undefined) continue // already read; not re-stamped
      await ctx.db.patch(row._id, { read_at: now })
      issues.add(row.issue_id)
    }
    for (const issue_id of issues) {
      await pruneReadMessages(ctx, { recipient_id: ctx.me.id, issue_id })
    }
    return null
  },
})

/* P.markAllMessagesRead. The cutoff is the newest stored unread row at the
 * first call, not the browser clock or the notification's narrated date.
 * Reusing it across batches leaves later arrivals unread. The prune reads
 * at most 256 newly stamped rows plus one retained read row per affected
 * task, and seeks each task's newest unread directly in the index. It never
 * scans that task's whole unread backlog. Already-read stamps stay intact. */
export const markAllRead = orgMutation({
  args: { before: v.optional(v.number()) },
  handler: async (ctx, { before }) => {
    const latest =
      before === undefined
        ? await ctx.db
            .query('messages')
            .withIndex('by_recipient_read', (q) =>
              q.eq('recipient_id', ctx.me.id).eq('read_at', undefined),
            )
            .order('desc')
            .first()
        : null
    const cutoff = before ?? latest?._creationTime ?? 0
    // Snoozed items are hidden, so a bulk act never reaches them (they would
    // otherwise return already read). Filtered inside the scan, not after
    // take(), so a page of snoozed rows can never stall the batch loop.
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', ctx.me.id).eq('read_at', undefined).lte('_creationTime', cutoff),
      )
      .filter((q) => q.eq(q.field('snoozed_until'), undefined))
      .take(257)
    const batch = rows.slice(0, 256)
    const now = new Date().toISOString()
    for (const row of batch) await ctx.db.patch(row._id, { read_at: now })
    for (const issue_id of new Set(batch.map((row) => row.issue_id))) {
      const newestUnread = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue_read_order', (q) =>
          q.eq('recipient_id', ctx.me.id).eq('issue_id', issue_id).eq('read_at', undefined),
        )
        .order('desc')
        .first()
      // The shared prune invariant guarantees at most one pre-existing read
      // row. This batch added at most 256 more, so this bounded read is complete.
      const read = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue_read_order', (q) =>
          q.eq('recipient_id', ctx.me.id).eq('issue_id', issue_id).gt('read_at', undefined),
        )
        .take(257)
      let newest = newestUnread ?? read[0]
      for (const row of read) {
        if (
          row.created_at > newest.created_at ||
          (row.created_at === newest.created_at && row.id > newest.id)
        )
          newest = row
      }
      for (const row of read) {
        if (row._id !== newest._id) await ctx.db.delete(row._id)
      }
    }
    return { marked: batch.length, hasMore: rows.length > 256, before: cutoff }
  },
})

/* P.markMessagesUnread — the same column, the other way. No prune: the rows
 * it re-opens are no longer read, which is exactly what the prune asks. */
export const markUnread = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const row = await byId(ctx, 'messages', id)
      if (row === null || row.recipient_id !== ctx.me.id) continue
      if (row.read_at === undefined) continue
      await ctx.db.patch(row._id, { read_at: undefined })
    }
    return null
  },
})

/* P.deleteMessages — removing an item removes every message in it; the
 * caller passes the whole list (P.messageGroups' ids). */
export const remove = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const row = await byId(ctx, 'messages', id)
      if (row === null || row.recipient_id !== ctx.me.id) continue
      await ctx.db.delete(row._id)
    }
    return null
  },
})

/* Read cleanup is independent of the snapshot's 500-message display limit.
 * Each bounded batch selects the current read rows, so a message reopened
 * by another device survives. The caller repeats while hasMore is true. */
export const removeRead = orgMutation({
  args: {},
  handler: async (ctx) => {
    // a snoozed row that was read meanwhile is a pending reminder, not clutter
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', ctx.me.id).gt('read_at', undefined),
      )
      .filter((q) => q.eq(q.field('snoozed_until'), undefined))
      .take(257)
    const batch = rows.slice(0, 256)
    for (const row of batch) await ctx.db.delete(row._id)
    return { removed: batch.length, hasMore: rows.length > 256 }
  },
})

/* P.snoozeMessages. Hides an item until `until` on every client at once, or
 * lifts the snooze early (null). Either way the item ends up UNREAD: a
 * snoozed row is a reminder, and a reminder that returns already read is
 * easy to miss. The ids name the item; the write covers the WHOLE
 * (recipient, issue) pair, loaded or not, so every row keeps the same stamp.
 * The return trip is the scheduled wake below — a server event, so the
 * laptop that snoozed and the phone that did not see the row come back at
 * the same instant, and a closed phone finds it back the moment it opens. */
const MAX_SNOOZE_MS = 366 * 86_400_000
export const snooze = orgMutation({
  args: { ids: v.array(v.string()), until: v.union(v.string(), v.null()) },
  handler: async (ctx, { ids, until }) => {
    let at: string | null = null
    if (until !== null) {
      const ms = Date.parse(until)
      if (Number.isNaN(ms)) throw badRequest('snooze: until must be an ISO instant')
      if (ms <= Date.now()) throw badRequest('snooze: until must be in the future')
      if (ms > Date.now() + MAX_SNOOZE_MS) throw badRequest('snooze: at most a year ahead')
      at = new Date(ms).toISOString() // normalized, so the wake's equality holds
    }
    const issues = new Set<string>()
    for (const id of new Set(ids)) {
      const row = await byId(ctx, 'messages', id)
      if (row === null || row.recipient_id !== ctx.me.id) continue
      issues.add(row.issue_id)
    }
    for (const issue_id of issues) {
      const pair = { recipient_id: ctx.me.id, issue_id }
      const rows = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id),
        )
        .collect()
      if (at === null) {
        // an early return is a wake without the stamp: the person asked for
        // it here and now, so nothing needs floating or announcing
        for (const row of rows) {
          if (row.snoozed_until === undefined) continue
          await ctx.db.patch(row._id, { snoozed_until: undefined, read_at: undefined })
        }
        continue
      }
      for (const row of rows) {
        await ctx.db.patch(row._id, { snoozed_until: at, read_at: undefined, woke_at: undefined })
      }
      await ctx.scheduler.runAt(Date.parse(at), wakeRef, { ...pair, until: at })
    }
    return null
  },
})

/* The scheduled end of a snooze. Self-referenced by name, as roadmap:expire
 * is, to keep the module's own `internal` type out of its own inference. */
const wakeRef = makeFunctionReference<
  'mutation',
  { recipient_id: string; issue_id: string; until: string },
  null
>('messages:wake')
export const wake = internalMutation({
  args: { recipient_id: v.string(), issue_id: v.string(), until: v.string() },
  handler: async (ctx, a) => {
    await wakeSnoozedItem(ctx, a, new Date().toISOString())
    return null
  },
})
