/* The profile domain's public surface: the org-seat
 * invitation door (create), the admin update door, removal, and the three
 * self/near-self setters. The OTHER invitation door — inviteGuest, the
 * cross-org project grant — lives in projects.ts.
 *
 * Ported bodies (final SQL state):
 *   profiles_insert / _update   is_org_admin (0081:124-126)
 *   remove_member               0100:206-222 — 'user not found' /
 *                               'you cannot remove yourself'
 *   set_plannable_hours         0094→0095→0099→0103 (final body 0103:70-100)
 *   set_display_name            0116:158-199 (+ profiles_name_narrate)
 *   set_message_retention       0110:56-77 as widened by 0112:49-76
 *   profiles_last_admin_*      model/orgs (0099) — fire conditions here
 *   profiles_viewer_leads_nothing  0102:391-411
 *   trigger-filled defaults     plannable_hours (0092 as amended 0103),
 *                               message_retention_days (0110 default 7 +
 *                               0112 sibling inheritance), initials (0116/0117)
 *
 * An invite IS a profile with an email and no accepted_at — the seat is the
 * invitation; claiming (identity.ts) stamps accepted_at/auth_user_id.
 *
 * message_retention_days is STAMPED on every create path (7 when no sibling
 * seat exists): in this schema ABSENT means "keep forever", the opposite of
 * the shipped Postgres default — omitting the field would flip every new seat
 * to Never. The 0112 inheritance copies even a sibling's Never.
 *
 * Rename narration fires on BOTH doors: update writes ONE row (an
 * admin's authority stops at their org), setDisplayName one row per touched
 * org — and only when the value actually changed. */

import type { WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId, insertUnique } from './lib/db'
import { isDemoDeployment, refuseDemoFeature, requireActiveDemo } from './lib/demo'
import { vOrgRole, vProfileKind } from './lib/enums'
import {
  adminMutation,
  authedMutation,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  require,
  rule,
} from './lib/functions'
import { logActivity } from './model/activity'
import { removeProfile } from './model/cascade'
import { assertNotLastAdmin, nameInitials, setPlannableHoursCore } from './model/orgs'

/* The only address check the database ever had (invite_project_guest's regex,
 * mirrored by the client's EMAIL_RE): something, @, something, dot, something,
 * no whitespace. The address is proved by someone signing in with it. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const normalizeEmail = (raw: string | null | undefined): string | undefined => {
  const e = (raw ?? '').trim().toLowerCase()
  return e === '' ? undefined : e
}

/* 0116's normalization, shared by both rename doors AND create: collapse
 * whitespace runs, trim; then the two profiles_name_shape rules as sentences
 * (the CHECK was bare — these are 0116's own RPC wordings). */
const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

function assertNameShape(name: string): void {
  if (name === '') throw rule('a name cannot be blank')
  if ([...name].length > 80) throw rule('a name is at most 80 characters')
}

const byCreated = (a: Doc<'profiles'>, b: Doc<'profiles'>) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0

/* profiles_inherit_message_retention (0112): a new seat starts where the
 * person's other seats already are — matched on login OR address across every
 * org, oldest sibling wins, and the value copies even when it is Never
 * (FOUND-not-null semantics). No sibling ⇒ the old column default, 7 —
 * stamped explicitly. */
async function inheritedRetention(
  ctx: QueryCtx,
  who: { auth_user_id?: string; email?: string },
): Promise<number | undefined> {
  const siblings: Doc<'profiles'>[] = []
  const auth = who.auth_user_id
  if (auth !== undefined) {
    siblings.push(
      ...(await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', auth))
        .collect()),
    )
  }
  const em = who.email
  if (em !== undefined) {
    const carriers = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', em))
      .collect()
    for (const p of carriers) {
      if (!siblings.some((s) => s._id === p._id)) siblings.push(p)
    }
  }
  if (siblings.length === 0) return 7
  siblings.sort(byCreated)
  return siblings[0].message_retention_days
}

/* The 0112/0116 fan-out predicate: every profile carrying the caller's login,
 * OR the address held by one of the caller's claimed seats (the unclaimed-
 * invitation arm). Inactive seats are matched too, as the SQL UPDATEs did. */
async function myMatchedSeats(ctx: QueryCtx & { authUserId: string }): Promise<Doc<'profiles'>[]> {
  const mine = await ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', ctx.authUserId))
    .collect()
  const matched = [...mine]
  if (isDemoDeployment()) {
    const demo = await requireActiveDemo(ctx, ctx.authUserId)
    return matched.filter((seat) => seat.org_id === demo.org_id)
  }
  const claimed = [...mine].sort(byCreated).find((p) => p.email !== undefined)
  const em = claimed?.email
  if (em !== undefined) {
    const carriers = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', em))
      .collect()
    for (const p of carriers) {
      if (!matched.some((s) => s._id === p._id)) matched.push(p)
    }
  }
  return matched
}

/* ----------------------------------------------------------------- create
 * P.addUser — the org-seat invitation, admin only. One mutation replaces the
 * old two-step insert (profile, then team_members): shape rules, per-org
 * address uniqueness, the trigger-filled defaults, membership
 * rows, and the 'added' narration all land or none do. */
export const create = adminMutation({
  args: {
    id: v.string(),
    name: v.string(),
    email: v.optional(v.union(v.string(), v.null())),
    org_role: vOrgRole,
    kind: vProfileKind,
    color: v.string(),
    teams: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    refuseDemoFeature()
    const now = new Date().toISOString()
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    const name = cleanName(args.name)
    assertNameShape(name)
    const isAgent = args.kind === 'agent'
    let email: string | undefined
    if (isAgent) {
      // profiles_agent_shape (0102:421-426): no mailbox, no login, and only
      // user/viewer — the one readable sentence in the family is 0102:443's
      if (normalizeEmail(args.email) !== undefined) {
        throw rule('An agent has no email address — its login is a key')
      }
      if (args.org_role === 'admin') {
        throw rule(
          'an agent cannot be an organization admin — it reaches only the projects it is added to',
        )
      }
      if (args.org_role === 'guest') throw badRequest('an agent is user or viewer — never a guest')
    } else {
      email = normalizeEmail(args.email)
      if (email === undefined || !EMAIL_SHAPE.test(email)) {
        throw rule('A person needs an email address — it is what they sign in with')
      }
      const held = email
      const dup = await ctx.db
        .query('profiles')
        .withIndex('by_org_email', (q) => q.eq('org_id', org.id).eq('email', held))
        .first()
      if (dup !== null) throw rule(`${email} already has a seat in this organization`)
    }
    const teams: Doc<'teams'>[] = []
    for (const tid of new Set(args.teams ?? [])) {
      const team = await byId(ctx, 'teams', tid)
      if (team === null || team.org_id !== org.id) throw notFound('team not found')
      teams.push(team)
    }
    if (teams.length > 0 && args.org_role === 'guest')
      throw forbidden('a guest is never a team member')
    await insertUnique(
      ctx,
      'profiles',
      'by_uuid',
      { id: args.id },
      {
        id: args.id,
        org_id: org.id,
        email,
        name,
        initials: nameInitials(name),
        color: args.color,
        org_role: args.org_role,
        active: true,
        kind: args.kind,
        // (kind='agent') = (hours is null), 0103; a person starts at the org default (0092)
        plannable_hours: isAgent ? undefined : org.default_plannable_hours,
        message_retention_days: await inheritedRetention(ctx, { email }),
        // accepted_at ABSENT: the seat IS the invitation (0118's kept column)
        created_at: now,
      },
      badRequest('a profile with this id already exists'),
    )
    for (const team of teams) {
      await ctx.db.insert('team_members', {
        team_id: team.id,
        profile_id: args.id,
        is_leader: false,
      })
    }
    await logActivity(ctx, {
      org_id: org.id,
      actor_id: ctx.me.id,
      verb: 'added',
      target_type: 'user',
      target_id: args.id,
      label: name,
      detail: isAgent ? 'to the organization as an agent' : 'to the organization',
      ts: now,
    })
    await markBillingMembershipChanged(ctx, org.id, email === undefined ? [] : [email])
    return null
  },
})

/* ----------------------------------------------------------------- update
 * P.updateUser minus plannableHours (its own fn below) — admin only. Guard
 * order: agent shape → last-admin → viewer-leads-nothing →
 * name → email → teams fences; then the writes. Role, active,
 * email and the teams diff narrate NOTHING; a real name change writes the
 * profiles_name_narrate row (ONE row — the admin's authority stops here). */
export const update = adminMutation({
  args: {
    id: v.string(),
    patch: v.object({
      org_role: v.optional(vOrgRole),
      active: v.optional(v.boolean()),
      name: v.optional(v.string()),
      email: v.optional(v.union(v.string(), v.null())),
      teams: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, { id, patch }) => {
    const now = new Date().toISOString()
    const row = await byId(ctx, 'profiles', id)
    if (row === null || row.org_id !== ctx.me.org_id) throw notFound('user not found')
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    const newRole = patch.org_role ?? row.org_role
    const newActive = patch.active ?? row.active

    if (row.kind === 'agent' && newRole === 'admin') {
      throw rule(
        'an agent cannot be an organization admin — it reaches only the projects it is added to',
      )
    }
    if (row.kind === 'agent' && newRole === 'guest') {
      throw badRequest('an agent is user or viewer — never a guest')
    }

    const upd: Partial<WithoutSystemFields<Doc<'profiles'>>> = {}
    let renamedFrom: string | undefined
    if (patch.name !== undefined) {
      const name = cleanName(patch.name)
      assertNameShape(name)
      if (name !== row.name) {
        upd.name = name
        upd.initials = nameInitials(name)
        renamedFrom = row.name
      }
    }
    // the viewer-leads sentence names the person — by their post-patch name,
    // as the BEFORE trigger's new.name did
    const effectiveName = upd.name ?? row.name

    // last admin: fires when (old admin AND active) stops being (new admin AND
    // active) — demotion and deactivation share the sentence (0099)
    if (row.org_role === 'admin' && row.active && !(newRole === 'admin' && newActive)) {
      await assertNotLastAdmin(ctx, row, 'demote')
    }

    // viewer-leads-nothing (0102:391-411), agents included; existing grants
    // are deliberately KEPT — they are what the viewer sees through
    if (newRole === 'viewer' && row.org_role !== 'viewer') {
      const led = await ctx.db
        .query('projects')
        .withIndex('by_lead', (q) => q.eq('lead_id', row.id))
        .collect()
      if (led.length > 0) {
        throw rule(
          `${effectiveName} leads ${led.length} project(s) — hand those over before making them a viewer`,
        )
      }
      let teamsLed = 0
      const memberships = ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', row.id))
      for await (const tm of memberships) {
        if (tm.is_leader) teamsLed += 1
      }
      if (teamsLed > 0) {
        throw rule(
          `${effectiveName} leads ${teamsLed} team(s) — hand those over before making them a viewer`,
        )
      }
    }

    if (patch.org_role !== undefined && patch.org_role !== row.org_role)
      upd.org_role = patch.org_role
    if (patch.active !== undefined && patch.active !== row.active) upd.active = patch.active

    if (patch.email !== undefined) {
      refuseDemoFeature()
      // only while the seat is UNCLAIMED; corrected, never emptied (0104).
      // Client sentences, now server-owned
      if (row.kind === 'agent') throw rule('An agent has no email address — its login is a key')
      if (row.auth_user_id !== undefined) {
        throw rule('This seat has been claimed — its address is the one they signed in with')
      }
      const email = normalizeEmail(patch.email)
      if (email === undefined || !EMAIL_SHAPE.test(email)) {
        throw rule('A person needs an email address — it is what they sign in with')
      }
      if (email !== row.email) {
        const dup = await ctx.db
          .query('profiles')
          .withIndex('by_org_email', (q) => q.eq('org_id', row.org_id).eq('email', email))
          .first()
        if (dup !== null) throw rule(`${email} already has a seat in this organization`)
        upd.email = email
      }
    }

    // teams diff — untouched memberships keep their is_leader; adds arrive
    // as plain members; removals drop leadership with the row. No narration
    // (the old updateUser wrote none — unlike teams.addMember; keep the
    // asymmetry)
    let dels: Doc<'team_members'>[] = []
    const adds: Doc<'teams'>[] = []
    if (patch.teams !== undefined) {
      const next = new Set(patch.teams)
      const mine = await ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', row.id))
        .collect()
      const held = new Set(mine.map((m) => m.team_id))
      dels = mine.filter((m) => !next.has(m.team_id))
      for (const tid of next) {
        if (held.has(tid)) continue
        const team = await byId(ctx, 'teams', tid)
        if (team === null || team.org_id !== row.org_id) throw notFound('team not found')
        adds.push(team)
      }
      if (adds.length > 0 && newRole === 'guest') throw forbidden('a guest is never a team member')
    }

    if (Object.keys(upd).length > 0) await ctx.db.patch(row._id, upd)
    if (renamedFrom !== undefined) {
      await logActivity(ctx, {
        org_id: row.org_id,
        actor_id: ctx.me.id,
        verb: 'renamed',
        target_type: 'user',
        target_id: row.id,
        label: upd.name as string,
        detail: `from “${renamedFrom}”`,
        ts: now,
      })
    }
    for (const m of dels) await ctx.db.delete(m._id)
    for (const team of adds) {
      await ctx.db.insert('team_members', {
        team_id: team.id,
        profile_id: row.id,
        is_leader: false,
      })
    }
    if (upd.active !== undefined || upd.org_role !== undefined || upd.email !== undefined) {
      await markBillingMembershipChanged(
        ctx,
        row.org_id,
        [row.email, upd.email].filter((email): email is string => email !== undefined),
      )
    }
    return null
  },
})

/* ----------------------------------------------------------------- remove
 * P.removeUser → rpc remove_member (0100). orgMutation, NOT adminMutation:
 * the SQL folded "no such row", "not your org" and "not an admin" into ONE
 * raised sentence — a stranger probing uuids learns nothing. The cascade
 * (model/cascade.removeProfile) owns every FK edge incl. the avatar bytes;
 * the 'removed' narration is the caller's, after the cascade. */
export const remove = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const target = await byId(ctx, 'profiles', id)
    if (target === null || target.org_id !== ctx.me.org_id || ctx.me.org_role !== 'admin') {
      throw rule('user not found')
    }
    if (target.id === ctx.me.id) throw rule('you cannot remove yourself')
    if (target.org_role === 'admin' && target.active)
      await assertNotLastAdmin(ctx, target, 'remove')
    await removeProfile(ctx, { profile: target, now })
    await logActivity(ctx, {
      org_id: target.org_id,
      actor_id: ctx.me.id,
      verb: 'removed',
      target_type: 'user',
      target_id: target.id,
      label: target.name,
      detail: 'from the organization',
      ts: now,
    })
    await markBillingMembershipChanged(
      ctx,
      target.org_id,
      target.email === undefined ? [] : [target.email],
    )
    return null
  },
})

/* ------------------------------------------------------- setPlannableHours
 * The ONE write path for the column (0094→0095→0099→0103). orgMutation, not
 * adminMutation: a mere team leader qualifies. The rule body — rights /
 * agent / range, in that order — lives in model/orgs.setPlannableHoursCore,
 * shared verbatim with MCP's update_user (phase 8). */
export const setPlannableHours = orgMutation({
  args: { profile_id: v.string(), hours: v.number() },
  handler: async (ctx, { profile_id, hours }) => {
    await setPlannableHoursCore(ctx, { me: ctx.me, profile_id, hours })
    return null
  },
})

/* --------------------------------------------------------- setDisplayName
 * set_display_name (0116) — awaited by the client, which capitalizes and
 * shows whatever sentence comes back; null means it landed. Renames EVERY
 * seat this login holds (auth arm + the claimed address's unclaimed-invite
 * arm, 0112's predicate) and re-derives the initials. One 'renamed' row per
 * touched org — the narration trigger fired only where the value actually
 * moved, so an already-matching seat is a silent no-op (T15). The actor is
 * the caller's profile in THAT org (for a self-rename, the renamed row
 * itself); an org where the caller holds no active claimed seat narrates
 * with no actor — the feed's neutral "Someone". */
export const setDisplayName = authedMutation({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const now = new Date().toISOString()
    const name = cleanName(args.name)
    if (name === '') return 'a name cannot be blank'
    if ([...name].length > 80) return 'a name is at most 80 characters'
    const matched = await myMatchedSeats(ctx)
    if (matched.length === 0) return 'no profile for this account'
    const initials = nameInitials(name)
    for (const p of matched) {
      if (p.name === name) continue
      await ctx.db.patch(p._id, { name, initials })
      await logActivity(ctx, {
        org_id: p.org_id,
        actor_id: ctx.myProfiles.get(p.org_id)?.id,
        verb: 'renamed',
        target_type: 'user',
        target_id: p.id,
        label: name,
        detail: `from “${p.name}”`,
        ts: now,
      })
    }
    return null
  },
})

/* ---------------------------------------------------- setMessageRetention
 * set_message_retention (0110 as widened by 0112): retention follows the
 * person — every seat matched by login or claimed address, unclaimed invites
 * included. null = Never, stored as ABSENT (the field is removed); an agent
 * has no login, so this can never reach one. No narration. */
export const setMessageRetention = authedMutation({
  args: { days: v.union(v.number(), v.null()) },
  handler: async (ctx, { days }) => {
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      throw rule('message retention must be NULL (never) or a whole number of days from 1 to 3650')
    }
    const matched = await myMatchedSeats(ctx)
    if (matched.length === 0) throw rule('no profile for this account')
    const value = days ?? undefined
    for (const p of matched) {
      if (p.message_retention_days === value) continue
      await ctx.db.patch(p._id, { message_retention_days: value })
    }
    return null
  },
})

/* inviteGuest (invite_project_guest) lives in projects.ts: the cross-org
 * invitation belongs with the project surface it
 * fences through; the guest-seat traps it carries (T2 retention stamp, T13
 * upper(left(local-part,2)) initials, the T12 'lead, member or viewer'
 * sentence) are honored there. */
