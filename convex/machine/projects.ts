/* Projects over REST and MCP: reading one project, creating projects and
 * sub-projects, changing their settings and lead, archiving and restoring
 * them, giving and removing access one person or one team at a time, and
 * milestones.
 *
 * PROJECT_TOOLS and PROJECT_ROUTES are registry entries (machine/registry.ts)
 * that machine/mcp.ts TOOLS and machine/rest.ts ROUTES spread in, so
 * tools/list, the OAuth step-up and REST routing treat them like the rest.
 * This module imports only types from those two, so neither is loaded
 * through it. machine/rest.ts uses restProjectDetail for GET
 * /v1/projects/{ref}.
 *
 * Each action is one shared model function the app runs too
 * (model/projects.ts createProjectCore, updateProjectCore, archiveProjectCore
 * and unarchiveProjectCore, model/projectAccess.ts setProjectGrantCore and
 * removeProjectGrantCore, model/milestones.ts). The internal functions below
 * are thin per-surface wrappers, `mcp*` and `rest*`: each starts from
 * asMachineCaller, which refuses a read-only credential before anything
 * resolves, parses its surface's input, calls the model and encodes the
 * result. MCP answers pretty-printed text, stringified here so the key order
 * survives the function boundary; REST answers objects.
 *
 * Visibility: a project the caller cannot read answers like an unknown one,
 * and so does a milestone on it. Machine creation takes no grant maps; access
 * changes one person or team at a time, and only a person may change it
 * (lib/access.ts canChangeAccess). */

import { type ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { canSeeProject, rootMetaOf } from '../lib/access'
import {
  type AccessFlag,
  accessFlags,
  asMachineCaller,
  type Caller,
  findProject,
  issueKey,
  mcpProjectOut,
  restProjectJson,
  UUID,
} from '../lib/core'
import { byId } from '../lib/db'
import {
  type CredentialAccess,
  type GrantLevel,
  vCredentialAccess,
  vGrantLevel,
} from '../lib/enums'
import { badRequest, notFound, type Refusal } from '../lib/functions'
import { PROJECT_DESCRIPTION_MAX } from '../lib/projectLimits'
import { REVIEW_HOURS_MAX } from '../lib/review'
import {
  addMilestoneCore,
  changeableMilestone,
  cleanMilestoneDate,
  removeMilestoneCore,
  updateMilestoneCore,
} from '../model/milestones'
import { newUuid } from '../model/orgs'
import {
  type AccessSubject,
  type HeldTasks,
  type Holding,
  ON_HELD_TASKS_SCHEMA,
  parseHeldTasks,
  removeProjectGrantCore,
  setProjectGrantCore,
  vHeldTasks,
} from '../model/projectAccess'
import {
  archiveProjectCore,
  createProjectCore,
  type ProjectPatch,
  reviewHoursFor,
  unarchiveProjectCore,
  updateProjectCore,
} from '../model/projects'
import type { TOOLS } from './mcp'
import type { ROUTES, route as restRoute } from './rest'
import { MCP_PROVENANCE, needJson, optionalJson, pretty, restProvenance, vKeyName } from './shared'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* --------------------------------------------------------------- reading */

type MilestoneJson = { id: string; name: string; date: string }
type GrantJson = { id: string; name: string; level: GrantLevel }

/** What the single-project read adds to a project row. */
type ProjectDetailJson = {
  lead_id: string | null
  lead_name: string | null
  review_hours: number | null
  effective_review_hours: number
  track_delay: boolean
  milestones: MilestoneJson[]
  grants: { users: GrantJson[]; teams: GrantJson[] }
}

const milestoneJson = (m: Doc<'milestones'>): MilestoneJson => ({
  id: m.id,
  name: m.name,
  date: m.week,
})

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/**
 * The fields a single-project read adds: the lead (a sub-project without its
 * own is led by its parent's), the review time it sets and the one its tasks
 * get, delay tracking, the milestones of the top-level project that stores
 * them, by date, and the project's own grants, as the app's project settings
 * show them to anyone who can read the project. A sub-project also inherits
 * its parent's grants.
 */
async function projectDetail(ctx: QueryCtx, project: Doc<'projects'>): Promise<ProjectDetailJson> {
  const root = await rootMetaOf(ctx, project)
  const leadId = project.lead_id ?? root.lead_id
  const lead = leadId === undefined ? null : await byId(ctx, 'profiles', leadId)
  const milestones = await ctx.db
    .query('milestones')
    .withIndex('by_project', (q) => q.eq('project_id', root.id))
    .collect()
  milestones.sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name))
  const users: GrantJson[] = []
  const grants = ctx.db
    .query('project_access')
    .withIndex('by_project', (q) => q.eq('project_id', project.id))
  for await (const g of grants) {
    const p = await byId(ctx, 'profiles', g.profile_id)
    if (p !== null && p.org_id === project.org_id)
      users.push({ id: p.id, name: p.name, level: g.level })
  }
  const teams: GrantJson[] = []
  const shares = ctx.db
    .query('project_team_access')
    .withIndex('by_project', (q) => q.eq('project_id', project.id))
  for await (const s of shares) {
    const team = await byId(ctx, 'teams', s.team_id)
    if (team !== null && team.org_id === project.org_id) {
      teams.push({ id: team.id, name: team.name, level: s.level })
    }
  }
  return {
    lead_id: lead?.id ?? null,
    lead_name: lead?.name ?? null,
    review_hours: project.review_hours ?? null,
    effective_review_hours: await reviewHoursFor(ctx, project),
    track_delay: project.track_delay,
    milestones: milestones.map(milestoneJson),
    grants: { users: users.sort(byName), teams: teams.sort(byName) },
  }
}

/** GET /v1/projects/{ref}'s answer: the list row with the caller's flags,
 * plus the single read's fields (projectDetail). */
export async function restProjectDetail(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  flag: AccessFlag,
): Promise<ReturnType<typeof restProjectJson> & ProjectDetailJson> {
  return { ...restProjectJson(project, flag), ...(await projectDetail(ctx, project)) }
}

/* restProjectDetail for a project the caller just changed. */
async function restProjectOut(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  access: CredentialAccess,
) {
  const flags = await accessFlags(ctx, me, [project], access)
  return await restProjectDetail(
    ctx,
    project,
    flags.get(project.id) ?? { read: false, write: false },
  )
}

/* get_project's answer: list_projects' row plus the single read's fields. */
async function mcpProjectDetail(ctx: QueryCtx, project: Doc<'projects'>) {
  return { ...mcpProjectOut(project), ...(await projectDetail(ctx, project)) }
}

/* ------------------------------------------------------------------ refs */

/* The project `ref` names (uuid, number or key) when the caller can read it,
 * else null. */
async function readableProject(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<Doc<'projects'> | null> {
  const project = await findProject(ctx, me, ref)
  return project !== null && (await canSeeProject(ctx, me, project)) ? project : null
}

/* A profile uuid in the caller's organization, else null. */
async function orgProfile(ctx: QueryCtx, me: Caller, ref: string) {
  if (!UUID.test(ref)) return null
  const profile = await byId(ctx, 'profiles', ref.toLowerCase())
  return profile !== null && profile.org_id === me.org_id ? profile : null
}

/* A team uuid in the caller's organization, else null. */
async function orgTeam(ctx: QueryCtx, me: Caller, ref: string) {
  if (!UUID.test(ref)) return null
  const team = await byId(ctx, 'teams', ref.toLowerCase())
  return team !== null && team.org_id === me.org_id ? team : null
}

/* The milestone `ref` on `project`'s top-level project, which the caller may
 * change, else null when there is no such milestone there. */
async function milestoneOn(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  ref: string,
): Promise<Doc<'milestones'> | null> {
  const root = await rootMetaOf(ctx, project)
  const row = UUID.test(ref) ? await byId(ctx, 'milestones', ref.toLowerCase()) : null
  if (row === null || row.project_id !== root.id) return null
  return (await changeableMilestone(ctx, me, row.id)).milestone
}

/* --------------------------------------------------------------- changes */

/* What a create carries, once each surface has parsed and resolved it. */
type CreateInput = {
  name: string
  parent?: Doc<'projects'>
  lead_id?: string
  description?: string | null
}

/* A new project or, under `parent`, sub-project, by createProjectCore. */
const createFrom = (ctx: MutationCtx, me: Caller, input: CreateInput, provenance: string) =>
  createProjectCore(ctx, {
    me,
    now: new Date().toISOString(),
    provenance,
    project: {
      id: newUuid(),
      type: input.parent === undefined ? 'meta' : 'project',
      parent_id: input.parent?.id,
      name: input.name,
      lead_id: input.lead_id,
      description: input.description,
    },
  })

/* The fields update_project and PATCH /v1/projects/{ref} change. */
type UpdateInput = Pick<
  ProjectPatch,
  'name' | 'description' | 'review_hours' | 'track_delay' | 'lead_id'
> & { archived?: boolean }

/**
 * Applies an update in one transaction. The restore or archive runs first,
 * while the caller still holds the Lead access that a lead handover in the
 * same update gives away, so a restore also lets the rest land on an active
 * project. The fields and the lead follow (updateProjectCore). Each step keeps
 * its own rule and activity row. Returns the project as stored.
 */
async function applyUpdate(
  ctx: MutationCtx,
  me: Caller,
  project: Doc<'projects'>,
  input: UpdateInput,
  provenance: string,
): Promise<Doc<'projects'>> {
  const now = new Date().toISOString()
  const { archived, ...patch } = input
  let current = project
  if (archived !== undefined) {
    const step = { me, project: current, now, provenance }
    if (archived) await archiveProjectCore(ctx, step)
    else await unarchiveProjectCore(ctx, step)
    current = (await ctx.db.get(current._id)) ?? current
  }
  if (Object.keys(patch).length > 0) {
    current = await updateProjectCore(ctx, { me, project: current, patch, now, provenance })
  }
  return current
}

type HoldingJson = {
  id: string
  key: string
  title: string
  user_id: string
  role: 'assignee' | 'reviewer'
}

const holdingJson = (h: Holding): HoldingJson => ({
  id: h.task.id,
  key: issueKey(h.task.num),
  title: h.task.title,
  user_id: h.profile_id,
  role: h.role,
})

/* The subject as the result names it. */
const subjectJson = (subject: AccessSubject) =>
  'team' in subject
    ? { team: { id: subject.team.id, name: subject.team.name } }
    : { user: { id: subject.profile.id, name: subject.profile.name } }

/* A removal's result fields. */
const removalJson = (r: Awaited<ReturnType<typeof removeProjectGrantCore>>) => ({
  stranded: r.stranded.map(holdingJson),
  kept_as_viewer: r.kept_as_viewer,
  reassigned: r.reassigned.map(holdingJson),
})

/* --------------------------------------------------------- MCP sentences */

const mcpProjectMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`project "${ref}" not found (or not visible to you)`)
const mcpMilestoneMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`milestone "${ref}" not found (or not visible to you)`)
const mcpUserMissing = (ref: string): ConvexError<Refusal> =>
  badRequest(`user "${ref}" not found in your organization`)
const mcpTeamMissing = (ref: string): ConvexError<Refusal> =>
  badRequest(`team "${ref}" not found in your organization`)

/* An MCP project ref the caller can read. */
async function mcpProject(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await readableProject(ctx, me, ref)
  if (project === null) throw mcpProjectMissing(ref)
  return project
}

/* An MCP lead_id, lowercased, when it names someone in the organization. */
async function mcpLead(ctx: QueryCtx, me: Caller, ref: string | undefined) {
  if (ref === undefined) return undefined
  const profile = await orgProfile(ctx, me, ref)
  if (profile === null) throw mcpUserMissing(ref)
  return profile.id
}

/* The one user or team set_project_access names, in the organization. */
async function mcpSubject(
  ctx: QueryCtx,
  me: Caller,
  a: { user_id?: string; team_id?: string },
): Promise<AccessSubject> {
  if (a.user_id !== undefined && a.team_id === undefined) {
    const profile = await orgProfile(ctx, me, a.user_id)
    if (profile === null) throw mcpUserMissing(a.user_id)
    return { profile }
  }
  if (a.team_id !== undefined && a.user_id === undefined) {
    const team = await orgTeam(ctx, me, a.team_id)
    if (team === null) throw mcpTeamMissing(a.team_id)
    return { team }
  }
  throw badRequest('name exactly one of user_id and team_id')
}

/* ------------------------------------------------------ MCP internal fns */

/* get_project: one readable project with its lead, settings, milestones and
 * grants. */
export const mcpGetProject = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, project: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return pretty(await mcpProjectDetail(ctx, await mcpProject(ctx, me, a.project)))
  },
})

/* create_project: a project, or a sub-project under `parent`. */
export const mcpCreateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    name: v.string(),
    parent: v.optional(v.string()),
    lead_id: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    let parent: Doc<'projects'> | undefined
    if (a.parent !== undefined) {
      const found = await readableProject(ctx, me, a.parent)
      if (found === null) {
        throw notFound(`parent project "${a.parent}" not found (or not visible to you)`)
      }
      parent = found
    }
    const lead_id = await mcpLead(ctx, me, a.lead_id)
    const input = { name: a.name, parent, lead_id, description: a.description }
    const project = await createFrom(ctx, me, input, MCP_PROVENANCE)
    return pretty(await mcpProjectDetail(ctx, project))
  },
})

/* update_project: settings, the lead and archive/restore of one project. */
export const mcpUpdateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    review_hours: v.optional(v.union(v.number(), v.null())),
    track_delay: v.optional(v.boolean()),
    lead_id: v.optional(v.string()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    const { callerId: _caller, access: _access, project: _ref, lead_id, ...fields } = a
    const input: UpdateInput = fields
    if (lead_id !== undefined) input.lead_id = await mcpLead(ctx, me, lead_id)
    if (Object.keys(input).length === 0) throw badRequest('no fields to update')
    const after = await applyUpdate(ctx, me, project, input, MCP_PROVENANCE)
    return pretty(await mcpProjectDetail(ctx, after))
  },
})

/* set_project_access: one user's or one team's access, or its removal. */
export const mcpSetProjectAccess = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    user_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    level: v.union(vGrantLevel, v.null()),
    on_held_tasks: v.optional(vHeldTasks),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    if (a.level !== null && a.on_held_tasks !== undefined) {
      throw badRequest('on_held_tasks applies only when level is null')
    }
    const project = await mcpProject(ctx, me, a.project)
    const subject = await mcpSubject(ctx, me, a)
    const now = new Date().toISOString()
    const base = { project: project.key, ...subjectJson(subject) }
    if (a.level !== null) {
      const { changed } = await setProjectGrantCore(ctx, {
        me,
        project,
        subject,
        level: a.level,
        now,
        provenance: MCP_PROVENANCE,
      })
      return pretty({ ...base, level: a.level, changed })
    }
    const removal = await removeProjectGrantCore(ctx, {
      me,
      project,
      subject,
      held: a.on_held_tasks ?? 'leave',
      now,
      provenance: MCP_PROVENANCE,
    })
    return pretty({ ...base, level: null, changed: removal.removed, ...removalJson(removal) })
  },
})

/* set_milestone: add a milestone, or rename or move one. */
export const mcpSetMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    milestone: v.optional(v.string()),
    name: v.optional(v.string()),
    date: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    const week = a.date === undefined ? undefined : cleanMilestoneDate(a.date)
    const now = new Date().toISOString()
    if (a.milestone === undefined) {
      if (a.name === undefined || week === undefined) {
        throw badRequest('a new milestone needs name and date')
      }
      const m = await addMilestoneCore(ctx, {
        me,
        id: newUuid(),
        projectId: project.id,
        name: a.name,
        week,
        now,
        provenance: MCP_PROVENANCE,
      })
      return pretty({ ...milestoneJson(m), project_id: m.project_id, created: true })
    }
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw mcpMilestoneMissing(a.milestone)
    if (a.name === undefined && week === undefined) throw badRequest('no fields to update')
    const m = await updateMilestoneCore(ctx, {
      me,
      milestone,
      patch: { name: a.name, week },
      now,
      provenance: MCP_PROVENANCE,
    })
    return pretty({ ...milestoneJson(m), project_id: m.project_id, created: false })
  },
})

/* delete_milestone: remove one milestone. */
export const mcpDeleteMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    milestone: v.string(),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw mcpMilestoneMissing(a.milestone)
    await removeMilestoneCore(ctx, {
      me,
      milestone,
      now: new Date().toISOString(),
      provenance: MCP_PROVENANCE,
    })
    return pretty({ deleted: true, id: milestone.id })
  },
})

/* -------------------------------------------------------- REST parsing */

/* A REST project path ref the caller can read, else the one 404. */
async function restProject(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'projects'>> {
  const project = await readableProject(ctx, me, ref)
  if (project === null) throw notFound('project not found')
  return project
}

const PARENT_AT_CREATION = "a project's parent is set when it is created, with parent"

/* Fields a project body may not write, each refused with where to go
 * instead rather than ignored. */
function refuseProjectFields(b: Record<string, unknown>): void {
  if ('access' in b || 'team_access' in b) {
    throw badRequest('give access one user or team at a time, under /v1/projects/{ref}/access')
  }
  if ('key' in b) throw badRequest("a project's key comes from its name and cannot be written")
  if ('parent_id' in b || 'type' in b) throw badRequest(PARENT_AT_CREATION)
}

/* A REST body's lead_id: a profile uuid in the organization, lowercased. */
async function restLead(ctx: QueryCtx, me: Caller, b: Record<string, unknown>) {
  if (!('lead_id' in b)) return undefined
  if (typeof b.lead_id !== 'string' || !UUID.test(b.lead_id)) {
    throw badRequest('lead_id must be a profile uuid')
  }
  const profile = await orgProfile(ctx, me, b.lead_id)
  if (profile === null) throw badRequest(`user "${b.lead_id}" not found in your organization`)
  return profile.id
}

/* A REST body's description: a string, or null for none. */
function restDescription(b: Record<string, unknown>): string | null | undefined {
  if (!('description' in b)) return undefined
  const description = b.description
  if (description === null) return null
  if (typeof description === 'string') return description
  throw badRequest('description must be a string')
}

/* A REST body's `level`: user or viewer. */
function restLevel(b: Record<string, unknown>): GrantLevel {
  if (b.level === 'user' || b.level === 'viewer') return b.level
  throw badRequest('level must be user or viewer; DELETE removes access')
}

/* A REST access path's person or team, else its 404. */
async function restSubject(
  ctx: QueryCtx,
  me: Caller,
  kind: 'users' | 'teams',
  ref: string,
): Promise<AccessSubject> {
  if (kind === 'users') {
    const profile = await orgProfile(ctx, me, ref)
    if (profile === null) throw notFound('user not found')
    return { profile }
  }
  const team = await orgTeam(ctx, me, ref)
  if (team === null) throw notFound('team not found')
  return { team }
}

const vAccessKind = v.union(v.literal('users'), v.literal('teams'))

/* ----------------------------------------------------- REST internal fns */

/* POST /v1/projects {name, parent?, lead_id?, description?}. */
export const restCreateProject = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, keyName: vKeyName, body: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const b = needJson(a.body)
    refuseProjectFields(b)
    if (!('name' in b)) throw badRequest('name is required')
    if (typeof b.name !== 'string') throw badRequest('name must be a string')
    let parent: Doc<'projects'> | undefined
    if ('parent' in b && b.parent !== null) {
      // an unknown parent and one the caller cannot read answer alike
      const found = typeof b.parent === 'string' ? await readableProject(ctx, me, b.parent) : null
      if (found === null) throw badRequest('parent project not found')
      parent = found
    }
    const input = {
      name: b.name,
      parent,
      lead_id: await restLead(ctx, me, b),
      description: restDescription(b),
    }
    const project = await createFrom(ctx, me, input, restProvenance(a.keyName))
    return await restProjectOut(ctx, me, project, a.access)
  },
})

/* PATCH /v1/projects/{ref} {name?, description?, review_hours?,
 * track_delay?, lead_id?, archived?}. Unknown fields are ignored. */
export const restUpdateProject = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const b = needJson(a.body)
    refuseProjectFields(b)
    // POST takes `parent`; a project keeps the parent it was created with
    if ('parent' in b) throw badRequest(PARENT_AT_CREATION)
    const input: UpdateInput = {}
    if ('name' in b) {
      if (typeof b.name !== 'string') throw badRequest('name must be a string')
      input.name = b.name
    }
    const description = restDescription(b)
    if (description !== undefined) input.description = description
    if ('review_hours' in b) {
      const hours = b.review_hours
      if (hours !== null && typeof hours !== 'number') {
        throw badRequest(
          `review_hours must be a number of hours from 0 to ${REVIEW_HOURS_MAX}, or null`,
        )
      }
      input.review_hours = hours as number | null
    }
    if ('track_delay' in b) {
      if (typeof b.track_delay !== 'boolean') throw badRequest('track_delay must be a boolean')
      input.track_delay = b.track_delay
    }
    const lead = await restLead(ctx, me, b)
    if (lead !== undefined) input.lead_id = lead
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') throw badRequest('archived must be a boolean')
      input.archived = b.archived
    }
    if (Object.keys(input).length === 0) throw badRequest('no recognized fields to update')
    const after = await applyUpdate(ctx, me, project, input, restProvenance(a.keyName))
    return await restProjectOut(ctx, me, after, a.access)
  },
})

/* PUT /v1/projects/{ref}/access/{users|teams}/{id} {level}. */
export const restSetAccess = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    kind: vAccessKind,
    subject: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const subject = await restSubject(ctx, me, a.kind, a.subject)
    const level = restLevel(needJson(a.body))
    const { changed } = await setProjectGrantCore(ctx, {
      me,
      project,
      subject,
      level,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { project_id: project.id, ...subjectJson(subject), level, changed }
  },
})

/* DELETE /v1/projects/{ref}/access/{users|teams}/{id}, with an optional
 * body {on_held_tasks}. */
export const restRemoveAccess = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    kind: vAccessKind,
    subject: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const held: HeldTasks = parseHeldTasks(optionalJson(a.body).on_held_tasks)
    const project = await restProject(ctx, me, a.ref)
    const subject = await restSubject(ctx, me, a.kind, a.subject)
    const removal = await removeProjectGrantCore(ctx, {
      me,
      project,
      subject,
      held,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return {
      project_id: project.id,
      ...subjectJson(subject),
      removed: removal.removed,
      ...removalJson(removal),
    }
  },
})

/* A REST milestone body's name and date: strings when present, `required`
 * names the ones that must be. */
function milestoneFields(
  b: Record<string, unknown>,
  required: boolean,
): { name?: string; week?: string } {
  const out: { name?: string; week?: string } = {}
  if ('name' in b) {
    if (typeof b.name !== 'string') throw badRequest('name must be a string')
    out.name = b.name
  } else if (required) throw badRequest('name is required')
  if ('date' in b) out.week = cleanMilestoneDate(b.date)
  else if (required) throw badRequest('date is required')
  return out
}

/* POST /v1/projects/{ref}/milestones {name, date}. */
export const restAddMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const f = milestoneFields(needJson(a.body), true)
    const m = await addMilestoneCore(ctx, {
      me,
      id: newUuid(),
      projectId: project.id,
      name: f.name as string,
      week: f.week as string,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { ...milestoneJson(m), project_id: m.project_id }
  },
})

/* PATCH /v1/projects/{ref}/milestones/{id} {name?, date?}. */
export const restUpdateMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    milestone: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw notFound('milestone not found')
    const patch = milestoneFields(needJson(a.body), false)
    if (patch.name === undefined && patch.week === undefined) {
      throw badRequest('no recognized fields to update')
    }
    const m = await updateMilestoneCore(ctx, {
      me,
      milestone,
      patch,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { ...milestoneJson(m), project_id: m.project_id }
  },
})

/* DELETE /v1/projects/{ref}/milestones/{id}. */
export const restDeleteMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    milestone: v.string(),
  },
  handler: async (ctx, a): Promise<{ deleted: true; id: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw notFound('milestone not found')
    await removeMilestoneCore(ctx, {
      me,
      milestone,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { deleted: true, id: milestone.id }
  },
})

/* ------------------------------------------------------- registry entries */

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

/** The MCP tools of this domain, in tools/list order after mcp.ts's own. */
export const PROJECT_TOOLS: McpTool[] = [
  {
    access: 'read',
    def: {
      name: 'get_project',
      title: 'Get project',
      description:
        'One project you can see, by number, key or uuid: its lead, review time, delay tracking, its milestones (kept on the top-level project) and the users and teams given access to it.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.projects.mcpGetProject, {
        callerId,
        access,
        ...(args as { project: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'create_project',
      title: 'Create project',
      description:
        "Create a top-level project, or with `parent` (a project number, key or uuid) a sub-project under it. A top-level project follows the organization's project creation setting (get_me `can_create_projects`); a sub-project needs Lead access on its parent. `lead_id` defaults to you, and only a person may name someone else. Tasks go in sub-projects.",
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          name: {
            type: 'string',
          },
          parent: {
            type: 'string',
          },
          lead_id: {
            type: 'string',
          },
          description: {
            type: 'string',
            maxLength: PROJECT_DESCRIPTION_MAX,
          },
        },
        required: ['name'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.projects.mcpCreateProject, {
        callerId,
        access,
        ...(args as { name: string; parent?: string; lead_id?: string; description?: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'update_project',
      title: 'Update project',
      description:
        'Change a project you lead: `name`, `description`, `review_hours` (null uses the parent or default), `track_delay`, or `archived: true/false` to archive or restore it. `lead_id` hands the lead to another user, which only a person may do; the old lead keeps User access.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          name: {
            type: 'string',
          },
          description: {
            type: 'string',
            maxLength: PROJECT_DESCRIPTION_MAX,
          },
          review_hours: {
            anyOf: [{ type: 'number', minimum: 0, maximum: REVIEW_HOURS_MAX }, { type: 'null' }],
          },
          track_delay: {
            type: 'boolean',
          },
          lead_id: {
            type: 'string',
          },
          archived: {
            type: 'boolean',
          },
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.projects.mcpUpdateProject, {
        callerId,
        access,
        ...(args as {
          project: string
          name?: string
          description?: string
          review_hours?: number | null
          track_delay?: boolean
          lead_id?: string
          archived?: boolean
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'set_project_access',
      title: 'Set project access',
      description:
        'Give one user (`user_id`) or one team (`team_id`) `user` or `viewer` access to a project, or with `level: null` remove it. `on_held_tasks` settles open tasks a removal hides from the people working on them: `leave` (the default; the result lists them), `keep_as_viewer`, or `{"reassign_to": user id or null}`. Needs Lead access, and only a person may change access.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          user_id: {
            type: 'string',
          },
          team_id: {
            type: 'string',
          },
          level: {
            anyOf: [{ type: 'string', enum: ['user', 'viewer'] }, { type: 'null' }],
          },
          on_held_tasks: ON_HELD_TASKS_SCHEMA,
        },
        required: ['project', 'level'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { on_held_tasks, ...rest } = args as {
        project: string
        user_id?: string
        team_id?: string
        level: GrantLevel | null
        on_held_tasks?: unknown
      }
      return r.runMutation(internal.machine.projects.mcpSetProjectAccess, {
        callerId,
        access,
        ...rest,
        ...(on_held_tasks === undefined ? {} : { on_held_tasks: parseHeldTasks(on_held_tasks) }),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'set_milestone',
      title: 'Set milestone',
      description:
        "Without `milestone`, add one to `project` from `name` and `date` (YYYY-MM-DD); a sub-project's goes on its top-level project. With `milestone` (an id from get_project), rename or move it. Needs Edit access on the top-level project.",
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          milestone: {
            type: 'string',
          },
          name: {
            type: 'string',
          },
          date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.projects.mcpSetMilestone, {
        callerId,
        access,
        ...(args as { project: string; milestone?: string; name?: string; date?: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'delete_milestone',
      title: 'Delete milestone',
      description:
        'Delete a milestone (an id from get_project) of `project`. Needs Edit access on the top-level project.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          milestone: {
            type: 'string',
          },
        },
        required: ['project', 'milestone'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.projects.mcpDeleteMilestone, {
        callerId,
        access,
        ...(args as { project: string; milestone: string }),
      }),
  },
]

/** The REST routes of this domain, matched after machine/rest.ts's own. GET
 * /v1/projects/{ref} stays there, with restProjectDetail's fields. */
export const PROJECT_ROUTES: RestRoute[] = [
  route({
    method: 'POST',
    path: 'projects',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, body }) =>
      r.runMutation(internal.machine.projects.restCreateProject, {
        callerId,
        access,
        keyName,
        body,
      }),
  }),
  route({
    method: 'PATCH',
    path: 'projects/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restUpdateProject, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  ...(['users', 'teams'] as const).flatMap((kind) => [
    route({
      method: 'PUT',
      path: `projects/:ref/access/${kind}/:subject`,
      access: 'write',
      status: 200,
      run: (r, { callerId, access, keyName, param, body }) =>
        r.runMutation(internal.machine.projects.restSetAccess, {
          callerId,
          access,
          keyName,
          ref: param('ref'),
          kind,
          subject: param('subject'),
          body,
        }),
    }),
    route({
      method: 'DELETE',
      path: `projects/:ref/access/${kind}/:subject`,
      access: 'write',
      status: 200,
      run: (r, { callerId, access, keyName, param, body }) =>
        r.runMutation(internal.machine.projects.restRemoveAccess, {
          callerId,
          access,
          keyName,
          ref: param('ref'),
          kind,
          subject: param('subject'),
          body,
        }),
    }),
  ]),
  route({
    method: 'POST',
    path: 'projects/:ref/milestones',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restAddMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'PATCH',
    path: 'projects/:ref/milestones/:milestone',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restUpdateMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        milestone: param('milestone'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/milestones/:milestone',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param }) =>
      r.runMutation(internal.machine.projects.restDeleteMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        milestone: param('milestone'),
      }),
  }),
]
