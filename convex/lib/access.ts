// Indexed permission predicates over an already-resolved profile, plus the
// credential access rule, live credential check and login ban rule the
// machine surfaces share (end of file).
// Identity and active-seat checks belong to lib/functions.ts.

import type { ConvexError } from 'convex/values'
import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from './db'
import { type AccessLevel, type CredentialAccess, LEVEL_RANK, type OrgRole } from './enums'
import { badRequest, forbidden, notFound, type Refusal } from './functions'
import type { EventOwner } from './taskEvents'

export function levelRank(l: AccessLevel | null): number {
  // No grant ranks below every permission level.
  return l === null ? 0 : LEVEL_RANK[l]
}

// Viewer seats cannot exceed viewer access; a missing grant stays missing.
export function cappedLevel(role: OrgRole, level: AccessLevel | null): AccessLevel | null {
  if (role === 'viewer' && level !== null && LEVEL_RANK[level] > LEVEL_RANK.viewer) return 'viewer'
  return level
}

// Enumerate staff roles positively so new roles fail closed.
export function isOrgStaff(me: Pick<Doc<'profiles'>, 'org_role'>): boolean {
  return me.org_role === 'admin' || me.org_role === 'user'
}

// Resolve the root defensively: dangling parents and cycles fail closed.
export async function rootMetaOf(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>> {
  let current = project
  const seen = new Set<string>([project.id])
  while (current.parent_id !== undefined) {
    const parentId = current.parent_id
    const parent = await ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', parentId))
      .unique()
    if (parent === null || seen.has(parent.id)) {
      throw notFound('project not found')
    }
    seen.add(parent.id)
    current = parent
  }
  return current
}

/* The project fields that decide levels: the hierarchy and the leads. */
type LevelProject = Pick<Doc<'projects'>, 'id' | 'org_id' | 'type' | 'parent_id' | 'lead_id'>

/* Access lives on a top-level meta and its direct sub-projects, where `root`
 * is the project itself or the top-level project above it. A row outside
 * that tree, such as a top-level project that is not a meta or a sub-project
 * of a sub-project, carries no access for anyone, so the per-project
 * predicates and levelsFrom (behind projectLevelsForOrg and the levels of a
 * project item in Deleted items) hide it alike. */
function inMetaTree(project: LevelProject, root: LevelProject): boolean {
  return (
    root.parent_id === undefined &&
    root.type === 'meta' &&
    (project.id === root.id || project.parent_id === root.id)
  )
}

async function grantOn(ctx: QueryCtx, projectId: string, profileId: string) {
  return await ctx.db
    .query('project_access')
    .withIndex('by_project_profile', (q) =>
      q.eq('project_id', projectId).eq('profile_id', profileId),
    )
    .unique()
}

const higherLevel = (a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null =>
  levelRank(a) >= levelRank(b) ? a : b

// Guests participate through individual invitations, never through teams.
// Positively enumerate membership roles so future roles fail closed.
const receivesTeamAccess = (me: Doc<'profiles'>): boolean =>
  isOrgStaff(me) || me.org_role === 'viewer'

async function teamGrantOn(ctx: QueryCtx, me: Doc<'profiles'>, root: Doc<'projects'>) {
  if (!receivesTeamAccess(me)) return null
  let level: AccessLevel | null = null
  const grants = ctx.db
    .query('project_team_access')
    .withIndex('by_project', (q) => q.eq('project_id', root.id))
  for await (const grant of grants) {
    const team = await ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', grant.team_id))
      .unique()
    if (team === null || team.org_id !== me.org_id) continue
    const membership = await ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', team.id).eq('profile_id', me.id))
      .unique()
    if (membership !== null) level = higherLevel(level, grant.level)
  }
  return level
}

// Raw membership predicate; isTeamLeader adds the role and kind restriction.
async function leadsTeam(
  ctx: QueryCtx,
  profileId: string,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (teamId === null || teamId === undefined) return false
  const tm = await ctx.db
    .query('team_members')
    .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
    .unique()
  return tm?.is_leader ?? false
}

/** Whether a profile's role lets it lead a project. Guests may lead a
 * project they were explicitly invited to; viewers and unknown future roles
 * cannot. Creating a new top-level project follows the organization's
 * project_creators setting (lib/projectCreators.ts), and team administration
 * still requires organization staff. */
export const canLeadProjects = (me: Pick<Doc<'profiles'>, 'org_role'>): boolean =>
  me.org_role === 'admin' || me.org_role === 'user' || me.org_role === 'guest'

/* A named lead controls its project. A parent lead has Edit on children
 * with a different lead; legacy children without a lead use their parent's.
 * Team leadership never confers project authority. */
function isProjectLead(
  me: Doc<'profiles'>,
  project: Pick<LevelProject, 'lead_id'>,
  root: Pick<LevelProject, 'lead_id'>,
) {
  return canLeadProjects(me) && (project.lead_id ?? root.lead_id) === me.id
}

async function directLevel(ctx: QueryCtx, me: Doc<'profiles'>, project: Doc<'projects'>) {
  return higherLevel(
    (await grantOn(ctx, project.id, me.id))?.level ?? null,
    await teamGrantOn(ctx, me, project),
  )
}

/* The effective level of `me` on a live project, the one rule behind
 * canSeeProject and hasProjectLevel. includeNavigation: whether a parent
 * visible only for navigation to one of its sub-projects counts (it then
 * answers 'viewer'). */
export async function projectLevel(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  includeNavigation = true,
): Promise<AccessLevel | null> {
  const root = await rootMetaOf(ctx, project)
  const direct = (p: Doc<'projects'>) => directLevel(ctx, me, p)
  return await levelUnder(me, project, root, includeNavigation, {
    direct,
    // A child grant exposes its parent for navigation, without granting
    // permissions on siblings or control over the parent.
    navigates: async (parent) => {
      const children = ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', parent.id))
      for await (const child of children) {
        if (child.org_id !== me.org_id) continue
        if (isProjectLead(me, child, parent) || (await direct(child)) !== null) return true
      }
      return false
    },
  })
}

/* projectLevel's rule once `root` is known. `direct` gives the person's own
 * and team level on one project, and `navigates` whether a sub-project of
 * root `parent` is led by them or gives them a level of their own. */
async function levelUnder(
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  root: Doc<'projects'>,
  includeNavigation: boolean,
  {
    direct,
    navigates,
  }: {
    direct: (project: Doc<'projects'>) => Promise<AccessLevel | null>
    navigates: (parent: Doc<'projects'>) => Promise<boolean>
  },
): Promise<AccessLevel | null> {
  if (project.org_id !== me.org_id || root.org_id !== me.org_id) return null
  if (!inMetaTree(project, root)) return null
  if (me.org_role === 'admin' || isProjectLead(me, project, root)) return 'lead'
  let level = await direct(project)
  if (project.id !== root.id) {
    const inherited = isProjectLead(me, root, root) ? 'user' : await direct(root)
    level = higherLevel(level, inherited)
  } else if (level === null && includeNavigation && (await navigates(root))) {
    level = 'viewer'
  }
  return cappedLevel(me.org_role, level)
}

/* The cached promise of `key`, read once. */
function once<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let known = cache.get(key)
  if (known === undefined) {
    known = read()
    cache.set(key, known)
  }
  return known
}

/** projectLevel of `me` on the projects of one organization asked about one
 * at a time, each project, root and direct level read once. A caller that
 * needs a few hundred of an organization's thousands of projects reads only
 * those, where projectLevelsForOrg reads them all with every share of the
 * person's teams. Whether a parent shows for navigation is answered from
 * the person's grants and team shares, read once (accessRowsOf), and the
 * parent's sub-projects, as projectLevel's walk reads two or more ranges a
 * sub-project and passes Convex's 4,096 under a large parent. A missing
 * project, a dangling parent or a cycle answers null instead of throwing,
 * as projectLevelsForOrg hides them. `read` holds projects the caller
 * already read. */
export function projectLevelsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  read: readonly Doc<'projects'>[] = [],
) {
  const projects = new Map(read.map((p) => [p.id, Promise.resolve<Doc<'projects'> | null>(p)]))
  const project = (id: string) => once(projects, id, () => byId(ctx, 'projects', id))
  const direct = new Map<string, Promise<AccessLevel | null>>()
  const directOf = (p: Doc<'projects'>) => once(direct, p.id, () => directLevel(ctx, me, p))
  /* rootMetaOf over the cached reads, null where it throws */
  const rootOf = async (p: Doc<'projects'>) => {
    let current = p
    const seen = new Set([p.id])
    while (current.parent_id !== undefined) {
      const parent = await project(current.parent_id)
      if (parent === null || seen.has(parent.id)) return null
      seen.add(parent.id)
      current = parent
    }
    return current
  }
  /* the projects the person has a level of their own on */
  let ownLevels: Promise<Set<string>> | undefined
  const navigates = async (parent: Doc<'projects'>) => {
    ownLevels ??= accessRowsOf(ctx, me).then(
      ({ grants, shares }) => new Set([...grants, ...shares].map((g) => g.project_id)),
    )
    const [own, children] = await Promise.all([
      ownLevels,
      ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', parent.id))
        .collect(),
    ])
    return children.some(
      (child) =>
        child.org_id === me.org_id && (isProjectLead(me, child, parent) || own.has(child.id)),
    )
  }
  const levels = new Map<string, Promise<AccessLevel | null>>()
  return {
    /** The project with this id, of any organization, or null. */
    project,
    /** projectLevel on the project with this id, null when it is missing. */
    level: (id: string, includeNavigation = true) =>
      once(levels, `${includeNavigation}:${id}`, async () => {
        const p = await project(id)
        const root = p === null ? null : await rootOf(p)
        if (p === null || root === null) return null
        return await levelUnder(me, p, root, includeNavigation, { direct: directOf, navigates })
      }),
  }
}

export async function canSeeProject(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return (await projectLevel(ctx, me, project)) !== null
}

/* Access for a reason other than read-only navigation, the per-profile
 * counterpart of OrgProjectView.accessible. On a parent it means organization
 * admin, its lead, or an individual or team grant on the parent itself. On a
 * sub-project it equals canSeeProject. The project user list answers it for
 * every profile at once through projectLevelsForProfiles. */
export async function canAccessProject(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return (await projectLevel(ctx, profile, project, false)) !== null
}

// Recipient visibility uses the same permission rules, without an active-seat
// restriction: callers decide whether inactive recipients are eligible.
export async function profileCanSeeProject(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return await canSeeProject(ctx, profile, project)
}

/* Effective level is the highest leadership, individual or team grant,
 * capped by the org viewer ceiling. Unknown projects answer false. */
export async function hasProjectLevel(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  projectId: string,
  min: 'user' | 'lead' | 'admin',
): Promise<boolean> {
  const project = await ctx.db
    .query('projects')
    .withIndex('by_uuid', (q) => q.eq('id', projectId))
    .unique()
  if (project === null) return false
  return levelRank(await projectLevel(ctx, me, project)) >= levelRank(min)
}

/** The seat half of profileCanBeAssigned: an active profile whose role can
 * hold work. Positively enumerate eligible org roles so new roles fail
 * closed. */
export const canHoldWork = (profile: Pick<Doc<'profiles'>, 'active' | 'org_role'>): boolean =>
  profile.active && (isOrgStaff(profile) || profile.org_role === 'guest')

/* Assignment is new work: the recipient must be active and hold effective
 * Edit access, including inherited individual/team grants and leadership. */
export async function profileCanBeAssigned(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return canHoldWork(profile) && (await hasProjectLevel(ctx, profile, project.id, 'user'))
}

/* Only a person with an org staff role can lead a team. The kind is named
 * positively, so agents and any future kind never lead one. */
export function canLeadTeams(me: Doc<'profiles'>): boolean {
  return isOrgStaff(me) && me.kind === 'person'
}

/* Only a person changes who sees what: project access grants, a project's
 * lead and team membership and leadership. The kind is named positively, so
 * agents and any future kind cannot, whatever their role and grants. */
export function canChangeAccess(me: Pick<Doc<'profiles'>, 'kind'>): boolean {
  return me.kind === 'person'
}

export const ACCESS_NEEDS_A_PERSON = 'only people can change who has access, not agents'

/* Team leadership requires canLeadTeams and a same-org leader row; leader
 * rows held by guests, viewers or agents grant nothing. */
export async function isTeamLeader(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (teamId === null || teamId === undefined) return false
  if (!canLeadTeams(me)) return false
  const team = await ctx.db
    .query('teams')
    .withIndex('by_uuid', (q) => q.eq('id', teamId))
    .unique()
  if (team === null || team.org_id !== me.org_id) return false
  return await leadsTeam(ctx, me.id, teamId)
}

/* Only the named lead and organization administrators control permissions,
 * and nobody controls those of a project outside a meta tree (inMetaTree). */
export async function canManageOwnProjectAccess(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  if (!me.active || project.org_id !== me.org_id) return false
  const root = await rootMetaOf(ctx, project)
  return (
    root.org_id === me.org_id &&
    inMetaTree(project, root) &&
    (me.org_role === 'admin' || isProjectLead(me, project, root))
  )
}

export const canManageProjectUsers = canManageOwnProjectAccess

export const canManageProjectTeams = canManageProjectUsers

export type OrgProjectLevels = {
  levelOf: (project: Pick<Doc<'projects'>, 'id' | 'org_id'>) => AccessLevel | null
  /* true when levelOf answers 'viewer' only because the person can access
   * one of the project's sub-projects */
  navigationOnly: (projectId: string) => boolean
}

/** Every project of organization `orgId`, archived ones included, oldest
 * first. */
export const orgProjects = (ctx: QueryCtx, orgId: string): Promise<Doc<'projects'>[]> =>
  ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()

/* Amortized counterpart of projectLevel, used by snapshots and list reads.
 * Evaluate actual projects rather than reusing the parent's answer for all
 * siblings. Navigation-only parent visibility is never inherited back down.
 * Callers that already loaded the complete org project list can reuse it. */
export async function projectLevelsForOrg(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  loadedProjects?: readonly Doc<'projects'>[],
): Promise<OrgProjectLevels> {
  const [projects, { grants, shares }] = await Promise.all([
    loadedProjects ?? orgProjects(ctx, me.org_id),
    accessRowsOf(ctx, me),
  ])
  return levelsFrom(me, projects, grants, shares)
}

/** `me`'s own grants and the shares of the teams of its organization it
 * belongs to, the rows projectLevelsForOrg reads: shares only for a role
 * that receives team access. A caller that also needs the rows reads them
 * here once and passes them to levelsFrom. The teams are read at once, as
 * the memberships of a person in hundreds of teams would take as many
 * reads one after another. */
export async function accessRowsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
): Promise<{ grants: Doc<'project_access'>[]; shares: Doc<'project_team_access'>[] }> {
  const [grants, perTeam] = await Promise.all([
    ctx.db
      .query('project_access')
      .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
      .collect(),
    receivesTeamAccess(me)
      ? ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
          .collect()
          .then((memberships) =>
            Promise.all(
              memberships.map(async (membership) => {
                const team = await ctx.db
                  .query('teams')
                  .withIndex('by_uuid', (q) => q.eq('id', membership.team_id))
                  .unique()
                if (team === null || team.org_id !== me.org_id) return []
                return await ctx.db
                  .query('project_team_access')
                  .withIndex('by_team', (q) => q.eq('team_id', team.id))
                  .collect()
              }),
            ),
          )
      : [],
  ])
  return { grants, shares: perTeam.flat() }
}

/** How many membership rows projectLevelsForPeople reads from the
 * organization's teams before it reads each person's memberships alone
 * instead, so memberships of people it does not ask about cannot fill the
 * transaction. 4,000 is an eighth of Convex's 32,000 documents. Tests lower
 * it. */
export const LEVELS_READ = { max: 4000 }

/** projectLevelsForOrg for each of `people`, by profile id, over `projects`,
 * every project of one organization. Each person costs one index range for
 * their own grants. Their teams come from every membership of the
 * organization's teams, one range a team, when there are more people than
 * teams and those memberships are at most LEVELS_READ rows, and otherwise
 * from one range a person. Each team's shares are read once for everyone.
 * Removing a large team's access asked each member alone, about four ranges
 * before the change and four after, and passed Convex's 4,096. `guard`, when
 * given, runs before each read and after every GUARD_ROWS rows of it, so a
 * caller can stop before the reads fill the transaction
 * (model/projectAccess.ts removeAndSettle). */
export async function projectLevelsForPeople(
  ctx: QueryCtx,
  people: readonly Doc<'profiles'>[],
  projects: readonly Doc<'projects'>[],
  guard: () => Promise<void> = async () => {},
): Promise<Map<string, OrgProjectLevels>> {
  const out = new Map<string, OrgProjectLevels>()
  if (people.length === 0 || projects.length === 0) return out
  const orgId = projects[0].org_id
  const teams = await ctx.db
    .query('teams')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const orgTeams = new Set(teams.map((t) => t.id))
  const teamsOf =
    people.length > teams.length ? await teamsOfPeople(ctx, people, teams, guard) : null
  const sharesOfTeam = new Map<string, Doc<'project_team_access'>[]>()
  for (const person of people) {
    if (person.org_id !== orgId) {
      await guard()
      out.set(person.id, await projectLevelsForOrg(ctx, person, projects))
      continue
    }
    const grants = await guardedRows(
      ctx.db.query('project_access').withIndex('by_profile', (q) => q.eq('profile_id', person.id)),
      guard,
    )
    const shares: Doc<'project_team_access'>[] = []
    if (receivesTeamAccess(person)) {
      const mine = teamsOf
        ? (teamsOf.get(person.id) ?? [])
        : (
            await guardedRows(
              ctx.db
                .query('team_members')
                .withIndex('by_profile', (q) => q.eq('profile_id', person.id)),
              guard,
            )
          ).map((m) => m.team_id)
      for (const teamId of mine) {
        if (!orgTeams.has(teamId)) continue
        let teamShares = sharesOfTeam.get(teamId)
        if (teamShares === undefined) {
          teamShares = await guardedRows(
            ctx.db
              .query('project_team_access')
              .withIndex('by_team', (q) => q.eq('team_id', teamId)),
            guard,
          )
          sharesOfTeam.set(teamId, teamShares)
        }
        shares.push(...teamShares)
      }
    }
    out.set(person.id, levelsFrom(person, projects, grants, shares))
  }
  return out
}

/* How many rows projectLevelsForPeople reads between two runs of its guard:
 * well under the 5% of Convex's 32,000 documents a removal keeps
 * (model/projectAccess.ts REASSIGN_ROOM). */
const GUARD_ROWS = 500

/* Every row of `rows`, running `guard` before the first and after every
 * GUARD_ROWS more. */
async function guardedRows<T>(rows: AsyncIterable<T>, guard: () => Promise<void>): Promise<T[]> {
  const out: T[] = []
  await guard()
  for await (const row of rows) {
    out.push(row)
    if (out.length % GUARD_ROWS === 0) await guard()
  }
  return out
}

/* The ids of the teams among `teams` each of `people` belongs to, from every
 * membership of those teams, or null once that passes LEVELS_READ rows. */
async function teamsOfPeople(
  ctx: QueryCtx,
  people: readonly Doc<'profiles'>[],
  teams: readonly Doc<'teams'>[],
  guard: () => Promise<void>,
): Promise<Map<string, string[]> | null> {
  const ids = new Set(people.map((p) => p.id))
  const out = new Map<string, string[]>()
  let rows = 0
  for (const team of teams) {
    await guard()
    const memberships = ctx.db
      .query('team_members')
      .withIndex('by_team', (q) => q.eq('team_id', team.id))
    for await (const { profile_id } of memberships) {
      if (++rows > LEVELS_READ.max) return null
      if (rows % GUARD_ROWS === 0) await guard()
      if (ids.has(profile_id)) out.set(profile_id, [...(out.get(profile_id) ?? []), team.id])
    }
  }
  return out
}

/** The levels `me` holds on `projects`, the pure part of
 * projectLevelsForOrg. `grants` are `me`'s own grants and `shares` the
 * shares of the teams `me` belongs to (counted only for roles that receive
 * team access); each project gets the higher of the two. A project item in
 * Deleted items is evaluated over its stored rows the same way
 * (model/deletedItems.ts). */
export function levelsFrom(
  me: Doc<'profiles'>,
  projects: readonly LevelProject[],
  grants: Iterable<Pick<Doc<'project_access'>, 'project_id' | 'level'>>,
  shares: Iterable<Pick<Doc<'project_team_access'>, 'project_id' | 'level'>>,
): OrgProjectLevels {
  const byUuid = new Map(projects.map((p) => [p.id, p]))
  const levels = new Map<string, AccessLevel>()
  const add = (g: { project_id: string; level: AccessLevel }) =>
    levels.set(g.project_id, higherLevel(levels.get(g.project_id) ?? null, g.level) ?? g.level)
  for (const grant of grants) add(grant)
  if (receivesTeamAccess(me)) for (const share of shares) add(share)
  const effective = new Map<string, AccessLevel | null>()
  for (const project of projects) {
    const root = project.parent_id === undefined ? project : byUuid.get(project.parent_id)
    if (!root || !inMetaTree(project, root)) continue
    let level = levels.get(project.id) ?? null
    if (me.org_role === 'admin' || isProjectLead(me, project, root)) level = 'lead'
    else if (project.id !== root.id) {
      level = higherLevel(
        level,
        isProjectLead(me, root, root) ? 'user' : (levels.get(root.id) ?? null),
      )
    }
    effective.set(project.id, cappedLevel(me.org_role, level))
  }
  const navigation = new Set<string>()
  for (const project of projects) {
    if (
      project.parent_id &&
      effective.get(project.id) != null &&
      effective.get(project.parent_id) === null
    ) {
      effective.set(project.parent_id, 'viewer')
      navigation.add(project.parent_id)
    }
  }
  return {
    levelOf: (project) =>
      project.org_id === me.org_id ? (effective.get(project.id) ?? null) : null,
    navigationOnly: (projectId) => navigation.has(projectId),
  }
}

/** The level every profile of `project`'s organization holds on it, leaving
 * out the read-only navigation a parent gets from its sub-projects. It is
 * projectLevel(ctx, profile, project, false) for many profiles at once, so a
 * profile with a level is one canAccessProject admits, and one at User or
 * above passes hasProjectLevel 'user'. It reads the individual grants and
 * team shares on the project and its root, and each sharing team, a few
 * index ranges however many profiles it answers. The per-profile walk read
 * each profile's own grants and team memberships, about two ranges per
 * profile plus one per sharing team, so the project user list of a large
 * organization passed Convex's 4,096. A profile of another organization, and
 * every profile on a project whose root is in another organization, gets
 * null. A missing parent or a cycle throws not found, as in rootMetaOf. */
export async function projectLevelsForProfiles(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<(profile: Doc<'profiles'>) => AccessLevel | null> {
  const root = await rootMetaOf(ctx, project)
  if (root.org_id !== project.org_id) return () => null
  const tree = project.id === root.id ? [project] : [root, project]
  type Level = Pick<Doc<'project_access'>, 'project_id' | 'level'>
  // each profile's grants, and each share once for every member of its
  // team, as levelsFrom takes them
  const grantsOf = new Map<string, Level[]>()
  const sharesOf = new Map<string, Level[]>()
  const add = (to: Map<string, Level[]>, profileId: string, level: Level) => {
    const held = to.get(profileId)
    if (held === undefined) to.set(profileId, [level])
    else held.push(level)
  }
  const teamMembers = new Map<string, string[]>()
  for (const { id } of tree) {
    const grants = ctx.db
      .query('project_access')
      .withIndex('by_project', (q) => q.eq('project_id', id))
    for await (const grant of grants) add(grantsOf, grant.profile_id, grant)
    const teamShares = ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', id))
    for await (const share of teamShares) {
      let members = teamMembers.get(share.team_id)
      if (members === undefined) {
        members = await sameOrgTeamMembers(ctx, share.team_id, project.org_id)
        teamMembers.set(share.team_id, members)
      }
      for (const profileId of members) add(sharesOf, profileId, share)
    }
  }
  return (profile) => {
    if (profile.org_id !== project.org_id) return null
    const { levelOf, navigationOnly } = levelsFrom(
      profile,
      tree,
      grantsOf.get(profile.id) ?? [],
      sharesOf.get(profile.id) ?? [],
    )
    return navigationOnly(project.id) ? null : levelOf(project)
  }
}

/** How many grant and team membership rows projectSightForProfiles reads
 * for one project before it asks each profile about the rest alone. A
 * fan-out keeps about 5% of each limit for one follower, 1,600 of Convex's
 * 32,000 documents, and the project's first follower pays this read. Tests
 * lower it. */
export const SIGHT_READ = { max: 1000 }

/** canSeeProject for many profiles of `project`'s organization, for a write
 * that notifies many followers. It reads the grants and team shares on the
 * project and its root, each sharing team and its members once, so a
 * profile then costs no index range. Past SIGHT_READ rows, the grants of a
 * project, or the members of a team, it did not read in full are looked up
 * for each profile instead: one range for each such project, and one for
 * the profile's memberships if any such team remains. canSeeProject costs a
 * few ranges for each profile and two more for each team sharing the
 * project, and a fan-out of some hundreds of followers each asked alone
 * passed Convex's 4,096 ranges or its 1 s. A top-level project also shows
 * to someone who reaches only one of its sub-projects, which this leaves
 * out, so on one a profile without a level of its own is asked alone
 * (canSeeProject). Tasks live in sub-projects only. Each profile's answer
 * is kept. A missing parent or a cycle throws not found, as in rootMetaOf. */
export async function projectSightForProfiles(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<(profile: Doc<'profiles'>) => Promise<boolean>> {
  const root = await rootMetaOf(ctx, project)
  const tree = project.id === root.id ? [project] : [root, project]
  let rest = SIGHT_READ.max
  // up to the rest of the budget, null when that is not all of them
  const inFull = async <T>(rows: { take: (n: number) => Promise<T[]> }): Promise<T[] | null> => {
    const read = await rows.take(rest + 1)
    if (read.length > rest) {
      rest = 0
      return null
    }
    rest -= read.length
    return read
  }
  type Level = Pick<Doc<'project_access'>, 'project_id' | 'level'>
  // each project's grants by profile, null for a project read per profile
  const grantsOn = new Map<string, Map<string, Level> | null>()
  for (const { id } of tree) {
    const read = await inFull(
      ctx.db.query('project_access').withIndex('by_project', (q) => q.eq('project_id', id)),
    )
    grantsOn.set(id, read && new Map(read.map((grant) => [grant.profile_id, grant])))
  }
  // the shares of the teams teamGrantOn counts, and each such team's
  // members, null for a team read per profile
  const sharesOf = new Map<string, Level[]>()
  const membersOf = new Map<string, Set<string> | null>()
  const skipped = new Set<string>()
  for (const { id } of tree) {
    const shares = await ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', id))
      .collect()
    for (const share of shares) {
      if (skipped.has(share.team_id)) continue
      if (!membersOf.has(share.team_id)) {
        const team = await ctx.db
          .query('teams')
          .withIndex('by_uuid', (q) => q.eq('id', share.team_id))
          .unique()
        if (team === null || team.org_id !== project.org_id) {
          skipped.add(share.team_id)
          continue
        }
        const members = await inFull(
          ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', team.id)),
        )
        membersOf.set(team.id, members && new Set(members.map((m) => m.profile_id)))
      }
      const held = sharesOf.get(share.team_id)
      if (held === undefined) sharesOf.set(share.team_id, [share])
      else held.push(share)
    }
  }
  const someTeamUnread = [...membersOf.values()].includes(null)
  const sees = async (profile: Doc<'profiles'>): Promise<boolean> => {
    if (profile.org_id !== project.org_id || root.org_id !== project.org_id) return false
    const grants: Level[] = []
    for (const { id } of tree) {
      const read = grantsOn.get(id)
      const grant = read ? read.get(profile.id) : await grantOn(ctx, id, profile.id)
      if (grant) grants.push(grant)
    }
    const joined = new Set<string>()
    if (someTeamUnread) {
      const memberships = ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
      for await (const { team_id } of memberships) joined.add(team_id)
    }
    const shares: Level[] = []
    for (const [teamId, members] of membersOf) {
      if (members ? members.has(profile.id) : joined.has(teamId))
        shares.push(...(sharesOf.get(teamId) ?? []))
    }
    const { levelOf, navigationOnly } = levelsFrom(profile, tree, grants, shares)
    if (!navigationOnly(project.id) && levelOf(project) !== null) return true
    return project.parent_id === undefined && (await canSeeProject(ctx, profile, project))
  }
  const known = new Map<string, Promise<boolean>>()
  return (profile) => {
    let answer = known.get(profile.id)
    if (answer === undefined) {
      answer = sees(profile)
      known.set(profile.id, answer)
    }
    return answer
  }
}

/* The profile ids of team `teamId`, or none when the team is gone or belongs
 * to another organization than `orgId`, the teams teamGrantOn skips. */
async function sameOrgTeamMembers(ctx: QueryCtx, teamId: string, orgId: string): Promise<string[]> {
  const team = await ctx.db
    .query('teams')
    .withIndex('by_uuid', (q) => q.eq('id', teamId))
    .unique()
  if (team === null || team.org_id !== orgId) return []
  const members = await ctx.db
    .query('team_members')
    .withIndex('by_team', (q) => q.eq('team_id', teamId))
    .collect()
  return members.map((member) => member.profile_id)
}

/* Staff may add organization labels when any meta grants user standing,
 * including explicit team sharing. Renaming, recoloring and deleting follow
 * canManageOrgLabels. */
export async function canWriteOrgLabels(ctx: QueryCtx, me: Doc<'profiles'>): Promise<boolean> {
  if (!isOrgStaff(me)) return false
  if (me.org_role === 'admin') return true
  const { levelOf: levelForRoot } = await projectLevelsForOrg(ctx, me)
  const orgProjects = ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', me.org_id))
  for await (const p of orgProjects) {
    if (p.type === 'meta' && levelRank(levelForRoot(p)) >= LEVEL_RANK.user) return true
  }
  return false
}

/* Only organization admins rename, recolor or delete labels, as on the app's
 * admin-only Labels settings page. */
export function canManageOrgLabels(me: Doc<'profiles'>): boolean {
  return me.active && me.org_role === 'admin'
}

/* -------------------------------------------------------- credential access
 * What a machine credential lets its holder do, 'read' or 'write'. It is the
 * credential's own ceiling, and a person still needs their role's project
 * rules to write anything. REST, MCP and webhooks all ask credentialAccess, and
 * every branch names the writing case positively, so a missing field, an
 * unknown role or a new credential kind can only read. */

/** A resolved machine credential, keyed by its table like an EventOwner. */
export type AccessCredential =
  | {
      table: 'mcp_tokens'
      token: Pick<Doc<'mcp_tokens'>, 'access' | 'expires_at'>
      /** epoch milliseconds the expiry is judged against */
      now: number
    }
  | { table: 'oauth_connections'; scopes: readonly string[] }
  | { table: 'agent_keys' }

/**
 * The credential's access. A personal token writes only when it was created
 * with write access and has not expired; an OAuth grant only with both
 * qivo:read and qivo:write; an agent key only for a Standard user agent.
 */
export function credentialAccess(
  credential: AccessCredential,
  profile: Pick<Doc<'profiles'>, 'kind' | 'org_role'>,
): CredentialAccess {
  switch (credential.table) {
    case 'mcp_tokens':
      return profile.kind === 'person' &&
        credential.token.access === 'write' &&
        !tokenExpired(credential.token, credential.now)
        ? 'write'
        : 'read'
    case 'oauth_connections':
      return profile.kind === 'person' &&
        credential.scopes.includes('qivo:read') &&
        credential.scopes.includes('qivo:write')
        ? 'write'
        : 'read'
    case 'agent_keys':
      return profile.kind === 'agent' && profile.org_role === 'user' ? 'write' : 'read'
    default:
      return 'read'
  }
}

/**
 * What a machine caller may do right now. It is the access its credential
 * was resolved with, narrowed for an agent by its live role, which can change
 * between authentication and dispatch. asMachineCaller refuses a write unless
 * this is 'write', and get_me reports it.
 */
export function machineAccess(
  profile: Pick<Doc<'profiles'>, 'kind' | 'org_role'>,
  access: CredentialAccess,
): CredentialAccess {
  const live =
    profile.kind === 'agent' ? credentialAccess({ table: 'agent_keys' }, profile) : 'write'
  return access === 'write' && live === 'write' ? 'write' : 'read'
}

/**
 * Whether Qivo sends `profile` inbox messages and makes it a follower. Every
 * person has an inbox. An agent has one only while it is active and its key
 * can write, because a Viewer or Inactive agent can never mark a message
 * read or remove it, so its unread messages would pile up for good. An
 * unknown kind gets no inbox.
 */
export function keepsInbox(
  profile: Pick<Doc<'profiles'>, 'kind' | 'org_role' | 'active'>,
): boolean {
  switch (profile.kind) {
    case 'person':
      return true
    case 'agent':
      return profile.active && credentialAccess({ table: 'agent_keys' }, profile) === 'write'
    default:
      return false
  }
}

/**
 * Whether a personal token has expired at `now` (epoch milliseconds). A
 * token without an expiry never expires; an unreadable one counts as expired.
 */
export function tokenExpired(token: Pick<Doc<'mcp_tokens'>, 'expires_at'>, now: number): boolean {
  if (token.expires_at === undefined) return false
  return !(Date.parse(token.expires_at) > now)
}

/**
 * The credential row a machine request or webhook subscription is bound to,
 * while it still authorizes. It must be the exact record the lookup found
 * (app uuids may be reused after deletion), still belong to the same
 * profile, not be revoked and, for a personal token, not have expired at
 * `now` (epoch milliseconds). Null otherwise. touchCredential, get_me and
 * webhook ownership all use this one check.
 */
export function liveCredentialRow<T extends EventOwner['credential_table']>(
  ctx: QueryCtx,
  owner: EventOwner & { credential_table: T },
  now: number,
): Promise<Doc<T> | null>
export async function liveCredentialRow(
  ctx: QueryCtx,
  owner: EventOwner,
  now: number,
): Promise<Doc<EventOwner['credential_table']> | null> {
  const row = await byId(ctx, owner.credential_table, owner.credential_id)
  if (
    row === null ||
    row._id !== owner.credential_row_id ||
    row.profile_id !== owner.profile_id ||
    row.revoked_at !== undefined ||
    ('token_hash' in row && tokenExpired(row, now))
  )
    return null
  return row
}

/** The ban columns Better Auth's admin plugin keeps on its user row. */
export type LoginBan = { banned?: boolean | null; banExpires?: number | null }

/**
 * Whether a platform ban on a login is in force at `now` (epoch
 * milliseconds). A ban without `banExpires` never ends. Once `banExpires`
 * has passed the ban no longer counts, even though Better Auth clears the
 * flag only at the login's next sign-in. Personal tokens, OAuth grants,
 * webhook ownership and account appearance all decide with this rule.
 */
export function loginBanned(user: LoginBan, now: number): boolean {
  return user.banned === true && (user.banExpires == null || user.banExpires > now)
}

/**
 * The Better Auth user row behind a login, or null when Better Auth no
 * longer has it. Each call is a query into the Better Auth component, one
 * more read than the app's own tables, so callers make it after their
 * cheaper checks pass.
 */
export async function findAuthUser(ctx: QueryCtx, authUserId: string): Promise<LoginBan | null> {
  return (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: authUserId }],
  })) as LoginBan | null
}

export const VIEWER_AGENT_READS_ONLY = 'this agent is a Viewer and can only read'
export const CREDENTIAL_READS_ONLY = 'this credential can only read'

/** The refusal for a write through a credential that can only read. */
export function readOnlyRefusal(profile: Pick<Doc<'profiles'>, 'kind'>): ConvexError<Refusal> {
  return forbidden(profile.kind === 'agent' ? VIEWER_AGENT_READS_ONLY : CREDENTIAL_READS_ONLY)
}

const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * A personal token expiry as stored, normalized to toISOString's form so it
 * sorts like every other timestamp. Refuses anything but a real UTC
 * date-time such as 2027-01-31T00:00:00Z (no offsets, no rolled-over days).
 */
export function cleanTokenExpiry(value: string): string {
  const at = UTC_DATE_TIME.test(value) ? new Date(value) : null
  const iso = at !== null && !Number.isNaN(at.getTime()) ? at.toISOString() : null
  if (iso === null || iso.slice(0, 19) !== value.slice(0, 19)) {
    throw badRequest('expires_at must be a UTC date-time such as 2027-01-31T00:00:00Z')
  }
  return iso
}
