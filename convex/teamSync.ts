/* Team sync: the meeting page's two server facts. `stamp` records that a
 * change was made on a person through the sync page (profiles.sync_at /
 * sync_since, read through the sitting rule in lib/teamSync.ts; the columns
 * ride the snapshot's profile rows). `lastComments` is the one per-task fact
 * the snapshot lacks: when each open task was last commented on, for the
 * page's "untouched" and "changed" marks. It is subscribed only while the
 * page is open, so forMe does not rerun a comment read per task.
 *
 * The stamp is meeting bookkeeping, not a task change: it writes no activity
 * row and notifies no one. */

import { v } from 'convex/values'
import { isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import { forbidden, notFound, orgMutation, orgQuery } from './lib/functions'
import { nextSyncStamp } from './lib/teamSync'
import { orgProjectView } from './lib/visibility'

/* A change made from a sync page stamps the owner of that page, who is often
 * not the caller. The sync is a home-organization page for staff: guests
 * never reach it and viewers change nothing. One server `now`; an absent
 * `since` stays absent (patched to undefined, never null). `first_since` is
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
    const prev =
      person.sync_at === undefined ? null : { at: person.sync_at, since: person.sync_since }
    const next = nextSyncStamp(prev, now, first_since)
    await ctx.db.patch(person._id, { sync_at: next.at, sync_since: next.since })
    return null
  },
})

/* The statuses a sync row can have. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['todo', 'progress', 'review'])

/* The latest comment's instant per open task the caller can see: active
 * (not archived, in an active project), To Do, In Progress or In Review, with
 * at least one comment. Comments are server-stamped and inserted in time
 * order, so the index's newest row is the latest. Any member may read. */
export const lastComments = orgQuery({
  args: {},
  handler: async (ctx) => {
    const [view, active] = await Promise.all([
      orgProjectView(ctx, ctx.me),
      ctx.db
        .query('issues')
        .withIndex('by_org_archived', (q) =>
          q.eq('org_id', ctx.me.org_id).eq('archived_at', undefined),
        )
        .collect(),
    ])
    const open = active.filter(
      (issue) =>
        OPEN_STATUSES.has(issue.status) &&
        view.visible(issue.project_id) &&
        view.byUuid.get(issue.project_id)?.archived_at === undefined,
    )
    const latest = await Promise.all(
      open.map(async (issue) => {
        const comment = await ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .order('desc')
          .first()
        return comment === null ? null : { issue_id: issue.id, at: comment.created_at }
      }),
    )
    return latest.filter((row) => row !== null)
  },
})
