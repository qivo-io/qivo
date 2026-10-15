/* The team domain's public surface: create / settings /
 * delete + the three membership verbs. Thin wrappers over model/teams (the
 * rules REST and MCP share), model/orgs and model/cascade.
 *
 * Ported predicates (final SQL state):
 *   teams_insert            is_org_admin (0081:218)
 *   teams_update            is_org_admin OR is_team_leader(id) (0081:219-220)
 *   delete_team             0081:458-471 — 'team not found' /
 *                           'only organization admins can delete teams'
 *   teams_last_guard        0078 — 'cannot delete the last team' (model/orgs)
 *   tm_insert/update/delete admin-or-leader; grantee same org, never a guest
 *                           (0081:223-251); a leader is never a viewer
 *                           (0102:334-359 — WITH CHECK, no sentence: forbidden)
 *                           and never an agent (lib/access canLeadTeams,
 *                           a rule sentence); only a person changes
 *                           membership (lib/access canChangeAccess)
 *
 * Narration is asymmetric BY DESIGN: create/update/delete write NO
 * activity; the membership verbs write three ('added'/'removed'/'made'/
 * 'demoted' against the USER, hung on the team branch) — exactly what the old
 * client logged.
 *
 * Settings clamps mirror the old client's write path (bc022c2:3098-3126).
 * The SQL CHECKs behind them (0011/0018/0044/0070) raised bare 23514s — no
 * verbatim sentences exist in this family; out-of-range numbers clamp like
 * the client's, malformed icon strings read badRequest. Team names are
 * trimmed and may not be blank. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { assertBillingWritable } from './lib/billingAccess'
import { byId } from './lib/db'
import { accessRemovalMutation, adminMutation, notFound, orgMutation, rule } from './lib/functions'
import { deleteTeamDeep } from './model/cascade'
import { assertNotLastTeam } from './model/orgs'
import { vHeldTasks } from './model/projectAccess'
import {
  addTeamMemberCore,
  createTeamCore,
  removeTeamMemberCore,
  setTeamLeaderCore,
  updateTeamCore,
} from './model/teams'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* Resolve a team uuid inside the caller's org — missing and foreign rows are
 * indistinguishable ("a team in an org I have no profile in reads exactly
 * like a nonexistent one", 0081:463). */
async function myTeam(ctx: MeCtx, id: string): Promise<Doc<'teams'>> {
  const team = await byId(ctx, 'teams', id)
  if (team === null || team.org_id !== ctx.me.org_id) throw notFound('team not found')
  return team
}

/* ----------------------------------------------------------------- create
 * P.addTeam — admin only; the client pre-generates the uuid; defaults are
 * newTeamDefaults (stale 120, archive 30, delay true). */
export const create = adminMutation({
  args: { id: v.string(), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await createTeamCore(ctx, { me: ctx.me, id, name, now: new Date().toISOString() })
    return null
  },
})

/* ----------------------------------------------------------------- update
 * P.updateTeam — rename + settings, admin or team leader. Same-value fields
 * are dropped from the patch (silent no-ops); an empty patch writes nothing. */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      icon: v.optional(v.union(v.string(), v.null())),
      icon_color: v.optional(v.union(v.string(), v.null())),
      stale_days: v.optional(v.number()),
      archive_days: v.optional(v.number()),
      track_delay_default: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { id, patch }) => {
    await updateTeamCore(ctx, { me: ctx.me, team: await myTeam(ctx, id), patch })
    return null
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.removeTeam → rpc delete_team. Guard order is the SQL's: fence, admin
 * sentence, then the last-team trigger. The cascade (model/cascade) preserves
 * every project; legacy team_id values are cleared, and team
 * access grants are removed. Nothing re-homes, labels survive, and activity
 * rows keep their team_id. The deleted team's membership rows then reach
 * organization admins only. No narration (the old client wrote no event). */
export const deleteDeep = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const team = await myTeam(ctx, id)
    if (ctx.me.org_role !== 'admin') throw rule('only organization admins can delete teams')
    await assertNotLastTeam(ctx, team)
    await deleteTeamDeep(ctx, { team, actor: ctx.me, now })
    return null
  },
})

/* -------------------------------------------------------------- addMember
 * P.addTeamMember. Grantee fenced to the team's org; a guest is never a team
 * member (0081 — the WITH CHECK had no sentence). An existing membership is a
 * silent no-op: no insert, no narration (the old client returned early). */
export const addMember = orgMutation({
  args: { team_id: v.string(), profile_id: v.string() },
  handler: async (ctx, { team_id, profile_id }) => {
    await addTeamMemberCore(ctx, {
      me: ctx.me,
      team: await myTeam(ctx, team_id),
      profileId: profile_id,
      now: new Date().toISOString(),
    })
    return null
  },
})

/* ----------------------------------------------------------- removeMember
 * P.removeAccess for a member leaving a team. A missing membership is a
 * silent no-op (the SQL delete matched 0 rows). Removing a leader drops the
 * leadership with the row. The open tasks the member can no longer see are
 * settled by `on_held_tasks` (absent means 'leave') in the same write, the
 * rule REST and MCP use (model/teams.ts removeTeamMemberCore), so a refused
 * reassignment or Viewer grant leaves the member in the team.
 * Leaving the tasks only takes access away (the projects shared with the
 * team), so an organization admin can still do it while billing has made the
 * organization read-only (accessRemovalMutation). Keeping the member as a
 * Viewer or reassigning their tasks writes more than that, so it meets the
 * billing gate like any other change, and so does a team leader who is not
 * an admin. Adding members stays behind the gate. */
export const removeMember = accessRemovalMutation({
  args: { team_id: v.string(), profile_id: v.string(), on_held_tasks: v.optional(vHeldTasks) },
  handler: async (ctx, { team_id, profile_id, on_held_tasks }) => {
    const held = on_held_tasks ?? 'leave'
    if (held !== 'leave') await assertBillingWritable(ctx, ctx.me.org_id)
    await removeTeamMemberCore(ctx, {
      me: ctx.me,
      team: await myTeam(ctx, team_id),
      profileId: profile_id,
      held,
      now: new Date().toISOString(),
    })
    return null
  },
})

/* -------------------------------------------------------------- setLeader
 * P.setTeamLeader. Same-value and missing-row calls are silent no-ops (T15 —
 * the old client pre-checked; the SQL update matched 0 changed rows).
 * Only people lead teams (lib/access canLeadTeams), so promoting an agent is
 * refused with a rule sentence the app toasts to a stale client that still
 * offers the Leader box for an agent. An agent's older leader row grants
 * nothing and can still be demoted.
 * Promoting a viewer is refused — "a viewer is never a team leader" (0102's
 * WITH CHECK; no sentence existed, so forbidden). Promoting a guest left
 * with a stale membership is refused too. Demoting stays allowed, so stale
 * leader rows can be cleared. There is no last-leader guard: a team may have
 * zero leaders. */
export const setLeader = orgMutation({
  args: { team_id: v.string(), profile_id: v.string(), is_leader: v.boolean() },
  handler: async (ctx, { team_id, profile_id, is_leader }) => {
    await setTeamLeaderCore(ctx, {
      me: ctx.me,
      team: await myTeam(ctx, team_id),
      profileId: profile_id,
      isLeader: is_leader,
      now: new Date().toISOString(),
    })
    return null
  },
})
