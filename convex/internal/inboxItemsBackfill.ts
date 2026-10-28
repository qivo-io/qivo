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
 * from all their messages, records the last of those tasks in the
 * profile's inbox_state (`built_through`), and once no task is left sets
 * `built`. Message writes keep an item only for a task at or below
 * `built_through` (model/inboxItems.ts covers), and a step reads the
 * messages it builds from and moves the state in one transaction. So every
 * write lands wholly before a step, in the messages it reads, or after it,
 * and then keeps the item the step built. A write that lands while a step
 * runs makes Convex run one of them again.
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
 * Read the dry run first. It writes nothing and reports, for the profiles
 * not built yet, their items and messages and the items too large to build
 * without a trim. Then run it. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. Then confirm
 * that `remaining` reports no profile on any page, passing its `cursor`
 * back until `done`, and spot-check profiles with `check`, which builds
 * their items again from the messages without writing and lists every one
 * that differs from its row:
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
 * are. When `check` lists rows that differ, for example after the
 * deployment ran an earlier release that did not keep them, `"rebuild":
 * true` builds every profile again from its messages, deleting the rows no
 * message makes; read its dry run first too:
 *   "$H" staging npx convex run internal/inboxItemsBackfill:run '{"dry_run": false, "rebuild": true}'
 *
 * A call that wrote adds one platform_audit_log row (action
 * 'inbox_items_backfill', actor 'system') with its counts. Running it again
 * is safe, because a built profile is skipped. It writes no activity, sends
 * no task event and changes nothing a person sees, except that an item it
 * trims lists fewer of its oldest unread messages and counts them as
 * dropped, as the item's next message would have. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import { MIB } from '../lib/limits'
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

/** The sizes of one step: the most items it builds or checks, the bytes of
 * messages and tasks it reads before it starts no further item, as Convex
 * counts a document's size, the most messages an item may have to be built
 * in one step, and the most trims a step makes of an item with more. A
 * message is at most a few KB and a task about 1 MiB, so a step stays well
 * inside Convex's 16 MiB. Tests lower them. */
export const BUILD = { pairs: 200, bytes: 4 * MIB, pair_rows: 1000, trims: 20 }

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

/* The bytes of `docs` as Convex counts them. */
const bytesOf = (docs: readonly (Doc<'messages'> | Doc<'issues'> | null)[]): number =>
  docs.reduce((n, doc) => n + (doc === null ? 0 : getDocumentSize(doc)), 0)

/** What one walk over a profile's items found: how many it read, how many
 * messages they hold, which were too large to build without a trim, and
 * the task to go on after, null once no item is left. */
type Walk = { items: number; messages: number; oversized: string[]; next: string | null }

/* The item `pair` as its messages make it, with its task's project, and
 * the bytes read, or 'oversized' when it has more than BUILD.pair_rows. */
async function expected(
  ctx: QueryCtx,
  pair: Pair,
): Promise<{ item: ItemFields | null; messages: number; bytes: number } | 'oversized'> {
  const rows = await pairRows(ctx, pair)
  if (rows.length > BUILD.pair_rows) return 'oversized'
  const task = await byId(ctx, 'issues', pair.issue_id)
  return {
    item: itemOf(pair, rows, task?.project_id),
    messages: rows.length,
    bytes: bytesOf([...rows, task]),
  }
}

/** Reads one step's worth of the profile's items after task `after`, as a
 * build step would, without writing, and calls `each` with each item as
 * its messages make it. It stops at an item too large to build, listed in
 * `oversized`, so a dry run reports it and goes on after it. */
async function walk(
  ctx: QueryCtx,
  profileId: string,
  after: string | undefined,
  each: (pair: Pair, item: ItemFields | null) => Promise<void>,
): Promise<Walk> {
  const out: Walk = { items: 0, messages: 0, oversized: [], next: after ?? null }
  let bytes = 0
  let through = after
  while (out.items < BUILD.pairs && bytes < BUILD.bytes) {
    const first = await nextMessage(ctx, profileId, through)
    if (first === null) return { ...out, next: null }
    const pair = { recipient_id: profileId, issue_id: first.issue_id }
    through = pair.issue_id
    out.next = through
    const built = await expected(ctx, pair)
    if (built === 'oversized') {
      out.oversized.push(pair.issue_id)
      return out
    }
    bytes += built.bytes
    out.items += 1
    out.messages += built.messages
    await each(pair, built.item)
  }
  return out
}

/** One page of a dry run of the profile: what a build would read from task
 * `after` on, without writing. */
export const survey = internalQuery({
  args: { profile_id: v.string(), after: v.optional(v.string()) },
  handler: async (ctx, { profile_id, after }): Promise<Walk> =>
    await walk(ctx, profile_id, after, async () => {}),
})

/** What one build step did: the items it built, the messages it trimmed,
 * whether the profile is built now, and the item it stopped at as stuck. */
type StepResult = { items: number; trimmed: number; done: boolean; stuck: string | null }

/** One build step of the profile, in its own transaction: builds its next
 * items from their messages, or trims the next one first when it is too
 * large, and moves its inbox_state. A built profile, or one that is gone,
 * whose messages go with it, is done. */
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
    // rows of the built range that no message makes, which only a rebuild
    // meets: deleted, BUILD.pairs a step, and the state stays where it was
    // until none is left
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
      for (let i = 0; i < BUILD.trims; i++) {
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
 * no message makes. */
export const reset = internalMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
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

/** One page of profiles, by id, with their states. */
type ProfilePage = { profiles: ProfileState[]; cursor: string; done: boolean }

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

/** One page of profiles, by id, with their states. */
export const profilePage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<ProfilePage> => {
    const page = await ctx.db
      .query('profiles')
      .withIndex('by_uuid')
      .paginate({ cursor, numItems: RUN.profiles })
    const profiles: ProfileState[] = []
    for (const profile of page.page) profiles.push(await stateOf(ctx, profile))
    return { profiles, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Whether a profile still needs a build: it has messages and its items
 * are not complete. A profile without messages has nothing to build. */
const due = (p: ProfileState): boolean => !p.built && p.has_messages

/** Counts, without writing, the profiles of one page of profiles, by id,
 * whose items are not built yet, and lists up to RUN.listed of them. Leave
 * out `cursor`, or pass null, for the first page, then call again with the
 * returned `cursor` until `done`. A deployment whose every page reports 0
 * `profiles` has every item built. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('profiles')
      .withIndex('by_uuid')
      .paginate({ cursor: cursor ?? null, numItems: RUN.profiles })
    const left: ProfileState[] = []
    for (const profile of page.page) {
      const state = await stateOf(ctx, profile)
      if (due(state)) left.push(state)
    }
    return {
      profiles: left.length,
      listed: left.slice(0, RUN.listed),
      cursor: page.continueCursor,
      done: page.isDone,
    }
  },
})

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

/** One stored item that differs from what its messages make, with the
 * fields that differ. */
type Difference = { issue_id: string; fields: string[] }

/** The consistency check of one page of the profile's items after task
 * `after`: each item whose inbox_state covers it is built again from its
 * messages and its task's project and compared with its row. It lists the
 * items whose row differs (`differ`, with the fields), whose row is
 * missing (`missing`), and the rows of this page that no message makes or
 * whose task the state does not cover (`extra`), up to RUN.listed each, and
 * the items too large to check (`oversized`). Pass the returned `next` as
 * `after` until `done`. The tests and the private helpers run it; a
 * profile whose every page lists nothing has every item exact. */
export const check = internalQuery({
  args: { profile_id: v.string(), after: v.optional(v.string()) },
  handler: async (ctx, { profile_id, after }) => {
    const state = await inboxState(ctx, profile_id)
    const differ: Difference[] = []
    const missing: string[] = []
    const extra: string[] = []
    const seen = new Set<string>()
    const list = <T>(into: T[], value: T) => {
      if (into.length < RUN.listed) into.push(value)
    }
    const walked = await walk(ctx, profile_id, after, async (pair, item) => {
      seen.add(pair.issue_id)
      const stored = await itemRow(ctx, pair)
      if (!covers(state, pair.issue_id) || item === null) {
        if (stored !== null) list(extra, pair.issue_id)
        return
      }
      if (stored === null) {
        list(missing, pair.issue_id)
        return
      }
      const fields = (Object.keys(item) as (keyof ItemFields)[]).filter(
        (key) => item[key] !== stored[key],
      )
      for (const key of Object.keys(stored) as (keyof typeof stored)[])
        if (!key.startsWith('_') && !(key in item) && stored[key] !== undefined)
          fields.push(key as keyof ItemFields)
      if (fields.length > 0) list(differ, { issue_id: pair.issue_id, fields })
    })
    // rows between the items walked, or after the last one, that no message
    // makes: the page's range of task ids, to its end once no item is left
    const rows = await pageItems(ctx, profile_id, after, walked.next).take(BUILD.pairs + RUN.listed)
    for (const row of rows) {
      if (!seen.has(row.issue_id) && !walked.oversized.includes(row.issue_id))
        list(extra, row.issue_id)
    }
    return {
      profile_id,
      built: state?.built ?? false,
      built_through: state?.built_through ?? null,
      checked: walked.items,
      differ,
      missing,
      extra,
      oversized: walked.oversized,
      next: walked.next,
      done: walked.next === null,
    }
  },
})

/** Records a call that wrote, with its counts. */
export const audit = internalMutation({
  args: {
    profiles: v.number(),
    items: v.number(),
    trimmed: v.number(),
    stuck: v.number(),
    rebuild: v.boolean(),
  },
  handler: async (ctx, counts) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'inbox_items_backfill', detail: counts })
    return null
  },
})

const profilePageRef = makeFunctionReference<'query', { cursor: string | null }, ProfilePage>(
  'internal/inboxItemsBackfill:profilePage',
)
const surveyRef = makeFunctionReference<'query', { profile_id: string; after?: string }, Walk>(
  'internal/inboxItemsBackfill:survey',
)
const stepRef = makeFunctionReference<'mutation', { profile_id: string }, StepResult>(
  'internal/inboxItemsBackfill:step',
)
const resetRef = makeFunctionReference<'mutation', { profile_id: string }, null>(
  'internal/inboxItemsBackfill:reset',
)
const auditRef = makeFunctionReference<
  'mutation',
  { profiles: number; items: number; trimmed: number; stuck: number; rebuild: boolean },
  null
>('internal/inboxItemsBackfill:audit')

/** Builds the items of every profile not built yet, from `cursor` on, and
 * answers how many profiles and items it built and how many messages it
 * trimmed, listing up to RUN.listed stuck profiles. A dry run writes
 * nothing: it answers how many profiles, items and messages a run would
 * build, and lists the items too large to build without a trim
 * (`oversized`). Past RUN.ms it stops between profiles or steps and answers
 * the `cursor` to go on from, else `done`. `"rebuild": true` builds every
 * profile with messages or a build state again from the start (reset),
 * which mends the items a check lists as differing, for example after a
 * deployment ran an earlier release that did not keep them; pass it again
 * with the `cursor`. A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), rebuild: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, rebuild = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { visited: 0, profiles: 0, items: 0, messages: 0, trimmed: 0 }
    const oversized: Pair[] = []
    const stuck: Pair[] = []
    let oversizedCount = 0
    let stuckCount = 0
    let cursor: string | null = from ?? null
    let done = false
    // a call out of time inside a page answers the page's own cursor, and the
    // next call passes the profiles it built, which are skipped
    let late = false
    for (;;) {
      const page: ProfilePage = await ctx.runQuery(profilePageRef, { cursor })
      for (const profile of page.profiles) {
        // a call builds at least one profile, so a run always gets on
        if (Date.now() >= until && totals.profiles > 0) {
          late = true
          break
        }
        totals.visited++
        if (rebuild ? !profile.has_messages && !profile.has_state : !due(profile)) continue
        totals.profiles++
        const { profile_id } = profile
        if (dry_run) {
          let after = rebuild ? undefined : (profile.built_through ?? undefined)
          for (;;) {
            const got: Walk = await ctx.runQuery(surveyRef, { profile_id, after })
            totals.items += got.items
            totals.messages += got.messages
            for (const issue_id of got.oversized)
              if (oversizedCount++ < RUN.listed)
                oversized.push({ recipient_id: profile_id, issue_id })
            if (got.next === null) break
            after = got.next
          }
          continue
        }
        // a profile a rebuild visited is built again when a later call
        // passes it, so a cursor from the middle of a page resets it once
        // more, which costs a build and changes nothing
        if (rebuild) await ctx.runMutation(resetRef, { profile_id })
        for (;;) {
          const got: StepResult = await ctx.runMutation(stepRef, { profile_id })
          totals.items += got.items
          totals.trimmed += got.trimmed
          if (got.stuck !== null) {
            if (stuckCount++ < RUN.listed)
              stuck.push({ recipient_id: profile_id, issue_id: got.stuck })
            break
          }
          if (got.done) break
          if (Date.now() >= until) {
            late = true
            break
          }
        }
        if (late) break
      }
      if (late) break
      done = page.done
      cursor = page.cursor
      if (done || Date.now() >= until) break
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        profiles: totals.profiles,
        items: totals.items,
        trimmed: totals.trimmed,
        stuck: stuckCount,
        rebuild,
      })
    return {
      dry_run,
      ...totals,
      oversized: oversizedCount,
      oversized_items: oversized,
      stuck: stuckCount,
      stuck_items: stuck,
      done,
      cursor: done ? null : cursor,
    }
  },
})
