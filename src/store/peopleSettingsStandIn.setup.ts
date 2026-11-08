/* A stand-in for the reads of Settings › Users and Organization › General's
   creators line (convex/people.ts settingsPage, get and byIds,
   convex/tokens.ts agentKeys, convex/orgs.ts projectCreators and
   convex/invites.ts deliveries with profile_ids) that answers from a
   workspace the app holds, for the jsdom tests and the browser benchmark's
   server (scripts/perf/server.mjs), as store/teamSettingsStandIn.setup.ts
   answers the team pages.

   It applies the reads' rules (convex/model/peopleSettings.ts) to the
   workspace's rows:
   - settingsPage: refused for anyone but an active admin; the people and
     agents (admin, user and viewer) marked '0' before the guests marked
     '1', each group in the byte order of the name key as Convex compares
     strings, the id breaking ties; the search keeps a person when every
     whitespace-separated word of it is in the name key or the address's;
     at most LIST_BATCH rows a page, or with `through` every match up to
     and including it, stopping past four pages; `next` and `stopped` as
     lib/namedPages.ts readBatch answers them; `admins`, the active admins
     up to two; a guest's first GUEST_PROJECTS.shown projects, their leads
     and then their grants, each by creation (a grant at its project's),
     live and of the organization, each once, with `more`;
   - get: the person, `unavailable` alike for an unknown id and another
     organization's;
   - byIds: the person rows with color, initials, picture, sample portrait
     and stored hours of the organization's profiles among the ids, for any
     active seat, at most BY_IDS_MAX ids, or the state `force.byIds` asks
     for (every read failing, answering late or leaving every id out);
   - agentKeys: refused for anyone but an admin, for no ids and past
     LIST_BATCH; each agent of the organization among the ids with its
     keys newest first by created_at, the id breaking ties, at most
     AGENT_KEYS.most and `more`; the keys come from `extra.keys`, since
     the workspace holds none;
   - projectCreators: refused for anyone but an admin; the admins and then
     the standard users in name key order who may create projects under
     the organization's setting, active ones only, two named and up to 100
     counted, `more` past them;
   - invites:deliveries: the rows of `extra.deliveries` of the
     organization's seats that are still invitations among profile_ids, in
     their order, for an admin, at most BY_IDS_MAX ids.

   Its cursors are plain JSON of the list, the scope and the position, so
   equal positions give equal text, as the server's sealed cursors do, and
   a cursor of another list, organization or search is refused with
   bad_request. It reads no read budget, so `not_ready`, a stopped page, a
   failure, a smaller page, a count of admins, keys that fail or hit their
   bound and a creators line the server could not count answer only when
   `force` asks for them. src/store/peopleSettingsParity.test.ts compares
   it with the real queries. It imports nothing the benchmark's worker
   cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import type { InviteDeliveryRow } from '../../convex/invites'
import { BY_IDS_MAX, LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { canCreateProjects } from '../../convex/lib/projectCreators'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type {
  CreatorRow,
  GuestProject,
  PeoplePageAnswer,
  PersonFaceRow,
  PersonSettingsAnswer,
  ProjectCreatorsAnswer,
  SettingsPersonRow,
} from '../../convex/model/peopleSettings'
import type { AgentKeysRow } from '../../convex/tokens'
import { readsServer } from './projectSettingsStandIn.setup'

/** The workspace rows the stand-in reads. */
export type PeopleSettingsWorkspace = Pick<
  Workspace,
  'myProfileIds' | 'profiles' | 'projects' | 'access' | 'orgs'
>

/** One agent key as the server lists it, with its agent. */
export type StandInKey = AgentKeysRow['keys'][number]

/** What the workspace does not hold, the agents' keys and the invitation
    rows invites.deliveries would report. */
export type PeopleSettingsExtra = {
  keys?: readonly StandInKey[]
  deliveries?: readonly InviteDeliveryRow[]
}

/** The reads the stand-in answers, by their function names. */
export const PEOPLE_SETTINGS_READS = [
  'people:settingsPage',
  'people:get',
  'people:byIds',
  'tokens:agentKeys',
  'orgs:projectCreators',
  'invites:deliveries',
] as const
export type PeopleSettingsRead = (typeof PEOPLE_SETTINGS_READS)[number]

/** Whether `name` is one of the reads the stand-in answers. */
export const isPeopleSettingsRead = (name: string): name is PeopleSettingsRead =>
  (PEOPLE_SETTINGS_READS as readonly string[]).includes(name)

/** States the stand-in answers whatever the workspace says, as the perf
    page's `userspage`, `agentkeys` and `creators` parameters name them:
    - `notReady`, settingsPage answers `not_ready`;
    - `stop`, a page's read stops after this many rows looked at (at least
      one, as the server always reads its first);
    - `fail`, the reads that fail, by name without the module, such as
      'settingsPage' or 'agentKeys';
    - `batch`, a smaller page;
    - `admins`, the count of active admins settingsPage and get answer;
    - `keysMost`, the bound on one agent's keys (AGENT_KEYS.most);
    - `creatorsUnavailable`, projectCreators answers `unavailable`;
    - `guestShown`, the bound on a guest's projects (GUEST_PROJECTS.shown);
    - `byIds`, what people.byIds answers whatever the workspace holds, as
      the perf page's `peoplebyids` names it: `error`, every read fails, or
      `gone`, every asked id is left out, as for people the organization
      does not hold. The page's `byids-slow`, an answer after two seconds,
      is the transport's (scripts/perf/server.mjs). */
export type ForcedPeopleSettings = {
  notReady?: boolean
  stop?: number
  fail?: readonly string[]
  batch?: number
  admins?: number
  keysMost?: number
  creatorsUnavailable?: boolean
  guestShown?: number
  byIds?: 'error' | 'gone'
}

type Profile = Workspace['profiles'][number]

/* The sentences the server answers with, which the worker cannot import
   from its model code (convex/model/peopleSettings.ts). */
const PEOPLE_ADMINS_ONLY = 'only organization admins manage users'
const CREATORS_ADMINS_ONLY = 'only organization admins see who can create projects'
const NOT_PEOPLE_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same search; start again from the first page'
const LIST = 'people.settings'
const PEOPLE_MARK = '0'
const GUEST_MARK = '1'

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })
const forbidden = (message: string) => new ConvexError({ code: 'forbidden', message })

/** The caller's active seat in organization `orgId`, refused as an
    orgQuery refuses a caller without one. */
function seatIn(ws: PeopleSettingsWorkspace, orgId: string): Profile {
  const me = ws.profiles.find(
    (p) => p.org_id === orgId && ws.myProfileIds.includes(p.id) && p.active,
  )
  if (!me) throw forbidden('no profile in this organization')
  return me
}

/* A place in the list, just after the row with this key and id. */
type Position = { key: string; id: string }

const compare = (a: Position, b: Position) => compareValues([a.key, a.id], [b.key, b.id])

/** `p` as a person row (convex/model/projectSettings.ts personRow). */
const personRow = (p: Profile) => ({
  id: p.id,
  name: p.name,
  org_role: p.org_role,
  kind: p.kind,
  active: p.active,
  pending: p.kind === 'person' && !p.auth_user_id,
})

/**
 * What read `name` answers for `args` while the server holds `ws`, read by
 * the caller the workspace belongs to, with `extra` for what the workspace
 * does not hold. Throws as the server refuses, and for a read `force`
 * fails.
 */
export function peopleSettingsStandIn(
  ws: PeopleSettingsWorkspace,
  name: string,
  args: Record<string, unknown>,
  force: ForcedPeopleSettings = {},
  extra: PeopleSettingsExtra = {},
): unknown {
  const org = String(args.org_id ?? '')
  const me = seatIn(ws, org)
  const short = name.replace(/^[a-zA-Z]+:/, '')
  const admin = me.org_role === 'admin'
  const people = ws.profiles.filter((p) => p.org_id === org)
  const admins = () =>
    force.admins ?? Math.min(2, people.filter((p) => p.org_role === 'admin' && p.active).length)

  const guestProjects = (guest: Profile): { projects: GuestProject[]; more: boolean } => {
    const most = force.guestShown ?? 10
    const shows = (p: (typeof ws.projects)[number] | undefined) =>
      p !== undefined && p.org_id === org && !p.archived_at
    // oldest first, as the server reads leads and grants by creation; the
    // workspace holds no creation time of a grant, so a grant counts at its
    // project's
    const byCreation = (a: { created_at: string; id: string }, b: typeof a) =>
      a.created_at !== b.created_at
        ? a.created_at < b.created_at
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
    const projectOf = new Map(ws.projects.map((p) => [p.id, p]))
    const leads = ws.projects.filter((p) => p.lead_id === guest.id).sort(byCreation)
    const grants = ws.access
      .filter((g) => g.profile_id === guest.id)
      .sort((a, b) => {
        const pa = projectOf.get(a.project_id)
        const pb = projectOf.get(b.project_id)
        return pa && pb ? byCreation(pa, pb) : pa ? -1 : pb ? 1 : 0
      })
    const out: GuestProject[] = []
    const seen = new Set<string>()
    for (const p of leads.slice(0, most)) {
      if (!shows(p) || seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ id: p.id, name: p.name, level: 'lead' })
    }
    for (const g of grants.slice(0, most)) {
      if (seen.has(g.project_id)) continue
      const p = projectOf.get(g.project_id)
      if (!p || !shows(p)) continue
      seen.add(p.id)
      out.push({ id: p.id, name: p.name, level: g.level })
    }
    const more = leads.length > most || grants.length > most || out.length > most
    return { projects: out.slice(0, most), more }
  }
  const settingsRow = (p: Profile): SettingsPersonRow => ({
    ...personRow(p),
    email: p.email ?? null,
    can_create_projects: p.can_create_projects === true,
    plannable_hours: p.plannable_hours ?? null,
    guest: p.org_role === 'guest' ? guestProjects(p) : null,
  })

  if (name === 'people:settingsPage' || name === 'people:get') {
    if (!admin) throw forbidden(PEOPLE_ADMINS_ONLY)
  }
  if (force.fail?.includes(short)) throw new Error(`${name} fails, as the stand-in was asked`)

  if (name === 'people:settingsPage') {
    const search = String(args.search ?? '').trim()
    if (overText(LIMITS.search, search))
      throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
    const scope = [org, nameKey(search)]
    const open = (text: unknown): Position | null => {
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
        of !== LIST ||
        JSON.stringify(from) !== JSON.stringify(scope) ||
        typeof key !== 'string' ||
        typeof id !== 'string' ||
        !(key.startsWith(PEOPLE_MARK) || key.startsWith(GUEST_MARK))
      )
        throw badRequest(NOT_PEOPLE_CURSOR)
      return { key, id }
    }
    const after = open(args.after)
    const through = open(args.through)
    if (after !== null && through !== null && compare(through, after) <= 0)
      throw badRequest('through must be a cursor after the one in after')
    if (force.notReady) return { state: 'not_ready' } satisfies PeoplePageAnswer
    const seal = (p: Position) => JSON.stringify([LIST, scope, [p.key, p.id]])
    const matches = allWordsMatcher(nameKey(search))
    const items = people
      .map((p) => ({
        at: {
          key: (p.org_role === 'guest' ? GUEST_MARK : PEOPLE_MARK) + nameKey(p.name),
          id: p.id,
        },
        p,
      }))
      .sort((a, b) => compare(a.at, b.at))
    const size = force.batch ?? LIST_BATCH
    const limit = through === null ? size : 4 * size
    const rows: SettingsPersonRow[] = []
    let at: Position | null = after
    let read = 0
    const answer = (next: Position | null, stopped: boolean): PeoplePageAnswer => ({
      state: 'ready',
      admins: admins(),
      rows,
      next: next === null ? null : seal(next),
      stopped,
    })
    for (const { at: position, p } of items) {
      if (after !== null && compare(position, after) <= 0) continue
      // a page kept live between two cursors ends at its own
      if (through !== null && compare(position, through) > 0) return answer(through, false)
      // a full page reads one row more, so a page that ends with the list
      // says so; past four pages a pinned one stops short of its end
      if (rows.length >= limit && at !== null)
        return answer(at, through !== null && compare(at, through) < 0)
      if (force.stop !== undefined && through === null && read >= Math.max(1, force.stop) && at)
        return answer(at, true)
      read++
      at = position
      if (matches(`${nameKey(p.name)} ${nameKey(p.email ?? '')}`)) rows.push(settingsRow(p))
    }
    return answer(null, false)
  }

  if (name === 'people:get') {
    const p = people.find((row) => row.id === args.id)
    if (!p) return { state: 'unavailable' } satisfies PersonSettingsAnswer
    return { state: 'ok', person: settingsRow(p), admins: admins() } satisfies PersonSettingsAnswer
  }

  if (name === 'people:byIds') {
    const ids = (args.ids ?? []) as readonly string[]
    if (ids.length > BY_IDS_MAX) throw badRequest(`ids must name at most ${BY_IDS_MAX} people`)
    if (force.byIds === 'error') throw new Error(`${name} fails, as the stand-in was asked`)
    if (force.byIds === 'gone') return { rows: [] }
    const rows: PersonFaceRow[] = []
    for (const id of new Set(ids)) {
      const p = people.find((row) => row.id === id)
      if (p)
        rows.push({
          ...personRow(p),
          color: p.color,
          initials: p.initials,
          avatar: p.avatar_storage_id ?? null,
          sample_avatar: p.sample_avatar ?? null,
          plannable_hours: p.plannable_hours ?? null,
        })
    }
    return { rows }
  }

  if (name === 'tokens:agentKeys') {
    if (!admin) throw forbidden('admin only')
    const ids = (args.agent_ids ?? []) as readonly string[]
    if (ids.length === 0) throw badRequest('agent_ids must name at least one agent')
    if (ids.length > LIST_BATCH)
      throw badRequest(`agent_ids must name at most ${LIST_BATCH} agents`)
    const most = force.keysMost ?? 50
    const agents: AgentKeysRow[] = []
    for (const id of new Set(ids)) {
      const agent = people.find((p) => p.id === id && p.kind === 'agent')
      if (!agent) continue
      // descending as agent_keys by_profile_created reads them; key ids are
      // ASCII, so `<` matches Convex's byte order
      const keys = (extra.keys ?? [])
        .filter((k) => k.agentId === id)
        .sort((a, b) =>
          a.createdAt !== b.createdAt
            ? a.createdAt < b.createdAt
              ? 1
              : -1
            : a.id < b.id
              ? 1
              : a.id > b.id
                ? -1
                : 0,
        )
      agents.push({ agent_id: id, keys: keys.slice(0, most), more: keys.length > most })
    }
    return { agents }
  }

  if (name === 'orgs:projectCreators') {
    if (!admin) throw forbidden(CREATORS_ADMINS_ONLY)
    if (force.creatorsUnavailable) return { state: 'unavailable' } satisfies ProjectCreatorsAnswer
    const row = ws.orgs.find((o) => o.id === org)
    const setting = row?.project_creators ?? 'users'
    const roles = setting === 'admins' ? ['admin'] : ['admin', 'user']
    const found: Profile[] = []
    for (const role of roles) {
      const inRole = people
        .filter((p) => p.org_role === role)
        .sort((a, b) =>
          compare({ key: nameKey(a.name), id: a.id }, { key: nameKey(b.name), id: b.id }),
        )
      for (const p of inRole) if (p.active && canCreateProjects(p, setting)) found.push(p)
    }
    const creator = (p: Profile): CreatorRow => ({
      id: p.id,
      name: p.name,
      agent: p.kind === 'agent',
    })
    if (found.length <= 3)
      return {
        state: 'ok',
        setting,
        creators: found.map(creator),
        others: 0,
        more: false,
        agents: 0,
      } satisfies ProjectCreatorsAnswer
    const counted = found.slice(2, 102)
    return {
      state: 'ok',
      setting,
      creators: found.slice(0, 2).map(creator),
      others: counted.length,
      more: found.length > 102,
      agents: counted.filter((p) => p.kind === 'agent').length,
    } satisfies ProjectCreatorsAnswer
  }

  if (name === 'invites:deliveries') {
    const ids = args.profile_ids as readonly string[] | undefined
    if (ids !== undefined && ids.length > BY_IDS_MAX)
      throw badRequest(`profile_ids must name at most ${BY_IDS_MAX} seats`)
    // the Users page is an admin's; another seat sees only its own sends,
    // which these rows do not record, so it sees none
    if (!admin) return []
    const rows = extra.deliveries ?? []
    // a seat of the organization that is still an invitation, as
    // convex/invites.ts isInvitation keeps it
    const invitation = (id: string) =>
      people.some(
        (p) => p.id === id && p.kind === 'person' && p.active && !!p.email && !p.auth_user_id,
      )
    const seats = new Set(ids ?? rows.map((r) => r.profile_id))
    return [...seats].filter(invitation).flatMap((id) => rows.filter((r) => r.profile_id === id))
  }
  throw new Error(`the people settings stand-in does not answer ${name}`)
}

/**
 * A server double for the jsdom tests, the Users page's reads over the
 * workspace `server()` answers, with the states `force()` asks for and the
 * keys and invitation rows `extra()` holds, through
 * projectSettingsStandIn.setup.ts readsServer (`watch` for the live reads,
 * `query` for the one-shot key reads, `rerun` as Convex reruns them).
 */
export function peopleSettingsServer(
  server: () => PeopleSettingsWorkspace,
  force: () => ForcedPeopleSettings = () => ({}),
  extra: () => PeopleSettingsExtra = () => ({}),
) {
  return readsServer((name, args) => peopleSettingsStandIn(server(), name, args, force(), extra()))
}
