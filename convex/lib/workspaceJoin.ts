/* The root part (workspace.ts root) as the one workspace the app keeps
 * (src/store/workspaceBase.ts), and the reverse for stand-ins of the
 * server. src/ and scripts/ import this module, so it must stay free of
 * server runtime. Its imports are types and other such modules, named with
 * their .ts extension, so Node runs it as it is.
 *
 * The app's workspace is the root part alone (rootWorkspace). Its
 * profiles, team memberships and teams are the caller's own. No part sends
 * anyone else's, nor a task, a label, a project, a grant or a team grant,
 * so the workspace holds none. The app reads every task from its views'
 * and its window's own answers, people and labels by id or a batch at a
 * time, and every project it shows through the navigation reads,
 * projectNav.byIds and the views' own answers (convex/projectNav.ts).
 *
 * joinParts and readWorkspace still join each organization's task windows
 * beside the root, window by window in the order the windows give them,
 * for the tests and scripts that read the tasks part. */

import { joinLists } from './arrayLimit.ts'
import { shownAvatarColor } from './avatarColors.ts'
import { type IdWindow, idWindows, inIdWindow, piecesAfter, startWindows } from './idWindows.ts'
import type { readRoot, readTasks } from './workspaceParts.ts'

/* What a reader behind a part answers (lib/workspaceParts.ts), the types
 * taken from the readers rather than from `api`, which lists this module. */
type Read<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>
/** A part's answer with rows. */
type Ok<F extends (...args: never[]) => Promise<unknown>> = Omit<
  Extract<Read<F>, { state: 'ok' }>,
  'more' | 'split' | 'state'
>

export type RootAnswer = Read<typeof readRoot>
/** The root part's answer for a login with no seat it can open, because a
 * running organization deletion holds its seats (`deleting`) or an
 * organization deactivated it, with when it may create an organization. */
export type Seatless = Extract<RootAnswer, { deleting: boolean }>
/** The root part's answer for a caller with a seat. */
export type RootSeats = Exclude<RootAnswer, null | Seatless>

/** The organizations of the root part's answer, none without a seat. */
export const rootOrgs = (root: RootAnswer): RootSeats['orgs'] =>
  root === null || 'deleting' in root ? [] : root.orgs
export type TasksPart = Ok<typeof readTasks>

/** The parts of one organization, its windows in order, chunked lists
 * (lib/arrayLimit.ts) joined. */
export type OrgParts = {
  tasks: readonly TasksPart[]
}

/** A part's answer with its chunked lists joined back and the window
 * bookkeeping (`state`, `split`) left out. */
export function partRows<A extends { state: 'ok'; more?: Record<string, unknown[][] | undefined> }>(
  answer: A,
): Omit<A, 'more' | 'state' | 'split'> {
  const {
    state: _state,
    split: _split,
    ...rest
  } = joinLists(answer) as Omit<A, 'more'> & {
    split?: number
  }
  return rest as Omit<A, 'more' | 'state' | 'split'>
}

/** The workspace of `root`'s seats, as the app keeps it. `deliveredAt` is
 * when the server held this state, the time of the transition that
 * carried it.
 *
 * The profiles, memberships and teams are the root part's, the caller's
 * own. A membership goes out only for one of those profiles and one of
 * those teams of the profile's organization, as a removed seat's
 * memberships can outlive its profile for a moment (model/cascade.ts
 * removeProfile). */
export function rootWorkspace(root: RootSeats, deliveredAt: string) {
  const profiles = [...root.profiles]
  const teams = [...root.teams]
  const orgOfProfile = new Map(profiles.map((p) => [p.id, p.org_id]))
  const orgOfTeam = new Map(teams.map((team) => [team.id, team.org_id]))
  const teamMembers = root.teamMembers.filter((m) => {
    const org = orgOfProfile.get(m.profile_id)
    return org !== undefined && orgOfTeam.get(m.team_id) === org
  })
  return {
    auth_user_id: root.auth_user_id,
    myProfileIds: root.myProfileIds,
    orgs: root.orgs,
    teams,
    teamMembers,
    profiles,
    create: root.create,
    delivered_at: deliveredAt,
  }
}

/** The workspace as the app keeps it, the root part's answer for every
 * seat. */
export type Workspace = ReturnType<typeof rootWorkspace>

/** The workspace of `root`'s seats with their organizations' task windows
 * joined beside it, each `orgs` entry for root.orgs at the same place, as
 * the tests and scripts that still read the tasks part take it
 * (readWorkspace). The app subscribes no task window. */
export function joinParts(root: RootSeats, orgs: readonly OrgParts[], deliveredAt: string) {
  const issues: TasksPart['issues'] = []
  const links: TasksPart['links'] = []
  const issueLabels: TasksPart['issueLabels'] = []
  const attachments: TasksPart['attachments'] = []
  const issueSubs: TasksPart['issueSubs'] = []
  const orgLoad: TasksPart['orgLoad'] = []
  for (const org of orgs) {
    for (const part of org.tasks) {
      issues.push(...part.issues)
      links.push(...part.links)
      issueLabels.push(...part.issueLabels)
      attachments.push(...part.attachments)
      issueSubs.push(...part.issueSubs)
      orgLoad.push(...part.orgLoad)
    }
  }
  return {
    ...rootWorkspace(root, deliveredAt),
    issues,
    links,
    issueLabels,
    issueSubs,
    attachments,
    orgLoad,
  }
}

/** The workspace with every seat's task windows joined (joinParts). */
export type JoinedWorkspace = ReturnType<typeof joinParts>

/** The rows a stand-in of the server holds beside the workspace's: every
 * profile, membership and team of each organization, not only the
 * caller's (src/store/guard/liveDouble.setup.ts Whole). */
type ServerRows = Pick<
  Workspace,
  'auth_user_id' | 'myProfileIds' | 'orgs' | 'profiles' | 'teamMembers' | 'teams'
> & { create?: Workspace['create'] }

/** The root part a server holding `whole` answers its caller, for
 * stand-ins of the server (tests, the browser benchmark): the seats of
 * `myProfileIds` in that order, every membership of each, and the teams
 * those name of the profile's own organization, each once, as
 * lib/workspaceParts.ts readRoot answers them, an older color as gray
 * (avatarColors.ts shownAvatarColor). A stand-in's whole holds no stamp on
 * the root's rows, which carry none. */
export function rootOf(whole: ServerRows): RootSeats {
  const byId = new Map(whole.profiles.map((p) => [p.id, p]))
  const orgs = new Set(whole.orgs.map((org) => org.id))
  const profiles = whole.myProfileIds.flatMap((id) => {
    const p = byId.get(id)
    if (!p || !orgs.has(p.org_id)) return []
    const {
      sync_at: _at,
      sync_since: _since,
      ...row
    } = p as typeof p & {
      sync_at?: string
      sync_since?: string
    }
    return [{ ...row, color: shownAvatarColor(row.color) }]
  })
  const teamsById = new Map(whole.teams.map((team) => [team.id, team]))
  const teamMembers: Workspace['teamMembers'] = []
  const teams: Workspace['teams'] = []
  for (const p of profiles)
    for (const m of whole.teamMembers) {
      if (m.profile_id !== p.id) continue
      teamMembers.push(m)
      const team = teamsById.get(m.team_id)
      if (team && team.org_id === p.org_id && !teams.includes(team)) teams.push(team)
    }
  return {
    auth_user_id: whole.auth_user_id,
    myProfileIds: whole.myProfileIds,
    orgs: whole.orgs,
    profiles,
    teamMembers,
    teams,
    create: whole.create ?? 'now',
  }
}

/** The parts a server holding `workspace` would answer, for stand-ins of
 * the server (tests, the browser benchmark): `windows` gives each
 * organization's task windows (lib/idWindows.ts). The app never sees a
 * row's window key, so a stand-in places tasks by id, which the app cannot
 * tell apart from keys the server picked. Inverse of
 * joinParts, with rootOf, for a workspace whose sections hold no row of an
 * organization it does not list. A hidden load row names no task, so every
 * one goes to the first task window. */
export function splitWorkspace(
  workspace: Omit<JoinedWorkspace, 'create'>,
  windows: (orgId: string) => readonly IdWindow[],
) {
  /** `rows` of `orgId` cut into its task windows. */
  const cut = <R extends { id: string }>(orgId: string, rows: readonly R[]) =>
    windows(orgId).map((w) => rows.filter((row) => inIdWindow(row.id, w)))
  const orgOfProfile = new Map(workspace.profiles.map((p) => [p.id, p.org_id]))
  return workspace.orgs.map((org) => {
    const id = org.id
    const mine = <R>(rows: readonly R[], orgOf: (row: R) => string | undefined) =>
      rows.filter((row) => orgOf(row) === id)
    const issues = mine(workspace.issues, (t) => t.org_id)
    const taskWindows = cut(id, issues)
    const owners = mine(workspace.orgLoad, (r) => orgOfProfile.get(r.owner_id))
    return {
      org_id: id,
      tasks: taskWindows.map((ts, i) => {
        const ids = new Set(ts.map((t) => t.id))
        return {
          issues: ts,
          orgLoad: i === 0 ? owners : [],
          links: workspace.links.filter((l) => ids.has(l.source_id)),
          issueLabels: workspace.issueLabels.filter((l) => ids.has(l.issue_id)),
          attachments: workspace.attachments.filter((a) => ids.has(a.issue_id)),
          issueSubs: workspace.issueSubs.filter((s) => ids.has(s.issue_id)),
        }
      }),
    }
  })
}

/** Runs one-shot query `name` with `args`, as a client does. */
export type QueryByName = (name: string, args: Record<string, unknown>) => Promise<unknown>

/* The windowed part. */
const TASKS_PART = 'workspace:tasks'

/* A part's answer before its rows are taken. */
type Answered = { state: string; split?: boolean; pieces?: number; message?: string }

/** The answer of part `name`, which must have rows. */
function rowsOrThrow(name: string, answer: unknown) {
  const a = answer as Answered
  if (a.state === 'refused') throw new Error(a.message)
  if (a.state !== 'ok') throw new Error(`${name} answered ${a.state}`)
  return partRows(a as Answered & { state: 'ok' })
}

/**
 * The workspace of the caller of `query` read once, as the app holds it once
 * every part answered: the root, with the caller's own profiles,
 * memberships and teams, and each organization's tasks, each task window
 * cut where it answers overflow or split, as the app cuts them
 * (lib/idWindows.ts piecesAfter), joined by joinParts with the local time
 * as delivery time. Null without a seat. It holds no other person and no
 * label and no project: a test or script that needs them reads
 * people.settingsPage, pickers.mentions, teams.picker, labels.picker or the
 * navigation reads (projectNav.page, children and byIds), and the tests
 * take their reference projects from convex/tests/projectsOracle.setup.ts.
 * For tests and scripts that read the workspace
 * once rather than subscribing; its parts are read at different moments, so
 * a write meanwhile can show in some and not others.
 */
export async function readWorkspace(query: QueryByName): Promise<JoinedWorkspace | null> {
  const root = (await query('workspace:root', {})) as RootAnswer
  if (root === null || 'deleting' in root) return null
  /** The answers of task window `w`, cut wherever one overflows or
   * splits. */
  const windowRows = async (org_id: string, w: IdWindow): Promise<unknown[]> => {
    const answer = (await query(TASKS_PART, { org_id, from: w.from, to: w.to })) as Answered
    const pieces = piecesAfter(w, answer)
    if (pieces === null) return [rowsOrThrow(TASKS_PART, answer)]
    const rows: unknown[] = []
    for (const piece of pieces) rows.push(...(await windowRows(org_id, piece)))
    return rows
  }
  const orgs: OrgParts[] = []
  for (const row of root.orgs) {
    const { id } = row
    // as the app chooses them (src/store/liveParts.ts)
    const tasks: unknown[] = []
    for (const w of idWindows(startWindows(row).tasks)) tasks.push(...(await windowRows(id, w)))
    orgs.push({
      tasks: tasks as TasksPart[],
    })
  }
  return joinParts(root, orgs, new Date().toISOString())
}
