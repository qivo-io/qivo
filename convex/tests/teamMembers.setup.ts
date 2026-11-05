/* The whole-team reader REST and MCP answered every team with until November
 * 2026, kept as the truth the team counts (teamCounts.test.ts,
 * helpers.setup.ts expectListCounts) and the member pages
 * (peopleLists.test.ts, model/teams.ts memberPage) are pinned against. It
 * reads every profile of the organization and every membership of each
 * team, so only tests call it. Two dots in the basename keep the Convex CLI
 * from deploying this module, as helpers.setup.ts. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canLeadTeams } from '../lib/access'

/** One team as REST and MCP listed it: its members by name, each with whether
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
