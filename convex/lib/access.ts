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

/** When projectLevelsOf reads a person's own rows at once instead of asking
 * project by project. After `steps` projects asked about one by one it reads
 * their grants and their memberships, each while they are at most as many
 * rows as projects asked, as a range costs about as much as two or three
 * rows; and then the shares of their teams, while those teams are at most
 * as many as the projects asked, at most `teams` (one range a team, which
 * one batch of a part can afford past its budget check, lib/workspaceParts.ts
 * PAGE.batch and PAGE.hard), and their shares at most `rows`. Membership is
 * asked team by team for the first `lookups` teams, then from all their
 * memberships. Navigation asks whether each team of the person, or each
 * team their known shares name, is the organization's, and from `manyTeams`
 * such teams not asked yet reads the organization's teams in one range
 * instead, while they are at most `orgTeams` for each of those teams and at
 * most `orgTeamsMost` and at most `bytes` as JSON, as a legacy team icon has
 * no length limit and the part's hard budget counts this read too. Past
 * any bound it asks team by team. Tests change them. */
export const OWN_READS = {
  steps: [32, 128, 512],
  lookups: 64,
  rows: 1000,
  teams: 256,
  manyTeams: 8,
  orgTeams: 16,
  orgTeamsMost: 4000,
  bytes: 512 * 1024,
}

/** projectLevel of `me` on the projects of one organization asked about one
 * at a time, each project, root and direct level read once. A caller that
 * needs a few hundred of an organization's thousands of projects reads only
 * those, where projectLevelsForOrg reads them all with every share of the
 * person's teams. A caller that asks about many projects reads the person's
 * own rows once instead of once a project (OWN_READS): their grants, their
 * memberships and the shares of their teams, each team a share names checked
 * once (teamInOrg). Whether a parent shows for navigation is answered from
 * the person's grants and team shares (accessRowsOf's rows) and the parent's
 * sub-projects, as projectLevel's walk reads two or more ranges a
 * sub-project and passes Convex's 4,096 under a large parent; those rows
 * then answer every project, and a person in many teams reads the
 * organization's teams in one range. A missing project, a dangling parent or
 * a cycle answers null instead of throwing, as projectLevelsForOrg hides
 * them. `read` holds projects the caller already read. */
export function projectLevelsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  read: readonly Doc<'projects'>[] = [],
) {
  const projects = new Map(read.map((p) => [p.id, Promise.resolve<Doc<'projects'> | null>(p)]))
  const project = (id: string) => once(projects, id, () => byId(ctx, 'projects', id))
  /* what the reads of the person's own rows cost so far, the same for every
   * part of the person */
  const shared = { ranges: 0, documents: 0, bytes: 0 }
  const counted = <R>(rows: R[]) => {
    shared.ranges += 1
    shared.documents += rows.length
    for (const row of rows) shared.bytes += JSON.stringify(row).length
    return rows
  }
  /* `promise`, marked handled: a read that fails fails every answer that
   * awaits it, and none left unawaited rejects unhandled */
  const handled = <P extends Promise<unknown>>(promise: P) => {
    promise.catch(() => {})
    return promise
  }
  /* the rows of `query`, or null when it holds more than `most` */
  const atMost = <R>(query: { take(n: number): Promise<R[]> }, most: number) =>
    query
      .take(most + 1)
      .then(counted)
      .then((rows) => (rows.length > most ? null : rows))
  /* atMost for rows of any size: also null past OWN_READS.bytes, read row
   * by row, as take() reads, so it stops at the first row past either
   * bound */
  const atMostBytes = async <R>(query: AsyncIterable<R>, most: number) => {
    const rows: R[] = []
    let bytes = 0
    shared.ranges += 1
    for await (const row of query) {
      const size = JSON.stringify(row).length
      shared.documents += 1
      shared.bytes += size
      bytes += size
      rows.push(row)
      if (rows.length > most || bytes > OWN_READS.bytes) return null
    }
    return rows
  }
  const grantRows = () =>
    ctx.db.query('project_access').withIndex('by_profile', (q) => q.eq('profile_id', me.id))
  const memberRows = () =>
    ctx.db.query('team_members').withIndex('by_profile', (q) => q.eq('profile_id', me.id))
  /* all the person's grants by project, and the ids of all their teams,
   * once read */
  let grants: Map<string, Doc<'project_access'>[]> | undefined
  let teams: Set<string> | undefined
  /* grantOn's level on the project with this id */
  const grantLevel = async (id: string): Promise<AccessLevel | null> => {
    if (grants === undefined) return (await grantOn(ctx, id, me.id))?.level ?? null
    const rows = grants.get(id) ?? []
    // grantOn reads with unique(), which throws on a second row
    if (rows.length > 1) throw new Error('more than one grant of one person on one project')
    return rows[0]?.level ?? null
  }
  /* whether the person is a member of the team with this id, each team
   * asked once: by the team for the first OWN_READS.lookups teams, then
   * from all their memberships, read once */
  const member = new Map<string, Promise<boolean>>()
  let allTeams: Promise<void> | undefined
  const isMember = (teamId: string) =>
    once(member, teamId, async () => {
      if (teams === undefined && member.size > OWN_READS.lookups) {
        allTeams ??= memberRows()
          .collect()
          .then(counted)
          .then((rows) => {
            teams ??= new Set(rows.map((m) => m.team_id))
          })
        await allTeams
      }
      if (teams !== undefined) return teams.has(teamId)
      return (
        (await ctx.db
          .query('team_members')
          .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', me.id))
          .first()) !== null
      )
    })
  /* the ids of the teams of the person's organization, read once where
   * navigation asks about many teams, or null past OWN_READS or where one
   * id names two of its rows */
  let orgTeams: Promise<Set<string> | null> | undefined
  /* whether the team with this id is one of the person's organization,
   * each asked once: from orgTeams once read, else by the team, a read
   * counted in `shared` when navigation (`own`) makes it. The client chooses
   * a team's id, and createTeamCore keeps it unique across organizations
   * (lib/db.ts insertUnique on teams by_uuid), so orgTeams does not look for
   * a second row with the same id in another organization, which the read
   * by the team refuses. */
  const inOrg = new Map<string, Promise<boolean>>()
  const teamInOrg = (id: string, own = false) =>
    once(inOrg, id, async () => {
      const all = orgTeams === undefined ? null : await orgTeams
      if (all !== null) return all.has(id)
      const team = await ctx.db
        .query('teams')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      if (own) counted(team === null ? [] : [team])
      return team !== null && team.org_id === me.org_id
    })
  /* the shares of the person's teams by project, once read, or null when
   * they are more than OWN_READS.rows. One team after another, each up to
   * the rows left, so the reads stay within OWN_READS.rows and one more
   * however the shares fall on the teams. */
  let ofTeams: Promise<Map<string, Doc<'project_team_access'>[]> | null> | undefined
  const sharesOfTeams = async (ids: readonly string[]) => {
    const all: Doc<'project_team_access'>[] = []
    for (const teamId of ids) {
      const rows = await atMost(
        ctx.db.query('project_team_access').withIndex('by_team', (q) => q.eq('team_id', teamId)),
        OWN_READS.rows - all.length,
      )
      if (rows === null) return null
      all.push(...rows)
    }
    return byProjectId(all)
  }
  /* how many projects were asked about one by one */
  let asked = 0
  /* the latest attempt to read the person's own rows at once */
  let trying: Promise<unknown> | undefined
  /* reads the person's grants and memberships still unknown, each while
   * they are at most `most` rows, and then the shares of their teams while
   * those are at most `most` teams */
  const readOwn = (most: number) =>
    Promise.all([
      grants === undefined &&
        atMost(grantRows(), most).then((rows) => {
          if (rows !== null) grants ??= byProjectId(rows)
        }),
      teams === undefined &&
        receivesTeamAccess(me) &&
        atMost(memberRows(), most).then((rows) => {
          if (rows !== null) teams ??= new Set(rows.map((m) => m.team_id))
        }),
    ]).then(() => {
      if (
        ofTeams === undefined &&
        teams !== undefined &&
        teams.size <= Math.min(most, OWN_READS.teams)
      )
        ofTeams = handled(sharesOfTeams([...teams]))
    })
  /* the team shares on the project with this id that may reach the person:
   * those of their teams once read, else the project's */
  const sharesOn = async (id: string) => {
    const known = ofTeams === undefined ? null : await ofTeams
    if (known !== null) return known.get(id) ?? []
    return await ctx.db
      .query('project_team_access')
      .withIndex('by_project', (q) => q.eq('project_id', id))
      .collect()
  }
  /* the shares of `shares` that reach the person: through a team of their
   * organization they are a member of */
  const reaching = async <S extends { team_id: string }>(shares: readonly S[]) => {
    const ok = await Promise.all(
      shares.map(
        async (share) => (await isMember(share.team_id)) && (await teamInOrg(share.team_id)),
      ),
    )
    return shares.filter((_, i) => ok[i])
  }
  const direct = new Map<string, Promise<AccessLevel | null>>()
  /* directLevel over the cached reads; a role that receives no team access
   * reads no shares */
  const directOf = (p: Doc<'projects'>) =>
    once(direct, p.id, async () => {
      asked += 1
      if (OWN_READS.steps.includes(asked)) trying = readOwn(asked)
      await trying
      const [grant, shares] = await Promise.all([
        grantLevel(p.id),
        receivesTeamAccess(me) ? sharesOn(p.id).then(reaching) : [],
      ])
      let level: AccessLevel | null = grant
      for (const share of shares) level = higherLevel(level, share.level)
      return level
    })
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
    // accessRowsOf's rows, each team checked once
    if (ownLevels === undefined) {
      const teamIds = receivesTeamAccess(me)
        ? teams !== undefined
          ? Promise.resolve([...teams])
          : memberRows()
              .collect()
              .then(counted)
              .then((rows) => {
                teams ??= new Set(rows.map((m) => m.team_id))
                return [...teams]
              })
        : Promise.resolve([])
      // The shares of the person's teams: those sharesOn read, or else read
      // here team by team, every one, which then answer sharesOn too.
      const before = ofTeams
      const shares = teamIds.then(async (mine) => {
        const known = before === undefined ? null : await before
        const read = known === null ? null : [...known.values()].flat()
        // Navigation asks whether each of these teams is the organization's,
        // so for many teams not asked yet it reads the organization's teams
        // at once instead, while they are at most OWN_READS.orgTeams rows
        // for each of those teams.
        const asking = new Set(
          (read?.map((share) => share.team_id) ?? mine).filter((id) => !inOrg.has(id)),
        )
        if (asking.size >= OWN_READS.manyTeams)
          orgTeams ??= handled(
            atMostBytes(
              ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', me.org_id)),
              Math.min(OWN_READS.orgTeams * asking.size, OWN_READS.orgTeamsMost),
            ).then((rows) => {
              const ids = new Set(rows?.map((team) => team.id))
              // two rows with one id: the read by the team refuses them
              return rows !== null && ids.size === rows.length ? ids : null
            }),
          )
        if (read !== null) return read
        const perTeam = await Promise.all(
          mine.map(async (teamId) =>
            (await teamInOrg(teamId, true))
              ? await ctx.db
                  .query('project_team_access')
                  .withIndex('by_team', (q) => q.eq('team_id', teamId))
                  .collect()
                  .then(counted)
              : [],
          ),
        )
        return perTeam.flat()
      })
      ofTeams = handled(shares.then(byProjectId))
      ownLevels = Promise.all([
        grants !== undefined
          ? [...grants.values()].flat()
          : grantRows()
              .collect()
              .then(counted)
              .then((rows) => {
                grants ??= byProjectId(rows)
                return rows
              }),
        // only the shares of teams of the person's organization
        shares.then(async (rows) => {
          const ok = await Promise.all(rows.map((share) => teamInOrg(share.team_id, true)))
          return rows.filter((_, i) => ok[i])
        }),
      ]).then(([grants, own]) => new Set([...grants, ...own].map((g) => g.project_id)))
    }
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
    /** About what the reads of the person's own rows cost so far, which
     * every part of theirs repeats however few rows it holds: each read of
     * all their grants, memberships or team shares (at a step of OWN_READS,
     * or for navigation, which may read them again), and navigation's reads
     * of their teams or the organization's teams. Documents and ranges as
     * Convex counts them, bytes as JSON. */
    shared,
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

/* `rows` by their project_id. */
function byProjectId<R extends { project_id: string }>(rows: readonly R[]): Map<string, R[]> {
  const out = new Map<string, R[]>()
  for (const row of rows) out.set(row.project_id, [...(out.get(row.project_id) ?? []), row])
  return out
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
 * The ban columns of the Better Auth user row behind a login, or null when
 * Better Auth no longer has it. Each call is a query into the Better Auth
 * component, one more read than the app's own tables, so callers make it
 * after their cheaper checks pass. The query loads no Better Auth
 * (betterAuth/lookups.ts userBan), because every REST and MCP call made with
 * a personal token or an OAuth access token makes it.
 */
export async function findAuthUser(ctx: QueryCtx, authUserId: string): Promise<LoginBan | null> {
  return await ctx.runQuery(components.betterAuth.lookups.userBan, { userId: authUserId })
}

/**
 * Whether Better Auth's OAuth client `clientId` is disabled, or null once it
 * no longer has the client. One indexed read of the Better Auth component,
 * which loads no Better Auth (betterAuth/lookups.ts oauthClient).
 */
export async function findOAuthClient(ctx: QueryCtx, clientId: string) {
  return await ctx.runQuery(components.betterAuth.lookups.oauthClient, { clientId })
}

/**
 * Whether an OAuth client may still act for its grants on `resource`: Better
 * Auth still has the client, it is not disabled and it keeps its link to the
 * resource. Better Auth checks the link only when it issues a token, so every
 * use of a grant checks it here: each MCP or REST call
 * (oauthAccess.ts lookupAccess) and each webhook subscription's owner
 * (model/taskEvents.ts eventOwner). It costs two indexed reads of the Better
 * Auth component, so callers make it after their cheaper checks pass.
 */
export async function oauthClientLive(
  ctx: QueryCtx,
  clientId: string,
  resource: string,
): Promise<boolean> {
  const client = await findOAuthClient(ctx, clientId)
  if (!client || client.disabled) return false
  return await ctx.runQuery(components.betterAuth.lookups.clientLinked, {
    clientId,
    resourceId: resource,
  })
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
