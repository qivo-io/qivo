/* The project domain's public surface (phase 5): create / update /
 * removeAccess / archive / unarchive / deleteDeep / removalSummary /
 * inviteGuest, plus the milestones CRUD (there is no milestones.ts). Thin
 * wrappers over the shared cores REST and MCP use too (model/projects.ts,
 * model/projectAccess.ts, model/milestones.ts) and over lib/access,
 * model/orgs and model/cascade —
 * orgMutation → resolve by uuid → core (access predicate → guards → writes →
 * narration), all under ONE `now`.
 *
 * Refusal posture (the 0049/0056 no-oracle discipline):
 * - an unknown OR foreign-org project/milestone uuid reads `not_found`
 *   ('project not found' / 'milestone not found') — never an existence reveal;
 * - insufficient level on the plain RLS surfaces (update/archive/unarchive,
 *   milestones, grant writes) reads `forbidden` — the silent-0-row successor,
 *   the client shows its fixed permission toast. Milestones follow the shared
 *   rule in model/milestones.ts, so a project or milestone the caller cannot
 *   see reads `not_found` there, as in the roadmap batch;
 * - deleteDeep keeps its P0001 sentence as `rule`, verbatim; inviteGuest
 *   uses the project's explicit user-management permission refusal;
 * - the hierarchy/archive trigger sentences are `rule`, verbatim per surface:
 *   'the project is archived — restore it first' (new sub under an archived
 *   meta, 0106:68) is deliberately NOT the issue/milestone arrival sentence
 *   'that project is archived — restore it first' (0106:131/148).
 *
 * parent_id / type / org_id are immutable after create. A subtask stays in
 * its parent task's top-level project (model/issues.ts parentChainCheck), so
 * a sub-project that ever changes parent must carry that rule along, because
 * its tasks' families can span its siblings. Projects and
 * sub-projects have a lead, never an owning team. Teams and users receive
 * explicit permission grants. team_id remains an optional legacy column so
 * old development rows can be read and cleaned up safely.
 *
 * The old client's accessGate ordering (a lead handover's demotion row had to
 * land before the lead_id update or RLS refused the grant writes) is NOT
 * ported — field patch and access diff commit in one mutation. */

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { canManageOwnProjectAccess, canManageProjectUsers, hasProjectLevel } from './lib/access'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { vGrantLevel, vProjectType } from './lib/enums'
import {
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
  require,
  rule,
} from './lib/functions'
import { logActivity } from './model/activity'
import { cleanReason, moveProjectToTrash } from './model/deletedItems'
import {
  addMilestoneCore,
  changeableMilestone,
  removeMilestoneCore,
  updateMilestoneCore,
} from './model/milestones'
import { newUuid } from './model/orgs'
import { type AccessSubject, removeProjectGrantCore, vHeldTasks } from './model/projectAccess'
import {
  archiveProjectCore,
  assertGrantee,
  createProjectCore,
  removalSummaryOf,
  unarchiveProjectCore,
  updateProjectCore,
} from './model/projects'

type MeCtx = QueryCtx & { me: Doc<'profiles'> }

/* Unknown and foreign-org rows are indistinguishable (0049/0056). The
 * sentence is delete_project's own (0081:479). */
async function myProject(ctx: MeCtx, id: string): Promise<Doc<'projects'>> {
  const project = await byId(ctx, 'projects', id)
  if (project === null || project.org_id !== ctx.me.org_id) throw notFound('project not found')
  return project
}

/* The access-map values a client may send: stored grants are vGrantLevel
 * only (project_access_level_ck, 0013→0098); 'lead' entries are legal on the
 * wire and DROPPED — the lead is carried by lead_id, never a grant row. On
 * create, null names no grant, which for the creator also declines the User
 * grant a creator who names someone else as lead gets by default
 * (lib/projectGrants.ts creatorGrant). */
const vAccessMap = v.record(v.string(), v.union(vGrantLevel, v.literal('lead')))
const vCreateAccessMap = v.record(v.string(), v.union(vGrantLevel, v.literal('lead'), v.null()))
const vTeamAccessMap = v.record(v.string(), vGrantLevel)

/* ----------------------------------------------------------------- create
 * P.addProject, through model/projects.ts createProjectCore (the rule REST
 * and MCP use too). The client pre-generates the uuid and previews num and
 * key; it reconciles both from the returned values (the core may replace a
 * taken key). */
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
    access: v.optional(vCreateAccessMap),
    team_access: v.optional(vTeamAccessMap),
  },
  handler: async (ctx, args) => {
    if ((args.team_id ?? undefined) !== undefined) {
      throw badRequest('projects cannot belong to a team; use team access instead')
    }
    const project = await createProjectCore(ctx, {
      me: ctx.me,
      now: new Date().toISOString(),
      project: {
        id: args.id,
        type: args.type,
        parent_id: args.parent_id ?? undefined,
        name: args.name,
        key: args.key,
        lead_id: args.lead_id ?? undefined,
        description: args.description,
        icon: args.icon,
        icon_color: args.icon_color,
        sort_order: args.sort_order,
        track_delay: args.track_delay,
        access: args.access,
        team_access: args.team_access,
      },
    })
    return { id: project.id, num: project.num, key: project.key }
  },
})

/* ----------------------------------------------------------------- update
 * P.updateProject / P.setProjectAccess through model/projects.ts
 * updateProjectCore: field patch + access-map diff in ONE mutation, one
 * narration. KEY CHANGE IS ALLOWED — issue refs are QN-num since 0050 — with
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
    const project = await myProject(ctx, id)
    await updateProjectCore(ctx, { me: ctx.me, project, patch, now: new Date().toISOString() })
    return null
  },
})

/* ----------------------------------------------------------- removeAccess
 * The removal window's one write (P.removeAccess): one person's or one
 * team's grant leaves the project, and the open tasks that would leave
 * someone's sight are kept as Viewer, reassigned or left, all at once
 * (model/projectAccess.ts removeProjectGrantCore, which REST and MCP use
 * too). A person or team outside the organization reads as not found. */
export const removeAccess = orgMutation({
  args: {
    id: v.string(),
    user_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    on_held_tasks: vHeldTasks,
  },
  handler: async (ctx, a) => {
    const project = await myProject(ctx, a.id)
    const result = await removeProjectGrantCore(ctx, {
      me: ctx.me,
      project,
      subject: await accessSubject(ctx, a),
      held: a.on_held_tasks,
      now: new Date().toISOString(),
    })
    return { removed: result.removed, stranded: result.stranded.length }
  },
})

/* The one person or team an access write names, in the caller's
 * organization. */
async function accessSubject(
  ctx: MeCtx,
  a: { user_id?: string; team_id?: string },
): Promise<AccessSubject> {
  if (a.user_id !== undefined && a.team_id === undefined) {
    const profile = await byId(ctx, 'profiles', a.user_id)
    if (profile === null || profile.org_id !== ctx.me.org_id) throw notFound('user not found')
    return { profile }
  }
  if (a.team_id !== undefined && a.user_id === undefined) {
    const team = await byId(ctx, 'teams', a.team_id)
    if (team === null || team.org_id !== ctx.me.org_id) throw notFound('team not found')
    return { team }
  }
  throw badRequest('name exactly one of user_id and team_id')
}

/* ---------------------------------------------------------------- archive
 * P.archiveProject (model/projects.ts archiveProjectCore). */
export const archive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const project = await myProject(ctx, id)
    await archiveProjectCore(ctx, { me: ctx.me, project, now: new Date().toISOString() })
    return null
  },
})

/* -------------------------------------------------------------- unarchive
 * P.unarchiveProject — awaited by the client; the snapshot pulls the
 * restored rows back in reactively (model/projects.ts unarchiveProjectCore). */
export const unarchive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const project = await myProject(ctx, id)
    await unarchiveProjectCore(ctx, { me: ctx.me, project, now: new Date().toISOString() })
    return null
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.removeProject → delete_project (0081:473-488; wording 0078:399). The
 * project, its sub-projects and every task in them move to Deleted items as
 * one item (model/deletedItems.ts moveProjectToTrash): this transaction
 * hides the projects, and bounded steps move the tasks. Deleting an ARCHIVED
 * project is allowed (0106 deliberately left the delete policies alone).
 * `reason` is shown in Deleted items: trimmed, at most 500 characters. The
 * 'deleted' event is written AFTER the move and hangs on the parent (for a
 * sub) or the team (for a meta) — the project it names is gone, which is
 * exactly why (bc022c2:2952-2958). Members receive a sub's event only with
 * access to the parent beyond navigation, and a meta's reaches org admins
 * only (snapshot.ts memberSeesActivity). */
export const deleteDeep = orgMutation({
  args: { id: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { id, reason }) => {
    const now = new Date().toISOString()
    const project = await myProject(ctx, id)
    if (!(await hasProjectLevel(ctx, ctx.me, id, 'lead'))) {
      throw rule('requires the project lead')
    }
    await moveProjectToTrash(ctx, { actor: ctx.me, project, now, reason: cleanReason(reason) })
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

/* --------------------------------------------------------- removalSummary
 * What the Archive or delete window shows before either: the sub-projects,
 * archived ones included, and how many tasks the tree holds, archived ones
 * included (model/projects.ts removalSummaryOf, which stops counting past
 * 5,000 and says so). The same gate as deleteDeep, because it names
 * sub-projects and counts work a member who only navigates to the project
 * cannot see; a top-level project's lead can see every sub-project. */
export const removalSummary = orgQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const project = await myProject(ctx, id)
    if (!(await hasProjectLevel(ctx, ctx.me, id, 'lead'))) {
      throw rule('requires the project lead')
    }
    return await removalSummaryOf(ctx, project)
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
    if (existing === null) {
      await markBillingMembershipChanged(ctx, ctx.me.org_id, [em])
      // A new guest seat is an invitation; email it once this mutation commits.
      await ctx.scheduler.runAfter(0, internal.invites.sendFromApp, {
        invites: [{ profile_id: pid, email: em }],
      })
    }
    return pid
  },
})

/* -------------------------------------------------------------- milestones
 * P.addMilestone / P.updateMilestone / P.removeMilestone through the shared
 * cores in model/milestones.ts (visibility, the top-level fold, User level on
 * the project that stores the milestone, the archive guard and the
 * narration), which the roadmap batch and the machine surfaces also use.
 * week is a real calendar day, YYYY-MM-DD (the client converts its week
 * index). */

export const addMilestone = orgMutation({
  args: { id: v.string(), project_id: v.string(), name: v.string(), week: v.string() },
  handler: async (ctx, { id, project_id, name, week }) => {
    await addMilestoneCore(ctx, {
      me: ctx.me,
      id,
      projectId: project_id,
      name,
      week,
      now: new Date().toISOString(),
    })
    return null
  },
})

export const updateMilestone = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({ name: v.optional(v.string()), week: v.optional(v.string()) }),
  },
  handler: async (ctx, { id, patch }) => {
    const { milestone } = await changeableMilestone(ctx, ctx.me, id)
    await updateMilestoneCore(ctx, {
      me: ctx.me,
      milestone,
      patch,
      now: new Date().toISOString(),
    })
    return null
  },
})

export const removeMilestone = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const { milestone } = await changeableMilestone(ctx, ctx.me, id)
    await removeMilestoneCore(ctx, { me: ctx.me, milestone, now: new Date().toISOString() })
    return null
  },
})
