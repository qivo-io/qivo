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
 * projectNav.byIds and the views' own answers (convex/projectNav.ts). */

import { shownAvatarColor } from './avatarColors.ts'
import type { readRoot } from './workspaceParts.ts'

/** What the root part answers (lib/workspaceParts.ts readRoot), the type
 * taken from the reader rather than from `api`, which lists this module. */
export type RootAnswer = Awaited<ReturnType<typeof readRoot>>
/** The root part's answer for a login with no seat it can open, because a
 * running organization deletion holds its seats (`deleting`) or an
 * organization deactivated it, with when it may create an organization. */
export type Seatless = Extract<RootAnswer, { deleting: boolean }>
/** The root part's answer for a caller with a seat. */
export type RootSeats = Exclude<RootAnswer, null | Seatless>

/** The organizations of the root part's answer, none without a seat. */
export const rootOrgs = (root: RootAnswer): RootSeats['orgs'] =>
  root === null || 'deleting' in root ? [] : root.orgs
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
