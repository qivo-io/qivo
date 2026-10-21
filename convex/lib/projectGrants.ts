/* The individual grants a project change stores by itself, without the
 * request naming them. The server applies them (model/projects.ts) and the
 * browser paints the same rows before the server confirms them
 * (src/store/planner.ts), so both follow one rule. The lead is
 * projects.lead_id and never a grant row. src/ imports this module, so it
 * must stay free of server runtime and import only types. */

import type { GrantLevel } from './enums'

/** The most tasks one access removal reassigns (model/projectAccess.ts
 * removeAndSettle). Each task's reassignment runs every rule of a task
 * update inside the removal's one transaction, so a larger handover would
 * pass Convex's limits for one transaction. Set at about 60% of the largest
 * count that passed the measurement behind tests/bulkReassign.test.ts (196
 * tasks with four followers each, in an organization of 100 people), taken
 * when the removal still told each follower itself. Background steps tell
 * them now (model/messages.ts NotifyPreload.deferFollowers). The removal
 * window shows it. */
export const REASSIGN_MAX = 120

/** The most people with open tasks one access removal takes access from
 * (model/projectAccess.ts removeAndSettle). The removal works out each such
 * person's sight before and after, and keeping them as Viewers looks up each
 * one's grant, which cost at most five index ranges a person when
 * convex-test counted every query (tests/bulkReassign.test.ts). 700 people
 * use about 3,500 of Convex's 4,096 and leave the rest for the removal's
 * other reads. Only a team's removal or deletion reaches it. */
export const REMOVAL_HOLDERS_MAX = 700

/** Individual grants on one project, by profile id. */
export type Grants = Record<string, GrantLevel>

/**
 * The grant a new top-level project stores for its creator. `own` is the
 * creator's entry in the request and decides when present: a level, or null
 * for none. Without one, a creator who is not an organization admin and
 * names someone else as lead gets User access, so the project does not drop
 * out of their sight. An admin sees every project and a lead leads it, so
 * neither gets a grant by default.
 */
export function creatorGrant(a: {
  admin: boolean
  creator: string
  lead: string
  own: GrantLevel | null | undefined
}): GrantLevel | null {
  if (a.own !== undefined) return a.own
  return !a.admin && a.lead !== a.creator ? 'user' : null
}

/**
 * The grants once the lead passes from `from` to `to`. The outgoing lead
 * keeps User access, and the incoming lead's own grant goes, because the lead
 * role carries their access from then on.
 */
export function grantsAfterHandover(grants: Grants, from: string | undefined, to: string): Grants {
  if (from === to) return grants
  const next = { ...grants }
  delete next[to]
  if (from !== undefined) next[from] = 'user'
  return next
}
