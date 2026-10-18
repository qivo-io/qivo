/* Deleted items, the Settings page every role has (design 6), and its
 * background work. model/deletedItems.ts holds the rules: how deleting
 * moves a task or a project into the trash, who sees and restores what, the
 * step machine, restoring and purging. model/deletedItemsList.ts projects
 * the rows.
 *
 * list and matches read every active seat of the login (authedQuery), as
 * Archived projects does, and show each item only as the seat in its own
 * organization may see it (model/deletedItems.ts viewOf). restore and purge
 * act in one organization and load each id through myItem, the same rule:
 * an unknown id, another organization's item and one hidden from the
 * caller all answer not_found, before any state or permission reason. They
 * answer per item and never throw for one item's problem.
 *
 * step runs one bounded step of an item's job, whatever its phase (moving,
 * restoring or purging), and schedules the next. recover (every minute,
 * crons.ts) restarts a job whose step stopped, at half the budget each
 * time, and after its last retry makes an item stuck, or sends a restore
 * back to moving so the item is ready again, or, once a restored project is
 * live, leaves the tasks still waiting for their parent without it. expire
 * (daily at 03:45 UTC) starts purging the ready items whose 30 days are
 * over, one bounded page per run, and schedules the next page while more
 * are due. Items keep expiring while their organization is read-only
 * before its deletion. Once that deletion has begun (orgRemovals.ts), step,
 * recover and expire leave the organization's items and jobs alone, and the
 * deletion's trash phase deletes them (model/orgDeletion.ts).
 *
 * purgeOrg and purgeTasks are deploy-key seams for fixtures and live
 * drives, refused on production and public demo deployments like
 * machine/testing.ts. */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type QueryCtx } from './_generated/server'
import { refuseProduction } from './lib/deployment'
import { adminMutation, authedQuery, orgMutation, rule } from './lib/functions'
import {
  clearOrgTrash,
  expireItems,
  myItem,
  PURGE_MAX,
  purgeItems,
  RESTORE_MAX,
  recoverJobs,
  restoreItems,
  runStep,
} from './model/deletedItems'
import { listFor, matchesFor } from './model/deletedItemsList'

/* The items `ids` names that `me` can see, once each, and the other ids,
 * which answer not_found whether they are unknown, in another organization
 * or hidden from `me`. */
async function loadItems(ctx: QueryCtx, me: Doc<'profiles'>, ids: string[]) {
  const items: Doc<'deleted_items'>[] = []
  const missing: { id: string; reason: 'not_found' }[] = []
  for (const id of new Set(ids)) {
    const item = await myItem(ctx, me, id)
    if (item === null) missing.push({ id, reason: 'not_found' })
    else items.push(item)
  }
  return { items, missing }
}

/* ------------------------------------------------------------------- list
 * The Deleted items page: the rows every seat of the login sees, newest
 * first, at most 2,000 per organization, fewer once the call spent its read
 * budget (model/deletedItemsList.ts LIST); `capped` when more may exist.
 * `deleted_by` lists one person's deletes only, a profile id. */
export const list = authedQuery({
  args: { deleted_by: v.optional(v.string()) },
  handler: async (ctx, { deleted_by }) => await listFor(ctx, ctx.myProfiles.values(), deleted_by),
})

/* ---------------------------------------------------------------- matches
 * Deleted tasks the caller sees whose task key or title matches `text`, the
 * roots and subtasks of task items and the tasks inside deleted projects,
 * at most 50, fewer once the call spent the same read budget. Each comes
 * back with its item, whose kind `item_kind` names, so a capped list still
 * finds older items, and a subtask of a task item with its root's key and
 * title unless the match is redacted. */
export const matches = authedQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => await matchesFor(ctx, ctx.myProfiles.values(), text),
})

/* ---------------------------------------------------------------- restore
 * Restores up to 25 items (model/deletedItems.ts restoreItems). Each id is
 * restored (an item too large for this call goes on in steps, and its row
 * shows Restoring), refused with its reason, deferred until a project item
 * in the same call has come back, or not_found. `bulk` marks a call as one
 * of a restore of several items, which the client splits per organization
 * and 25 ids at a time, so that a call holding one task item sends no
 * Restored notice (design 5.4). */
export const restore = orgMutation({
  args: { ids: v.array(v.string()), bulk: v.optional(v.boolean()) },
  handler: async (ctx, { ids, bulk }) => {
    if (ids.length > RESTORE_MAX)
      throw rule(`at most ${RESTORE_MAX} items can be restored at a time`)
    const { items, missing } = await loadItems(ctx, ctx.me, ids)
    const result = await restoreItems(ctx, {
      me: ctx.me,
      items,
      now: new Date().toISOString(),
      bulk,
    })
    return { ...result, refused: [...missing, ...result.refused] }
  },
})

/* ------------------------------------------------------------------ purge
 * Delete now: an organization admin deletes up to 25 ready or stuck items
 * for good (model/deletedItems.ts purgeItems). Each id is purged, refused
 * while it moves or restores, or not_found. No webhook events. */
export const purge = adminMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    if (ids.length > PURGE_MAX)
      throw rule(`at most ${PURGE_MAX} items can be deleted for good at a time`)
    const { items, missing } = await loadItems(ctx, ctx.me, ids)
    const result = await purgeItems(ctx, items)
    return { ...result, refused: [...missing, ...result.refused] }
  },
})

const expireArgs = {
  cursor: v.optional(v.string()), // where the next page starts
  now: v.optional(v.number()), // the run's start, epoch milliseconds
}
const expireRef = makeFunctionReference<'mutation', ObjectType<typeof expireArgs>, null>(
  'deletedItems:expire',
)

/** One step of a deleted item's job. Safe to run twice or after the item is gone. */
export const step = internalMutation({
  args: { item_id: v.string() },
  handler: async (ctx, { item_id }): Promise<null> => {
    await runStep(ctx, item_id)
    return null
  },
})

/** Restarts stalled jobs (model/deletedItems.ts recoverJobs). */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await recoverJobs(ctx)
    return null
  },
})

/** Starts purging one page of expired items and chains the next. Empty
 * arguments start a run, as the nightly cron does; each page reads up to
 * the run's start. */
export const expire = internalMutation({
  args: expireArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? Date.now()
    const cursor = await expireItems(ctx, { cursor: a.cursor, now })
    if (cursor !== null) await ctx.scheduler.runAfter(0, expireRef, { cursor, now })
    return null
  },
})

/** What one purgeOrg call deletes at most: `batch` rows and about `bytes`
 * of them. A stored row can hold a document of almost 1 MiB, so a batch
 * counted in rows alone could read past Convex's 16 MiB, and every retry
 * would fail on the same rows. 4 MiB leaves the margin an organization's
 * deletion in steps leaves (model/cascade.ts REMOVAL_BUDGET) for the rows a
 * call reads past its last check. */
export const PURGE_ORG = { batch: 256, bytes: 4 * 1024 * 1024 }

/* Deletes everything an organization keeps in Deleted items for good,
 * whatever state its items are in, one bounded batch per call
 * (model/deletedItems.ts clearOrgTrash). The Northstar fixture CLI
 * (scripts/marketing-demo.mjs) calls it until it answers done before a wipe
 * or a reset, because the wipe refuses while the organization has Deleted
 * items: their tasks keep numbers the wipe hands out again, and an item
 * still moving keeps tasks under projects the wipe cannot reach. */
export const purgeOrg = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<{ done: boolean }> => {
    refuseProduction('deletedItems:purgeOrg')
    const budget = { left: PURGE_ORG.batch, bytes: PURGE_ORG.bytes }
    return { done: await clearOrgTrash(ctx, org_id, budget) }
  },
})

/* Deletes for good the Deleted items whose root is one of `task_ids`, as
 * an admin's Delete now does (model/deletedItems.ts purgeItems), for the
 * live browser drives (scripts/browser-demo.mjs) that delete their own
 * temporary tasks in the shared development organization and must not leave
 * them in its Deleted items for 30 days. At most 25 ids. `waiting` counts
 * the items still moving or restoring, which a drive's small deletes never
 * leave. */
export const purgeTasks = internalMutation({
  args: { task_ids: v.array(v.string()) },
  handler: async (ctx, { task_ids }): Promise<{ purged: number; waiting: number }> => {
    refuseProduction('deletedItems:purgeTasks')
    const items: Doc<'deleted_items'>[] = []
    for (const id of new Set(task_ids))
      for (const item of await ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', id))
        .collect())
        if (item.kind === 'task' && item.state !== 'purging') items.push(item)
    const { purged, refused } = await purgeItems(ctx, items)
    return { purged: purged.length, waiting: refused.length }
  },
})
