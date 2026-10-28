/* Inbox items (schema.ts inbox_items): one row per (recipient, task) pair of
 * messages, kept exact by every message write, and the build state that
 * says which of a recipient's rows are complete (inbox_state).
 *
 * Every field of a row is a function of its pair's messages (itemOf). A
 * message writer makes its writes through one ItemEdits (itemEdits), which
 * remembers each message as it was before its first change and after its
 * last, and calls flush once its writes are done. flush moves each touched
 * row by the difference. Counts move by it alone. The newest message
 * changes only when a message arrives, which flush compares, or when the
 * newest one is deleted, which reads the pair's newest unread message and
 * its read ones, which the prune keeps to one (newestOf). A new item's row
 * is made from its arrival, and a row that is missing or does not add up is
 * built from all the item's messages. So a writer reads, besides what it
 * read before, the item's row and its recipient's build state, and those
 * few messages when it deletes the newest one.
 *
 * The build gate. A recipient's rows are complete for a task when its
 * inbox_state is built, or built_through has reached the task's id
 * (covers). flush keeps only such rows. internal/inboxItemsBackfill builds
 * a recipient's rows in task id order and moves built_through in the
 * transaction that reads the messages it built from, and every flush reads
 * the state, so Convex orders each write wholly before or after a build: a
 * write before it is in the messages the build reads, and a write after it
 * sees the new state and keeps the row. A recipient without messages and
 * without a state row gets one, built, with its first message
 * (ensureInboxState), so a profile created after the backfill needs none.
 *
 * Teardowns delete a task's or a recipient's rows after its messages
 * (taskItems, recipientItems, stateRows). Until then a row can count
 * messages already deleted, which readers never show, because the task or
 * the recipient is gone. */

import type { WithoutSystemFields } from 'convex/server'
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import type { MessageKind } from '../lib/enums'
import { newestFirst } from '../lib/inbox'

/** One inbox item: a recipient's messages about one task. */
export type Pair = { recipient_id: string; issue_id: string }

type Message = Doc<'messages'>
type MessageFields = WithoutSystemFields<Message>

/** An inbox_items row as itemOf builds it. */
export type ItemFields = WithoutSystemFields<Doc<'inbox_items'>>

/** The field of inbox_items that counts each kind of message. */
const KIND_FIELD = {
  mention: 'mentions',
  change: 'changes',
  comment: 'comments',
} as const satisfies Record<MessageKind, keyof ItemFields>

type Counts = Pick<ItemFields, (typeof KIND_FIELD)[MessageKind]>

/* The message fields an item is made of. */
type Tracked = Pick<
  Message,
  '_id' | 'id' | 'kind' | 'created_at' | 'read_at' | 'dropped' | 'snoozed_until' | 'woke_at'
>

/** A message as an ItemEdits writes it: what its item is made of, and which
 * item it is in. */
export type Written = Tracked & Pick<Message, 'recipient_id' | 'issue_id'>

/* Every message of one inbox item. */
const pairMessages = (ctx: QueryCtx, pair: Pair): Promise<Message[]> =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id),
    )
    .collect()

/** The stored row of one inbox item, or null. */
export const itemRow = (ctx: QueryCtx, pair: Pair): Promise<Doc<'inbox_items'> | null> =>
  ctx.db
    .query('inbox_items')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id),
    )
    .first()

/** Task `issueId`'s inbox_items rows, every recipient's, for a teardown. */
export const taskItems = (ctx: QueryCtx, issueId: string) =>
  ctx.db.query('inbox_items').withIndex('by_issue_project', (q) => q.eq('issue_id', issueId))

/** Profile `profileId`'s inbox_items rows, for a teardown. */
export const recipientItems = (ctx: QueryCtx, profileId: string) =>
  ctx.db
    .query('inbox_items')
    .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', profileId))

/** Profile `profileId`'s inbox_state row as a range, for a teardown. */
export const stateRows = (ctx: QueryCtx, profileId: string) =>
  ctx.db.query('inbox_state').withIndex('by_profile', (q) => q.eq('profile_id', profileId))

/** The fields derived from the others: the two flags the indexes need and
 * the list order. */
function derived(
  row: Pick<ItemFields, 'unread_count' | 'snoozed_until' | 'woke_at' | 'latest_at'>,
): Pick<ItemFields, 'unread' | 'snoozed' | 'sort_at'> {
  return {
    unread: row.unread_count > 0,
    snoozed: row.snoozed_until !== undefined,
    sort_at: row.woke_at !== undefined && row.woke_at > row.latest_at ? row.woke_at : row.latest_at,
  }
}

/**
 * The inbox_items row that the messages `rows` of `pair` make, or null when
 * there are none. `projectId` is the task's project, absent for a task not
 * live. This is the definition every writer keeps the stored row equal to:
 * the newest message by (created_at, id), as the prune and the app order
 * them, its snooze, the unread count, the dropped counts of the unread
 * messages, the messages of each kind and the latest wake's stamp, as
 * store/viewModels.ts shapeMessageGroup folds them.
 */
export function itemOf(
  pair: Pair,
  rows: readonly Tracked[],
  projectId: string | undefined,
): ItemFields | null {
  if (rows.length === 0) return null
  let latest = rows[0]
  const counts: Counts = { mentions: 0, changes: 0, comments: 0 }
  let unread = 0
  let dropped = 0
  let wokeRows = 0
  let woke: string | undefined
  for (const r of rows) {
    if (newestFirst(r, latest) < 0) latest = r
    counts[KIND_FIELD[r.kind]] += 1
    if (r.read_at === undefined) {
      unread += 1
      dropped += r.dropped ?? 0
    }
    if (r.woke_at !== undefined) {
      wokeRows += 1
      if (woke === undefined || r.woke_at > woke) woke = r.woke_at
    }
  }
  const row = {
    ...pair,
    project_id: projectId,
    latest_id: latest.id,
    latest_at: latest.created_at,
    unread_count: unread,
    dropped,
    ...counts,
    snoozed_until: latest.snoozed_until,
    woke_at: woke,
    woke_rows: wokeRows,
  }
  return { ...row, ...derived(row) }
}

/** The newest of the pair's messages by (created_at, id), or null when it
 * has none: the newest unread one, which the index orders last, against
 * the read ones, which the prune keeps to one per item. */
async function newestOf(ctx: QueryCtx, pair: Pair): Promise<Message | null> {
  let newest = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', pair.recipient_id)
        .eq('issue_id', pair.issue_id)
        .eq('read_at', undefined),
    )
    .order('desc')
    .first()
  const read = ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', pair.recipient_id)
        .eq('issue_id', pair.issue_id)
        .gt('read_at', undefined),
    )
  for await (const r of read) if (newest === null || newestFirst(r, newest) < 0) newest = r
  return newest
}

/* ------------------------------------------------------------ build gate */

/** Profile `profileId`'s inbox_state row, or null. */
export const inboxState = (ctx: QueryCtx, profileId: string) => stateRows(ctx, profileId).first()

/** What the build gate reads of an inbox_state row. */
type BuildState = Pick<Doc<'inbox_state'>, 'built' | 'built_through'>

/** Whether `state` says the recipient's row for task `issueId` is complete,
 * so that writes keep it. */
export const covers = (state: BuildState | null, issueId: string): boolean =>
  state !== null &&
  (state.built || (state.built_through !== undefined && issueId <= state.built_through))

/** The recipient's inbox_state row, adding one, built, when it has none and
 * no message either: such a recipient's rows are complete, as it has none.
 * postMessage calls it before it inserts, so a profile created after the
 * backfill keeps its items from its first message. A recipient without a
 * row whose messages came before stays unbuilt until the backfill reaches
 * it. `added` says this call added the row, so the recipient has no
 * inbox_items row yet. The demo's record limit does not count the row
 * (lib/demo.ts uncountedWriter), as for message_sweeps. */
export async function ensureInboxState(
  ctx: MutationCtx,
  profileId: string,
): Promise<{ state: BuildState | null; added: boolean }> {
  const state = await inboxState(ctx, profileId)
  if (state !== null) return { state, added: false }
  const any = await ctx.db
    .query('messages')
    .withIndex('by_recipient', (q) => q.eq('recipient_id', profileId))
    .first()
  if (any !== null) return { state: null, added: false }
  const built = { profile_id: profileId, built: true }
  await uncountedWriter(ctx.db).insert('inbox_state', built)
  return { state: built, added: true }
}

/* ----------------------------------------------------------------- edits */

/* One message's change within an ItemEdits: as it was before its first
 * change, null for one inserted here, and after its last, null for one
 * deleted here. */
type Change = { before: Tracked | null; after: Tracked | null }

/* What one ItemEdits holds for an item: its changed messages by id, the
 * project an arrival named, which the row takes, and whether the item held
 * no message before them (ItemEdits.insert `fresh`). */
type PairChanges = {
  pair: Pair
  rows: Map<Id<'messages'>, Change>
  project?: string
  fresh?: true
}

/** The message writes of one writer, made through it so that flush can keep
 * their inbox_items rows. Every insert, patch and delete of a message goes
 * through one, except the teardowns, which delete the items after the
 * messages, and profile removal's patch of actor_id, which no item reads.
 * The writer calls flush once after its last write; the Northstar seed
 * shares one between the notices of a transaction (NotifyPreload.items)
 * and flushes it once. It reads each recipient's build state once, and
 * flush reads each item's row once. */
export type ItemEdits = {
  /** Inserts a message about a task in project `projectId`. `fresh` says
   * the caller read the item and found no message in it, so flush makes its
   * row from these changes alone. */
  insert(row: MessageFields, projectId: string, fresh?: boolean): Promise<Id<'messages'>>
  /** Patches a message as ctx.db.patch does, undefined unsetting a field. */
  patch(row: Written, fields: Partial<MessageFields>): Promise<void>
  delete(row: Written): Promise<void>
  /** The recipient's inbox_state, read once per ItemEdits. postMessage
   * passes `ensure` before its insert (ensureInboxState). */
  state(profileId: string, ensure?: 'ensure'): Promise<BuildState | null>
  /** Brings the inbox_items row of every item written to in step. */
  flush(): Promise<void>
}

/* `row` with `fields` written as ctx.db.patch writes them. */
function patched(row: Tracked, fields: Partial<MessageFields>): Tracked {
  const out: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out as Tracked
}

/** An ItemEdits over `ctx`. Message writes go through ctx.db, so the demo's
 * record limit counts the inserts as before, and inbox_items rows through
 * the uncounted writer, as maintenance (lib/demo.ts uncountedWriter). */
export function itemEdits(ctx: MutationCtx): ItemEdits {
  const pairs = new Map<string, PairChanges>()
  const states = new Map<string, Promise<BuildState | null>>()
  // the recipients whose state this ItemEdits added, who had no item then
  const added = new Set<string>()
  const keyOf = (pair: Pair) => JSON.stringify([pair.recipient_id, pair.issue_id])
  const changesOf = (pair: Pair): PairChanges => {
    const key = keyOf(pair)
    let found = pairs.get(key)
    if (found === undefined) {
      found = {
        pair: { recipient_id: pair.recipient_id, issue_id: pair.issue_id },
        rows: new Map(),
      }
      pairs.set(key, found)
    }
    return found
  }
  const record = (
    pair: Pair,
    id: Id<'messages'>,
    before: Tracked | null,
    after: Tracked | null,
  ) => {
    const rows = changesOf(pair).rows
    const prior = rows.get(id)
    const first = prior === undefined ? before : prior.before
    if (first === null && after === null) rows.delete(id)
    else rows.set(id, { before: first, after })
  }
  const current = (row: Written): Tracked => changesOf(row).rows.get(row._id)?.after ?? row
  const edits: ItemEdits = {
    async insert(row, projectId, fresh) {
      const changes = changesOf(row)
      // a pair written to before in this ItemEdits is not fresh to it
      if (fresh === true && changes.rows.size === 0) changes.fresh = true
      const _id = await ctx.db.insert('messages', row)
      record(row, _id, null, { ...row, _id })
      changes.project = projectId
      return _id
    },
    async patch(row, fields) {
      await ctx.db.patch(row._id, fields)
      record(row, row._id, current(row), patched(current(row), fields))
    },
    async delete(row) {
      await ctx.db.delete(row._id)
      record(row, row._id, current(row), null)
    },
    state(profileId, ensure) {
      let state = states.get(profileId)
      if (state === undefined) {
        state =
          ensure === 'ensure'
            ? ensureInboxState(ctx, profileId).then((got) => {
                if (got.added) added.add(profileId)
                return got.state
              })
            : inboxState(ctx, profileId)
        states.set(profileId, state)
      }
      return state
    },
    async flush() {
      const touched = [...pairs.values()]
      pairs.clear()
      for (const changes of touched) {
        const { pair } = changes
        if (changes.rows.size === 0) continue
        if (!covers(await edits.state(pair.recipient_id), pair.issue_id)) continue
        const item = added.has(pair.recipient_id) ? null : await itemRow(ctx, pair)
        await applyChanges(ctx, changes, item)
      }
    },
  }
  return edits
}

/* Moves one item's row, `item` as stored, by its changes
 * (ItemEdits.flush). */
async function applyChanges(
  ctx: MutationCtx,
  changes: PairChanges,
  item: Doc<'inbox_items'> | null,
): Promise<void> {
  const { pair } = changes
  if (changes.fresh) {
    // every message of the item went through this ItemEdits
    const rows = [...changes.rows.values()].flatMap((c) => (c.after === null ? [] : [c.after]))
    return await storeItem(ctx, item, itemOf(pair, rows, changes.project))
  }
  if (item === null) return await rebuild(ctx, pair, changes.project, item)
  const counts: Counts = { mentions: item.mentions, changes: item.changes, comments: item.comments }
  let unread = item.unread_count
  let dropped = item.dropped
  // the item's own stamp stays while a message it did not touch carries it
  let untouchedWoke = item.woke_rows
  let woke: string | undefined
  let wokeRows = item.woke_rows
  let latestGone = false
  let latest: Pick<Tracked, 'id' | 'created_at' | 'snoozed_until'> = {
    id: item.latest_id,
    created_at: item.latest_at,
    snoozed_until: item.snoozed_until,
  }
  for (const { before, after } of changes.rows.values()) {
    if (before !== null) {
      counts[KIND_FIELD[before.kind]] -= 1
      if (before.read_at === undefined) {
        unread -= 1
        dropped -= before.dropped ?? 0
      }
      if (before.woke_at !== undefined) {
        wokeRows -= 1
        untouchedWoke -= 1
      }
      if (after === null && before.id === item.latest_id) latestGone = true
    }
    if (after !== null) {
      counts[KIND_FIELD[after.kind]] += 1
      if (after.read_at === undefined) {
        unread += 1
        dropped += after.dropped ?? 0
      }
      if (after.woke_at !== undefined) {
        wokeRows += 1
        if (woke === undefined || after.woke_at > woke) woke = after.woke_at
      }
      // ids and created_at never change, so only an arrival can be newer
      // than the newest message, whose own changes it takes
      if (after.id === latest.id || newestFirst(after, latest) < 0) latest = after
    }
  }
  const total = counts.mentions + counts.changes + counts.comments
  if (Math.min(total, unread, dropped, wokeRows, untouchedWoke) < 0 || unread > total) {
    // the row was not what its messages make, so it is made again from them
    return await rebuild(ctx, pair, changes.project ?? item.project_id, item)
  }
  if (total === 0) return await storeItem(ctx, item, null)
  // an arrival newer than the deleted newest message is the newest still
  if (latestGone && latest.id === item.latest_id) {
    const newest = await newestOf(ctx, pair)
    if (newest === null) return await storeItem(ctx, item, null)
    latest = newest
  }
  if (
    untouchedWoke > 0 &&
    item.woke_at !== undefined &&
    (woke === undefined || item.woke_at > woke)
  )
    woke = item.woke_at
  const base = {
    project_id: changes.project ?? item.project_id,
    latest_id: latest.id,
    latest_at: latest.created_at,
    unread_count: unread,
    dropped,
    ...counts,
    snoozed_until: latest.snoozed_until,
    woke_at: wokeRows > 0 ? woke : undefined,
    woke_rows: wokeRows,
  }
  const next = { ...base, ...derived(base) }
  if ((Object.keys(next) as (keyof typeof next)[]).some((key) => next[key] !== item[key]))
    await ctx.db.patch(item._id, next)
}

/** Stores `built` as the item's row in place of `stored`, the row read
 * before, or deletes the row when `built` is null. */
export async function storeItem(
  ctx: MutationCtx,
  stored: Doc<'inbox_items'> | null,
  built: ItemFields | null,
): Promise<void> {
  if (built === null) {
    if (stored !== null) await ctx.db.delete(stored._id)
  } else if (stored === null) {
    await uncountedWriter(ctx.db).insert('inbox_items', built)
  } else {
    await ctx.db.replace(stored._id, built)
  }
}

/* Builds the pair's row from all its messages in place of `stored`, the
 * row read before. `projectId` is the task's project when the caller knows
 * it; otherwise the task is read. */
async function rebuild(
  ctx: MutationCtx,
  pair: Pair,
  projectId: string | undefined,
  stored: Doc<'inbox_items'> | null,
): Promise<void> {
  const rows = await pairMessages(ctx, pair)
  const project = projectId ?? (await byId(ctx, 'issues', pair.issue_id))?.project_id
  return await storeItem(ctx, stored, itemOf(pair, rows, project))
}

/* ---------------------------------------------------------------- re-key */

/** How many inbox_items rows a move re-keys in its own transaction
 * (`inline`), of how many of its tasks at most (`inlineTasks`, two index
 * ranges each), how many rows each background step after it re-keys
 * (`step`), how many tasks one step visits at most (`tasks`), and the
 * bytes of tasks a step reads before it leaves the rest to the next
 * (`bytes`). A task followed by hundreds of people has as many rows, a move
 * carries its subtasks too, and a task can be about 60 KB within TEXT_MAX.
 * Tests lower them. */
export const REKEY = {
  inline: 128,
  inlineTasks: 8,
  step: 1000,
  tasks: 256,
  bytes: 4 * 1024 * 1024,
}

/* The background step in convex/messages.ts, referenced by name like the
 * other inbox steps. */
const rekeyRef = makeFunctionReference<'mutation', { issues: string[] }, null>(
  'messages:rekeyItems',
)

/* Gives up to `budget` of task `issueId`'s rows project `projectId`, the
 * task's. Two ranges of by_issue_project hold just the rows keyed to
 * another project, those below it and those above, an absent one first.
 * Returns how many it wrote and whether any are left. */
async function rekeyTask(
  ctx: MutationCtx,
  issueId: string,
  projectId: string,
  budget: number,
): Promise<{ written: number; more: boolean }> {
  let written = 0
  for (const range of [
    () =>
      ctx.db
        .query('inbox_items')
        .withIndex('by_issue_project', (q) =>
          q.eq('issue_id', issueId).lt('project_id', projectId),
        ),
    () =>
      ctx.db
        .query('inbox_items')
        .withIndex('by_issue_project', (q) =>
          q.eq('issue_id', issueId).gt('project_id', projectId),
        ),
  ]) {
    const room = budget - written
    const rows = await range().take(room + 1)
    for (const row of rows.slice(0, room)) {
      await ctx.db.patch(row._id, { project_id: projectId })
      written += 1
    }
    if (rows.length > room) return { written, more: true }
  }
  return { written, more: false }
}

/**
 * Re-keys the inbox_items rows of the tasks `issueIds`, which a move just
 * gave project `projectId` in this transaction, up to REKEY.inline rows of
 * the first REKEY.inlineTasks tasks, and schedules background steps for the
 * rest (rekeyStep). It reads no task: the move read them already. Until a
 * step runs, a row keeps the old project, so readers check the task.
 */
export async function rekeyItems(
  ctx: MutationCtx,
  issueIds: readonly string[],
  projectId: string,
): Promise<void> {
  let left = REKEY.inline
  for (const [i, issueId] of issueIds.entries()) {
    if (left === 0 || i === REKEY.inlineTasks) {
      await scheduleRekeys(ctx, issueIds.slice(i))
      return
    }
    const done = await rekeyTask(ctx, issueId, projectId, left)
    left -= done.written
    if (done.more) {
      await scheduleRekeys(ctx, issueIds.slice(i))
      return
    }
  }
}

/* Schedules rekeyStep for `issueIds`, REKEY.tasks of them a step. */
async function scheduleRekeys(ctx: MutationCtx, issueIds: readonly string[]): Promise<void> {
  for (let i = 0; i < issueIds.length; i += REKEY.tasks) {
    await ctx.scheduler.runAfter(0, rekeyRef, { issues: issueIds.slice(i, i + REKEY.tasks) })
  }
}

/** One background step of rekeyItems: gives the rows of the tasks
 * `issueIds`, in order, each task's project as it reads it now, so a later
 * move meanwhile wins, up to REKEY.step rows and REKEY.bytes of tasks, and
 * schedules the next step with the tasks left. A task gone meanwhile is
 * skipped; its rows go with its messages. */
export async function rekeyStep(ctx: MutationCtx, issueIds: readonly string[]): Promise<void> {
  let left = REKEY.step
  let bytes = 0
  for (const [i, issueId] of issueIds.entries()) {
    if (left === 0 || bytes >= REKEY.bytes) {
      await scheduleRekeys(ctx, issueIds.slice(i))
      return
    }
    const task = await byId(ctx, 'issues', issueId)
    if (task === null) continue
    bytes += getDocumentSize(task)
    const done = await rekeyTask(ctx, task.id, task.project_id, left)
    left -= done.written
    if (done.more) {
      await scheduleRekeys(ctx, issueIds.slice(i))
      return
    }
  }
}
