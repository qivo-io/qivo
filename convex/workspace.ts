/* The workspace the app shows, in live parts. The app subscribes to each
 * part and adopts the results of one Convex transition together
 * (src/store/liveParts.ts), so it shows one consistent state, and a change
 * re-sends only the parts it changed. Readers and budgets are in
 * lib/workspaceParts.ts.
 *
 * - root: the caller's seats and organizations, and whether the login may
 *   create an organization. With no seat it can open, null, or why not
 *   (an organization deletion, a deactivation) and when it may create one
 *   (lib/workspaceParts.ts readRoot). It reads the caller's profiles, each
 *   organization and its counters, so it reruns on seat changes,
 *   organization settings and every task or project created, archived,
 *   restored or deleted (the numbers and live counts in org_counters).
 * - catalog (per organization): teams and labels. One range each.
 * - people (per window of the organization's profile ids,
 *   lib/idWindows.ts): profiles with their Team sync stamps and team
 *   memberships. Two ranges, and one per person for their memberships.
 * - projects (per window of its projects' window keys, which the server
 *   picks at random, lib/db.ts newWindowKey): the projects the caller can
 *   see, with grants, team grants and the active ones' milestones. Up to
 *   three ranges per project, beside the caller's levels on it.
 * - tasks (per window of its tasks' window keys): the caller's working set,
 *   with links, labels, attachments and follows, and the anonymized load of
 *   the window's tasks the caller is not shown. Five ranges for the window
 *   and its relation rows, one or two per task for its subtasks, five per
 *   task restored before its archive marks were cleared, one per task
 *   outside it that a task names (a parent, a link target) and one per
 *   owner of a hidden task.
 * - inbox (per organization): the caller's messages, at most 3,002 messages
 *   read and one range per task they name, cut short where those tasks
 *   would read too much.
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
 * project the caller holds no level on, lib/access.ts levelUnder) reads all of the caller's grants, memberships and
 * team shares, the parent's sub-projects, and the teams of those
 * memberships or shares, or for many such teams all of the organization's
 * teams, so a team edit anywhere in the organization reruns it
 * (lib/access.ts projectLevelsOf, OWN_READS). An edit of one of those
 * reruns the parts that read it. Each windowed part stays inside Convex's limits at any size by
 * answering `split` or `overflow` (lib/workspaceParts.ts), and the app
 * chooses the windows from the organization's counts of the rows they read,
 * without asking (lib/idWindows.ts startWindows).
 * A windowed part refuses (bad_request) a window that is not one of
 * lib/idWindows.ts's grid. */

import { v } from 'convex/values'
import { authedQuery, badRequest, seatQuery } from './lib/functions'
import { type IdWindow, isIdWindow } from './lib/idWindows'
import {
  readCatalog,
  readInbox,
  readPeople,
  readProjects,
  readRoot,
  readTasks,
} from './lib/workspaceParts'

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

export const catalog = seatQuery({
  args: {},
  handler: async (ctx) => (ctx.me === null ? GONE : await readCatalog(ctx, ctx.me)),
})

export const people = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) =>
    ctx.me === null ? GONE : await readPeople(ctx, ctx.me, gridWindow(w)),
})

export const projects = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) =>
    ctx.me === null ? GONE : await readProjects(ctx, ctx.me, gridWindow(w)),
})

export const tasks = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) => (ctx.me === null ? GONE : await readTasks(ctx, ctx.me, gridWindow(w))),
})

export const inbox = seatQuery({
  args: {},
  handler: async (ctx) => (ctx.me === null ? GONE : await readInbox(ctx, ctx.me)),
})
