/* A stand-in for Team sync's live query (convex/teamSync.ts agenda) that
   answers from a workspace the app holds, for the jsdom fixture
   (src/views/boardFixture.setup.tsx), the app-level tests and the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/boardStandIn.setup.ts answers the Board.

   It applies the agenda's rules (convex/lib/teamSyncAgenda.ts) to the
   workspace's tasks: the scope, a project with its visible live
   sub-projects, a team of the home organization through its shares, or
   All projects, answered unavailable alike for a scope it cannot honour
   and never as another scope; the rows (open tasks without subtasks), the
   Backlog tasks Needs an owner lists (convex/lib/teamSync.ts needsAnOwner)
   and the Done tasks each walker's Done since can show from their reading
   floor (readingBounds, doneSinceKind); the walkers, the rows' owners and in
   a team only its members; the ceiling, over_ceiling from the rows, asks
   and the Done tasks certain from a walker's latest reading point, else
   over_budget where the Done tasks read from the floors pass it; the shown
   parents; each row's open blockers in link creation order; the verdicts
   by convex/lib/delay.ts against each owner's load as
   store/ownerLoadsStandIn.setup.ts gives it, none needing a load for an
   organization Viewer, who gets `unknown` there; each walker's week at
   tenths on the client's clock, unavailable (`loads`) for a Viewer; the
   sub-projects the reader may edit; and `hidden`. `sees` tells the
   projects the person sees, by default every live one the workspace holds,
   and `writes` those they may edit, by default the level rule of
   convex/lib/access.ts levelUnder over the workspace's leads, grants and
   team shares, for an organization admin as for anyone. It has no read
   budget, so it answers over_budget, unavailable or unknown loads only
   where the workspace says so or `force` asks for them, and a lowered
   `ceiling` reaches over_ceiling without seeding past it.
   src/store/teamSyncParity.test.ts compares it with the real query. It
   imports nothing the benchmark's worker cannot load: the agenda module
   only as types. */

import { type DelayIssue, delayOf } from '../../convex/lib/delay'
import { TEAM_SYNC_TASKS } from '../../convex/lib/limits'
import { roundTenths } from '../../convex/lib/numbers'
import { taskOwnerId } from '../../convex/lib/review'
import { issueKey } from '../../convex/lib/taskRefs'
import {
  askHorizon,
  doneSinceKind,
  needsAnOwner,
  readingBounds,
  type SyncStamp,
} from '../../convex/lib/teamSync'
import type {
  AgendaAnswer,
  AgendaPerson,
  AgendaRow,
  AgendaScope,
} from '../../convex/lib/teamSyncAgenda'
import type { ViewRow } from '../../convex/lib/viewReads'
import {
  canonicalLoad,
  committedByWeek,
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
} from '../../convex/lib/workload'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import { groupProgress, isIssueDone } from '../lib/issueGroups'
import { spanOf } from './boardStandIn.setup'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'

/** The parents and outside blockers one agenda answers at most beside its
    tasks (convex/lib/teamSyncAgenda.ts AGENDA.context, which the parity
    test pins it to). */
export const SYNC_CONTEXT = 2000

/** The sentence an `access_unchecked` answer carries. */
export const SYNC_ACCESS_UNCHECKED =
  'Qivo could not check all of your access in time. Try again in a moment.'

/** The arguments teamSync.agenda takes (src/lib/teamSync.ts SyncAgendaArgs,
    which this module does not import, as it pulls in the store's types). */
export type SyncArgs = {
  org_id: string
  scope: AgendaScope
  day: string
  week: string
  week_starts: readonly number[]
  week_end: number
}

/** What the stand-in answers whatever the tasks say: a state in place of
    the meeting, every verdict that needs a load `unknown` (`delays`), every
    week unavailable for a reason (`weeks`), or a lower ceiling. */
export type ForcedSync = {
  state?: 'over_ceiling' | 'over_budget' | 'unavailable' | 'access_unchecked'
  delays?: 'unknown'
  weeks?: 'loads' | 'budget'
  ceiling?: number
}

type Task = Workspace['issues'][number]
type Project = Workspace['projects'][number]

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byNumber = (a: Task, b: Task) =>
  a.num - b.num || order(a.org_id, b.org_id) || order(a.id, b.id)

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/* The days since 1970-01-01 of YYYY-MM-DD `iso`. */
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/** The client's clock as convex/lib/viewLoads.ts clockOf places days and
    instants in its weeks, week 0 being the client's current week. */
function clockOf(a: SyncArgs) {
  const first = dayNumber(a.week)
  const starts = a.week_starts
  const last = starts.length - 1
  return {
    day: a.day,
    ofDay: (iso: string) => Math.floor((dayNumber(iso) - first) / 7),
    ofInstant: (instant: string) => {
      const ms = Date.parse(instant)
      if (ms >= a.week_end) return 1 + Math.floor((ms - a.week_end) / WEEK_MS)
      if (ms >= (starts[last] as number)) return 0
      if (ms < (starts[0] as number))
        return -last - Math.ceil(((starts[0] as number) - ms) / WEEK_MS)
      let lo = 0
      let hi = last
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if ((starts[mid] as number) <= ms) lo = mid
        else hi = mid
      }
      return lo - last
    },
  }
}

const OPEN = new Set(['todo', 'progress', 'review'])

/**
 * What teamSync.agenda answers `args` to the person whose workspace is
 * `workspace`. `sees` tells whether they see a project and `writes` whether
 * they may edit one; `force` answers a state or unknown figures instead.
 */
export function teamSyncStandIn(
  workspace: Workspace,
  args: SyncArgs,
  {
    sees,
    writes,
    force = {},
  }: {
    sees?: (projectId: string) => boolean
    writes?: (projectId: string) => boolean
    force?: ForcedSync
  } = {},
): AgendaAnswer {
  const org = args.org_id
  const mine = new Set(workspace.myProfileIds)
  const me = workspace.profiles.find((p) => p.org_id === org && mine.has(p.id))
  if (!me || me.org_role === 'guest') return { state: 'unavailable' }
  const staff = me.org_role === 'admin' || me.org_role === 'user'
  if (force.state === 'unavailable') return { state: 'unavailable' }
  if (force.state === 'access_unchecked')
    return { state: 'unavailable', reason: 'access_unchecked', message: SYNC_ACCESS_UNCHECKED }
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const myTeams = new Set(
    workspace.teamMembers.filter((m) => m.profile_id === me.id).map((m) => m.team_id),
  )
  /* Whether `me` holds User on `p` by a grant or a team share. */
  const writesOn = (p: Project | undefined) =>
    p !== undefined &&
    (workspace.access.some(
      (a) => a.project_id === p.id && a.profile_id === me.id && a.level === 'user',
    ) ||
      workspace.teamAccess.some(
        (s) => s.project_id === p.id && myTeams.has(s.team_id) && s.level === 'user',
      ))
  /* Whether `me` may edit sub-project `id` by the level rule: its lead or
     its parent's, or User on it or its parent, never for a Viewer. */
  const editsByLevel = (id: string) => {
    const sub = projectById.get(id)
    if (me.org_role === 'viewer' || sub === undefined) return false
    const parent = sub.parent_id === undefined ? undefined : projectById.get(sub.parent_id)
    const lead = (sub.lead_id ?? parent?.lead_id) === me.id || parent?.lead_id === me.id
    return lead || writesOn(sub) || writesOn(parent)
  }
  const live = (p: Project | undefined): p is Project =>
    p !== undefined && p.org_id === org && p.archived_at === undefined
  const seen = (p: Project | undefined): p is Project => live(p) && (sees ? sees(p.id) : true)

  // the scope's sub-projects and top-level projects, or null where the
  // reader cannot honour it
  const subs = new Map<string, Project>()
  const tops = new Set<string>()
  /* adds the selection of project `p`: a top-level project's seen live
     sub-projects, or a seen sub-project; a top-level project that holds no
     sub-projects (not a meta) selects nothing, as the server's
     lib/viewReads.ts selectionOf */
  const select = (p: Project | undefined): boolean => {
    if (!live(p)) return false
    if (p.parent_id === undefined && p.type !== 'meta') return false
    if (p.parent_id !== undefined) {
      if (!seen(p)) return false
      subs.set(p.id, p)
      tops.add(p.parent_id)
      return true
    }
    const kids = workspace.projects.filter((c) => c.parent_id === p.id && seen(c))
    for (const c of kids) subs.set(c.id, c)
    // a top-level project seen only to reach sub-projects none of which is
    // live holds nothing
    if (kids.length > 0 || seen(p)) tops.add(p.id)
    return true
  }
  const scope = args.scope
  if (scope.kind === 'project') {
    if (!select(projectById.get(scope.project_id))) return { state: 'unavailable' }
  } else if (scope.kind === 'team') {
    const team = workspace.teams.find((t) => t.id === scope.team_id)
    if (!team || team.org_id !== org) return { state: 'unavailable' }
    for (const share of workspace.teamAccess)
      if (share.team_id === team.id) select(projectById.get(share.project_id))
  } else
    for (const p of workspace.projects)
      if (p.parent_id === undefined && p.type === 'meta' && seen(p)) select(p)
  const subIds = [...subs.keys()].sort(order)
  const inScope = (t: Task) => subs.has(t.project_id)
  const ceiling = force.ceiling ?? TEAM_SYNC_TASKS
  if (force.state === 'over_budget') return { state: 'over_budget' }
  if (force.state === 'over_ceiling') return { state: 'over_ceiling', ceiling }

  // the workspace's tasks, their subtasks and what makes a task a group
  const byId = new Map(workspace.issues.map((t) => [t.id, t]))
  const children = new Map<string, string[]>()
  for (const t of workspace.issues)
    if (t.parent_id !== undefined && byId.has(t.parent_id))
      children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t.id])
  const isGroup = (t: Task) => t.has_hidden_subtasks || (children.get(t.id)?.length ?? 0) > 0
  const groupView = Object.fromEntries(
    workspace.issues.map((t) => [
      t.id,
      {
        id: t.id,
        status: t.status,
        children: children.get(t.id) ?? [],
        hasHiddenSubtasks: t.has_hidden_subtasks,
      },
    ]),
  )
  const done = (t: Task) => isIssueDone(groupView[t.id], groupView)
  const clock = clockOf(args)
  const horizon = askHorizon(args.day)

  // the rows and the asks
  const leaves = workspace.issues.filter((t) => t.org_id === org && inScope(t) && !isGroup(t))
  const rows = leaves.filter((t) => OPEN.has(t.status))
  const asks = leaves.filter(
    (t) =>
      t.status === 'backlog' &&
      needsAnOwner(
        {
          status: t.status,
          pressing: t.priority === 'urgent' || t.priority === 'high',
          assigned: t.assignee_id !== undefined,
          group: false,
          startsByThisWeek: t.start_week !== undefined && clock.ofDay(t.start_week) <= 0,
          due: t.due_date ?? null,
        },
        horizon,
      ),
  )
  if (rows.length + asks.length > ceiling) return { state: 'over_ceiling', ceiling }

  // the walk's people: the rows' owners of the organization, in a team its
  // members, in id order
  const profileById = new Map(workspace.profiles.map((p) => [p.id, p]))
  const members =
    scope.kind === 'team'
      ? new Set(
          workspace.teamMembers.filter((m) => m.team_id === scope.team_id).map((m) => m.profile_id),
        )
      : null
  const owners = [...new Set(rows.flatMap((t) => taskOwnerId(t, false) ?? []))].sort(order)
  const walkers = owners.flatMap((id) => {
    const p = profileById.get(id)
    return p !== undefined && p.org_id === org && (!members || members.has(id)) ? [p] : []
  })
  const stampOf = (p: (typeof walkers)[number]): SyncStamp | null =>
    p.sync_at === undefined
      ? null
      : { at: p.sync_at, ...(p.sync_since === undefined ? {} : { since: p.sync_since }) }

  // the Done tasks each walker's Done since can show from their floor, and
  // those certain from their latest reading point
  const weekStart = workspace.orgs.find((o) => o.id === org)?.week_start ?? 1
  const bounds = new Map(walkers.map((p) => [p.id, readingBounds(stampOf(p), args, weekStart)]))
  const shows = (t: Task, point: 'floor' | 'top') => {
    for (const id of [t.assignee_id, t.reviewer_id]) {
      const b = id === undefined ? undefined : bounds.get(id)
      if (
        id !== undefined &&
        b !== undefined &&
        doneSinceKind(
          {
            status: t.status,
            group: false,
            doneAt: t.done_at === undefined ? null : Date.parse(t.done_at),
            assignee: t.assignee_id ?? null,
            reviewer: t.reviewer_id ?? null,
            handedOff: t.review_at !== undefined,
          },
          id,
          b[point],
        )
      )
        return true
    }
    return false
  }
  const doneTasks = leaves.filter((t) => t.status === 'done' && shows(t, 'floor'))
  const certain = doneTasks.filter((t) => shows(t, 'top')).length
  const fixed = rows.length + asks.length
  if (fixed + certain > ceiling) return { state: 'over_ceiling', ceiling }
  if (fixed + doneTasks.length > ceiling) return { state: 'over_budget' }

  // the shown parents, then the blockers, within SYNC_CONTEXT together
  const agenda = [...rows, ...asks, ...doneTasks]
  const inAgenda = new Set(agenda.map((t) => t.id))
  const parents = new Map<string, Task>()
  for (const t of agenda) {
    const visited = new Set([t.id])
    for (let p = t.parent_id && byId.get(t.parent_id); p && !visited.has(p.id); ) {
      visited.add(p.id)
      if (!inAgenda.has(p.id)) parents.set(p.id, p)
      p = p.parent_id ? byId.get(p.parent_id) : undefined
    }
  }
  const rowIds = new Set(rows.map((t) => t.id))
  const links = workspace.links
    .filter((l) => l.type === 'blocks' && rowIds.has(l.target_id))
    .sort((a, b) => order(a.created_at, b.created_at) || order(a.id, b.id))
  const blockerIds = new Set<string>()
  const blockedBy = new Map<string, string[]>()
  for (const link of links) {
    const b = byId.get(link.source_id)
    if (!b || b.org_id !== org) continue
    blockerIds.add(b.id)
    if (done(b)) continue
    blockedBy.set(link.target_id, [...(blockedBy.get(link.target_id) ?? []), issueKey(b.num)])
  }
  const related = new Set(parents.keys())
  for (const id of blockerIds) if (!inAgenda.has(id)) related.add(id)
  if (related.size > SYNC_CONTEXT) return { state: 'over_budget' }

  // the verdicts and the weeks
  const capacityOf = (id: string | undefined, orgId: string) => {
    const p = id === undefined ? undefined : profileById.get(id)
    return p !== undefined && p.org_id === orgId
      ? plannableHoursOf({ plannableHours: p.plannable_hours, kind: p.kind })
      : DEFAULT_PLANNABLE_HOURS
  }
  const loads = new Map<string, LoadSpan[]>()
  const loadOf = (id: string): LoadSpan[] => {
    const known = loads.get(id)
    if (known) return known
    const first = ownerLoadsStandIn(workspace, { org_id: org, owner_ids: [id] }).owners[0]
    const spans =
      first?.state === 'ok'
        ? canonicalLoad(
            first.spans.map((s) => ({
              issueUuid: s.issue_id,
              start: clock.ofDay(s.start_week),
              end: clock.ofDay(s.end_week),
              remaining: s.remaining,
              remainingSet:
                s.remaining_set_at === null ? null : clock.ofInstant(s.remaining_set_at),
            })),
          )
        : []
    loads.set(id, spans)
    return spans
  }
  /* the owner whose load `t`'s verdict needs, or null (lib/viewLoads.ts
     verdicts needs) */
  const needs = (t: Task): string | null => {
    if (t.end_week === undefined && t.due_date === undefined) return null
    if (!((t.remaining_hours ?? 0) > 0)) return null
    const id = taskOwnerId(t, false)
    if (id === undefined || !profileById.has(id)) return null
    const capacity = capacityOf(id, t.org_id)
    return Number.isFinite(capacity) && capacity > 0 ? id : null
  }
  const verdictOf = (t: Task): AgendaRow['delay'] => {
    if (subs.get(t.project_id)?.track_delay !== true) return null
    const owner = needs(t)
    if (owner !== null && (!staff || force.delays === 'unknown')) return 'unknown'
    const week = (day: string | undefined) => (day ? clock.ofDay(day) : null)
    const start = week(t.start_week)
    const planned = week(t.end_week)
    const ownerId = taskOwnerId(t, false)
    const it: DelayIssue = {
      uuid: t.id,
      status: t.status,
      isGroup: false,
      isDone: t.status === 'done',
      partial: false,
      owner: ownerId ?? null,
      start,
      end: planned === null ? null : Math.max(start ?? planned, planned),
      dueWeek: week(t.due_date),
      duePast: t.due_date !== undefined && t.due_date < clock.day,
      remaining: t.remaining_hours,
      remainingSet: t.remaining_set_at ? clock.ofInstant(t.remaining_set_at) : null,
      capacity: capacityOf(ownerId, t.org_id),
    }
    const verdict = delayOf(it, owner === null ? [] : loadOf(owner), 0)
    return verdict === null || verdict.status === 'ok' ? null : verdict.status
  }
  const weekOf = (id: string): AgendaPerson['week'] => {
    if (force.weeks) return { state: 'unavailable', reason: force.weeks }
    if (!staff) return { state: 'unavailable', reason: 'loads' }
    const hours = committedByWeek(loadOf(id), null, { from: 0, to: 0 }).get(0) ?? 0
    return { state: 'ok', hours: roundTenths(hours) }
  }

  // the rows as the agenda sends them
  const shown = new Set([...inAgenda, ...parents.keys()])
  const out = (t: Task): ViewRow => {
    const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
    const row = {
      ...rest,
      ...(parent !== undefined && shown.has(parent)
        ? { parent_id: parent, has_hidden_parent: false }
        : parent !== undefined
          ? { has_hidden_parent: true }
          : {}),
    } as Omit<ViewRow, 'has_subtasks'>
    if (!isGroup(t)) return { ...row, has_subtasks: false, has_hidden_subtasks: false }
    return {
      ...row,
      has_subtasks: true,
      has_hidden_subtasks: t.has_hidden_subtasks,
      group_done: done(t),
      span: {
        ...spanOf(t, children, byId),
        partial: groupProgress(groupView[t.id], groupView).unknown,
      },
    }
  }
  return {
    state: 'ok',
    sub_projects: subIds,
    top_projects: [...tops].sort(order),
    editable: subIds.filter((id) => (writes ? writes(id) : editsByLevel(id))),
    rows: rows.sort(byNumber).map((t) => ({
      ...out(t),
      blocked_by: blockedBy.get(t.id) ?? [],
      delay: verdictOf(t),
    })),
    asks: asks.sort(byNumber).map(out),
    done: doneTasks.sort(byNumber).map(out),
    parents: [...parents.values()].sort(byNumber).map(out),
    people: walkers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      active: p.active,
      plannable_hours: p.plannable_hours ?? null,
      stamp: stampOf(p),
      week: weekOf(p.id),
    })),
    hidden: staff ? 'counted' : 'own_only',
  }
}
