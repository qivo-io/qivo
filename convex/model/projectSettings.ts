/* The reads behind a project's Settings page (projectSettings.ts): the
 * project's fields and the caller's rights on it, its Users and Teams access
 * lists, the Add team or user picker, the lead pickers and the invite form's
 * lookup of one address. The grant readers (userGrantBatch, teamShareBatch)
 * check no access, so REST and MCP project details can page grants with
 * them behind their own gate. Nothing here reads a task, a comment, a file
 * or a milestone. To decide whether a top-level project shows to a caller
 * without a level of their own for navigation, the gate reads the caller's
 * reach rows under it, once the organization's are complete, or else its
 * sub-projects, in one range, with the caller's own grants, memberships and
 * team shares (lib/access.ts accessOf); it reads nothing else about them. A
 * check a bound of those reads stopped answers `unavailable`. The project
 * lists of Settings (Settings › Projects and Archived projects) are in
 * model/projectSettingsLists.ts, which opens its cursors here
 * (orderedListAsk) and answers such a check with the access_unchecked
 * refusal instead, as the navigation reads do.
 *
 * One gate (settingsGate) decides who reads a project: whoever manages it
 * (canManageOwnProjectAccess) or sees it (lib/access.ts projectLevel,
 * navigation included, the rule behind canSeeProject). An organization
 * admin manages every project of their organization and sees only the
 * projects their own leads, grants and team shares reach, so the gate lets
 * them in by management, as the Settings project lists list every project
 * of an admin's organization by management (model/projectSettingsLists.ts).
 * get names its project by id or by its organization and number
 * (projectSettingsOf), and either form goes through the same gate with the
 * caller's seat in that organization. An unknown id, a free number, a
 * project of another organization, one in Deleted items, one outside a meta
 * tree and one the caller neither manages nor sees all answer
 * `unavailable`, so an answer tells nothing about a project the caller
 * cannot reach.
 *
 * Rights come from the writes' own rules (settingsRights), computed with
 * canManageOwnProjectAccess, the predicate those writes ask, never from the
 * caller's level. The lists are explicit
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

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  accessOf,
  canChangeAccess,
  canLeadProjects,
  inMetaTree,
  isAccessUnchecked,
  managesIn,
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
  besideHeld,
  compareIn,
  indexAfter,
  inGroup,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedAt,
  type NamedOrder,
  type NamedReads,
  type NamedTie,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
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
      accessible: boolean | null
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
 * manages `project` (canManageOwnProjectAccess) or sees it (lib/access.ts
 * projectLevel, navigation included) reads it. Answers `unavailable` for no
 * project, one of another organization or outside a meta tree, and one
 * `me` neither manages nor sees; `archived` for an archived project `me`
 * manages or sees; else `ok`. Each predicate runs once.
 *
 * Management is asked first, with lib/access.ts managesIn on the tree the
 * gate already read, so it reads nothing more and never depends on
 * ordinary access. The level then comes from lib/access.ts accessOf, which
 * answers projectLevel's level within bounded reads (OWN_READS): whether a
 * top-level project shows to `me` for navigation comes from the reach rows
 * of `me`'s seat and teams under it, a few rows, once the organization's
 * are complete, or else from its sub-projects (one range) and `me`'s own
 * grants, memberships and team shares, where projectLevel's walk reads
 * each sub-project's grant and team shares and, for each share, its team
 * and `me`'s membership, past Convex's 4,096 index ranges under a large
 * shared project. A check those bounds stopped (accessUnchecked) answers
 * `unavailable` to a caller who does not manage the project, as for a
 * project `me` cannot reach, and `level` and `accessible` null, unknown, to
 * one who does, whose page decides nothing by them. `accessible` is
 * accessOf's accessible, from the same reads, which asks nothing more of a
 * top-level project than its level did.
 *
 * A timing of projectSettings.get and projects.create on 7 November 2026 on
 * a local backend (8 vCPU, one call at a time), in one quiet session and
 * one beside 8 busy loops, with the organization's reach rows complete,
 * gave these figures for the whole call with its sign-in. On a top-level
 * project of 30 live and 40 archived sub-projects that an organization
 * admin reaches in none, projectSettings.get reads 13 ranges, 27 documents
 * and 0.01 MiB in 9 to 17 ms of JavaScript in both sessions and answers ok
 * by management with level null. A standard user with the same rows reads
 * 12 and 26 and gets unavailable, and the project's lead reads 5 and 3. The
 * gate reads the same for the admin and the standard user, and the admin's
 * one more range and document is the lead's profile that an ok answer
 * reads. On an everyday project the admin's read costs the same as the
 * standard user's, 9 ranges and 6 documents each (level user).
 * projects.create of a sub-project under the first project reads 18 ranges,
 * 83 documents and 0.03 MiB for the admin, who manages the parent and reads
 * no level, and 17 and 84 for the lead. The standard user, who neither
 * manages nor sees the parent, is refused after projectLevel's walk, in a
 * call of 149 ranges and 73 documents. Every call stayed at or under 60 ms
 * of JavaScript in the busy session, except one of the lead's creates at
 * 178 ms.
 *
 * A timing of projectSettings.get on 8 November 2026 at 8e501d53 on a
 * local backend on Boat (8 vCPU, one call at a time), in one quiet session
 * and one beside 8 busy loops, with the organization's reach rows
 * complete, gave these figures for the whole call with its sign-in.
 * projectSettings.get by number reads what it reads by id, call for call.
 * On a top-level project of 30 live and 40 archived sub-projects that an
 * organization admin reaches in none, the admin reads 13 ranges, 27
 * documents and 0.01 MiB and gets ok by management with level null, in 11
 * to 30 ms of JavaScript quiet and at most 73 ms busy. A standard user with
 * the same rows reads 12 and 26 and gets unavailable (at most 81 ms busy).
 * A member who sees it only for navigation through one sub-project shared
 * with one of their 3 teams reads 17 and 32 and gets level viewer (at most
 * 69 ms quiet, 100 ms busy), and an admin in the same teams reads the
 * same. The same member shape in 5 teams on an everyday project reads 19
 * and 49 (at most 43 ms quiet, 109 ms busy).
 */
export async function settingsGate(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'> | null,
): Promise<SettingsGate> {
  if (project === null || project.org_id !== me.org_id) return { state: 'unavailable' }
  const tree = await treeOf(ctx, project)
  if (tree === null) return { state: 'unavailable' }
  const manages = managesIn(me, project, tree.root)
  const read = tree.parent === null ? [project] : [project, tree.parent]
  const access = accessOf(ctx, me, read)
  let level: AccessLevel | null = null
  let accessible: boolean | null = null
  try {
    level = await access.level(project.id)
    accessible = await access.accessible(project.id)
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    if (!manages) return { state: 'unavailable' }
    level = null
    accessible = null
  }
  if (level === null && !manages) return { state: 'unavailable' }
  if (project.archived_at !== undefined) return { state: 'archived', project, parent: tree.parent }
  return { state: 'ok', project, ...tree, level, accessible, manages }
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
   * tracking (model/projects.ts updateProjectCore, assertManages) */
  can_edit: boolean
  /** projects.update of lead_id: a person, and canManageProjectUsers for a
   * top-level project, assertManages for a sub-project */
  can_change_lead: boolean
  /** projects.setAccess and removeAccess for a person
   * (model/projectAccess.ts assertManagesAccess) */
  can_manage_users: boolean
  /** projects.setAccess and removeAccess for a team (assertManagesAccess) */
  can_manage_teams: boolean
  /** projects.inviteGuest: not in the demo, and canManageProjectUsers */
  can_invite: boolean
  /** projects.archive (model/projects.ts archiveProjectCore, assertManages) */
  can_archive: boolean
  /** projects.deleteDeep and removalSummary: canManageOwnProjectAccess */
  can_delete: boolean
  /** projects.create of a sub-project under this one (model/projects.ts
   * subProjectParent): management of a top-level meta that is not
   * archived. The write checks only that the parent is a meta, so it would
   * also take a legacy meta row with a parent, which nobody could then
   * reach; this flag is stricter and asks for a top-level one. */
  can_create_sub_project: boolean
}

/**
 * `me`'s rights on the project of `gate` (SettingsRights). Every management
 * right is canManageOwnProjectAccess (`gate.manages`), and every write these
 * rights offer asks that predicate too (model/projects.ts assertManages and
 * subProjectParent, projects.deleteDeep and removalSummary, and
 * model/projectAccess.ts for access changes), so an organization admin who
 * takes part in no project of the organization is offered exactly the
 * writes that go through. The caller's level decides none of them.
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
       * right, null where they hold none or, for a caller who manages the
       * project, where a bound stopped the check. An organization admin's
       * level is their ordinary one, as anyone's. */
      level: AccessLevel | null
      /** whether the caller sees the project for a reason other than
       * navigation to one of its sub-projects (lib/access.ts
       * canAccessProject), which every sub-project of a top-level project
       * inherits: the New sub-project dialog says from it whether the
       * creator will see the new sub-project. Null, unknown, where a bound
       * stopped the check of a caller who manages the project. */
      accessible: boolean | null
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

/** How projectSettings.get names its project: by `id` alone, or by its
 * organization `org_id` and its number `num` there. */
export type SettingsAsk = { id?: string; org_id?: string; num?: number }

/** The refusal of any other form of get's arguments, in the words of
 * projectNav.resolve's (model/projectNavReads.ts RESOLVE_FORM). */
export const SETTINGS_FORM = 'get takes id alone, or org_id with num, a whole number of at least 1'

/* Whether `n` is a whole number of at least 1. */
const wholeNumber = (n: number | undefined): n is number =>
  n !== undefined && Number.isInteger(n) && n >= 1

/**
 * projectSettings.get: the settings of the project `ask` names for the
 * caller's seat in its organization (`myProfiles`, the caller's active
 * seats by organization), as `milestones.get` resolves a seat. Refuses with
 * badRequest, before it reads anything, every form but `id` alone and
 * `org_id` with `num`, a whole number of at least 1, as projectNav.resolve
 * does. By id it reads the project and takes the seat in its organization.
 * By number it takes the seat in `org_id` first, reads nothing without
 * one, and then reads the project by its number there (projects
 * by_org_num, which the organization's counter keeps unique, so a second
 * row throws rather than choose one). Either way settingsGate decides with
 * that seat, so whoever sees the project or manages it reads it, and the
 * answer has the same shape. No seat, no project and every project the
 * gate answers `unavailable` for answer alike, so a hidden number tells
 * nothing a free one would not. It reads the project, its parent, the
 * caller's level and management right and the lead's profile, never a
 * task.
 *
 * Timed on 8 November 2026 at 8e501d53 on a local backend on Boat (8 vCPU,
 * one call at a time), in one quiet session and one beside 8 busy loops,
 * for the whole call with its sign-in. The `{ org_id, num }` form reads
 * what the `{ id }` form reads for every caller timed, call for call
 * (settingsGate has the design-size cases). A member in 3 teams on an
 * everyday project and an admin with the same rows each read 9 ranges, 6
 * documents and 0.002 MiB in 11 to 30 ms of JavaScript quiet and at most
 * 57 ms busy. A free number reads 4 ranges and 1 document, the sign-in's
 * reads plus one by_org_num range, and answers unavailable in at most 50
 * ms of JavaScript in either session.
 */
export async function projectSettingsOf(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  ask: SettingsAsk,
): Promise<ProjectSettings> {
  const byNumber = ask.org_id !== undefined || ask.num !== undefined
  if (ask.id !== undefined ? byNumber : !wholeNumber(ask.num) || ask.org_id === undefined)
    throw badRequest(SETTINGS_FORM)
  let project: Doc<'projects'> | null = null
  let me: Doc<'profiles'> | undefined
  if (ask.id !== undefined) {
    project = await byId(ctx, 'projects', ask.id)
    me = project === null ? undefined : myProfiles.get(project.org_id)
  } else if (ask.org_id !== undefined && ask.num !== undefined) {
    const { org_id, num } = ask
    me = myProfiles.get(org_id)
    if (me !== undefined)
      project = await ctx.db
        .query('projects')
        .withIndex('by_org_num', (q) => q.eq('org_id', org_id).eq('num', num))
        .unique()
  }
  if (me === undefined || project === null) return { state: 'unavailable' }
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
    accessible: gate.accessible,
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
 * and the positions the batch reads between, a lib/namedPages.ts BatchAsk
 * with the search. The positions' tie is one id unless the list orders by
 * more (orderedListAsk). */
export type ListAsk<Tie extends NamedTie = IdTie> = {
  list: string
  scope: readonly string[]
  search: string
  after: NamedAt<Tie> | null
  through: NamedAt<Tie> | null
}

/** The refusal of an `after` or `through` that is not a cursor of this
 * list for the same arguments and search. */
const NOT_LIST_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same project and search; start again from the first batch'

/** The tie of a position of an index that orders equal name keys by one id,
 * or null for any other shape. */
export const idTieOf = ({ tie }: NamedAt): IdTie | null => {
  const [id] = tie
  return tie.length === 1 && typeof id === 'string' ? [id] : null
}

/**
 * The arguments of list `list` checked and opened, for `scope`, which the
 * normalized search ends, for a list whose positions tie on one id
 * (orderedListAsk with idTieOf). `known` refuses a key the list never
 * hands out, such as one without its group mark.
 */
export async function listAsk(
  list: string,
  scope: readonly string[],
  a: ListArgs,
  known: (key: string) => boolean = () => true,
): Promise<ListAsk> {
  return await orderedListAsk(list, scope, a, {
    tieOf: (at) => (known(at.key) ? idTieOf(at) : null),
  })
}

/**
 * The arguments of list `list` checked and opened, for `scope`, which the
 * normalized search ends. Refuses a search longer than LIMITS.search with
 * that limit's sentence, and with badRequest (`o.refusal`, a sentence of
 * this module's lists by default) an `after` or `through` that is not a
 * cursor this list gave for the same scope and search, or whose position
 * `o.tieOf` refuses (a tie of another shape, a key the list never hands
 * out), and a `through` that does not come after `after` in `o.order`, the
 * direction the list reads in, ascending by default. Two searches with one
 * name key, such as "Café" and "cafe", share cursors, since they match the
 * same rows. Settings' project lists (model/projectSettingsLists.ts) open
 * their cursors here, Archived projects' descending.
 */
export async function orderedListAsk<Tie extends NamedTie>(
  list: string,
  scope: readonly string[],
  a: ListArgs,
  o: { tieOf: (at: NamedAt) => Tie | null; order?: NamedOrder; refusal?: string },
): Promise<ListAsk<Tie>> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const sealed = [...scope, nameKey(search)]
  const open = async (text: string | undefined): Promise<NamedAt<Tie> | null> => {
    if (text === undefined) return null
    const at = await openNamedCursor(text, list, sealed)
    const tie = at === null ? null : o.tieOf(at)
    if (at === null || tie === null) throw badRequest(o.refusal ?? NOT_LIST_CURSOR)
    return { key: at.key, tie }
  }
  const after = await open(a.after)
  const through = await open(a.through)
  if (after !== null && through !== null && compareIn(o.order ?? 'asc', through, after) <= 0) {
    throw badRequest('through must be a cursor after the one in after')
  }
  return { list, scope: sealed, search, after, through }
}

/** What a grant reader answers: `not_ready` while the organization's rows
 * are not all name keyed, else one batch. */
export type GrantBatch<Row> = { state: 'not_ready' } | ({ state: 'ready' } & ListBatch<Row>)

/** The most grants or shares without a name key on one project that a
 * list checks before it reads in name order (unkeyedOrphans). Past it the
 * list fails closed. Tests lower it. */
export const UNKEYED_MOST = { rows: 64 }

/* Whether every grant (or, for `shares`, team share) on `project` without
 * a copy of its name key belongs to a profile (or team) that is gone or in
 * another organization, which a list leaves out anyway. The walk in name
 * order does not read such rows (model/nameKeys.ts projectGrantIndex), and
 * they are only those a removed person or team left before the backfill
 * keyed the organization, until their removal's background steps clear
 * them. Reads at most UNKEYED_MOST.rows of them in one range, and one
 * lookup each. Answers false for a row whose profile or team is in the
 * organization, and past UNKEYED_MOST.rows, so the list fails closed
 * rather than leave such a row out unseen. */
async function unkeyedOrphans(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  kind: 'grants' | 'shares',
): Promise<boolean> {
  const most = UNKEYED_MOST.rows + 1
  const holders =
    kind === 'grants'
      ? (
          await ctx.db
            .query('project_access')
            .withIndex('by_project_name', (q) =>
              q.eq('project_id', project.id).eq('name_key', undefined),
            )
            .take(most)
        ).map((grant) => () => byId(ctx, 'profiles', grant.profile_id))
      : (
          await ctx.db
            .query('project_team_access')
            .withIndex('by_project_name', (q) =>
              q.eq('project_id', project.id).eq('name_key', undefined),
            )
            .take(most)
        ).map((share) => () => byId(ctx, 'teams', share.team_id))
  if (holders.length === most) return false
  for (const holder of holders) if ((await holder())?.org_id === project.org_id) return false
  return true
}

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
 * the organization's name keys itself (nameKeysReady), and that every grant
 * without a key is one it would leave out (unkeyedOrphans), so every caller
 * fails closed while keys are missing.
 */
export async function userGrantBatch(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  ask: ListAsk,
  o: { limit: number; ceiling: ReadCeiling; without?: string },
): Promise<GrantBatch<UserGrantRow>> {
  if (
    !(await nameKeysReady(ctx, project.org_id)) ||
    !(await unkeyedOrphans(ctx, project, 'grants'))
  )
    return { state: 'not_ready' }
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
  if (
    !(await nameKeysReady(ctx, project.org_id)) ||
    !(await unkeyedOrphans(ctx, project, 'shares'))
  )
    return { state: 'not_ready' }
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
 * assertNotLead): a legacy sub-project without a lead of its own shows its
 * parent's, which the app's Settings page marks as from the project, where
 * the app's planner shows only a project's own lead_id
 * (src/store/viewModels.ts withLead).
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

/* Whether `key` is a position of the Add team or user picker. */
const markedKey = (key: string): boolean => key.startsWith(TEAM_MARK) || key.startsWith(PERSON_MARK)

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
 * grant whose copy of the name key trails a rename or is missing.
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
  // the teams and people the project holds, by id, as its shares and
  // grants mark them; apart, since a team's client-chosen id can be a
  // person's
  const heldTeams = new Set<string>()
  const heldPeople = new Set<string>()
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
    if (!('org_role' in doc)) {
      if (heldTeams.has(doc.id) || !matches(nameKey(doc.name))) return null
      if (project !== null && (await guard.lookup(() => shareOn(ctx, project.id, doc.id))) !== null)
        return null
      return { type: 'team', id: doc.id, name: doc.name }
    }
    if (heldPeople.has(doc.id) || !doc.active || doc.id === without) return null
    if (!matches(nameKey(doc.name))) return null
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
            (doc) => ('org_role' in doc ? heldPeople : heldTeams).add(doc.id),
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
 *   checks in its order (subProjectParent), where a parent `me` cannot see,
 *   or whose check the bounds of lib/access.ts accessOf stopped, answers
 *   `unavailable` and the others are refused with the create's
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
    // where projectLevel throws; a check its bounds stopped answers the
    // same
    const parent = await byId(ctx, 'projects', a.parent_id)
    let check: Awaited<ReturnType<typeof subProjectParent>>
    try {
      check = await subProjectParent(ctx, me, parent, (p) => accessOf(ctx, me, [p]).level(p.id))
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      return { state: 'unavailable' }
    }
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
