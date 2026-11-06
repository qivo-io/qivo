/* Team sync's meeting as the page derived it from the workspace's tasks
 * before it read the server's agenda (src/views/TeamSync.tsx walkOf and
 * PersonColumns, src/views/teamSync/TeamOpening.tsx, SyncCard.tsx and
 * weekFigure.ts until the Team sync view stage), kept as the oracle
 * store/teamSyncParity.test.ts compares the agenda
 * (convex/lib/teamSyncAgenda.ts) and Team sync's stand-in
 * (store/teamSyncStandIn.setup.ts) with. It holds the page's former scope
 * rules, its fallback to All projects included, and its blocker rule, with
 * their tests (store/teamSyncOracle.test.ts), as no product module may hold
 * that fallback. The stage that removes the workspace's task windows ends
 * or rewrites it. The parity test imports it after the store it boots, so
 * it reads that store. */

import { syncSince } from '../../convex/lib/teamSync'
import { isIssueDone } from '../lib/issueGroups'
import {
  bannerVerdict,
  doneSince,
  needsOwner,
  type SyncIssue,
  type SyncScope,
  type SyncUser,
  syncDay,
  syncRows,
  syncWalk,
} from '../lib/teamSync'
import { type IssueVM, P, type ProjectVM, type TeamVM, type UserVM } from './planner'

export type SyncProject = Pick<
  ProjectVM,
  'id' | 'type' | 'org' | 'parent' | 'children' | 'teamAccess'
>
export type SyncTeam = Pick<TeamVM, 'id' | 'org'>
/** What a blocker lookup needs: its display key and whether it is finished
    (a group is finished when all its known leaves are, as `P.isDone`). */
export type BlockerIssue = Pick<
  IssueVM,
  'id' | 'key' | 'status' | 'children' | 'isGroup' | 'hasHiddenSubtasks'
>

/** What scope resolution reads: the home organization (the sync is always
    about it), the projects and teams the viewer has, and the visibility test
    (`P.canSee`). */
export type ScopeWorld = {
  homeOrg: string
  projects: readonly SyncProject[]
  teams: readonly SyncTeam[]
  canSee: (projectId: string) => boolean
}

/** The scope as the page honoured it: a team or project that no longer
    exists, belongs to another organization or is out of sight fell back to
    all. The agenda answers unavailable instead, and the page asks to
    choose. */
export function resolveSyncScope(scope: SyncScope, w: ScopeWorld): SyncScope {
  if (scope.kind === 'team') {
    return w.teams.some((t) => t.id === scope.id && t.org === w.homeOrg) ? scope : { kind: 'all' }
  }
  if (scope.kind === 'project') {
    const p = w.projects.find((x) => x.id === scope.id)
    return p && p.org === w.homeOrg && w.canSee(p.id) ? scope : { kind: 'all' }
  }
  return scope
}

/* The top-level projects a scope reaches (metas, or sub-projects shared on
   their own), each with the sub-projects it contributes. */
function scopeRoots(scope: SyncScope, w: ScopeWorld): SyncProject[] {
  const s = resolveSyncScope(scope, w)
  const home = w.projects.filter((p) => p.org === w.homeOrg && w.canSee(p.id))
  if (s.kind === 'project') return home.filter((p) => p.id === s.id)
  if (s.kind === 'team') return home.filter((p) => p.teamAccess[s.id] !== undefined)
  return home.filter((p) => p.type === 'meta')
}

/** The sub-project ids in scope (tasks live only in sub-projects): all = every
    visible sub-project of the home organization; team = the sub-projects of
    every project shared with the team (a meta's share reaches its children);
    project = that project's sub-projects, or the sub-project itself. */
export function scopeProjectIds(scope: SyncScope, w: ScopeWorld): Set<string> {
  const out = new Set<string>()
  for (const p of scopeRoots(scope, w)) {
    if (p.type !== 'meta') out.add(p.id)
    else for (const id of p.children || []) if (w.canSee(id)) out.add(id)
  }
  return out
}

/** The meta project ids in scope, whose milestones the team opening lists. */
export function scopeMetaIds(scope: SyncScope, w: ScopeWorld): Set<string> {
  const out = new Set<string>()
  for (const p of scopeRoots(scope, w)) {
    if (p.type === 'meta') out.add(p.id)
    else if (p.parent) out.add(p.parent)
  }
  return out
}

/** Everyone who owns a row, in walk order (lib/teamSync.ts syncWalk). Team
    scope keeps only that team's members. */
export function syncRoster<U extends SyncUser & { teams: readonly string[] }>(
  rows: readonly SyncIssue[],
  users: readonly U[],
  scope: SyncScope,
): { humans: U[]; agents: U[] } {
  const owners = new Set(rows.map((it) => it.owner).filter(Boolean))
  return syncWalk(
    users.filter((u) => owners.has(u.id) && (scope.kind !== 'team' || u.teams.includes(scope.id))),
  )
}

/** The display keys of the open tasks blocking this one ("is blocked by"
    links whose task is not Done). `issueById` is `P.issueById`; a blocker the
    viewer cannot see is not in it and says nothing. */
export function blockersOf(
  it: Pick<SyncIssue, 'links'>,
  issueById: Readonly<Record<string, BlockerIssue>>,
): string[] {
  const out: string[] = []
  for (const l of it.links) {
    const b = l.type === 'blocked_by' ? issueById[l.id] : undefined
    if (b && !isIssueDone(b, issueById)) out.push(b.key)
  }
  return out
}

/** The page's scope world (TeamSync.tsx): the home organization, the
 * store's projects and teams and what the person can see. */
export const worldOf = (): ScopeWorld => ({
  homeOrg: P.homeOrg,
  projects: P.projects,
  teams: P.teams,
  canSee: (id) => P.canSee(id),
})

/** One meeting of `scope` as the page derived it at `now` (ms): its
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
