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
 * mark unread and snooze refuse such a task (refuseArchivedItems). */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { canSeeProject, keepsInbox, profileCanSeeProject } from '../lib/access'
import { byId } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { badRequest, forbidden, rule } from '../lib/functions'
import { reviewerOwns, taskOwnerId } from '../lib/review'
import { issueKey, PRIORITY_NAMES, STATUS_NAMES } from '../lib/taskRefs'
import { newUuid } from './orgs'
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
 * snooze on the pair ends. Returns how many rows it wrote, 0 when nothing
 * woke. It writes each row of the item at most once, so a wake writes at
 * most ITEM_UNREAD_CAP + 1 rows, which the nightly sweep budgets on. */
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
  const issue = await byId(ctx, 'issues', a.issue_id)
  const project = issue === null ? null : await byId(ctx, 'projects', issue.project_id)
  if (issue?.archived_at === undefined && project?.archived_at === undefined) {
    for (const r of rows) {
      await ctx.db.patch(r._id, { snoozed_until: undefined, read_at: undefined, woke_at: now })
    }
    return rows.length
  }
  // Messages about an archived task stay read (see "archived tasks" below),
  // so such an item only loses its snooze and does not return. Its rows are
  // read now, so it keeps only its newest row, as pruneReadMessages leaves
  // an item after a mark read. A row the prune would drop is deleted
  // without a patch first, since Convex counts every write.
  const waking = new Set(rows.map((r) => r._id))
  const newest = item.reduce((best, r) => (oldestFirst(best, r) < 0 ? r : best))
  let written = 0
  for (const r of item) {
    if (r._id === newest._id) {
      if (!waking.has(r._id)) continue
      await ctx.db.patch(r._id, { snoozed_until: undefined, read_at: r.read_at ?? now })
    } else if (waking.has(r._id) || r.read_at !== undefined) {
      await ctx.db.delete(r._id)
    } else {
      continue
    }
    written += 1
  }
  return written
}

/* Oldest first by (created_at, id), the total order the prune uses too. */
function oldestFirst(a: Doc<'messages'>, b: Doc<'messages'>): number {
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
 * message" is the item cap below (trimUnreadMessages). */
export async function pruneReadMessages(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
  preloaded?: Doc<'messages'>[],
): Promise<void> {
  const rows = preloaded ?? (await pairRows(ctx, a))
  if (rows.length === 0) return
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
    if (r._id !== newest._id && r.read_at !== undefined) await ctx.db.delete(r._id)
  }
}

/* -------------------------------------------------------------- item cap
 * The most UNREAD messages one inbox item keeps. Every pair-level operation
 * reads the whole item: pairRows in postMessage (on every comment and
 * change to the task), snooze, wake, the prune after mark read and the
 * machine inbox's item actions (itemMessages). Without a cap, a follower or
 * an agent that never reads its inbox would grow one item on a busy task
 * without limit, until each new comment or change to that task read more
 * than one transaction allows and failed for everybody, and snoozing or
 * marking the item read failed too. Only arrivals add rows, and the prune
 * keeps at most one read row, so an item held at the cap stays within
 * ITEM_UNREAD_CAP + 1 rows. An item that grew past the cap before the cap
 * existed shrinks by up to ITEM_TRIM_STEP rows per arrival, so it reaches
 * the cap over later arrivals. */
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

/* Collapses an oversized item. When `rows` (the whole item, as postMessage
 * read it after its insert) holds more than ITEM_UNREAD_CAP unread rows, it
 * deletes the oldest unread rows, by (created_at, id) like the prune, until
 * the item holds the cap or ITEM_TRIM_STEP rows are gone. It never deletes
 * the item's oldest unread row, which marks where the unread run starts
 * (src/lib/spine.ts firstUnreadTs puts the New divider there), nor the
 * newest unread row of each kind, so the Inbox kind filter still finds the
 * item. This is separate from retention, and the nightly sweep still never
 * deletes an unread row. */
async function trimUnreadMessages(
  ctx: MutationCtx,
  rows: readonly Doc<'messages'>[],
): Promise<void> {
  const unread = rows.filter((r) => r.read_at === undefined).sort(oldestFirst)
  let excess = Math.min(unread.length - ITEM_UNREAD_CAP, ITEM_TRIM_STEP)
  if (excess <= 0) return
  const newestOfKind = new Map<MessageKind, Doc<'messages'>>()
  for (const r of unread) newestOfKind.set(r.kind, r)
  const kept = new Set([unread[0]._id, ...[...newestOfKind.values()].map((r) => r._id)])
  for (const r of unread) {
    if (excess === 0) break
    if (kept.has(r._id)) continue
    await ctx.db.delete(r._id)
    excess -= 1
  }
}

/* ---------------------------------------------------------------- preload
 * Rows a bulk writer already holds, handed to notifyIssueInsert and
 * notifyCommentInsert so each call need not read them again. A preload is a
 * snapshot: it is valid only while nothing in the transaction changes
 * profiles, projects, grants or teams, so it must never be passed from an
 * interactive mutation. Only the Northstar seed (demoSeed.ts's
 * writeNorthstarWork) passes one; interactive mutations pass nothing and
 * every row is read fresh. */
export type NotifyPreload = {
  /* Every profile of the issue's org, as stored now (after any patch). */
  orgProfiles: Doc<'profiles'>[]
  /* The org's projects by uuid, as stored now; a miss is read by uuid. */
  projects: Map<string, Doc<'projects'>>
  /* Recipient visibility answers by `${profile}:${project}` uuid, filled as
   * they are asked. */
  visibility: Map<string, boolean>
}

/* profileCanSeeProject, answered from a preload's visibility memo when one
 * is given (see NotifyPreload), else asked live. */
async function recipientCanSee(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
  visibility: NotifyPreload['visibility'] | undefined,
): Promise<boolean> {
  if (visibility === undefined) return await profileCanSeeProject(ctx, profile, project)
  const key = `${profile.id}:${project.id}`
  let canSee = visibility.get(key)
  if (canSee === undefined) {
    canSee = await profileCanSeeProject(ctx, profile, project)
    visibility.set(key, canSee)
  }
  return canSee
}

/* ------------------------------------------------------------- postMessage
 * THE single insert path (0109:95-114) — no other code may insert messages.
 * Silent drops, never errors: the actor's own copy, a recipient outside the
 * issue's org, a recipient without an inbox (a Viewer or Inactive agent,
 * lib/access.ts keepsInbox, which could never read or remove the row) and a
 * recipient who cannot see the project are all skipped without a trace — a
 * mention must not leak a hidden project's existence (0074), and a
 * subscription can never outlive the access that justified it (0114:40-42).
 * After the insert it wakes a snoozed item, prunes its read rows and trims
 * its unread rows toward ITEM_UNREAD_CAP (trimUnreadMessages). Returns
 * whether a row was inserted.
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
 * are read by uuid. `visibility` is a seed's memo (NotifyPreload), never
 * passed interactively. The issue_title snapshot is the issue's CURRENT
 * title (the SQL passed new.title). */
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
    visibility?: NotifyPreload['visibility']
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
  await ctx.db.insert('messages', {
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
  })
  const pair = { recipient_id: m.recipient_id, issue_id: m.issue_id }
  const rows = await pairRows(ctx, pair)
  // News wakes a snoozed item: the arrival is the news, so the older rows
  // only drop the snooze (no woke_at — the new row's created_at floats and
  // announces the item), and the scheduled wake later finds nothing to do.
  // An arrival stored read drops it too, so every row of the item keeps the
  // same stamp; the archive's background step would drop it anyway.
  for (const r of rows) {
    if (r.snoozed_until !== undefined) await ctx.db.patch(r._id, { snoozed_until: undefined })
  }
  await pruneReadMessages(ctx, pair, rows)
  // The prune deletes read rows only, so the unread rows read above are
  // still the item's.
  await trimUnreadMessages(ctx, rows)
  return true
}

/* --------------------------------------------------------------- subscribe
 * subscribe_to_issue (0114:134-149): same fence as postMessage (org, an
 * inbox and visibility — a subscription row decides who gets messages, so it
 * must not be creatable for someone who could not have received them),
 * idempotent.
 * `visibility` is a seed's memo (NotifyPreload), never passed interactively.
 * Returns whether a row was inserted. */
export async function subscribeToIssue(
  ctx: MutationCtx,
  a: {
    issue_id: string
    profile: Doc<'profiles'>
    org_id: string
    project: Doc<'projects'> | null
    now: string
    visibility?: NotifyPreload['visibility']
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
  await ctx.db.insert('issue_subscriptions', {
    issue_id: a.issue_id,
    profile_id: a.profile.id,
    created_at: a.now,
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
 * see. Returns whether `me` was not following it before.
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
    profile: a.me,
    org_id: a.issue.org_id,
    project,
    now: a.now,
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
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
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
 * ids its list holds through ownMessages, and the machine every row of the
 * items it names through itemMessages. Each returns the ids of the tasks
 * whose items it changed. */

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

/** Every row of `me`'s inbox item about one task. */
export const itemMessages = (
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  issueId: string,
): Promise<Doc<'messages'>[]> => pairRows(ctx, { recipient_id: me.id, issue_id: issueId })

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
  const issues = new Set<string>()
  for (const row of rows) {
    if (row.read_at !== undefined) continue
    await ctx.db.patch(row._id, { read_at: now })
    issues.add(row.issue_id)
  }
  for (const issue_id of issues) {
    await pruneReadMessages(ctx, { recipient_id: me.id, issue_id })
  }
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
  const issues = new Set<string>()
  for (const row of rows) {
    if (row.read_at === undefined || hidden.has(row.issue_id)) continue
    await ctx.db.patch(row._id, { read_at: undefined })
    issues.add(row.issue_id)
  }
  return issues
}

/** Deletes the rows. Removing an item means passing every row it holds. */
export async function removeMessages(
  ctx: MutationCtx,
  rows: readonly Doc<'messages'>[],
): Promise<Set<string>> {
  const issues = new Set<string>()
  for (const row of rows) {
    await ctx.db.delete(row._id)
    issues.add(row.issue_id)
  }
  return issues
}

/* How many rows one bulk inbox write changes at most. The caller repeats
 * while hasMore is true. */
const INBOX_BATCH = 256

/* Keeps 0109's invariant on one item after a bulk write stamped at most
 * `stamped` of its rows read. The invariant held before that write, so the
 * item then held at most one read row, and it now holds at most
 * stamped + 1, which this reads in full. It seeks the item's newest unread
 * row in the index rather than reading every unread row, so its cost does
 * not grow with the item. */
async function pruneStampedItem(
  ctx: MutationCtx,
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
    if (row._id !== newest._id) await ctx.db.delete(row._id)
  }
}

/**
 * Marks up to INBOX_BATCH of `me`'s unread rows read, the ones created no
 * later than `before`. The first call passes no `before`: the cutoff is then
 * the newest stored unread row, not a client clock, and the caller passes
 * the returned `before` to later batches so later arrivals stay unread.
 * Snoozed rows are hidden, so a bulk act never reaches them; they are
 * filtered inside the scan, so a page of snoozed rows cannot stall the
 * batches. The prune reads at most the newly stamped rows plus one retained
 * read row per affected task and seeks each task's newest unread directly
 * in the index. Returns the rows it marked, as they were before.
 */
export async function markAllMessagesRead(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  before: number | undefined,
  now: string,
): Promise<{ marked: Doc<'messages'>[]; hasMore: boolean; before: number }> {
  const latest =
    before === undefined
      ? await ctx.db
          .query('messages')
          .withIndex('by_recipient_read', (q) =>
            q.eq('recipient_id', me.id).eq('read_at', undefined),
          )
          .order('desc')
          .first()
      : null
  const cutoff = before ?? latest?._creationTime ?? 0
  const rows = await ctx.db
    .query('messages')
    .withIndex('by_recipient_read', (q) =>
      q.eq('recipient_id', me.id).eq('read_at', undefined).lte('_creationTime', cutoff),
    )
    .filter((q) => q.eq(q.field('snoozed_until'), undefined))
    .take(INBOX_BATCH + 1)
  const batch = rows.slice(0, INBOX_BATCH)
  for (const row of batch) await ctx.db.patch(row._id, { read_at: now })
  for (const issue_id of new Set(batch.map((row) => row.issue_id))) {
    await pruneStampedItem(ctx, { recipient_id: me.id, issue_id }, INBOX_BATCH)
  }
  return { marked: batch, hasMore: rows.length > INBOX_BATCH, before: cutoff }
}

/**
 * Deletes up to INBOX_BATCH of `me`'s read rows. A snoozed row that was read
 * meanwhile is a pending reminder, not clutter, and stays. Each batch
 * selects the current read rows, so a row reopened elsewhere survives.
 * Returns the rows it deleted.
 */
export async function removeReadMessages(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
): Promise<{ removed: Doc<'messages'>[]; hasMore: boolean }> {
  const rows = await ctx.db
    .query('messages')
    .withIndex('by_recipient_read', (q) => q.eq('recipient_id', me.id).gt('read_at', undefined))
    .filter((q) => q.eq(q.field('snoozed_until'), undefined))
    .take(INBOX_BATCH + 1)
  const batch = rows.slice(0, INBOX_BATCH)
  for (const row of batch) await ctx.db.delete(row._id)
  return { removed: batch, hasMore: rows.length > INBOX_BATCH }
}

/* The farthest ahead a snooze may reach. */
const MAX_SNOOZE_MS = 366 * 86_400_000

/* The scheduled end of a snooze, convex/messages.ts wake, referenced by
 * name so this module does not import the app module. */
const wakeRef = makeFunctionReference<
  'mutation',
  { recipient_id: string; issue_id: string; until: string },
  null
>('messages:wake')

/**
 * Snoozes the items the rows belong to until `until`, an ISO instant at
 * most a year ahead, or with null lifts their snooze now. Either way the
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
    if (ms > Date.now() + MAX_SNOOZE_MS) throw badRequest('snooze: at most a year ahead')
    at = new Date(ms).toISOString() // normalized, so the wake's equality holds
  }
  const changed = new Set<string>()
  for (const issue_id of new Set(rows.map((row) => row.issue_id))) {
    if (hidden.has(issue_id)) continue
    const pair = { recipient_id: me.id, issue_id }
    const item = await pairRows(ctx, pair)
    if (at === null) {
      for (const row of item) {
        if (row.snoozed_until === undefined) continue
        await ctx.db.patch(row._id, { snoozed_until: undefined, read_at: undefined })
        changed.add(issue_id)
      }
      continue
    }
    for (const row of item) {
      await ctx.db.patch(row._id, { snoozed_until: at, read_at: undefined, woke_at: undefined })
    }
    if (item.length > 0) changed.add(issue_id)
    await ctx.scheduler.runAt(Date.parse(at), wakeRef, { ...pair, until: at })
  }
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
 * (jobs.ts archiveDoneIssues) and archiveProjectCore. The marking happens
 * in steps because one task can have many followers with up to
 * ITEM_UNREAD_CAP + 1 rows each, so a big subtree, a project or a nightly
 * leg could pass the archiving transaction's write limit. Each step marks
 * at most ARCHIVED_READ_BATCH rows, visits at most ARCHIVED_READ_TASKS tasks
 * and schedules the rest.
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
 * Mark read and remove still work on it. Messages stored before archiving
 * marked anything read are marked by internal/archivedReadsBackfill.ts. */

/** The most rows one archived-read step marks read. */
export const ARCHIVED_READ_BATCH = 500

/** The most tasks one archived-read step visits. scheduleArchivedReads gives
 * each step at most this many task ids, and a project walk stops after this
 * many tasks, because each task costs index ranges whether or not it holds
 * a row to mark. */
export const ARCHIVED_READ_TASKS = 500

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
  { project_id: string; cursor?: string; batch?: number; tasks?: number },
  null
>('messages:readArchivedProject')

/**
 * Schedules the background steps that mark every message about the archived
 * `issues`, and about the active tasks of the archived `projects`, read. The
 * archive paths call it in the transaction that archives.
 */
export async function scheduleArchivedReads(
  ctx: MutationCtx,
  a: { issues?: readonly string[]; projects?: readonly string[] },
): Promise<void> {
  const issues = a.issues ?? []
  for (let i = 0; i < issues.length; i += ARCHIVED_READ_TASKS) {
    await ctx.scheduler.runAfter(0, readArchivedTasksRef, {
      issues: issues.slice(i, i + ARCHIVED_READ_TASKS),
    })
  }
  for (const project_id of a.projects ?? []) {
    await ctx.scheduler.runAfter(0, readArchivedProjectRef, { project_id })
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
 * snooze is never left to wake unread later. `more` says rows remain for
 * the next step. */
async function readTaskMessages(
  ctx: MutationCtx,
  issueId: string,
  now: string,
  budget: number,
): Promise<{ marked: number; more: boolean }> {
  const unread = await ctx.db
    .query('messages')
    .withIndex('by_issue_read', (q) => q.eq('issue_id', issueId).eq('read_at', undefined))
    .take(budget + 1)
  const touched = unread.slice(0, budget)
  for (const row of touched) {
    await ctx.db.patch(row._id, { read_at: now, snoozed_until: undefined })
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
      await ctx.db.patch(row._id, { snoozed_until: undefined })
      touched.push(row)
    }
  }
  for (const recipient_id of new Set(touched.map((row) => row.recipient_id))) {
    await pruneStampedItem(ctx, { recipient_id, issue_id: issueId }, budget)
  }
  return { marked: touched.length, more }
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
    const step = await readTaskMessages(ctx, issue.id, a.now, budget)
    budget -= step.marked
    if (step.more) {
      rest = a.issues.slice(i)
      break
    }
  }
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, readArchivedTasksRef, { issues: [...rest], batch: a.batch })
  }
}

/* The most bytes of tasks one project walk step reads. Task descriptions
 * have no size cap, so the page also ends early on bytes. */
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
 * that share a creation time or are deleted between steps.
 */
export async function readArchivedProjectMessages(
  ctx: MutationCtx,
  a: { project_id: string; cursor?: string; batch?: number; tasks?: number; now: string },
): Promise<void> {
  const project = await byId(ctx, 'projects', a.project_id)
  if (project === null || project.archived_at === undefined) return
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
  for (const task of page.page) {
    if (budget === 0) {
      unfinished = true
      break
    }
    const step = await readTaskMessages(ctx, task.id, a.now, budget)
    budget -= step.marked
    if (step.more) {
      unfinished = true
      break
    }
  }
  if (!unfinished && page.isDone) return
  await ctx.scheduler.runAfter(0, readArchivedProjectRef, {
    project_id: project.id,
    cursor: unfinished ? a.cursor : page.continueCursor,
    batch: a.batch,
    tasks: a.tasks,
  })
}

/* ---------------------------------------------------------------- mentions
 * extract_mentions (0075:34-49 — the survey quotes 0074's obsolete regex).
 * Code contexts are stripped first (the dialect renders them literally):
 * ``` fences to the closer or EOF, then single-line backtick spans. Then
 * `@[label](user:uuid)` — case-INSENSITIVE (USER: matches, uppercase hex
 * folds), label charset [^][]* (no brackets), dest padding by spaces/tabs.
 * A plain [x](user:...) link is NOT a mention. Distinct uuids, mapped onto
 * the supplied profile list (callers pass the org's profiles — active or
 * not, the SQL org fence never filtered on active); unknown uuids drop. */
const FENCE_RE = /```[\s\S]*?(```|$)/g
const SPAN_RE = /`[^`\n]*`/g
const MENTION_RE =
  /@\[[^\][]*\]\([ \t]*user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*\)/gi

export function extractMentions(text: string, profiles: Doc<'profiles'>[]): Doc<'profiles'>[] {
  const stripped = (text ?? '').replace(FENCE_RE, ' ').replace(SPAN_RE, ' ')
  const seen = new Set<string>()
  const out: Doc<'profiles'>[] = []
  for (const match of stripped.matchAll(MENTION_RE)) {
    const uuid = match[1].toLowerCase()
    if (seen.has(uuid)) continue
    seen.add(uuid)
    const profile = profiles.find((p) => p.id === uuid)
    if (profile !== undefined) out.push(profile)
  }
  return out
}

const orgProfilesOf = (ctx: MutationCtx, orgId: string): Promise<Doc<'profiles'>[]> =>
  ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()

const subscribersOf = (ctx: MutationCtx, issueId: string): Promise<Doc<'issue_subscriptions'>[]> =>
  ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect()

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
    actor: Doc<'profiles'>
    now: string
    preload?: NotifyPreload
    skipTaskEvent?: boolean
  },
): Promise<void> {
  const { issue, actor, now, preload } = a
  if (!a.skipTaskEvent) await emitTaskEvent(ctx, { name: 'task.created', issue, actor, now })
  const project =
    preload?.projects.get(issue.project_id) ?? (await byId(ctx, 'projects', issue.project_id))
  const orgProfiles = preload?.orgProfiles ?? (await orgProfilesOf(ctx, issue.org_id))
  const visibility = preload?.visibility
  const mentioned = extractMentions(issue.description, orgProfiles)
  for (const m of mentioned) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
      visibility,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in the description',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
      visibility,
    })
  }
  if (issue.assignee_id !== undefined) {
    const assignee = orgProfiles.find((p) => p.id === issue.assignee_id)
    // a missing profile is skipped (the org fence would drop both writes),
    // but the reviewer below still hears about the task
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        profile: assignee,
        org_id: issue.org_id,
        project,
        now,
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
        })
      }
    }
  }
  // a task created In Review is the reviewer's: they follow it and hear so
  if (reviewerOwns(issue) && issue.reviewer_id !== issue.assignee_id) {
    const reviewer = orgProfiles.find((p) => p.id === issue.reviewer_id)
    if (reviewer !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        profile: reviewer,
        org_id: issue.org_id,
        project,
        now,
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
        })
      }
    }
  }
}

/* ---------------------------------------------------------- notify: update
 * notify_issue_update (0114:196-352). Diffs ONLY the trigger's column list;
 * a write that changes nothing in it must not post. Callers hand the STORED
 * before/after rows, for the remaining-clear side-effect write too. A
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
 * (jobs.ts archiveDoneIssues) does not call this and posts no message.
 *
 * Ownership (#314): when the task passes to someone else (lib/review.ts's
 * taskOwnerId), the new owner starts following it. A reviewer handed the
 * task reads 'Ready for your review' after any assignment line and before
 * the change parts; both lines are said from the reader's side.
 *
 * `isGroup` marks a task with active subtasks, which always stays with its
 * assignee, so no write hands it over. The writers that can clear a group's
 * dormant reviewer (updateIssueCore, moveIssueCore) pass it; every other
 * caller changes neither the status nor the reviewer. */
export async function notifyIssueUpdate(
  ctx: MutationCtx,
  a: {
    before: Doc<'issues'>
    after: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    suppressNotify?: boolean
    skipTaskEvent?: boolean
    isGroup?: boolean
  },
): Promise<void> {
  const { before, after, actor, now } = a
  if (!a.skipTaskEvent)
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before, actor, now })
  const isGroup = a.isGroup === true
  const project = await byId(ctx, 'projects', after.project_id)
  const orgProfiles = await orgProfilesOf(ctx, after.org_id)

  // @mentions newly added to the description notify regardless of
  // subscribers, and subscribe the person to what they were pulled into
  const oldMentions = extractMentions(before.description, orgProfiles)
  const newMentions = extractMentions(after.description, orgProfiles).filter(
    (p) => !oldMentions.some((o) => o.id === p.id),
  )
  for (const m of newMentions) {
    await subscribeToIssue(ctx, {
      issue_id: after.id,
      profile: m,
      org_id: after.org_id,
      project,
      now,
    })
    await postMessage(ctx, {
      org_id: after.org_id,
      recipient_id: m.id,
      issue_id: after.id,
      kind: 'mention',
      body: 'Mentioned you in the description',
      actor_id: actor.id,
      now,
      issue: after,
      project: project ?? undefined,
      recipient: m,
    })
  }

  // a new assignee starts following; the old one keeps following — being
  // taken off a task is news you want (0114:228-229)
  if (after.assignee_id !== before.assignee_id && after.assignee_id !== undefined) {
    const assignee = orgProfiles.find((p) => p.id === after.assignee_id)
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        profile: assignee,
        org_id: after.org_id,
        project,
        now,
      })
    }
  }

  // whoever the task passes to starts following it: the reviewer when it
  // enters Review or is handed over in Review, the assignee when it leaves
  // Review (#314). A reviewer set outside Review owns nothing yet.
  const ownerAfter = taskOwnerId(after, isGroup)
  if (ownerAfter !== undefined && ownerAfter !== taskOwnerId(before, isGroup)) {
    const owner = orgProfiles.find((p) => p.id === ownerAfter)
    if (owner !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        profile: owner,
        org_id: after.org_id,
        project,
        now,
      })
    }
  }
  // the reviewer was handed the task in this write, not merely kept
  const handedToReviewer =
    reviewerOwns(after, isGroup) &&
    !(reviewerOwns(before, isGroup) && before.reviewer_id === after.reviewer_id)

  // the cheap exit: with nobody following, there is nothing to narrate for
  const subs = await subscribersOf(ctx, after.id)
  if (subs.length === 0) return

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
  if (after.description !== before.description) {
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
  let parentProjectId: string | undefined
  let parentProject: Doc<'projects'> | null = null
  let parentKey: string | undefined
  if (after.parent_id !== before.parent_id) {
    if (after.parent_id === undefined) {
      parts.push('Detached from its parent')
    } else {
      const parent = await byId(ctx, 'issues', after.parent_id)
      if (parent !== null) {
        parentProjectId = parent.project_id
        parentProject = await byId(ctx, 'projects', parent.project_id)
        parentKey = `QN-${parent.num}`
      }
      parts.push(ATTACH_SLOT)
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
        before.assignee_id === undefined
          ? undefined
          : orgProfiles.find((p) => p.id === before.assignee_id)?.name
      assignedLine = `Unassigned (was ${oldName ?? 'someone'})`
    } else {
      const newName = orgProfiles.find((p) => p.id === after.assignee_id)?.name
      assignedLine = `Assigned to ${newName ?? 'someone'}`
    }
  }
  // the reviewer line, likewise; the reviewer's own copy is chosen per reader
  let reviewerLine: string | undefined
  if (after.reviewer_id !== before.reviewer_id) {
    if (after.reviewer_id === undefined) {
      const oldName =
        before.reviewer_id === undefined
          ? undefined
          : orgProfiles.find((p) => p.id === before.reviewer_id)?.name
      reviewerLine = `Reviewer removed (was ${oldName ?? 'someone'})`
    } else {
      const newName = orgProfiles.find((p) => p.id === after.reviewer_id)?.name
      reviewerLine = `Reviewer set to ${newName ?? 'someone'}`
    }
  }

  if (parts.length === 0 && assignedLine === undefined && reviewerLine === undefined) return

  // one message per follower. postMessage drops the actor's own copy, anyone
  // who has left the org, and anyone who can no longer see the project.
  for (const s of subs) {
    const recipient = orgProfiles.find((p) => p.id === s.profile_id)
    let mine = [...parts]
    if (newMentions.some((m) => m.id === s.profile_id)) {
      // a fresh mention supersedes the bare description line — they will
      // read it in the message view
      mine = mine.filter((x) => x !== 'Description updated')
    }
    if (parentProjectId !== undefined) {
      const canSee =
        recipient !== undefined &&
        parentProject !== null &&
        (await profileCanSeeProject(ctx, recipient, parentProject))
      // Keep the hidden parent anonymous while using the same task wording
      // as the inbox and the machine surfaces.
      mine = mine.map((x) =>
        x === ATTACH_SLOT
          ? `Attached under ${canSee ? parentKey : 'a task in another project'}`
          : x,
      )
    } else {
      mine = mine.filter((x) => x !== ATTACH_SLOT)
    }
    // unshifted before the assignment line, so it reads second
    let reviewLine = reviewerLine
    if (s.profile_id === after.reviewer_id) {
      if (handedToReviewer) reviewLine = REVIEW_READY
      else if (reviewerLine !== undefined) reviewLine = 'Reviewer set to you'
    }
    if (reviewLine !== undefined) mine.unshift(reviewLine)
    if (assignedLine !== undefined) {
      mine.unshift(s.profile_id === after.assignee_id ? 'Assigned to you' : assignedLine)
    }
    if (mine.length === 0) continue
    await postMessage(ctx, {
      org_id: after.org_id,
      recipient_id: s.profile_id,
      issue_id: after.id,
      kind: 'change',
      body: mine.join('. '),
      actor_id: actor.id,
      now,
      issue: after,
      project: project ?? undefined,
      recipient,
    })
  }
}

/* --------------------------------------------------------- notify: comment
 * notify_comment_insert (0114:354-382): mentions subscribe + hear about it;
 * the author subscribes (saying something is the clearest statement that you
 * want to hear the reply); every subscriber EXCEPT the mentioned reads
 * 'New comment'. `actor` is the comment's author; of the comment itself
 * only the body is read. */
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
  const project =
    preload?.projects.get(issue.project_id) ?? (await byId(ctx, 'projects', issue.project_id))
  const orgProfiles = preload?.orgProfiles ?? (await orgProfilesOf(ctx, issue.org_id))
  const visibility = preload?.visibility
  const mentioned = extractMentions(comment.body, orgProfiles)
  for (const m of mentioned) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
      visibility,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in a comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
      visibility,
    })
  }
  await subscribeToIssue(ctx, {
    issue_id: issue.id,
    profile: actor,
    org_id: issue.org_id,
    project,
    now,
    visibility,
  })
  const subs = await subscribersOf(ctx, issue.id)
  for (const s of subs) {
    if (mentioned.some((m) => m.id === s.profile_id)) continue
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: s.profile_id,
      issue_id: issue.id,
      kind: 'comment',
      body: 'New comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: orgProfiles.find((p) => p.id === s.profile_id),
      visibility,
    })
  }
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
  const orgProfiles = await orgProfilesOf(ctx, issue.org_id)
  const oldMentions = extractMentions(before.body, orgProfiles)
  const added = extractMentions(after.body, orgProfiles).filter(
    (p) => !oldMentions.some((o) => o.id === p.id),
  )
  for (const m of added) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in a comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
    })
  }
}
