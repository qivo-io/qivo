/* The project domain's public surface (phase 5): create / update /
 * archive / unarchive / deleteDeep / inviteGuest,
 * plus the milestones CRUD (there is no milestones.ts). Thin wrappers over lib/access,
 * model/orgs and model/cascade — orgMutation → resolve by uuid → access
 * predicate → guards → writes → narration, all under ONE `now`.
 *
 * Refusal posture (the 0049/0056 no-oracle discipline):
 * - an unknown OR foreign-org project/milestone uuid reads `not_found`
 *   ('project not found' / 'milestone not found') — never an existence reveal;
 * - insufficient level on the plain RLS surfaces (update/archive/unarchive,
 *   milestones, grant writes) reads `forbidden` — the silent-0-row successor,
 *   the client shows its fixed permission toast;
 * - deleteDeep keeps its P0001 sentence as `rule`, verbatim; inviteGuest
 *   uses the project's explicit user-management permission refusal;
 * - the hierarchy/archive trigger sentences are `rule`, verbatim per surface:
 *   'the project is archived — restore it first' (new sub under an archived
 *   meta, 0106:68) is deliberately NOT the issue/milestone arrival sentence
 *   'that project is archived — restore it first' (0106:131/148).
 *
 * parent_id / type / org_id are immutable after create. Projects and
 * sub-projects have a lead, never an owning team. Teams and users receive
 * explicit permission grants. team_id remains an optional legacy column so
 * old development rows can be read and cleaned up safely.
 *
 * The old client's accessGate ordering (a lead handover's demotion row had to
 * land before the lead_id update or RLS refused the grant writes) is NOT
 * ported — field patch and access diff commit in one mutation. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import {
  canManageOwnProjectAccess,
  canManageProjectTeams,
  canManageProjectUsers,
  hasProjectLevel,
  isOrgStaff,
} from './lib/access'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId, insertUnique } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { type GrantLevel, vGrantLevel, vProjectType } from './lib/enums'
import { badRequest, forbidden, notFound, orgMutation, require, rule } from './lib/functions'
import { logActivity } from './model/activity'
import { deleteProjectDeep } from './model/cascade'
import { ICON_COLOR_SHAPE, newUuid, nextProjectNum, weekLabel } from './model/orgs'
import { cleanReviewHours, projectDescription } from './model/projects'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* projects_key_ck (0001:62): 1–5 uppercase alphanumerics. Bare 23514/23505 in
 * SQL — badRequest lands in the client's same generic toast bucket. */
const KEY_SHAPE = /^[A-Z0-9]{1,5}$/

function cleanKey(raw: string): string {
  if (!KEY_SHAPE.test(raw)) throw badRequest('a project key is 1-5 uppercase letters or digits')
  return raw
}

async function assertKeyFree(
  ctx: QueryCtx,
  orgId: string,
  key: string,
  self?: string,
): Promise<void> {
  const holder = await ctx.db
    .query('projects')
    .withIndex('by_org_key', (q) => q.eq('org_id', orgId).eq('key', key))
    .first()
  if (holder !== null && holder.id !== self) {
    throw badRequest('a project with that key already exists in this organization')
  }
}

/* Unknown and foreign-org rows are indistinguishable (0049/0056). The
 * sentence is delete_project's own (0081:479). */
async function myProject(ctx: MeCtx, id: string): Promise<Doc<'projects'>> {
  const project = await byId(ctx, 'projects', id)
  if (project === null || project.org_id !== ctx.me.org_id) throw notFound('project not found')
  return project
}

/* projects_update is lead level (0106 left it as the rule — no RPC), so the
 * plain surfaces refuse as the silent 0-row did. */
async function assertLead(ctx: MeCtx, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, ctx.me, projectId, 'lead'))) {
    throw forbidden('requires lead access to this project')
  }
}

/* project_lead_same_org (0102:311-329), on create and on an actual CHANGE of
 * lead. Only reachable for a profile in the caller's own organization, so the
 * viewer sentence says nothing a stranger could not already see. */
async function assertLeadAllowed(ctx: MeCtx, leadId: string): Promise<void> {
  const p = await byId(ctx, 'profiles', leadId)
  if (p === null || p.org_id !== ctx.me.org_id) {
    throw rule("the lead must be a member of the project's organization")
  }
  if (!p.active || (p.org_role !== 'admin' && p.org_role !== 'user' && p.org_role !== 'guest')) {
    if (p.org_role === 'viewer') {
      throw rule('a viewer cannot lead a project — make them a standard user first')
    }
    throw rule('the lead must be an active organization user')
  }
}

/* pa_insert/pa_update's WITH CHECK (0081:275-283 + 0102:365-384): the grantee
 * holds a profile in the project's org (a guest qualifies — that is the whole
 * point), and a viewer-role grantee only ever receives a 'viewer' grant.
 * Refusing silently was the RLS behavior — surfaced as forbidden. */
async function assertGrantee(
  ctx: MeCtx,
  project: Doc<'projects'>,
  profileId: string,
  level: GrantLevel,
): Promise<void> {
  const p = await byId(ctx, 'profiles', profileId)
  if (p === null || p.org_id !== project.org_id) {
    throw forbidden('the grantee must hold a profile in this organization')
  }
  if (level !== 'viewer' && p.org_role === 'viewer') {
    throw forbidden('a viewer can only receive a viewer grant')
  }
}

/* The access-map values a client may send: stored grants are vGrantLevel
 * only (project_access_level_ck, 0013→0098); 'lead' entries are legal on the
 * wire and DROPPED — the lead is carried by lead_id, never a grant row. */
const vAccessMap = v.record(v.string(), v.union(vGrantLevel, v.literal('lead')))
const vTeamAccessMap = v.record(v.string(), vGrantLevel)

async function assertTeamGrantee(ctx: MeCtx, project: Doc<'projects'>, teamId: string) {
  const team = await byId(ctx, 'teams', teamId)
  if (team === null || team.org_id !== project.org_id) {
    throw forbidden('the team must belong to this organization')
  }
}

const grantEntries = (map: Record<string, GrantLevel | 'lead'>): [string, GrantLevel][] =>
  Object.entries(map).filter((e): e is [string, GrantLevel] => e[1] !== 'lead')

/* ----------------------------------------------------------------- create
 * P.addProject. The client pre-generates the uuid and reconciles its key
 * preview off the returned num (the old select('num').single() round trip). */
export const create = orgMutation({
  args: {
    id: v.string(),
    type: vProjectType,
    team_id: v.optional(v.union(v.string(), v.null())),
    parent_id: v.optional(v.union(v.string(), v.null())),
    key: v.string(),
    name: v.string(),
    icon: v.optional(v.union(v.string(), v.null())),
    icon_color: v.optional(v.union(v.string(), v.null())),
    lead_id: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    sort_order: v.number(),
    track_delay: v.optional(v.boolean()),
    access: v.optional(vAccessMap),
    team_access: v.optional(vTeamAccessMap),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const team_id = args.team_id ?? undefined
    const parent_id = args.parent_id ?? undefined
    const lead_id = args.lead_id ?? ctx.me.id
    // Neither products nor sub-projects have an owning team. A parent is the
    // only structural requirement for a sub-project; permissions are explicit
    // grants below.
    if (team_id !== undefined) {
      throw badRequest('projects cannot belong to a team; use team access instead')
    }
    if (args.type === 'meta') {
      if (parent_id !== undefined) throw badRequest('a project cannot have a parent')
      // Without a managing team there is no team-leader gate. Organization
      // staff can create a product; its lead controls it afterwards.
      if (!isOrgStaff(ctx.me)) {
        throw forbidden('no permission to create a project')
      }
    } else {
      if (parent_id === undefined) {
        throw badRequest('a sub-project needs a parent')
      }
      // projects_hierarchy_guard (0078:341-349) + archive-parent guard
      // (0106:68), fence first — a foreign parent reads like a missing one
      const parent = await byId(ctx, 'projects', parent_id)
      if (parent === null || parent.org_id !== ctx.me.org_id) {
        throw rule(`parent project ${parent_id} not found`)
      }
      if (parent.type !== 'meta') {
        throw rule('sub-projects live directly under a project, never under another sub-project')
      }
      if (parent.archived_at !== undefined) {
        throw rule('the project is archived — restore it first')
      }
      if (!(await hasProjectLevel(ctx, ctx.me, parent_id, 'lead'))) {
        throw forbidden('requires lead access to this project')
      }
    }
    if (args.type === 'project' && (args.icon != null || args.icon_color != null)) {
      throw badRequest('sub-projects carry no icon')
    }
    const iconColor = args.icon_color === '' ? undefined : (args.icon_color ?? undefined)
    if (iconColor !== undefined && !ICON_COLOR_SHAPE.test(iconColor)) {
      throw badRequest('an icon color must be a #rrggbb hex')
    }
    const key = cleanKey(args.key)
    const description = projectDescription(args.description)
    await assertKeyFree(ctx, ctx.me.org_id, key)
    if (lead_id !== undefined) await assertLeadAllowed(ctx, lead_id)
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org !== null, notFound('organization not found'))
    const num = await nextProjectNum(ctx, org)
    await insertUnique(
      ctx,
      'projects',
      'by_uuid',
      { id: args.id },
      {
        id: args.id,
        org_id: ctx.me.org_id,
        team_id: undefined,
        type: args.type,
        parent_id: args.type === 'meta' ? undefined : parent_id,
        key,
        name: args.name,
        icon: args.icon ?? undefined,
        icon_color: iconColor,
        lead_id,
        description,
        sort_order: args.sort_order,
        num,
        // Teamless projects use the neutral default unless explicitly set.
        track_delay: args.track_delay ?? true,
        created_at: now,
      },
      badRequest('a project with this id already exists'),
    )
    // Grant rows ride along on either project level. Root grants are inherited
    // by children by the access helpers; child grants can further narrow a
    // workstream without introducing an owning team.
    if (args.access !== undefined) {
      const project = (await byId(ctx, 'projects', args.id)) as Doc<'projects'>
      for (const [uid, level] of grantEntries(args.access)) {
        await assertGrantee(ctx, project, uid, level)
        await ctx.db.insert('project_access', { project_id: project.id, profile_id: uid, level })
      }
    }
    if (args.team_access !== undefined) {
      const project = (await byId(ctx, 'projects', args.id)) as Doc<'projects'>
      const shares = args.team_access ?? {}
      for (const [sharedTeamId, level] of Object.entries(shares)) {
        await assertTeamGrantee(ctx, project, sharedTeamId)
        await ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id: sharedTeamId,
          level,
        })
      }
    }
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'created',
      target_type: 'project',
      target_id: args.id,
      label: args.name,
      project_id: args.id,
      ts: now,
    })
    return { id: args.id, num }
  },
})

/* ----------------------------------------------------------------- update
 * P.updateProject / P.setProjectAccess. Field patch + access-map diff in ONE
 * mutation. Exactly one narration per call, else-if priority access > name >
 * lead; same-value name/lead writes are silent no-ops (the cross-cutting
 * rule), and icon/description/key/track_delay/review_hours alone narrate
 * nothing. KEY CHANGE IS ALLOWED — issue refs are QN-num since 0050 — with
 * shape and uniqueness revalidated. */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      icon: v.optional(v.union(v.string(), v.null())),
      icon_color: v.optional(v.union(v.string(), v.null())),
      lead_id: v.optional(v.union(v.string(), v.null())),
      description: v.optional(v.union(v.string(), v.null())),
      key: v.optional(v.string()),
      track_delay: v.optional(v.boolean()),
      review_hours: v.optional(v.union(v.number(), v.null())),
      access: v.optional(vAccessMap),
      team_access: v.optional(vTeamAccessMap),
    }),
  },
  handler: async (ctx, { id, patch }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, id)
    const managesUsers =
      patch.access !== undefined || (project.type === 'meta' && patch.lead_id !== undefined)
    const managesTeams = patch.team_access !== undefined
    const editsSettings = Object.keys(patch).some(
      (key) =>
        key !== 'access' &&
        key !== 'team_access' &&
        !(key === 'lead_id' && project.type === 'meta'),
    )
    // Evaluate all capabilities against the pre-write state. A delegate may
    // not attach a settings change to an access patch, or grant themselves
    // lead standing first and use it for the rest of this same mutation.
    if (editsSettings || (!managesUsers && !managesTeams)) await assertLead(ctx, id)
    if (managesUsers && !(await canManageProjectUsers(ctx, ctx.me, project))) {
      throw forbidden('no permission to manage users on this project')
    }
    const controlsOwnAccess = await canManageOwnProjectAccess(ctx, ctx.me, project)
    if (managesTeams && !(await canManageProjectTeams(ctx, ctx.me, project))) {
      throw forbidden('no permission to manage users on this project')
    }
    // projects_sub_no_icon (0069): the glyph/tint stays a meta feature
    if (project.type === 'project' && (patch.icon != null || patch.icon_color != null)) {
      throw badRequest('sub-projects carry no icon')
    }
    const db: Partial<Doc<'projects'>> = {}
    if (patch.name !== undefined) db.name = patch.name
    if (patch.icon !== undefined) db.icon = patch.icon ?? undefined
    if (patch.icon_color !== undefined) {
      const color =
        patch.icon_color === null || patch.icon_color === '' ? undefined : patch.icon_color
      if (color !== undefined && !ICON_COLOR_SHAPE.test(color)) {
        throw badRequest('an icon color must be a #rrggbb hex')
      }
      db.icon_color = color
    }
    if (patch.description !== undefined) db.description = projectDescription(patch.description)
    if (patch.track_delay !== undefined) db.track_delay = patch.track_delay
    // null clears: undefined unsets the column through ctx.db.patch
    if (patch.review_hours !== undefined) db.review_hours = cleanReviewHours(patch.review_hours)
    if (patch.key !== undefined) {
      const key = cleanKey(patch.key)
      await assertKeyFree(ctx, ctx.me.org_id, key, id)
      db.key = key
    }
    const prevLead = project.lead_id
    const nextLead = patch.lead_id === undefined ? prevLead : (patch.lead_id ?? undefined)
    const leadChanged = nextLead !== prevLead
    const editsOwnLead =
      nextLead === ctx.me.id || (prevLead === ctx.me.id && nextLead === undefined)
    if (project.type === 'meta' && leadChanged && editsOwnLead && !controlsOwnAccess) {
      throw forbidden(
        'only organization admins or project leads can change their own project access',
      )
    }
    if (patch.lead_id !== undefined) {
      if (nextLead === undefined) throw badRequest('a project must have a lead')
      // the 0102 trigger revalidates only an actual CHANGE to a non-null lead
      if (leadChanged && nextLead !== undefined) await assertLeadAllowed(ctx, nextLead)
      db.lead_id = nextLead
    }
    if (patch.access !== undefined) {
      const next = new Map(grantEntries(patch.access))
      const prev = await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', id))
        .collect()
      const held = new Map(prev.map((r) => [r.profile_id, r]))
      const selfChanged = held.get(ctx.me.id)?.level !== next.get(ctx.me.id)
      // Lead handover may retain the outgoing lead as a User in the
      // same atomic patch. Their previous effective Lead access is reduced,
      // never elevated; other self edits remain reserved to the strict role.
      const handsOverLead =
        prevLead === ctx.me.id &&
        leadChanged &&
        nextLead !== undefined &&
        next.get(ctx.me.id) === 'user'
      if (selfChanged && !controlsOwnAccess && !handsOverLead) {
        throw forbidden(
          'only organization admins or project leads can change their own project access',
        )
      }
      for (const [uid, level] of next) {
        const row = held.get(uid)
        if (row !== undefined && row.level === level) continue
        await assertGrantee(ctx, project, uid, level)
        if (row !== undefined) await ctx.db.patch(row._id, { level })
        else await ctx.db.insert('project_access', { project_id: id, profile_id: uid, level })
      }
      for (const row of prev) {
        if (!next.has(row.profile_id)) await ctx.db.delete(row._id)
      }
    }
    if (patch.team_access !== undefined) {
      const next = new Map(Object.entries(patch.team_access))
      const prev = await ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', id))
        .collect()
      const held = new Map(prev.map((row) => [row.team_id, row]))
      for (const [teamId, level] of next) {
        await assertTeamGrantee(ctx, project, teamId)
        const row = held.get(teamId)
        if (row === undefined) {
          await ctx.db.insert('project_team_access', { project_id: id, team_id: teamId, level })
        } else if (row.level !== level) await ctx.db.patch(row._id, { level })
      }
      for (const row of prev) {
        if (!next.has(row.team_id)) await ctx.db.delete(row._id)
      }
    }
    if (Object.keys(db).length > 0) await ctx.db.patch(project._id, db)
    const name = db.name ?? project.name
    const nameChanged = patch.name !== undefined && patch.name !== project.name
    const event = {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      target_type: 'project' as const,
      target_id: id,
      label: name,
      project_id: id,
      ts: now,
    }
    if (patch.access !== undefined || patch.team_access !== undefined) {
      await logActivity(ctx, { ...event, verb: 'changed access on' })
    } else if (nameChanged) {
      await logActivity(ctx, { ...event, verb: 'renamed', detail: `from “${project.name}”` })
    } else if (leadChanged) {
      const from = prevLead === undefined ? null : await byId(ctx, 'profiles', prevLead)
      const to = nextLead === undefined ? null : await byId(ctx, 'profiles', nextLead)
      await logActivity(ctx, {
        ...event,
        verb: to !== null ? 'changed the lead of' : 'removed the lead of',
        detail:
          to !== null
            ? `to ${to.name}${from !== null ? ` (was ${from.name})` : ''}`
            : from !== null
              ? `(was ${from.name})`
              : undefined,
      })
    }
    return null
  },
})

/* ---------------------------------------------------------------- archive
 * P.archiveProject. Subtree-atomic (0106:86-91): a meta stamps its active
 * subs with the parent's OWN instant — that shared stamp is the only record
 * of "these came along", and unarchive reads it. Existing tasks are
 * untouched; the snapshot stops shipping them because its section filters on
 * project.archived_at. Already archived ⇒ silent no-op. */
export const archive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, id)
    await assertLead(ctx, id)
    if (project.archived_at !== undefined) return null
    let carried = 0
    if (project.type === 'meta') {
      const subs = await ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', id))
        .collect()
      for (const s of subs) {
        if (s.archived_at === undefined) {
          await ctx.db.patch(s._id, { archived_at: now })
          carried += 1
        }
      }
    }
    await ctx.db.patch(project._id, { archived_at: now })
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'archived',
      target_type: 'project',
      target_id: id,
      label: project.name,
      detail: carried > 0 ? `with ${carried} sub-project${carried > 1 ? 's' : ''}` : undefined,
      project_id: id,
      ts: now,
    })
    return null
  },
})

/* -------------------------------------------------------------- unarchive
 * P.unarchiveProject — awaited by the client; the snapshot pulls the
 * restored rows back in reactively. Restore semantics 0106:92-107: restoring
 * a sub surfaces its parent (and nothing else — the parent's other subs stay
 * archived); restoring a meta directly also restores exactly the subs
 * carrying the meta's own archive stamp. Not archived ⇒ silent no-op. */
export const unarchive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, id)
    await assertLead(ctx, id)
    if (project.archived_at === undefined) return null
    const stamp = project.archived_at
    await ctx.db.patch(project._id, { archived_at: undefined })
    if (project.parent_id !== undefined) {
      // an active project never sits under an archived one
      const parent = await byId(ctx, 'projects', project.parent_id)
      if (parent !== null && parent.archived_at !== undefined) {
        await ctx.db.patch(parent._id, { archived_at: undefined })
      }
    } else {
      const subs = await ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', id))
        .collect()
      for (const s of subs) {
        if (s.archived_at === stamp) await ctx.db.patch(s._id, { archived_at: undefined })
      }
    }
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'restored',
      target_type: 'project',
      target_id: id,
      label: project.name,
      detail: 'from the archive',
      project_id: id,
      ts: now,
    })
    return null
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.removeProject → delete_project (0081:473-488; wording 0078:399).
 * model/cascade owns the FK edges. Deleting an ARCHIVED project is allowed
 * (0106 deliberately left the delete policies alone). The 'deleted' event is
 * written AFTER the cascade and hangs on the parent (for a sub) or the team
 * (for a meta) — the project it names is gone, which is exactly why
 * (bc022c2:2952-2958). */
export const deleteDeep = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, id)
    if (!(await hasProjectLevel(ctx, ctx.me, id, 'lead'))) {
      throw rule('requires the project lead')
    }
    await deleteProjectDeep(ctx, { project, actor: ctx.me, now })
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'deleted',
      target_type: 'project',
      target_id: id,
      label: project.name,
      project_id: project.parent_id,
      team_id: project.team_id,
      ts: now,
    })
    return null
  },
})

/* ------------------------------------------------------------ inviteGuest
 * P.inviteToProject → invite_project_guest (0082, final body 0096:330-373) —
 * awaited; returns the invitee's profile uuid, as the RPC did. A known
 * address in the org gets the grant only (the same person is never given a
 * second seat); an unknown one gets a guest seat that stays "Invited" until
 * they sign in. The grant is an UPSERT on the ROOT meta — inviting twice
 * updates the level. Writes no activity (0082 logged nothing).
 *
 * The level sentence still says 'member' — 0098's programmatic rename only
 * replaced quoted enum literals, not prose — and is ported verbatim. The SQL
 * let 'lead' pass this check only to die on project_access_level_ck (a bare
 * 23514, the T12 latent bug); here 'lead' reads the sentence too. */
export const inviteGuest = orgMutation({
  args: { project_id: v.string(), email: v.string(), level: v.string() },
  handler: async (ctx, { project_id, email, level }) => {
    refuseDemoFeature()
    const now = new Date().toISOString()
    const project = await myProject(ctx, project_id)
    if (!(await canManageProjectUsers(ctx, ctx.me, project))) {
      throw rule('no permission to manage users on this project')
    }
    if (level !== 'user' && level !== 'viewer') {
      throw rule('a project role is lead, member or viewer')
    }
    const em = email.trim().toLowerCase()
    if (em === '' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      throw rule('that does not look like an email address')
    }
    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_org_email', (q) => q.eq('org_id', ctx.me.org_id).eq('email', em))
      .first()
    let pid: string
    if (existing !== null) {
      await assertGrantee(ctx, project, existing.id, level)
      if (existing.id === ctx.me.id && !(await canManageOwnProjectAccess(ctx, ctx.me, project))) {
        throw forbidden(
          'only organization admins or project leads can change their own project access',
        )
      }
      pid = existing.id
    } else {
      pid = newUuid()
      const nm = em.split('@')[0]
      // 0082/0096 verbatim: upper(left(name, 2)) of the address's local part —
      // deliberately NOT nameInitials ('anna.k' → 'AN', not 'A'); trap T13
      const initials = [...(nm === '' ? 'G' : nm)].slice(0, 2).join('').toUpperCase()
      const org = await byId(ctx, 'organizations', ctx.me.org_id)
      require(org !== null, notFound('organization not found'))
      // retention follows the person (0112): a sibling seat by address is
      // copied even when its value is absent-meaning-Never; otherwise the
      // old column default 7 is stamped explicitly (trap T2)
      const sibs = await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', em))
        .collect()
      sibs.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      const retention = sibs.length > 0 ? sibs[0].message_retention_days : 7
      await ctx.db.insert('profiles', {
        id: pid,
        org_id: ctx.me.org_id,
        email: em,
        name: nm,
        initials,
        color: '#8A8F98',
        org_role: 'guest',
        active: true,
        kind: 'person',
        plannable_hours: org.default_plannable_hours,
        message_retention_days: retention,
        created_at: now,
      })
    }
    const grant = await ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) => q.eq('project_id', project.id).eq('profile_id', pid))
      .unique()
    if (grant !== null) await ctx.db.patch(grant._id, { level })
    else await ctx.db.insert('project_access', { project_id: project.id, profile_id: pid, level })
    if (existing === null) await markBillingMembershipChanged(ctx, ctx.me.org_id, [em])
    return pid
  },
})

/* -------------------------------------------------------------- milestones
 * P.addMilestone / P.updateMilestone / P.removeMilestone. Level is 'user'
 * (0078:497's milestone policies, member→user). The client folds subs up to
 * the meta; the server accepts any visible project — the SQL had no meta
 * restriction. week is the ISO Monday string (the client converts its week
 * index). Narration details embed weekLabel computed against the SUBJECT
 * org's settings, frozen at write time (trap T1). */

const WEEK_SHAPE = /^\d{4}-\d{2}-\d{2}$/

function cleanWeek(raw: string): string {
  if (!WEEK_SHAPE.test(raw)) throw badRequest('a milestone week is an ISO date (YYYY-MM-DD)')
  return raw
}

async function myMilestone(
  ctx: MeCtx,
  id: string,
): Promise<{ milestone: Doc<'milestones'>; project: Doc<'projects'> }> {
  const milestone = await byId(ctx, 'milestones', id)
  if (milestone !== null) {
    const project = await byId(ctx, 'projects', milestone.project_id)
    if (project !== null && project.org_id === ctx.me.org_id) return { milestone, project }
  }
  throw notFound('milestone not found')
}

async function assertMilestoneWriter(ctx: MeCtx, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, ctx.me, projectId, 'user'))) {
    throw forbidden('no write access to this project')
  }
}

async function orgSettings(ctx: MeCtx): Promise<Doc<'organizations'>> {
  const org = await byId(ctx, 'organizations', ctx.me.org_id)
  require(org !== null, notFound('organization not found'))
  return org
}

export const addMilestone = orgMutation({
  args: { id: v.string(), project_id: v.string(), name: v.string(), week: v.string() },
  handler: async (ctx, { id, project_id, name, week }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, project_id)
    await assertMilestoneWriter(ctx, project_id)
    // milestones_project_archived_guard (0106:148) — the arrival sentence
    if (project.archived_at !== undefined) throw rule('that project is archived — restore it first')
    const iso = cleanWeek(week)
    await insertUnique(
      ctx,
      'milestones',
      'by_uuid',
      { id },
      { id, project_id, name, week: iso, created_at: now },
      badRequest('a milestone with this id already exists'),
    )
    const org = await orgSettings(ctx)
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'added milestone',
      target_type: 'milestone',
      target_id: id,
      label: name,
      detail: `at ${weekLabel(iso, org)}`,
      project_id,
      ts: now,
    })
    return null
  },
})

/* The dialog always submits both fields, so the verb names what actually
 * CHANGED — a pure rename must not read as a move (bc022c2:3536-3562, trap
 * T15); a no-change submit still narrates the bare 'updated milestone'. */
export const updateMilestone = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({ name: v.optional(v.string()), week: v.optional(v.string()) }),
  },
  handler: async (ctx, { id, patch }) => {
    const now = new Date().toISOString()
    const { milestone, project } = await myMilestone(ctx, id)
    await assertMilestoneWriter(ctx, project.id)
    const db: Partial<Doc<'milestones'>> = {}
    if (patch.name !== undefined) db.name = patch.name
    if (patch.week !== undefined) db.week = cleanWeek(patch.week)
    const weekChanged = db.week !== undefined && db.week !== milestone.week
    const renamed = db.name !== undefined && db.name !== milestone.name
    if (Object.keys(db).length > 0) await ctx.db.patch(milestone._id, db)
    const name = db.name ?? milestone.name
    const org = await orgSettings(ctx)
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: weekChanged ? 'moved milestone' : renamed ? 'renamed milestone' : 'updated milestone',
      target_type: 'milestone',
      target_id: id,
      label: name,
      detail: weekChanged
        ? `from ${weekLabel(milestone.week, org)} to ${weekLabel(db.week as string, org)}` +
          (renamed ? ` (renamed from “${milestone.name}”)` : '')
        : renamed
          ? `from “${milestone.name}”`
          : undefined,
      project_id: milestone.project_id,
      ts: now,
    })
    return null
  },
})

export const removeMilestone = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const { milestone, project } = await myMilestone(ctx, id)
    await assertMilestoneWriter(ctx, project.id)
    await ctx.db.delete(milestone._id)
    await logActivity(ctx, {
      org_id: ctx.me.org_id,
      actor_id: ctx.me.id,
      verb: 'deleted milestone',
      target_type: 'milestone',
      target_id: id,
      label: milestone.name,
      project_id: milestone.project_id,
      ts: now,
    })
    return null
  },
})
