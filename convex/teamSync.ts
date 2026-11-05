/* Team sync: the meeting page's server reads and its stamp. `agenda`
 * answers one meeting for one scope (lib/teamSyncAgenda.ts): the tasks the
 * page shows, the people it walks with their stamps and loads, within
 * Team sync's budget and ceiling. No app reader calls it yet; the Team sync
 * view moves onto it. `stamp` records that a change was made on a person
 * through the sync page (the person's sync_stamps row, model/syncStamps.ts,
 * read through the sitting rule in lib/teamSync.ts; the app's people part
 * sends it on its profile rows as sync_at and sync_since). `lastComments`
 * is the one per-task fact the workspace lacks: when each open task was
 * last commented on, for the page's "untouched" and "changed" marks. The
 * page subscribes to it only while it is open, and only for the people
 * whose cards it shows, so neither the workspace parts nor the page read a
 * comment per task of the whole organization.
 *
 * agenda is a live query: a change to a document its reads returned or
 * would now return reruns it, such as an active task of the scope's
 * sub-projects in an open, Backlog or Done status the reads reached, a
 * subtask a check read, a link row of a row, a blocker or parent it read, a
 * walker's profile or stamp, a team membership it asked about, a project,
 * share or access row it asked about, a count row of the scope in a team
 * or All projects, and through the loads any open task of an owner it read
 * anywhere in the organization and that owner's plannable hours. Every
 * Remaining, status or owner edit made in the meeting reruns it. A new
 * scope or a new local day is a new subscription. authedQuery, not
 * orgQuery, so a seat that goes away answers `unavailable` instead of
 * throwing in a subscription.
 *
 * The stamp is meeting bookkeeping, not a task change: it writes no activity
 * row and notifies no one. */

import { getDocumentSize, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { isAccessUnchecked, isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import type { IssueStatus } from './lib/enums'
import {
  authedQuery,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
} from './lib/functions'
import { MIB, TASK_ROW_MAX_BYTES } from './lib/limits'
import { taskOwnerId } from './lib/review'
import { nextSyncStamp, SYNC_OWNERS_MAX } from './lib/teamSync'
import { readAgenda } from './lib/teamSyncAgenda'
import { vClock } from './lib/viewLoads'
import { inSteps, isOverBudget, ROW, type StepRange, viewAccess, viewBudget } from './lib/viewReads'
import { DOCUMENT_MAX_BYTES, latestComment } from './model/comments'
import { stampOf, writeStamp } from './model/syncStamps'

/* One Team sync meeting of the organization `org_id` for `scope`, a
 * project or sub-project, a team of that organization, or All projects
 * asked for by name, on the client's day and weeks (lib/viewLoads.ts
 * clockOf), as lib/teamSyncAgenda.ts readAgenda answers it: ok,
 * over_ceiling, over_budget or unavailable, never part of a meeting. Any
 * member but a guest reads it. */
export const agenda = authedQuery({
  args: {
    org_id: v.string(),
    scope: v.union(
      v.object({ kind: v.literal('project'), project_id: v.string() }),
      v.object({ kind: v.literal('team'), team_id: v.string() }),
      v.object({ kind: v.literal('all') }),
    ),
    ...vClock,
  },
  handler: (ctx, args) => readAgenda(ctx, ctx.myProfiles, args),
})

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

/** The bounds of one lastComments call, which tests lower and set back.
 *
 * - `owners`: the most people one call takes.
 * - `tasks`: the most tasks it answers.
 * - `projects`: the most live projects its owners' tasks name that it asks
 *   the caller's access about, the design size's 200 sub-projects one
 *   person can read. A call of 50 owners can name more inside the design
 *   size, up to the organization's 500 live sub-projects, and is then cut
 *   short, so the store asks again in halves (src/store/planner.ts
 *   watchTeamSync).
 * - `taskBytes`: the owner scan stops at the first task it reads once the
 *   tasks read reach it, each task counted at its own size where the caller
 *   can see its project and at lib/limits.ts TASK_ROW_MAX_BYTES where not,
 *   so a hidden task's text moves no answer.
 * - `bytes`: the comment reads stop once tasks and comments together reach
 *   it, counted so, or counted at their own sizes, whichever is larger.
 * - `reads`: the guard of the scan and of the access questions
 *   (lib/viewReads.ts viewBudget), over the request's reads as Convex counts
 *   them with hidden tasks at their fixed size, which keeps their real
 *   bytes under 14 MiB too. Beside it the comment reads take a range and a
 *   document each, at most `tasks` of them, so a call stays inside Convex's
 *   4,096 ranges and 32,000 documents, and with `bytes` inside its 16 MiB
 *   for the caller's own access rows at the design size.
 *
 * Each passes its bound by one document, one step of the scan or one round
 * of access questions at most. A task document takes at least about 400
 * bytes, so `taskBytes` bounds the scan to about 16,000 documents. */
export const LAST_COMMENTS = {
  owners: SYNC_OWNERS_MAX,
  tasks: 1000,
  projects: 200,
  taskBytes: 6 * MIB,
  bytes: 12 * MIB,
  reads: { bytes: 10 * MIB, documents: 24_000, ranges: 2_400 },
}

/* The request's real bytes the comment reads stop at, whatever the counts
 * of LAST_COMMENTS say: Convex's 16 MiB less 2 MiB for one comment and the
 * caller's reads before the call. */
const COMMENT_REAL_BYTES = 14 * MIB

/** The latest comment's instant per open task `me` can see that one of
 * `ownerIds` owns, by lastComments' rules, with whether the answer is
 * whole. It reads within LAST_COMMENTS. */
export async function latestComments(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  ownerIds: readonly string[],
): Promise<{ rows: { issue_id: string; at: string | null }[]; complete: boolean }> {
  const owners = [...new Set(ownerIds.map((id) => id.toLowerCase()))]
  if (owners.length > LAST_COMMENTS.owners) {
    throw badRequest(`at most ${LAST_COMMENTS.owners} people at a time`)
  }
  const guard = viewBudget(ctx, LAST_COMMENTS.reads)
  const seat = viewAccess(ctx, guard, me)
  // whether the caller sees each live project of theirs asked about, false
  // for one that is not live, and how many live ones were asked about
  const sight = new Map<string, boolean>()
  let asked = 0
  // An owner's open tasks are those they are assigned and, In Review,
  // those they review. A task with the same person in both roles turns up
  // twice.
  const held = (owner: string): StepRange<Doc<'issues'>>[] => [
    ...OPEN_STATUSES.map(
      (status): StepRange<Doc<'issues'>> => ({
        open: (from) =>
          ctx.db.query('issues').withIndex('by_assignee_archived_status', (q) => {
            const own = q.eq('assignee_id', owner).eq('archived_at', undefined).eq('status', status)
            return from === undefined ? own : own.gte('_creationTime', from)
          }),
      }),
    ),
    {
      open: (from) =>
        ctx.db.query('issues').withIndex('by_reviewer_archived_status', (q) => {
          const own = q.eq('reviewer_id', owner).eq('archived_at', undefined).eq('status', 'review')
          return from === undefined ? own : own.gte('_creationTime', from)
        }),
    },
  ]
  /* asks the caller's access about the projects `tasks` name that it has
   * not asked about, those past LAST_COMMENTS.projects left unasked */
  const ask = async (tasks: readonly Doc<'issues'>[]) => {
    const fresh = [
      ...new Set(
        tasks
          .filter((t) => t.org_id === me.org_id && !sight.has(t.project_id))
          .map((t) => t.project_id),
      ),
    ]
    const live = await seat.live(fresh)
    for (const [i, id] of fresh.entries()) if (!live[i]) sight.set(id, false)
    const asking = fresh
      .filter((_, i) => live[i])
      .slice(0, Math.max(0, LAST_COMMENTS.projects - asked))
    asked += asking.length
    const seen = await seat.visible(asking)
    for (const [i, id] of asking.entries()) sight.set(id, seen[i])
  }

  // Every task and comment read counts toward `bytes`, kept or not; `real`
  // counts each at its own size, a task each time a read returned it.
  const ids = new Set<string>()
  let bytes = 0
  let real = 0
  let complete = true
  const returned: Doc<'issues'>[] = []
  const read = (task: Doc<'issues'>) => {
    guard.charge(task, TASK_ROW_MAX_BYTES)
    returned.push(task)
    real += getDocumentSize(task)
  }
  scan: for (const owner of owners) {
    try {
      for await (const step of inSteps(guard, held(owner), ROW, read)) {
        await ask(step)
        // a task the caller is shown counts at its real size
        for (const task of returned.splice(0))
          if (sight.get(task.project_id) === true) guard.refund(task, TASK_ROW_MAX_BYTES)
        for (const task of step) {
          const shown = task.org_id === me.org_id ? sight.get(task.project_id) : false
          // a project past LAST_COMMENTS.projects: this task and those after
          // it have no row
          if (shown === undefined) {
            complete = false
            break scan
          }
          const spent = bytes >= LAST_COMMENTS.taskBytes
          bytes += shown ? getDocumentSize(task) : TASK_ROW_MAX_BYTES
          if (spent) {
            complete = false
            break scan
          }
          if (ids.has(task.id) || !shown || taskOwnerId(task) !== owner) continue
          if (ids.size === LAST_COMMENTS.tasks) {
            complete = false
            break scan
          }
          ids.add(task.id)
        }
      }
    } catch (e) {
      // the guard, or a bound of the caller's own access reads, stopped the
      // scan, and the tasks it did not decide have no row
      if (!isOverBudget(e) && !isAccessUnchecked(e)) throw e
      complete = false
      break
    }
  }

  // Comments are read a few at a time, never more than the unspent budget
  // could hold at Convex's document size limit, so the budget is passed by
  // at most one comment.
  const other = (await ctx.meta.getTransactionMetrics()).bytesRead.used - real
  const queue = [...ids]
  const rows: { issue_id: string; at: string | null }[] = []
  while (rows.length < queue.length) {
    const left = Math.min(
      LAST_COMMENTS.bytes - Math.max(bytes, real),
      COMMENT_REAL_BYTES - other - real,
    )
    if (left <= 0) {
      complete = false
      break
    }
    const fits = Math.max(1, Math.floor(left / DOCUMENT_MAX_BYTES))
    const batch = queue.slice(rows.length, rows.length + fits)
    const latest = await Promise.all(batch.map((id) => latestComment(ctx, id)))
    batch.forEach((issue_id, i) => {
      const comment = latest[i]
      if (comment !== null) {
        bytes += getDocumentSize(comment)
        real += getDocumentSize(comment)
      }
      rows.push({ issue_id, at: comment?.created_at ?? null })
    })
  }
  return { rows, complete }
}

/* The latest comment's instant per open task the caller can see that one of
 * `owner_ids` owns. A task counts when it is active (not archived, in an
 * active project), To Do, In Progress or In Review, and owned by that person
 * under the Reviewer rule (lib/review.ts taskOwnerId). `at` is null for a
 * task with no comment. Any member may read.
 *
 * Each owner's open tasks are read by index, in steps (lib/viewReads.ts
 * inSteps), so the call reads neither the organization's other tasks nor
 * the owner's Backlog and Done ones. Before a step's tasks are decided, the
 * projects they name that were not asked about before are read, and the
 * live ones of the caller's organization asked about through the caller's
 * access (lib/access.ts accessOf, through lib/viewReads.ts viewAccess), so
 * the reads follow the projects the owners' tasks name, never every
 * project of the organization, and a hidden task counts at a fixed size
 * (LAST_COMMENTS). The answer covers at most LAST_COMMENTS.tasks tasks. The
 * owner scan stops at the first task it reads once the tasks read reach
 * LAST_COMMENTS.taskBytes, or whose project is past LAST_COMMENTS.projects,
 * and where the guard or a bound of the caller's own access reads stops a
 * step. The comment reads stop once tasks and comments together reach
 * LAST_COMMENTS.bytes, which they pass by one comment at most. When any of
 * these cuts the answer short, `complete` is false and the tasks left out
 * have no row, so the page shows no mark for them rather than a wrong one,
 * and the store asks again in halves down to one person. Owners are read
 * in the order given, so the first ones keep their rows. Index ranges are
 * four per person and one more for each 64 of their open tasks, at most
 * six for each live project asked about, and one per task answered.
 *
 * For the Team sync view stage: an answer cut short by the projects bound,
 * the guard or the caller's own access bound still makes the page say the
 * person "holds more open tasks than Qivo checks at once" (src/views/
 * TeamSync.tsx marksCutLine), which is then not why. */
export const lastComments = orgQuery({
  args: { owner_ids: v.array(v.string()) },
  handler: (ctx, { owner_ids }) => latestComments(ctx, ctx.me, owner_ids),
})
