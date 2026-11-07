/* A stand-in for the app's three milestone reads (convex/milestones.ts get,
   section and between) that answers from a workspace the app holds, for
   the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs), as store/overviewStandIn.setup.ts answers the
   Overview.

   It applies the reads' rules (convex/model/milestones.ts readMilestones,
   milestoneProjects and visibleMilestone) to the workspace's milestones:
   the projects named, each sub-project standing for its top-level
   project, only the active ones the workspace shows; the order by stored
   day, name key and id; `from` and `to` by the day the app shows a stored
   day on (shownDay), read from OVERFLOW_DAYS before `from`; the search on
   name keys; `after`, `limit`, `next` (null once no milestone follows) and
   `past`; and a `get` that answers null for an unknown milestone, one
   stored on a sub-project or one of a project the person does not see,
   with `can_write` from the person's own level on its top-level project,
   as the app's level rule reads the workspace (User access or more; a
   project shown only to reach a sub-project gives none). A section read
   with `mine` lists My view's projects, which it finds by the health
   table's rule (store/overviewStandIn.setup.ts myViewProjects), answers
   them as `projects` and refuses more than MILESTONE_READ_PROJECTS of them
   with milestone_too_many. It reads no read budget, so a refusal, a
   failure, a read that stops or one that never answers comes only when
   `force` asks for it.
   src/store/milestoneStandInParity.test.ts compares it with the real
   queries. It imports nothing the benchmark's worker cannot load. */

import { ConvexError } from 'convex/values'
import { LIMITS, MILESTONE_READ_PROJECTS, MILESTONE_READ_ROWS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import {
  comparePositions,
  type MilestonePosition,
  type MilestoneRow,
  positionOf,
  shownDay,
} from './milestoneRows'
import { myViewProjects } from './overviewStandIn.setup'

/** A state a section or a range answers whatever the workspace says. */
type ForcedBatch = 'loading' | 'error' | 'refused' | 'unchecked' | 'stopped'

/** A state the stand-in answers whatever the workspace says, for each
    read: no answer (`loading`), a failure (`error`), a refusal with the
    server's sentence for a read too large (`refused`) or for an access
    check a bound stopped (`unchecked`), for `get` an answer of null
    (`unavailable`), and for a section or a range a read that stops after
    its first row (`stopped`). `upcoming` and `past` force one side of a
    section alone, over `section`, so a test can fail Past while Upcoming
    answers. `more` forces a section ask that grows or moves a section,
    over its side's state, so a Load more fails while the read it grows
    answers: one that names `after`, or whose `limit` is above the least
    of `firstBatch` and none of them, the app's first batches (10 and 25
    unless set, src/lib/milestoneSection.ts OVERVIEW_MILESTONES and
    MILESTONE_SECTION), so a first ask of either size is not one and a
    one-row read is not either. `mine` forces a section read with `mine`
    alone, over every other state: its refusal for a read too large
    (`refused`) or for too many projects (`too_many`). `canWrite` replaces
    `get`'s `can_write`. */
export type ForcedMilestones = {
  get?: 'loading' | 'error' | 'unavailable' | 'refused' | 'unchecked'
  section?: ForcedBatch
  upcoming?: ForcedBatch
  past?: ForcedBatch
  more?: ForcedBatch
  firstBatch?: number | readonly number[]
  mine?: 'refused' | 'too_many'
  between?: ForcedBatch
  canWrite?: boolean
}

/** The app's first batches of a section, which a Load more is not
    (ForcedMilestones `more`). */
const FIRST_BATCHES: readonly number[] = [10, 25]

/** The state `force` holds the read `query` with `args` in, if any: a
    section ask's own one first (ForcedMilestones `more`, then its side). */
function forcedOf(
  query: 'get' | 'section' | 'between',
  args: MilestoneReadArgs,
  force: ForcedMilestones,
): ForcedMilestones['get'] | ForcedBatch | undefined {
  if (query !== 'section') return force[query]
  const firsts =
    force.firstBatch === undefined
      ? FIRST_BATCHES
      : typeof force.firstBatch === 'number'
        ? [force.firstBatch]
        : force.firstBatch
  const limit = args.limit ?? 0
  const grows = args.after !== undefined || (limit > Math.min(...firsts) && !firsts.includes(limit))
  return (
    (grows ? force.more : undefined) ??
    (args.side === 'past' ? force.past : force.upcoming) ??
    force.section
  )
}

/** The arguments of the three reads, as the app sends them. */
export type MilestoneReadArgs = {
  id?: string
  projects?: readonly string[]
  mine?: boolean
  from?: string
  to?: string
  side?: 'upcoming' | 'past'
  search?: string
  after?: MilestonePosition
  limit?: number
}

/** How many days before `from` a read starts (convex/model/milestones.ts
    OVERFLOW_DAYS). */
const OVERFLOW_DAYS = 3
/** The most rows a section answer holds (convex/lib/limits.ts
    MILESTONE_READ_ROWS, convex/model/milestones.ts MILESTONE_READ.rows). */
const SECTION_ROWS = MILESTONE_READ_ROWS
/** The most weeks a range spans (LIMITS.roadmapWeeks.max). */
const RANGE_WEEKS = 260

/** The server's numbers the stand-in copies, which its parity test
    (src/store/milestoneStandInParity.test.ts) compares with the server's
    own: the module imports none of the server's read code, which the
    benchmark's worker cannot load. */
export const MILESTONE_STAND_IN_NUMBERS = {
  overflowDays: OVERFLOW_DAYS,
  sectionRows: SECTION_ROWS,
  rangeWeeks: RANGE_WEEKS,
}

/** The sentence of a read of several projects too large for one request. */
export const MILESTONES_TOO_LARGE =
  'these projects need more reads than one request allows, so Qivo cannot show their milestones at once. Choose fewer projects.'
/** The sentence of a `get` whose navigation check does not fit. */
export const MILESTONE_TOO_LARGE =
  'checking access to the project of this milestone needs more reads than one request allows, so Qivo cannot open it. Contact support@qivo.io.'
/** The access_unchecked refusal's sentence (convex/lib/access.ts). */
export const MILESTONES_UNCHECKED =
  'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.'

const refusal = (reason: string, message: string) =>
  new ConvexError({ code: 'rule', reason, message })
const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })

/* `day`, a real YYYY-MM-DD day, moved by `days`. */
function shift(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

type Level = 'lead' | 'user' | 'viewer'
const RANK: Record<Level, number> = { viewer: 1, user: 2, lead: 3 }
const rank = (level: Level | null) => (level ? RANK[level] : 0)
const higher = (a: Level | null, b: Level | null) => (rank(b) > rank(a) ? b : a)

/** The person's own level on project `projectId` of `workspace`, without
    navigation, as the app's level rule reads it (store/planner.ts
    levelOnProject): an organization admin leads every project, a lead
    leads their own, and a grant or a team share gives its level, which a
    Viewer's role caps. A sub-project adds its parent's. */
function ownLevel(workspace: Workspace, projectId: string): Level | null {
  const project = workspace.projects.find((p) => p.id === projectId)
  if (!project) return null
  const me = workspace.profiles.find(
    (p) => p.org_id === project.org_id && workspace.myProfileIds.includes(p.id),
  )
  if (!me?.active) return null
  if (me.org_role === 'admin') return 'lead'
  const teams = new Set(
    workspace.teamMembers.filter((m) => m.profile_id === me.id).map((m) => m.team_id),
  )
  const grantOn = (id: string): Level | null => {
    const on = workspace.projects.find((p) => p.id === id)
    if (!on) return null
    let level: Level | null = on.lead_id === me.id && me.org_role !== 'viewer' ? 'lead' : null
    const grant = workspace.access.find((a) => a.project_id === id && a.profile_id === me.id)
    level = higher(level, (grant?.level as Level | undefined) ?? null)
    if (me.org_role !== 'guest')
      for (const share of workspace.teamAccess)
        if (share.project_id === id && teams.has(share.team_id))
          level = higher(level, share.level as Level)
    return level
  }
  let level = grantOn(project.id)
  if (project.parent_id) level = higher(level, grantOn(project.parent_id))
  return me.org_role === 'viewer' && level ? 'viewer' : level
}

/** The active top-level projects of `workspace` a read of `ids` lists,
    each once (convex/model/milestones.ts milestoneProjects). */
function rootsOf(workspace: Workspace, ids: readonly string[]): Set<string> {
  const byId = new Map(workspace.projects.map((p) => [p.id, p]))
  const roots = new Set<string>()
  for (const id of ids) {
    const project = byId.get(id)
    if (!project || project.archived_at !== undefined) continue
    const root = project.parent_id ? byId.get(project.parent_id) : project
    if (root && root.archived_at === undefined && !root.parent_id) roots.add(root.id)
  }
  return roots
}

/** Whether `row` comes after `after` in the order (`desc` newest first). */
const afterOf = (row: MilestoneRow, after: MilestonePosition | undefined, desc: boolean) => {
  if (after === undefined) return true
  const c = comparePositions(positionOf(row), after)
  return desc ? c < 0 : c > 0
}

/** A read that stops after its first row (ForcedMilestones `stopped`), as
    one whose budget ran out there: that row, and `next` and `stopped` at
    it, or at `from` when it holds none. */
function stoppedAt(rows: MilestoneRow[], from: string) {
  const first = rows[0]
  const at = first ? positionOf(first) : { week: from, key: '', id: '' }
  return { rows: first ? [first] : [], next: at, stopped: at.week }
}

/** The answer of milestone read `query` with `args` over `workspace`, or
    undefined for one `force` keeps from answering. Throws the server's
    refusals. */
export function milestoneStandIn(
  workspace: Workspace,
  query: 'get' | 'section' | 'between',
  args: MilestoneReadArgs,
  force: ForcedMilestones = {},
): unknown {
  // a section read with `mine` alone, as the perf page's mine-* states ask
  const mineAsk = query === 'section' && args.mine === true
  if (mineAsk && force.mine === 'refused')
    throw refusal('milestone_read_too_large', MILESTONES_TOO_LARGE)
  if (mineAsk && force.mine === 'too_many')
    throw refusal('milestone_too_many', LIMITS.milestoneProjects.refusal)
  const forced = forcedOf(query, args, force)
  if (forced === 'loading') return undefined
  if (forced === 'error') throw new Error('the milestone read failed')
  if (forced === 'unchecked') throw refusal('access_unchecked', MILESTONES_UNCHECKED)
  if (forced === 'refused')
    throw refusal(
      'milestone_read_too_large',
      query === 'get' ? MILESTONE_TOO_LARGE : MILESTONES_TOO_LARGE,
    )
  if (query === 'get') {
    if (forced === 'unavailable') return null
    const row = workspace.milestones.find((m) => m.id === args.id)
    const project = row && workspace.projects.find((p) => p.id === row.project_id)
    if (!row || !project || project.parent_id || project.archived_at !== undefined) return null
    const level = ownLevel(workspace, project.id)
    // a project shown only to reach one of its sub-projects
    const reaches =
      level === null &&
      workspace.projects.some(
        (p) => p.parent_id === project.id && ownLevel(workspace, p.id) !== null,
      )
    if (level === null && !reaches) return null
    const canWrite = level === 'lead' || level === 'user'
    return {
      row: { ...row },
      project: { id: project.id, name: project.name, key: project.key, org_id: project.org_id },
      can_write: force.canWrite ?? canWrite,
    }
  }
  const projects = args.projects ?? []
  if (mineAsk && projects.length > 0) throw badRequest('projects must be empty when mine is true')
  if (projects.length > MILESTONE_READ_PROJECTS)
    throw badRequest(`projects can name at most ${MILESTONE_READ_PROJECTS} projects`)
  // My view's projects, found as the server finds them, and refused past
  // the limit rather than cut
  const found = mineAsk ? [...myViewProjects(workspace).keys()] : []
  if (found.length > MILESTONE_READ_PROJECTS)
    throw refusal('milestone_too_many', LIMITS.milestoneProjects.refusal)
  const from = args.from ?? ''
  const roots = rootsOf(workspace, mineAsk ? found : projects)
  const listed = mineAsk ? { projects: [...roots].sort() } : {}
  const mine = workspace.milestones.filter((m) => roots.has(m.project_id))
  if (query === 'between') {
    const to = args.to ?? ''
    if (to <= from) throw badRequest('to must be after from')
    if (to > shift(from, 7 * RANGE_WEEKS))
      throw badRequest(`to can be at most ${RANGE_WEEKS} weeks after from`)
    const lower = shift(from, -OVERFLOW_DAYS)
    const rows = mine
      .filter((m) => {
        const shown = shownDay(m.week)
        return m.week >= lower && m.week < to && shown !== null && shown >= from && shown < to
      })
      .filter((m) => afterOf(m, args.after, false))
      .sort((a, b) => comparePositions(positionOf(a), positionOf(b)))
      .map((m) => ({ ...m }))
    if (forced === 'stopped') return stoppedAt(rows, from)
    return { rows, next: null, stopped: null }
  }
  const limit = args.limit ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > SECTION_ROWS)
    throw badRequest(`limit must be a whole number from 1 to ${SECTION_ROWS}`)
  const desc = args.side === 'past'
  const search = (args.search ?? '').trim()
  const matches = search === '' ? null : allWordsMatcher(nameKey(search))
  const lower = shift(from, -OVERFLOW_DAYS)
  const matching = mine
    .filter((m) => {
      const shown = shownDay(m.week)
      if (shown === null) return false
      return desc ? m.week < from && shown < from : m.week >= lower && shown >= from
    })
    .filter((m) => matches === null || matches(nameKey(m.name)))
    .filter((m) => afterOf(m, args.after, desc))
    .sort((a, b) => {
      const c = comparePositions(positionOf(a), positionOf(b))
      return desc ? -c : c
    })
    .map((m) => ({ ...m }))
  const rows = matching.slice(0, limit)
  const last = rows.at(-1)
  const past =
    !desc && args.after === undefined
      ? {
          past: mine.some((m) => {
            const shown = shownDay(m.week)
            return m.week < from && shown !== null && shown < from
          }),
        }
      : {}
  if (forced === 'stopped') return { ...stoppedAt(matching, from), ...past, ...listed }
  return {
    rows,
    next: matching.length > limit && last ? positionOf(last) : null,
    stopped: null,
    ...past,
    ...listed,
  }
}

/** Whether `name`, a query as Convex names it, is one of the milestone
    reads this stand-in answers. */
export const isMilestoneRead = (name: string) =>
  name === 'milestones:get' || name === 'milestones:section' || name === 'milestones:between'

/** Answers a test double's subscription to `name`, one of the milestone
    reads as Convex names it (`milestones:get` and so on), with `args`
    over `workspace` through `next`, or through `fail` where the stand-in
    refuses or fails, and not at all where `force` holds it back. */
export function answerMilestones(
  workspace: Workspace,
  name: string,
  args: unknown,
  next: (value: unknown) => void,
  fail?: (error: unknown) => void,
  force?: ForcedMilestones,
) {
  let answer: unknown
  try {
    answer = milestoneStandIn(
      workspace,
      name.slice('milestones:'.length) as 'get' | 'section' | 'between',
      args as MilestoneReadArgs,
      force,
    )
  } catch (error) {
    fail?.(error)
    return
  }
  if (answer !== undefined) next(structuredClone(answer))
}
