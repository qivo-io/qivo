/* What the Deleted items page shows beside its entries, read on the server
 * so that it needs neither the workspace's roster nor a loaded list
 * (design 6.2): each seat's role, for the page's subtitle and whether
 * Deleted by shows (rolesFor, deletedItems.roles); the people of one
 * organization a batch at a time, for the Deleted by choices and the
 * assignee filter (peopleBatch, deletedItems.people); and how many items
 * Delete now deletes with a project item (purgeSummaryOf,
 * deletedItems.purgeSummary). The page's `someone` and its `via` of a
 * credential kind (model/deletedItemsPage.ts deletedAsAsked) complete the
 * Deleted by choices, so none of them comes from the rows of a page. Each
 * answer is the login's seat's in the organization it speaks of, as
 * model/deletedItems.ts viewOf judges each item, and none names a task.
 * These readers stay when deletedItems.list and matches go. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canLeadProjects } from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, MIB } from '../lib/limits'
import {
  indexAfter,
  type NamedAt,
  type NamedReads,
  type NamedStream,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  readBatch,
  STOPPED,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { dependentRanges, namesProfile, newMemo, orgReadOnly, seesItem } from './deletedItems'
import { type Reads, spending, spent } from './deletedItemsList'
import { type IdTie, nameKeysReady, profileIndex } from './nameKeys'
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
 * reveal. The role only words the page and decides whether Deleted by
 * shows; every item still goes through viewOf. A seat reads its
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

/* The list a people cursor names (lib/namedPages.ts namedCursor). */
const PEOPLE_LIST = 'deletedItems.people'

/** The most people one batch answers. A page size, not a limit on what the
 * organization holds. */
export const PEOPLE_BATCH = 25

/**
 * What one batch of the people may read: at most `candidates` profiles,
 * and `read` past what the call read before the batch (lib/namedPages.ts
 * namedCeiling), checked with the transaction's metrics as it reads
 * (readGuard). The profiles come from one or two index ranges, a few
 * hundred bytes each with ordinary text, so `candidates` stops a batch
 * first and `read` only one over unusually large rows. Past either, the
 * batch answers what it found with a cursor, marked as stopped early.
 * Measured on 5 November 2026 in convex-test in an organization of 1,000
 * people with ordinary names (tests/deletedItemsChoices.test.ts, "reads at
 * the design size"), without the login's own reads: the first batch
 * without a search reads 2 index ranges, 27 documents and 0.01 MiB, and a
 * search whose only matches sit last in name order reads to `candidates`,
 * 2 ranges, 402 documents and 0.14 MiB a batch, and answers them in its
 * third batch. A mutable object, so tests can lower it; replace `read`
 * whole rather than change its fields.
 */
export const DELETED_PEOPLE: { candidates: number; read: ReadCeiling } = {
  candidates: 400,
  read: { ranges: 256, documents: 2_000, bytes: 2 * MIB },
}

/** One person or agent of the batch: lib's person row, with `pending`
 * for a person nobody has claimed yet, who can hold work but has deleted
 * nothing, and `you` for the caller's own seat. A public demo's seeded
 * seats have no login either and read as pending here; the app keeps its
 * demo exception (src/store/viewModels.ts). */
export type DeletedPerson = PersonRow & { you: boolean }

/** One batch of the people (deletedItems.people), or `not_ready` while the
 * organization's name keys are not all written (model/nameKeys.ts
 * nameKeysReady). */
export type DeletedPeople =
  | { state: 'not_ready' }
  | { state: 'ready'; rows: DeletedPerson[]; next: string | null; stopped: boolean }

/** What the people are asked (deletedItems.people). */
export type PeopleArgs = { org_id: string; search?: string; cursor?: string }

/**
 * One batch of at most PEOPLE_BATCH of organization `org_id`'s profiles in
 * name order, ties by id (profiles.by_org_name), people, agents, switched
 * off and unclaimed seats alike, as the workspace's people part gives every
 * seat of the organization to every seat today (lib/workspaceParts.ts
 * readPeople). The client builds Deleted by from it, "You" first and
 * unclaimed seats left out, and the assignee filter from every row.
 * `search` keeps those whose name holds every whitespace-separated
 * fragment of it, ignoring case and accents. `cursor` is an earlier
 * batch's `next` for the same organization and search, sealed with the
 * list's name, so it opens for nothing else.
 *
 * A search longer than LIMITS.search and a cursor that does not open are
 * refused first, then an organization where the login holds no active seat
 * answers an empty last batch, as the page answers one, before any read of
 * the organization, and an organization whose name keys are not ready
 * answers `not_ready`. Reads within DELETED_PEOPLE. The batches are cursor
 * only, for the client's paged list read once (src/lib/pagedList.ts); a
 * live list kept between two cursors would need the `after` and `through`
 * of model/projectSettings.ts listAsk.
 */
export async function peopleBatch(
  ctx: QueryCtx,
  seats: Map<string, Profile>,
  a: PeopleArgs,
): Promise<DeletedPeople> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [a.org_id, nameKey(search)]
  let after: NamedAt<IdTie> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, PEOPLE_LIST, scope)
    const id = at?.tie[0]
    if (at === null || at.tie.length !== 1 || typeof id !== 'string')
      throw badRequest(
        'cursor must come from an earlier batch of these people, for the same organization and search',
      )
    after = { key: at.key, tie: [id] }
  }
  const me = seats.get(a.org_id)
  if (me === undefined) return { state: 'ready', rows: [], next: null, stopped: false }
  if (!(await nameKeysReady(ctx, a.org_id))) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(search))
  // the profiles the batch has looked at, each a candidate
  let seen = 0
  const batch = await readBatch(ctx, {
    stream: upTo(
      indexAfter(profileIndex(ctx, a.org_id), after),
      () => seen < DELETED_PEOPLE.candidates,
    ),
    keep: async (profile: Profile) => {
      seen += 1
      return matches(nameKey(profile.name))
        ? { ...personRow(profile), you: profile.id === me.id }
        : null
    },
    limit: PEOPLE_BATCH,
    through: null,
    ceiling: await namedCeiling(ctx, DELETED_PEOPLE.read),
    after,
  })
  return {
    state: 'ready',
    rows: batch.rows,
    next: batch.ended ? null : await namedCursor(PEOPLE_LIST, scope, batch.at),
    stopped: batch.stopped,
  }
}

/** `stream` ending with STOPPED in place of a row once `more` answers
 * false, as when DELETED_PEOPLE.candidates run out. Its first row always
 * passes, so a batch moves on. A batch reads one row past a full one; a cut
 * there only leaves the end unknown. */
function upTo<Row>(
  stream: (reads: NamedReads) => NamedStream<Row>,
  more: () => boolean,
): (reads: NamedReads) => NamedStream<Row> {
  return (reads) =>
    (async function* () {
      let handed = 0
      for await (const step of stream(reads)) {
        if (step !== STOPPED && handed > 0 && !more()) {
          yield STOPPED
          return
        }
        if (step !== STOPPED) handed += 1
        yield step
      }
    })()
}

/* ------------------------------------------------- Delete now's summary */

/**
 * What Delete now's summary may read for one project item: `items`, the
 * most dependents it counts, and the documents (`rows`), estimated `bytes`
 * and index `ranges` it reads, each read of a range being one. A project
 * item of 71 projects opens 4 ranges a project, one a kind and purgeable
 * state (model/deletedItems.ts dependentRanges), 284 ranges, and each
 * sub-project item it finds 4 more. Measured on 5 November 2026 in
 * convex-test for a project item that stores 30 live and 40 archived
 * sub-projects, with a task item in each live one and three earlier
 * sub-project items each with one task item (tests/deletedItemsChoices.test.ts,
 * "reads at the design size"): 36 items in 297 index ranges, 37 documents
 * and 0.04 MiB with the item's own read, answered exactly. Past any bound it
 * answers the count so far with `exact: false`. A subscription query
 * reruns when a dependent changes state or is added, inside the same
 * bounds. A mutable object, so tests can lower it.
 */
export const PURGE_ALONG = { items: 1_000, rows: 2_000, bytes: 4 * MIB, ranges: 1_024 }

/** How many items Delete now on an item deletes with it, exactly or, past
 * PURGE_ALONG, at least (`exact: false`). */
export type PurgeSummary = { along: number; exact: boolean }

/**
 * Delete now's summary of item `id` (deletedItems.purgeSummary): for an
 * organization admin's seat of the login in the item's organization, a
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
