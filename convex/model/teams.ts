/* Teams and their members, the rules the app (teams.ts), REST and MCP
 * (machine/teams.ts) share, so each rule exists once.
 *
 * Who may do what:
 * - Creating a team: organization admins only. Agents are never admins, so
 *   only people create teams.
 * - Renaming a team and its other settings: an organization admin or a
 *   leader of that team (assertRunsTeam).
 * - Adding and removing members and making or unmaking leaders change who
 *   sees the projects shared with the team, so they also need a person
 *   (lib/access.ts canChangeAccess), never an agent. Only a person with an
 *   organization staff role leads a team (canLeadTeams).
 *
 * Removing a member can hide open tasks from them. As with a project grant
 * (model/projectAccess.ts), the caller chooses what happens to those tasks
 * with on_held_tasks, and removeAndSettle applies the removal and the choice
 * in one transaction or not at all.
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
import { NAME_MAX, nameOverCap } from '../lib/textLimits'
import { logActivity, signedDetail } from './activity'
import { assertExpected, BOOLEAN, exact, type Fields, type Next, NUMBER, TEXT } from './expected'
import { newTeamDefaults } from './orgs'
import {
  type AccessRemoval,
  type HeldTasks,
  narrateAccess,
  reachedProjects,
  removeAndSettle,
} from './projectAccess'

export const TEAM_RUNS_RULE = 'requires an organization admin or a leader of this team'

export const TEAM_NAME_TOO_LONG = `a team name must be at most ${NAME_MAX} characters`

/** A team name as stored: trimmed, and refused when nothing is left or when
 * it has more than NAME_MAX code points. A name equal to `current`, the
 * team's stored one, passes, so a team named before the cap keeps its name
 * through writes that resend it. */
export function cleanTeamName(raw: string, current?: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a team name cannot be blank')
  if (nameOverCap(name, current)) throw rule(TEAM_NAME_TOO_LONG)
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

/* A membership change also changes who sees the team's projects, so it needs
 * a person who runs the team. */
async function assertManagesMembers(
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

/** One team as REST and MCP list it: its members by name, each with whether
 * they lead it. `leader` is effective leadership (lib/access.ts
 * canLeadTeams), so a leader row held by an agent or a viewer reads false. */
export type TeamJson = {
  id: string
  name: string
  members: { id: string; name: string; leader: boolean }[]
}

/* Orders rows by name. Names may repeat, so id breaks ties for a stable order. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/* The organization's people and agents by id, read once. */
async function orgProfiles(
  ctx: QueryCtx,
  orgId: string,
): Promise<ReadonlyMap<string, Doc<'profiles'>>> {
  const rows = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return new Map(rows.map((p) => [p.id, p]))
}

/** A team with its members, as teamsJson lists it. A guest is never a team
 * member (lib/access.ts gives guests no team access), so an old row held by
 * one is left out, as on the app's Team settings. `profiles` holds the
 * organization's profiles by id; one read loads them when it is absent. */
export async function teamJson(
  ctx: QueryCtx,
  team: Doc<'teams'>,
  profiles?: ReadonlyMap<string, Doc<'profiles'>>,
): Promise<TeamJson> {
  const people = profiles ?? (await orgProfiles(ctx, team.org_id))
  const members: TeamJson['members'] = []
  const rows = ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const row of rows) {
    const profile = people.get(row.profile_id)
    if (profile === undefined || profile.org_role === 'guest') continue
    members.push({
      id: profile.id,
      name: profile.name,
      leader: row.is_leader && canLeadTeams(profile),
    })
  }
  return { id: team.id, name: team.name, members: members.sort(byName) }
}

/** Every team of the caller's organization with its members, by name. Every
 * member of an organization sees its teams and their membership, as in the
 * app's snapshot. The organization's profiles are read once for all teams. */
export async function teamsJson(ctx: QueryCtx, me: Doc<'profiles'>): Promise<TeamJson[]> {
  const teams = await ctx.db
    .query('teams')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const profiles = await orgProfiles(ctx, me.org_id)
  const out: TeamJson[] = []
  for (const team of teams.sort(byName)) out.push(await teamJson(ctx, team, profiles))
  return out
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
    { id: a.id, org_id: a.me.org_id, name: cleanTeamName(a.name), ...newTeamDefaults(a.now) },
    badRequest('a team with this id already exists'),
  )
  const team = await ctx.db.get(_id)
  if (team === null) throw notFound('team not found')
  return team
}

/** The team settings a change may carry. */
export type TeamPatch = {
  name?: string
  stale_days?: number
  archive_days?: number
  track_delay_default?: boolean
}

/* The old client's whole-number clamp (Math.round + range), range per column. */
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)))

/** The keys of a team's `expected`. REST and MCP change only the name. */
export const TEAM_FIELDS: Fields<Doc<'teams'>> = {
  name: { sends: 'name', type: TEXT, form: trimmedForm },
  stale_days: { sends: 'stale_days', type: NUMBER, form: exact },
  archive_days: { sends: 'archive_days', type: NUMBER, form: exact },
  track_delay_default: { sends: 'track_delay_default', type: BOOLEAN, form: exact },
}

/** TEAM_FIELDS over REST and MCP, which change only the name. */
export const TEAM_MACHINE_FIELDS: Fields<Doc<'teams'>> = { name: TEAM_FIELDS.name }

/** The app's `expected` for a team edit or delete. */
export const vTeamExpected = v.object({
  name: v.optional(v.string()),
  stale_days: v.optional(v.number()),
  archive_days: v.optional(v.number()),
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
 * writes nothing. Day counts clamp to 1..3650 like the old client's. Returns
 * the team as stored. `expected` holds what the caller read
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
  const days = (n: number | undefined) => (n === undefined ? undefined : clamp(n, 1, 3650))
  await assertTeamExpected(
    ctx,
    a.me,
    team,
    a.expected,
    Object.fromEntries(
      Object.entries({
        ...patch,
        stale_days: days(patch.stale_days),
        archive_days: days(patch.archive_days),
      }).filter(([, value]) => value !== undefined),
    ),
  )
  const upd: Partial<WithoutSystemFields<Doc<'teams'>>> = {}
  if (patch.name !== undefined) {
    const name = cleanTeamName(patch.name, team.name)
    if (name !== team.name) upd.name = name
  }
  if (patch.stale_days !== undefined) {
    const d = clamp(patch.stale_days, 1, 3650)
    if (d !== team.stale_days) upd.stale_days = d
  }
  if (patch.archive_days !== undefined) {
    const d = clamp(patch.archive_days, 1, 3650)
    if (d !== team.archive_days) upd.archive_days = d
  }
  if (
    patch.track_delay_default !== undefined &&
    patch.track_delay_default !== team.track_delay_default
  ) {
    upd.track_delay_default = patch.track_delay_default
  }
  if (Object.keys(upd).length === 0) return team
  await ctx.db.patch(team._id, upd)
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
  await ctx.db.insert('team_members', { team_id: team.id, profile_id: member.id, is_leader: false })
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
  if (isLeader && member !== null && !canLeadTeams(member)) {
    if (member.kind === 'agent') throw rule('an agent cannot lead a team')
    throw forbidden(
      member.org_role === 'viewer'
        ? 'a viewer is never a team leader'
        : 'a guest is never a team member',
    )
  }
  await ctx.db.patch(row._id, { is_leader: isLeader })
  if (member !== null) {
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
  }
  return { changed: true }
}

/* The projects whose tasks the team's grants reach: each project shared with
 * the team and, for a top-level one, its sub-projects, without archived ones
 * and each once. */
async function teamReach(ctx: QueryCtx, team: Doc<'teams'>): Promise<Doc<'projects'>[]> {
  const out = new Map<string, Doc<'projects'>>()
  const shares = ctx.db
    .query('project_team_access')
    .withIndex('by_team', (q) => q.eq('team_id', team.id))
  for await (const share of shares) {
    const project = await byId(ctx, 'projects', share.project_id)
    if (project === null || project.org_id !== team.org_id) continue
    for (const p of await reachedProjects(ctx, project)) out.set(p.id, p)
  }
  return [...out.values()]
}

/* Where keeping a member as Viewer puts the grant for a task in `project`:
 * the project the team shared that showed the task, the task's own
 * sub-project first, then its parent. The app's removal window lists the
 * same projects. */
async function viewerProjectFor(
  ctx: QueryCtx,
  team: Doc<'teams'>,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>> {
  if (project.parent_id === undefined) return project
  const share = await ctx.db
    .query('project_team_access')
    .withIndex('by_project_team', (q) => q.eq('project_id', project.id).eq('team_id', team.id))
    .unique()
  if (share !== null) return project
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
  const settled = await removeAndSettle(ctx, {
    me,
    people,
    projects: await teamReach(ctx, team),
    remove: () => ctx.db.delete(row._id),
    held: a.held,
    viewerOn: (project) => viewerProjectFor(ctx, team, project),
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
