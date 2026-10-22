/* The workspace the app shows, in live parts. The app subscribes to each
 * part and adopts the results of one Convex transition together
 * (src/store/liveParts.ts), so it shows one consistent state, and a change
 * re-sends only the parts it changed. Readers and budgets are in
 * lib/workspaceParts.ts.
 *
 * - root: the caller's seats and organizations, or null with no seat. It
 *   reads the caller's profiles, each organization and its counters, so it
 *   reruns on seat changes, organization settings and every task or project
 *   created (the counters).
 * - catalog (per organization): teams and labels. One range each.
 * - people (per window of the organization's profile ids,
 *   lib/idWindows.ts): profiles with their Team sync stamps and team
 *   memberships. Two ranges, and one per person for their memberships.
 * - projects (per window of its project ids): the projects the caller can
 *   see, with grants, team grants and the active ones' milestones. Up to
 *   three ranges per project, beside the caller's project view.
 * - tasks (per window of its task ids): the caller's working set, with
 *   links, labels, attachments and follows, and the anonymized load of the
 *   window's tasks the caller is not shown. Six ranges for the window, one
 *   per task outside it that a task names (a parent, a link target) and one
 *   per owner of a hidden task.
 * - inbox (per organization): the caller's messages, at most 3,002 messages
 *   read and one range per task they name.
 *
 * Every part reads the caller's own profiles first (lib/functions.ts), so
 * all of them rerun when one of those changes, and answer the same. A part
 * of an organization the caller no longer holds a seat in answers
 * `{state: 'gone'}`, and only a missing sign-in throws. Every part also reads
 * the caller's project view (lib/visibility.ts orgProjectView: the
 * organization's projects and the caller's grants and teams) where it
 * needs to know what the caller can see, so a project or access edit reruns
 * them all. Each windowed part stays inside Convex's limits at any size by
 * answering `split` or `overflow` (lib/workspaceParts.ts), and the app
 * chooses the windows from the organization's counters, without asking. */

import { v } from 'convex/values'
import { authedQuery, seatQuery } from './lib/functions'
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
  handler: async (ctx, w) => (ctx.me === null ? GONE : await readPeople(ctx, ctx.me, w)),
})

export const projects = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) => (ctx.me === null ? GONE : await readProjects(ctx, ctx.me, w)),
})

export const tasks = seatQuery({
  args: windowArgs,
  handler: async (ctx, w) => (ctx.me === null ? GONE : await readTasks(ctx, ctx.me, w)),
})

export const inbox = seatQuery({
  args: {},
  handler: async (ctx) => (ctx.me === null ? GONE : await readInbox(ctx, ctx.me)),
})
