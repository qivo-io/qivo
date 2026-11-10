/* Teams and their members, the rules the app (teams.ts), REST and MCP
 * (machine/teams.ts) share, so each rule exists once, the pages REST and
 * MCP list teams and a team's members in (teamPage, memberPage), and the
 * reads of Settings › Teams, a team's page and its Add member picker
 * (settingsTeamsOf, teamSettingsOf, settingsMembersOf, addableOf), which
 * list the members memberPage lists and count as team_counts counts.
 *
 * Who may do what:
 * - Creating a team: organization admins only. Agents are never admins, so
 *   only people create teams.
 * - Renaming a team and its other settings: an organization admin or a
 *   leader of that team (assertRunsTeam).
 * - Deleting a team: organization admins only, and never the organization's
 *   last team (deleteTeamCore).
 * - Adding and removing members and making or unmaking leaders change who
 *   sees the projects shared with the team, so they also need a person
 *   (lib/access.ts canChangeAccess), never an agent. Only a person with an
 *   organization staff role leads a team (canLeadTeams).
 *
 * Removing a member or deleting a team can hide open tasks from the people
 * working on them. As with a project grant (model/projectAccess.ts), the
 * caller chooses what happens to those tasks with on_held_tasks, and
 * removeAndSettle applies the removal and the choice in one transaction or
 * not at all. Deleting a team stays in the app (docs/mcp.md, Stays in the
 * app).
 *
 * Narration follows the app: creating and changing a team write no activity
 * row; adding, removing, making and demoting a member write one against the
 * user, hung on the team. A machine write appends its provenance. */

import type { WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON, canChangeAccess, canLeadTeams, isTeamLeader } from '../lib/access'
import { assertOrgWritable } from '../lib/billingAccess'
import { assertNewRowId, byId, insertUnique } from '../lib/db'
import { trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, notFound, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMES_NOT_READY, type NamedListPage, namedListPage, namedScope } from '../lib/listCursor'
import {
  besideHeld,
  indexAfter,
  type ListBatch,
  listBatch,
  mergeNamed,
  type NamedReads,
  namedCeiling,
  type ReadGuard,
} from '../lib/namedPages'
import { named, nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { logActivity, signedDetail } from './activity'
import { deleteTeamDeep } from './cascade'
import {
  assertExpected,
  BOOLEAN,
  DELETES,
  exact,
  type Fields,
  filledText,
  type Next,
} from './expected'
import {
  copyNameKey,
  idTieOf,
  inlineBudget,
  nameKeysReady,
  profileRoleIndex,
  teamIndex,
  teamMemberIndex,
} from './nameKeys'
import { assertNotLastTeam, newTeamDefaults } from './orgs'
import {
  type AccessRemoval,
  assertRoom,
  type HeldTasks,
  narrateAccess,
  peopleOf,
  reachedProjects,
  removeAndSettle,
  withinRoom,
} from './projectAccess'
import { grantee, reachOfGrantee } from './projectNav'
import {
  type ListArgs,
  orderedListAsk,
  type PersonRow,
  personRow,
  UNKEYED_MOST,
} from './projectSettings'
import {
  countingOrg,
  countingOrgOf,
  countMemberAdded,
  countMemberRemoved,
  insertTeamCount,
  memberCount,
  shownCount,
  teamCountRow,
} from './teamCounts'

/** Refuses with LIMITS.teamDeleteRows' sentence a team deletion that changes
 * more than LIMITS.teamDeleteRows.max memberships, project shares, their
 * reach rows (model/projectNav.ts, at most two a share) and legacy owned
 * projects (model/cascade.ts deleteTeamDeep), read before anything else so
 * the refusal itself fits. A deployment counts each changed row as one of
 * Convex's 4,096 reads: a local backend read 3,062 ranges deleting a team
 * with 3,000 memberships, and refused one with 5,000. Answers the team's
 * legacy owned projects it read, for deleteTeamDeep. */
export async function assertTeamFits(
  ctx: QueryCtx,
  team: Doc<'teams'>,
): Promise<Doc<'projects'>[]> {
  const over = LIMITS.teamDeleteRows.max + 1
  const memberships = await ctx.db
    .query('team_members')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
    .take(over)
  const shares = await ctx.db
    .query('project_team_access')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
    .take(over)
  const reach = await reachOfGrantee(ctx, grantee.team(team.id)).take(over)
  const owned = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
    .take(over)
  if (memberships.length + shares.length + reach.length + owned.length > LIMITS.teamDeleteRows.max)
    throw rule(LIMITS.teamDeleteRows.refusal)
  return owned
}

export const TEAM_RUNS_RULE = 'requires an organization admin or a leader of this team'

/** A team name as stored: trimmed, and refused when nothing is left or past
 * LIMITS.teamName. */
export function cleanTeamName(raw: string): string {
  const name = limitedText(LIMITS.teamName, raw)
  if (name === '') throw rule('a team name cannot be blank')
  return name
}

/** Refuses a caller who is neither an organization admin nor a leader of
 * this team. A leader row held by an agent, a viewer or a guest grants
 * nothing (lib/access.ts isTeamLeader). */
export async function assertRunsTeam(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  team: Doc<'teams'>,
): Promise<void> {
  if (me.org_role === 'admin') return
  if (await isTeamLeader(ctx, me, team.id)) return
  throw forbidden(TEAM_RUNS_RULE)
}

/** Refuses a membership change by anyone but a person who runs the team,
 * because it also changes who sees the team's projects. */
export async function assertManagesMembers(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  team: Doc<'teams'>,
): Promise<void> {
  if (!canChangeAccess(me)) throw forbidden(ACCESS_NEEDS_A_PERSON)
  await assertRunsTeam(ctx, me, team)
}

/** The membership row of `profileId` in `team`, if any. */
export const membershipOf = (ctx: QueryCtx, teamId: string, profileId: string) =>
  ctx.db
    .query('team_members')
    .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
    .unique()

/* ------------------------------------------- REST and MCP team lists */

/** A team as REST and MCP answer it, in a list, a single-team read and a
 * team write's answer. `member_count` is the number of its members as the
 * member list counts them (model/teamCounts.ts shownCount), null while
 * Qivo counts the team, never 0 for a count it does not have. It holds no
 * member rows; memberPage lists a team's members. */
export type TeamSummaryJson = { id: string; name: string; member_count: number | null }

/** `team` as REST and MCP answer it (TeamSummaryJson), reading its count
 * row with `lookup`, a batch's counted lookup (lib/namedPages.ts ReadGuard)
 * or a plain read. A new team's row holds 0 (createTeamCore). */
export async function teamSummary(
  ctx: QueryCtx,
  team: Doc<'teams'>,
  lookup: ReadGuard['lookup'] = (read) => read(),
): Promise<TeamSummaryJson> {
  const row = await lookup(() => teamCountRow(ctx, team.id))
  return { id: team.id, name: team.name, member_count: shownCount(row, team) }
}

/* The list names a REST or MCP teams or members cursor seals
 * (lib/listCursor.ts). REST and MCP answer the same rows, so each list
 * shares its name across them, and a cursor of one continues on the other. */
const TEAMS_LIST = 'machine.teams'
const MEMBERS_LIST = 'machine.team_members'

/** One page of the organization's teams, as REST GET /v1/teams and MCP
 * list_teams answer it, the cursor first. */
export type TeamsPageJson = { next_cursor: string | null; teams: TeamSummaryJson[] }

/**
 * One page of the teams of `me`'s organization for REST GET /v1/teams and
 * MCP list_teams, after `p.cursor`, the next_cursor of an earlier page, at
 * most `p.limit` of them, each as its summary (teamSummary) with its count
 * read through the page's guard. Every member of the organization reads
 * every team, guests and Viewers included, as in the app's catalog.
 *
 * The teams come in name order (teams.by_org_name, by the name key, which
 * ignores case and accents, in Convex's byte order, then the id). With
 * `p.search`, the rows are the teams whose name holds every word of it in
 * any order, ignoring case and accents, matched over every team before the
 * limit, and a team the search leaves out reads no count. The page reads
 * within the call's share (lib/listCursor.ts namedListPage), so a page can
 * be short, or empty, while next_cursor is set, and next_cursor is null only
 * once the teams ended. The cursor is sealed with the organization, `me`
 * and the search's name key, and any other cursor is refused with
 * CURSOR_REFUSAL. Pages are not a snapshot. A page refuses with
 * NAMES_NOT_READY until the organization's name keys are all written.
 *
 * A team reads its row from the index and its count row, one lookup.
 * convex/tests/peopleLists.test.ts ("at the design size") logs the call's
 * own reads for the 50 teams in one page at limit 200, and for a search
 * that matches no team, which reads no count row.
 */
export async function teamPage(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  p: { limit: number; cursor: string | null; search: string },
): Promise<TeamsPageJson> {
  if (!(await nameKeysReady(ctx, me.org_id))) throw rule(NAMES_NOT_READY)
  const matches = allWordsMatcher(nameKey(p.search))
  const page: NamedListPage<TeamSummaryJson> = await namedListPage(ctx, {
    list: TEAMS_LIST,
    scope: await namedScope(me, p.search),
    cursor: p.cursor,
    tieOf: idTieOf,
    index: teamIndex(ctx, me.org_id),
    keep: async (team, guard) =>
      matches(nameKey(team.name)) ? await teamSummary(ctx, team, guard.lookup) : null,
    limit: p.limit,
  })
  return { next_cursor: page.next_cursor, teams: page.rows }
}

/** A member of a team as REST and MCP list them. `leader` is effective
 * leadership (lib/access.ts canLeadTeams), so a leader row an agent or a
 * Viewer holds reads false. */
export type TeamMemberJson = { id: string; name: string; leader: boolean }

/** One page of a team's members, as REST GET /v1/teams/{id}/members and
 * MCP list_team_members answer it, the cursor first, then the team's
 * summary, whose count is the whole team's whatever the search. */
export type TeamMembersPageJson = {
  next_cursor: string | null
  team: TeamSummaryJson
  members: TeamMemberJson[]
}

/** The profile of `membership`, a membership of `team`, read with
 * `lookup` (a batch's counted lookup or a plain read), when a member list
 * lists it: null when the profile is gone, in another organization or a
 * guest's, the rule team_counts counts by (model/teamCounts.ts). REST, MCP
 * (memberPage) and the app's member list (settingsMembersOf) list members
 * by it, so their rule stays one. */
export async function memberProfile(
  ctx: QueryCtx,
  team: Doc<'teams'>,
  membership: Doc<'team_members'>,
  lookup: ReadGuard['lookup'] = (read) => read(),
): Promise<Doc<'profiles'> | null> {
  const profile = await lookup(() => byId(ctx, 'profiles', membership.profile_id))
  return profile === null || profile.org_id !== team.org_id || profile.org_role === 'guest'
    ? null
    : profile
}

/* Whether every membership of `team` without a copy of its person's name
 * key belongs to a profile that is gone or in another organization, which
 * the member list leaves out anyway. The walk in name order does not read
 * such rows (model/nameKeys.ts teamMemberIndex), and they are only those a
 * removed person left before the backfill keyed the organization, until
 * their removal's background steps delete them. Reads at most
 * UNKEYED_MOST.rows of them in one range, and one profile each. Answers
 * false for a row whose profile is in the organization, a guest's
 * included, and past UNKEYED_MOST.rows, so the list fails closed rather
 * than leave such a row out unseen, the rule model/projectSettings.ts
 * applies to a project's grants. */
async function unkeyedMembersGone(ctx: QueryCtx, team: Doc<'teams'>): Promise<boolean> {
  const most = UNKEYED_MOST.rows + 1
  const rows = await ctx.db
    .query('team_members')
    .withIndex('by_team_name', (q) => q.eq('team_id', team.id).eq('name_key', undefined))
    .take(most)
  if (rows.length === most) return false
  for (const row of rows)
    if ((await byId(ctx, 'profiles', row.profile_id))?.org_id === team.org_id) return false
  return true
}

/**
 * One page of the members of `team`, a team of `me`'s organization the
 * caller resolved, for REST GET /v1/teams/{id}/members and MCP
 * list_team_members, after `p.cursor`, the next_cursor of an earlier page
 * of this team, at most `p.limit` of them, with the team's summary
 * (teamSummary) on every page. Every member of the organization reads
 * every team's members, guests and Viewers included, as in the app.
 *
 * The members are the team's memberships whose profile exists in the
 * team's organization and is not a guest, as team_counts counts them, so
 * a guest's stale membership and a profile of another organization are
 * left out. A membership that a removal from the organization left to its
 * background steps counts in `member_count` until a step deletes it, but
 * its profile is gone, so it is not listed and the count can be higher than
 * the members listed for a moment. Each member is `{id, name, leader}`,
 * the name read from the profile, so it is always current.
 *
 * The members come in the order of their memberships' copies of the
 * person's name key (model/nameKeys.ts teamMemberIndex), then the profile
 * id, and a search matches the copy before the profile is read, so a
 * membership the search leaves out reads no profile. A copy can trail a
 * rename for a moment, which sorts and matches that member by the earlier
 * name, so a search by the new name can miss them until the copy is in
 * line. The page reads within the call's share (lib/listCursor.ts
 * namedListPage), so a page can be short, or empty, while next_cursor is
 * set, and next_cursor is null only once the memberships ended. The cursor
 * is sealed with the organization, `me`, the team and the search's name
 * key, and any other cursor is refused with CURSOR_REFUSAL. Pages are not
 * a snapshot.
 *
 * A page refuses with NAMES_NOT_READY until the organization's name keys
 * are all written, and while a membership without a copy may be one of a
 * profile in the organization or there are more such memberships than the
 * check reads (unkeyedMembersGone), so a page is never answered from rows a
 * read in key order could skip.
 *
 * A member reads their membership from the index and their profile by id.
 * convex/tests/peopleLists.test.ts ("at the design size") logs the call's
 * own reads for a team of 1,000 members, everyone in an organization of
 * 1,000 people, at limit 200, and for a search that matches nobody, which
 * reads the memberships and no profile.
 */
export async function memberPage(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  team: Doc<'teams'>,
  p: { limit: number; cursor: string | null; search: string },
): Promise<TeamMembersPageJson> {
  if (!(await nameKeysReady(ctx, team.org_id)) || !(await unkeyedMembersGone(ctx, team)))
    throw rule(NAMES_NOT_READY)
  const summary = await teamSummary(ctx, team)
  const matches = allWordsMatcher(nameKey(p.search))
  const page: NamedListPage<TeamMemberJson> = await namedListPage(ctx, {
    list: MEMBERS_LIST,
    scope: await namedScope(me, p.search, [team.id]),
    cursor: p.cursor,
    tieOf: idTieOf,
    index: teamMemberIndex(ctx, team.id),
    keep: async (membership, guard) => {
      if (!matches(membership.name_key ?? '')) return null
      const profile = await memberProfile(ctx, team, membership, guard.lookup)
      if (profile === null) return null
      return {
        id: profile.id,
        name: profile.name,
        leader: membership.is_leader && canLeadTeams(profile),
      }
    },
    limit: p.limit,
  })
  return { next_cursor: page.next_cursor, team: summary, members: page.rows }
}

/* ------------------------------------------- the app's team settings */

/** The refusal of an `after` or `through` that is not a cursor of the same
 * team list for the same arguments and search. */
export const NOT_TEAM_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same arguments and search; start again from the first batch'

/** What teams.settingsPage answers a seat that may neither run the
 * organization nor lead a team (lib/access.ts canLeadTeams). */
export const TEAM_LIST_REFUSAL =
  'only organization admins and team leaders can open the team settings'

/* The list names the app's team list cursors seal (lib/namedPages.ts
 * namedCursor). */
const SETTINGS_TEAMS_LIST = 'teams.settings'
const SETTINGS_MEMBERS_LIST = 'teams.members'
const ADDABLE_LIST = 'teams.addable'
const PICKER_LIST = 'teams.picker'

/* The organization roles Add member offers: a guest is never a member
 * (addTeamMemberCore), so the guests' role index is never read. */
const MEMBER_ROLES = ['admin', 'user', 'viewer'] as const

/* `a` opened for a team list, whose positions tie on one id. */
const teamListAsk = (list: string, scope: readonly string[], a: ListArgs) =>
  orderedListAsk(list, scope, a, { tieOf: idTieOf, refusal: NOT_TEAM_CURSOR })

/* Team `id` of `me`'s organization, or null for an unknown id, a team of
 * another organization and one deleted meanwhile, alike, as teams.ts
 * myTeam refuses them. */
async function teamOf(ctx: QueryCtx, me: Doc<'profiles'>, id: string) {
  const team = await byId(ctx, 'teams', id)
  return team === null || team.org_id !== me.org_id ? null : team
}

/** What teams.settingsPage answers: `refused` with TEAM_LIST_REFUSAL,
 * `not_ready` without name keys, or one batch with `teams`, how many teams
 * the organization holds up to 3, which stands for three or more. */
export type SettingsTeamsAnswer =
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | ({ state: 'ready'; teams: number } & ListBatch<TeamSummaryJson>)

/**
 * teams.settingsPage for `me`: one batch of Settings › Teams, LIST_BATCH
 * teams in name order (teamIndex, the name key in Convex's byte order,
 * then the id), each as its summary (teamSummary) with its member count
 * from team_counts, null while Qivo counts it. An organization admin reads
 * every team of the organization, and anyone else who may lead teams
 * (lib/access.ts canLeadTeams) reads the teams whose membership row of
 * their own leads them, isTeamLeader's rule, one lookup a team. A viewer,
 * a guest and an agent are refused with TEAM_LIST_REFUSAL before anything
 * is read.
 *
 * The search keeps the teams whose name holds every word of it in any
 * order, ignoring case and accents, matched over every team before the
 * batch is cut and before the membership or the count is read. Cursors are
 * sealed with the organization, `me` and the search's name key
 * (NOT_TEAM_CURSOR). The batch reads within NAMED_READ (lib/namedPages.ts
 * listBatch), so it can stop short with `stopped`, and it answers
 * `not_ready` until the organization's name keys are all written.
 *
 * Every ready batch answers `teams`, from at most three rows of
 * teams.by_org, so the page turns Delete off for the organization's last
 * team from the server's answer and not from the rows it loaded. The
 * deletion still checks the last team at full scope (assertNotLastTeam).
 * It reads no profile, no other person's membership and no share.
 */
export async function settingsTeamsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: ListArgs,
): Promise<SettingsTeamsAnswer> {
  const admin = me.org_role === 'admin'
  if (!admin && !canLeadTeams(me)) return { state: 'refused', message: TEAM_LIST_REFUSAL }
  const ask = await teamListAsk(SETTINGS_TEAMS_LIST, [me.org_id, me.id], a)
  if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' }
  const teams = (
    await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .take(3)
  ).length
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(teamIndex(ctx, me.org_id), ask.after),
    keep: async (team: Doc<'teams'>, guard): Promise<TeamSummaryJson | null> => {
      if (!matches(nameKey(team.name))) return null
      if (!admin && !(await guard.lookup(() => membershipOf(ctx, team.id, me.id)))?.is_leader)
        return null
      return await teamSummary(ctx, team, guard.lookup)
    },
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', teams, ...batch }
}

/** A team as Team sync's scope menu lists it: its id and name. */
export type TeamChoiceRow = { id: string; name: string }

/** What teams.picker answers: `not_ready` without name keys, or one batch
 * of teams in name order. */
export type TeamPickerAnswer =
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<TeamChoiceRow>)

/**
 * teams.picker for `me`: one batch of LIST_BATCH teams of their
 * organization for Team sync's scope menu (src/views/teamSync/
 * SyncScopeMenu.tsx), in name order (teamIndex, the name key in Convex's
 * byte order, then the id), each as its id and name. Any active seat of
 * the organization reads it, guests and Viewers included, as every seat
 * received every team's id and name through the workspace's catalog part
 * before it was removed, and reads any one team through teams.get.
 *
 * The search keeps the teams whose name holds every word of it in any
 * order, ignoring case and accents, matched over every team before the
 * batch is cut. A search past LIMITS.search is refused with that limit's
 * sentence, and a cursor that is not one of this list's for the same
 * organization, caller and search with NOT_TEAM_CURSOR. The batch reads
 * within NAMED_READ (lib/namedPages.ts listBatch), so it can stop short
 * with `stopped`, and it answers `not_ready` until the organization's name
 * keys are all written. It reads teams.by_org_name and nothing else: no
 * membership, count, share or profile.
 *
 * tests/teamSettings.test.ts ("at the design size") logs what a batch, the
 * next batch and a search read among 50 teams, for an admin and a guest
 * alike.
 */
export async function teamPickerOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: ListArgs,
): Promise<TeamPickerAnswer> {
  const ask = await teamListAsk(PICKER_LIST, [me.org_id, me.id], a)
  if (!(await nameKeysReady(ctx, me.org_id))) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(teamIndex(ctx, me.org_id), ask.after),
    keep: async (team: Doc<'teams'>): Promise<TeamChoiceRow | null> =>
      matches(nameKey(team.name)) ? { id: team.id, name: team.name } : null,
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/** What teams.get answers: `unavailable` for a team the caller's
 * organization does not hold, else the team's name, its member count
 * (shownCount, null while Qivo counts it) and the caller's rights. */
export type TeamSettingsAnswer =
  | { state: 'unavailable' }
  | {
      state: 'ok'
      team: { id: string; name: string }
      member_count: number | null
      /** whether the caller may rename the team (assertRunsTeam) */
      can_manage: boolean
      /** whether the caller may add and remove members and make or unmake
       * leaders (assertManagesMembers) */
      can_manage_members: boolean
    }

/**
 * teams.get for `me`: team `id` of their organization for its Settings
 * page, read whether or not the app holds it. Every active seat of the
 * organization reads it, as every seat reads every team over REST and MCP
 * and in the workspace; the page shows only to a caller with `can_manage`
 * (src/panels/Settings.tsx). An unknown id, a team of another organization
 * and one deleted meanwhile all answer `unavailable`.
 *
 * Each right is its write's rule. `can_manage` is assertRunsTeam's, an
 * organization admin or a leader of the team (lib/access.ts isTeamLeader),
 * for the rename. `can_manage_members` is assertManagesMembers', which also
 * needs a person (canChangeAccess), for adding and removing members and
 * making leaders. No seat has the one without the other today, since
 * agents are never admins and never lead, but the page follows each write's
 * own rule on purpose, so a change to either rule changes what the page
 * offers with it.
 */
export async function teamSettingsOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
): Promise<TeamSettingsAnswer> {
  const team = await teamOf(ctx, me, id)
  if (team === null) return { state: 'unavailable' }
  const can_manage = me.org_role === 'admin' || (await isTeamLeader(ctx, me, team.id))
  return {
    state: 'ok',
    team: { id: team.id, name: team.name },
    member_count: await memberCount(ctx, team),
    can_manage,
    can_manage_members: can_manage && canChangeAccess(me),
  }
}

/** A member as a team's Settings page lists them: the person; `is_leader`,
 * the stored flag, so an agent's or a Viewer's old leader row shows and can
 * be cleared; `can_lead`, whether a leader write accepts them
 * (canLeadTeams); and their plannable hours, null for the organization's
 * default week. */
export type TeamMemberRow = PersonRow & {
  is_leader: boolean
  can_lead: boolean
  plannable_hours: number | null
}

/** What a team's member list or its Add member picker is asked for. */
export type TeamListArgs = ListArgs & { team_id: string }

/** What teams.members answers. */
export type TeamMembersAnswer =
  | { state: 'unavailable' }
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<TeamMemberRow>)

/**
 * teams.members for `me`: one batch of LIST_BATCH members of team
 * `a.team_id` of their organization for its Settings page, in the order of
 * their memberships' copies of the person's name key (teamMemberIndex),
 * then the profile id, with the search matched against the copy before the
 * profile is read. It lists the members memberPage lists (memberProfile),
 * so a guest's stale membership and a profile that is gone or of another
 * organization are left out. Every active seat of the organization reads
 * it, as over REST and MCP. The team as teamSettingsOf resolves it, else
 * `unavailable`; `not_ready` while memberPage would refuse, until the name
 * keys are all written and every membership without a copy is one it would
 * leave out (unkeyedMembersGone). Cursors are sealed with the organization,
 * the team and the search's name key (NOT_TEAM_CURSOR). It reads no task,
 * share or grant.
 */
export async function settingsMembersOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: TeamListArgs,
): Promise<TeamMembersAnswer> {
  const ask = await teamListAsk(SETTINGS_MEMBERS_LIST, [me.org_id, a.team_id], a)
  const team = await teamOf(ctx, me, a.team_id)
  if (team === null) return { state: 'unavailable' }
  if (!(await nameKeysReady(ctx, team.org_id)) || !(await unkeyedMembersGone(ctx, team)))
    return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: indexAfter(teamMemberIndex(ctx, team.id), ask.after),
    keep: async (membership: Doc<'team_members'>, guard): Promise<TeamMemberRow | null> => {
      if (!matches(membership.name_key ?? '')) return null
      const profile = await memberProfile(ctx, team, membership, guard.lookup)
      if (profile === null) return null
      return {
        ...personRow(profile),
        is_leader: membership.is_leader,
        can_lead: canLeadTeams(profile),
        plannable_hours: profile.plannable_hours ?? null,
      }
    },
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/** What teams.addable answers: the states of teams.members, `refused` with
 * the sentence the write would refuse with, else one batch. */
export type TeamChoicesAnswer =
  | { state: 'unavailable' }
  | { state: 'refused'; message: string }
  | { state: 'not_ready' }
  | ({ state: 'ready' } & ListBatch<PersonRow>)

/**
 * teams.addable for `me`: one batch of the Add member picker of team
 * `a.team_id`, LIST_BATCH people in name order (profileRoleIndex), the
 * organization's admins, users and viewers who are not members, people and
 * agents, switched-off people and pending invitations included, never
 * guests, as addTeamMemberCore accepts them. The team, else `unavailable`;
 * then `refused` as assertManagesMembers refuses, ACCESS_NEEDS_A_PERSON for
 * an agent and TEAM_RUNS_RULE for anyone who neither administers the
 * organization nor leads the team; `not_ready` without name keys.
 *
 * The team's memberships are read beside the people in the same order
 * (lib/namedPages.ts besideHeld), since a membership copies its person's
 * name key and ties on the profile id, so a member costs one document and
 * no range and is left out before the batch is cut. A person the search
 * matched whom no membership marked is looked up by team and profile
 * before they are offered, one range, which catches a membership whose copy
 * trails a rename or has none. Cursors are sealed with the organization,
 * the team and the search's name key (NOT_TEAM_CURSOR). The add checks
 * again (addTeamMemberCore), so a person who joined meanwhile changes
 * nothing.
 */
export async function addableOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  a: TeamListArgs,
): Promise<TeamChoicesAnswer> {
  const ask = await teamListAsk(ADDABLE_LIST, [me.org_id, a.team_id], a)
  const team = await teamOf(ctx, me, a.team_id)
  if (team === null) return { state: 'unavailable' }
  if (!canChangeAccess(me)) return { state: 'refused', message: ACCESS_NEEDS_A_PERSON }
  if (me.org_role !== 'admin' && !(await isTeamLeader(ctx, me, team.id)))
    return { state: 'refused', message: TEAM_RUNS_RULE }
  if (!(await nameKeysReady(ctx, team.org_id))) return { state: 'not_ready' }
  const people = MEMBER_ROLES.map((role) =>
    indexAfter(profileRoleIndex(ctx, team.org_id, role), ask.after),
  )
  // the people the team's memberships mark as members, by profile id
  const members = new Set<string>()
  const matches = allWordsMatcher(nameKey(ask.search))
  const batch = await listBatch(ctx, ask, {
    stream: besideHeld(
      (reads: NamedReads) => mergeNamed(people.map((stream) => stream(reads))),
      indexAfter(teamMemberIndex(ctx, team.id), ask.after),
      (profile) => members.add(profile.id),
    ),
    keep: async (profile: Doc<'profiles'>, guard): Promise<PersonRow | null> => {
      if (members.has(profile.id) || !matches(nameKey(profile.name))) return null
      if ((await guard.lookup(() => membershipOf(ctx, team.id, profile.id))) !== null) return null
      return personRow(profile)
    },
    limit: LIST_BATCH,
    ceiling: await namedCeiling(ctx),
  })
  return { state: 'ready', ...batch }
}

/** Creates a team with the standard settings (newTeamDefaults). Organization
 * admins only. `id` is the caller's uuid for it; one that is not a
 * lowercase UUID (lib/db.ts assertNewRowId) or is reused is refused. */
export async function createTeamCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; id: string; name: string; now: string },
): Promise<Doc<'teams'>> {
  assertNewRowId(a.id)
  if (a.me.org_role !== 'admin') throw forbidden('only organization admins can create teams')
  const _id = await insertUnique(
    ctx,
    'teams',
    'by_uuid',
    { id: a.id },
    {
      id: a.id,
      org_id: a.me.org_id,
      ...named(cleanTeamName(a.name)),
      ...newTeamDefaults(a.now),
    },
    badRequest('a team with this id already exists'),
  )
  const team = await ctx.db.get(_id)
  if (team === null) throw notFound('team not found')
  await insertTeamCount(ctx, team, 0)
  return team
}

/** The team settings a change may carry. */
export type TeamPatch = {
  name?: string
  track_delay_default?: boolean
}

/** The keys of a team's `expected`. REST and MCP change only the name. */
export const TEAM_FIELDS: Fields<Doc<'teams'>> = {
  // cleanTeamName's rule
  name: { sends: 'name', type: filledText(LIMITS.teamName), form: trimmedForm },
  track_delay_default: { sends: 'track_delay_default', type: BOOLEAN, form: exact },
}

/** TEAM_FIELDS over REST and MCP, which change only the name. */
export const TEAM_MACHINE_FIELDS: Fields<Doc<'teams'>> = { name: TEAM_FIELDS.name }

/** The app's `expected` for a team edit or delete. */
export const vTeamExpected = v.object({
  name: v.optional(v.string()),
  track_delay_default: v.optional(v.boolean()),
})

/** Refuses a team edit or delete over a field someone else changed since
 * `expected` was read (model/expected.ts). `next` holds what the edit
 * stores, or DELETES for a delete, which Deleted items cannot undo. */
export async function assertTeamExpected(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  team: Doc<'teams'>,
  expected: Readonly<Record<string, unknown>> | undefined,
  next: Next,
): Promise<void> {
  await assertExpected({
    read: { ctx, me, view: 'app' },
    fields: TEAM_FIELDS,
    record: 'team',
    id: team.id,
    label: `team "${team.name}"`,
    row: team,
    expected,
    next,
  })
}

/**
 * Renames a team or changes its settings, for an organization admin or a
 * leader of the team. Same-value fields are dropped, so an unchanged patch
 * writes nothing. Returns the team as stored. `expected` holds what the caller read
 * (model/expected.ts).
 */
export async function updateTeamCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    team: Doc<'teams'>
    patch: TeamPatch
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<Doc<'teams'>> {
  const { team, patch } = a
  await assertRunsTeam(ctx, a.me, team)
  await assertTeamExpected(
    ctx,
    a.me,
    team,
    a.expected,
    Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  )
  const upd: Partial<WithoutSystemFields<Doc<'teams'>>> = {}
  if (patch.name !== undefined) {
    const name = cleanTeamName(patch.name)
    if (name !== team.name) Object.assign(upd, named(name))
  }
  if (
    patch.track_delay_default !== undefined &&
    patch.track_delay_default !== team.track_delay_default
  ) {
    upd.track_delay_default = patch.track_delay_default
  }
  if (Object.keys(upd).length === 0) return team
  await ctx.db.patch(team._id, upd)
  // the team's project shares copy its name key (model/nameKeys.ts)
  if (upd.name !== undefined)
    await copyNameKey(ctx, 'teams', { ...team, name: upd.name }, inlineBudget())
  return (await ctx.db.get(team._id)) ?? team
}

/**
 * Adds a person or an agent of the team's organization to the team as a
 * plain member. A guest is never a team member. An existing membership
 * changes nothing and writes no activity. Returns whether a member was
 * added.
 */
export async function addTeamMemberCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    team: Doc<'teams'>
    profileId: string
    now: string
    provenance?: string
  },
): Promise<{ changed: boolean }> {
  const { me, team } = a
  await assertManagesMembers(ctx, me, team)
  const member = await byId(ctx, 'profiles', a.profileId)
  if (member === null || member.org_id !== team.org_id) throw notFound('user not found')
  if (member.org_role === 'guest') throw forbidden('a guest is never a team member')
  if ((await membershipOf(ctx, team.id, member.id)) !== null) return { changed: false }
  await ctx.db.insert('team_members', {
    team_id: team.id,
    profile_id: member.id,
    is_leader: false,
    name_key: nameKey(member.name),
  })
  await countMemberAdded(ctx, team.id, countingOrg(member))
  await logActivity(ctx, {
    org_id: team.org_id,
    actor_id: me.id,
    verb: 'added',
    target_type: 'user',
    target_id: member.id,
    label: member.name,
    detail: signedDetail(`to ${team.name}`, a.provenance),
    team_id: team.id,
    ts: a.now,
  })
  return { changed: true }
}

/**
 * Makes a member a leader of the team or demotes them. A missing membership
 * or the value already set changes nothing. Only people with an
 * organization staff role lead (lib/access.ts canLeadTeams): promoting an
 * agent is refused with a rule the app shows verbatim, and a viewer or a
 * guest left with an old membership is refused too. Demoting always works,
 * so old leader rows can be cleared. A team may have no leader. Returns
 * whether the flag changed.
 */
export async function setTeamLeaderCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    team: Doc<'teams'>
    profileId: string
    isLeader: boolean
    now: string
    provenance?: string
  },
): Promise<{ changed: boolean }> {
  const { me, team, isLeader } = a
  await assertManagesMembers(ctx, me, team)
  const row = await membershipOf(ctx, team.id, a.profileId)
  if (row === null || row.is_leader === isLeader) return { changed: false }
  const member = await byId(ctx, 'profiles', a.profileId)
  // a removed person's membership that waits for its cleanup
  // (profileRemovals.ts) counts as none
  if (member === null) return { changed: false }
  if (isLeader && !canLeadTeams(member)) {
    if (member.kind === 'agent') throw rule('an agent cannot lead a team')
    throw forbidden(
      member.org_role === 'viewer'
        ? 'a viewer is never a team leader'
        : 'a guest is never a team member',
    )
  }
  await ctx.db.patch(row._id, { is_leader: isLeader })
  await logActivity(ctx, {
    org_id: team.org_id,
    actor_id: me.id,
    verb: isLeader ? 'made' : 'demoted',
    target_type: 'user',
    target_id: member.id,
    label: member.name,
    detail: signedDetail(
      `${isLeader ? 'a leader of ' : 'from leader of '}${team.name}`,
      a.provenance,
    ),
    team_id: team.id,
    ts: a.now,
  })
  return { changed: true }
}

/** The projects whose tasks the team's grants reach, each project shared
 * with the team and, for a top-level one, its sub-projects, without archived
 * ones and each once, with the ids of the projects the team shares. It
 * checks the room before each share, so call it within withinRoom. */
export async function teamReach(
  ctx: QueryCtx,
  team: Doc<'teams'>,
): Promise<{ projects: Doc<'projects'>[]; shared: Set<string> }> {
  const out = new Map<string, Doc<'projects'>>()
  const shared = new Set<string>()
  const shares = ctx.db
    .query('project_team_access')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const share of shares) {
    await assertRoom(ctx)
    const project = await byId(ctx, 'projects', share.project_id)
    if (project === null || project.org_id !== team.org_id) continue
    shared.add(project.id)
    for (const p of await reachedProjects(ctx, project)) out.set(p.id, p)
  }
  return { projects: [...out.values()], shared }
}

/** Where keeping a member as Viewer puts the grant for a task in `project`:
 * the project the team shared that showed the task, the task's own
 * sub-project first, then its parent. `shared` holds the ids of the projects
 * the team shared before the removal (teamReach). The app's removal window
 * and the removal preview (model/removalPreview.ts) list the same
 * projects. */
export async function viewerProjectFor(
  ctx: QueryCtx,
  shared: ReadonlySet<string>,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>> {
  if (project.parent_id === undefined || shared.has(project.id)) return project
  return (await byId(ctx, 'projects', project.parent_id)) ?? project
}

/**
 * Removes a member from the team, leadership included, and settles the open
 * tasks they can no longer see once the team's grants no longer reach them
 * (model/projectAccess.ts removeAndSettle). 'keep_as_viewer' gives them a
 * Viewer grant on each project the team shared that showed those tasks, which
 * needs the right to manage that project's users. `reassign_to` hands the
 * tasks over by the task update rules, which needs Edit access on them.
 * Either of those two writes more than a removal, so it needs an
 * organization that allows changes, even for an organization admin, and the
 * first line refuses it before anything is read, a missing membership
 * included. A refusal anywhere leaves everything as it was. A missing
 * membership changes nothing.
 */
export async function removeTeamMemberCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    team: Doc<'teams'>
    profileId: string
    held: HeldTasks
    now: string
    provenance?: string
  },
): Promise<AccessRemoval> {
  const { me, team, now } = a
  if (a.held !== 'leave') await assertOrgWritable(ctx, me.org_id)
  await assertManagesMembers(ctx, me, team)
  const row = await membershipOf(ctx, team.id, a.profileId)
  if (row === null) return { removed: false, stranded: [], kept_as_viewer: [], reassigned: [] }
  const member = await byId(ctx, 'profiles', a.profileId)
  const people = new Map<string, Doc<'profiles'>>()
  if (member !== null && member.org_id === team.org_id) people.set(member.id, member)
  // a removed person's membership that waits for its cleanup counts
  // through the removal (model/teamCounts.ts)
  const countedIn = member === null ? await countingOrgOf(ctx, a.profileId) : countingOrg(member)
  const reach = await withinRoom(() => teamReach(ctx, team))
  const settled = await removeAndSettle(ctx, {
    me,
    people,
    projects: reach.projects,
    remove: async () => {
      await ctx.db.delete(row._id)
      await countMemberRemoved(ctx, row, countedIn)
    },
    held: a.held,
    viewerOn: (project) => viewerProjectFor(ctx, reach.shared, project),
    now,
    provenance: a.provenance,
  })
  for (const project of settled.viewer_grants) {
    await narrateAccess(ctx, { me, project, now, provenance: a.provenance })
  }
  if (member !== null) {
    await logActivity(ctx, {
      org_id: team.org_id,
      actor_id: me.id,
      verb: 'removed',
      target_type: 'user',
      target_id: member.id,
      label: member.name,
      detail: signedDetail(`from ${team.name}`, a.provenance),
      team_id: team.id,
      ts: now,
    })
  }
  const { viewer_grants: _granted, ...settlement } = settled
  return { removed: true, ...settlement }
}

/** Refuses a team deletion by anyone but an organization admin, and the
 * deletion of the organization's last team. */
export async function assertDeletesTeam(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  team: Doc<'teams'>,
): Promise<void> {
  if (me.org_role !== 'admin') throw rule('only organization admins can delete teams')
  await assertNotLastTeam(ctx, team)
}

/**
 * Deletes the team (model/cascade.ts deleteTeamDeep) and settles, by `held`,
 * the open tasks its members can no longer see once its grants are gone
 * (model/projectAccess.ts removeAndSettle), in one transaction or not at all.
 * 'leave' settles nothing and answers no list, so it deletes the team without
 * working out who loses sight of what. 'keep_as_viewer' gives each of those
 * people a Viewer grant on each project the team shared that showed their own
 * tasks, as removing a member does. `reassign_to` hands the tasks over by the
 * task update rules, at most LIMITS.reassign.max of them (reassignTooLarge).
 * Only an organization admin deletes a team, and never the organization's
 * last one, nor one with more than LIMITS.teamDeleteRows.max memberships and
 * project shares (assertTeamFits). A deletion that settles tasks checks the room as it
 * deletes too, since the holders' sight shares its transaction.
 * `expected` refuses the delete over a field someone else changed since it was
 * read. The caller refuses a read-only organization (teams.deleteDeep is an
 * orgMutation). The deletion writes no activity row; each Viewer grant writes
 * `changed access on` for its project, and each handed-over task its update.
 */
export async function deleteTeamCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    team: Doc<'teams'>
    held: HeldTasks
    expected?: Readonly<Record<string, unknown>>
    now: string
  },
): Promise<void> {
  const { me, team, now } = a
  await assertDeletesTeam(ctx, me, team)
  await assertTeamExpected(ctx, me, team, a.expected, DELETES)
  const owned = await assertTeamFits(ctx, team)
  if (a.held === 'leave') return deleteTeamDeep(ctx, { team, actor: me, now, owned })
  const remove = () =>
    deleteTeamDeep(ctx, { team, actor: me, now, owned, guard: () => assertRoom(ctx) })
  // the shares go with the team, so where a Viewer grant goes is read first
  const reach = await withinRoom(() => teamReach(ctx, team))
  const settled = await removeAndSettle(ctx, {
    me,
    people: await withinRoom(() => peopleOf(ctx, { team })),
    projects: reach.projects,
    remove,
    held: a.held,
    viewerOn: (project) => viewerProjectFor(ctx, reach.shared, project),
    now,
  })
  for (const project of settled.viewer_grants) await narrateAccess(ctx, { me, project, now })
}
