/* The reads behind a project's Settings page (projectSettings.ts): the
 * project's fields and the caller's rights on it, its Users and Teams access
 * lists, the Add team or user picker, the lead pickers and the invite form's
 * lookup of one address. The grant readers (userGrantBatch, teamShareBatch)
 * check no access, so REST and MCP project details can page grants with
 * them behind their own gate. Nothing here reads a task, a comment, a file,
 * a milestone or a project's list of sub-projects.
 *
 * One gate (settingsGate) decides who reads a project: whoever sees it
 * (lib/access.ts projectLevel, navigation included, the rule behind
 * canSeeProject) or manages it (canManageOwnProjectAccess). Today every
 * manager also sees the project; the admin access split takes an admin's
 * ordinary access away from projects they only manage, and the gate keeps
 * them in. An unknown id, a project of another organization, one in Deleted
 * items, one outside a meta tree and one the caller neither sees nor
 * manages all answer `unavailable`, so an answer tells nothing about a
 * project the caller cannot reach.
 *
 * Rights come from the writes' own rules (settingsRights), computed with
 * canManageOwnProjectAccess, the predicate the admin access split moves
 * those writes onto, never from the caller's level. The lists are explicit
 * grants, never effective access, and a list or picker never becomes a
 * permission map: the writes stay projects.setAccess, removeAccess, update
 * and inviteGuest with their own checks.
 *
 * Lists and pickers read in name order a batch at a time (lib/namedPages.ts)
 * over the indexes of model/nameKeys.ts, in the byte order of each name key
 * with an id to break ties, and keep the rows whose name holds every
 * whitespace-separated fragment of the search, ignoring case and accents.
 * Each answers `not_ready` until the organization's rows hold their name
 * keys (nameKeysReady), because an unkeyed row sorts first and a search by
 * name misses it. */

import type { GenericDocument } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  accessOf,
  canChangeAccess,
  canLeadProjects,
  canManageOwnProjectAccess,
  inMetaTree,
  NO_USER_MANAGEMENT,
} from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import { DEMO_FEATURE_REFUSAL, isDemoDeployment } from '../lib/demo'
import { asciiEmail } from '../lib/email'
import {
  type AccessLevel,
  GRANT_LEVELS,
  type GrantLevel,
  type OrgRole,
  type ProfileKind,
  type ProjectType,
} from '../lib/enums'
import { badRequest, notFound, require } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  compareNamed,
  indexAfter,
  mergeNamed,
  type Named,
  type NamedAt,
  type NamedIndex,
  type NamedReads,
  type NamedStream,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  type ReadGuard,
  readBatch,
  STOPPED,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { canCreateProjects, projectCreationRefusal } from '../lib/projectCreators'
import { DEFAULT_REVIEW_HOURS, resolveReviewHours } from '../lib/review'
import { allWordsMatcher } from '../lib/search'
import {
  type IdTie,
  nameKeysReady,
  profileIndex,
  profileRoleIndex,
  projectGrantIndex,
  projectShareIndex,
  teamIndex,
} from './nameKeys'
import { LEAD_ACCESS_NEEDED, subProjectParent } from './projects'

/* ------------------------------------------------------------- the rows */

/** A person as the access lists and pickers show them. `pending` marks an
 * invited seat nobody has claimed (a person without a login), as
 * src/store/viewModels.ts shapeUser marks it before its demo exception,
 * which stays in the app. Rows carry no email, avatar or icon fields; the
 * app paints avatars from the people it holds. */
export type PersonRow = {
  id: string
  name: string
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  pending: boolean
}

/** `profile` as a person row. */
export const personRow = (profile: Doc<'profiles'>): PersonRow => ({
  id: profile.id,
  name: profile.name,
  org_role: profile.org_role,
  kind: profile.kind,
  active: profile.active,
  pending: profile.kind === 'person' && !profile.auth_user_id,
})

/** A project's effective lead as a person row, `inherited` when a legacy
 * sub-project without a lead of its own is led by its parent's. */
export type LeadRow = PersonRow & { inherited: boolean }

/** What a person may be given or made: `levels`, the grant levels a grant
 * write accepts for them (model/projects.ts assertGrantee, only Viewer for
 * an organization viewer), and `can_lead`, whether a lead write accepts
 * them (assertLeadAllowed: an active seat with the role admin, user or
 * guest). */
export type GrantChoices = { levels: GrantLevel[]; can_lead: boolean }

/** `profile`'s grant choices (GrantChoices). */
const choicesOf = (profile: Doc<'profiles'>): GrantChoices => ({
  levels: profile.org_role === 'viewer' ? ['viewer'] : [...GRANT_LEVELS],
  can_lead: profile.active && canLeadProjects(profile),
})

/** A sub-project's top-level project, as its settings name it. */
export type ParentRef = { id: string; name: string; key: string; num: number }

const parentRef = (parent: Doc<'projects'> | null): ParentRef | null =>
  parent === null ? null : { id: parent.id, name: parent.name, key: parent.key, num: parent.num }

/** The lead of `project` in the tree of `root`, its top-level project: its
 * own, else, for a legacy sub-project without one, its parent's. Leadership
 * (lib/access.ts isProjectLead) and the lead's own grant rule
 * (model/projectAccess.ts assertNotLead) read it the same way. */
export const effectiveLeadId = (
  project: Pick<Doc<'projects'>, 'lead_id'>,
  root: Pick<Doc<'projects'>, 'lead_id'>,
): string | undefined => project.lead_id ?? root.lead_id

/* ------------------------------------------------------------- the gate */

/** What settingsGate answers. `ok` carries the project, its parent (null
 * for a top-level project), its root (the top-level project, the project
 * itself or its parent), the caller's ordinary level on it and whether they
 * manage it. */
export type SettingsGate =
  | { state: 'unavailable' }
  | { state: 'archived'; project: Doc<'projects'>; parent: Doc<'projects'> | null }
  | {
      state: 'ok'
      project: Doc<'projects'>
      parent: Doc<'projects'> | null
      root: Doc<'projects'>
      level: AccessLevel | null
      manages: boolean
    }

/* The parent of `project`, read once, and the top-level meta whose tree
 * holds it, or null when it is in no meta tree (lib/access.ts inMetaTree):
 * a missing parent, a deeper or cyclic chain of parents, a top-level
 * project that is not a meta. Deciding this first keeps lib/access.ts
 * rootMetaOf, which throws for a broken chain, to one read of a parent that
 * exists. */
async function treeOf(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<{ parent: Doc<'projects'> | null; root: Doc<'projects'> } | null> {
  if (project.parent_id === undefined)
    return inMetaTree(project, project) ? { parent: null, root: project } : null
  const parent = await byId(ctx, 'projects', project.parent_id)
  return parent !== null && inMetaTree(project, parent) ? { parent, root: parent } : null
}

/**
 * The one gate of a project's settings, lists and pickers for `me`: whoever
 * sees `project` (lib/access.ts projectLevel, navigation included) or
 * manages it (canManageOwnProjectAccess) reads it. Answers `unavailable`
 * for no project, one of another organization or outside a meta tree, and
 * one `me` neither sees nor manages; `archived` for an archived project `me`
 * sees or manages; else `ok`. Each predicate runs once.
 *
 * The level comes from lib/access.ts accessOf, which answers projectLevel's
 * level within bounded reads: whether a top-level project shows to `me`
 * for navigation comes from its sub-projects (one range) and `me`'s own
 * grants, memberships and team shares, where projectLevel's walk reads each
 * sub-project's grant and team shares and, for each share, its team and
 * `me`'s membership, past Convex's 4,096 index ranges under a large shared
 * project. canManageOwnProjectAccess reads the root again, one range for a
 * sub-project.
 */
export async function settingsGate(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'> | null,
): Promise<SettingsGate> {
  if (project === null || project.org_id !== me.org_id) return { state: 'unavailable' }
  const tree = await treeOf(ctx, project)
  if (tree === null) return { state: 'unavailable' }
  const read = tree.parent === null ? [project] : [project, tree.parent]
  const level = await accessOf(ctx, me, read).level(project.id)
  const manages = await canManageOwnProjectAccess(ctx, me, project)
  if (level === null && !manages) return { state: 'unavailable' }
  if (project.archived_at !== undefined) return { state: 'archived', project, parent: tree.parent }
  return { state: 'ok', project, ...tree, level, manages }
}

/** settingsGate for the project with id `id`. */
export const settingsProject = async (
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
): Promise<SettingsGate> => await settingsGate(ctx, me, await byId(ctx, 'projects', id))

/* ----------------------------------------------------------- the rights */

/** What `me` may change on a live project, each the outcome of the write
 * it names for a change that passes the write's other checks. They say who
 * may, not whether the organization accepts writes now: a billing pause or
 * a pending deletion is billing.status's. */
export type SettingsRights = {
  /** projects.update of the name, key, description, review time and delay
   * tracking (model/projects.ts updateProjectCore, assertLead) */
  can_edit: boolean
  /** projects.update of lead_id: a person, and canManageProjectUsers for a
   * top-level project, assertLead for a sub-project */
  can_change_lead: boolean
  /** projects.setAccess and removeAccess for a person
   * (model/projectAccess.ts assertManagesAccess) */
  can_manage_users: boolean
  /** projects.setAccess and removeAccess for a team (assertManagesAccess) */
  can_manage_teams: boolean
  /** projects.inviteGuest: not in the demo, and canManageProjectUsers */
  can_invite: boolean
  /** projects.archive (model/projects.ts archiveProjectCore, assertLead) */
  can_archive: boolean
  /** projects.deleteDeep and removalSummary: Lead access */
  can_delete: boolean
  /** projects.create of a sub-project under this one (model/projects.ts
   * subProjectParent): Lead access to a top-level meta that is not
   * archived. The write checks only that the parent is a meta, so it would
   * also take a legacy meta row with a parent, which nobody could then
   * reach; this flag is stricter and asks for a top-level one. */
  can_create_sub_project: boolean
}

/**
 * `me`'s rights on the project of `gate` (SettingsRights). Every management
 * right is canManageOwnProjectAccess, which equals Lead access
 * (hasProjectLevel 'lead') for an active seat today, as lib/access.ts
 * levelUnder answers 'lead' only for an organization admin or the project's
 * lead and grants hold at most User. The admin access split moves the
 * writes onto that predicate, so these answers do not change with it.
 */
export function settingsRights(
  me: Doc<'profiles'>,
  gate: Extract<SettingsGate, { state: 'ok' }>,
): SettingsRights {
  const { manages, project } = gate
  const person = canChangeAccess(me)
  return {
    can_edit: manages,
    can_change_lead: person && manages,
    can_manage_users: person && manages,
    can_manage_teams: person && manages,
    can_invite: !isDemoDeployment() && manages,
    can_archive: manages,
    can_delete: manages,
    can_create_sub_project:
      manages &&
      project.type === 'meta' &&
      project.parent_id === undefined &&
      project.archived_at === undefined,
  }
}

/* --------------------------------------------------------------- get */

/** A project as its Settings page edits it. `review_hours` and `lead_id`
 * are the project's own stored values, null when it has none, because the
 * app's `expected` for projects.update compares with them
 * (model/projects.ts PROJECT_FIELDS); `description` is the stored text. */
export type SettingsProject = {
  id: string
  org_id: string
  key: string
  num: number
  name: string
  type: ProjectType
  description: string
  track_delay: boolean
  review_hours: number | null
  lead_id: string | null
}

/** What projectSettings.get answers (projectSettingsOf). */
export type ProjectSettings =
  | { state: 'unavailable' }
  | {
      state: 'archived'
      project: Pick<SettingsProject, 'id' | 'org_id' | 'key' | 'num' | 'name' | 'type'>
      parent: ParentRef | null
    }
  | ({
      state: 'ok'
      project: SettingsProject
      parent: ParentRef | null
      /** what an empty Review time means: the parent's for a sub-project,
       * else DEFAULT_REVIEW_HOURS */
      inherited_review_hours: number
      /** the effective lead, or null when there is none or their profile is
       * gone or in another organization */
      lead: LeadRow | null
      /** the caller's level (lib/access.ts projectLevel), never used for a
       * right. Today every organization admin has 'lead'; after the admin
       * access split it is their ordinary level. */
      level: AccessLevel | null
    } & SettingsRights)

/** The profile `id` names in organization `orgId`, or null. */
async function memberOf(
  ctx: QueryCtx,
  orgId: string,
  id: string | undefined,
): Promise<Doc<'profiles'> | null> {
  const profile = id === undefined ? null : await byId(ctx, 'profiles', id)
  return profile !== null && profile.org_id === orgId ? profile : null
}

/**
 * projectSettings.get: the settings of project `id` for the caller's seat in
 * its organization (`myProfiles`, the caller's active seats by organization),
 * as `milestones.get` resolves a seat. No seat there answers `unavailable`,
 * as settingsGate does. It reads the project, its parent, the caller's level
 * and management right and the lead's profile, never a task.
 */
export async function projectSettingsOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  id: string,
): Promise<ProjectSettings> {
  const project = await byId(ctx, 'projects', id)
  const me = project === null ? undefined : myProfiles.get(project.org_id)
  if (me === undefined) return { state: 'unavailable' }
  const gate = await settingsGate(ctx, me, project)
  if (gate.state === 'unavailable') return gate
  const p = gate.project
  if (gate.state === 'archived') {
    return {
      state: 'archived',
      project: { id: p.id, org_id: p.org_id, key: p.key, num: p.num, name: p.name, type: p.type },
      parent: parentRef(gate.parent),
    }
  }
  const lead = await memberOf(ctx, p.org_id, effectiveLeadId(p, gate.root))
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
    lead: lead === null ? null : { ...personRow(lead), inherited: p.lead_id === undefined },
    level: gate.level,
    ...settingsRights(me, gate),
  }
}

/* ------------------------------------------------------------ the lists */

/** What a list is asked for: an optional search, and the cursors of the
 * batch's start (`after`, none for the first batch) and, to keep a loaded
 * batch live, its end (`through`). */
export type ListArgs = { search?: string; after?: string; through?: string }

/** A name-ordered list asked for: the list's name and scope, which seal
 * its cursors (lib/namedPages.ts namedCursor), the search as typed, trimmed,
 * and the positions the batch reads between. */
export type ListAsk = {
  list: string
  scope: readonly string[]
  search: string
  after: NamedAt<IdTie> | null
  through: NamedAt<IdTie> | null
}

/** The refusal of an `after` or `through` that is not a cursor of this
 * list for the same arguments and search. */
const NOT_LIST_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same project and search; start again from the first batch'

/**
 * The arguments of list `list` checked and opened, for `scope`, which the
 * normalized search ends. Refuses a search longer than LIMITS.search with
 * that limit's sentence, and with badRequest an `after` or `through` that is
 * not a cursor this list gave for the same scope and search, or whose key
 * `known` refuses, and a `through` that does not come after `after`. Two
 * searches with one name key, such as "Café" and "cafe", share cursors,
 * since they match the same rows.
 */
export async function listAsk(
  list: string,
  scope: readonly string[],
  a: ListArgs,
  known: (key: string) => boolean = () => true,
): Promise<ListAsk> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const sealed = [...scope, nameKey(search)]
  const open = async (text: string | undefined): Promise<NamedAt<IdTie> | null> => {
    if (text === undefined) return null
    const at = await openNamedCursor(text, list, sealed)
    const id = at?.tie[0]
    if (at === null || at.tie.length !== 1 || typeof id !== 'string' || !known(at.key)) {
      throw badRequest(NOT_LIST_CURSOR)
    }
    return { key: at.key, tie: [id] }
  }
  const after = await open(a.after)
  const through = await open(a.through)
  if (after !== null && through !== null && compareNamed(through, after) <= 0) {
    throw badRequest('through must be a cursor after the one in after')
  }
  return { list, scope: sealed, search, after, through }
}

/** One batch of a name-ordered list: the rows; `next`, a cursor at the
 * position the batch reached, or null when nothing follows it; and
 * `stopped`, whether the read budget ended the batch before it was full or
 * reached `through`, so the rows are every match up to `next`, possibly
 * none. */
export type ListBatch<Row> = { rows: Row[]; next: string | null; stopped: boolean }

/* One batch of `ask` over `stream` (lib/namedPages.ts readBatch), keeping
 * what `keep` answers. Without `ask.through` it holds at most `limit` rows;
 * with it, every match up to and including `through`, so a loaded batch
 * stays live without its end moving, and one that would hold more than four
 * times `limit` stops there as if the read budget stopped it, and the app
 * splits it, as model/labels.ts labelBatch does. */
async function listBatch<Row extends GenericDocument, Out>(
  ctx: QueryCtx,
  ask: ListAsk,
  o: {
    stream: (reads: NamedReads) => NamedStream<Row>
    keep: (row: Row, guard: ReadGuard) => Promise<Out | null>
    limit: number
    ceiling: ReadCeiling
  },
): Promise<ListBatch<Out>> {
  const batch = await readBatch(ctx, {
    stream: o.stream,
    keep: o.keep,
    limit: ask.through === null ? o.limit : 4 * o.limit,
    through: ask.through,
    ceiling: o.ceiling,
    after: ask.after,
  })
  // a batch under `through` that stopped short of it holds too many rows
  const short = !batch.ended && ask.through !== null && compareNamed(batch.at, ask.through) < 0
  return {
    rows: batch.rows,
    next: batch.ended ? null : await namedCursor(ask.list, ask.scope, batch.at),
    stopped: batch.stopped || short,
  }
}

/** What a grant reader answers: `not_ready` while the organization's rows
 * are not all name keyed, else one batch. */
export type GrantBatch<Row> = { state: 'not_ready' } | ({ state: 'ready' } & ListBatch<Row>)

/** A user grant as the Users list shows it: the person, their grant's
 * level and what else they may be given (GrantChoices). */
export type UserGrantRow = PersonRow & { level: GrantLevel } & GrantChoices

/** A team share as the Teams list shows it. */
export type TeamShareRow = { id: string; name: string; level: GrantLevel }

/**
 * One batch of the user grants on `project`, in the order of their copies
 * of the person's name key (model/nameKeys.ts projectGrantIndex), with
 * `ask`'s search matched against the copy before anything else is read, so
 * a row the search leaves out costs no profile read. A copy can trail a
 * rename for a moment, which places its row by the earlier name and can
 * miss a search by the new one. It lists every grant of a person in the
 * project's organization, the lead's own grant included, except the grant
 * of `without`; a grant whose profile is gone or in another organization is
 * left out, as a removed person's grants can outlive their profile for a
 * moment. Each kept row reads its profile. `limit` is the batch size.
 *
 * It checks no access: each caller applies its own gate first. It checks
 * the organization's name keys itself (nameKeysReady), so every caller
 * fails closed while they are missing.
 */
export async function userGrantBatch(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  ask: ListAsk,
  o: { limit: number; ceiling: ReadCeiling; without?: string },
): Promise<GrantBatch<UserGrantRow>> {
  if (!(await nameKeysReady(ctx, project.org_id))) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(projectGrantIndex(ctx, project.id), ask.after),
    keep: async (grant: Doc<'project_access'>, guard): Promise<UserGrantRow | null> => {
      if (grant.profile_id === o.without || !matches(grant.name_key ?? '')) return null
      const profile = await guard.lookup(() => byId(ctx, 'profiles', grant.profile_id))
      if (profile === null || profile.org_id !== project.org_id) return null
      return { ...personRow(profile), level: grant.level, ...choicesOf(profile) }
    },
    limit: o.limit,
    ceiling: o.ceiling,
  })
  return { state: 'ready', ...batch }
}

/**
 * One batch of the team shares on `project`, in the order of their copies
 * of the team's name key (model/nameKeys.ts projectShareIndex), with the
 * search matched against the copy first, as userGrantBatch matches grants.
 * A share whose team is gone or of another organization is left out, as
 * lib/access.ts teamGrantOn skips it. Each kept row reads its team. Like
 * userGrantBatch it checks no access and fails closed without name keys.
 */
export async function teamShareBatch(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  ask: ListAsk,
  o: { limit: number; ceiling: ReadCeiling },
): Promise<GrantBatch<TeamShareRow>> {
  if (!(await nameKeysReady(ctx, project.org_id))) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(projectShareIndex(ctx, project.id), ask.after),
    keep: async (share: Doc<'project_team_access'>, guard): Promise<TeamShareRow | null> => {
      if (!matches(share.name_key ?? '')) return null
      const team = await guard.lookup(() => byId(ctx, 'teams', share.team_id))
      if (team === null || team.org_id !== project.org_id) return null
      return { id: team.id, name: team.name, level: share.level }
    },
    limit: o.limit,
    ceiling: o.ceiling,
  })
  return { state: 'ready', ...batch }
}

/** What projectSettings.users and teams answer. */
export type AccessListAnswer<Row> =
  | { state: 'unavailable' }
  | { state: 'archived' }
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<Row>)

/** What a project's access list is asked for. */
export type AccessListArgs = ListArgs & { project_id: string }

/**
 * projectSettings.users for `me`: one batch of LIST_BATCH user grants on the
 * project (userGrantBatch) behind settingsGate. A first batch (no `after`)
 * also answers `lead`, outside its rows: the project's effective lead as a
 * person row, or null when there is none, their profile is gone or their
 * current name does not match the search. The lead's own legacy grant is
 * left out of the rows, which the lead row stands for. The lead row uses the
 * effective lead, as the lead rule does (model/projectAccess.ts
 * assertNotLead), where the app's planner shows only a project's own
 * lead_id (src/store/viewModels.ts withLead): a legacy sub-project without
 * a lead of its own shows its parent's.
 */
export async function projectUsersOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: AccessListArgs,
): Promise<AccessListAnswer<UserGrantRow> & { lead?: LeadRow | null }> {
  const ask = await listAsk('projectSettings.users', [a.project_id], a)
  const gate = await settingsProject(ctx, me, a.project_id)
  if (gate.state !== 'ok') return { state: gate.state }
  const leadId = effectiveLeadId(gate.project, gate.root)
  const batch = await userGrantBatch(ctx, gate.project, ask, {
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
    without: leadId,
  })
  if (batch.state !== 'ready' || ask.after !== null) return batch
  const lead = await memberOf(ctx, gate.project.org_id, leadId)
  const shown = lead !== null && allWordsMatcher(nameKey(ask.search))(nameKey(lead.name))
  return {
    ...batch,
    lead: shown ? { ...personRow(lead), inherited: gate.project.lead_id === undefined } : null,
  }
}

/** projectSettings.teams for `me`: one batch of LIST_BATCH team shares on
 * the project (teamShareBatch) behind settingsGate. */
export async function projectTeamsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: AccessListArgs,
): Promise<AccessListAnswer<TeamShareRow>> {
  const ask = await listAsk('projectSettings.teams', [a.project_id], a)
  const gate = await settingsProject(ctx, me, a.project_id)
  if (gate.state !== 'ok') return { state: gate.state }
  return await teamShareBatch(ctx, gate.project, ask, {
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
}

/* ---------------------------------------------------------- the pickers */

/** What a picker answers: the gate's states, `refused` with the sentence
 * the write would refuse with, `not_ready` without name keys, else one
 * batch. */
export type PickerAnswer<Row> =
  | { state: 'unavailable' }
  | { state: 'archived' }
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<Row>)

const refused = (message: string) => ({ state: 'refused' as const, message })

/* The marks that put the Add team or user picker's groups in one order:
 * every position's key starts with its group's mark, so teams come before
 * people (lib/namedPages.ts compareNamed compares the marks first). */
const TEAM_MARK = '0'
const PERSON_MARK = '1'

/* `index` as one group of a list of several, each marked by a one-character
 * prefix of its keys (TEAM_MARK, PERSON_MARK). After a position of its own
 * group it reads what follows it in the index; after a position of an
 * earlier group, the whole index; after one of a later group, nothing. */
function inGroup<Row>(index: NamedIndex<Row, IdTie>, mark: string): NamedIndex<Row, IdTie> {
  return {
    all: index.all,
    after: (at) => {
      const group = at.key.slice(0, 1)
      if (group === mark) return index.after({ key: at.key.slice(1), tie: at.tie })
      return group < mark ? [index.all] : []
    },
    at: (row) => {
      const at = index.at(row)
      return { key: mark + at.key, tie: at.tie }
    },
  }
}

/* Whether `key` is a position of the Add team or user picker. */
const markedKey = (key: string): boolean => key.startsWith(TEAM_MARK) || key.startsWith(PERSON_MARK)

/* `stream` with the id of each row that a row of `held` sits at, the same
 * position in the same order, added to `found` before the row is handed
 * out. The Add team or user picker reads a project's shares and grants
 * beside the organization's teams and people this way, so a choice the
 * project already holds is left out without a lookup of its own: a share or
 * grant copies its team's or person's name key, and its tie is the same id.
 * It reads `held` only as far as the row it hands out, and counts every
 * held row it reads (NamedReads skip). Once `held` stops or the budget is
 * full it marks nothing more, and the picker looks those rows up. */
function besideHeld<Row extends { id: string }, Held>(
  stream: (reads: NamedReads) => NamedStream<Row>,
  held: (reads: NamedReads) => NamedStream<Held & GenericDocument>,
  found: Set<string>,
): (reads: NamedReads) => NamedStream<Row> {
  return (reads) =>
    (async function* () {
      const marks = held(reads)[Symbol.asyncIterator]()
      // the next held row, null past the last, undefined until it is read
      let next: Named<Held & GenericDocument> | null | undefined
      // whether `held` stopped or the budget filled, so nothing more is marked
      let blind = false
      try {
        for await (const item of stream(reads)) {
          while (item !== STOPPED && !blind) {
            if (next === undefined) {
              const step = await marks.next()
              if (step.done === true) next = null
              else if (step.value === STOPPED) blind = true
              else {
                next = step.value
                blind = !(await reads.skip(next.row))
              }
            }
            if (next === null || next === undefined || compareNamed(next.at, item.at) > 0) break
            if (compareNamed(next.at, item.at) === 0) found.add(item.row.id)
            next = undefined
          }
          yield item
        }
      } finally {
        await marks.return?.()
      }
    })()
}

/** A choice of the Add team or user picker: a team, or a person with what
 * they may be given (GrantChoices). `type` tells them apart, since a
 * person row's `kind` is the profile's (a person or an agent). */
export type CandidateRow =
  | { type: 'team'; id: string; name: string }
  | ({ type: 'user' } & PersonRow & GrantChoices)

/** What the Add team or user picker is asked for: a project's picker with
 * `project_id`, the New project dialog's without, where `lead_id` names the
 * lead the dialog has chosen. */
export type CandidateArgs = ListArgs & { project_id?: string; lead_id?: string }

/* The organization roles the New project dialog offers access to: guests
 * reach a project only by an invitation to it. */
const NEW_PROJECT_ROLES = ['admin', 'user', 'viewer'] as const

/**
 * projectSettings.candidates for `me`: one batch of the Add team or user
 * picker, LIST_BATCH choices across both groups, every team in name order
 * and then every person in name order, so a changed search starts with
 * LIST_BATCH matches in all.
 *
 * For a project (`project_id`): settingsGate, then refused unless `me` is a
 * person and manages the project's users (model/projectAccess.ts
 * assertManagesAccess); teams only while they manage its teams. It offers
 * the organization's teams without a share on the project and its active
 * people without a grant on it, leaving out the effective lead, whose access
 * is the lead role. A team membership or a grant on the parent excludes
 * nobody, and neither does admin status: admins, agents, guests and viewers
 * stay.
 *
 * For a new top-level project (no `project_id`): refused unless `me` may
 * create projects (lib/projectCreators.ts) and is a person, as
 * model/projects.ts createProjectCore refuses. It offers every team and the
 * active admins, users and viewers, guests left out, and leaves out
 * `lead_id`, the lead the dialog has chosen; an unknown id leaves out
 * nobody.
 *
 * A project's shares and grants are read beside its choices in the same
 * order (besideHeld), so the choices it holds cost one document each and no
 * index range. A choice the search matched that they do not hold is looked
 * up by id before it is offered, one index range, which catches a share or
 * grant whose copy of the name key trails a rename.
 */
export async function candidatesOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: CandidateArgs,
): Promise<PickerAnswer<CandidateRow>> {
  if (a.project_id !== undefined && a.lead_id !== undefined) {
    throw badRequest('lead_id names the lead of a new project, so leave it out with project_id')
  }
  const ask = await listAsk(
    'projectSettings.candidates',
    [me.org_id, a.project_id ?? '', a.lead_id ?? ''],
    a,
    markedKey,
  )
  let project: Doc<'projects'> | null = null
  let teams = true
  let without = a.lead_id
  if (a.project_id !== undefined) {
    const gate = await settingsProject(ctx, me, a.project_id)
    if (gate.state !== 'ok') return { state: gate.state }
    const rights = settingsRights(me, gate)
    if (!canChangeAccess(me)) return refused(ACCESS_NEEDS_A_PERSON)
    if (!rights.can_manage_users) return refused(NO_USER_MANAGEMENT)
    project = gate.project
    teams = rights.can_manage_teams
    without = effectiveLeadId(gate.project, gate.root)
  } else {
    const org = await byId(ctx, 'organizations', me.org_id)
    require(org !== null, notFound('organization not found'))
    if (!canCreateProjects(me, org.project_creators)) {
      return refused(projectCreationRefusal(org.project_creators))
    }
    if (!canChangeAccess(me)) return refused(ACCESS_NEEDS_A_PERSON)
  }
  if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' }
  const people =
    project === null
      ? NEW_PROJECT_ROLES.map((role) => profileRoleIndex(ctx, me.org_id, role))
      : [profileIndex(ctx, me.org_id)]
  const streams = [
    ...(teams ? [indexAfter(inGroup(teamIndex(ctx, me.org_id), TEAM_MARK), ask.after)] : []),
    ...people.map((index) => indexAfter(inGroup(index, PERSON_MARK), ask.after)),
  ]
  const choices = (reads: NamedReads) =>
    mergeNamed<Doc<'teams'> | Doc<'profiles'>>(streams.map((stream) => stream(reads)))
  // the choices the project holds, by id, as its shares and grants mark them
  const found = new Set<string>()
  const held =
    project === null
      ? []
      : [
          ...(teams
            ? [indexAfter(inGroup(projectShareIndex(ctx, project.id), TEAM_MARK), ask.after)]
            : []),
          indexAfter(inGroup(projectGrantIndex(ctx, project.id), PERSON_MARK), ask.after),
        ]
  const matches = allWordsMatcher(nameKey(ask.search))
  const keep = async (
    doc: Doc<'teams'> | Doc<'profiles'>,
    guard: ReadGuard,
  ): Promise<CandidateRow | null> => {
    if (found.has(doc.id)) return null
    if (!('org_role' in doc)) {
      if (!matches(nameKey(doc.name))) return null
      if (project !== null && (await guard.lookup(() => shareOn(ctx, project.id, doc.id))) !== null)
        return null
      return { type: 'team', id: doc.id, name: doc.name }
    }
    if (!doc.active || doc.id === without || !matches(nameKey(doc.name))) return null
    if (project !== null && (await guard.lookup(() => grantOn(ctx, project.id, doc.id))) !== null)
      return null
    return { type: 'user', ...personRow(doc), ...choicesOf(doc) }
  }
  const batch = await listBatch(ctx, ask, {
    stream:
      held.length === 0
        ? choices
        : besideHeld(
            choices,
            (reads) =>
              mergeNamed<Doc<'project_team_access'> | Doc<'project_access'>>(
                held.map((stream) => stream(reads)),
              ),
            found,
          ),
    keep,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/* The grant of person `profileId` on project `projectId`, or null. */
const grantOn = (ctx: QueryCtx, projectId: string, profileId: string) =>
  ctx.db
    .query('project_access')
    .withIndex('by_project_profile', (q) =>
      q.eq('project_id', projectId).eq('profile_id', profileId),
    )
    .first()

/* The share of team `teamId` on project `projectId`, or null. */
const shareOn = (ctx: QueryCtx, projectId: string, teamId: string) =>
  ctx.db
    .query('project_team_access')
    .withIndex('by_project_team', (q) => q.eq('project_id', projectId).eq('team_id', teamId))
    .first()

/** What a lead picker is asked for: the Lead field of project `project_id`,
 * the lead of a new sub-project under `parent_id`, or with neither the lead
 * of a new top-level project. */
export type LeadCandidateArgs = ListArgs & { project_id?: string; parent_id?: string }

/* The organization roles a lead write accepts (model/projects.ts
 * assertLeadAllowed, lib/access.ts canLeadProjects). */
const LEAD_ROLES = ['admin', 'user', 'guest'] as const

/* The roles the New project dialog offers as lead: guests reach a project
 * only by an invitation to it. */
const NEW_PROJECT_LEAD_ROLES = ['admin', 'user'] as const

/**
 * projectSettings.leadCandidates for `me`: one batch of LIST_BATCH people a
 * lead write would accept, in name order: active seats with the role admin,
 * user or guest (model/projects.ts assertLeadAllowed), agents with the user
 * role included. The current lead stays in the list.
 *
 * - `project_id`, the Lead field of a project: settingsGate, then refused
 *   with model/projects.ts updateProjectCore's sentences unless `me` is a
 *   person and manages the project (canManageProjectUsers for a top-level
 *   project, Lead access for a sub-project).
 * - `parent_id`, the lead of a new sub-project: createProjectCore's parent
 *   checks in its order (subProjectParent), where a parent `me` cannot see
 *   answers `unavailable` and the others are refused with the create's
 *   sentences, then refused unless `me` is a person, as the create refuses
 *   another lead.
 * - neither, a new top-level project: refused unless `me` may create
 *   projects and is a person. It offers admins and users only, as the New
 *   project dialog does.
 *
 * Naming both ids is refused.
 */
export async function leadCandidatesOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: LeadCandidateArgs,
): Promise<PickerAnswer<PersonRow>> {
  if (a.project_id !== undefined && a.parent_id !== undefined) {
    throw badRequest('name project_id or parent_id, not both')
  }
  const target =
    a.project_id !== undefined
      ? ['project', a.project_id]
      : a.parent_id !== undefined
        ? ['parent', a.parent_id]
        : ['organization', '']
  const ask = await listAsk('projectSettings.leadCandidates', [me.org_id, ...target], a)
  let roles: readonly OrgRole[] = LEAD_ROLES
  if (a.project_id !== undefined) {
    const gate = await settingsProject(ctx, me, a.project_id)
    if (gate.state !== 'ok') return { state: gate.state }
    if (!canChangeAccess(me)) return refused(ACCESS_NEEDS_A_PERSON)
    if (!settingsRights(me, gate).can_change_lead) {
      return refused(gate.project.type === 'meta' ? NO_USER_MANAGEMENT : LEAD_ACCESS_NEEDED)
    }
  } else if (a.parent_id !== undefined) {
    // accessOf answers no level, so a missing parent, for a parent of
    // another organization or outside a meta tree, as the create's
    // projectLevel does, and also for one whose chain of parents is broken,
    // where projectLevel throws
    const parent = await byId(ctx, 'projects', a.parent_id)
    const check = await subProjectParent(ctx, me, parent, (p) => accessOf(ctx, me, [p]).level(p.id))
    if (check.state === 'missing') return { state: 'unavailable' }
    if (check.state === 'refused') return refused(check.refusal.data.message)
    if (!canChangeAccess(me)) return refused(ACCESS_NEEDS_A_PERSON)
  } else {
    const org = await byId(ctx, 'organizations', me.org_id)
    require(org !== null, notFound('organization not found'))
    if (!canCreateProjects(me, org.project_creators)) {
      return refused(projectCreationRefusal(org.project_creators))
    }
    if (!canChangeAccess(me)) return refused(ACCESS_NEEDS_A_PERSON)
    roles = NEW_PROJECT_LEAD_ROLES
  }
  if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' }
  const streams = roles.map((role) => indexAfter(profileRoleIndex(ctx, me.org_id, role), ask.after))
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: (reads) => mergeNamed(streams.map((stream) => stream(reads))),
    keep: async (profile: Doc<'profiles'>) =>
      profile.active && matches(nameKey(profile.name)) ? personRow(profile) : null,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/* ------------------------------------------------------ the invite form */

/** What projectSettings.inviteTarget answers: the gate's states, `refused`
 * when the caller may not invite, or the seat the address names in the
 * organization as a person row, null when none does, and that seat's grant
 * on the project, null when it holds none. */
export type InviteTarget =
  | { state: 'unavailable' }
  | { state: 'archived' }
  | { state: 'refused'; message: string }
  | { state: 'ready'; person: PersonRow | null; level: GrantLevel | null }

/**
 * projectSettings.inviteTarget for `me`: the seat the project's invite form
 * would reach with `email`, found as projects.inviteGuest finds it, by the
 * address's stored form (lib/email.ts asciiEmail), and its grant on the
 * project, the level the form sends as `expected`. settingsGate first, then
 * refused unless `me` may invite (SettingsRights can_invite), with the
 * demo's sentence or the write's. Refuses an address longer than
 * LIMITS.email with that limit's sentence. Two index ranges past the gate.
 */
export async function inviteTargetOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: { project_id: string; email: string },
): Promise<InviteTarget> {
  const email = asciiEmail(limitedText(LIMITS.email, a.email))
  const gate = await settingsProject(ctx, me, a.project_id)
  if (gate.state !== 'ok') return { state: gate.state }
  if (!settingsRights(me, gate).can_invite) {
    return refused(isDemoDeployment() ? DEMO_FEATURE_REFUSAL : NO_USER_MANAGEMENT)
  }
  const seat = await ctx.db
    .query('profiles')
    .withIndex('by_org_email', (q) => q.eq('org_id', me.org_id).eq('email', email))
    .first()
  if (seat === null) return { state: 'ready', person: null, level: null }
  const grant = await grantOn(ctx, gate.project.id, seat.id)
  return { state: 'ready', person: personRow(seat), level: grant?.level ?? null }
}
