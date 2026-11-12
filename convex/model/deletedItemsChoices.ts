/* What the Deleted items page shows beside its entries, read on the server
 * so that it needs neither the workspace's roster nor a loaded list
 * (design 6.2): each seat's role, for the page's subtitle and whether
 * Deleted by shows (rolesFor, deletedItems.roles); the people who appear
 * on the items the seat sees, for the Deleted by choices and the assignee
 * filter (peopleOf, deletedItems.people); and how many items
 * Delete now deletes with a project item (purgeSummaryOf,
 * deletedItems.purgeSummary). The page's `someone` and its `via` of a
 * credential kind (model/deletedItemsPage.ts deletedAsAsked) complete the
 * Deleted by choices, so none of them comes from the rows of a page. Each
 * answer is the login's seat's in the organization it speaks of, as
 * model/deletedItems.ts viewOf judges each item, and none names a task. */

import { compareValues } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canLeadProjects } from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { limitedText } from '../lib/limitRules'
import { LIMITS, MIB } from '../lib/limits'
import { namedCeiling, readGuard } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import {
  dependentRanges,
  type ItemView,
  namesProfile,
  newMemo,
  orgReadOnly,
  sameReference,
  seesItem,
  sightOf,
  viewOf,
} from './deletedItems'
import { type Reads, spending, spent } from './deletedItemsRows'
import { type PersonRow, personRow } from './projectSettings'

type Item = Doc<'deleted_items'>
type Profile = Doc<'profiles'>

/* --------------------------------------------------------------- roles */

/** What one seat of the login sees in Deleted items, and whether Delete
 * now applies there (deletedItems.roles). */
export type DeletedRole = {
  org_id: string
  org_name: string
  /** every delete of the organization (`admin`), its own and those in
   * projects it leads (`lead`), or its own (`user`), as viewOf shows items */
  role: 'admin' | 'lead' | 'user'
  /** an organization admin's seat while the organization is not read-only,
   * as each row's can_purge says */
  can_purge: boolean
}

/**
 * Each seat of `seats`, in the order given, with its role in Deleted items.
 * An organization admin's seat is `admin`. A seat whose role may lead
 * projects (lib/access.ts canLeadProjects, so never a viewer's) is `lead`
 * when it leads a project of its organization, live or archived
 * (projects.by_lead), or when the newest stored project row that names it
 * as lead (deleted_rows.by_org_lead) belongs to an item that is not
 * purging and was deleted while this profile held the id
 * (model/deletedItems.ts namesProfile). Anyone else is `user`.
 *
 * The stored check reads that one row rather than every row of a removed
 * lead's id. A seat that reuses such an id therefore reads `user` when the
 * newest row is the earlier holder's, even if an older row names the new
 * seat, which needs a reused id and an item moved again after a failed
 * reveal. A seat whose newest stored lead row belongs to an item being
 * purged also reads `user` until that purge removes the row, even if an
 * older row names it. The role only words the page and decides whether
 * Deleted by shows; every item still goes through viewOf. A seat reads its
 * organization's row, at most two `first` reads and one item by id, and an
 * admin's whether the organization is read-only (model/deletedItems.ts
 * orgReadOnly), a fixed handful of documents whatever the organization's
 * size, so it has no case at the design size.
 */
export async function rolesFor(ctx: QueryCtx, seats: Iterable<Profile>): Promise<DeletedRole[]> {
  const memo = newMemo()
  const out: DeletedRole[] = []
  for (const me of seats) {
    const role = await roleOf(ctx, me)
    out.push({
      org_id: me.org_id,
      org_name: (await byId(ctx, 'organizations', me.org_id))?.name ?? '',
      role,
      can_purge: role === 'admin' && !(await orgReadOnly(ctx, memo, me.org_id)),
    })
  }
  return out
}

/** `me`'s role in Deleted items (rolesFor). */
async function roleOf(ctx: QueryCtx, me: Profile): Promise<DeletedRole['role']> {
  if (me.org_role === 'admin') return 'admin'
  if (!canLeadProjects(me)) return 'user'
  const live = await ctx.db
    .query('projects')
    .withIndex('by_lead', (q) => q.eq('lead_id', me.id))
    .filter((q) => q.eq(q.field('org_id'), me.org_id))
    .first()
  if (live !== null) return 'lead'
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_org_lead', (q) => q.eq('org_id', me.org_id).eq('lead_id', me.id))
    .order('desc')
    .first()
  if (stored === null) return 'user'
  const item = await byId(ctx, 'deleted_items', stored.item_id)
  return item !== null && item.state !== 'purging' && namesProfile(item, stored.lead_id, me)
    ? 'lead'
    : 'user'
}

/* -------------------------------------------------------------- people */

/**
 * What one read of the people may read past what the call read before it
 * (lib/namedPages.ts namedCeiling), checked with the transaction's metrics
 * as it reads (readGuard): the seat's sight, as a page of the list reads it
 * (model/deletedItems.ts sightOf), every item of the organization, and for
 * the assignees a range for each assignee of each item the seat sees. Past
 * it the read answers the people it found, marked as stopped early, never
 * as the whole list. tests/deletedItemsChoices.test.ts ("reads at the
 * design size") logs what the read takes. A mutable object, so tests can
 * lower it; replace `read` whole rather than change its fields.
 */
export const DELETED_PEOPLE: { read: ReadCeiling } = {
  read: { ranges: 2_400, documents: 20_000, bytes: 10 * MIB },
}

/** One person or agent of the list, as model/projectSettings.ts personRow
 * gives it, with `you` for the caller's own seat. */
export type DeletedPerson = PersonRow & { you: boolean }

/** The people of one filter (deletedItems.people), all at once, as a list's
 * one batch that ends it: `next` is always null, and `stopped` says the
 * read budget ended the walk before the last item, so more people may
 * follow. */
export type DeletedPeople = {
  state: 'ready'
  rows: DeletedPerson[]
  next: null
  stopped: boolean
}

/** What the people are asked (deletedItems.people): the organization, the
 * filter they are for, and a search. */
export type PeopleArgs = { org_id: string; of: 'deleters' | 'assignees'; search?: string }

/** Whether `view` lets its viewer read the project of `task`
 * (model/deletedItemsPage.ts shows). */
const showsTask = (view: ItemView, task: Doc<'deleted_tasks'>): boolean =>
  view.readable.some((p) => p.id === task.project_id)

/**
 * The people Deleted by (`of: 'deleters'`) or Assigned to (`'assignees'`)
 * offers the login's seat in organization `org_id`: only those who appear
 * on a deleted item the seat sees, and nobody else of the organization
 * (the owner's decision of 12 November 2026). The deleters are the people
 * who deleted an item the seat's viewOf shows. The assignees are the
 * people who hold a deleted task in a project that view lets the seat read
 * (ItemView readable), the tasks the assignee filter itself lists. A
 * profile counts only while it is the one the item named
 * (model/deletedItems.ts sameReference), so a seat that reuses a removed
 * person's id is not offered for their items. Rows are person rows in name
 * key order, ties by id, people, agents and switched-off seats alike.
 * `search` keeps those whose name holds every whitespace-separated
 * fragment of it, ignoring case and accents.
 *
 * A search longer than LIMITS.search is refused first, then an
 * organization where the login holds no active seat answers an empty list,
 * as the page answers one, before any read of the organization. It walks
 * the organization's items newest first (deleted_items.by_org_deleted) and
 * judges each as the page does. For the assignees it reads each seen
 * item's first task of each assignee (deleted_tasks.by_item_assignee), and
 * the others of an assignee only until one is in a readable project. Reads
 * within DELETED_PEOPLE, and answers `stopped` past it.
 */
export async function peopleOf(
  ctx: QueryCtx,
  seats: Map<string, Profile>,
  a: PeopleArgs,
): Promise<DeletedPeople> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const me = seats.get(a.org_id)
  if (me === undefined) return { state: 'ready', rows: [], next: null, stopped: false }
  const guard = readGuard(ctx, await namedCeiling(ctx, DELETED_PEOPLE.read))
  const sight = await sightOf(ctx, me)
  const found = new Set<string>()
  /* whether `id` still names the profile `item` named */
  const named = (id: string | undefined, item: Item): id is string =>
    id !== undefined && sameReference(sight.profiles.get(id), item)
  let stopped = !(await guard.settle())
  const items = ctx.db
    .query('deleted_items')
    .withIndex('by_org_deleted', (q) => q.eq('org_id', a.org_id))
    .order('desc')
  if (!stopped)
    walk: for await (const item of items) {
      const view = await viewOf(ctx, sight.memo, me, item)
      // the item, and what judging it read
      if (!(await guard.document(item)) || !(await guard.settle())) {
        stopped = true
        break
      }
      if (view === null) continue
      if (a.of === 'deleters') {
        if (named(item.deleted_by, item)) found.add(item.deleted_by)
        continue
      }
      // each assignee of the item's tasks once, in the order of their ids
      for (let after = ''; ; ) {
        const from = after
        if (!(await guard.range())) {
          stopped = true
          break walk
        }
        const first = await ctx.db
          .query('deleted_tasks')
          .withIndex('by_item_assignee', (q) => q.eq('item_id', item.id).gt('assignee_id', from))
          .first()
        if (first === null || first.assignee_id === undefined) break
        const who = first.assignee_id
        after = who
        if (!(await guard.document(first))) {
          stopped = true
          break walk
        }
        if (found.has(who) || !named(who, item)) continue
        if (showsTask(view, first)) {
          found.add(who)
          continue
        }
        // a task of theirs in a project the seat reads, if the item has one
        const others = ctx.db
          .query('deleted_tasks')
          .withIndex('by_item_assignee', (q) => q.eq('item_id', item.id).eq('assignee_id', who))
        for await (const task of others) {
          if (showsTask(view, task)) {
            found.add(who)
            break
          }
          if (!(await guard.document(task))) {
            stopped = true
            break walk
          }
        }
      }
    }
  const matches = allWordsMatcher(nameKey(search))
  const rows = [...found]
    .flatMap((id) => sight.profiles.get(id) ?? [])
    .filter((profile) => matches(nameKey(profile.name)))
    .sort((x, y) => compareValues([nameKey(x.name), x.id], [nameKey(y.name), y.id]))
    .map((profile) => ({ ...personRow(profile), you: profile.id === me.id }))
  return { state: 'ready', rows, next: null, stopped }
}

/* ------------------------------------------------- Delete now's summary */

/**
 * What Delete now's summary may read for one project item. `items` is the
 * most dependents it counts, and `rows`, `bytes` and `ranges` are the
 * documents, estimated bytes and index ranges it reads, each read of a
 * range being one. A project item of 71 projects opens 4 ranges a project,
 * one a kind and purgeable state (model/deletedItems.ts dependentRanges),
 * 284 ranges, and each sub-project item it finds 4 more.
 * tests/deletedItemsChoices.test.ts ("reads at the design size") logs what
 * a project item that stores 30 live and 40 archived sub-projects reads,
 * with a task item in each live one and three earlier sub-project items
 * each with one task item, and the summary counts its 36 items exactly.
 * Past any bound it answers the count so far with `exact: false`. A
 * subscription query reruns when a dependent changes state or is added,
 * inside the same bounds. A mutable object, so tests can lower it.
 */
export const PURGE_ALONG = { items: 1_000, rows: 2_000, bytes: 4 * MIB, ranges: 1_024 }

/** How many items Delete now on an item deletes with it, exactly or, past
 * PURGE_ALONG, at least (`exact: false`). */
export type PurgeSummary = { along: number; exact: boolean }

/**
 * Delete now's summary of item `id` (deletedItems.purgeSummary), for an
 * organization admin's seat of the login in the item's organization and a
 * ready or stuck item that seat sees (model/deletedItems.ts seesItem, which
 * reads no level for an admin). A task item deletes nothing with it. A
 * project item deletes the items that could never come back without it,
 * the ranges its purge drains (dependentRanges), and for each sub-project
 * item found there its own in turn, each item counted once. Items moving or
 * restoring are left out, as the purge leaves them. Unknown, foreign,
 * purging, moving and restoring items and any seat but an admin's answer
 * null alike. It counts items and names none of them, and an admin keeps
 * every item, so a stop at the bound tells nothing hidden.
 */
export async function purgeSummaryOf(
  ctx: QueryCtx,
  seats: Map<string, Profile>,
  id: string,
): Promise<PurgeSummary | null> {
  const item = await byId(ctx, 'deleted_items', id)
  if (item === null) return null
  const me = seats.get(item.org_id)
  if (me === undefined || me.org_role !== 'admin') return null
  if (item.state !== 'ready' && item.state !== 'stuck') return null
  if (!(await seesItem(ctx, newMemo(), me, item))) return null
  if (item.kind === 'task') return { along: 0, exact: true }
  return await alongOf(ctx, item)
}

/** The dependents of project item `root` and of the sub-project items
 * among them, each counted once, while PURGE_ALONG lasts. */
async function alongOf(ctx: QueryCtx, root: Item): Promise<PurgeSummary> {
  const reads: Reads = {
    rows: PURGE_ALONG.rows,
    bytes: PURGE_ALONG.bytes,
    ranges: PURGE_ALONG.ranges,
  }
  const reader = spending(ctx, reads)
  const counted = new Set<string>([root.id])
  const projects: Item[] = [root]
  for (let i = 0; i < projects.length; i++)
    for (const range of dependentRanges(reader, projects[i])) {
      if (spent(reads)) return { along: counted.size - 1, exact: false }
      for await (const dependent of range) {
        if (!counted.has(dependent.id)) {
          counted.add(dependent.id)
          if (dependent.kind === 'project') projects.push(dependent)
        }
        if (counted.size - 1 >= PURGE_ALONG.items || spent(reads))
          return { along: counted.size - 1, exact: false }
      }
    }
  return { along: counted.size - 1, exact: true }
}
