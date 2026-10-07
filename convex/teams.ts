/* The team domain's public surface: create / settings /
 * delete + the three membership verbs. Thin wrappers over lib/access,
 * model/orgs and model/cascade.
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
 *
 * Narration is asymmetric BY DESIGN: create/update/delete write NO
 * activity; the membership verbs write three ('added'/'removed'/'made'/
 * 'demoted' against the USER, hung on the team branch) — exactly what the old
 * client logged.
 *
 * Settings clamps mirror the old client's write path (bc022c2:3098-3126).
 * The SQL CHECKs behind them (0011/0018/0044/0070) raised bare 23514s — no
 * verbatim sentences exist in this family; out-of-range numbers clamp like
 * the client's, malformed icon strings read badRequest. */

import type { WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { isTeamLeader } from './lib/access'
import { byId, insertUnique } from './lib/db'
import { adminMutation, badRequest, forbidden, notFound, orgMutation, rule } from './lib/functions'
import { logActivity } from './model/activity'
import { deleteTeamDeep } from './model/cascade'
import { assertNotLastTeam, ICON_COLOR_SHAPE, newTeamDefaults } from './model/orgs'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* Resolve a team uuid inside the caller's org — missing and foreign rows are
 * indistinguishable ("a team in an org I have no profile in reads exactly
 * like a nonexistent one", 0081:463). */
async function myTeam(ctx: MeCtx, id: string): Promise<Doc<'teams'>> {
  const team = await byId(ctx, 'teams', id)
  if (team === null || team.org_id !== ctx.me.org_id) throw notFound('team not found')
  return team
}

/* teams_update / tm_* rights: org admin, or leader of THIS team. */
async function assertRunsTeam(ctx: MeCtx, team: Doc<'teams'>): Promise<void> {
  if (ctx.me.org_role === 'admin') return
  if (await isTeamLeader(ctx, ctx.me, team.id)) return
  throw forbidden('requires an organization admin or a leader of this team')
}

const membership = (ctx: MeCtx, teamId: string, profileId: string) =>
  ctx.db
    .query('team_members')
    .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
    .unique()

/* The old client's whole-number clamp (Math.round + range), range per column. */
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)))

/* ----------------------------------------------------------------- create
 * P.addTeam — admin only; the client pre-generates the uuid; defaults are
 * newTeamDefaults (stale 120, archive 30, delay true). */
export const create = adminMutation({
  args: { id: v.string(), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const now = new Date().toISOString()
    await insertUnique(
      ctx,
      'teams',
      'by_uuid',
      { id },
      { id, org_id: ctx.me.org_id, name, ...newTeamDefaults(now) },
      badRequest('a team with this id already exists'),
    )
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
    const team = await myTeam(ctx, id)
    await assertRunsTeam(ctx, team)
    const upd: Partial<WithoutSystemFields<Doc<'teams'>>> = {}
    if (patch.name !== undefined && patch.name !== team.name) upd.name = patch.name
    if (patch.icon !== undefined) {
      const icon = patch.icon === null || patch.icon === '' ? undefined : patch.icon
      if (icon !== undefined && [...icon].length > 40)
        throw badRequest('an icon is at most 40 characters')
      if (icon !== team.icon) upd.icon = icon
    }
    if (patch.icon_color !== undefined) {
      const color =
        patch.icon_color === null || patch.icon_color === '' ? undefined : patch.icon_color
      if (color !== undefined && !ICON_COLOR_SHAPE.test(color)) {
        throw badRequest('an icon color must be a #rrggbb hex')
      }
      if (color !== team.icon_color) upd.icon_color = color
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
    if (Object.keys(upd).length > 0) await ctx.db.patch(team._id, upd)
    return null
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.removeTeam → rpc delete_team. Guard order is the SQL's: fence, admin
 * sentence, then the last-team trigger. The cascade (model/cascade) preserves
 * every project; legacy team_id values are cleared, and team
 * access grants are removed. Nothing re-homes, labels survive, and activity
 * rows survive with team_id nulled. No narration (the old client wrote no
 * event). */
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
    const now = new Date().toISOString()
    const team = await myTeam(ctx, team_id)
    await assertRunsTeam(ctx, team)
    const grantee = await byId(ctx, 'profiles', profile_id)
    if (grantee === null || grantee.org_id !== ctx.me.org_id) throw notFound('user not found')
    if (grantee.org_role === 'guest') throw forbidden('a guest is never a team member')
    if ((await membership(ctx, team.id, grantee.id)) !== null) return null
    await ctx.db.insert('team_members', {
      team_id: team.id,
      profile_id: grantee.id,
      is_leader: false,
    })
    await logActivity(ctx, {
      org_id: team.org_id,
      actor_id: ctx.me.id,
      verb: 'added',
      target_type: 'user',
      target_id: grantee.id,
      label: grantee.name,
      detail: `to ${team.name}`,
      team_id: team.id,
      ts: now,
    })
    return null
  },
})

/* ----------------------------------------------------------- removeMember
 * P.removeTeamMember. A missing membership is a silent no-op (the SQL delete
 * matched 0 rows). Removing a leader drops the leadership with the row. */
export const removeMember = orgMutation({
  args: { team_id: v.string(), profile_id: v.string() },
  handler: async (ctx, { team_id, profile_id }) => {
    const now = new Date().toISOString()
    const team = await myTeam(ctx, team_id)
    await assertRunsTeam(ctx, team)
    const row = await membership(ctx, team.id, profile_id)
    if (row === null) return null
    await ctx.db.delete(row._id)
    const gone = await byId(ctx, 'profiles', profile_id)
    if (gone !== null) {
      await logActivity(ctx, {
        org_id: team.org_id,
        actor_id: ctx.me.id,
        verb: 'removed',
        target_type: 'user',
        target_id: gone.id,
        label: gone.name,
        detail: `from ${team.name}`,
        team_id: team.id,
        ts: now,
      })
    }
    return null
  },
})

/* -------------------------------------------------------------- setLeader
 * P.setTeamLeader. Same-value and missing-row calls are silent no-ops (T15 —
 * the old client pre-checked; the SQL update matched 0 changed rows).
 * Promoting a viewer is refused — "a viewer is never a team leader" (0102's
 * WITH CHECK; no sentence existed, so forbidden). There is no last-leader
 * guard: a team may have zero leaders. */
export const setLeader = orgMutation({
  args: { team_id: v.string(), profile_id: v.string(), is_leader: v.boolean() },
  handler: async (ctx, { team_id, profile_id, is_leader }) => {
    const now = new Date().toISOString()
    const team = await myTeam(ctx, team_id)
    await assertRunsTeam(ctx, team)
    const row = await membership(ctx, team.id, profile_id)
    if (row === null || row.is_leader === is_leader) return null
    const member = await byId(ctx, 'profiles', profile_id)
    if (is_leader && member !== null && member.org_role === 'viewer') {
      throw forbidden('a viewer is never a team leader')
    }
    await ctx.db.patch(row._id, { is_leader })
    if (member !== null) {
      await logActivity(ctx, {
        org_id: team.org_id,
        actor_id: ctx.me.id,
        verb: is_leader ? 'made' : 'demoted',
        target_type: 'user',
        target_id: member.id,
        label: member.name,
        detail: `${is_leader ? 'a leader of ' : 'from leader of '}${team.name}`,
        team_id: team.id,
        ts: now,
      })
    }
    return null
  },
})
