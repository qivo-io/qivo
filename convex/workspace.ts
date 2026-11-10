/* The workspace the app shows, in one live part. The app subscribes to it
 * and adopts its results with the side queries of the same Convex
 * transition (src/store/liveParts.ts), so it shows one consistent state.
 * The reader is in lib/workspaceParts.ts. No part sends a project, grant
 * or team grant: the app reads every project it shows from the navigation
 * reads, the store's project cache (projectNav.byIds) and the views' own
 * reads (projectNav.ts).
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
 *   deleted (the task number in org_counters). It sends no other person's
 *   profile, membership or Team sync stamp, and no team the caller is not
 *   in, so it reads the same at the design size's people as at everyday
 *   values. The closing review's report in qivo-internal
 *   (evaluations/limits/closing-review-2026-11-09/closing-report.md,
 *   "Task windows retirement") holds its timed figures.
 *
 * No part sends a task or a message: the app reads every task from its
 * view's or its window's own answer (tasks.ts, overview.ts, teamSync.ts,
 * taskWindow.ts) and the Inbox through inbox.ts (its unread summary, the
 * open task's item, the list's pages and the feed its desktop alerts
 * take). The part reads the caller's own profiles first (lib/functions.ts),
 * so it reruns when one of those changes, and only a missing sign-in
 * throws. */

import { authedQuery } from './lib/functions'
import { readRoot } from './lib/workspaceParts'

export const root = authedQuery({
  args: {},
  handler: async (ctx) => await readRoot(ctx),
})
