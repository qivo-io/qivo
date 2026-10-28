/* Team member counts (schema.ts team_counts): for each team, its
 * memberships whose profile exists in the team's organization and is not a
 * guest. Every write of a membership moves the count in its own transaction
 * (countMemberAdded, countMemberRemoved), given the organization whose
 * teams count the membership's profile, as the profile was before the write
 * (countingOrg). The profile writes that change that answer delete the
 * profile's memberships in the same transaction: becoming a guest and
 * leaving the guest role (profiles.update, model/orgs.ts leaveAllTeams). A
 * profile removal deletes the profile with as many memberships as its
 * budget allows; the rest keep counting through the removal row until its
 * background steps delete them (countingOrgOf). Creating a team adds its
 * row (insertTeamCount); deleting one deletes it (deleteTeamCount). The
 * teardowns that delete an organization's work over many steps delete its
 * counts before the memberships (model/orgDeletion.ts,
 * internal/demoCleanup.ts), so none reads wrong meanwhile.
 *
 * While internal/teamCountsBackfill counts a team, its row's `through`
 * holds the _creationTime of the last membership it read. A write moves the
 * count only for a membership at or below it; the backfill reads every
 * later one, a new membership included. A missing row means the team is
 * not counted, and a write leaves it missing. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'

/** The team's team_counts row, or null. */
export const teamCountRow = (ctx: QueryCtx, teamId: string) =>
  ctx.db
    .query('team_counts')
    .withIndex('by_team', (q) => q.eq('team_id', teamId))
    .unique()

/** The members of `team` as a reader may show them: null while the team is
 * not counted or is being counted. */
export async function memberCount(
  ctx: QueryCtx,
  team: Pick<Doc<'teams'>, 'id' | 'org_id'>,
): Promise<number | null> {
  const row = await teamCountRow(ctx, team.id)
  return row === null || row.org_id !== team.org_id || row.through !== undefined
    ? null
    : row.members
}

/** The organization whose team counts count a membership of `profile`: its
 * own, unless it is a guest, and none for no profile. */
export const countingOrg = (
  profile: Pick<Doc<'profiles'>, 'org_id' | 'org_role'> | null,
): string | null => (profile === null || profile.org_role === 'guest' ? null : profile.org_id)

/** countingOrg for the profile with id `profileId` as it is now. A removed
 * profile's memberships that its removal left count in the organization
 * the removal row names (profile_removals.counted_org_id). */
export async function countingOrgOf(ctx: QueryCtx, profileId: string): Promise<string | null> {
  const profile = await byId(ctx, 'profiles', profileId)
  if (profile !== null) return countingOrg(profile)
  const removal = await ctx.db
    .query('profile_removals')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .unique()
  return removal?.counted_org_id ?? null
}

/** Adds the row of a team this transaction creates, with the `members`
 * that count among the memberships it gives the team. Every path that
 * creates a team calls it. A row that an earlier team with the same id
 * left, which only a delete by an earlier release leaves, is replaced, so
 * the new team never takes its count. */
export async function insertTeamCount(
  ctx: MutationCtx,
  team: Pick<Doc<'teams'>, 'id' | 'org_id'>,
  members: number,
): Promise<void> {
  const row = { team_id: team.id, org_id: team.org_id, members }
  const left = await teamCountRow(ctx, team.id)
  // the team spends a public demo's record limit, and its count row none
  // (lib/demo.ts uncountedWriter)
  if (left === null) await uncountedWriter(ctx.db).insert('team_counts', row)
  else await ctx.db.replace(left._id, row)
}

/** Deletes the team's row, if any, in the transaction that deletes the
 * team. */
export async function deleteTeamCount(ctx: MutationCtx, teamId: string): Promise<void> {
  const row = await teamCountRow(ctx, teamId)
  if (row !== null) await ctx.db.delete(row._id)
}

/** Moves team `teamId`'s count by `by` when `countedIn` is its
 * organization and `read` says the backfill counting it, if any, has read
 * the membership. */
async function moveMembers(
  ctx: MutationCtx,
  teamId: string,
  by: 1 | -1,
  countedIn: string | null,
  read: (through: number) => boolean,
): Promise<void> {
  if (countedIn === null) return
  const row = await teamCountRow(ctx, teamId)
  if (row === null || row.org_id !== countedIn) return
  if (row.through !== undefined && !read(row.through)) return
  await ctx.db.patch(row._id, { members: row.members + by })
}

/** Counts a membership of team `teamId` this transaction inserted.
 * `countedIn` is countingOrg of its profile. A backfill counting the team
 * reads the new row itself. */
export const countMemberAdded = (ctx: MutationCtx, teamId: string, countedIn: string | null) =>
  moveMembers(ctx, teamId, 1, countedIn, () => false)

/** Takes membership `row`, which this transaction deleted, off its team's
 * count. `countedIn` is countingOrg of its profile as it was before the
 * write, or countingOrgOf for a removed profile. */
export const countMemberRemoved = (
  ctx: MutationCtx,
  row: Doc<'team_members'>,
  countedIn: string | null,
) => moveMembers(ctx, row.team_id, -1, countedIn, (through) => row._creationTime <= through)
