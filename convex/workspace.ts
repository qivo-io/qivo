/* The workspace the app shows, in live parts. The app subscribes to each
 * part and adopts the results of one Convex transition together
 * (src/store/liveParts.ts), so it shows one consistent state, and a change
 * re-sends only the parts it changed. Readers and budgets are in
 * lib/workspaceParts.ts. No part sends a project, grant or team grant: the
 * app reads every project it shows from the navigation reads, the store's
 * project cache (projectNav.byIds) and the views' own reads
 * (projectNav.ts).
 *
 * - root: the caller's seats and organizations, the caller's own profiles,
 *   their team memberships and the teams those name, and whether the login
 *   may create an organization. With no seat it can open, null, or why not
 *   (an organization deletion or a deactivation) and when it may create
 *   one (lib/workspaceParts.ts readRoot). It reads the caller's profiles,
 *   each one's memberships (at most OWN_READS.teams of them, past which it
 *   refuses with lib/access.ts accessUnchecked's sentence), the teams they
 *   name, each organization and its counters, so it reruns on seat and
 *   membership changes, a change to one of the caller's teams,
 *   organization settings and every task created, archived, restored or
 *   deleted (the task number and live task count in org_counters). It
 *   sends no other person's profile, membership or Team sync stamp, and no
 *   team the caller is not in. In the timing of 8 November 2026 at
 *   02fa0e0a on a local backend on Boat (8 vCPU), one call at a time, one
 *   seat with its 3 team memberships read 9 ranges, 10 documents and
 *   0.003 MiB with the sign-in at 50 people and at 1,000, where the removed
 *   people part read 1,005 ranges, 4,461 documents and 1.118 MiB at 1,000
 *   people. Every root case took 7 to 29 ms of JavaScript quiet and 11 to
 *   66 ms beside eight busy loops (lib/workspaceParts.ts readRoot has the
 *   cases).
 * - tasks (per window of its tasks' window keys, which the server picks at
 *   random, lib/db.ts newWindowKey): the caller's working set,
 *   with links, labels, attachments and follows, and the anonymized load of
 *   the window's tasks the caller is not shown. Five ranges for the window
 *   and its relation rows, one or two per task for its subtasks, five per
 *   task restored before its archive marks were cleared, one per task
 *   outside it that a task names (a parent, a link target) and one per
 *   owner of a hidden task.
 *
 * No part sends a message: the app reads the Inbox through inbox.ts (its
 * unread summary, the open task's item, the list's pages and the feed its
 * desktop alerts take).
 *
 * Every part reads the caller's own profiles first (lib/functions.ts), so
 * all of them rerun when one of those changes, and answer the same. A part
 * of an organization the caller no longer holds a seat in answers
 * `{state: 'gone'}`, and only a missing sign-in throws. A part that needs to
 * know what the caller can see reads the projects its rows name, the
 * caller's grants and the team shares on them, and the teams those shares
 * name with the caller's memberships of them; where it asks about many
 * projects, all of the caller's grants, memberships and team shares instead.
 * A part that asks whether a parent shows for navigation (a top-level
 * project the caller holds no level on, lib/access.ts levelUnder) reads,
 * once the organization's project_reach rows are complete (org_ready
 * nav_at), the caller's memberships and the root rows of their seat and
 * teams, and under the parent the child rows of those that hold one there
 * with the sub-projects they name, so it reruns only when the caller's or
 * their teams' reach rows change. Without nav_at, or past those reads'
 * bounds, it reads the caller's grants, memberships and team shares, the
 * parent's sub-projects, and the teams of those memberships or shares, or
 * for many such teams all of the organization's teams, so a team edit
 * anywhere in the organization reruns it (lib/access.ts projectLevelsOf,
 * OWN_READS). An edit of one of those reruns the parts that read it. Every
 * one of those reads is bounded. A check its bounds stop answers the tasks
 * part `overflow` where what ran out is the room for the projects the
 * window asks about (lib/access.ts roomSpent) and the window can still be
 * cut, and else `{state: 'refused', message}` with lib/access.ts
 * accessUnchecked's sentence, as a window too full to cut does. The tasks
 * part stays inside Convex's limits at any size by answering `split` or
 * `overflow` (lib/workspaceParts.ts), and the app chooses its windows from
 * the organization's count of active tasks, without asking
 * (lib/idWindows.ts startWindows). It refuses (bad_request) a window that
 * is not one of lib/idWindows.ts's grid. */

import { v } from 'convex/values'
import { authedQuery, badRequest, seatQuery } from './lib/functions'
import { type IdWindow, isIdWindow } from './lib/idWindows'
import { readRoot, readTasks } from './lib/workspaceParts'

const GONE = { state: 'gone' as const }

/* A window's bounds as a part takes them (lib/idWindows.ts). */
const windowArgs = { from: v.string(), to: v.union(v.string(), v.null()) }

/* `w`, refused unless it is a window of lib/idWindows.ts's grid. A part
 * holds back rows of its window, such as the ids behind hidden load, so a
 * caller who could narrow a window at will could find a held-back id by
 * asking about ever narrower ones. */
function gridWindow(w: IdWindow): IdWindow {
  if (!isIdWindow(w)) throw badRequest('this window of ids is not one the app makes')
  return w
}

export const root = authedQuery({
  args: {},
  handler: async (ctx) => await readRoot(ctx),
})

export const tasks = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) => (ctx.me === null ? GONE : await readTasks(ctx, ctx.me, gridWindow(w))),
})
