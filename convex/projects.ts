/* The project domain's public surface (phase 5): create / update /
 * setAccess / removeAccess / archive / unarchive / deleteDeep / removalSummary /
 * inviteGuest, plus the milestone writes (milestones.ts holds the app's
 * milestone reads, projectSettings.ts the reads of a project's Settings page
 * and its access lists and pickers). Thin wrappers over the shared cores REST and MCP use
 * too (model/projects.ts, model/projectAccess.ts, model/milestones.ts) and
 * over lib/access, model/orgs and model/cascade —
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
 *   'the project is archived, so restore it first' (new sub under an archived
 *   meta, 0106:68) is deliberately NOT the issue/milestone arrival sentence
 *   'that project is archived, so restore it first' (0106:131/148).
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
 * ported — the field patch and the handover's grants commit in one
 * mutation. */

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  canManageOwnProjectAccess,
  canManageProjectUsers,
  hasProjectLevel,
  NO_USER_MANAGEMENT,
} from './lib/access'
import { markBillingMembershipChanged } from './lib/billableUsers'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { asciiEmail } from './lib/email'
import { vGrantLevel, vProjectType } from './lib/enums'
import {
  accessRemovalMutation,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
  require,
  rule,
} from './lib/functions'
import { limitedEmail } from './lib/limitRules'
import { cutText, DEFAULT_MESSAGE_RETENTION_DAYS, LIMITS } from './lib/limits'
import { named, nameKey } from './lib/nameKey'
import { logActivity } from './model/activity'
import { cleanReason, moveProjectToTrash } from './model/deletedItems'
import {
  addMilestoneCore,
  changeableMilestone,
  removeMilestoneCore,
  updateMilestoneCore,
  vMilestoneExpected,
} from './model/milestones'
import { newUuid } from './model/orgs'
import { cleanName } from './model/people'
import {
  type AccessSubject,
  assertGrantExpected,
  removeProjectGrantCore,
  setProjectGrantCore,
  vGrantExpected,
  vHeldTasks,
} from './model/projectAccess'
import { insertGrant } from './model/projectNav'
import {
  archiveProjectCore,
  assertGrantee,
  createProjectCore,
  removalSummaryOf,
  unarchiveProjectCore,
  updateProjectCore,
  vProjectExpected,
} from './model/projects'

type MeCtx = QueryCtx & { me: Doc<'profiles'> }

/* Unknown and foreign-org rows are indistinguishable (0049/0056). The
 * sentence is delete_project's own (0081:479). */
async function myProject(ctx: MeCtx, id: string): Promise<Doc<'projects'>> {
  const project = await byId(ctx, 'projects', id)
  if (project === null || project.org_id !== ctx.me.org_id) throw notFound('project not found')
  return project
}

/* The access-map values create accepts: stored grants are vGrantLevel only
 * (project_access_level_ck, 0013→0098); 'lead' entries are legal on the
 * wire and DROPPED — the lead is carried by lead_id, never a grant row. Null
 * names no grant, which for the creator also declines the User grant a
 * creator who names someone else as lead gets by default
 * (lib/projectGrants.ts creatorGrant). */
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
 * P.updateProject through model/projects.ts updateProjectCore: field patch
 * in ONE mutation, one narration. KEY CHANGE IS ALLOWED — issue refs are
 * QN-num since 0050 — with shape and uniqueness revalidated. A lead
 * handover moves the outgoing and incoming leads' own grants; setAccess and
 * removeAccess change every other grant and share. */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      lead_id: v.optional(v.union(v.string(), v.null())),
      description: v.optional(v.union(v.string(), v.null())),
      key: v.optional(v.string()),
      track_delay: v.optional(v.boolean()),
      review_hours: v.optional(v.union(v.number(), v.null())),
    }),
    expected: v.optional(vProjectExpected),
  },
  handler: async (ctx, { id, patch, expected }) => {
    const project = await myProject(ctx, id)
    await updateProjectCore(ctx, {
      me: ctx.me,
      project,
      patch,
      now: new Date().toISOString(),
      expected,
    })
    return null
  },
})

/* -------------------------------------------------------------- setAccess
 * P.setProjectAccess and P.setProjectTeamAccess: gives one person or one
 * team `level` on the project, or changes the level they have
 * (model/projectAccess.ts setProjectGrantCore, which REST and MCP use too).
 * Naming the one grant it changes, it cannot drop a grant someone else
 * added meanwhile. A person or team outside the organization reads as not
 * found. Returns whether anything changed. */
export const setAccess = orgMutation({
  args: {
    id: v.string(),
    user_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    level: vGrantLevel,
    expected: v.optional(vGrantExpected),
  },
  handler: async (ctx, a) => {
    const project = await myProject(ctx, a.id)
    return await setProjectGrantCore(ctx, {
      me: ctx.me,
      project,
      subject: await accessSubject(ctx, a),
      level: a.level,
      now: new Date().toISOString(),
      expected: a.expected,
    })
  },
})

/* ----------------------------------------------------------- removeAccess
 * The removal window's one write (P.removeAccess): one person's or one
 * team's grant leaves the project, and the open tasks that would leave
 * someone's sight are kept as Viewer, reassigned or left, all at once
 * (model/projectAccess.ts removeProjectGrantCore, which REST and MCP use
 * too). A person or team outside the organization reads as not found.
 * Leaving the tasks only takes access away, so an organization admin can
 * still do it while billing has made the organization read-only
 * (accessRemovalMutation). Keeping people as Viewers or reassigning their
 * tasks writes more, so the core meets the billing gate for it, and the
 * wrapper does for a lead who is not an admin. */
export const removeAccess = accessRemovalMutation({
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
 * `reason` is shown in Deleted items, trimmed and refused past
 * LIMITS.deleteReason (model/deletedItems.ts cleanReason). The 'deleted'
 * event is written AFTER the move and hangs on the parent (for a
 * sub) or the team (for a meta) — the project it names is gone, which is
 * exactly why (bc022c2:2952-2958). Project rows reach no client;
 * organization admins read them in the export (lib/activityVisibility.ts). */
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
 * 5,000 tasks or 8 MiB of them and says so). The same gate as deleteDeep,
 * because it names sub-projects and counts work a member who only navigates
 * to the project cannot see; a top-level project's lead can see every
 * sub-project. */
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
 * awaited; returns the invitee's profile uuid, as the RPC did, and whether
 * an invitation email was scheduled (`emailed`, for a new seat only). A known
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
  args: {
    project_id: v.string(),
    email: v.string(),
    level: v.string(),
    // the level the inviter saw for a person the address already names
    expected: v.optional(vGrantExpected),
  },
  handler: async (ctx, { project_id, email, level, expected }) => {
    refuseDemoFeature()
    const now = new Date().toISOString()
    const project = await myProject(ctx, project_id)
    if (!(await canManageProjectUsers(ctx, ctx.me, project))) {
      throw rule(NO_USER_MANAGEMENT)
    }
    if (level !== 'user' && level !== 'viewer') {
      throw rule('a project role is lead, member or viewer')
    }
    // A seat the address already names only gains a grant, so it is found
    // by the stored form (asciiEmail) and its address is not checked again.
    // That address may predate the address rule or come from a provider
    // sign-in. Only a new seat stores the address, and only then is it
    // checked.
    const typed = asciiEmail(email)
    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_org_email', (q) => q.eq('org_id', ctx.me.org_id).eq('email', typed))
      .first()
    const em =
      existing === null ? limitedEmail(email, 'that does not look like an email address') : typed
    // A seat the address named when the inviter looked, gone since, holds no
    // grant now: an expected level other than none is stale, so a removed
    // member is not invited back unseen. Checked before the new seat.
    if (existing === null && expected !== undefined) {
      await assertGrantExpected(ctx, {
        me: ctx.me,
        project,
        of: { id: em, name: em },
        level: null,
        expected,
        next: level,
      })
    }
    let pid: string
    // the grant copies the person's name key (model/nameKeys.ts)
    let grantee: string
    if (existing !== null) {
      await assertGrantee(ctx, project, existing.id, level)
      if (existing.id === ctx.me.id && !(await canManageOwnProjectAccess(ctx, ctx.me, project))) {
        throw forbidden(
          'only organization admins or project leads can change their own project access',
        )
      }
      pid = existing.id
      grantee = existing.name
    } else {
      pid = newUuid()
      // the address's local part, cut to a name's length rather than
      // refused, because the inviter did not choose it
      const nm = cutText(cleanName(em.slice(0, em.lastIndexOf('@'))), LIMITS.personName.max)
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
      const retention =
        sibs.length > 0 ? sibs[0].message_retention_days : DEFAULT_MESSAGE_RETENTION_DAYS
      await ctx.db.insert('profiles', {
        id: pid,
        org_id: ctx.me.org_id,
        email: em,
        ...named(nm),
        initials,
        color: '#8A8F98',
        org_role: 'guest',
        active: true,
        kind: 'person',
        plannable_hours: org.default_plannable_hours,
        message_retention_days: retention,
        created_at: now,
      })
      grantee = nm
    }
    const grant = await ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) => q.eq('project_id', project.id).eq('profile_id', pid))
      .unique()
    if (existing !== null) {
      await assertGrantExpected(ctx, {
        me: ctx.me,
        project,
        of: existing,
        level: grant?.level ?? null,
        expected,
        next: level,
      })
    }
    const name_key = nameKey(grantee)
    if (grant !== null) await ctx.db.patch(grant._id, { level, name_key })
    // a new grant writes its reach rows (model/projectNav.ts)
    else
      await insertGrant(
        ctx,
        { project_id: project.id, profile_id: pid, level, name_key },
        { org: project.org_id },
      )
    if (existing === null) {
      await markBillingMembershipChanged(ctx, ctx.me.org_id, [em])
      // A new guest seat is an invitation; email it once this mutation commits.
      await ctx.scheduler.runAfter(0, internal.invites.sendFromApp, {
        invites: [{ profile_id: pid, email: em, by: ctx.me.id }],
      })
    }
    return { id: pid, emailed: existing === null }
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
    expected: v.optional(vMilestoneExpected),
  },
  handler: async (ctx, { id, patch, expected }) => {
    const { milestone } = await changeableMilestone(ctx, ctx.me, id)
    await updateMilestoneCore(ctx, {
      me: ctx.me,
      milestone,
      patch,
      now: new Date().toISOString(),
      expected,
    })
    return null
  },
})

export const removeMilestone = orgMutation({
  args: { id: v.string(), expected: v.optional(vMilestoneExpected) },
  handler: async (ctx, { id, expected }) => {
    const { milestone } = await changeableMilestone(ctx, ctx.me, id)
    await removeMilestoneCore(ctx, {
      me: ctx.me,
      milestone,
      now: new Date().toISOString(),
      expected,
    })
    return null
  },
})
