/* A stand-in for the four reads of Settings › Teams and a team's page
   (convex/teams.ts settingsPage, get, members and addable) that answers
   from a workspace the app holds, for the jsdom tests and the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/projectSettingsStandIn.setup.ts answers a project's Settings page.

   It applies the reads' rules (convex/model/teams.ts) to the workspace's
   rows:
   - settingsPage: every team of the organization for an active admin, the
     teams whose membership row of the caller's own leads them for anyone
     else who may lead teams (an admin or user who is a person), `refused`
     for the rest; each team with its member count by team_counts' rule,
     the memberships whose profile is in the team's organization and not a
     guest; and `teams`, the organization's teams up to three;
   - get: the team of the caller's organization with its count and the
     rights of its writes, `can_manage` for an admin or a leader who may
     lead and `can_manage_members` for a person among them, `unavailable`
     alike for an unknown team and one of another organization;
   - members: the members the server lists, with role, leadership as
     stored, whether they may lead and their plannable hours;
   - addable: the organization's admins, users and viewers who are not
     members, switched-off and invited people included, `refused` for an
     agent and for a caller who neither administers nor leads the team.
   Every list is in the byte order of the name key (convex/lib/nameKey.ts),
   as Convex compares strings, with the id to break ties; a member sorts by
   their current name, since the workspace holds no copy; the search keeps
   the rows whose name holds every whitespace-separated fragment of it,
   ignoring case and accents; at most LIST_BATCH rows a batch, or with
   `through` every match up to and including it, stopping past four
   batches; and `next` and `stopped` as lib/namedPages.ts readBatch answers
   them.

   Its cursors are plain JSON of the list, the scope and the position, so
   equal positions give equal text, as the server's sealed cursors do, and
   a cursor of another list, caller, team or search is refused with
   bad_request. It reads no read budget, so `not_ready`, a stopped batch, a
   failure, a refusal, `unavailable`, a smaller batch and counts the server
   does not have answer only when `force` asks for them.
   src/store/teamSettingsParity.test.ts compares it with the real queries.
   It imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { PersonRow } from '../../convex/model/projectSettings'
import type {
  SettingsTeamsAnswer,
  TeamChoicesAnswer,
  TeamMemberRow,
  TeamMembersAnswer,
  TeamSettingsAnswer,
  TeamSummaryJson,
} from '../../convex/model/teams'
import { readsServer } from './projectSettingsStandIn.setup'

/** The workspace rows the stand-in reads. */
export type TeamSettingsWorkspace = Pick<
  Workspace,
  'myProfileIds' | 'profiles' | 'teams' | 'teamMembers'
>

/** The reads the stand-in answers, by their function names. */
export const TEAM_SETTINGS_READS = [
  'teams:settingsPage',
  'teams:get',
  'teams:members',
  'teams:addable',
] as const
export type TeamSettingsRead = (typeof TEAM_SETTINGS_READS)[number]

/** Whether `name` is one of the reads the stand-in answers. */
export const isTeamSettingsRead = (name: string): name is TeamSettingsRead =>
  (TEAM_SETTINGS_READS as readonly string[]).includes(name)

/** States the stand-in answers whatever the workspace says, as the perf
    page's `teamsettings` parameter names them:
    - `notReady`, the three lists answer `not_ready`;
    - `stop`, an open batch's read stops after this many rows looked at
      (at least one, as the server always reads its first);
    - `fail`, the reads that fail, by name without the module, such as
      'members';
    - `refused`, settingsPage and addable answer `refused` with their
      sentences;
    - `unavailable`, get, members and addable answer `unavailable`;
    - `batch`, a smaller batch;
    - `counts`, member counts by team id, a number or null for a team the
      server has not counted. */
export type ForcedTeamSettings = {
  notReady?: boolean
  stop?: number
  fail?: readonly string[]
  refused?: boolean
  unavailable?: boolean
  batch?: number
  counts?: Readonly<Record<string, number | null>>
}

type Profile = Workspace['profiles'][number]
type Team = Workspace['teams'][number]

/* The sentences the server answers with, which the worker cannot import
   from its model code (convex/model/teams.ts TEAM_LIST_REFUSAL,
   TEAM_RUNS_RULE and NOT_TEAM_CURSOR, convex/lib/access.ts
   ACCESS_NEEDS_A_PERSON). */
const TEAM_LIST_REFUSAL = 'only organization admins and team leaders can open the team settings'
const TEAM_RUNS_RULE = 'requires an organization admin or a leader of this team'
const ACCESS_NEEDS_A_PERSON = 'only people can change who has access, not agents'
const NOT_TEAM_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same arguments and search; start again from the first batch'

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })

/** The caller's active seat in organization `orgId`, refused as an
    orgQuery refuses a caller without one. */
function seatIn(ws: TeamSettingsWorkspace, orgId: string): Profile {
  const me = ws.profiles.find(
    (p) => p.org_id === orgId && ws.myProfileIds.includes(p.id) && p.active,
  )
  if (!me) throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  return me
}

/* convex/lib/access.ts canLeadTeams */
const canLead = (p: Profile) =>
  (p.org_role === 'admin' || p.org_role === 'user') && p.kind === 'person'

/* A place in a list, just after the row with this key and id. */
type Position = { key: string; id: string }

const compare = (a: Position, b: Position) => compareValues([a.key, a.id], [b.key, b.id])

/** One batch of `items`, each with its position, after `after` and up to
    `through`, keeping what `keep` answers, as lib/namedPages.ts listBatch
    reads one; `seal` writes a cursor. */
function batchOf<Item, Row>(
  items: readonly { at: Position; item: Item }[],
  o: {
    after: Position | null
    through: Position | null
    keep: (item: Item) => Row | null
    seal: (at: Position) => string
    size: number
    stop: number | undefined
  },
) {
  const limit = o.through === null ? o.size : 4 * o.size
  const rows: Row[] = []
  let at: Position | null = o.after
  let read = 0
  const answer = (next: Position | null, stopped: boolean) => ({
    rows,
    next: next === null ? null : o.seal(next),
    stopped,
  })
  for (const { at: position, item } of items) {
    if (o.after !== null && compare(position, o.after) <= 0) continue
    // a batch kept live between two cursors ends at its own
    if (o.through !== null && compare(position, o.through) > 0) return answer(o.through, false)
    // a full batch reads one row more, so a batch that ends with the list
    // says so; past four batches a pinned one stops short of its end
    if (rows.length >= limit && at !== null)
      return answer(at, o.through !== null && compare(at, o.through) < 0)
    if (o.stop !== undefined && o.through === null && read >= Math.max(1, o.stop) && at)
      return answer(at, true)
    read++
    at = position
    const row = o.keep(item)
    if (row !== null) rows.push(row)
  }
  return answer(null, false)
}

/**
 * What read `name` answers for `args` while the server holds `ws`, read by
 * the caller the workspace belongs to. Throws as the server refuses: no
 * active seat in the organization, a search past LIMITS.search, a cursor
 * this list did not give for the same scope and search, and a read `force`
 * fails. A list checks its search and cursors where the server does, so
 * settingsPage answers a seat it refuses `refused` whatever the search.
 */
export function teamSettingsStandIn(
  ws: TeamSettingsWorkspace,
  name: string,
  args: Record<string, unknown>,
  force: ForcedTeamSettings = {},
): unknown {
  const org = String(args.org_id ?? '')
  const me = seatIn(ws, org)
  const short = name.replace(/^teams:/, '')
  if (force.fail?.includes(short)) throw new Error(`${name} fails, as the stand-in was asked`)
  const search = String(args.search ?? '').trim()
  const admin = me.org_role === 'admin'
  const teamsHere = ws.teams.filter((t) => t.org_id === org)
  const people = new Map(ws.profiles.filter((p) => p.org_id === org).map((p) => [p.id, p]))
  const membersOf = (teamId: string) => ws.teamMembers.filter((m) => m.team_id === teamId)
  const membership = (teamId: string, profileId: string) =>
    ws.teamMembers.find((m) => m.team_id === teamId && m.profile_id === profileId)
  const leads = (teamId: string) => canLead(me) && membership(teamId, me.id)?.is_leader === true
  // team_counts' rule: memberships whose profile is in the team's
  // organization and is not a guest
  const count = (team: Team): number | null =>
    force.counts && team.id in force.counts
      ? (force.counts[team.id] ?? null)
      : membersOf(team.id).filter((m) => {
          const p = people.get(m.profile_id)
          return p !== undefined && p.org_role !== 'guest'
        }).length
  const matches = allWordsMatcher(nameKey(search))
  // a list's arguments, checked where the server checks them
  // (model/projectSettings.ts orderedListAsk): the search, then the cursors
  const open = (list: string, scope: readonly string[]) => {
    if (overText(LIMITS.search, search))
      throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
    const sealed = [...scope, nameKey(search)]
    const at = (text: unknown): Position | null => {
      if (text === undefined) return null
      let parsed: unknown
      try {
        parsed = JSON.parse(String(text))
      } catch {
        parsed = null
      }
      const [of, from, position] = Array.isArray(parsed) ? parsed : []
      const [key, id] = Array.isArray(position) ? position : []
      if (
        of !== list ||
        JSON.stringify(from) !== JSON.stringify(sealed) ||
        typeof key !== 'string' ||
        typeof id !== 'string'
      )
        throw badRequest(NOT_TEAM_CURSOR)
      return { key, id }
    }
    const after = at(args.after)
    const through = at(args.through)
    if (after !== null && through !== null && compare(through, after) <= 0)
      throw badRequest('through must be a cursor after the one in after')
    return {
      after,
      through,
      seal: (p: Position) => JSON.stringify([list, sealed, [p.key, p.id]]),
      size: force.batch ?? LIST_BATCH,
      stop: force.stop,
    }
  }
  const team = teamsHere.find((t) => t.id === args.team_id || t.id === args.id)
  const placed = <T extends { id: string; name: string }>(rows: readonly T[]) =>
    rows
      .map((item) => ({ at: { key: nameKey(item.name), id: item.id }, item }))
      .sort((a, b) => compare(a.at, b.at))

  if (name === 'teams:settingsPage') {
    if (force.refused || (!admin && !canLead(me)))
      return { state: 'refused', message: TEAM_LIST_REFUSAL } satisfies SettingsTeamsAnswer
    const ask = open('teams.settings', [org, me.id])
    if (force.notReady) return { state: 'not_ready' } satisfies SettingsTeamsAnswer
    const batch = batchOf(placed(teamsHere), {
      ...ask,
      keep: (t): TeamSummaryJson | null =>
        matches(nameKey(t.name)) && (admin || leads(t.id))
          ? { id: t.id, name: t.name, member_count: count(t) }
          : null,
    })
    return {
      state: 'ready',
      teams: Math.min(teamsHere.length, 3),
      ...batch,
    } satisfies SettingsTeamsAnswer
  }
  if (name === 'teams:get') {
    if (!team || force.unavailable) return { state: 'unavailable' } satisfies TeamSettingsAnswer
    const can_manage = admin || leads(team.id)
    return {
      state: 'ok',
      team: { id: team.id, name: team.name },
      member_count: count(team),
      can_manage,
      can_manage_members: can_manage && me.kind === 'person',
    } satisfies TeamSettingsAnswer
  }
  const person = (p: Profile): PersonRow => ({
    id: p.id,
    name: p.name,
    org_role: p.org_role,
    kind: p.kind,
    active: p.active,
    pending: p.kind === 'person' && !p.auth_user_id,
  })
  if (name === 'teams:members') {
    const ask = open('teams.members', [org, String(args.team_id ?? '')])
    if (!team || force.unavailable) return { state: 'unavailable' } satisfies TeamMembersAnswer
    if (force.notReady) return { state: 'not_ready' } satisfies TeamMembersAnswer
    const listed = membersOf(team.id).flatMap((m) => {
      const p = people.get(m.profile_id)
      return p === undefined || p.org_role === 'guest'
        ? []
        : [{ id: p.id, name: p.name, profile: p, leader: m.is_leader }]
    })
    const batch = batchOf(placed(listed), {
      ...ask,
      keep: (m): TeamMemberRow | null =>
        matches(nameKey(m.name))
          ? {
              ...person(m.profile),
              is_leader: m.leader,
              can_lead: canLead(m.profile),
              plannable_hours: m.profile.plannable_hours ?? null,
            }
          : null,
    })
    return { state: 'ready', ...batch } satisfies TeamMembersAnswer
  }
  if (name === 'teams:addable') {
    const ask = open('teams.addable', [org, String(args.team_id ?? '')])
    if (!team || force.unavailable) return { state: 'unavailable' } satisfies TeamChoicesAnswer
    if (me.kind !== 'person')
      return { state: 'refused', message: ACCESS_NEEDS_A_PERSON } satisfies TeamChoicesAnswer
    if (force.refused || (!admin && !leads(team.id)))
      return { state: 'refused', message: TEAM_RUNS_RULE } satisfies TeamChoicesAnswer
    if (force.notReady) return { state: 'not_ready' } satisfies TeamChoicesAnswer
    const choices = [...people.values()].filter((p) => p.org_role !== 'guest')
    const batch = batchOf(placed(choices), {
      ...ask,
      keep: (p): PersonRow | null =>
        matches(nameKey(p.name)) && !membership(team.id, p.id) ? person(p) : null,
    })
    return { state: 'ready', ...batch } satisfies TeamChoicesAnswer
  }
  throw new Error(`the team settings stand-in does not answer ${name}`)
}

/**
 * A server double for the jsdom tests: the team settings reads over the
 * workspace `server()` answers, with the states `force()` asks for, through
 * projectSettingsStandIn.setup.ts readsServer (`watch` for the live reads,
 * `query` for the picker's, `rerun` as Convex reruns them).
 */
export function teamSettingsServer(
  server: () => TeamSettingsWorkspace,
  force: () => ForcedTeamSettings = () => ({}),
) {
  return readsServer((name, args) => teamSettingsStandIn(server(), name, args, force()))
}
