/* The workspace parts (workspace.ts) joined into the one workspace the app
 * keeps (src/store/workspaceBase.ts), and the reverse for stand-ins of the
 * server. src/ and scripts/ import this module, so it must stay free of
 * server runtime: its imports are types and other such modules, named with
 * their .ts extension, so Node runs it as it is.
 *
 * joinParts takes every part of every seat's organization, as one Convex
 * transition left them, and lists each section per organization in seat
 * order and, within one, window by window, so the rows keep the order the
 * windows give them: people by id, tasks by window key, projects by
 * creation within each window, and hidden load rows in their own order
 * (lib/workspaceParts.ts byLoad). */

import { joinLists } from './arrayLimit.ts'
import {
  type IdWindow,
  idWindows,
  inIdWindow,
  piecesAfter,
  WINDOW_ROWS,
  windowCount,
} from './idWindows.ts'
import { blendInbox } from './inbox.ts'
import { LIMITS } from './limits.ts'
import type {
  readCatalog,
  readInbox,
  readPeople,
  readProjects,
  readRoot,
  readTasks,
} from './workspaceParts.ts'

/* What a reader behind a part answers (lib/workspaceParts.ts), the types
 * taken from the readers rather than from `api`, which lists this module. */
type Read<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>
/** A part's answer with rows. */
type Ok<F extends (...args: never[]) => Promise<unknown>> = Omit<
  Extract<Read<F>, { state: 'ok' }>,
  'more' | 'split' | 'state'
>

export type RootAnswer = Read<typeof readRoot>
export type CatalogPart = Ok<typeof readCatalog>
export type PeoplePart = Ok<typeof readPeople>
export type ProjectsPart = Ok<typeof readProjects>
export type TasksPart = Ok<typeof readTasks>
export type InboxPart = Ok<typeof readInbox>

/** The parts of one organization, its windows in order, chunked lists
 * (lib/arrayLimit.ts) joined. */
export type OrgParts = {
  catalog: CatalogPart
  people: readonly PeoplePart[]
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
 * Memberships go out only for teams and people the organization's parts
 * hold, and grants only for people it holds: a removed person's memberships
 * and grants can outlive their profile for a moment (model/cascade.ts
 * removeProfile). */
export function joinParts(
  root: NonNullable<RootAnswer>,
  orgs: readonly OrgParts[],
  deliveredAt: string,
) {
  const teams: CatalogPart['teams'] = []
  const labels: CatalogPart['labels'] = []
  const profiles: PeoplePart['profiles'] = []
  const teamMembers: PeoplePart['teamMembers'] = []
  const projects: ProjectsPart['projects'] = []
  const access: ProjectsPart['access'] = []
  const teamAccess: ProjectsPart['teamAccess'] = []
  const milestones: ProjectsPart['milestones'] = []
  const issues: TasksPart['issues'] = []
  const links: TasksPart['links'] = []
  const issueLabels: TasksPart['issueLabels'] = []
  const attachments: TasksPart['attachments'] = []
  const issueSubs: TasksPart['issueSubs'] = []
  const orgLoad: TasksPart['orgLoad'] = []
  for (const org of orgs) {
    teams.push(...org.catalog.teams)
    labels.push(...org.catalog.labels)
    const people = new Set<string>()
    for (const part of org.people) for (const p of part.profiles) people.add(p.id)
    const teamIds = new Set(org.catalog.teams.map((team) => team.id))
    for (const part of org.people) {
      profiles.push(...part.profiles)
      for (const m of part.teamMembers)
        if (people.has(m.profile_id) && teamIds.has(m.team_id)) teamMembers.push(m)
    }
    for (const part of org.projects) {
      projects.push(...part.projects)
      for (const g of part.access) if (people.has(g.profile_id)) access.push(g)
      teamAccess.push(...part.teamAccess)
      milestones.push(...part.milestones)
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
  const inbox = blendInbox(
    orgs.map((org) => org.inbox),
    LIMITS.inboxShown.max,
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
    labels,
    issueLabels,
    issueSubs,
    attachments,
    milestones,
    orgLoad,
    messages: inbox.messages,
    readMessageCount: inbox.readMessageCount,
    unreadTruncated: inbox.unreadTruncated,
    readTruncated: inbox.readTruncated,
    ...(inbox.messagesCut ? { messagesCut: true as const } : {}),
    delivered_at: deliveredAt,
  }
}

/** The workspace as the app keeps it, every seat's organizations joined. */
export type Workspace = ReturnType<typeof joinParts>

/** The parts a server holding `workspace` would answer, for stand-ins of
 * the server (tests, the browser benchmark): `windows` gives each
 * organization's windows per kind (lib/idWindows.ts). The app never sees a
 * row's window key, so a stand-in places tasks and projects by id, which
 * the app cannot tell apart from keys the server picked. Inverse of
 * joinParts for a workspace whose sections hold no row of an organization
 * it does not list. A hidden load row names no task, so every one goes to
 * the first task window, and every seat's inbox counters go to the first
 * organization, which blendInbox adds up the same. */
export function splitWorkspace(
  workspace: Omit<Workspace, 'messagesCut'> & { messagesCut?: boolean },
  windows: (orgId: string, kind: 'tasks' | 'people' | 'projects') => readonly IdWindow[],
) {
  /** `rows` of `orgId` cut into its windows of `kind`. */
  const cut = <R extends { id: string }>(
    orgId: string,
    kind: 'tasks' | 'people' | 'projects',
    rows: readonly R[],
  ) => windows(orgId, kind).map((w) => rows.filter((row) => inIdWindow(row.id, w)))
  const orgOfProfile = new Map(workspace.profiles.map((p) => [p.id, p.org_id]))
  const orgOfTeam = new Map(workspace.teams.map((t) => [t.id, t.org_id]))
  return workspace.orgs.map((org, at) => {
    const id = org.id
    const mine = <R>(rows: readonly R[], orgOf: (row: R) => string | undefined) =>
      rows.filter((row) => orgOf(row) === id)
    const profiles = mine(workspace.profiles, (p) => p.org_id)
    const projects = mine(workspace.projects, (p) => p.org_id)
    const issues = mine(workspace.issues, (t) => t.org_id)
    const people = cut(id, 'people', profiles)
    const projectWindows = cut(id, 'projects', projects)
    const taskWindows = cut(id, 'tasks', issues)
    const owners = mine(workspace.orgLoad, (r) => orgOfProfile.get(r.owner_id))
    const messages = mine(workspace.messages, (m) => m.org_id)
    return {
      org_id: id,
      catalog: {
        teams: mine(workspace.teams, (t) => t.org_id),
        labels: mine(workspace.labels, (l) => l.org_id),
      },
      people: people.map((ps) => {
        const ids = new Set(ps.map((p) => p.id))
        return {
          profiles: ps,
          teamMembers: workspace.teamMembers.filter(
            (m) => ids.has(m.profile_id) && orgOfTeam.get(m.team_id) === id,
          ),
        }
      }),
      projects: projectWindows.map((ps) => {
        const ids = new Set(ps.map((p) => p.id))
        return {
          projects: ps,
          access: workspace.access.filter((g) => ids.has(g.project_id)),
          teamAccess: workspace.teamAccess.filter((g) => ids.has(g.project_id)),
          milestones: workspace.milestones.filter((m) => ids.has(m.project_id)),
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
  people: 'workspace:people',
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
 * every part answered: the root and every part, each window cut where
 * it answers overflow or split, as the app cuts them (lib/idWindows.ts
 * piecesAfter), joined by joinParts with the local time as delivery
 * time. Null without a seat. For tests and scripts that read the workspace
 * once rather than subscribing; its parts are read at different moments, so
 * a write meanwhile can show in some and not others.
 */
export async function readWorkspace(query: QueryByName): Promise<Workspace | null> {
  const root = (await query('workspace:root', {})) as RootAnswer
  if (root === null) return null
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
  for (const { id, next_issue_num, next_project_num } of root.orgs) {
    // as the app chooses them (src/store/liveParts.ts)
    const counts = {
      tasks: windowCount(next_issue_num, WINDOW_ROWS.tasks),
      people: 1,
      projects: windowCount(next_project_num, WINDOW_ROWS.projects),
    }
    const windows = async <P>(kind: keyof typeof WINDOWED_NAMES): Promise<P[]> => {
      const rows: unknown[] = []
      for (const w of idWindows(counts[kind])) rows.push(...(await windowRows(kind, id, w)))
      return rows as P[]
    }
    orgs.push({
      catalog: rowsOrThrow(
        'workspace:catalog',
        await query('workspace:catalog', { org_id: id }),
      ) as CatalogPart,
      people: await windows<PeoplePart>('people'),
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
