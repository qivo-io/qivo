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
 * time, and makes an item stuck after its last retry. expire (daily at
 * 03:45 UTC) starts purging the ready items whose 30 days are over, one
 * bounded batch per run, and schedules the next run while more are due. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type QueryCtx } from './_generated/server'
import { adminMutation, authedQuery, orgMutation, rule } from './lib/functions'
import {
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
 * first, at most 2,000 per organization (`capped` when more may exist).
 * `deleted_by` lists one person's deletes only, a profile id. */
export const list = authedQuery({
  args: { deleted_by: v.optional(v.string()) },
  handler: async (ctx, { deleted_by }) => await listFor(ctx, ctx.myProfiles.values(), deleted_by),
})

/* ---------------------------------------------------------------- matches
 * Tasks inside the deleted projects the caller sees whose task key or title
 * matches `text`, at most 50; each comes back with its project item. */
export const matches = authedQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => await matchesFor(ctx, ctx.myProfiles.values(), text),
})

/* ---------------------------------------------------------------- restore
 * Restores up to 25 items (model/deletedItems.ts restoreItems). Each id is
 * restored (an item too large for this call goes on in steps, and its row
 * shows Restoring), refused with its reason, deferred until a project item
 * in the same call has come back, or not_found. */
export const restore = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    if (ids.length > RESTORE_MAX)
      throw rule(`at most ${RESTORE_MAX} items can be restored at a time`)
    const { items, missing } = await loadItems(ctx, ctx.me, ids)
    const result = await restoreItems(ctx, {
      me: ctx.me,
      items,
      now: new Date().toISOString(),
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

const expireRef = makeFunctionReference<'mutation', Record<string, never>, null>(
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

/** Starts purging one batch of expired items and chains the next. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (await expireItems(ctx)) await ctx.scheduler.runAfter(0, expireRef, {})
    return null
  },
})
