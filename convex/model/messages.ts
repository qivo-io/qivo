/* The inbox: subscriptions, the single message insert path, the pair-item
 * prune and unread cap, the snooze wake, mention extraction and the notify
 * fan-outs: postMessage, pruneReadMessages, wakeSnoozedItem, subscribeToIssue,
 * extractMentions, notifyIssueInsert, notifyIssueUpdate, notifyCommentInsert
 * and notifyCommentUpdate. Also one's own follows (followTask, unfollowTask,
 * followersOf) and inbox writes (mark read or unread, remove, snooze), which
 * the app and the machine surfaces share.
 *
 * Change fragments are joined as sentences; user-written values inside
 * them are preserved verbatim. Inbox.tsx still rewrites 'an issue in another
 * project' and keys on 'New comment'. All timestamps are the mutation's ONE
 * `now` (0111: a comment and the message announcing it share an instant;
 * spine.ts's >= is load-bearing).
 *
 * Whoever a task passes to starts following it (#314), extending #89's
 * assignment subscription: the reviewer when the task enters Review or is
 * handed over in Review, the assignee when it leaves Review. A reviewer set
 * in any other status is not subscribed; one who already follows the task
 * reads 'Reviewer set to you'.
 *
 * An archived task's messages are read for every recipient. postMessage
 * stores news about one already read, the archive paths schedule
 * readArchivedTaskMessages and readArchivedProjectMessages for the rest, and
 * mark unread and snooze refuse such a task (refuseArchivedItems).
 *
 * Every message write here goes through an ItemEdits (model/inboxItems.ts),
 * which keeps the item's inbox_items row equal to what its messages make.
 * The only message writes elsewhere are the teardowns, which delete the
 * items after the messages, and profile removal's patch of actor_id, which
 * no item reads. */

import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canSeeProject,
  keepsInbox,
  profileCanSeeProject,
  projectSightForProfiles,
} from '../lib/access'
import { byId, usedMoreThan } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import type { MessageKind } from '../lib/enums'
import { badRequest, forbidden, rule } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { mentionIds } from '../lib/mentions'
import { MENTION_DETAILS } from '../lib/messageDetails'
import { reviewerOwns, taskOwnerId } from '../lib/review'
import { issueKey, PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { scheduleArchiveMarks } from './archiveMarks'
import { textsOf } from './descriptions'
import { type ItemEdits, itemEdits, type Written } from './inboxItems'
import { newUuid } from './orgs'
import { messageRetentionDays } from './people'
import { emitTaskEvent } from './taskEvents'

/* The line a reviewer reads when a task becomes theirs to review. */
const REVIEW_READY = 'Ready for your review'

/* The per-recipient placeholder for the parent-attach line (0114:212):
 * two followers of one task can differ on whether they may see the parent's
 * project, so the narration holds its place until the fan-out. */
export const ATTACH_SLOT = '\x01attach'

/* to_char(date, 'FMDD Mon') over the ISO 'YYYY-MM-DD' storage → '5 Aug'. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDayMon = (iso: string): string => {
  const [, m, d] = iso.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`
}

/* to_char(numeric(6,1), 'FM999990.#'). VERIFIED against the live PG17
 * deployment: '#' is not a numeric template character, so the template has
 * zero fraction positions and the value is rounded to an INTEGER, half away
 * from zero — 80.5 → '81', 0.4 → '0', 2.0 → '2'. The design prose reads the
 * template as "integer-or-one-decimal"; byte fidelity follows what the
 * deployed trigger actually produced. remaining_hours >= 0, so JS
 * Math.round (half toward +∞) matches. */
const fmtHours = (n: number): string => String(Math.round(n))

/* Every message of one inbox item, the (recipient, issue) pair. The item
 * cap (ITEM_UNREAD_CAP) keeps this read small. */
const pairRows = (
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
): Promise<Doc<'messages'>[]> =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id),
    )
    .collect()

/* -------------------------------------------------------------------- wake
 * Ends an item's snooze: every row of the pair loses snoozed_until, goes
 * UNREAD and is stamped woke_at = now, so the item returns bold, at the top
 * of the list, on every client at once. Idempotent by design — `until`
 * narrows it to the snooze it was scheduled for, so a wake scheduled for a
 * superseded or already-lifted snooze finds nothing and does nothing (no
 * cancellation bookkeeping). Without `until` (the nightly fallback) any
 * snooze on the pair ends. Returns how many messages it wrote, 0 when
 * nothing woke. It writes each row of the item at most once, so a wake
 * writes at most ITEM_UNREAD_CAP + 1 messages, which the nightly sweep
 * budgets on, and the item's inbox_items row once more
 * (model/inboxItems.ts), after reading it and its recipient's build state,
 * two index ranges. */
export async function wakeSnoozedItem(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string; until?: string },
  now: string,
): Promise<number> {
  const item = await pairRows(ctx, a)
  const rows = item.filter(
    (r) => r.snoozed_until !== undefined && (a.until === undefined || r.snoozed_until === a.until),
  )
  if (rows.length === 0) return 0
  const edits = itemEdits(ctx)
  const issue = await byId(ctx, 'issues', a.issue_id)
  const project = issue === null ? null : await byId(ctx, 'projects', issue.project_id)
  if (
    issue !== null &&
    project !== null &&
    issue.archived_at === undefined &&
    project.archived_at === undefined
  ) {
    for (const r of rows) {
      await edits.patch(r, { snoozed_until: undefined, read_at: undefined, woke_at: now })
    }
    await edits.flush()
    return rows.length
  }
  // Messages about an archived task stay read (see "archived tasks" below),
  // so such an item only loses its snooze and does not return. Its rows are
  // read now, so it keeps only its newest row, as pruneReadMessages leaves
  // an item after a mark read. A row the prune would drop is deleted
  // without a patch first, since Convex counts every write. A task in
  // Deleted items, or one whose project is there, is treated the same way:
  // its messages are deleted with it (model/deletedItems.ts), so they never
  // come back unread meanwhile.
  const waking = new Set(rows.map((r) => r._id))
  const newest = item.reduce((best, r) => (oldestFirst(best, r) < 0 ? r : best))
  let written = 0
  for (const r of item) {
    if (r._id === newest._id) {
      if (!waking.has(r._id)) continue
      const readAt = r.read_at ?? now
      await edits.patch(r, { snoozed_until: undefined, read_at: readAt })
      await noteSweepable(ctx, a.recipient_id, readAt)
    } else if (waking.has(r._id) || r.read_at !== undefined) {
      await edits.delete(r)
    } else {
      continue
    }
    written += 1
  }
  await edits.flush()
  return written
}

/* ------------------------------------------------------- sweep schedule
 * The nightly read-message sweep (jobs.ts sweepReadMessages) visits only
 * the profiles whose message_sweeps row is due. The rule that keeps it from
 * skipping a row: a profile with a retention period that holds a read,
 * unsnoozed message has a sweep row due no later than that message's
 * read_at plus the period. Every write here that leaves a row read and not
 * snoozed calls noteSweepable with the row's read_at (mark read, mark all
 * read, the archive's read steps, a notice stored read, and a snooze that
 * ends on a read row), and a change of the period calls lowerSweepDue
 * (profiles.ts setMessageRetention). The sweep moves the row to the next
 * due time it finds, or deletes it. Deletion is always decided from the
 * messages themselves, so a row due too early costs one visit and nothing
 * else. A message the rule misses, for example one restored from an older
 * backup or read by a write without noteSweepable, waits for the sweep's
 * full pass, every 28th night (jobs.ts SWEEP_FULL_AFTER_MS). The row goes
 * with its profile (deleteSweepRow). */

/** Brings `profileId`'s message_sweeps row forward to `due`, adding the row
 * when it has none. A row already due by then stays as it is. The demo's
 * record limit does not count the row: there is at most one per person and
 * it is maintenance state, so a demo at its limit can still mark messages
 * read (lib/demo.ts uncountedWriter). */
export async function lowerSweepDue(
  ctx: MutationCtx,
  profileId: string,
  due: string,
): Promise<void> {
  const row = await ctx.db
    .query('message_sweeps')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .first()
  if (row === null) {
    await uncountedWriter(ctx.db).insert('message_sweeps', { profile_id: profileId, due_at: due })
  } else if (row.due_at > due) {
    await ctx.db.patch(row._id, { due_at: due })
  }
}

/** Deletes `profileId`'s message_sweeps row, if any, with the profile
 * (model/cascade.ts removeProfile and deleteOrgDeep). noteSweepable adds
 * none for a profile that is gone. */
export async function deleteSweepRow(ctx: MutationCtx, profileId: string): Promise<void> {
  for (const row of await ctx.db
    .query('message_sweeps')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .collect())
    await ctx.db.delete(row._id)
}

/** Records that a message of `recipient`, read at `readAt`, is now read and
 * not snoozed, so the sweep deletes it once the recipient's retention
 * period has passed. A recipient who keeps read messages, or who is gone,
 * needs nothing. */
export async function noteSweepable(
  ctx: MutationCtx,
  recipient: Doc<'profiles'> | string,
  readAt: string,
): Promise<void> {
  const p = typeof recipient === 'string' ? await byId(ctx, 'profiles', recipient) : recipient
  const days = p === null ? null : messageRetentionDays(p)
  if (p === null || days === null) return
  await lowerSweepDue(ctx, p.id, new Date(Date.parse(readAt) + days * 86_400_000).toISOString())
}

/* Adds `readAt` to `earliest`, the oldest read_at that became sweepable per
 * recipient in one step, for noteSweepable once the step is done. */
function noteEarliest(earliest: Map<string, string>, recipientId: string, readAt: string): void {
  const known = earliest.get(recipientId)
  if (known === undefined || readAt < known) earliest.set(recipientId, readAt)
}

/* Oldest first by (created_at, id), the total order the prune uses too. */
function oldestFirst(
  a: Pick<Doc<'messages'>, 'created_at' | 'id'>,
  b: Pick<Doc<'messages'>, 'created_at' | 'id'>,
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
}

/* ------------------------------------------------------------------- prune
 * 0109's invariant, kept at both ends (postMessage and messages.markRead):
 * "an item holds every UNREAD message it has been sent, plus its newest
 * message when that one has been read." Deletes every READ message of the
 * (recipient, issue) pair except the pair's newest message, read or not.
 * Newest = max by (created_at desc, id desc) — raw string compare, the same
 * total order as the client's isNewer mirror (planner.ts), so client and
 * server keep the same survivor. The one exception to "every UNREAD
 * message" is the item cap below (trimUnreadMessages). A writer passes its
 * `edits` (model/inboxItems.ts), which it flushes; without one the prune
 * flushes its own. */
export async function pruneReadMessages(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
  preloaded?: Doc<'messages'>[],
  edits?: ItemEdits,
): Promise<void> {
  const rows = preloaded ?? (await pairRows(ctx, a))
  if (rows.length === 0) return
  const own = edits ?? itemEdits(ctx)
  let newest = rows[0]
  for (const r of rows) {
    if (
      r.created_at > newest.created_at ||
      (r.created_at === newest.created_at && r.id > newest.id)
    ) {
      newest = r
    }
  }
  for (const r of rows) {
    if (r._id !== newest._id && r.read_at !== undefined) await own.delete(r)
  }
  if (edits === undefined) await own.flush()
}

/* -------------------------------------------------------------- item cap
 * The most UNREAD messages one inbox item keeps. Snooze, wake, the prune
 * after mark read and the machine inbox's item actions (itemMessages) read
 * the whole item, and the trim after each arrival reads up to the cap and a
 * step more (trimUnreadMessages). Without a cap, a follower or an agent that
 * never reads its inbox would grow one item on a busy task without limit,
 * until snoozing or marking the item read failed, and each comment or change
 * to that task paid for it. Only arrivals add rows, and the prune
 * keeps at most one read row, so an item held at the cap stays within
 * ITEM_UNREAD_CAP + 1 rows. An item that grew past the cap before the cap
 * existed shrinks by up to ITEM_TRIM_STEP rows per arrival, so it reaches
 * the cap over later arrivals. The item counts what the cap deleted
 * (trimRows), and the app, REST and MCP say how many earlier updates it no
 * longer lists. */
export const ITEM_UNREAD_CAP = 50

/* The most unread rows one arrival trims from its item. An item at the cap
 * needs one or two (an arrival adds one row, and mark unread can reopen the
 * one read row). The bound matters for an item that grew past the cap
 * before the cap existed. Trimming all of its excess in the arriving
 * comment or change would add one write per excess row to that mutation,
 * for every such follower, and once that passed the transaction's write
 * limit every later comment or change to the task would fail, rolling the
 * trim back each time. */
export const ITEM_TRIM_STEP = ITEM_UNREAD_CAP

/** How many of an item's oldest unread rows decide a trim: every row it may
 * delete is among them. */
const TRIM_READ = ITEM_UNREAD_CAP + ITEM_TRIM_STEP + 1

/* The start of an item in by_recipient_issue_read_order, which holds its
 * unread rows oldest first by (created_at, id), then its read rows. */
const itemStart = (ctx: MutationCtx, a: { recipient_id: string; issue_id: string }) =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id),
    )

/* Collapses an oversized item. `unread` is the item's unread rows oldest
 * first, or at least its first TRIM_READ of them. When the item holds more
 * than ITEM_UNREAD_CAP unread rows, it deletes the oldest unread rows until
 * the item holds the cap or ITEM_TRIM_STEP rows are gone. It never deletes
 * the item's oldest unread row, which marks where the unread run starts
 * (src/lib/spine.ts firstUnreadTs puts the New divider there), nor the
 * newest unread row of each kind, so the Inbox kind filter still finds the
 * item. A kind whose newest row lies past the first TRIM_READ keeps one more
 * row than it needs to. It never deletes `arrival` either, the row the
 * caller just posted, which woke the item from any snooze.
 *
 * The item counts what the cap deleted in `dropped` (schema.ts), kept on
 * `holder`, its newest unread row by insertion. The inbox reads walk unread
 * rows newest first and stop at INBOX_LIMIT, so whenever they list an item
 * they hold that row, while its oldest rows are the first they leave out.
 * A trim adds the rows it deleted to the counts its rows carried, the
 * deleted ones included, and to the count of the last holder, read on its
 * own when the item is longer than `unread`, and moves the total to the
 * holder. This is
 * separate from retention, and the nightly sweep still never deletes an
 * unread row. Returns how many rows it deleted. */
async function trimRows(
  ctx: MutationCtx,
  edits: ItemEdits,
  unread: readonly Written[],
  pair: { recipient_id: string; issue_id: string },
  holder: Written,
  arrival?: Id<'messages'>,
): Promise<number> {
  const excess = Math.min(unread.length - ITEM_UNREAD_CAP, ITEM_TRIM_STEP)
  if (excess <= 0) return 0
  // The count's last holder is the newest unread row before this one. In an
  // item longer than `unread` reaches, it lies past it, so it is read here.
  const prior = (
    await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id),
      )
      .order('desc')
      .take(3)
  ).find((r) => r.read_at === undefined && r._id !== holder._id)
  const outside = prior?.dropped && !unread.some((r) => r._id === prior._id) ? prior : undefined
  const first = unread[0]
  const newestOfKind = new Map<MessageKind, Written>()
  for (const r of unread) newestOfKind.set(r.kind, r)
  const kept = new Set([first._id, holder._id, ...[...newestOfKind.values()].map((r) => r._id)])
  if (arrival !== undefined) kept.add(arrival)
  let total = unread.some((r) => r._id === holder._id) ? 0 : (holder.dropped ?? 0)
  for (const r of unread) total += r.dropped ?? 0
  total += outside?.dropped ?? 0
  const gone = new Set<Id<'messages'>>()
  for (const r of unread) {
    if (gone.size === excess) break
    if (kept.has(r._id)) continue
    await edits.delete(r)
    gone.add(r._id)
  }
  if (gone.size === 0) return 0
  // the counts move to the holder: clear them on the other rows that stay
  for (const r of unread) {
    if (r._id !== holder._id && r.dropped && !gone.has(r._id))
      await edits.patch(r, { dropped: undefined })
  }
  if (outside !== undefined) await edits.patch(outside, { dropped: undefined })
  await edits.patch(holder, { dropped: total + gone.size })
  return gone.size
}

/** Trims one item toward ITEM_UNREAD_CAP (trimRows), reading its first
 * TRIM_READ unread rows and its newest unread row, which holds the count.
 * The background trim step and the inbox items backfill run it. Returns how
 * many rows it deleted. */
export async function trimUnreadMessages(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
): Promise<number> {
  const unread = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id).eq('read_at', undefined),
    )
    .take(TRIM_READ)
  // the item keeps at most one read row (pruneReadMessages), so the newest
  // unread row is among its last two by insertion
  const holder = (
    await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id),
      )
      .order('desc')
      .take(2)
  ).find((r) => r.read_at === undefined)
  if (holder === undefined) return 0
  const edits = itemEdits(ctx)
  const gone = await trimRows(ctx, edits, unread, a, holder)
  await edits.flush()
  return gone
}

/* ---------------------------------------------------------------- preload
 * Rows a bulk writer keeps for every task it writes, handed to
 * notifyIssueInsert, notifyIssueUpdate and notifyCommentInsert so each call
 * need not read them again. A preload fills as it is asked. It is valid only
 * while nothing in the transaction changes profiles, projects, grants, teams
 * or team memberships after it is built, because its answers would then be
 * stale. A
 * bulk writer that meets this may pass one:
 *   - a task or comment step of the Northstar seed (demoSeed.ts
 *     writeNorthstarStep);
 *   - a Deleted items step (model/deletedItems.ts), which reads it after any
 *     project rows moved and then only detaches tasks;
 *   - the detach loop of a task delete (model/deletedItems.ts
 *     moveTasksToTrash), the app's, REST's and MCP's delete, which reads it
 *     at the first detach of a transaction that changes only tasks, their
 *     rows and activity, and defers the followers;
 *   - the reassign loop of an access removal (projectAccess.ts
 *     removeAndSettle), which builds it after the access is gone;
 *   - a roadmap save or undo (roadmap.ts), which changes only tasks,
 *     milestones and activity, one preload per organization.
 * A write that changes one task passes none, so every row is read fresh. */
export type NotifyPreload = {
  /* The profiles the fan-outs read, each once, by uuid (ProfileCache). */
  profiles: ProfileCache
  /* The org's projects by uuid, as stored now. A miss is read by uuid and
   * kept. */
  projects: Map<string, Doc<'projects'>>
  /* Recipient sight, filled as it is asked (RecipientSight). */
  visibility: RecipientSight
  /* Run by notifyIssueUpdate before each webhook subscription it checks
   * (taskEvents.ts emitTaskEvent), each mention and each follower it
   * notifies. A bulk writer throws from it to stop before the transaction
   * passes Convex's limits (projectAccess.ts removeAndSettle). */
  guard?: () => Promise<void>
  /* Set by a bulk save that changes many tasks at once (a roadmap save or
   * undo, an access removal's reassignments, a task delete's detaches):
   * notifyIssueUpdate leaves every follower notice to background steps
   * (FOLLOWER_FANOUT), so a save of many tasks with many followers stays
   * within one transaction. Those
   * notices arrive moments later. New owners' follows stay in the save;
   * mentions are told in it while its notice room lasts (tellMentioned). */
  deferFollowers?: true
  /* Set by a bulk writer whose only message writes are its notices, the
   * Northstar seed: every notice it posts keeps its inbox item through this
   * one ItemEdits (model/inboxItems.ts), which reads each recipient's build
   * state and each item once, and the writer flushes it after its notices.
   * Another message write in the same transaction would have to go
   * through it too. */
  items?: ItemEdits
}

/** Builds an empty preload with the `projects` the caller already read. Use
 * it only while the transaction will change no profile, project, grant,
 * team or team membership (NotifyPreload). */
export function newNotifyPreload(projects: readonly Doc<'projects'>[] = []): NotifyPreload {
  return {
    profiles: new Map(),
    projects: new Map(projects.map((p) => [p.id, p])),
    visibility: new Map(),
  }
}

/** Profiles a fan-out read by uuid, each read once, null for one that is
 * gone. A fan-out reads only the people it names, the followers, the
 * mentioned people and the assignee and reviewer, never the whole
 * organization, so its cost does not grow with the organization. */
export type ProfileCache = Map<string, Promise<Doc<'profiles'> | null>>

/** A ProfileCache that already holds `profiles`, for a writer that read them. */
export const profileCacheOf = (profiles: readonly Doc<'profiles'>[]): ProfileCache =>
  new Map(profiles.map((p) => [p.id, Promise.resolve(p)]))

/** Profile `id` of organization `orgId`, read once through `cache`, or
 * undefined for one that is gone or in another organization. */
export async function orgProfile(
  ctx: QueryCtx,
  cache: ProfileCache,
  orgId: string,
  id: string,
): Promise<Doc<'profiles'> | undefined> {
  let read = cache.get(id)
  if (read === undefined) {
    read = byId(ctx, 'profiles', id)
    cache.set(id, read)
  }
  const profile = await read
  return profile !== null && profile.org_id === orgId ? profile : undefined
}

/* A project by uuid, from the preload when one is given. A miss is read and
 * kept in the preload, so a bulk writer reads each project once. */
async function preloadedProject(
  ctx: MutationCtx,
  preload: NotifyPreload | undefined,
  projectId: string,
): Promise<Doc<'projects'> | null> {
  const known = preload?.projects.get(projectId)
  if (known !== undefined) return known
  const project = await byId(ctx, 'projects', projectId)
  if (project !== null) preload?.projects.set(projectId, project)
  return project
}

/** How many people a fan-out asks about one project's sight one at a time
 * before it works out everyone's at once (RecipientSight). A few followers,
 * as most comments and updates have, cost less asked alone than the
 * project's grants and team members read in full. */
export const SIGHT_ALONE = 8

/** Who can see each project a fan-out asks about, by project uuid. The
 * first SIGHT_ALONE people are asked one at a time. After that the
 * project's grants, team shares and sharing teams' members are read once,
 * up to a bound, and answer everyone (lib/access.ts
 * projectSightForProfiles). One check per follower costs a few index
 * ranges, and two more for each team sharing the project, so a task with
 * some hundreds of followers passed Convex's 4,096 ranges or its 1 s. Like
 * a preload, it holds only while the transaction changes no profile,
 * project, grant, team or team membership. */
export type RecipientSight = Map<
  string,
  {
    /* the answers asked one at a time, by profile uuid */
    alone: Map<string, boolean>
    /* everyone's, once more people were asked about */
    all?: Promise<(profile: Doc<'profiles'>) => Promise<boolean>>
  }
>

/* profileCanSeeProject, answered through `visibility` when one is given,
 * else asked live. */
async function recipientCanSee(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
  visibility: RecipientSight | undefined,
): Promise<boolean> {
  if (visibility === undefined) return await profileCanSeeProject(ctx, profile, project)
  let sight = visibility.get(project.id)
  if (sight === undefined) {
    sight = { alone: new Map() }
    visibility.set(project.id, sight)
  }
  const known = sight.alone.get(profile.id)
  if (known !== undefined) return known
  if (sight.all === undefined && sight.alone.size < SIGHT_ALONE) {
    const sees = await profileCanSeeProject(ctx, profile, project)
    sight.alone.set(profile.id, sees)
    return sees
  }
  sight.all ??= projectSightForProfiles(ctx, project)
  return await (await sight.all)(profile)
}

/** How many items one fan-out trims in its own transaction (ItemTrims).
 * An item at ITEM_UNREAD_CAP costs about that many rows to trim, so a task
 * with hundreds of followers would read tens of thousands of rows in every
 * comment or change, near Convex's limit for one transaction. */
export const INLINE_TRIMS = 32

/** The trims of one fan-out: the first INLINE_TRIMS items it posts to are
 * trimmed in the posting transaction, and the recipients of the rest are
 * collected in `later` for one background step (scheduleItemTrims), which
 * the fan-out schedules once it has posted. Until that step runs, such an
 * item holds one row past the cap. */
export type ItemTrims = { inline: number; later: string[] }

/** A fan-out's ItemTrims, before it posts. */
export const newItemTrims = (): ItemTrims => ({ inline: 0, later: [] })

/* ------------------------------------------------------------- postMessage
 * THE single insert path (0109:95-114) — no other code may insert messages.
 * Silent drops, never errors: the actor's own copy, a recipient outside the
 * issue's org, a recipient without an inbox (a Viewer or Inactive agent,
 * lib/access.ts keepsInbox, which could never read or remove the row) and a
 * recipient who cannot see the project are all skipped without a trace — a
 * mention must not leak a hidden project's existence (0074), and a
 * subscription can never outlive the access that justified it (0114:40-42).
 * After the insert it wakes a snoozed item, prunes its read rows and trims
 * its unread rows toward ITEM_UNREAD_CAP (trimUnreadMessages), or leaves the
 * trim to the fan-out's background step (`trims`, ItemTrims). It reads the
 * item's rows in full only to wake a snoozed item, so a follower's cost does
 * not grow with the item. Returns whether a row was inserted.
 *
 * A message about an archived task, or a task in an archived project, is
 * stored already read, stamped `now`, because no inbox shows that task and
 * the archive marks its earlier messages read in the background (see
 * "archived tasks" below). That covers the Archived notice itself, which the archive
 * writes after its stamp, the archive reason's comment, and any later
 * comment, edit or detach notice. The Restored notice is written after the
 * restore, so it arrives unread.
 *
 * `issue` / `project` / `recipient` are optional preloads; when absent they
 * are read by uuid. `visibility` is the fan-out's RecipientSight; without
 * one the recipient's sight is asked alone. The issue_title snapshot is
 * the issue's CURRENT title (the SQL passed new.title). */
export async function postMessage(
  ctx: MutationCtx,
  m: {
    org_id: string
    recipient_id: string
    issue_id: string
    kind: MessageKind
    body: string
    actor_id: string | undefined
    now: string
    issue?: Doc<'issues'>
    project?: Doc<'projects'>
    recipient?: Doc<'profiles'>
    visibility?: RecipientSight
    trims?: ItemTrims
    items?: ItemEdits
  },
): Promise<boolean> {
  if (m.actor_id !== undefined && m.recipient_id === m.actor_id) return false
  const recipient = m.recipient ?? (await byId(ctx, 'profiles', m.recipient_id))
  if (recipient === null || recipient.org_id !== m.org_id || !keepsInbox(recipient)) return false
  const issue = m.issue ?? (await byId(ctx, 'issues', m.issue_id))
  if (issue === null) return false
  const project = m.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) return false
  if (!(await recipientCanSee(ctx, recipient, project, m.visibility))) return false
  const archived = issue.archived_at !== undefined || project.archived_at !== undefined
  const pair = { recipient_id: m.recipient_id, issue_id: m.issue_id }
  // One read of the item. A trim in this transaction reads its start: the
  // unread rows it decides on, then the read rows, which 0109's invariant
  // keeps to one. Otherwise its end holds the read rows and a row besides.
  // Every row of an item carries the same snooze or none (schema.ts), so
  // any one of them tells whether the item sleeps.
  const inline = m.trims === undefined || m.trims.inline < INLINE_TRIMS
  const rows = inline
    ? await itemStart(ctx, pair).take(TRIM_READ + 2)
    : await itemStart(ctx, pair).order('desc').take(3)
  // An item past the cap from before it (ITEM_UNREAD_CAP) can fill the
  // start with unread rows, so its read rows are read on their own.
  const read =
    inline && rows.length === TRIM_READ + 2 && rows.at(-1)?.read_at === undefined
      ? await ctx.db
          .query('messages')
          .withIndex('by_recipient_issue_read_order', (q) =>
            q
              .eq('recipient_id', pair.recipient_id)
              .eq('issue_id', pair.issue_id)
              .gt('read_at', undefined),
          )
          .take(2)
      : rows.filter((r) => r.read_at !== undefined)
  const row = {
    id: newUuid(),
    org_id: m.org_id,
    recipient_id: m.recipient_id,
    actor_id: m.actor_id,
    issue_id: m.issue_id,
    issue_title: issue.title,
    kind: m.kind,
    detail: m.body,
    created_at: m.now,
    read_at: archived ? m.now : undefined,
  }
  // the item's row (model/inboxItems.ts), and the recipient's build state
  // read before the insert, which adds a built one to an empty inbox. A
  // bulk writer's shared ItemEdits (NotifyPreload.items) is flushed by it.
  const edits = m.items ?? itemEdits(ctx)
  await edits.state(m.recipient_id, 'ensure')
  const inserted = await edits.insert(row, issue.project_id, rows.length === 0)
  const arrived = { ...row, _id: inserted }
  // News wakes a snoozed item: the arrival is the news, so the older rows
  // only drop the snooze (no woke_at — the new row's created_at floats and
  // announces the item), and the scheduled wake later finds nothing to do.
  // An arrival stored read drops it too, so every row of the item keeps the
  // same stamp; the archive's background step would drop it anyway. A read
  // row that loses its snooze, like an arrival stored read, can be swept.
  let sweepable = row.read_at
  if (rows[0]?.snoozed_until !== undefined) {
    for (const r of await pairRows(ctx, pair)) {
      if (r.snoozed_until === undefined) continue
      await edits.patch(r, { snoozed_until: undefined })
      if (r.read_at !== undefined && (sweepable === undefined || r.read_at < sweepable)) {
        sweepable = r.read_at
      }
    }
  }
  if (sweepable !== undefined) await noteSweepable(ctx, recipient, sweepable)
  // The prune (pruneReadMessages): the item keeps its newest row, read or
  // not, and no other read row. A read row newer than the arrival survives
  // it: one of this same instant, or any row newer than a background step's
  // notice, which keeps its write's time. Such a notice stored read about an
  // archived task can outlive newer unread rows of its item until the
  // archive's background step marks them read and prunes the item
  // (readArchivedTaskMessages).
  let newest: Written = arrived
  for (const r of read) if (oldestFirst(newest, r) < 0) newest = r
  for (const r of read) if (r !== newest) await edits.delete(r)
  if (newest !== arrived && row.read_at !== undefined) await edits.delete(arrived)
  if (!inline) {
    m.trims?.later.push(m.recipient_id)
    if (m.items === undefined) await edits.flush()
    return true
  }
  if (m.trims !== undefined) m.trims.inline += 1
  const unread = rows.filter((r) => r.read_at === undefined)
  // the arrival in its place in the item, which a background step's notice,
  // stamped with its write's time, may not be at the end of
  // the newest unread row by insertion holds the item's dropped count: the
  // arrival, or the latest unread row before it when it is stored read
  const latest = unread.reduce<(typeof unread)[number] | undefined>(
    (best, r) => (best === undefined || r._creationTime > best._creationTime ? r : best),
    undefined,
  )
  const holder = row.read_at === undefined ? arrived : latest
  if (holder !== undefined)
    await trimRows(
      ctx,
      edits,
      row.read_at === undefined ? [...unread, arrived].sort(oldestFirst) : unread,
      pair,
      holder,
      inserted,
    )
  if (m.items === undefined) await edits.flush()
  return true
}

/* The background trim step in convex/messages.ts, referenced by name like
 * wakeRef below. */
const trimItemsRef = makeFunctionReference<
  'mutation',
  { issue_id: string; recipients: string[] },
  null
>('messages:trimItems')

/** How many items one background trim step trims. Each reads at most
 * ITEM_UNREAD_CAP + ITEM_TRIM_STEP + 1 rows and deletes at most
 * ITEM_TRIM_STEP. */
export const TRIM_BATCH = 64

/** Schedules the background trims of a fan-out's deferred items
 * (ItemTrims.later), TRIM_BATCH recipients a step. */
export async function scheduleItemTrims(
  ctx: MutationCtx,
  issueId: string,
  trims: ItemTrims,
): Promise<void> {
  const recipients = [...new Set(trims.later)]
  for (let i = 0; i < recipients.length; i += TRIM_BATCH) {
    await ctx.scheduler.runAfter(0, trimItemsRef, {
      issue_id: issueId,
      recipients: recipients.slice(i, i + TRIM_BATCH),
    })
  }
}

/** How a new follow meets LIMITS.followers.max (lib/limits.ts). 'refuse'
 * throws LIMITS.followers.refusal, for a follow by hand. 'skip' adds no follower, for
 * a comment's author and a mentioned person, whose comment or mention still
 * goes ahead. 'pass' adds the follower anyway, for a new assignee or
 * reviewer, who must hear about their own task. */
export type FollowCap = 'refuse' | 'skip' | 'pass'

/** Whether the task already has LIMITS.followers.max followers, read with a bound.
 * A task followed before the cap can have more. */
export async function followersFull(ctx: QueryCtx, issueId: string): Promise<boolean> {
  const rows = await ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issueId))
    .take(LIMITS.followers.max)
  return rows.length >= LIMITS.followers.max
}

/* --------------------------------------------------------------- subscribe
 * subscribe_to_issue (0114:134-149): same fence as postMessage (org, an
 * inbox and visibility — a subscription row decides who gets messages, so it
 * must not be creatable for someone who could not have received them),
 * idempotent, then the follower cap as `cap` says (FollowCap). Someone who
 * already follows is never refused.
 * `visibility` is the fan-out's RecipientSight, as for postMessage. Returns
 * whether a row was inserted. */
export async function subscribeToIssue(
  ctx: MutationCtx,
  a: {
    issue_id: string
    /** the task's window_key, which the follow carries (schema.ts taskKey) */
    task_key: string | undefined
    profile: Doc<'profiles'>
    org_id: string
    project: Doc<'projects'> | null
    now: string
    cap: FollowCap
    visibility?: RecipientSight
  },
): Promise<boolean> {
  if (a.profile.org_id !== a.org_id || !keepsInbox(a.profile)) return false
  if (a.project === null) return false
  if (!(await recipientCanSee(ctx, a.profile, a.project, a.visibility))) return false
  const existing = await ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_profile', (q) =>
      q.eq('issue_id', a.issue_id).eq('profile_id', a.profile.id),
    )
    .unique()
  if (existing !== null) return false
  if (a.cap !== 'pass' && (await followersFull(ctx, a.issue_id))) {
    if (a.cap === 'refuse') throw rule(LIMITS.followers.refusal)
    return false
  }
  await ctx.db.insert('issue_subscriptions', {
    issue_id: a.issue_id,
    profile_id: a.profile.id,
    created_at: a.now,
    task_key: a.task_key,
  })
  return true
}

/* ----------------------------------------------------------------- follows
 * Following a task is one's own subscription row. The app's eye button
 * (issues.subscribe and unsubscribe) and the machine surfaces (MCP
 * set_following, REST /v1/tasks/{ref}/following) run these. Changing a
 * follow narrates nothing and notifies nobody. Managing other people's
 * follows stays in issues.setSubscriber. */

/**
 * Starts `me` following `issue`. Refuses a task whose project `me` cannot
 * see, and one with LIMITS.followers.max followers that `me` does not follow yet.
 * Returns whether `me` was not following it before.
 */
export async function followTask(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; now: string },
): Promise<boolean> {
  const project = await byId(ctx, 'projects', a.issue.project_id)
  if (project === null || !(await canSeeProject(ctx, a.me, project))) {
    throw forbidden('no access to this task')
  }
  return await subscribeToIssue(ctx, {
    issue_id: a.issue.id,
    task_key: a.issue.window_key,
    profile: a.me,
    org_id: a.issue.org_id,
    project,
    now: a.now,
    cap: 'refuse',
  })
}

/** Stops `me` following the task. Returns whether `me` was following it. */
export async function unfollowTask(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; issueId: string },
): Promise<boolean> {
  const row = await ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_profile', (q) => q.eq('issue_id', a.issueId).eq('profile_id', a.me.id))
    .unique()
  if (row === null) return false
  await ctx.db.delete(row._id)
  return true
}

/**
 * The profiles following `issue`, ordered by name, as the app's follower
 * list shows them. Someone who has since lost sight of the task stays
 * listed, as in the app, but postMessage sends them nothing.
 */
export async function followersOf(
  ctx: QueryCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<Doc<'profiles'>[]> {
  const out: Doc<'profiles'>[] = []
  const rows = ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id))
  for await (const row of rows) {
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (profile !== null && profile.org_id === issue.org_id) out.push(profile)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/* ------------------------------------------------------------ inbox writes
 * The recipient's own writes on its inbox, shared by the app's Inbox
 * (convex/messages.ts) and the machine inbox (machine/discussion.ts). Each
 * takes rows the caller already chose as its own. The app passes the message
 * ids its list holds through ownMessages, or for an item action the task's
 * id through itemMessages, and the machine every row of the items it names
 * through itemMessages. Each returns the ids of the tasks whose items it
 * changed. */

/**
 * The rows among `ids` that belong to `me`, each once. Other people's rows
 * and unknown ids are skipped silently, so a probe learns nothing and a
 * stale id is not an error.
 */
export async function ownMessages(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  ids: readonly string[],
): Promise<Doc<'messages'>[]> {
  const out: Doc<'messages'>[] = []
  for (const id of new Set(ids)) {
    const row = await byId(ctx, 'messages', id)
    if (row !== null && row.recipient_id === me.id) out.push(row)
  }
  return out
}

/**
 * Every row of `me`'s inbox item about one task, or with `through` the rows
 * whose _creationTime is at most `through`, the item's newest _creationTime
 * as inbox.item answered it, so an item action leaves out what was stored
 * after the caller's view.
 *
 * The cutoff leaves out every message stored after the view by more than
 * one mutation's run time, also the follower and mention notices that
 * background steps store with their write's earlier created_at, for which
 * it was built: a cut by (created_at, id) took those. It is not exact.
 * Convex bases _creationTime on the time the storing mutation started, not
 * on commit order (docs.convex.dev/database/advanced/commit-timestamp), so
 * a message from a mutation that started before the view and committed
 * after it can carry an earlier or equal _creationTime, a tie included,
 * and is then taken with the rest, as markAllMessagesRead's cutoff takes
 * it. The exact fix is a planned follow-up: a server-owned
 * `commit_ts: v.commitTs()` on messages with an index, strictly increasing
 * in commit order, which would make markAllMessagesRead's cutoff exact
 * too.
 */
export async function itemMessages(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  issueId: string,
  through?: number,
): Promise<Doc<'messages'>[]> {
  const rows = await pairRows(ctx, { recipient_id: me.id, issue_id: issueId })
  return through === undefined ? rows : rows.filter((row) => row._creationTime <= through)
}

/**
 * Marks the unread rows read, stamped `now`, then keeps 0109's invariant
 * once per item it touched (pruneReadMessages). A row already read keeps
 * its stamp.
 */
export async function markMessagesRead(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  rows: readonly Doc<'messages'>[],
  now: string,
): Promise<Set<string>> {
  const edits = itemEdits(ctx)
  const issues = new Set<string>()
  for (const row of rows) {
    if (row.read_at !== undefined) continue
    await edits.patch(row, { read_at: now })
    issues.add(row.issue_id)
  }
  for (const issue_id of issues) {
    await pruneReadMessages(ctx, { recipient_id: me.id, issue_id }, undefined, edits)
  }
  await edits.flush()
  if (issues.size > 0) await noteSweepable(ctx, me, now)
  return issues
}

/**
 * Refuses to make the items of archived tasks unread or snoozed. Messages
 * about an archived task, or a task in an archived project, stay read (see
 * "archived tasks" below), because no inbox lists that task and an unread
 * row there would sit hidden in the bounded unread walk until a restore.
 * The first such task among `issueIds` that `me` can see refuses the whole
 * change with a rule naming it, so nothing changes. Mark unread and snooze
 * call it on the tasks of their rows, and the machine inbox also on the
 * tasks a request names, which refuses an archived task without messages
 * too. Returns the ids of such tasks `me` can no longer see. The caller
 * leaves their rows out silently, as it skips an unknown id, so the answer
 * says nothing about a hidden task.
 */
export async function refuseArchivedItems(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  issueIds: Iterable<string>,
): Promise<Set<string>> {
  const hidden = new Set<string>()
  for (const id of new Set(issueIds)) {
    const issue = await byId(ctx, 'issues', id)
    if (issue === null) continue
    const project = await byId(ctx, 'projects', issue.project_id)
    const taskArchived = issue.archived_at !== undefined
    const projectArchived = project !== null && project.archived_at !== undefined
    if (!taskArchived && !projectArchived) continue
    if (project === null || !(await canSeeProject(ctx, me, project))) {
      hidden.add(id)
      continue
    }
    const key = issueKey(issue.num)
    throw rule(
      taskArchived && projectArchived
        ? `${key} and its project are archived and must be restored first`
        : taskArchived
          ? `${key} is archived and must be restored first`
          : `${key} is in an archived project, which must be restored first`,
    )
  }
  return hidden
}

/**
 * Marks the read rows unread. It prunes nothing ("Mark-as-unread …
 * correctly does nothing", 0109:122): the rows it reopens are no longer
 * read, which is all the prune asks. A row about an archived task refuses
 * the whole change (refuseArchivedItems).
 */
export async function markMessagesUnread(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  rows: readonly Doc<'messages'>[],
): Promise<Set<string>> {
  const hidden = await refuseArchivedItems(
    ctx,
    me,
    rows.map((row) => row.issue_id),
  )
  const edits = itemEdits(ctx)
  const issues = new Set<string>()
  for (const row of rows) {
    if (row.read_at === undefined || hidden.has(row.issue_id)) continue
    await edits.patch(row, { read_at: undefined })
    issues.add(row.issue_id)
  }
  await edits.flush()
  return issues
}

/** Deletes the rows. Removing an item means passing every row it holds. */
export async function removeMessages(
  ctx: MutationCtx,
  rows: readonly Doc<'messages'>[],
): Promise<Set<string>> {
  const edits = itemEdits(ctx)
  const issues = new Set<string>()
  for (const row of rows) {
    await edits.delete(row)
    issues.add(row.issue_id)
  }
  await edits.flush()
  return issues
}

/* How many rows one bulk inbox write changes at most. The caller repeats
 * while hasMore is true. Measured in convex/tests/inboxBulk.test.ts, with
 * every message as long as a change notice can be (the longest title and
 * names in a three-byte script, about 3.9 KB), so that one batch stays
 * below a quarter of each of Convex's transaction limits. The worst case is
 * Mark all as read on one older unread message in each of INBOX_BATCH
 * items that also hold a newer unread message outside the batch and a
 * newest read one: the batch reads each marked message four times (the
 * range, its patch, the prune's read and its delete), the newer unread
 * message the prune seeks and the read one, about 23.6 KB a marked message,
 * so 177 is the most that fits. One run at 160 measured, in bytes read,
 * documents read, index ranges, documents written and bytes written:
 *   - that worst case: 3.77 MB, 1,284, 484, 480 and 0.68 MB, 90% of a
 *     quarter of the 16 MiB read limit;
 *   - one unread message in each item, its newest read: 3.17 MB, 1,123,
 *     484, 480 and 0.68 MB;
 *   - items of 51 messages: 2.43 MB, 655, 16, 324 and 0.61 MB;
 *   - Remove all read of each item's newest message: 1.96 MB, 802, 483,
 *     320 and 0.08 MB.
 * These are convex-test's counts, which count the document a patch or a
 * delete reads; a hosted deployment was not measured. */
export const INBOX_BATCH = 160

/** The two bulk inbox actions: Mark all as read (`read`) and Remove all
 * read (`remove`). */
export type BulkAction = 'read' | 'remove'

/**
 * The rows bulk action `action` walks in the inbox of profile
 * `recipientId`, in the order its batches take them: the unsnoozed unread
 * rows for Mark all as read, those created no later than `cutoff` when it
 * is given, and the unsnoozed read rows for Remove all read. A snoozed row
 * is hidden, so neither action reaches it, and the index range leaves it
 * out, so it costs a batch nothing. markAllMessagesRead,
 * removeReadMessages, readBulkReach and the summary's seat flags
 * (model/inboxReads.ts) read these ranges.
 */
export function bulkRows(ctx: QueryCtx, recipientId: string, action: BulkAction, cutoff?: number) {
  return ctx.db.query('messages').withIndex('by_recipient_snoozed_read', (q) => {
    const seat = q.eq('recipient_id', recipientId).eq('snoozed_until', undefined)
    if (action === 'remove') return seat.gt('read_at', undefined)
    const unread = seat.eq('read_at', undefined)
    return cutoff === undefined ? unread : unread.lte('_creationTime', cutoff)
  })
}

/**
 * The cutoff a first Mark all as read batch chooses for profile
 * `recipientId`: the _creationTime of its newest stored unread row, a
 * snoozed one included, or 0 when nothing is unread. It is the server's
 * time, not a client clock, and later batches pass it on, so messages that
 * arrive after it stay unread. readBulkReach answers it when the person
 * presses the action, so a seat whose first batch waits for another seat's
 * still stops at what had arrived by then.
 */
export async function markCutoff(ctx: QueryCtx, recipientId: string): Promise<number> {
  const latest = await ctx.db
    .query('messages')
    .withIndex('by_recipient_read', (q) =>
      q.eq('recipient_id', recipientId).eq('read_at', undefined),
    )
    .order('desc')
    .first()
  return latest?._creationTime ?? 0
}

/** The budget of readBulkReach: it reads a seat's range only while the
 * transaction has used no more than `room` of any of Convex's limits
 * (lib/db.ts usedMoreThan). Tests lower it. */
export const BULK_REACH = { room: 0.5 }

/** How much one bulk action has to do in one seat: nothing, one batch or
 * more than one. For Mark all as read, `before` is the cutoff a first batch
 * would choose now (markCutoff). */
export type SeatReach = { org_id: string; reach: 'none' | 'one' | 'many'; before?: number }

/**
 * How much bulk action `action` has to do in each of the seats `seats`, the
 * caller's active profiles, in organization id order. For Mark all as read
 * it reads each seat's newest unread row first and answers its time as
 * `before`, the cutoff a first batch would choose now, for every seat, so
 * no seat's first batch chooses a later one. It then reads INBOX_BATCH + 1
 * rows of the range the batches walk (bulkRows), up to that cutoff. A seat
 * whose range it cannot read within BULK_REACH answers `many`, so a budget
 * makes the app warn rather than stay silent. A seat costs one row for the
 * cutoff and INBOX_BATCH + 1 rows of the range, each a message of at most a
 * few KB (see INBOX_BATCH), so seats past the budget are rare.
 */
export async function readBulkReach(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
  action: BulkAction,
): Promise<SeatReach[]> {
  const out: SeatReach[] = []
  for (const seat of [...seats].sort((a, b) => (a.org_id < b.org_id ? -1 : 1))) {
    const before = action === 'read' ? await markCutoff(ctx, seat.id) : undefined
    const answer = (reach: SeatReach['reach']): SeatReach =>
      before === undefined ? { org_id: seat.org_id, reach } : { org_id: seat.org_id, reach, before }
    if (await usedMoreThan(ctx, BULK_REACH.room)) {
      out.push(answer('many'))
      continue
    }
    const rows = await bulkRows(ctx, seat.id, action, before).take(INBOX_BATCH + 1)
    out.push(answer(rows.length === 0 ? 'none' : rows.length > INBOX_BATCH ? 'many' : 'one'))
  }
  return out
}

/* Keeps 0109's invariant on one item after a bulk write stamped at most
 * `stamped` of its rows read. The invariant held before that write, so the
 * item then held at most one read row, and it now holds at most
 * stamped + 1, which this reads in full. It seeks the item's newest unread
 * row in the index rather than reading every unread row, so its cost does
 * not grow with the item. */
async function pruneStampedItem(
  ctx: MutationCtx,
  edits: ItemEdits,
  a: { recipient_id: string; issue_id: string },
  stamped: number,
): Promise<void> {
  const newestUnread = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id).eq('read_at', undefined),
    )
    .order('desc')
    .first()
  const read = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id).gt('read_at', undefined),
    )
    .take(stamped + 1)
  let newest = newestUnread ?? read[0]
  for (const row of read) {
    if (
      row.created_at > newest.created_at ||
      (row.created_at === newest.created_at && row.id > newest.id)
    )
      newest = row
  }
  for (const row of read) {
    if (row._id !== newest._id) await edits.delete(row)
  }
}

/**
 * Marks up to INBOX_BATCH of `me`'s unread rows read, the ones created no
 * later than `before` (bulkRows). Without `before` the cutoff is the
 * newest stored unread row (markCutoff), not a client clock. The app's
 * first call passes the one messages.bulkReach answered at the press, and
 * every caller passes the returned `before` to later batches, so later
 * arrivals stay unread. The prune reads at most the newly stamped rows plus
 * one retained read row per affected task and seeks each task's newest
 * unread directly in the index. Returns the rows it marked, as they were
 * before.
 */
export async function markAllMessagesRead(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  before: number | undefined,
  now: string,
): Promise<{ marked: Doc<'messages'>[]; hasMore: boolean; before: number }> {
  const cutoff = before ?? (await markCutoff(ctx, me.id))
  const rows = await bulkRows(ctx, me.id, 'read', cutoff).take(INBOX_BATCH + 1)
  const batch = rows.slice(0, INBOX_BATCH)
  const edits = itemEdits(ctx)
  for (const row of batch) await edits.patch(row, { read_at: now })
  for (const issue_id of new Set(batch.map((row) => row.issue_id))) {
    await pruneStampedItem(ctx, edits, { recipient_id: me.id, issue_id }, INBOX_BATCH)
  }
  await edits.flush()
  if (batch.length > 0) await noteSweepable(ctx, me, now)
  return { marked: batch, hasMore: rows.length > INBOX_BATCH, before: cutoff }
}

/**
 * Deletes up to INBOX_BATCH of `me`'s read rows (bulkRows). A snoozed row
 * that was read meanwhile is a pending reminder, not clutter, and stays.
 * Each batch selects the current read rows, so a row reopened elsewhere
 * survives. Returns the rows it deleted.
 */
export async function removeReadMessages(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
): Promise<{ removed: Doc<'messages'>[]; hasMore: boolean }> {
  const rows = await bulkRows(ctx, me.id, 'remove').take(INBOX_BATCH + 1)
  const batch = rows.slice(0, INBOX_BATCH)
  const edits = itemEdits(ctx)
  for (const row of batch) await edits.delete(row)
  await edits.flush()
  return { removed: batch, hasMore: rows.length > INBOX_BATCH }
}

/* The farthest ahead a snooze may reach (LIMITS.snooze, in days). */
const MAX_SNOOZE_MS = LIMITS.snooze.max * 86_400_000

/* The scheduled end of a snooze, convex/messages.ts wake, referenced by
 * name so this module does not import the app module. */
const wakeRef = makeFunctionReference<
  'mutation',
  { recipient_id: string; issue_id: string; until: string },
  null
>('messages:wake')

/**
 * Snoozes the items the rows belong to until `until`, an ISO instant at
 * most LIMITS.snooze days ahead, or with null lifts their snooze now. Either way the
 * item ends up unread, because a snoozed row is a reminder, and a reminder
 * that returns already read is easy to miss. The write covers every row of each
 * item, so all of them keep the same stamp, and schedules the wake that
 * brings the item back on every client at once. An early return is a wake
 * without the stamp, because the person asked for it here and now. A row
 * about an archived task refuses the whole change, with or without `until`
 * (refuseArchivedItems), before `until` is checked.
 */
export async function snoozeMessages(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  rows: readonly Doc<'messages'>[],
  until: string | null,
): Promise<Set<string>> {
  const hidden = await refuseArchivedItems(
    ctx,
    me,
    rows.map((row) => row.issue_id),
  )
  let at: string | null = null
  if (until !== null) {
    const ms = Date.parse(until)
    if (Number.isNaN(ms)) throw badRequest('snooze: until must be an ISO instant')
    if (ms <= Date.now()) throw badRequest('snooze: until must be in the future')
    if (ms > Date.now() + MAX_SNOOZE_MS) throw rule(LIMITS.snooze.refusal)
    at = new Date(ms).toISOString() // normalized, so the wake's equality holds
  }
  const edits = itemEdits(ctx)
  const changed = new Set<string>()
  for (const issue_id of new Set(rows.map((row) => row.issue_id))) {
    if (hidden.has(issue_id)) continue
    const pair = { recipient_id: me.id, issue_id }
    const item = await pairRows(ctx, pair)
    if (at === null) {
      for (const row of item) {
        if (row.snoozed_until === undefined) continue
        await edits.patch(row, { snoozed_until: undefined, read_at: undefined })
        changed.add(issue_id)
      }
      continue
    }
    for (const row of item) {
      await edits.patch(row, { snoozed_until: at, read_at: undefined, woke_at: undefined })
    }
    if (item.length > 0) changed.add(issue_id)
    await ctx.scheduler.runAt(Date.parse(at), wakeRef, { ...pair, until: at })
  }
  await edits.flush()
  return changed
}

/* ---------------------------------------------------------- archived tasks
 * Archiving a task makes every inbox message about it read, for every
 * recipient. No inbox shows an archived task or a task in an archived
 * project (lib/workingSet.ts inWorkingSet), retention never retires an
 * unread row, and unread rows nobody can see would fill the bounded unread
 * walk (lib/inbox.ts) until visible messages drop out of it.
 *
 * postMessage stores news about such a task already read. For what was
 * stored before, every archive path schedules background steps
 * (scheduleArchivedReads). Those paths are archiveIssueCore and the machine
 * toggle in updateIssueCore with the subtree they stamp, the nightly sweep
 * (jobs.ts archiveProject) and archiveProjectCore. The marking happens
 * in steps because one task can have many followers with up to
 * ITEM_UNREAD_CAP + 1 rows each, so a big subtree, a project or a nightly
 * leg could pass the archiving transaction's write limit. Each step marks
 * at most ARCHIVED_READ_BATCH rows, visits at most ARCHIVED_READ_TASKS tasks
 * and schedules the rest. The same call schedules the steps that mark the
 * archived tasks' relation rows (model/archiveMarks.ts), so no task archive
 * path can leave one out.
 *
 * A step checks each task when it runs and leaves one that is no longer
 * archived alone, so a restore before the step runs keeps that task's
 * messages as they were. A snoozed item becomes read and loses its snooze,
 * so its scheduled wake finds nothing. Every touched item then keeps its
 * newest message, read (the prune's invariant). A step that runs twice finds
 * nothing left to mark. A restore changes nothing here. The Restored notice
 * arrives unread and, being the newest, the prune drops the older read
 * rows, as it does whenever news reaches a read item.
 *
 * While the archive stands, mark unread and snooze refuse the task
 * (refuseArchivedItems), so no inbox write reopens what the steps marked.
 * Mark read and remove still work on it. */

/** The most rows one archived-read step marks read. A row of its own
 * recipient costs up to six index ranges: two for its item's prune, two for
 * the recipient's sweep row and two for the recipient's build state and
 * the item's row (model/inboxItems.ts). Each task a step visits costs two
 * more, and a step over a list of tasks (readArchivedTaskMessages) also
 * reads each task, a third. A list step over ARCHIVED_READ_TASKS tasks then
 * reads at most about 3,480 of Convex's 4,096 ranges, and a project's step
 * about 3,000 (convex/tests/inboxItems.test.ts measures both). */
export const ARCHIVED_READ_BATCH = 330

/** The most tasks one archived-read step visits. scheduleTaskReads gives
 * each step at most this many task ids, and a project walk stops after this
 * many tasks, because each task costs index ranges whether or not it holds
 * a row to mark. */
export const ARCHIVED_READ_TASKS = 500

/* The rest of a chain as a step's arguments carry it, none when it ends. */
const chain = (rest: string[]) => (rest.length > 0 ? { rest } : {})

/** The most archived projects one chain of project steps walks, one after
 * another (scheduleArchivedReads), so an archive of a project with
 * thousands of sub-projects schedules a few chains, not one step a project,
 * within Convex's 1,000 functions one mutation may schedule. */
export const ARCHIVED_READ_PROJECTS = 100

/* The steps in convex/messages.ts, referenced by name like wakeRef. `batch`
 * lowers the rows per step in tests, and `tasks` the tasks a project step
 * visits. */
const readArchivedTasksRef = makeFunctionReference<
  'mutation',
  { issues: string[]; batch?: number },
  null
>('messages:readArchivedTasks')
const readArchivedProjectRef = makeFunctionReference<
  'mutation',
  { project_id: string; rest?: string[]; cursor?: string; batch?: number; tasks?: number },
  null
>('messages:readArchivedProject')

/**
 * Schedules the background steps that follow an archive. They mark every
 * message about the archived `issues`, and about the active tasks of the
 * archived `projects`, read. For the `issues` alone they also mark the
 * relation rows the label search then skips (model/archiveMarks.ts). A
 * project archive stamps no task, so its tasks keep theirs. The archive
 * paths call it in the transaction that archives.
 */
export async function scheduleArchivedReads(
  ctx: MutationCtx,
  a: { issues?: readonly string[]; projects?: readonly string[] },
): Promise<void> {
  const issues = a.issues ?? []
  await scheduleTaskReads(ctx, issues)
  await scheduleArchiveMarks(ctx, issues)
  const projects = a.projects ?? []
  for (let i = 0; i < projects.length; i += ARCHIVED_READ_PROJECTS) {
    const [project_id, ...rest] = projects.slice(i, i + ARCHIVED_READ_PROJECTS)
    await ctx.scheduler.runAfter(0, readArchivedProjectRef, { project_id, ...chain(rest) })
  }
}

/** Schedules readArchivedTaskMessages over the tasks `issues`,
 * ARCHIVED_READ_TASKS of them a step, without the archive marks that
 * scheduleArchivedReads adds. internal/archivedReadsBackfill calls it for
 * tasks archived before the archive paths marked their messages read. */
export async function scheduleTaskReads(
  ctx: MutationCtx,
  issues: readonly string[],
): Promise<void> {
  for (let i = 0; i < issues.length; i += ARCHIVED_READ_TASKS) {
    await ctx.scheduler.runAfter(0, readArchivedTasksRef, {
      issues: issues.slice(i, i + ARCHIVED_READ_TASKS),
    })
  }
}

/* A step's limit as a caller lowered it, or `fallback`, and at least one so
 * a step always makes progress. */
const stepLimit = (limit: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(limit ?? fallback))

/* Marks up to `budget` of the task's unread or snoozed rows read, for every
 * recipient, and keeps the prune's invariant on each item it touched. A row
 * already read keeps its stamp and only loses its snooze. Both index ranges
 * hold only rows that need a change (by_issue_read with no read_at, then
 * by_issue_snoozed), so the rows already read, one per recipient after the
 * prune, are never scanned and the step reads at most about `budget` rows
 * however many people follow the task. The snoozed range is checked even
 * when the unread rows used the whole budget, so a read row that kept its
 * snooze is never left to wake unread later. Each row it leaves read adds
 * its read_at to `earliest` (noteEarliest). `more` says rows remain for
 * the next step. */
async function readTaskMessages(
  ctx: MutationCtx,
  edits: ItemEdits,
  issueId: string,
  now: string,
  budget: number,
  earliest: Map<string, string>,
): Promise<{ marked: number; more: boolean }> {
  const unread = await ctx.db
    .query('messages')
    .withIndex('by_issue_read', (q) => q.eq('issue_id', issueId).eq('read_at', undefined))
    .take(budget + 1)
  const touched = unread.slice(0, budget)
  for (const row of touched) {
    await edits.patch(row, { read_at: now, snoozed_until: undefined })
  }
  let more = unread.length > budget
  if (!more) {
    // the unread rows marked above left this range, so what remains is a
    // read row that kept a snooze
    const room = budget - touched.length
    const snoozed = await ctx.db
      .query('messages')
      .withIndex('by_issue_snoozed', (q) =>
        q.eq('issue_id', issueId).gt('snoozed_until', undefined),
      )
      .take(room + 1)
    more = snoozed.length > room
    for (const row of snoozed.slice(0, room)) {
      await edits.patch(row, { snoozed_until: undefined })
      touched.push(row)
    }
  }
  for (const row of touched) noteEarliest(earliest, row.recipient_id, row.read_at ?? now)
  for (const recipient_id of new Set(touched.map((row) => row.recipient_id))) {
    await pruneStampedItem(ctx, edits, { recipient_id, issue_id: issueId }, budget)
  }
  return { marked: touched.length, more }
}

/* Calls noteSweepable once per recipient a read step left rows read for. */
async function noteSweepables(ctx: MutationCtx, earliest: Map<string, string>): Promise<void> {
  for (const [recipientId, readAt] of earliest) await noteSweepable(ctx, recipientId, readAt)
}

/**
 * One background step over archived tasks, then the next one scheduled with
 * the ids left. Each task in `issues`, in order, whose own archive or
 * project archive still stands has its unread and snoozed messages marked
 * read for every recipient. A task that was restored or deleted meanwhile is
 * skipped. The step stops after `batch` rows (ARCHIVED_READ_BATCH by
 * default), and the next one starts at the task it did not finish. It
 * visits at most the ids it carries, which scheduleArchivedReads keeps to
 * ARCHIVED_READ_TASKS.
 */
export async function readArchivedTaskMessages(
  ctx: MutationCtx,
  a: { issues: readonly string[]; batch?: number; now: string },
): Promise<void> {
  let budget = stepLimit(a.batch, ARCHIVED_READ_BATCH)
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const projectOf = (id: string) => {
    let project = projects.get(id)
    if (project === undefined) {
      project = byId(ctx, 'projects', id)
      projects.set(id, project)
    }
    return project
  }
  let rest: readonly string[] = []
  const earliest = new Map<string, string>()
  const edits = itemEdits(ctx)
  for (const [i, issueId] of a.issues.entries()) {
    if (budget === 0) {
      rest = a.issues.slice(i)
      break
    }
    const issue = await byId(ctx, 'issues', issueId)
    if (issue === null) continue
    if (
      issue.archived_at === undefined &&
      (await projectOf(issue.project_id))?.archived_at === undefined
    ) {
      continue
    }
    const step = await readTaskMessages(ctx, edits, issue.id, a.now, budget, earliest)
    budget -= step.marked
    if (step.more) {
      rest = a.issues.slice(i)
      break
    }
  }
  await edits.flush()
  await noteSweepables(ctx, earliest)
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, readArchivedTasksRef, { issues: [...rest], batch: a.batch })
  }
}

/* The most bytes of tasks one project walk step reads. Descriptions hold up
 * to TEXT_MAX characters (lib/limits.ts, at most about 60 KB stored), so
 * the page also ends early on bytes. */
const ARCHIVED_READ_TASK_BYTES = 8 * 1024 * 1024

/**
 * One background step over an archived project's active tasks, one page of
 * them from `cursor` (a Convex pagination cursor, absent for the start),
 * then the next one scheduled. A project that was restored or deleted
 * meanwhile ends the walk. Tasks the project held archived already were
 * handled by their own archive. A meta-project holds no tasks, so its walk
 * ends at once; its sub-projects archived with it are walked by their own
 * steps. A page holds at most `tasks` tasks (ARCHIVED_READ_TASKS by
 * default) and ARCHIVED_READ_TASK_BYTES of them, so a project with
 * thousands of tasks spreads over several steps. When the row budget
 * (`batch`, as in readArchivedTaskMessages) runs out inside the page, the
 * next step reads the same page again: the tasks already finished hold no
 * row to change and cost two index reads each, and every such step marks
 * at least one row, so the walk always ends. The cursor survives tasks
 * that share a creation time or are deleted between steps. Once a
 * project's walk ends, the step schedules the walk of the first project of
 * `rest`, with the others after it, so one chain walks a list of projects.
 */
export async function readArchivedProjectMessages(
  ctx: MutationCtx,
  a: {
    project_id: string
    rest?: string[]
    cursor?: string
    batch?: number
    tasks?: number
    now: string
  },
): Promise<void> {
  const rest = a.rest ?? []
  const next = async () => {
    const [project_id, ...after] = rest
    if (project_id !== undefined)
      await ctx.scheduler.runAfter(0, readArchivedProjectRef, {
        project_id,
        ...chain(after),
        batch: a.batch,
        tasks: a.tasks,
      })
  }
  const project = await byId(ctx, 'projects', a.project_id)
  if (project === null || project.archived_at === undefined) return await next()
  let budget = stepLimit(a.batch, ARCHIVED_READ_BATCH)
  const page = await ctx.db
    .query('issues')
    .withIndex('by_project_archived', (q) =>
      q.eq('project_id', project.id).eq('archived_at', undefined),
    )
    .paginate({
      cursor: a.cursor ?? null,
      numItems: stepLimit(a.tasks, ARCHIVED_READ_TASKS),
      maximumBytesRead: ARCHIVED_READ_TASK_BYTES,
    })
  let unfinished = false
  const earliest = new Map<string, string>()
  const edits = itemEdits(ctx)
  for (const task of page.page) {
    if (budget === 0) {
      unfinished = true
      break
    }
    const step = await readTaskMessages(ctx, edits, task.id, a.now, budget, earliest)
    budget -= step.marked
    if (step.more) {
      unfinished = true
      break
    }
  }
  await edits.flush()
  await noteSweepables(ctx, earliest)
  if (!unfinished && page.isDone) return await next()
  await ctx.scheduler.runAfter(0, readArchivedProjectRef, {
    project_id: project.id,
    ...chain(rest),
    cursor: unfinished ? a.cursor : page.continueCursor,
    batch: a.batch,
    tasks: a.tasks,
  })
}

/* ---------------------------------------------------------------- mentions
 * lib/mentions.ts reads the mentions out of a text. They map onto the
 * supplied profile list (callers pass the org's profiles — active or not,
 * the SQL org fence never filtered on active); unknown uuids drop. Every
 * write refuses a text with more than LIMITS.mentions.max mentions, so each
 * one reads at most that many profiles. */

/** The profiles among `profiles` that `text` mentions (lib/mentions.ts
 * mentionIds), at most LIMITS.mentions.max of them. */
export function extractMentions(text: string, profiles: Doc<'profiles'>[]): Doc<'profiles'>[] {
  return mentionIds(text, LIMITS.mentions.max).flatMap((id) => profiles.filter((p) => p.id === id))
}

/* The profiles of organization `orgId` that `text` mentions, read by uuid
 * through `cache`. Unknown and foreign uuids drop. Writes refuse a text with
 * more than LIMITS.mentions.max mentions, and the bound here keeps the reads
 * to that many regardless. */
async function mentionedIn(
  ctx: QueryCtx,
  text: string,
  cache: ProfileCache,
  orgId: string,
): Promise<Doc<'profiles'>[]> {
  const out: Doc<'profiles'>[] = []
  for (const id of mentionIds(text, LIMITS.mentions.max)) {
    const profile = await orgProfile(ctx, cache, orgId, id)
    if (profile !== undefined) out.push(profile)
  }
  return out
}

/* ------------------------------------------------------- follower notices
 * What a comment or a change tells a task's followers. Up to the first
 * FOLLOWER_FANOUT.inline followers hear in the writing transaction, while
 * the notice room it shares with the mentions lasts
 * (FOLLOWER_FANOUT.inlineRoom), and background steps of
 * FOLLOWER_FANOUT.step followers tell the rest, in by_issue_profile order. A bulk save leaves them all to the steps
 * (NotifyPreload.deferFollowers). A step tells the followers it finds then:
 * someone who stops following meanwhile hears nothing, and someone who
 * starts following before their turn hears too. It posts about the task as
 * it is then, so a task deleted meanwhile tells nobody more and an archived
 * one stores the notice already read (postMessage). */

/** How many followers one comment or change tells in its own transaction
 * (`inline`), and how many each background step tells after that (`step`).
 * A follower costs about two index ranges, a few writes and about a
 * millisecond, so a task followed by some thousands of people before
 * LIMITS.followers.max existed passed Convex's 4,096 ranges, and a bulk save of
 * tasks with many followers passed its 1 s. Keeping the follower's inbox
 * item (model/inboxItems.ts) adds two ranges and a write, and for someone
 * without a message yet one range and one write more: in tests a follower
 * of a comment read 4 to 6 ranges and wrote 2 or 3 rows. A task gains no
 * followers past LIMITS.followers.max now, besides owners who still follow.
 * A follower whose item holds snoozed rows also costs one write for each
 * row the notice wakes (postMessage), up to ITEM_UNREAD_CAP + 1, so a step
 * stops once it has made `stepRoom` database calls and leaves the rest to
 * the next. The writing transaction stops at `inlineRoom`, less, because
 * the write itself came first, and hands the rest to a step the same way;
 * the people it mentions count toward the same room (tellMentioned). The
 * room holds the first `inline` followers even when none has a message yet,
 * so a task at LIMITS.followers.max tells them all in the write. Tests
 * lower these. */
export const FOLLOWER_FANOUT = { inline: 128, step: 256, stepRoom: 2000, inlineRoom: 1250 }

/** What a fan-out tells every follower, before each reader's own lines. A
 * change carries its parts, its assignment and reviewer lines with the
 * assignee and reviewer they name, whether the reviewer was handed the task
 * in this write, and the new parent's project and key for the attach line. */
const vFollowerNote = v.union(
  v.object({ kind: v.literal('comment') }),
  v.object({
    kind: v.literal('change'),
    parts: v.array(v.string()),
    assigned: v.optional(v.string()),
    reviewer: v.optional(v.string()),
    handed: v.boolean(),
    assignee_id: v.optional(v.string()),
    reviewer_id: v.optional(v.string()),
    parent: v.optional(v.object({ id: v.string(), project_id: v.string(), key: v.string() })),
  }),
)

/** The arguments of a fan-out's background step (messages.ts
 * notifyFollowers): the notice, the people the write mentioned, who heard
 * of it already, and the last follower told before it (`after`). `task` is
 * the task's document, so a task deleted and restored meanwhile, or another
 * task with its uuid since, gets none of it, and `project_id` the task's
 * project when it was written, which a reader must still see. */
export const vFollowerStep = {
  org_id: v.string(),
  issue_id: v.string(),
  task: v.id('issues'),
  project_id: v.string(),
  actor_id: v.optional(v.string()),
  now: v.string(),
  note: vFollowerNote,
  mentioned: v.array(v.string()),
  after: v.optional(v.string()),
}
const followerStep = v.object(vFollowerStep)
type FollowerStep = Infer<typeof followerStep>
type FollowerNotice = Omit<FollowerStep, 'after'>

const notifyFollowersRef = makeFunctionReference<'mutation', FollowerStep, null>(
  'messages:notifyFollowers',
)

/* At most `n` of the task's followers after profile `after`, in
 * by_issue_profile order. */
const followersFrom = (ctx: QueryCtx, issueId: string, after: string | undefined, n: number) =>
  ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_profile', (q) =>
      after === undefined
        ? q.eq('issue_id', issueId)
        : q.eq('issue_id', issueId).gt('profile_id', after),
    )
    .take(n)

/* The line follower `profileId` reads of `notice`, or null for none. A
 * comment's mentioned people read their mention instead, and a fresh
 * mention replaces the bare description line, as they read it in the
 * message view. `seesParent` tells whether the reader can see the new
 * parent. */
async function followerLine(
  notice: FollowerNotice,
  profileId: string,
  seesParent: () => Promise<boolean>,
): Promise<string | null> {
  const { note } = notice
  const mentioned = notice.mentioned.includes(profileId)
  if (note.kind === 'comment') return mentioned ? null : 'New comment'
  let mine = mentioned ? note.parts.filter((x) => x !== 'Description updated') : [...note.parts]
  if (note.parent !== undefined) {
    const key = (await seesParent()) ? note.parent.key : 'a task in another sub-project'
    // Keep the hidden parent anonymous while using the same task wording
    // as the inbox and the machine surfaces. A subtask shares its parent's
    // top-level project (model/issues.ts sameTopLevel), so a parent the
    // reader cannot see is in a sub-project they cannot see. Messages
    // stored before that rule keep "a task in another project".
    mine = mine.map((x) => (x === ATTACH_SLOT ? `Attached under ${key}` : x))
  }
  // unshifted before the assignment line, so it reads second
  let reviewLine = note.reviewer
  if (profileId === note.reviewer_id) {
    if (note.handed) reviewLine = REVIEW_READY
    else if (note.reviewer !== undefined) reviewLine = 'Reviewer set to you'
  }
  if (reviewLine !== undefined) mine.unshift(reviewLine)
  if (note.assigned !== undefined) {
    mine.unshift(profileId === note.assignee_id ? 'Assigned to you' : note.assigned)
  }
  return mine.length === 0 ? null : mine.join('. ')
}

/* Tells each of `subs` of `notice` through postMessage, which drops the
 * actor's own copy, anyone who has left the organization and anyone who
 * can no longer see the project. `cx` holds what the caller read already,
 * and a bulk writer's guard, run before each follower. A reader must also
 * see each of `cx.also`, and reads the new parent's key only when they see
 * each of `cx.parent`; an empty `cx.parent` keeps it anonymous. Once
 * `cx.room` answers false it stops, after the first follower, and returns
 * how many of `subs` it handled. */
async function tellFollowers(
  ctx: MutationCtx,
  notice: FollowerNotice,
  subs: readonly Doc<'issue_subscriptions'>[],
  cx: {
    issue: Doc<'issues'>
    project: Doc<'projects'> | null
    also: readonly Doc<'projects'>[]
    parent: readonly Doc<'projects'>[]
    profiles: ProfileCache
    visibility: RecipientSight
    trims: ItemTrims
    items?: ItemEdits
    guard?: () => Promise<void>
    room: () => boolean
  },
): Promise<number> {
  let handled = 0
  for (const s of subs) {
    if (handled > 0 && !cx.room()) break
    handled += 1
    await cx.guard?.()
    const recipient = await orgProfile(ctx, cx.profiles, notice.org_id, s.profile_id)
    const seesAll = async (projects: readonly Doc<'projects'>[]) => {
      if (recipient === undefined) return false
      for (const p of projects)
        if (!(await recipientCanSee(ctx, recipient, p, cx.visibility))) return false
      return true
    }
    if (cx.also.length > 0 && !(await seesAll(cx.also))) continue
    const line = await followerLine(
      notice,
      s.profile_id,
      async () => cx.parent.length > 0 && (await seesAll(cx.parent)),
    )
    if (line === null) continue
    await postMessage(ctx, {
      org_id: notice.org_id,
      recipient_id: s.profile_id,
      issue_id: notice.issue_id,
      kind: notice.note.kind,
      body: line,
      actor_id: notice.actor_id,
      now: notice.now,
      issue: cx.issue,
      project: cx.project ?? undefined,
      recipient,
      visibility: cx.visibility,
      trims: cx.trims,
      items: cx.items,
    })
  }
  return handled
}

/* Tells the first `inline` of `subs`, read with followersFrom from the
 * start and one more, and schedules a background step for the rest, from
 * the last follower handled when `cx.room` stopped it early. */
async function fanOut(
  ctx: MutationCtx,
  notice: FollowerNotice,
  subs: readonly Doc<'issue_subscriptions'>[],
  inline: number,
  cx: Parameters<typeof tellFollowers>[3],
): Promise<void> {
  const now = subs.slice(0, inline)
  const handled = await tellFollowers(ctx, notice, now, cx)
  if (handled === now.length && subs.length <= inline) return
  const after = now[handled - 1]?.profile_id
  await ctx.scheduler.runAfter(
    0,
    notifyFollowersRef,
    after === undefined ? notice : { ...notice, after },
  )
}

/** One background step of a fan-out (FOLLOWER_FANOUT): tells the next
 * FOLLOWER_FANOUT.step followers after profile `after` about the task as it
 * is now, and schedules the next step while more follow. A reader must see
 * both the task's project when it was written and its project now, so a
 * move meanwhile tells nobody what they could not see, and reads the new
 * parent's key only when they see its project then and now. Anything gone
 * that the notice names tells nobody, or keeps the parent anonymous. The
 * step stops early once its database calls reach FOLLOWER_FANOUT.stepRoom. */
export async function notifyFollowersStep(step: MutationCtx, a: FollowerStep): Promise<void> {
  const used = { calls: 0 }
  const ctx = counting(step, used)
  const { after, ...written } = a
  const notice = { ...written, actor_id: await actorThen(ctx, written) }
  const issue = await ctx.db.get(notice.task)
  if (issue === null || issue.id !== notice.issue_id || issue.org_id !== notice.org_id) return
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null) return
  const then =
    notice.project_id === project.id ? project : await byId(ctx, 'projects', notice.project_id)
  if (then === null) return
  const parent: Doc<'projects'>[] = []
  const { note } = notice
  if (note.kind === 'change' && note.parent !== undefined) {
    const was = await byId(ctx, 'projects', note.parent.project_id)
    const row = await byId(ctx, 'issues', note.parent.id)
    const is = row === null ? null : await byId(ctx, 'projects', row.project_id)
    if (was !== null && is !== null) parent.push(...(was.id === is.id ? [was] : [was, is]))
  }
  const trims = newItemTrims()
  const subs = await followersFrom(ctx, issue.id, after, FOLLOWER_FANOUT.step + 1)
  await fanOut(ctx, notice, subs, FOLLOWER_FANOUT.step, {
    issue,
    project,
    also: then === project ? [] : [then],
    parent,
    profiles: new Map(),
    visibility: new Map(),
    trims,
    room: () => used.calls < FOLLOWER_FANOUT.stepRoom,
  })
  await scheduleItemTrims(ctx, issue.id, trims)
}

/** The author of a notice a background step posts: `actor_id` while a
 * profile with that id exists and already existed when the write happened
 * (`now`), else none. An author removed meanwhile has had every message
 * naming them cleared (profileRemovals.ts), so a step must not name them
 * again, nor a later profile that took their id. */
async function actorThen(
  ctx: QueryCtx,
  a: { actor_id?: string; now: string },
): Promise<string | undefined> {
  if (a.actor_id === undefined) return undefined
  const actor = await byId(ctx, 'profiles', a.actor_id)
  return actor !== null && actor.created_at <= a.now ? actor.id : undefined
}

/** `ctx` whose database calls each add one to `used.calls`. A read uses an
 * index range, and a write reads its row first, so the count follows the
 * ranges a transaction spends, writes included. */
function counting(ctx: MutationCtx, used: { calls: number }): MutationCtx {
  const db = new Proxy(ctx.db, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        used.calls += 1
        return value.apply(target, args)
      }
    },
  })
  return { ...ctx, db }
}

/** The room a writing transaction gives its notices: `ctx` counting its
 * database calls, and `room`, true while they are fewer than
 * FOLLOWER_FANOUT.inlineRoom. A write's mentions and its follower fan-out
 * share one. */
function inlineRoom(ctx: MutationCtx): { ctx: MutationCtx; room: () => boolean } {
  const used = { calls: 0 }
  return { ctx: counting(ctx, used), room: () => used.calls < FOLLOWER_FANOUT.inlineRoom }
}

/** The arguments of a background step that tells people a write mentioned
 * them (messages.ts notifyMentions): `body` for each of `recipients`, about
 * task document `task`, whose project was `project_id` when written. */
export const vMentionStep = {
  org_id: v.string(),
  issue_id: v.string(),
  task: v.id('issues'),
  project_id: v.string(),
  actor_id: v.optional(v.string()),
  now: v.string(),
  body: v.string(),
  recipients: v.array(v.string()),
}
const mentionStep = v.object(vMentionStep)
type MentionStep = Infer<typeof mentionStep>

const notifyMentionsRef = makeFunctionReference<'mutation', MentionStep, null>(
  'messages:notifyMentions',
)

/** Subscribes each of `mentioned` to `issue`, as a mention does (FollowCap
 * 'skip'), and tells them `body`: in this transaction while `room` answers
 * true, and the rest from one background step (notifyMentionsStep). A
 * mentioned person whose item holds snoozed rows costs a write for each row
 * the notice wakes, so a text that mentions up to LIMITS.mentions.max such
 * people would pass the transaction's limits. `guard` is a bulk writer's
 * (NotifyPreload), run before each. */
async function tellMentioned(
  ctx: MutationCtx,
  a: {
    issue: Doc<'issues'>
    project: Doc<'projects'> | null
    actor_id: string | undefined
    now: string
    body: string
    mentioned: readonly Doc<'profiles'>[]
    visibility: RecipientSight
    trims: ItemTrims
    items?: ItemEdits
    room: () => boolean
    guard?: () => Promise<void>
  },
): Promise<void> {
  const { issue, project } = a
  const later: string[] = []
  for (const m of a.mentioned) {
    await a.guard?.()
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      task_key: issue.window_key,
      profile: m,
      org_id: issue.org_id,
      project,
      now: a.now,
      cap: 'skip',
      visibility: a.visibility,
    })
    if (!a.room()) {
      later.push(m.id)
      continue
    }
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: a.body,
      actor_id: a.actor_id,
      now: a.now,
      issue,
      project: project ?? undefined,
      recipient: m,
      visibility: a.visibility,
      trims: a.trims,
      items: a.items,
    })
  }
  if (later.length > 0)
    await ctx.scheduler.runAfter(0, notifyMentionsRef, {
      org_id: issue.org_id,
      issue_id: issue.id,
      task: issue._id,
      project_id: issue.project_id,
      actor_id: a.actor_id,
      now: a.now,
      body: a.body,
      recipients: later,
    })
}

/** One background step of tellMentioned: tells `recipients` in order about
 * the task as it is now, until its database calls reach
 * FOLLOWER_FANOUT.stepRoom, and schedules the next step with the rest. As
 * for followers (notifyFollowersStep), a reader must see the task's project
 * when it was written and now, a task deleted meanwhile tells nobody, and an
 * author removed meanwhile is not named (actorThen). */
export async function notifyMentionsStep(step: MutationCtx, a: MentionStep): Promise<void> {
  const used = { calls: 0 }
  const ctx = counting(step, used)
  const actor_id = await actorThen(ctx, a)
  const issue = await ctx.db.get(a.task)
  if (issue === null || issue.id !== a.issue_id || issue.org_id !== a.org_id) return
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null) return
  const then = a.project_id === project.id ? project : await byId(ctx, 'projects', a.project_id)
  if (then === null) return
  const profiles: ProfileCache = new Map()
  const visibility: RecipientSight = new Map()
  const trims = newItemTrims()
  let handled = 0
  for (const id of a.recipients) {
    if (handled > 0 && used.calls >= FOLLOWER_FANOUT.stepRoom) break
    handled += 1
    const recipient = await orgProfile(ctx, profiles, a.org_id, id)
    if (recipient === undefined) continue
    if (then !== project && !(await recipientCanSee(ctx, recipient, then, visibility))) continue
    await postMessage(ctx, {
      org_id: a.org_id,
      recipient_id: id,
      issue_id: issue.id,
      kind: 'mention',
      body: a.body,
      actor_id,
      now: a.now,
      issue,
      project,
      recipient,
      visibility,
      trims,
    })
  }
  if (handled < a.recipients.length)
    await ctx.scheduler.runAfter(0, notifyMentionsRef, {
      ...a,
      recipients: a.recipients.slice(handled),
    })
  await scheduleItemTrims(ctx, issue.id, trims)
}

/** Tells the followers of `issue`, in `project`, one change line, `parts`
 * joined: up to the first FOLLOWER_FANOUT.inline in this transaction, while
 * its notice room lasts, and the rest in background steps. A restore from Deleted items says 'Restored' this
 * way (model/deletedItems.ts). */
export async function notifyFollowersOfChange(
  ctx: MutationCtx,
  a: {
    issue: Doc<'issues'>
    project: Doc<'projects'>
    actor: Doc<'profiles'>
    now: string
    parts: string[]
  },
): Promise<void> {
  const { issue, project } = a
  const trims = newItemTrims()
  const subs = await followersFrom(ctx, issue.id, undefined, FOLLOWER_FANOUT.inline + 1)
  const notices = inlineRoom(ctx)
  await fanOut(
    notices.ctx,
    {
      org_id: issue.org_id,
      issue_id: issue.id,
      task: issue._id,
      project_id: issue.project_id,
      actor_id: a.actor.id,
      now: a.now,
      note: { kind: 'change', parts: a.parts, handed: false },
      mentioned: [],
    },
    subs,
    FOLLOWER_FANOUT.inline,
    {
      issue,
      project,
      also: [],
      parent: [],
      profiles: new Map(),
      visibility: new Map(),
      trims,
      room: notices.room,
    },
  )
  await scheduleItemTrims(ctx, issue.id, trims)
}

/* ---------------------------------------------------------- notify: insert
 * notify_issue_insert (0114:167-194): mentions subscribe + hear about it;
 * an assignee subscribes and — unless they are the actor or already
 * mentioned — reads 'Assigned to you'. A task created In Review with a
 * reviewer is the reviewer's, so the reviewer subscribes too and, on the
 * same terms, reads 'Ready for your review' (an assignee who is also the
 * reviewer reads only 'Assigned to you'). No subscriber fan-out: a task one
 * statement old has no other subscribers by construction. */
export async function notifyIssueInsert(
  ctx: MutationCtx,
  a: {
    issue: Doc<'issues'>
    /** the new task's text, which its writer holds */
    description: string
    actor: Doc<'profiles'>
    now: string
    preload?: NotifyPreload
    skipTaskEvent?: boolean
  },
): Promise<void> {
  const { issue, actor, now, preload } = a
  if (!a.skipTaskEvent) await emitTaskEvent(ctx, { name: 'task.created', issue, actor, now })
  const project = await preloadedProject(ctx, preload, issue.project_id)
  const profiles = preload?.profiles ?? new Map()
  const visibility: RecipientSight = preload?.visibility ?? new Map()
  const trims = newItemTrims()
  const mentioned = await mentionedIn(ctx, a.description, profiles, issue.org_id)
  const notices = inlineRoom(ctx)
  await tellMentioned(notices.ctx, {
    issue,
    project,
    actor_id: actor.id,
    now,
    body: MENTION_DETAILS.description,
    mentioned,
    visibility,
    trims,
    items: preload?.items,
    room: notices.room,
  })
  if (issue.assignee_id !== undefined) {
    const assignee = await orgProfile(ctx, profiles, issue.org_id, issue.assignee_id)
    // a missing profile is skipped (the org fence would drop both writes),
    // but the reviewer below still hears about the task
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        task_key: issue.window_key,
        profile: assignee,
        org_id: issue.org_id,
        project,
        now,
        cap: 'pass',
        visibility,
      })
      if (assignee.id !== actor.id && !mentioned.some((p) => p.id === assignee.id)) {
        await postMessage(ctx, {
          org_id: issue.org_id,
          recipient_id: assignee.id,
          issue_id: issue.id,
          kind: 'change',
          body: 'Assigned to you',
          actor_id: actor.id,
          now,
          issue,
          project: project ?? undefined,
          recipient: assignee,
          visibility,
          trims,
          items: preload?.items,
        })
      }
    }
  }
  // a task created In Review is the reviewer's: they follow it and hear so
  if (reviewerOwns(issue) && issue.reviewer_id !== issue.assignee_id) {
    const reviewer = await orgProfile(ctx, profiles, issue.org_id, issue.reviewer_id as string)
    if (reviewer !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        task_key: issue.window_key,
        profile: reviewer,
        org_id: issue.org_id,
        project,
        now,
        cap: 'pass',
        visibility,
      })
      if (reviewer.id !== actor.id && !mentioned.some((p) => p.id === reviewer.id)) {
        await postMessage(ctx, {
          org_id: issue.org_id,
          recipient_id: reviewer.id,
          issue_id: issue.id,
          kind: 'change',
          body: REVIEW_READY,
          actor_id: actor.id,
          now,
          issue,
          project: project ?? undefined,
          recipient: reviewer,
          visibility,
          trims,
          items: preload?.items,
        })
      }
    }
  }
  await scheduleItemTrims(ctx, issue.id, trims)
}

/* ---------------------------------------------------------- notify: update
 * notify_issue_update (0114:196-352). Diffs ONLY the trigger's column list;
 * a write that changes nothing in it must not post. Callers hand the STORED
 * before/after rows, for the remaining-clear side-effect write too, except
 * that a write that changes the description hands both with their text
 * (model/descriptions.ts withText, textsOf), which the stored rows stop
 * holding in the third release of the description move. A
 * group's calculated dates are never stored, so a subtask moving its span
 * sends the group's followers nothing.
 *
 * `suppressNotify` replaces pg_trigger_depth() <= 1 and drops ONLY the
 * Archived/Restored narration line. Only the restore cascade passes it, for
 * the ancestors restoreAncestors brings back, so a cleared remaining still
 * narrates to their followers. The archive cascade never notifies its
 * descendants (model/issues.ts archiveSubtree), so one archive click is one
 * message, the root's, per subscriber. The flag sits upstream of the
 * fan-out, so it cannot multiply per subscriber. The nightly archive sweep
 * (jobs.ts archiveProject) does not call this and posts no message.
 *
 * Ownership (#314): when the task passes to someone else (lib/review.ts's
 * taskOwnerId), the new owner starts following it. A reviewer handed the
 * task reads 'Ready for your review' after any assignment line and before
 * the change parts; both lines are said from the reader's side.
 *
 * `isGroup` marks a task with active subtasks, which always stays with its
 * assignee, so no write hands it over. The writers that can clear a group's
 * dormant reviewer (updateIssueCore, moveIssueCore) pass it; every other
 * caller changes neither the status nor the reviewer.
 *
 * `actor` is absent only for a Deleted items step whose deleter is gone
 * (model/deletedItems.ts), which also passes the step's `preload`, and for a
 * restore's regroup step whose restorer is gone (regroup.ts).
 *
 * `preload` is a bulk writer's NotifyPreload, which keeps the profiles,
 * the projects and the recipients' sight it read for the next task, and
 * whose `guard` runs before each mention and follower. Without one each
 * profile the call names is read once, and the recipients' sight is worked
 * out once per project for the call (RecipientSight).
 *
 * Past FOLLOWER_FANOUT.inline followers or the save's notice room, and for
 * every follower of a bulk save (NotifyPreload.deferFollowers), background
 * steps tell the rest. */
export async function notifyIssueUpdate(
  ctx: MutationCtx,
  a: {
    before: Doc<'issues'>
    after: Doc<'issues'>
    actor: Doc<'profiles'> | undefined
    now: string
    suppressNotify?: boolean
    skipTaskEvent?: boolean
    isGroup?: boolean
    preload?: NotifyPreload
  },
): Promise<void> {
  const { before, after, actor, now, preload } = a
  if (!a.skipTaskEvent)
    await emitTaskEvent(ctx, {
      name: 'task.updated',
      issue: after,
      before,
      actor,
      now,
      guard: preload?.guard,
    })
  const isGroup = a.isGroup === true
  const project = await preloadedProject(ctx, preload, after.project_id)
  const profiles = preload?.profiles ?? new Map()
  const profileOf = (id: string) => orgProfile(ctx, profiles, after.org_id, id)
  const visibility: RecipientSight = preload?.visibility ?? new Map()
  const trims = newItemTrims()

  // @mentions newly added to the description notify regardless of
  // subscribers, and subscribe the person to what they were pulled into. An
  // unchanged description adds none, so a bulk write of dates skips the
  // scan. A write that changes the description passes both documents with
  // their text (model/descriptions.ts textsOf).
  const texts = textsOf(before, after)
  const described = texts.after !== texts.before
  const oldMentions = described ? mentionIds(texts.before) : []
  const newMentions = described
    ? (await mentionedIn(ctx, texts.after, profiles, after.org_id)).filter(
        (p) => !oldMentions.includes(p.id),
      )
    : []
  // mentions and followers share the room the write leaves its notices
  const notices = inlineRoom(ctx)
  await tellMentioned(notices.ctx, {
    issue: after,
    project,
    actor_id: actor?.id,
    now,
    body: MENTION_DETAILS.description,
    mentioned: newMentions,
    visibility,
    trims,
    items: preload?.items,
    room: notices.room,
    guard: preload?.guard,
  })

  // a new assignee starts following; the old one keeps following — being
  // taken off a task is news you want (0114:228-229)
  if (after.assignee_id !== before.assignee_id && after.assignee_id !== undefined) {
    const assignee = await profileOf(after.assignee_id)
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        task_key: after.window_key,
        profile: assignee,
        org_id: after.org_id,
        project,
        now,
        cap: 'pass',
        visibility,
      })
    }
  }

  // whoever the task passes to starts following it: the reviewer when it
  // enters Review or is handed over in Review, the assignee when it leaves
  // Review (#314). A reviewer set outside Review owns nothing yet.
  const ownerAfter = taskOwnerId(after, isGroup)
  if (ownerAfter !== undefined && ownerAfter !== taskOwnerId(before, isGroup)) {
    const owner = await profileOf(ownerAfter)
    if (owner !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        task_key: after.window_key,
        profile: owner,
        org_id: after.org_id,
        project,
        now,
        cap: 'pass',
        visibility,
      })
    }
  }
  // the reviewer was handed the task in this write, not merely kept
  const handedToReviewer =
    reviewerOwns(after, isGroup) &&
    !(reviewerOwns(before, isGroup) && before.reviewer_id === after.reviewer_id)

  // the cheap exit: with nobody following, there is nothing to narrate for.
  // A bulk save tells no follower itself, so one row tells whether any does.
  const inline = preload?.deferFollowers ? 0 : FOLLOWER_FANOUT.inline
  const subs = await followersFrom(ctx, after.id, undefined, inline + 1)
  if (subs.length === 0) return await scheduleItemTrims(ctx, after.id, trims)

  // narrate what changed (from → to, mirroring the activity feed's rule)
  const parts: string[] = []
  if (after.status !== before.status) {
    parts.push(`Status: ${STATUS_NAMES[before.status]} → ${STATUS_NAMES[after.status]}`)
  }
  if (after.priority !== before.priority) {
    parts.push(`Priority: ${PRIORITY_NAMES[before.priority]} → ${PRIORITY_NAMES[after.priority]}`)
  }
  if (after.title !== before.title) {
    parts.push(`Title: “${before.title}” → “${after.title}”`)
  }
  if (described) {
    parts.push('Description updated')
  }
  if (after.due_date !== before.due_date) {
    const od = before.due_date
    const nd = after.due_date
    if (od === undefined && nd !== undefined) parts.push(`Due set to ${fmtDayMon(nd)}`)
    else if (nd === undefined && od !== undefined) parts.push(`Due cleared (was ${fmtDayMon(od)})`)
    else if (od !== undefined && nd !== undefined) {
      parts.push(`Due: ${fmtDayMon(od)} → ${fmtDayMon(nd)}`)
    }
  }
  if (after.start_week !== before.start_week || after.end_week !== before.end_week) {
    // half-null pairs cannot exist under the both-or-neither CHECK, but each
    // side still renders '…' for a missing half, like the SQL's coalesce
    const sched = (s: string | undefined, e: string | undefined): string | undefined =>
      s === undefined && e === undefined
        ? undefined
        : `${s === undefined ? '…' : fmtDayMon(s)} – ${e === undefined ? '…' : fmtDayMon(e)}`
    const oldSched = sched(before.start_week, before.end_week)
    const newSched = sched(after.start_week, after.end_week)
    if (oldSched === undefined && newSched !== undefined) parts.push(`Scheduled ${newSched}`)
    else if (newSched === undefined && oldSched !== undefined) {
      parts.push(`Unscheduled (was ${oldSched})`)
    } else if (oldSched !== undefined && newSched !== undefined) {
      parts.push(`Schedule: ${oldSched} → ${newSched}`)
    }
  }
  if (after.remaining_hours !== before.remaining_hours) {
    const oh = before.remaining_hours
    const nh = after.remaining_hours
    if (oh === undefined && nh !== undefined) parts.push(`Remaining set to ${fmtHours(nh)} h`)
    else if (nh === undefined && oh !== undefined) {
      parts.push(`Remaining cleared (was ${fmtHours(oh)} h)`)
    } else if (oh !== undefined && nh !== undefined) {
      parts.push(`Remaining: ${fmtHours(oh)} h → ${fmtHours(nh)} h`)
    }
  }
  if (after.paused !== before.paused) parts.push(after.paused ? 'Paused' : 'Resumed')
  if (after.project_id !== before.project_id) {
    parts.push(`Moved to ${project?.name ?? 'another project'}`)
  }
  // the new parent, for the attach line each reader reads from their side
  let parent: { id: string; project_id: string; key: string } | undefined
  let parentProject: Doc<'projects'> | null = null
  if (after.parent_id !== before.parent_id) {
    if (after.parent_id === undefined) {
      parts.push('Detached from its parent')
    } else {
      const row = await byId(ctx, 'issues', after.parent_id)
      if (row !== null) {
        parent = { id: row.id, project_id: row.project_id, key: `QN-${row.num}` }
        parentProject = await preloadedProject(ctx, preload, row.project_id)
        parts.push(ATTACH_SLOT)
      }
    }
  }
  if (after.archived_at !== before.archived_at && a.suppressNotify !== true) {
    parts.push(after.archived_at !== undefined ? 'Archived' : 'Restored')
  }

  // the assignment line, said from the reader's side at fan-out
  let assignedLine: string | undefined
  if (after.assignee_id !== before.assignee_id) {
    if (after.assignee_id === undefined) {
      const oldName =
        before.assignee_id === undefined ? undefined : (await profileOf(before.assignee_id))?.name
      assignedLine = `Unassigned (was ${oldName ?? 'someone'})`
    } else {
      const newName = (await profileOf(after.assignee_id))?.name
      assignedLine = `Assigned to ${newName ?? 'someone'}`
    }
  }
  // the reviewer line, likewise; the reviewer's own copy is chosen per reader
  let reviewerLine: string | undefined
  if (after.reviewer_id !== before.reviewer_id) {
    if (after.reviewer_id === undefined) {
      const oldName =
        before.reviewer_id === undefined ? undefined : (await profileOf(before.reviewer_id))?.name
      reviewerLine = `Reviewer removed (was ${oldName ?? 'someone'})`
    } else {
      const newName = (await profileOf(after.reviewer_id))?.name
      reviewerLine = `Reviewer set to ${newName ?? 'someone'}`
    }
  }

  if (parts.length === 0 && assignedLine === undefined && reviewerLine === undefined) {
    return await scheduleItemTrims(ctx, after.id, trims)
  }

  const note: FollowerNotice['note'] = {
    kind: 'change',
    parts,
    handed: handedToReviewer,
    ...(assignedLine === undefined ? {} : { assigned: assignedLine }),
    ...(reviewerLine === undefined ? {} : { reviewer: reviewerLine }),
    ...(after.assignee_id === undefined ? {} : { assignee_id: after.assignee_id }),
    ...(after.reviewer_id === undefined ? {} : { reviewer_id: after.reviewer_id }),
    ...(parent === undefined ? {} : { parent }),
  }
  await fanOut(
    notices.ctx,
    {
      org_id: after.org_id,
      issue_id: after.id,
      task: after._id,
      project_id: after.project_id,
      ...(actor === undefined ? {} : { actor_id: actor.id }),
      now,
      note,
      mentioned: newMentions.map((m) => m.id),
    },
    subs,
    inline,
    {
      issue: after,
      project,
      also: [],
      parent: parentProject === null ? [] : [parentProject],
      profiles,
      visibility,
      trims,
      items: preload?.items,
      guard: preload?.guard,
      room: notices.room,
    },
  )
  await scheduleItemTrims(ctx, after.id, trims)
}

/* --------------------------------------------------------- notify: comment
 * notify_comment_insert (0114:354-382): mentions subscribe + hear about it;
 * the author subscribes (saying something is the clearest statement that you
 * want to hear the reply); every subscriber EXCEPT the mentioned reads
 * 'New comment'. `actor` is the comment's author; of the comment itself
 * only the body is read. The recipients' sight is worked out once per
 * project (RecipientSight). Past FOLLOWER_FANOUT.inline followers or the
 * save's notice room, background steps tell the rest, the mentioned people
 * included (tellMentioned). */
export async function notifyCommentInsert(
  ctx: MutationCtx,
  a: {
    comment: Pick<Doc<'comments'>, 'body'>
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    preload?: NotifyPreload
    skipTaskEvent?: boolean
  },
): Promise<void> {
  const { comment, issue, actor, now, preload } = a
  if (!a.skipTaskEvent) await emitTaskEvent(ctx, { name: 'comment.created', issue, actor, now })
  const project = await preloadedProject(ctx, preload, issue.project_id)
  const profiles = preload?.profiles ?? new Map()
  const visibility: RecipientSight = preload?.visibility ?? new Map()
  const trims = newItemTrims()
  const mentioned = await mentionedIn(ctx, comment.body, profiles, issue.org_id)
  // mentions and followers share the room the write leaves its notices
  const notices = inlineRoom(ctx)
  await tellMentioned(notices.ctx, {
    issue,
    project,
    actor_id: actor.id,
    now,
    body: MENTION_DETAILS.comment,
    mentioned,
    visibility,
    trims,
    items: preload?.items,
    room: notices.room,
  })
  await subscribeToIssue(ctx, {
    issue_id: issue.id,
    task_key: issue.window_key,
    profile: actor,
    org_id: issue.org_id,
    project,
    now,
    cap: 'skip',
    visibility,
  })
  const subs = await followersFrom(ctx, issue.id, undefined, FOLLOWER_FANOUT.inline + 1)
  await fanOut(
    notices.ctx,
    {
      org_id: issue.org_id,
      issue_id: issue.id,
      task: issue._id,
      project_id: issue.project_id,
      actor_id: actor.id,
      now,
      note: { kind: 'comment' },
      mentioned: mentioned.map((m) => m.id),
    },
    subs,
    FOLLOWER_FANOUT.inline,
    {
      issue,
      project,
      also: [],
      parent: [],
      profiles,
      visibility,
      trims,
      items: preload?.items,
      room: notices.room,
    },
  )
  await scheduleItemTrims(ctx, issue.id, trims)
}

/* notify_comment_update (0114:384-403): only when the body changed; mentions
 * ADDED by the edit subscribe + hear about it. `actor` is the caller's
 * resolution of coalesce(edited_by, author). Phase 5's comments.update
 * composes this. */
export async function notifyCommentUpdate(
  ctx: MutationCtx,
  a: {
    before: Doc<'comments'>
    after: Doc<'comments'>
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
  },
): Promise<void> {
  const { before, after, issue, actor, now } = a
  if (after.body === before.body) return
  const project = await byId(ctx, 'projects', issue.project_id)
  const oldMentions = mentionIds(before.body)
  const added = (await mentionedIn(ctx, after.body, new Map(), issue.org_id)).filter(
    (p) => !oldMentions.includes(p.id),
  )
  const trims = newItemTrims()
  const notices = inlineRoom(ctx)
  await tellMentioned(notices.ctx, {
    issue,
    project,
    actor_id: actor.id,
    now,
    body: MENTION_DETAILS.comment,
    mentioned: added,
    visibility: new Map(),
    trims,
    room: notices.room,
  })
  await scheduleItemTrims(ctx, issue.id, trims)
}
