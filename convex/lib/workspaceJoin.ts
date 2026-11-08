/* The workspace parts (workspace.ts) joined into the one workspace the app
 * keeps (src/store/workspaceBase.ts), and the reverse for stand-ins of the
 * server. src/ and scripts/ import this module, so it must stay free of
 * server runtime: its imports are types and other such modules, named with
 * their .ts extension, so Node runs it as it is.
 *
 * joinParts takes the root part and every part of every seat's
 * organization, as one Convex transition left them, and lists each section
 * per organization in seat order and, within one, window by window, so the
 * rows keep the order the windows give them: tasks by window key, projects
 * by creation within each window, and hidden load rows in their own order
 * (lib/workspaceParts.ts byLoad). The profiles, team memberships and teams
 * are the caller's own, which the root part sends; no part sends anyone
 * else's, nor a label, so the workspace holds none (the app reads them by
 * id or a batch at a time). */

import { joinLists } from './arrayLimit.ts'
import { shownAvatarColor } from './avatarColors.ts'
import { type IdWindow, idWindows, inIdWindow, piecesAfter, startWindows } from './idWindows.ts'
import { blendInbox } from './inbox.ts'
import { INBOX_LIMIT } from './limits.ts'
import type { readInbox, readProjects, readRoot, readTasks } from './workspaceParts.ts'

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
export type ProjectsPart = Ok<typeof readProjects>
export type TasksPart = Ok<typeof readTasks>
export type InboxPart = Ok<typeof readInbox>

/** The parts of one organization, its windows in order, chunked lists
 * (lib/arrayLimit.ts) joined. */
export type OrgParts = {
  projects: readonly ProjectsPart[]
  tasks: readonly TasksPart[]
  inbox: InboxPart
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

/** The workspace of `root`'s seats from their organizations' parts, each
 * `orgs` entry for root.orgs at the same place. `deliveredAt` is when the
 * server held this state, the time of the transition that carried it.
 *
 * The profiles, memberships and teams are the root part's, the caller's
 * own. A membership goes out only for one of those profiles and one of
 * those teams of the profile's organization, and a grant of the projects
 * part only for one of those profiles: the projects part still sends every
 * grant on the projects it holds, and a removed seat's memberships and
 * grants can outlive its profile for a moment (model/cascade.ts
 * removeProfile), so the store's levels read the caller's own rows and
 * nobody else's. */
export function joinParts(root: RootSeats, orgs: readonly OrgParts[], deliveredAt: string) {
  const profiles = [...root.profiles]
  const teams = [...root.teams]
  const orgOfProfile = new Map(profiles.map((p) => [p.id, p.org_id]))
  const orgOfTeam = new Map(teams.map((team) => [team.id, team.org_id]))
  const teamMembers = root.teamMembers.filter((m) => {
    const org = orgOfProfile.get(m.profile_id)
    return org !== undefined && orgOfTeam.get(m.team_id) === org
  })
  const projects: ProjectsPart['projects'] = []
  const access: ProjectsPart['access'] = []
  const teamAccess: ProjectsPart['teamAccess'] = []
  const issues: TasksPart['issues'] = []
  const links: TasksPart['links'] = []
  const issueLabels: TasksPart['issueLabels'] = []
  const attachments: TasksPart['attachments'] = []
  const issueSubs: TasksPart['issueSubs'] = []
  const orgLoad: TasksPart['orgLoad'] = []
  for (const org of orgs) {
    for (const part of org.projects) {
      projects.push(...part.projects)
      for (const g of part.access) if (orgOfProfile.has(g.profile_id)) access.push(g)
      teamAccess.push(...part.teamAccess)
    }
    for (const part of org.tasks) {
      issues.push(...part.issues)
      links.push(...part.links)
      issueLabels.push(...part.issueLabels)
      attachments.push(...part.attachments)
      issueSubs.push(...part.issueSubs)
      orgLoad.push(...part.orgLoad)
    }
  }
  // the inbox part's newest messages across the seats, which the desktop
  // alerts read; the Inbox lists inbox.page instead, and this cap goes
  // with the part (t3/limits-inbox-feed)
  const inbox = blendInbox(
    orgs.map((org) => org.inbox),
    INBOX_LIMIT,
  )
  return {
    auth_user_id: root.auth_user_id,
    myProfileIds: root.myProfileIds,
    orgs: root.orgs,
    teams,
    teamMembers,
    profiles,
    projects,
    access,
    teamAccess,
    issues,
    links,
    issueLabels,
    issueSubs,
    attachments,
    orgLoad,
    messages: inbox.messages,
    readMessageCount: inbox.readMessageCount,
    unreadTruncated: inbox.unreadTruncated,
    readTruncated: inbox.readTruncated,
    ...(inbox.messagesCut ? { messagesCut: true as const } : {}),
    create: root.create,
    delivered_at: deliveredAt,
  }
}

/** The workspace as the app keeps it, every seat's organizations joined. */
export type Workspace = ReturnType<typeof joinParts>

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
 * organization's windows per kind (lib/idWindows.ts). The app never sees a
 * row's window key, so a stand-in places tasks and projects by id, which
 * the app cannot tell apart from keys the server picked. Inverse of
 * joinParts, with rootOf, for a workspace whose sections hold no row of an
 * organization it does not list. A hidden load row names no task, so every
 * one goes to the first task window, and every seat's inbox counters go to
 * the first organization, which blendInbox adds up the same. */
export function splitWorkspace(
  workspace: Omit<Workspace, 'messagesCut' | 'create'> & { messagesCut?: boolean },
  windows: (orgId: string, kind: 'tasks' | 'projects') => readonly IdWindow[],
) {
  /** `rows` of `orgId` cut into its windows of `kind`. */
  const cut = <R extends { id: string }>(
    orgId: string,
    kind: 'tasks' | 'projects',
    rows: readonly R[],
  ) => windows(orgId, kind).map((w) => rows.filter((row) => inIdWindow(row.id, w)))
  const orgOfProfile = new Map(workspace.profiles.map((p) => [p.id, p.org_id]))
  return workspace.orgs.map((org, at) => {
    const id = org.id
    const mine = <R>(rows: readonly R[], orgOf: (row: R) => string | undefined) =>
      rows.filter((row) => orgOf(row) === id)
    const projects = mine(workspace.projects, (p) => p.org_id)
    const issues = mine(workspace.issues, (t) => t.org_id)
    const projectWindows = cut(id, 'projects', projects)
    const taskWindows = cut(id, 'tasks', issues)
    const owners = mine(workspace.orgLoad, (r) => orgOfProfile.get(r.owner_id))
    const messages = mine(workspace.messages, (m) => m.org_id)
    return {
      org_id: id,
      projects: projectWindows.map((ps) => {
        const ids = new Set(ps.map((p) => p.id))
        return {
          projects: ps,
          access: workspace.access.filter((g) => ids.has(g.project_id)),
          teamAccess: workspace.teamAccess.filter((g) => ids.has(g.project_id)),
        }
      }),
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
      inbox: {
        unread: messages.filter((m) => m.read_at === undefined),
        read: messages.filter((m) => m.read_at !== undefined),
        readMessageCount: at === 0 ? workspace.readMessageCount : 0,
        unreadTruncated: at === 0 && workspace.unreadTruncated,
        readTruncated: at === 0 && workspace.readTruncated,
        truncated: at === 0 && workspace.messagesCut === true,
      },
    }
  })
}

/** Runs one-shot query `name` with `args`, as a client does. */
export type QueryByName = (name: string, args: Record<string, unknown>) => Promise<unknown>

/* The windowed parts by kind. */
const WINDOWED_NAMES = {
  tasks: 'workspace:tasks',
  projects: 'workspace:projects',
} as const

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
 * memberships and teams, and each organization's projects, tasks and inbox,
 * each window cut where it answers overflow or split, as the app cuts them
 * (lib/idWindows.ts piecesAfter), joined by joinParts with the local time
 * as delivery time. Null without a seat. It holds no other person and no
 * label: a test or script that needs them reads people.settingsPage,
 * pickers.mentions, teams.picker or labels.picker. For tests and scripts that read the workspace
 * once rather than subscribing; its parts are read at different moments, so
 * a write meanwhile can show in some and not others.
 */
export async function readWorkspace(query: QueryByName): Promise<Workspace | null> {
  const root = (await query('workspace:root', {})) as RootAnswer
  if (root === null || 'deleting' in root) return null
  /** The answers of window `w` of `kind`, cut wherever one overflows or
   * splits. */
  const windowRows = async (
    kind: keyof typeof WINDOWED_NAMES,
    org_id: string,
    w: IdWindow,
  ): Promise<unknown[]> => {
    const name = WINDOWED_NAMES[kind]
    const answer = (await query(name, { org_id, from: w.from, to: w.to })) as Answered
    const pieces = piecesAfter(w, answer)
    if (pieces === null) return [rowsOrThrow(name, answer)]
    const rows: unknown[] = []
    for (const piece of pieces) rows.push(...(await windowRows(kind, org_id, piece)))
    return rows
  }
  const orgs: OrgParts[] = []
  for (const row of root.orgs) {
    const { id } = row
    // as the app chooses them (src/store/liveParts.ts)
    const counts = startWindows(row)
    const windows = async <P>(kind: keyof typeof WINDOWED_NAMES): Promise<P[]> => {
      const rows: unknown[] = []
      for (const w of idWindows(counts[kind])) rows.push(...(await windowRows(kind, id, w)))
      return rows as P[]
    }
    orgs.push({
      projects: await windows<ProjectsPart>('projects'),
      tasks: await windows<TasksPart>('tasks'),
      inbox: rowsOrThrow(
        'workspace:inbox',
        await query('workspace:inbox', { org_id: id }),
      ) as InboxPart,
    })
  }
  return joinParts(root, orgs, new Date().toISOString())
}
