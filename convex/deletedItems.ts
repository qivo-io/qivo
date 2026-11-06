/* Deleted items, the Settings page every role has (design 6), and its
 * background work. model/deletedItems.ts holds the rules: how deleting
 * moves a task or a project into the trash, who sees and restores what, the
 * step machine, restoring and purging. model/deletedItemsList.ts projects
 * the rows, model/deletedItemsPage.ts reads the page, and
 * model/deletedItemsChoices.ts what the page shows beside its entries.
 *
 * page answers the Settings page one page of 25 entries at a time, project
 * entries first, with its filters and search applied on the server, as the
 * app reads it from the release after v0.1.148. list and matches stay for
 * apps loaded before that release, and item for the app's holder of a
 * blocked row and its watch of a deferred item. All four read every active
 * seat of the login
 * (authedQuery), as Archived projects does, and show each item only as the
 * seat in its own organization may see it (model/deletedItems.ts viewOf);
 * page reads one organization's seat when its scope names one. An
 * organization admin keeps every item that is not purging and reads its
 * tasks as their role reads them, every task until the admin access split
 * and after it only the tasks their ordinary access reaches, with a hidden
 * row for a task item whose root they cannot read. roles answers each
 * seat's role, people the people of one organization a batch at a time for
 * Deleted by and the assignee filter, and purgeSummary what Delete now
 * deletes with a project item, so the page needs no roster or loaded list
 * beside its entries; the app reads them with page. restore and purge act
 * in one organization and load each id through myItem, the same rule: an
 * unknown id, another organization's item and one hidden from the caller
 * all answer not_found, before any state or permission reason. They answer
 * per item and never throw for one item's problem.
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
import { vDeletedItemKind } from './lib/enums'
import { adminMutation, authedQuery, orgMutation, rule } from './lib/functions'
import { LIMITS } from './lib/limits'
import {
  clearOrgTrash,
  detachArchivedChildren,
  expireItems,
  myItem,
  purgeItems,
  recoverArchivedDetaches,
  recoverJobs,
  restoreItems,
  runStep,
} from './model/deletedItems'
import {
  type DeletedPeople,
  type DeletedRole,
  type PurgeSummary,
  peopleBatch,
  purgeSummaryOf,
  rolesFor,
} from './model/deletedItemsChoices'
import { listFor, matchesFor, rowFor } from './model/deletedItemsList'
import { type DeletedPage, pageFor } from './model/deletedItemsPage'

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

/* ------------------------------------------------------------------- page
 * One page of Deleted items (model/deletedItemsPage.ts): at most `limit`
 * entries (a whole number from 1 to 25, 25 when absent), project entries
 * first and then task entries, each newest first, with `items`, the row of
 * each item an entry names, once. Without `scope` it reads every seat's
 * project entries, and answers `scope_needed` unless `kind` is project; a
 * scope names one organization and some of its projects (1 to 50 ids, a
 * top-level project standing for its sub-projects) or all of them, and
 * lists that scope's project entries and then its task entries. `kind`,
 * `deleted_by` (a profile id) with `via` ('app', a credential table, which
 * matches every delete through that kind of credential, or `table:id`,
 * which matches only where the caller may know the credential),
 * `someone` (the deletes of people no longer in the organization, without
 * `deleted_by` or `via`), `search` (every word matches, the last also as a
 * prefix, accents exact; a task reference finds its task) and `assignee`
 * (a profile id, needs a scope) apply before the page is cut. Pass
 * `next_cursor` back as `cursor` with the same arguments until it is null;
 * a page may hold fewer entries, even none, while it is not. `too_wide`
 * asks a caller who is no organization admin for a narrower scope,
 * `missing` says that entries before the last one may be missing, and
 * `legacy` that tasks deleted before this release are found by key and
 * title only. An organization without the caller's seat, and a scope that
 * names nothing the caller sees, answer an empty last page alike. */
export const page = authedQuery({
  args: {
    scope: v.optional(
      v.union(
        v.object({ org_id: v.string(), project_ids: v.array(v.string()) }),
        v.object({ org_id: v.string(), all: v.literal(true) }),
      ),
    ),
    kind: v.optional(vDeletedItemKind),
    search: v.optional(v.string()),
    deleted_by: v.optional(v.string()),
    via: v.optional(v.string()),
    someone: v.optional(v.literal(true)),
    assignee: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<DeletedPage> => await pageFor(ctx, ctx.myProfiles, a),
})

/* ------------------------------------------------------------------ roles
 * Each active seat of the login with its organization, its role in
 * Deleted items and whether Delete now applies there
 * (model/deletedItemsChoices.ts rolesFor). `admin` sees every delete,
 * `lead` its own and those in projects it leads, live, archived or in
 * Deleted items, and `user` its own. Seats come in no particular order; the
 * client orders them and words the subtitle. */
export const roles = authedQuery({
  args: {},
  handler: async (ctx): Promise<DeletedRole[]> => await rolesFor(ctx, ctx.myProfiles.values()),
})

/* ----------------------------------------------------------------- people
 * One batch of at most 25 of an organization's people and agents in name
 * order, for the Deleted by choices and the assignee filter
 * (model/deletedItemsChoices.ts peopleBatch), for any active seat of the
 * login there. `search` keeps those whose name holds every word of it,
 * ignoring case and accents, and `cursor` is an earlier batch's `next` for
 * the same organization and search. An organization without the caller's
 * seat answers an empty last batch; `not_ready` waits for the name keys,
 * and `stopped` says the read budget ended the batch early. Refuses a
 * search longer than LIMITS.search and a cursor of another organization or
 * search. */
export const people = authedQuery({
  args: { org_id: v.string(), search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<DeletedPeople> => await peopleBatch(ctx, ctx.myProfiles, a),
})

/* ----------------------------------------------------------- purgeSummary
 * How many items Delete now deletes with one item, for an organization
 * admin's seat of the login (model/deletedItemsChoices.ts purgeSummaryOf),
 * counted through the ranges its purge reads, exactly or, past a read
 * bound, at least (`exact: false`). A task item deletes nothing with it.
 * Null for an unknown, another organization's, purging, moving or restoring
 * item and for any seat but an admin's alike. */
export const purgeSummary = authedQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<PurgeSummary | null> =>
    await purgeSummaryOf(ctx, ctx.myProfiles, id),
})

/* ------------------------------------------------------------------- list
 * The Deleted items page as apps before the release after v0.1.148 read
 * it, kept for them until a later release removes it: the rows every seat
 * of the login sees, newest
 * first, at most 2,000 per organization, fewer once the call spent its read
 * budget (model/deletedItemsList.ts LIST); `capped` when more may exist.
 * `deleted_by` lists one person's deletes only, a profile id. */
export const list = authedQuery({
  args: { deleted_by: v.optional(v.string()) },
  handler: async (ctx, { deleted_by }) => await listFor(ctx, ctx.myProfiles.values(), deleted_by),
})

/* ------------------------------------------------------------------- item
 * One item's row as the list would show it, or null when the caller does
 * not see it, the same answer for unknown, hidden and other organizations'
 * ids. For the project item a blocked row waits for, when the page on
 * screen does not hold it, and for the store's watch of an item a restore
 * deferred until it can be sent again. */
export const item = authedQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => await rowFor(ctx, ctx.myProfiles.values(), id),
})

/* ---------------------------------------------------------------- matches
 * The search of apps before the release after v0.1.148, kept for them
 * until a later release removes it. Deleted tasks the caller sees
 * whose task key or title matches `text`, the
 * roots and subtasks of task items and the tasks inside deleted projects,
 * at most 50, fewer once the call spent the same read budget, and `capped`
 * when more may match. Each comes back with its item, whose kind
 * `item_kind` names, so a capped list still finds older items, and a
 * subtask of a task item with its root's key and title unless the match is
 * redacted, and with the key alone where the item is hidden from an admin
 * after the admin access split. */
export const matches = authedQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => await matchesFor(ctx, ctx.myProfiles.values(), text),
})

/* ---------------------------------------------------------------- restore
 * Restores up to 25 items (model/deletedItems.ts restoreItems). Each id is
 * restored (an item too large for this call goes on in steps, is in
 * `stepping` too, and its row shows Restoring), refused with its reason, deferred until a project item
 * in the same call has come back, or not_found. `bulk` marks a call as one
 * of a restore of several items, which the client splits per organization
 * and 25 ids at a time, so that a call holding one task item sends no
 * Restored notice (design 5.4). */
export const restore = orgMutation({
  args: { ids: v.array(v.string()), bulk: v.optional(v.boolean()) },
  handler: async (ctx, { ids, bulk }) => {
    if (ids.length > LIMITS.restoreBatch.max) throw rule(LIMITS.restoreBatch.refusal)
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
    if (ids.length > LIMITS.purgeBatch.max) throw rule(LIMITS.purgeBatch.refusal)
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

/** One step of detaching the archived children a deleted task left behind
 * (model/deletedItems.ts detachArchivedChildren). */
export const detachArchived = internalMutation({
  args: { job_id: v.id('archived_detaches') },
  handler: async (ctx, { job_id }): Promise<null> => {
    await detachArchivedChildren(ctx, job_id)
    return null
  },
})

/** Restarts stalled jobs and detach steps (model/deletedItems.ts
 * recoverJobs, recoverArchivedDetaches). */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await recoverJobs(ctx)
    await recoverArchivedDetaches(ctx)
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
    if (items.length > LIMITS.purgeBatch.max) throw rule(LIMITS.purgeBatch.refusal)
    const { purged, refused } = await purgeItems(ctx, items)
    return { purged: purged.length, waiting: refused.length }
  },
})
