/* Team sync's meeting as the page derives it from the workspace's tasks
 * (src/views/TeamSync.tsx walkOf and PersonColumns, src/views/teamSync/
 * TeamOpening.tsx, SyncCard.tsx and weekFigure.ts), kept as the oracle
 * store/teamSyncParity.test.ts compares the server's agenda
 * (convex/lib/teamSyncAgenda.ts) with, and which the Team sync view stage's
 * stand-in can use. The stage that stops loading every task ends or
 * rewrites it. The test imports it after the store it boots, so it reads
 * that store. */

import { syncSince } from '../../convex/lib/teamSync'
import {
  bannerVerdict,
  blockersOf,
  doneSince,
  needsOwner,
  type ScopeWorld,
  type SyncScope,
  scopeMetaIds,
  scopeProjectIds,
  syncDay,
  syncRoster,
  syncRows,
} from '../lib/teamSync'
import { type IssueVM, P, type UserVM } from './planner'

/** The page's scope world (TeamSync.tsx): the home organization, the
 * store's projects and teams and what the person can see. */
export const worldOf = (): ScopeWorld => ({
  homeOrg: P.homeOrg,
  projects: P.projects,
  teams: P.teams,
  canSee: (id) => P.canSee(id),
})

/** One meeting of `scope` as the page derives it at `now` (ms): its
 * sub-projects and top-level projects, its rows, the walk's people, the
 * opening's Needs an owner, each walker's Done since from their exact
 * reading point, each row's blockers and banner verdict, each walker's
 * week hours (P.weekLoadOf) and the sub-projects the person may edit. */
export function meetingOf(scope: SyncScope, now: number) {
  const world = worldOf()
  const subIds = scopeProjectIds(scope, world)
  const rows = syncRows(P.issues, subIds)
  const { humans, agents } = syncRoster(rows, P.users, scope)
  const walkers: UserVM[] = [...humans, ...agents]
  const weekStart = P.org.weekStart ?? 1
  const doneOf = new Map(
    walkers.map((u) => [
      u.id,
      doneSince(u.id, P.issues, subIds, syncSince(u.sync ?? null, now, weekStart)),
    ]),
  )
  return {
    subIds,
    metaIds: scopeMetaIds(scope, world),
    rows,
    walkers,
    asks: needsOwner(P.issues, subIds, syncDay(now)),
    doneOf,
    sinceOf: (u: UserVM) => syncSince(u.sync ?? null, now, weekStart),
    blockers: (it: IssueVM) => blockersOf(it, P.issueById),
    verdict: (it: IssueVM) => bannerVerdict(P.delayOf(it), P.tracksDelay(it)),
    week: (u: UserVM) => P.weekLoadOf(u.id, P.TODAY_WEEK),
    editable: [...subIds].filter((id) => P.canWrite(id)),
  }
}
