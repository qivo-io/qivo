/* A stand-in for the six reads of a project's Settings page
   (convex/projectSettings.ts: get, users, teams, candidates,
   leadCandidates and inviteTarget) that answers from a workspace the app
   holds, for the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs), as store/labelPagesStandIn.setup.ts answers
   Settings › Labels.

   It applies the reads' rules (convex/model/projectSettings.ts) to the
   workspace's rows:
   - the gate (settingsGate): whoever sees the project, navigation
     included, or manages it reads it, by the level rule of
     convex/lib/access.ts levelsFrom over the workspace's grants, team
     shares and memberships, copied here because the benchmark's worker
     cannot load that module; `unavailable` alike for an unknown project,
     one of another organization, one outside a meta tree and one the
     caller neither sees nor manages, and `archived` with names only;
   - get's fields, its parent, its effective lead and every right
     (settingsRights);
   - the Users and Teams lists: the explicit grants and team shares, the
     effective lead's own grant left out of the users and named in a first
     batch's `lead` when its name matches the search;
   - the Add team or user picker's choices, teams first and then people,
     each group in name order, leaving out what the project holds by grant
     type and the effective lead, and keeping admins, agents, guests and
     viewers; without a project the New project dialog's, every team and
     the active admins, users and viewers but the chosen lead;
   - the lead pickers' active admins, users and guests (admins and users
     for a new top-level project), with the parent checks of a new
     sub-project;
   - the invite form's lookup by the address's stored form.
   Every list is in the byte order of the name key (convex/lib/nameKey.ts),
   as Convex compares strings, with the id to break ties, the picker's
   groups marked as the server marks them; the search keeps the rows whose
   name holds every whitespace-separated fragment of it, ignoring case and
   accents; at most LIST_BATCH rows a batch, or with `through` every match
   up to and including it, stopping past four batches; and `next` and
   `stopped` as lib/namedPages.ts readBatch answers them.

   Its cursors are plain JSON of the list, the scope and the position, so
   equal positions give equal text, as the server's sealed cursors do, and
   a cursor of another list, project or search is refused with
   bad_request. It reads no read budget, so `not_ready`, a stopped batch, a
   failure, a refusal, `unavailable` and a smaller batch answer only when
   `force` asks for them. The benchmark answers a project the page's
   workspace leaves out by handing this stand-in its whole workspace while
   the parts leave the project out (its `projectsettings=unheld`).
   src/store/projectSettingsParity.test.ts compares it with the real
   queries. It imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { asciiEmail } from '../../convex/lib/email'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { canCreateProjects, projectCreationRefusal } from '../../convex/lib/projectCreators'
import { DEFAULT_REVIEW_HOURS, resolveReviewHours } from '../../convex/lib/review'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type {
  AccessListAnswer,
  CandidateRow,
  InviteTarget,
  LeadRow,
  PersonRow,
  PickerAnswer,
  ProjectSettings,
  TeamShareRow,
  UserGrantRow,
} from '../../convex/model/projectSettings'

/** The workspace rows the stand-in reads. */
export type SettingsWorkspace = Pick<
  Workspace,
  | 'myProfileIds'
  | 'orgs'
  | 'profiles'
  | 'projects'
  | 'teams'
  | 'teamMembers'
  | 'access'
  | 'teamAccess'
>

/** The reads the stand-in answers, by their function names. */
export const PROJECT_SETTINGS_READS = [
  'projectSettings:get',
  'projectSettings:users',
  'projectSettings:teams',
  'projectSettings:candidates',
  'projectSettings:leadCandidates',
  'projectSettings:inviteTarget',
] as const
export type ProjectSettingsRead = (typeof PROJECT_SETTINGS_READS)[number]

/** States the stand-in answers whatever the workspace says, as the perf
    page's `projectsettings` parameter names them:
    - `notReady`, the lists and pickers answer `not_ready`;
    - `stop`, an open batch's read stops after this many rows (at least
      one, as the server always reads its first);
    - `fail`, the reads that fail, by name without the module, such as
      'users';
    - `refused`, the pickers and the invite lookup answer `refused` with
      the write's sentence;
    - `unavailable`, every read answers `unavailable`;
    - `batch`, a smaller batch. */
export type ForcedProjectSettings = {
  notReady?: boolean
  stop?: number
  fail?: readonly string[]
  refused?: boolean
  unavailable?: boolean
  batch?: number
}

type Profile = Workspace['profiles'][number]
type Project = Workspace['projects'][number]
type Level = 'lead' | 'user' | 'viewer'
type GrantLevel = 'user' | 'viewer'

/* The sentences the server answers with, which the worker cannot import
   from its model code (convex/lib/access.ts ACCESS_NEEDS_A_PERSON and
   NO_USER_MANAGEMENT, convex/model/projects.ts LEAD_ACCESS_NEEDED,
   PARENT_NOT_TOP_LEVEL and PARENT_ARCHIVED). */
const ACCESS_NEEDS_A_PERSON = 'only people can change who has access, not agents'
const NO_USER_MANAGEMENT = 'no permission to manage users on this project'
const LEAD_ACCESS_NEEDED = 'requires lead access to this project'
const PARENT_NOT_TOP_LEVEL =
  'sub-projects live directly under a project, never under another sub-project'
const PARENT_ARCHIVED = 'the project is archived, so restore it first'
const NOT_LIST_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same project and search; start again from the first batch'

/* The marks that put the Add team or user picker's groups in one order. */
const TEAM_MARK = '0'
const PERSON_MARK = '1'

const RANK: Record<Level, number> = { viewer: 1, user: 2, lead: 3 }
const higher = (a: Level | null, b: Level | null): Level | null =>
  (a === null ? 0 : RANK[a]) >= (b === null ? 0 : RANK[b]) ? a : b

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })
const forbidden = (message: string) => new ConvexError({ code: 'forbidden', message })

/* ------------------------------------------------------------ the gate */

/** The caller's active seat in organization `orgId`, or undefined. */
const seatIn = (ws: SettingsWorkspace, orgId: string): Profile | undefined =>
  ws.profiles.find((p) => p.org_id === orgId && ws.myProfileIds.includes(p.id) && p.active)

/** The seat an orgQuery resolves, refused as the server refuses it. */
export function memberOf(ws: SettingsWorkspace, orgId: string): Profile {
  const me = seatIn(ws, orgId)
  if (!me) throw forbidden('no profile in this organization')
  return me
}

/** convex/lib/access.ts inMetaTree */
export const inMetaTree = (project: Project, root: Project) =>
  root.parent_id === undefined &&
  root.type === 'meta' &&
  (project.id === root.id || project.parent_id === root.id)

/** The top-level project whose tree holds `project`, with its parent, or
    null outside a meta tree (model/projectSettings.ts treeOf). */
export function treeOf(ws: SettingsWorkspace, project: Project) {
  if (project.parent_id === undefined)
    return inMetaTree(project, project) ? { parent: null, root: project } : null
  const parent = ws.projects.find((p) => p.id === project.parent_id)
  return parent && inMetaTree(project, parent) ? { parent, root: parent } : null
}

const canLead = (me: Pick<Profile, 'org_role'>) =>
  me.org_role === 'admin' || me.org_role === 'user' || me.org_role === 'guest'

/* convex/lib/access.ts isProjectLead */
const isLead = (me: Profile, project: Project, root: Project) =>
  canLead(me) && (project.lead_id ?? root.lead_id) === me.id

/** `me`'s own level on `project` by convex/lib/access.ts levelsFrom, from
    its grants, team shares, its lead and its parent's, without the
    navigation a sub-project gives its parent; null outside a meta tree or
    another organization. The Settings project lists' stand-in
    (projectSettingsListsStandIn.setup.ts) reads it too. */
export function levelIn(ws: SettingsWorkspace, me: Profile, project: Project): Level | null {
  const teamsOf = new Set(
    ws.teamMembers.filter((m) => m.profile_id === me.id).map((m) => m.team_id),
  )
  const teamsHere = new Set(ws.teams.filter((t) => t.org_id === me.org_id).map((t) => t.id))
  const shares = me.org_role === 'admin' || me.org_role === 'user' || me.org_role === 'viewer'
  const own = (id: string): Level | null => {
    let level: Level | null = null
    for (const a of ws.access)
      if (a.project_id === id && a.profile_id === me.id) level = higher(level, a.level)
    if (shares)
      for (const s of ws.teamAccess)
        if (s.project_id === id && teamsOf.has(s.team_id) && teamsHere.has(s.team_id))
          level = higher(level, s.level)
    return level
  }
  const tree = treeOf(ws, project)
  if (tree === null || project.org_id !== me.org_id) return null
  let level = own(project.id)
  if (me.org_role === 'admin' || isLead(me, project, tree.root)) level = 'lead'
  else if (project.id !== tree.root.id)
    level = higher(level, isLead(me, tree.root, tree.root) ? 'user' : own(tree.root.id))
  return me.org_role === 'viewer' && level !== null ? 'viewer' : level
}

/** `me`'s level on `project` by convex/lib/access.ts levelsFrom, a
    top-level project they see only through a sub-project answering Viewer
    (navigation). */
function levelOf(ws: SettingsWorkspace, me: Profile, project: Project): Level | null {
  const level = levelIn(ws, me, project)
  if (level !== null || project.parent_id !== undefined) return level
  // navigation: a sub-project the caller reaches shows its parent
  return ws.projects.some((c) => c.parent_id === project.id && levelIn(ws, me, c) !== null)
    ? 'viewer'
    : null
}

/** Whether `me` manages `project` (convex/lib/access.ts
    canManageOwnProjectAccess, the writes' managesIn). */
export function manages(ws: SettingsWorkspace, me: Profile, project: Project): boolean {
  const tree = treeOf(ws, project)
  return (
    me.active &&
    project.org_id === me.org_id &&
    tree !== null &&
    (me.org_role === 'admin' || isLead(me, project, tree.root))
  )
}

type Gate =
  | { state: 'unavailable' }
  | { state: 'archived'; project: Project; parent: Project | null }
  | {
      state: 'ok'
      project: Project
      parent: Project | null
      root: Project
      level: Level | null
      manages: boolean
    }

/** model/projectSettings.ts settingsGate for project `id`. */
function gateOf(ws: SettingsWorkspace, me: Profile, id: string): Gate {
  const project = ws.projects.find((p) => p.id === id)
  if (!project || project.org_id !== me.org_id) return { state: 'unavailable' }
  const tree = treeOf(ws, project)
  if (tree === null) return { state: 'unavailable' }
  const level = levelOf(ws, me, project)
  const managed = manages(ws, me, project)
  if (level === null && !managed) return { state: 'unavailable' }
  if (project.archived_at !== undefined) return { state: 'archived', project, parent: tree.parent }
  return { state: 'ok', project, ...tree, level, manages: managed }
}

/** model/projectSettings.ts settingsRights, outside the demo. */
function rightsOf(me: Profile, gate: Extract<Gate, { state: 'ok' }>) {
  const person = me.kind === 'person'
  const m = gate.manages
  return {
    can_edit: m,
    can_change_lead: person && m,
    can_manage_users: person && m,
    can_manage_teams: person && m,
    can_invite: m,
    can_archive: m,
    can_delete: m,
    can_create_sub_project:
      m &&
      gate.project.type === 'meta' &&
      gate.project.parent_id === undefined &&
      gate.project.archived_at === undefined,
  }
}

const personRow = (p: Profile): PersonRow => ({
  id: p.id,
  name: p.name,
  org_role: p.org_role,
  kind: p.kind,
  active: p.active,
  pending: p.kind === 'person' && !p.auth_user_id,
})

const choicesOf = (p: Profile) => ({
  levels: (p.org_role === 'viewer' ? ['viewer'] : ['user', 'viewer']) as GrantLevel[],
  can_lead: p.active && canLead(p),
})

const parentRef = (p: Project | null) =>
  p === null ? null : { id: p.id, name: p.name, key: p.key, num: p.num }

const profileIn = (ws: SettingsWorkspace, orgId: string, id: string | undefined) =>
  id === undefined ? undefined : ws.profiles.find((p) => p.id === id && p.org_id === orgId)

/* --------------------------------------------------------------- get */

/** What projectSettings.get answers for project `id`. */
export function projectSettingsGet(ws: SettingsWorkspace, args: { id: string }): ProjectSettings {
  const project = ws.projects.find((p) => p.id === args.id)
  const me = project ? seatIn(ws, project.org_id) : undefined
  if (!project || !me) return { state: 'unavailable' }
  const gate = gateOf(ws, me, project.id)
  if (gate.state === 'unavailable') return gate
  const p = gate.project
  if (gate.state === 'archived')
    return {
      state: 'archived',
      project: { id: p.id, org_id: p.org_id, key: p.key, num: p.num, name: p.name, type: p.type },
      parent: parentRef(gate.parent),
    }
  const lead = profileIn(ws, p.org_id, p.lead_id ?? gate.root.lead_id)
  return {
    state: 'ok',
    project: {
      id: p.id,
      org_id: p.org_id,
      key: p.key,
      num: p.num,
      name: p.name,
      type: p.type,
      description: p.description,
      track_delay: p.track_delay,
      review_hours: p.review_hours ?? null,
      lead_id: p.lead_id ?? null,
    },
    parent: parentRef(gate.parent),
    inherited_review_hours:
      gate.parent === null
        ? DEFAULT_REVIEW_HOURS
        : resolveReviewHours(undefined, gate.parent.review_hours),
    lead: lead ? { ...personRow(lead), inherited: p.lead_id === undefined } : null,
    level: gate.level,
    ...rightsOf(me, gate),
  }
}

/* ------------------------------------------------------------ the batches */

/* A place in a list: a name key and the id that breaks ties. */
type At = { key: string; id: string }
const compare = (a: At, b: At) => compareValues([a.key, a.id], [b.key, b.id])

type ListArgs = { search?: string; after?: string; through?: string }

/** The search and cursors of `args` checked for list `list` with
    `scope`, as model/projectSettings.ts listAsk checks them. */
function askOf(list: string, scope: readonly string[], args: ListArgs) {
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const sealed = [...scope, nameKey(search)]
  const open = (text: string | undefined): At | null => {
    if (text === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const [name, of, key, id] = Array.isArray(parsed) ? parsed : []
    if (
      name !== list ||
      JSON.stringify(of) !== JSON.stringify(sealed) ||
      typeof key !== 'string' ||
      typeof id !== 'string'
    )
      throw badRequest(NOT_LIST_CURSOR)
    return { key, id }
  }
  const after = open(args.after)
  const through = open(args.through)
  if (after !== null && through !== null && compare(through, after) <= 0)
    throw badRequest('through must be a cursor after the one in after')
  return {
    search,
    after,
    through,
    seal: (at: At) => JSON.stringify([list, sealed, at.key, at.id]),
  }
}

/** One batch of `items`, each at its place, after `ask.after`, keeping
    what `keep` answers, as lib/namedPages.ts listBatch reads one. */
function batchOf<I, Out>(
  items: readonly { at: At; item: I }[],
  ask: ReturnType<typeof askOf>,
  keep: (item: I) => Out | null,
  force: ForcedProjectSettings,
): { rows: Out[]; next: string | null; stopped: boolean } {
  const size = force.batch ?? LIST_BATCH
  const limit = ask.through === null ? size : 4 * size
  const sorted = [...items].sort((a, b) => compare(a.at, b.at))
  const rows: Out[] = []
  let at: At | null = null
  let read = 0
  const answer = (next: At | null, stopped: boolean) => ({
    rows,
    next: next === null ? null : ask.seal(next),
    stopped,
  })
  for (const { at: place, item } of sorted) {
    if (ask.after !== null && compare(place, ask.after) <= 0) continue
    if (ask.through !== null && compare(place, ask.through) > 0) return answer(ask.through, false)
    if (rows.length >= limit && at !== null) {
      const short = ask.through !== null && compare(at, ask.through) < 0
      return answer(at, short)
    }
    if (force.stop !== undefined && ask.through === null && read >= Math.max(1, force.stop) && at)
      return answer(at, rows.length < limit)
    read++
    at = place
    const kept = keep(item)
    if (kept !== null) rows.push(kept)
  }
  return answer(null, false)
}

/** The project of a list's or picker's arguments behind the gate, or the
    answer of a gate that turns it away. */
function gated(ws: SettingsWorkspace, me: Profile, id: string, force: ForcedProjectSettings) {
  if (force.unavailable) return { answer: { state: 'unavailable' as const } }
  const gate = gateOf(ws, me, id)
  if (gate.state !== 'ok') return { answer: { state: gate.state } }
  return { gate }
}

/** What projectSettings.users answers. */
export function projectUsersStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string; project_id: string },
  force: ForcedProjectSettings = {},
): AccessListAnswer<UserGrantRow> & { lead?: LeadRow | null } {
  const me = memberOf(ws, args.org_id)
  const ask = askOf('projectSettings.users', [args.project_id], args)
  const { gate, answer } = gated(ws, me, args.project_id, force)
  if (!gate) return answer
  if (force.notReady) return { state: 'not_ready' }
  const project = gate.project
  const leadId = project.lead_id ?? gate.root.lead_id
  const matches = allWordsMatcher(nameKey(ask.search))
  const items = ws.access.flatMap((grant) => {
    if (grant.project_id !== project.id) return []
    const person = profileIn(ws, project.org_id, grant.profile_id)
    return person
      ? [{ at: { key: nameKey(person.name), id: person.id }, item: { grant, person } }]
      : []
  })
  const batch = batchOf(
    items,
    ask,
    ({ grant, person }) =>
      person.id === leadId || !matches(nameKey(person.name))
        ? null
        : { ...personRow(person), level: grant.level, ...choicesOf(person) },
    force,
  )
  if (ask.after !== null) return { state: 'ready', ...batch }
  const lead = profileIn(ws, project.org_id, leadId)
  const shown = lead !== undefined && matches(nameKey(lead.name))
  return {
    state: 'ready',
    ...batch,
    lead: shown ? { ...personRow(lead), inherited: project.lead_id === undefined } : null,
  }
}

/** What projectSettings.teams answers. */
export function projectTeamsStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string; project_id: string },
  force: ForcedProjectSettings = {},
): AccessListAnswer<TeamShareRow> {
  const me = memberOf(ws, args.org_id)
  const ask = askOf('projectSettings.teams', [args.project_id], args)
  const { gate, answer } = gated(ws, me, args.project_id, force)
  if (!gate) return answer
  if (force.notReady) return { state: 'not_ready' }
  const project = gate.project
  const matches = allWordsMatcher(nameKey(ask.search))
  const items = ws.teamAccess.flatMap((share) => {
    if (share.project_id !== project.id) return []
    const team = ws.teams.find((t) => t.id === share.team_id && t.org_id === project.org_id)
    return team ? [{ at: { key: nameKey(team.name), id: team.id }, item: { share, team } }] : []
  })
  return {
    state: 'ready',
    ...batchOf(
      items,
      ask,
      ({ share, team }) =>
        matches(nameKey(team.name)) ? { id: team.id, name: team.name, level: share.level } : null,
      force,
    ),
  }
}

const refused = (message: string) => ({ state: 'refused' as const, message })

/** What projectSettings.candidates answers. */
export function candidatesStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string; project_id?: string; lead_id?: string },
  force: ForcedProjectSettings = {},
): PickerAnswer<CandidateRow> {
  const me = memberOf(ws, args.org_id)
  if (args.project_id !== undefined && args.lead_id !== undefined)
    throw badRequest('lead_id names the lead of a new project, so leave it out with project_id')
  const ask = askOf(
    'projectSettings.candidates',
    [me.org_id, args.project_id ?? '', args.lead_id ?? ''],
    args,
  )
  let project: Project | null = null
  let teams = true
  let without = args.lead_id
  if (args.project_id !== undefined) {
    const { gate, answer } = gated(ws, me, args.project_id, force)
    if (!gate) return answer
    const rights = rightsOf(me, gate)
    if (me.kind !== 'person') return refused(ACCESS_NEEDS_A_PERSON)
    if (!rights.can_manage_users || force.refused) return refused(NO_USER_MANAGEMENT)
    project = gate.project
    teams = rights.can_manage_teams
    without = gate.project.lead_id ?? gate.root.lead_id
  } else {
    const org = ws.orgs.find((o) => o.id === me.org_id)
    if (!canCreateProjects(me, org?.project_creators) || force.refused)
      return refused(projectCreationRefusal(org?.project_creators))
    if (me.kind !== 'person') return refused(ACCESS_NEEDS_A_PERSON)
  }
  if (force.notReady) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const held = (id: string, kind: 'team' | 'user') =>
    project !== null &&
    (kind === 'team'
      ? ws.teamAccess.some((s) => s.project_id === project?.id && s.team_id === id)
      : ws.access.some((a) => a.project_id === project?.id && a.profile_id === id))
  type Item = { kind: 'team'; team: Workspace['teams'][number] } | { kind: 'user'; person: Profile }
  const items: { at: At; item: Item }[] = [
    ...(teams
      ? ws.teams
          .filter((t) => t.org_id === me.org_id)
          .map((team) => ({
            at: { key: TEAM_MARK + nameKey(team.name), id: team.id },
            item: { kind: 'team' as const, team },
          }))
      : []),
    ...ws.profiles
      .filter(
        (p) =>
          p.org_id === me.org_id &&
          (project !== null ||
            p.org_role === 'admin' ||
            p.org_role === 'user' ||
            p.org_role === 'viewer'),
      )
      .map((person) => ({
        at: { key: PERSON_MARK + nameKey(person.name), id: person.id },
        item: { kind: 'user' as const, person },
      })),
  ]
  return {
    state: 'ready',
    ...batchOf(
      items,
      ask,
      (item): CandidateRow | null => {
        if (item.kind === 'team')
          return held(item.team.id, 'team') || !matches(nameKey(item.team.name))
            ? null
            : { type: 'team', id: item.team.id, name: item.team.name }
        const p = item.person
        if (held(p.id, 'user') || !p.active || p.id === without || !matches(nameKey(p.name)))
          return null
        return { type: 'user', ...personRow(p), ...choicesOf(p) }
      },
      force,
    ),
  }
}

/** What projectSettings.leadCandidates answers. */
export function leadCandidatesStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string; project_id?: string; parent_id?: string },
  force: ForcedProjectSettings = {},
): PickerAnswer<PersonRow> {
  const me = memberOf(ws, args.org_id)
  if (args.project_id !== undefined && args.parent_id !== undefined)
    throw badRequest('name project_id or parent_id, not both')
  const target =
    args.project_id !== undefined
      ? ['project', args.project_id]
      : args.parent_id !== undefined
        ? ['parent', args.parent_id]
        : ['organization', '']
  const ask = askOf('projectSettings.leadCandidates', [me.org_id, ...target], args)
  let roles: readonly string[] = ['admin', 'user', 'guest']
  if (args.project_id !== undefined) {
    const { gate, answer } = gated(ws, me, args.project_id, force)
    if (!gate) return answer
    if (me.kind !== 'person') return refused(ACCESS_NEEDS_A_PERSON)
    if (!rightsOf(me, gate).can_change_lead || force.refused)
      return refused(gate.project.type === 'meta' ? NO_USER_MANAGEMENT : LEAD_ACCESS_NEEDED)
  } else if (args.parent_id !== undefined) {
    if (force.unavailable) return { state: 'unavailable' }
    const parent = ws.projects.find((p) => p.id === args.parent_id)
    const level =
      parent && parent.org_id === me.org_id && treeOf(ws, parent) !== null
        ? levelOf(ws, me, parent)
        : null
    if (!parent || level === null) return { state: 'unavailable' }
    if (parent.type !== 'meta') return refused(PARENT_NOT_TOP_LEVEL)
    if (parent.archived_at !== undefined) return refused(PARENT_ARCHIVED)
    if (level !== 'lead' || force.refused) return refused(LEAD_ACCESS_NEEDED)
    if (me.kind !== 'person') return refused(ACCESS_NEEDS_A_PERSON)
  } else {
    const org = ws.orgs.find((o) => o.id === me.org_id)
    if (!canCreateProjects(me, org?.project_creators) || force.refused)
      return refused(projectCreationRefusal(org?.project_creators))
    if (me.kind !== 'person') return refused(ACCESS_NEEDS_A_PERSON)
    roles = ['admin', 'user']
  }
  if (force.notReady) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const items = ws.profiles
    .filter((p) => p.org_id === me.org_id && roles.includes(p.org_role))
    .map((person) => ({ at: { key: nameKey(person.name), id: person.id }, item: person }))
  return {
    state: 'ready',
    ...batchOf(
      items,
      ask,
      (p) => (p.active && matches(nameKey(p.name)) ? personRow(p) : null),
      force,
    ),
  }
}

/** What projectSettings.inviteTarget answers. */
export function inviteTargetStandIn(
  ws: SettingsWorkspace,
  args: { org_id: string; project_id: string; email: string },
  force: ForcedProjectSettings = {},
): InviteTarget {
  const me = memberOf(ws, args.org_id)
  const typed = args.email.trim()
  if (overText(LIMITS.email, typed))
    throw new ConvexError({ code: 'rule', message: LIMITS.email.refusal })
  const email = asciiEmail(typed)
  const { gate, answer } = gated(ws, me, args.project_id, force)
  if (!gate) return answer
  if (!rightsOf(me, gate).can_invite || force.refused) return refused(NO_USER_MANAGEMENT)
  const seat = ws.profiles.find((p) => p.org_id === me.org_id && p.email === email)
  if (!seat) return { state: 'ready', person: null, level: null }
  const grant = ws.access.find((a) => a.project_id === gate.project.id && a.profile_id === seat.id)
  return { state: 'ready', person: personRow(seat), level: grant?.level ?? null }
}

/**
 * What read `name` (such as 'projectSettings:users') answers for `args`
 * while the server holds `ws`, read by the caller the workspace belongs
 * to. Throws as the server refuses, and for a read `force.fail` names.
 */
export function projectSettingsStandIn(
  ws: SettingsWorkspace,
  name: string,
  args: Record<string, unknown>,
  force: ForcedProjectSettings = {},
): unknown {
  const short = name.slice('projectSettings:'.length)
  if (force.fail?.includes(short)) throw new Error(`${name} fails, as the stand-in was asked`)
  // the arguments as the query's validators take them
  const a = args as never
  switch (name) {
    case 'projectSettings:get':
      return force.unavailable ? { state: 'unavailable' } : projectSettingsGet(ws, a)
    case 'projectSettings:users':
      return projectUsersStandIn(ws, a, force)
    case 'projectSettings:teams':
      return projectTeamsStandIn(ws, a, force)
    case 'projectSettings:candidates':
      return candidatesStandIn(ws, a, force)
    case 'projectSettings:leadCandidates':
      return leadCandidatesStandIn(ws, a, force)
    case 'projectSettings:inviteTarget':
      return inviteTargetStandIn(ws, a, force)
    default:
      throw new Error(`the project settings stand-in does not answer ${name}`)
  }
}

/** Whether `name` is one of the reads the stand-in answers. */
export const isProjectSettingsRead = (name: string): name is ProjectSettingsRead =>
  (PROJECT_SETTINGS_READS as readonly string[]).includes(name)

/**
 * A server double for the jsdom tests: the project settings reads over the
 * workspace `server()` answers, with the states `force()` asks for. A test's
 * network double hands it each live read it is asked for (`watch`, which
 * answers at once and keeps the read open until stopped) and each one-shot
 * read (`query`), and calls `rerun` whenever the server's workspace or the
 * forced states change, as Convex reruns a query whose reads changed.
 * `open` lists the live reads open now, by name and arguments.
 */
export function projectSettingsServer(
  server: () => SettingsWorkspace,
  force: () => ForcedProjectSettings = () => ({}),
) {
  return readsServer((name, args) => projectSettingsStandIn(server(), name, args, force()))
}

/**
 * A server double for the jsdom tests over a stand-in that answers read
 * `name` for `args` (`answer`, which throws as the server refuses), as
 * projectSettingsServer and the Settings project lists'
 * (projectSettingsListsStandIn.setup.ts projectListsServer) use it.
 */
export function readsServer(answerOf: (name: string, args: Record<string, unknown>) => unknown) {
  type Read = {
    name: string
    args: Record<string, unknown>
    next: (value: unknown) => void
    fail?: (error: unknown) => void
  }
  const reads = new Set<Read>()
  let held = false
  const answer = (read: Read) => {
    let value: unknown
    try {
      value = answerOf(read.name, read.args)
    } catch (error) {
      read.fail?.(error)
      return
    }
    read.next(structuredClone(value))
  }
  return {
    watch(
      name: string,
      args: Record<string, unknown>,
      next: (value: unknown) => void,
      fail?: (error: unknown) => void,
    ): () => void {
      const read: Read = { name, args, next, fail }
      reads.add(read)
      if (!held) answer(read)
      return () => reads.delete(read)
    },
    async query(name: string, args: Record<string, unknown>): Promise<unknown> {
      return structuredClone(answerOf(name, args))
    },
    /** Answers every open read again, as Convex reruns them. */
    rerun() {
      for (const read of reads) answer(read)
    },
    /** Holds back the first answer of every read opened from now on, until
        `rerun`, or with false answers them as they open again. */
    hold(on: boolean) {
      held = on
    },
    open: () => [...reads].map((r) => ({ name: r.name, args: r.args })),
  }
}
