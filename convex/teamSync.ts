/* Team sync: the meeting page's two server facts. `stamp` records that a
 * change was made on a person through the sync page (the person's
 * sync_stamps row, model/syncStamps.ts, read through the sitting rule in
 * lib/teamSync.ts; the app's people part sends it on its profile rows as
 * sync_at and sync_since). `lastComments` is the one per-task fact
 * the workspace lacks: when each open task was last commented on, for the
 * page's "untouched" and "changed" marks. The page subscribes to it only
 * while it is open, and only for the people whose cards it shows, so neither
 * the workspace parts nor the page read a comment per task of the whole
 * organization.
 *
 * The stamp is meeting bookkeeping, not a task change: it writes no activity
 * row and notifies no one. */

import { getDocumentSize, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import type { IssueStatus } from './lib/enums'
import { badRequest, forbidden, notFound, orgMutation, orgQuery } from './lib/functions'
import { taskOwnerId } from './lib/review'
import { nextSyncStamp, SYNC_OWNERS_MAX } from './lib/teamSync'
import { orgProjectView } from './lib/visibility'
import { DOCUMENT_MAX_BYTES, latestComment } from './model/comments'
import { stampOf, writeStamp } from './model/syncStamps'

/* A change made from a sync page stamps the owner of that page, who is often
 * not the caller. The sync is a home-organization page for staff: guests
 * never reach it and viewers change nothing. One server `now`; an absent
 * `since` stays absent (left out of the row, never null). `first_since` is
 * the day the caller's page was reading from (YYYY-MM-DD); it is kept only
 * on a person's first stamp and only when valid (lib/teamSync.ts
 * firstSittingSince), else ignored. */
export const stamp = orgMutation({
  args: { profile_id: v.string(), first_since: v.optional(v.string()) },
  handler: async (ctx, { profile_id, first_since }) => {
    const now = new Date().toISOString()
    if (!isOrgStaff(ctx.me)) throw forbidden('no permission to run a team sync')
    const person = await byId(ctx, 'profiles', profile_id)
    if (person === null || person.org_id !== ctx.me.org_id) throw notFound('profile not found')
    // the profile itself is never written, so the person's own
    // subscriptions do not rerun
    const next = nextSyncStamp(await stampOf(ctx, person.id), now, first_since)
    await writeStamp(ctx, person, next)
    return null
  },
})

/* The statuses a sync row can have. */
const OPEN_STATUSES = ['todo', 'progress', 'review'] as const satisfies readonly IssueStatus[]

/** The most people one lastComments call takes and the most tasks it
 * answers, and its read budget in bytes as Convex sizes a document. The
 * owner scan stops once the tasks it read reach `taskBytes`, and the comment
 * reads stop once tasks and comments together reach `bytes`. Each passes its
 * budget by one document at most, so a call reads at most 13 MiB beside the
 * caller's project view, under Convex's 16 MiB read limit. A task document
 * takes at least about 400 bytes, so the task budget also bounds the scan to
 * about 16,000 documents, half of Convex's 32,000. Tests lower them. */
export const LAST_COMMENTS = {
  owners: SYNC_OWNERS_MAX,
  tasks: 1000,
  taskBytes: 6 * 1024 * 1024,
  bytes: 12 * 1024 * 1024,
}

/* The latest comment's instant per open task the caller can see that one of
 * `owner_ids` owns. A task counts when it is active (not archived, in an
 * active project), To Do, In Progress or In Review, and owned by that person
 * under the Reviewer rule (lib/review.ts taskOwnerId). `at` is null for a
 * task with no comment. Any member may read.
 *
 * Each owner's open tasks are read by index, so the call reads neither the
 * organization's other tasks nor the owner's Backlog and Done ones. The
 * answer covers at most LAST_COMMENTS.tasks tasks. The owner scan stops at
 * the first task it reads once the tasks read reach LAST_COMMENTS.taskBytes.
 * The comment reads stop once tasks and comments together reach
 * LAST_COMMENTS.bytes, which they pass by one comment at most. When any of
 * these cuts the answer short, `complete` is false and the tasks left out
 * have no row, so the page shows no mark for them rather than a wrong one.
 * Owners are read in the order given, so the first ones keep their rows.
 * Index ranges are four per person plus one per task answered, beside the
 * caller's project view. */
export const lastComments = orgQuery({
  args: { owner_ids: v.array(v.string()) },
  handler: async (ctx, { owner_ids }) => {
    const owners = [...new Set(owner_ids.map((id) => id.toLowerCase()))]
    if (owners.length > LAST_COMMENTS.owners) {
      throw badRequest(`at most ${LAST_COMMENTS.owners} people at a time`)
    }
    const view = await orgProjectView(ctx, ctx.me)
    const isRow = (task: Doc<'issues'>, owner: string) =>
      task.org_id === ctx.me.org_id &&
      taskOwnerId(task) === owner &&
      view.visible(task.project_id) &&
      view.byUuid.get(task.project_id)?.archived_at === undefined
    // An owner's open tasks are those they are assigned and, In Review,
    // those they review. A task with the same person in both roles turns up
    // twice.
    const held = (owner: string) => [
      ...OPEN_STATUSES.map((status) =>
        ctx.db
          .query('issues')
          .withIndex('by_assignee_archived_status', (q) =>
            q.eq('assignee_id', owner).eq('archived_at', undefined).eq('status', status),
          ),
      ),
      ctx.db
        .query('issues')
        .withIndex('by_reviewer_archived_status', (q) =>
          q.eq('reviewer_id', owner).eq('archived_at', undefined).eq('status', 'review'),
        ),
    ]

    // Every task and comment read counts toward `bytes`, kept or not.
    const ids = new Set<string>()
    let bytes = 0
    let complete = true
    scan: for (const owner of owners) {
      for (const tasks of held(owner)) {
        for await (const task of tasks) {
          const spent = bytes >= LAST_COMMENTS.taskBytes
          bytes += getDocumentSize(task)
          if (spent) {
            complete = false
            break scan
          }
          if (ids.has(task.id) || !isRow(task, owner)) continue
          if (ids.size === LAST_COMMENTS.tasks) {
            complete = false
            break scan
          }
          ids.add(task.id)
        }
      }
    }

    // Comments are read a few at a time, never more than the unspent budget
    // could hold at Convex's document size limit, so the budget is passed by
    // at most one comment.
    const queue = [...ids]
    const rows: { issue_id: string; at: string | null }[] = []
    while (rows.length < queue.length) {
      if (bytes >= LAST_COMMENTS.bytes) {
        complete = false
        break
      }
      const fits = Math.max(1, Math.floor((LAST_COMMENTS.bytes - bytes) / DOCUMENT_MAX_BYTES))
      const batch = queue.slice(rows.length, rows.length + fits)
      const latest = await Promise.all(batch.map((id) => latestComment(ctx, id)))
      batch.forEach((issue_id, i) => {
        const comment = latest[i]
        if (comment !== null) bytes += getDocumentSize(comment)
        rows.push({ issue_id, at: comment?.created_at ?? null })
      })
    }
    return { rows, complete }
  },
})
