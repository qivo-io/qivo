/* The reads behind Settings › Organization › Users and Organization ›
 * General's creators line (people.ts and orgs.ts projectCreators):
 *
 *   settingsPeopleOf  one page of the organization's people and agents,
 *                     then its guests, 25 records a page across both
 *                     groups, in name order with a search over each
 *                     person's name and address (people.settingsPage)
 *   settingsPersonOf  one person by id, for the phone's user page and
 *                     Settings' check of a `user:` page (people.get)
 *   peopleByIdsOf     the person rows of up to BY_IDS_MAX ids for any
 *                     active seat (people.byIds)
 *   projectCreatorsOf who can create top-level projects under the saved
 *                     setting, two named and the rest counted exactly up
 *                     to 100 (orgs.projectCreators)
 *
 * The page, the person and the creators are an organization admin's, as
 * Settings › Users and Organization › General are, so each refuses anyone
 * else before it reads a row. Each reads one organization, the caller's
 * seat in it, and no task, team, membership, key or grant other than a
 * guest's own. The page reads in name order a batch at a time through
 * lib/namedPages.ts over profiles.by_org_role_name, one range a role,
 * marked so people and agents (the admin, user and viewer ranges) come
 * before guests (the guest range), as the Add team or user picker marks
 * teams before people (model/projectSettings.ts). It answers `not_ready`
 * until the organization's rows hold their name keys (nameKeysReady),
 * because an unkeyed profile sorts first and a search misses it. The page
 * and the person carry the organization's count of active admins up to
 * two (model/orgs.ts activeAdmins), the count the last-admin check of the
 * writes reads, so the page locks the last admin's role and Remove from the
 * whole organization, never from the rows it shows.
 *
 * The readers live apart from model/people.ts, which model/orgs.ts imports,
 * so their imports of model/projectSettings.ts close no cycle. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { GrantLevel } from '../lib/enums'
import { badRequest, forbidden, notFound, require } from '../lib/functions'
import { BY_IDS_MAX, LIST_BATCH } from '../lib/limits'
import {
  indexAfter,
  inGroup,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedReads,
  namedCeiling,
  type ReadGuard,
  readGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { canCreateProjects } from '../lib/projectCreators'
import { allWordsMatcher } from '../lib/search'
import { idTieOf, nameKeysReady, profileRoleIndex } from './nameKeys'
import { activeAdmins } from './orgs'
import { shownAvatarColor } from './people'
import { type ListArgs, orderedListAsk, type PersonRow, personRow } from './projectSettings'

/* ------------------------------------------------------------- the rules */

/* The marks that put the page's groups in one order. Every position's key
 * starts with its group's mark, so people and agents come before guests
 * (lib/namedPages.ts compareNamed compares the marks first). */
export const PEOPLE_MARK = '0'
export const GUEST_MARK = '1'

/* Whether `key` is a position of the page, which every key it hands out
 * starts with a mark of. */
const markedPerson = (key: string): boolean =>
  key.startsWith(PEOPLE_MARK) || key.startsWith(GUEST_MARK)

/** The organization roles the page lists as people and agents, before the
 * guests. */
export const USER_ROLES = ['admin', 'user', 'viewer'] as const

/** The refusal of the page and the person for anyone but an active
 * organization admin. */
export const PEOPLE_ADMINS_ONLY = 'only organization admins manage users'

/** The refusal of the creators line for anyone but an active organization
 * admin. */
export const CREATORS_ADMINS_ONLY = 'only organization admins see who can create projects'

/** The refusal of an `after` or `through` that is not a cursor of the page
 * for the same organization and search. */
export const NOT_PEOPLE_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same search; start again from the first page'

/** The list name that seals the page's cursors. */
export const PEOPLE_LIST = 'people.settings'

/** How many of a guest's projects a row names, up to `shown`, with `more`
 * when its leads or grants hold more than it read. Tests lower it. */
export const GUEST_PROJECTS = { shown: 10 }

/** The most creators the creators line names in full, and how far it
 * counts the others. It names two and counts 100, and reads one more to
 * know that there are more (projectCreatorsOf). */
export const CREATORS = { named: 2, counted: 100 }

/* ------------------------------------------------------------- the rows */

/** One of a guest's projects as a guest row names it, a project the guest
 * leads (`lead`) or holds a grant on, with the grant's level. */
export type GuestProject = { id: string; name: string; level: GrantLevel | 'lead' }

/** A person as Settings › Users shows them, the person row
 * (model/projectSettings.ts PersonRow) with what the row's controls need,
 * the address (null for an agent and for a guest without one), the
 * per-user project right (`can_create_projects`, which counts only for a
 * standard user under Selected users), the plannable hours (null for an
 * agent and for a seat that stores none, which plans the organization's
 * default), and for a guest the first projects they lead or hold a grant on
 * (null for anyone else). No avatar, color, initials, login or hash field;
 * the app paints faces from people.byIds through its profile cache. */
export type SettingsPersonRow = PersonRow & {
  email: string | null
  can_create_projects: boolean
  plannable_hours: number | null
  guest: { projects: GuestProject[]; more: boolean } | null
}

/** What people.settingsPage answers, `not_ready` while the organization's
 * rows are not all name keyed, else one page with `admins`, the
 * organization's active admins counted up to two. */
export type PeoplePageAnswer =
  | { state: 'not_ready' }
  | ({ state: 'ready'; admins: number } & ListBatch<SettingsPersonRow>)

/** What people.get answers, `unavailable` alike for an unknown id and a
 * profile of another organization, else the person with `admins`, as the
 * page counts them. */
export type PersonSettingsAnswer =
  | { state: 'unavailable' }
  | { state: 'ok'; person: SettingsPersonRow; admins: number }

/** A person row with the face the workspace paints for every seat today,
 * the avatar color (gray for an older non-hex value, model/people.ts
 * shownAvatarColor), the stored initials, the uploaded picture's storage id
 * (`avatar`, null for none), which is the picture's version the app mints,
 * keys and keeps it by, the demo's sample portrait (`sample_avatar`, null
 * for none), and the plannable hours as stored (null for an agent and for a
 * seat that stores none, which plans the organization's default), the
 * fields the workspace's people part sent every seat before it was removed
 * (people.byIds). */
export type PersonFaceRow = PersonRow & {
  color: string
  initials: string
  avatar: string | null
  sample_avatar: NonNullable<Doc<'profiles'>['sample_avatar']> | null
  plannable_hours: number | null
}

/** One creator the creators line names, with `agent` set for an agent,
 * which the line marks. */
export type CreatorRow = { id: string; name: string; agent: boolean }

/** What orgs.projectCreators answers, `unavailable` when the read budget
 * ended the walk before it knew the line, else the saved setting it counted
 * under and, with three creators or fewer, every one in `creators`; with
 * more, the first two in `creators`, `others` the rest counted up to 100,
 * `more` whether a creator past those was found, and `agents` the agents
 * among the counted others. */
export type ProjectCreatorsAnswer =
  | { state: 'unavailable' }
  | {
      state: 'ok'
      setting: 'admins' | 'users' | 'selected'
      creators: CreatorRow[]
      others: number
      more: boolean
      agents: number
    }

/* --------------------------------------------------------- the readers */

/* A guest's first projects, as a guest row names them, the projects they
 * lead (projects.by_lead) and then those they hold a grant on
 * (project_access.by_profile), each range in creation order and read to at
 * most GUEST_PROJECTS.shown + 1 rows, each grant's project looked up once.
 * A project counts when it is in the guest's organization and live (no
 * archived_at); a lead wins over a grant on the same project, and each
 * project shows once. `more` is true when either range held more rows than
 * the row reads or the two together found more than it names, so the row
 * never says the guest has no projects when it did not read them all.
 * Every range, row and lookup counts with `guard`, whatever it says, so a
 * row's own reads always finish (lib/namedPages.ts ReadGuard lookup). */
async function guestProjects(
  ctx: QueryCtx,
  guest: Doc<'profiles'>,
  guard: ReadGuard,
): Promise<{ projects: GuestProject[]; more: boolean }> {
  const most = GUEST_PROJECTS.shown
  const shows = (p: Doc<'projects'> | null): p is Doc<'projects'> =>
    p !== null && p.org_id === guest.org_id && p.archived_at === undefined
  await guard.range()
  const leads = await ctx.db
    .query('projects')
    .withIndex('by_lead', (q) => q.eq('lead_id', guest.id))
    .take(most + 1)
  for (const p of leads) await guard.document(p)
  await guard.range()
  const grants = await ctx.db
    .query('project_access')
    .withIndex('by_profile', (q) => q.eq('profile_id', guest.id))
    .take(most + 1)
  for (const g of grants) await guard.document(g)
  const out: GuestProject[] = []
  const seen = new Set<string>()
  for (const p of leads.slice(0, most)) {
    if (!shows(p) || seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ id: p.id, name: p.name, level: 'lead' })
  }
  for (const g of grants.slice(0, most)) {
    if (seen.has(g.project_id)) continue
    const p = await guard.lookup(() => byId(ctx, 'projects', g.project_id))
    if (!shows(p)) continue
    seen.add(p.id)
    out.push({ id: p.id, name: p.name, level: g.level })
  }
  const more = leads.length > most || grants.length > most || out.length > most
  return { projects: out.slice(0, most), more }
}

/* `profile` as Settings › Users shows it, a guest with their projects. */
async function settingsRow(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  guard: ReadGuard,
): Promise<SettingsPersonRow> {
  return {
    ...personRow(profile),
    email: profile.email ?? null,
    can_create_projects: profile.can_create_projects === true,
    plannable_hours: profile.plannable_hours ?? null,
    guest: profile.org_role === 'guest' ? await guestProjects(ctx, profile, guard) : null,
  }
}

/* Refuses `me` unless it is an organization admin, before any read.
 * orgQuery already refuses a seat that is absent, inactive or in a
 * deletion. */
function assertManagesPeople(me: Doc<'profiles'>, refusal: string): void {
  if (me.org_role !== 'admin' || !me.active) throw forbidden(refusal)
}

/** The arguments of people.settingsPage, an optional search and the
 * cursors of the page's start (`after`) and, for the shape the Settings
 * lists share, its end (`through`), which no app caller sends, since the
 * page mode reads one page open (src/lib/pagedList.ts usePagedPages). */
export type PeoplePageArgs = ListArgs

/**
 * people.settingsPage for `me`, one page of Settings › Users of LIST_BATCH
 * records across both groups, the organization's people and agents (the
 * admin, user and viewer ranges merged) in name key byte order with the id
 * breaking ties, then its guests in the same order, so a changed search
 * starts with LIST_BATCH matches in all.
 *
 * Refused with PEOPLE_ADMINS_ONLY unless `me` is an organization admin,
 * before any read. The search keeps a person when every
 * whitespace-separated word of it is in their name or their address,
 * ignoring case and accents, each word in either field (the two name keys
 * joined by a space, which no word holds), on the profile the walk reads
 * anyway, before any further read. Addresses match as stored
 * (lib/email.ts asciiEmail), so a domain typed in Unicode does not match
 * its punycode. A guest's row reads their first projects (guestProjects)
 * through the batch's guard. `admins` is read before the walk, outside its
 * guard, so it is always a number.
 */
export async function settingsPeopleOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: PeoplePageArgs,
): Promise<PeoplePageAnswer> {
  assertManagesPeople(me, PEOPLE_ADMINS_ONLY)
  const ask = await orderedListAsk(PEOPLE_LIST, [me.org_id], a, {
    tieOf: (at) => (markedPerson(at.key) ? idTieOf(at) : null),
    refusal: NOT_PEOPLE_CURSOR,
  })
  if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' }
  const admins = await activeAdmins(ctx, me.org_id, 2)
  const ceiling = await namedCeiling(ctx)
  const streams = [
    ...USER_ROLES.map((role) =>
      indexAfter(inGroup(profileRoleIndex(ctx, me.org_id, role), PEOPLE_MARK), ask.after),
    ),
    indexAfter(inGroup(profileRoleIndex(ctx, me.org_id, 'guest'), GUEST_MARK), ask.after),
  ]
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: (reads: NamedReads) => mergeNamed(streams.map((stream) => stream(reads))),
    keep: async (profile, guard) =>
      matches(`${nameKey(profile.name)} ${nameKey(profile.email ?? '')}`)
        ? await settingsRow(ctx, profile, guard)
        : null,
    limit: LIST_BATCH,
    ceiling,
  })
  return { state: 'ready', admins, ...batch }
}

/**
 * people.get for `me`, which answers person `id` of `me`'s organization as
 * Settings › Users shows them, whether or not a loaded page holds them,
 * with `admins` as the page counts them. Refused with PEOPLE_ADMINS_ONLY
 * unless `me` is an organization admin, before any read. An unknown id and a profile of
 * another organization answer `unavailable` alike. A guest's projects read
 * under the call's own guard.
 */
export async function settingsPersonOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
): Promise<PersonSettingsAnswer> {
  assertManagesPeople(me, PEOPLE_ADMINS_ONLY)
  const profile = await byId(ctx, 'profiles', id)
  if (profile === null || profile.org_id !== me.org_id) return { state: 'unavailable' }
  const admins = await activeAdmins(ctx, me.org_id, 2)
  const guard = readGuard(ctx, await namedCeiling(ctx))
  return { state: 'ok', person: await settingsRow(ctx, profile, guard), admins }
}

/**
 * people.byIds for `me`, any active seat, which answers the person rows,
 * with their faces, pictures and plannable hours (PersonFaceRow), of the
 * profiles of `me`'s organization among `ids`, each once. Every profile of
 * the organization answers, switched-off and pending ones included, each
 * with its `active` and `pending`, so a reference to a person who left
 * keeps its name. An unknown id and a profile of another organization are
 * left out, a definite answer, since each was looked up. More than
 * BY_IDS_MAX ids are refused on the raw length, repeats included. It reads
 * each distinct profile once and nothing else.
 */
export async function peopleByIdsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  ids: readonly string[],
): Promise<{ rows: PersonFaceRow[] }> {
  if (ids.length > BY_IDS_MAX) throw badRequest(`ids must name at most ${BY_IDS_MAX} people`)
  const profiles = await Promise.all([...new Set(ids)].map((id) => byId(ctx, 'profiles', id)))
  return {
    rows: profiles.flatMap((p) =>
      p !== null && p.org_id === me.org_id
        ? [
            {
              ...personRow(p),
              color: shownAvatarColor(p.color),
              initials: p.initials,
              avatar: p.avatar_storage_id ?? null,
              sample_avatar: p.sample_avatar ?? null,
              plannable_hours: p.plannable_hours ?? null,
            },
          ]
        : [],
    ),
  }
}

/**
 * orgs.projectCreators for `me`, which answers who can create top-level
 * projects in `me`'s organization under its saved setting, by the rule
 * projects.create enforces (lib/projectCreators.ts canCreateProjects),
 * active seats only, pending invitations and Standard user agents
 * included. Refused with CREATORS_ADMINS_ONLY unless `me` is an
 * organization admin, before any read.
 *
 * It walks profiles.by_org_role_name's admin range and then, unless the
 * setting is Org admins, its user range, each in name key order, and stops
 * once it holds two creators to name, 100 to count and one more, or at the
 * end. An index range by role holds every row of that role, keyed or not,
 * so it needs no readiness check, and it reads the ranges raw, never
 * through the name-ordered streams, whose positions need a name key. The
 * walk runs under a guard on namedCeiling; when the guard ends it before
 * it holds 103 creators or has read every range it needs, it answers
 * `unavailable`, never a count from part of the ranges. Under Selected
 * users the walk reads every standard user, about 1,000 at the design
 * size.
 */
export async function projectCreatorsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
): Promise<ProjectCreatorsAnswer> {
  assertManagesPeople(me, CREATORS_ADMINS_ONLY)
  const org = await byId(ctx, 'organizations', me.org_id)
  require(org !== null, notFound('organization not found'))
  const setting = org.project_creators ?? 'users'
  const guard = readGuard(ctx, await namedCeiling(ctx))
  const wanted = CREATORS.named + CREATORS.counted + 1
  const found: Doc<'profiles'>[] = []
  const roles = setting === 'admins' ? (['admin'] as const) : (['admin', 'user'] as const)
  walk: for (const role of roles) {
    if (!(await guard.range())) return { state: 'unavailable' }
    for await (const p of profileRoleIndex(ctx, me.org_id, role).all()) {
      // a row past a full budget is not counted, so the line is never short
      if (guard.full) return { state: 'unavailable' }
      await guard.document(p)
      if (p.active && canCreateProjects(p, setting)) found.push(p)
      if (found.length >= wanted) break walk
    }
  }
  const creator = (p: Doc<'profiles'>): CreatorRow => ({
    id: p.id,
    name: p.name,
    agent: p.kind === 'agent',
  })
  if (found.length <= CREATORS.named + 1)
    return { state: 'ok', setting, creators: found.map(creator), others: 0, more: false, agents: 0 }
  const counted = found.slice(CREATORS.named, CREATORS.named + CREATORS.counted)
  return {
    state: 'ok',
    setting,
    creators: found.slice(0, CREATORS.named).map(creator),
    others: counted.length,
    more: found.length > CREATORS.named + CREATORS.counted,
    agents: counted.filter((p) => p.kind === 'agent').length,
  }
}
