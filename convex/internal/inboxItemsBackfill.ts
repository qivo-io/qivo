/* One-time migration: build the inbox_items rows (schema.ts) of every
 * profile whose messages were stored before them, and mark its inbox_state
 * built, so that a later release can list an inbox by its items. Until then
 * nothing reads the items: the app, REST and MCP read the messages as
 * before. A profile whose first message came after this release keeps its
 * items from the start (model/inboxItems.ts ensureInboxState) and needs
 * nothing.
 *
 * A profile is built in steps, each its own transaction, in task id order
 * (messages.by_recipient_issue). A step builds the items of the next tasks
 * from all their messages, deletes the rows of that range that no message
 * makes, records the last task in the profile's inbox_state
 * (`built_through`), and once no task is left sets `built`. Message writes
 * keep an item only for a task at or below `built_through`
 * (model/inboxItems.ts covers), and a step reads the messages it builds
 * from and moves the state in one transaction. So every write lands wholly
 * before a step, in the messages it reads, or after it, and then keeps the
 * item the step built. A write that lands while a step runs makes Convex
 * run one of them again. A step reads one item at least, and starts another
 * only while the transaction has used less than BUILD.room of each of
 * Convex's limits, as the deployment counts every read.
 *
 * An item with more than BUILD.pair_rows messages is too large to read in
 * one step. Only an item that grew before the item cap existed
 * (model/messages.ts ITEM_UNREAD_CAP) can be that large, and its next
 * arrivals would trim it toward the cap anyway. A step trims it as they
 * would (trimUnreadMessages), up to BUILD.trims times, each trim counting
 * what it deleted in the item's `dropped`, and a later step builds it once
 * it fits. An item that still does not fit when no trim deletes anything
 * more stops its profile, which a run lists as stuck and leaves unbuilt.
 *
 * After the profiles, a run deletes the inbox_items and inbox_state rows of
 * profiles that are gone, which only an earlier release's removal leaves.
 *
 * Read the dry run first. It writes nothing. It reports the items a run
 * would build and their messages, the items too large to build without a
 * trim, the rows of profiles that are gone, and, for the tasks a profile's
 * state already covers, every row that differs from its messages, is
 * missing or has no messages, which a deployment that ran an earlier
 * release can hold. Then run it. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": false}'
 * A call checks RUN.ms, well inside Convex's action time limit, before
 * every step and page, and past it answers `done: false` with a `cursor`,
 * which goes on inside the profile it stopped in. Call it again with the
 * same arguments and `"cursor"` set to the answered value, as it came,
 * until `done` is true. Then confirm that `remaining` reports no profile on
 * any page, passing its `cursor` back until `done`, and that a dry run
 * reports no `differing`, `missing`, `extra` or `orphan_rows`. `check` lists
 * the rows of one profile that differ:
 *   "$H" staging npx convex run internal/inboxItemsBackfill:remaining '{}'
 *   "$H" staging npx convex run internal/inboxItemsBackfill:check '{"profile_id": "<uuid>"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key: `remaining` and `check` need
 * deployment:functions:runInternalQueries, and `run`, an internal action,
 * deployment:functions:runInternalActions. A rehearsal belongs on a
 * disposable --local backend.
 *
 * A run builds the profiles not built yet and leaves the others as they
 * are. When a dry run reports rows that differ, are missing or are extra,
 * for example after the deployment ran an earlier release that did not
 * keep them, `"rebuild": true` builds every profile with messages or a
 * state again from its messages, resetting each once however many calls it
 * takes; read its dry run first too:
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": false, "rebuild": true}'
 *
 * A call that wrote adds one platform_audit_log row (action
 * 'inbox_items_backfill', actor 'system') with its counts and its cursor,
 * also when a step throws, with the error, so the next call can go on from
 * there. Running it again is safe, because a built profile is skipped. It
 * writes no activity, sends no task event and changes nothing a person
 * sees, except that an item it trims lists fewer of its oldest unread
 * messages and counts them as dropped, as the item's next message would
 * have. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId, usedMoreThan } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import { badRequest } from '../lib/functions'
import { audit as writeAudit } from '../model/admin'
import {
  covers,
  type ItemFields,
  inboxState,
  itemOf,
  itemRow,
  type Pair,
  storeItem,
} from '../model/inboxItems'
import { trimUnreadMessages } from '../model/messages'

/** The sizes of one step: the most items it builds or checks (`pairs`),
 * the share of each of Convex's limits for one transaction it may have used
 * before it starts no further item or trim (`room`, as the deployment
 * counts every read, lib/db.ts usedMoreThan), the most messages an item may
 * have to be built in one step (`pair_rows`), and the most trims a step
 * makes of an item with more (`trims`). An item reads at most `pair_rows`
 * messages of a few KB each and its task, about 1 MiB at most, so a step
 * that starts one below `room` stays well inside Convex's 16 MiB. A step
 * always reads one item, so it always gets on. Tests lower them. */
export const BUILD = { pairs: 200, room: 0.25, pair_rows: 1000, trims: 20 }

/** Profiles one page of a run reads, how long one call of run goes on
 * before it answers where to go on from, and the most profiles or items a
 * result lists. Tests lower them. */
export const RUN = { profiles: 100, ms: 5 * 60_000, listed: 100 }

/* The first message of the profile's next item after task `after`, or of
 * its first item without `after`, or null when no item is left. */
const nextMessage = (ctx: QueryCtx, profileId: string, after: string | undefined) =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      after === undefined
        ? q.eq('recipient_id', profileId)
        : q.eq('recipient_id', profileId).gt('issue_id', after),
    )
    .first()

/* The item's messages, at most one more than BUILD.pair_rows. */
const pairRows = (ctx: QueryCtx, pair: Pair) =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id),
    )
    .take(BUILD.pair_rows + 1)

/** What one walk over a profile's items found: how many it read, how many
 * messages they hold, which were too large to build without a trim, and
 * the task to go on after, null once no item is left. */
type Walk = { items: number; messages: number; oversized: string[]; next: string | null }

/** Reads one step's worth of the profile's items after task `after`, and
 * calls `each` with each item as its messages make it, with its task's
 * project. It stops at an item too large to build, listed in `oversized`.
 * It reads one item at least, and another only while the transaction has
 * used less than BUILD.room of each limit. With `until` it reads no item
 * past that task and goes on after it (`next`) even when no item is left. */
async function walk(
  ctx: QueryCtx,
  profileId: string,
  after: string | undefined,
  each: (pair: Pair, item: ItemFields, rows: number) => Promise<void>,
  until?: string,
): Promise<Walk> {
  const out: Walk = { items: 0, messages: 0, oversized: [], next: after ?? null }
  let through = after
  while (out.items < BUILD.pairs) {
    if (out.items > 0 && (await usedMoreThan(ctx, BUILD.room))) return out
    const first = await nextMessage(ctx, profileId, through)
    if (until !== undefined && (first === null || first.issue_id > until))
      return { ...out, next: until }
    if (first === null) return { ...out, next: null }
    const pair = { recipient_id: profileId, issue_id: first.issue_id }
    through = pair.issue_id
    out.next = through
    const rows = await pairRows(ctx, pair)
    if (rows.length > BUILD.pair_rows) {
      out.oversized.push(pair.issue_id)
      return out
    }
    const task = await byId(ctx, 'issues', pair.issue_id)
    out.items += 1
    out.messages += rows.length
    // the pair has a message, so it makes an item
    await each(pair, itemOf(pair, rows, task?.project_id) as ItemFields, rows.length)
  }
  return out
}

/* The profile's inbox_items rows for the tasks after `after`, up to and
 * with `through`, or to the end with null. */
const pageItems = (
  ctx: QueryCtx,
  profileId: string,
  after: string | undefined,
  through: string | null,
) =>
  ctx.db.query('inbox_items').withIndex('by_recipient_issue', (q) => {
    const mine = q.eq('recipient_id', profileId)
    if (after === undefined) return through === null ? mine : mine.lte('issue_id', through)
    const from = mine.gt('issue_id', after)
    return through === null ? from : from.lte('issue_id', through)
  })

/** What one build step did: the items it built, the messages it trimmed,
 * whether the profile is built now, and the item it stopped at as stuck. */
type StepResult = { items: number; trimmed: number; done: boolean; stuck: string | null }

/** One build step of the profile, in its own transaction: builds its next
 * items from their messages, or trims the next one first when it is too
 * large, deletes the rows of its range that no message makes, and moves its
 * inbox_state. A built profile, or one that is gone, whose rows go with it,
 * is done. */
export const step = internalMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<StepResult> => {
    const result: StepResult = { items: 0, trimmed: 0, done: true, stuck: null }
    if ((await byId(ctx, 'profiles', profile_id)) === null) return result
    const state = await inboxState(ctx, profile_id)
    if (state?.built) return result
    const after = state?.built_through
    let last = after
    const seen = new Set<string>()
    const walked = await walk(ctx, profile_id, after, async (pair, item) => {
      last = pair.issue_id
      seen.add(pair.issue_id)
      await storeItem(ctx, await itemRow(ctx, pair), item)
      result.items += 1
    })
    // an item trimmed here is built by a later step, so the state stops
    // below it, at the last item built
    let through = last
    result.done = walked.next === null
    // rows of the built range that no message makes, which a rebuild or a
    // half-built profile whose messages went meets: deleted, BUILD.pairs a
    // step, and the state stays where it was until none is left
    if (result.done || through !== after) {
      const rows = await pageItems(
        ctx,
        profile_id,
        after,
        result.done ? null : (through ?? null),
      ).take(2 * BUILD.pairs + 1)
      const stale = rows.filter((row) => !seen.has(row.issue_id))
      for (const row of stale.slice(0, BUILD.pairs)) await ctx.db.delete(row._id)
      if (stale.length > BUILD.pairs || rows.length > 2 * BUILD.pairs) {
        result.done = false
        through = after
      }
    }
    const big = walked.oversized[0]
    if (big !== undefined) {
      // one trim at least, then more while the room lasts
      for (let i = 0; i < BUILD.trims; i++) {
        if (i > 0 && (await usedMoreThan(ctx, BUILD.room))) break
        const gone = await trimUnreadMessages(ctx, { recipient_id: profile_id, issue_id: big })
        result.trimmed += gone
        if (gone === 0) break
      }
      if (result.trimmed === 0) result.stuck = big
    }
    const next = { built: result.done, built_through: result.done ? undefined : through }
    if (state === null) await uncountedWriter(ctx.db).insert('inbox_state', { profile_id, ...next })
    else await ctx.db.patch(state._id, next)
    return result
  },
})

/** Starts the profile's build again from its first task, for a rebuild:
 * until its steps reach a task, writes leave that task's item alone, and
 * the steps build every item again from the messages and delete the rows
 * no message makes. A profile that is gone gets no state: its rows go with
 * it, and the orphan steps delete any left. */
export const reset = internalMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
    if ((await byId(ctx, 'profiles', profile_id)) === null) return null
    const state = await inboxState(ctx, profile_id)
    if (state === null)
      await uncountedWriter(ctx.db).insert('inbox_state', { profile_id, built: false })
    else await ctx.db.patch(state._id, { built: false, built_through: undefined })
    return null
  },
})

/** A profile as a run sees it. */
type ProfileState = {
  profile_id: string
  built: boolean
  built_through: string | null
  has_state: boolean
  has_messages: boolean
}

/* The profile's state. */
async function stateOf(ctx: QueryCtx, profile: Doc<'profiles'>): Promise<ProfileState> {
  const state = await inboxState(ctx, profile.id)
  const any = await ctx.db
    .query('messages')
    .withIndex('by_recipient', (q) => q.eq('recipient_id', profile.id))
    .first()
  return {
    profile_id: profile.id,
    built: state?.built ?? false,
    built_through: state?.built_through ?? null,
    has_state: state !== null,
    has_messages: any !== null,
  }
}

/* RUN.profiles profiles by id after `after`, and whether none is left. */
async function profilesAfter(
  ctx: QueryCtx,
  after: string | null,
): Promise<{ profiles: ProfileState[]; done: boolean }> {
  const page = await ctx.db
    .query('profiles')
    .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
    .take(RUN.profiles + 1)
  const profiles: ProfileState[] = []
  for (const profile of page.slice(0, RUN.profiles)) profiles.push(await stateOf(ctx, profile))
  return { profiles, done: page.length <= RUN.profiles }
}

/** One page of profiles by id after profile `after`, with their states. */
export const profilePage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }) => await profilesAfter(ctx, after),
})

/** Whether a profile still needs a build: its items are not complete and it
 * has messages or a state. A half-built profile whose messages are all gone
 * still needs its last step, which deletes the rows left and marks it
 * built, or its later messages about tasks past `built_through` would get
 * no item. */
const due = (p: ProfileState): boolean => !p.built && (p.has_messages || p.has_state)

/** Counts, without writing, the profiles of one page of profiles, by id,
 * whose items are not built yet (due), and lists up to RUN.listed of them.
 * Leave out `cursor`, or pass null, for the first page, then call again
 * with the returned `cursor` until `done`. A deployment whose every page
 * reports 0 `profiles` has every profile built; the dry run of `run` tells
 * whether the rows of built profiles match their messages. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await profilesAfter(ctx, cursor ?? null)
    const left = page.profiles.filter(due)
    return {
      profiles: left.length,
      listed: left.slice(0, RUN.listed),
      cursor: page.done ? null : (page.profiles.at(-1)?.profile_id ?? null),
      done: page.done,
    }
  },
})

/** One stored item that differs from what its messages make, with the
 * fields that differ. */
type Difference = { issue_id: string; fields: string[] }

/** One page of a check (check). */
type Checked = {
  profile_id: string
  built: boolean
  built_through: string | null
  checked: number
  messages: number
  build: number
  found: { differ: number; missing: number; extra: number }
  differ: Difference[]
  missing: string[]
  extra: string[]
  oversized: string[]
  next: string | null
  done: boolean
}

/** The consistency check of one page of the profile's items after task
 * `after`, in one transaction, so a write cannot fall between what it
 * compares. Each item its inbox_state covers is built again from its
 * messages and its task's project and compared with its row: the rows that
 * differ (`differ`, with the fields) and the missing ones (`missing`). An
 * item the state does not cover yet is one a build makes (`build`). Rows of
 * the page's range that no message makes are `extra`. The lists hold up to
 * RUN.listed each and `found` counts them all; `oversized` lists the items
 * too large to check. Pass the returned `next` as `after` until `done`. The
 * dry run of `run`, the tests and the private helpers run it; a profile
 * whose every page finds nothing has every item exact. */
export const check = internalQuery({
  args: { profile_id: v.string(), after: v.optional(v.string()) },
  handler: async (ctx, { profile_id, after }): Promise<Checked> => {
    const state = await inboxState(ctx, profile_id)
    const differ: Difference[] = []
    const missing: string[] = []
    const extra: string[] = []
    const found = { differ: 0, missing: 0, extra: 0 }
    let build = 0
    const seen = new Set<string>()
    const list = <T>(into: T[], value: T) => {
      if (into.length < RUN.listed) into.push(value)
    }
    // the stored rows go first: a page counts the extra ones of its whole
    // range, so with more rows than one read holds it ends at the last one
    // read, and the next page goes on after it
    const cap = BUILD.pairs + RUN.listed
    const rows = await pageItems(ctx, profile_id, after, null).take(cap + 1)
    const until = rows.length > cap ? rows[cap - 1].issue_id : undefined
    const walked = await walk(
      ctx,
      profile_id,
      after,
      async (pair, item) => {
        seen.add(pair.issue_id)
        if (!covers(state, pair.issue_id)) {
          build += 1
          return
        }
        const stored = await itemRow(ctx, pair)
        if (stored === null) {
          found.missing += 1
          list(missing, pair.issue_id)
          return
        }
        const fields = (Object.keys(item) as (keyof ItemFields)[]).filter(
          (key) => item[key] !== stored[key],
        )
        for (const key of Object.keys(stored) as (keyof typeof stored)[])
          if (!key.startsWith('_') && !(key in item) && stored[key] !== undefined)
            fields.push(key as keyof ItemFields)
        if (fields.length === 0) return
        found.differ += 1
        list(differ, { issue_id: pair.issue_id, fields })
      },
      until,
    )
    // rows of the page's range of task ids that no message makes, to its end
    // once no item and no row is left
    const end = walked.next
    for (const row of rows) {
      if (end !== null && row.issue_id > end) break
      if (seen.has(row.issue_id) || walked.oversized.includes(row.issue_id)) continue
      found.extra += 1
      list(extra, row.issue_id)
    }
    return {
      profile_id,
      built: state?.built ?? false,
      built_through: state?.built_through ?? null,
      checked: walked.items,
      messages: walked.messages,
      build,
      found,
      differ,
      missing,
      extra,
      oversized: walked.oversized,
      next: walked.next,
      done: walked.next === null,
    }
  },
})

/** The two tables whose rows can outlive their profile, when an earlier
 * release removed it without them. */
const ORPHAN_TABLES = ['inbox_items', 'inbox_state'] as const
type OrphanTable = (typeof ORPHAN_TABLES)[number]
const vOrphanTable = v.union(v.literal('inbox_items'), v.literal('inbox_state'))

/** What one orphan step found: the profiles that are gone with rows left,
 * their rows it read (a dry run) or deleted, the last profile done, the
 * gone one it stopped inside (`at`, with the task to go on after in a dry
 * run) and whether the table is done. */
type OrphanResult = {
  gone: string[]
  rows: number
  after: string | null
  at: { id: string; from?: string } | null
  done: boolean
}

/* The first row of `table` past profile `after`, by profile. */
function firstPast(ctx: QueryCtx, table: OrphanTable, after: string | null) {
  if (table === 'inbox_items')
    return ctx.db
      .query('inbox_items')
      .withIndex('by_recipient_issue', (q) => (after === null ? q : q.gt('recipient_id', after)))
      .first()
  return ctx.db
    .query('inbox_state')
    .withIndex('by_profile', (q) => (after === null ? q : q.gt('profile_id', after)))
    .first()
}

/** One step over the rows of `table` by profile, from past profile `after`
 * or inside profile `at`: it skips each live profile's rows with one seek,
 * and reads (`write` null, a dry run) or deletes the rows of a profile that
 * is gone, at most BUILD.pairs of them, as long as the room lasts. */
async function orphanWalk(
  ctx: QueryCtx,
  write: MutationCtx | null,
  table: OrphanTable,
  after: string | null,
  at: { id: string; from?: string } | null,
): Promise<OrphanResult> {
  const out: OrphanResult = { gone: [], rows: 0, after, at: null, done: false }
  let inside = at
  for (let visited = 0; ; visited++) {
    if (visited > 0 && (await usedMoreThan(ctx, BUILD.room))) {
      out.at = inside
      return out
    }
    let id = inside?.id
    if (id === undefined) {
      const first = await firstPast(ctx, table, out.after)
      if (first === null) return { ...out, done: true }
      id = 'recipient_id' in first ? first.recipient_id : first.profile_id
    }
    // checked again inside one too: a profile created since with its id
    // keeps the rows, which its own build or a rebuild sets right
    if ((await byId(ctx, 'profiles', id)) !== null) {
      out.after = id
      inside = null
      continue
    }
    if (!out.gone.includes(id)) out.gone.push(id)
    const gone = id
    if (table === 'inbox_state') {
      const rows = await ctx.db
        .query('inbox_state')
        .withIndex('by_profile', (q) => q.eq('profile_id', gone))
        .collect()
      out.rows += rows.length
      if (write !== null) for (const row of rows) await write.db.delete(row._id)
      out.after = gone
      inside = null
      continue
    }
    const from = write === null ? inside?.from : undefined
    const rows = await pageItems(ctx, gone, from, null).take(BUILD.pairs + 1)
    const now = rows.slice(0, BUILD.pairs)
    out.rows += now.length
    if (write !== null) for (const row of now) await write.db.delete(row._id)
    if (rows.length > BUILD.pairs) {
      // a deleting step reads the rows left from the start again
      out.at = { id: gone, ...(write === null ? { from: now.at(-1)?.issue_id } : {}) }
      return out
    }
    out.after = gone
    inside = null
  }
}

/** One dry-run step over `table` for rows of gone profiles (orphanWalk). */
export const orphansFound = internalQuery({
  args: {
    table: vOrphanTable,
    after: v.union(v.string(), v.null()),
    at: v.union(v.object({ id: v.string(), from: v.optional(v.string()) }), v.null()),
  },
  handler: async (ctx, a): Promise<OrphanResult> =>
    await orphanWalk(ctx, null, a.table, a.after, a.at),
})

/** One step that deletes rows of `table` whose profile is gone
 * (orphanWalk). */
export const orphansDeleted = internalMutation({
  args: {
    table: vOrphanTable,
    after: v.union(v.string(), v.null()),
    at: v.union(v.object({ id: v.string(), from: v.optional(v.string()) }), v.null()),
  },
  handler: async (ctx, a): Promise<OrphanResult> =>
    await orphanWalk(ctx, ctx, a.table, a.after, a.at),
})

/** Records a call that wrote, with its counts, where it stopped, and the
 * error that stopped it if one did. */
export const audit = internalMutation({
  args: {
    profiles: v.number(),
    items: v.number(),
    trimmed: v.number(),
    stuck: v.number(),
    orphan_rows: v.number(),
    rebuild: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, detail) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'inbox_items_backfill', detail })
    return null
  },
})

const profilePageRef = makeFunctionReference<
  'query',
  { after: string | null },
  { profiles: ProfileState[]; done: boolean }
>('internal/inboxItemsBackfill:profilePage')
const checkRef = makeFunctionReference<'query', { profile_id: string; after?: string }, Checked>(
  'internal/inboxItemsBackfill:check',
)
const stepRef = makeFunctionReference<'mutation', { profile_id: string }, StepResult>(
  'internal/inboxItemsBackfill:step',
)
const resetRef = makeFunctionReference<'mutation', { profile_id: string }, null>(
  'internal/inboxItemsBackfill:reset',
)
type OrphanArgs = {
  table: OrphanTable
  after: string | null
  at: { id: string; from?: string } | null
}
const orphansFoundRef = makeFunctionReference<'query', OrphanArgs, OrphanResult>(
  'internal/inboxItemsBackfill:orphansFound',
)
const orphansDeletedRef = makeFunctionReference<'mutation', OrphanArgs, OrphanResult>(
  'internal/inboxItemsBackfill:orphansDeleted',
)
const auditRef = makeFunctionReference<
  'mutation',
  {
    profiles: number
    items: number
    trimmed: number
    stuck: number
    orphan_rows: number
    rebuild: boolean
    cursor: string | null
    error?: string
  },
  null
>('internal/inboxItemsBackfill:audit')

/** Where a run goes on from: the phase, the last profile it finished in
 * it, and the one it stopped inside (`at`): a dry run's next task in it
 * (`from`), or that a rebuild reset it already (`reset`). */
type Position = {
  phase: 'profiles' | OrphanTable
  after: string | null
  at?: { id: string; from?: string; reset?: true }
}

const PHASES: readonly Position['phase'][] = ['profiles', ...ORPHAN_TABLES]

/* The position a `cursor` names, or the start without one. */
function positionOf(cursor: string | null | undefined): Position {
  if (cursor === undefined || cursor === null) return { phase: 'profiles', after: null }
  let pos: unknown
  try {
    pos = JSON.parse(cursor)
  } catch {
    throw badRequest('cursor: not one a run answered')
  }
  const p = pos as Partial<Position> | null
  if (
    p === null ||
    typeof p !== 'object' ||
    !PHASES.includes(p.phase as Position['phase']) ||
    (p.after !== null && typeof p.after !== 'string') ||
    (p.at !== undefined && (typeof p.at !== 'object' || typeof p.at?.id !== 'string'))
  )
    throw badRequest('cursor: not one a run answered')
  return p as Position
}

/** Builds the items of every profile not built yet (due) from `cursor` on,
 * then deletes the rows of profiles that are gone, and answers what it
 * built, trimmed and deleted, listing up to RUN.listed stuck items. It
 * checks RUN.ms before every step and page, and past it answers the
 * `cursor` to go on from, which resumes inside a profile, else `done` with
 * a null cursor; pass the cursor back as it came. A call always makes one
 * step at least.
 *
 * A dry run writes nothing. It checks every profile with messages or a
 * state (check): the items a build would make (`build`) and, for the tasks
 * a state covers, the rows that differ from their messages, are missing or
 * have no messages (`differing`, `missing`, `extra`, the profiles listed in
 * `drifted`), the items too large to build without a trim (`oversized`),
 * and the rows of profiles that are gone (`orphan_rows`, their profiles in
 * `orphans`). Each comparison runs in one query, so only real drift shows,
 * such as rows an earlier release did not keep; `"rebuild": true` mends it,
 * building every profile with messages or a state again from the start
 * (reset), once per rebuild however many calls it takes.
 *
 * A call that wrote ends with its audit row, also when a step throws, with
 * the cursor to go on from and the error. */
export const run = internalAction({
  args: {
    dry_run: v.boolean(),
    rebuild: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { dry_run, rebuild = false, cursor }) => {
    const until = Date.now() + RUN.ms
    let pos = positionOf(cursor)
    const totals = {
      profiles: 0,
      items: 0,
      messages: 0,
      build: 0,
      trimmed: 0,
      differing: 0,
      missing: 0,
      extra: 0,
      orphan_rows: 0,
    }
    const oversized: Pair[] = []
    const stuck: Pair[] = []
    const drifted: string[] = []
    const orphans: string[] = []
    let oversizedCount = 0
    let stuckCount = 0
    let worked = false
    let wrote = false
    const late = () => worked && Date.now() >= until
    const listOnce = (into: string[], id: string) => {
      if (into.length < RUN.listed && !into.includes(id)) into.push(id)
    }
    const counts = (done: boolean) => ({
      profiles: totals.profiles,
      items: totals.items,
      trimmed: totals.trimmed,
      stuck: stuckCount,
      orphan_rows: totals.orphan_rows,
      rebuild,
      cursor: done ? null : JSON.stringify(pos),
    })
    const wanted = (p: ProfileState) =>
      dry_run || rebuild ? p.has_messages || p.has_state : due(p)

    /* One profile, from where `pos.at` left it. False when out of time. */
    const visit = async (profile: ProfileState): Promise<boolean> => {
      const { profile_id } = profile
      const resuming = pos.at?.id === profile_id ? pos.at : undefined
      if (!resuming) totals.profiles++
      if (dry_run) {
        let from = resuming?.from
        for (;;) {
          const got: Checked = await ctx.runQuery(checkRef, { profile_id, after: from })
          worked = true
          totals.items += got.checked
          totals.messages += got.messages
          totals.build += got.build
          totals.differing += got.found.differ
          totals.missing += got.found.missing
          totals.extra += got.found.extra
          if (got.found.differ + got.found.missing + got.found.extra > 0)
            listOnce(drifted, profile_id)
          for (const issue_id of got.oversized)
            if (oversizedCount++ < RUN.listed)
              oversized.push({ recipient_id: profile_id, issue_id })
          // an oversized item is reported, and the dry run goes on after it
          if (got.done) return true
          from = got.next ?? undefined
          pos = { ...pos, at: { id: profile_id, from } }
          if (late()) return false
        }
      }
      if (rebuild && !resuming?.reset) {
        await ctx.runMutation(resetRef, { profile_id })
        wrote = true
      }
      // a later call goes on inside this profile, from its inbox_state
      pos = { ...pos, at: { id: profile_id, ...(rebuild ? { reset: true as const } : {}) } }
      for (;;) {
        const got: StepResult = await ctx.runMutation(stepRef, { profile_id })
        worked = wrote = true
        totals.items += got.items
        totals.trimmed += got.trimmed
        if (got.stuck !== null) {
          if (stuckCount++ < RUN.listed)
            stuck.push({ recipient_id: profile_id, issue_id: got.stuck })
          return true
        }
        if (got.done) return true
        if (late()) return false
      }
    }

    let done = false
    try {
      phases: for (;;) {
        if (late()) break
        if (pos.phase === 'profiles') {
          const page = await ctx.runQuery(profilePageRef, { after: pos.after })
          for (const profile of page.profiles) {
            if (late()) break phases
            if (wanted(profile) && !(await visit(profile))) break phases
            pos = { phase: 'profiles', after: profile.profile_id }
          }
          if (page.done) pos = { phase: 'inbox_items', after: null }
          continue
        }
        const args = { table: pos.phase, after: pos.after, at: pos.at ?? null }
        const got: OrphanResult = dry_run
          ? await ctx.runQuery(orphansFoundRef, args)
          : await ctx.runMutation(orphansDeletedRef, args)
        worked = true
        if (!dry_run) wrote = true
        totals.orphan_rows += got.rows
        for (const id of got.gone) listOnce(orphans, id)
        if (got.done) {
          const next = PHASES[PHASES.indexOf(pos.phase) + 1]
          if (next === undefined) {
            done = true
            break
          }
          pos = { phase: next, after: null }
        } else {
          pos = { phase: pos.phase, after: got.after, ...(got.at ? { at: got.at } : {}) }
        }
      }
    } catch (error) {
      if (wrote)
        await ctx.runMutation(auditRef, {
          ...counts(false),
          error: error instanceof Error ? error.message : String(error),
        })
      throw error
    }
    if (!dry_run) await ctx.runMutation(auditRef, counts(done))
    return {
      dry_run,
      ...totals,
      oversized: oversizedCount,
      oversized_items: oversized,
      stuck: stuckCount,
      stuck_items: stuck,
      drifted,
      orphans,
      done,
      cursor: done ? null : JSON.stringify(pos),
    }
  },
})
