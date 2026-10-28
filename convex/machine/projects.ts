/* Projects over REST and MCP: reading one project, creating projects and
 * sub-projects, changing their settings and lead, archiving and restoring
 * them, giving and removing access one person or one team at a time, and
 * milestones.
 *
 * PROJECT_TOOLS and PROJECT_ROUTES are registry entries (machine/registry.ts)
 * that machine/mcp.ts TOOLS and machine/rest.ts ROUTES spread in, so
 * tools/list, the OAuth step-up and REST routing treat them like the rest.
 * This module imports only types from those two, so neither is loaded
 * through it. The provenance, key name validator, body parsers and MCP text
 * it shares with them come from machine/shared.ts. machine/rest.ts uses
 * projectDetailJson for GET /v1/projects/{ref}.
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

import { type ConvexError, type ObjectType, v } from 'convex/values'
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
  type CompletionJson,
  findProject,
  issueKey,
  loadCatalogue,
  NO_TASKS,
  projectCompletion,
  projectJson,
  UUID,
} from '../lib/core'
import { byId } from '../lib/db'
import {
  type CredentialAccess,
  type GrantLevel,
  vCredentialAccess,
  vGrantLevel,
} from '../lib/enums'
import { badRequest, notFound, type Refusal, rule } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import {
  createExpectedSentence,
  EXPECTED_DELETE_SENTENCE,
  EXPECTED_SENTENCE,
  expectedSchema,
  parseExpected,
  refuseCreateExpected,
  sentKeys,
  vExpected,
} from '../model/expected'
import {
  addMilestoneCore,
  changeableMilestone,
  cleanMilestoneDate,
  MILESTONE_MACHINE_FIELDS,
  removeMilestoneCore,
  updateMilestoneCore,
} from '../model/milestones'
import { newUuid } from '../model/orgs'
import {
  type AccessSubject,
  GRANT_FIELDS,
  type HeldTasks,
  type Holding,
  ON_HELD_TASKS_SCHEMA,
  parseHeldTasks,
  removeProjectGrantCore,
  setProjectGrantCore,
  vHeldTasks,
} from '../model/projectAccess'
import { treeBudget } from '../model/projectNav'
import {
  archiveProjectCore,
  createProjectCore,
  PROJECT_MACHINE_FIELDS,
  type ProjectPatch,
  reviewHoursFor,
  unarchiveProjectCore,
  updateProjectCore,
} from '../model/projects'
import { ACCESS_PUT_FIELDS, HELD_TASKS_FIELDS } from './bodyFields'
import type { TOOLS } from './mcp'
import type { ROUTES, route as restRoute } from './rest'
import {
  MCP_PROVENANCE,
  needJson,
  optionalJson,
  pretty,
  refuseUnknownFields,
  restProvenance,
  vKeyName,
} from './shared'

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
  /** the app Overview's Completion, null for an archived project */
  completion: CompletionJson | null
  milestones: MilestoneJson[]
  grants: { users: GrantJson[]; teams: GrantJson[] }
}

/* A milestone as REST and MCP send it, its stored `week` day as `date`. */
const milestoneJson = (m: Doc<'milestones'>): MilestoneJson => ({
  id: m.id,
  name: m.name,
  date: m.week,
})

/* Orders rows by name. Names may repeat, so id breaks ties for a stable order. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/**
 * The fields a single-project read adds: the lead (a sub-project without its
 * own is led by its parent's), the review time it sets and the one its tasks
 * get, delay tracking, its `completion` (lib/core.ts projectCompletion, which
 * the caller reads), the milestones of the top-level project that stores
 * them, by date, and the project's own grants, as the app's project settings
 * show them to anyone who can read the project. A sub-project also inherits
 * its parent's grants.
 */
async function projectDetail(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  completion: CompletionJson | null,
): Promise<ProjectDetailJson> {
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
    completion,
    milestones: milestones.map(milestoneJson),
    grants: { users: users.sort(byName), teams: teams.sort(byName) },
  }
}

/** The single-project read of REST GET /v1/projects/{ref} and MCP
 * get_project, which is the list row with the caller's `flag` plus the
 * single read's fields (projectDetail) with the caller's `completion`. */
export async function projectDetailJson(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  flag: AccessFlag,
  completion: CompletionJson | null,
): Promise<ReturnType<typeof projectJson> & ProjectDetailJson> {
  return { ...projectJson(project, flag), ...(await projectDetail(ctx, project, completion)) }
}

/* projectDetailJson for one project the caller resolved itself, such as one
 * it just changed, with the caller's flags read over the organization's
 * catalogue, which a sub-project's flags need for its parent. A project
 * the call `created` holds no tasks, so its completion reads none. */
async function projectOut(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  access: CredentialAccess,
  o: { created?: boolean } = {},
) {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat, access)
  const readable = (id: string) => flags.get(id)?.read === true
  const completion =
    o.created === true ? NO_TASKS : await projectCompletion(ctx, project, { cat, readable })
  return await projectDetailJson(
    ctx,
    project,
    flags.get(project.id) ?? { read: false, write: false },
    completion,
  )
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

/** A profile uuid in the caller's organization, else null. */
export async function orgProfile(ctx: QueryCtx, me: Caller, ref: string) {
  if (!UUID.test(ref)) return null
  const profile = await byId(ctx, 'profiles', ref.toLowerCase())
  return profile !== null && profile.org_id === me.org_id ? profile : null
}

/** A team uuid in the caller's organization, else null. */
export async function orgTeam(ctx: QueryCtx, me: Caller, ref: string) {
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

/* The fields update_project and PATCH /v1/projects/{ref} change, and what
 * the caller read of them (model/expected.ts). */
type UpdateInput = Pick<
  ProjectPatch,
  'name' | 'description' | 'review_hours' | 'track_delay' | 'lead_id'
> & { archived?: boolean; expected?: Readonly<Record<string, unknown>> }

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
  const { archived, expected, ...patch } = input
  // the archive or restore and the rename share one tree budget
  // (model/projectNav.ts TreeBudget), as one transaction runs both
  const budget = treeBudget()
  let current = project
  if (archived !== undefined) {
    const step = { me, project: current, now, provenance, budget }
    if (archived) await archiveProjectCore(ctx, step)
    else await unarchiveProjectCore(ctx, step)
    current = (await ctx.db.get(current._id)) ?? current
  }
  if (Object.keys(patch).length > 0) {
    current = await updateProjectCore(ctx, {
      me,
      project: current,
      patch,
      now,
      provenance,
      expected,
      view: 'machine',
      budget,
    })
  }
  return current
}

export type HoldingJson = {
  id: string
  key: string
  title: string
  user_id: string
  role: 'assignee' | 'reviewer'
}

/** One open task someone holds, as removalJson's `stranded` and
 * `reassigned` lists name it. */
export const holdingJson = (h: Holding): HoldingJson => ({
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

/** A removal's result fields. */
export const removalJson = (r: Awaited<ReturnType<typeof removeProjectGrantCore>>) => ({
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

/* get_project: one readable project with the caller's access, its lead,
 * settings, milestones and grants. */
export const mcpGetProject = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, project: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    return pretty(await projectOut(ctx, me, project, a.access))
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
    return pretty(await projectOut(ctx, me, project, a.access, { created: true }))
  },
})

/* update_project: settings, the lead and archive/restore of one project.
 * An argument the schema does not know, such as an `archive_reason` only
 * tasks take, is refused before this runs (mcp.ts validateArgs). */
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
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await mcpProject(ctx, me, a.project)
    const { callerId: _caller, access: _access, project: _ref, lead_id, expected, ...fields } = a
    const input: UpdateInput = fields
    if (lead_id !== undefined) input.lead_id = await mcpLead(ctx, me, lead_id)
    if (Object.keys(input).length === 0) throw badRequest('no fields to update')
    if (expected !== undefined) input.expected = expected
    const after = await applyUpdate(ctx, me, project, input, MCP_PROVENANCE)
    return pretty(await projectOut(ctx, me, after, a.access))
  },
})

/* set_project_access: one user's or one team's access, or its removal. A
 * removal is an access removal for the read-only gate (asMachineCaller), as
 * in the app. */
export const mcpSetProjectAccess = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    user_id: v.optional(v.string()),
    team_id: v.optional(v.string()),
    level: v.union(vGrantLevel, v.null()),
    on_held_tasks: v.optional(vHeldTasks),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const write = a.level === null ? 'access_removal' : 'change'
    const me = await asMachineCaller(ctx, a.callerId, a.access, write)
    if (a.level !== null && a.on_held_tasks !== undefined) {
      throw badRequest('on_held_tasks applies only when level is null')
    }
    if (a.level === null && a.expected !== undefined) {
      throw badRequest('expected applies only when level is not null')
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
        expected: a.expected,
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
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    if (a.milestone === undefined && a.expected !== undefined) {
      throw badRequest(createExpectedSentence('milestone'))
    }
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
      expected: a.expected,
      view: 'machine',
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
    expected: v.optional(vExpected),
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
      expected: a.expected,
      view: 'machine',
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

/* A project's parent never changes. A subtask stays in its parent task's
 * top-level project (model/issues.ts parentChainCheck), so allowing a
 * sub-project to change parent would have to carry that rule along, because
 * its tasks' families can span its siblings. */
const PARENT_AT_CREATION = "a project's parent is set when it is created, with parent"

/* Projects have no comment thread, so archiving one takes no reason. */
const NO_PROJECT_ARCHIVE_REASON =
  'only tasks take an archive reason; archive a project with archived alone'

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

/* ----------------------------------------------------- REST internal fns */

/* POST /v1/projects {name, parent?, lead_id?, description?}. */
export const restCreateProject = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, keyName: vKeyName, body: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const b = needJson(a.body)
    refuseProjectFields(b)
    refuseCreateExpected(b, 'project')
    refuseUnknownFields(b, ['name', 'parent', 'lead_id', 'description'])
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
    return await projectOut(ctx, me, project, a.access, { created: true })
  },
})

/* PATCH /v1/projects/{ref} {name?, description?, review_hours?,
 * track_delay?, lead_id?, archived?}. The fields refuseProjectFields names,
 * `parent` and `archive_reason` are refused with their own sentences, and
 * any other unknown field after them. */
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
    // a task's archive reason, refused rather than dropped without a word
    if ('archive_reason' in b) throw badRequest(NO_PROJECT_ARCHIVE_REASON)
    refuseUnknownFields(b, [
      'name',
      'description',
      'review_hours',
      'track_delay',
      'lead_id',
      'archived',
      'expected',
    ])
    const expected = parseExpected(
      PROJECT_MACHINE_FIELDS,
      b.expected,
      sentKeys(PROJECT_MACHINE_FIELDS, b),
    )
    const input: UpdateInput = {}
    if ('name' in b) {
      if (typeof b.name !== 'string') throw badRequest('name must be a string')
      input.name = b.name
    }
    const description = restDescription(b)
    if (description !== undefined) input.description = description
    if ('review_hours' in b) {
      const hours = b.review_hours
      if (hours !== null && typeof hours !== 'number') throw rule(LIMITS.reviewHours.refusal)
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
    if (expected !== undefined) input.expected = expected
    const after = await applyUpdate(ctx, me, project, input, restProvenance(a.keyName))
    return await projectOut(ctx, me, after, a.access)
  },
})

/* The arguments of each access route's function: the project and subject
 * from the path, and the body ({level} on PUT, an optional {on_held_tasks}
 * on DELETE). A body field the route does not take is refused
 * (refuseUnknownFields), so a misspelled one never falls back to a
 * default. Both routes check the body before they resolve the path, so a
 * bad body answers 400 whatever the path names. */
const vRestAccessArgs = {
  callerId: v.string(),
  access: vCredentialAccess,
  keyName: vKeyName,
  ref: v.string(),
  subject: v.string(),
  body: v.string(),
}

type RestAccessArgs = ObjectType<typeof vRestAccessArgs>

/* PUT /v1/projects/{ref}/access/{users|teams}/{id} {level}, which each
 * kind's own internal function below runs, so every route reaches exactly
 * one function. */
async function restSetAccess(ctx: MutationCtx, a: RestAccessArgs, kind: 'users' | 'teams') {
  const me = await asMachineCaller(ctx, a.callerId, a.access)
  const b = needJson(a.body)
  refuseUnknownFields(b, ACCESS_PUT_FIELDS)
  const level = restLevel(b)
  const expected = parseExpected(GRANT_FIELDS, b.expected, ['level'])
  const project = await restProject(ctx, me, a.ref)
  const subject = await restSubject(ctx, me, kind, a.subject)
  const { changed } = await setProjectGrantCore(ctx, {
    me,
    project,
    subject,
    level,
    now: new Date().toISOString(),
    provenance: restProvenance(a.keyName),
    expected,
  })
  return { project_id: project.id, ...subjectJson(subject), level, changed }
}

/* DELETE /v1/projects/{ref}/access/{users|teams}/{id}, with an optional
 * body {on_held_tasks}, which each kind's own internal function below runs.
 * An access removal for the read-only gate (asMachineCaller), as in the
 * app. */
async function restRemoveAccess(ctx: MutationCtx, a: RestAccessArgs, kind: 'users' | 'teams') {
  const me = await asMachineCaller(ctx, a.callerId, a.access, 'access_removal')
  const b = optionalJson(a.body)
  refuseUnknownFields(b, HELD_TASKS_FIELDS)
  const held: HeldTasks = parseHeldTasks(b.on_held_tasks)
  const project = await restProject(ctx, me, a.ref)
  const subject = await restSubject(ctx, me, kind, a.subject)
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
}

/* PUT /v1/projects/{ref}/access/users/{id}. */
export const restSetUserAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restSetAccess(ctx, a, 'users'),
})

/* PUT /v1/projects/{ref}/access/teams/{id}. */
export const restSetTeamAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restSetAccess(ctx, a, 'teams'),
})

/* DELETE /v1/projects/{ref}/access/users/{id}. */
export const restRemoveUserAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restRemoveAccess(ctx, a, 'users'),
})

/* DELETE /v1/projects/{ref}/access/teams/{id}. */
export const restRemoveTeamAccess = internalMutation({
  args: vRestAccessArgs,
  handler: (ctx, a) => restRemoveAccess(ctx, a, 'teams'),
})

/* A REST milestone body's name and date: strings when present, `required`
 * names the ones that must be. Any other field is refused. */
function milestoneFields(
  b: Record<string, unknown>,
  required: boolean,
): { name?: string; week?: string } {
  if (required) refuseCreateExpected(b, 'milestone')
  refuseUnknownFields(b, required ? ['name', 'date'] : ['name', 'date', 'expected'])
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
    const b = needJson(a.body)
    const patch = milestoneFields(b, false)
    const expected = parseExpected(
      MILESTONE_MACHINE_FIELDS,
      b.expected,
      sentKeys(MILESTONE_MACHINE_FIELDS, b),
    )
    if (patch.name === undefined && patch.week === undefined) {
      throw badRequest('no recognized fields to update')
    }
    const m = await updateMilestoneCore(ctx, {
      me,
      milestone,
      patch,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
      expected,
      view: 'machine',
    })
    return { ...milestoneJson(m), project_id: m.project_id }
  },
})

/* DELETE /v1/projects/{ref}/milestones/{id}, with an optional body
 * {expected}: the name and date the caller read, because Deleted items
 * cannot bring a milestone back. */
export const restDeleteMilestone = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    milestone: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ deleted: true; id: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const project = await restProject(ctx, me, a.ref)
    const milestone = await milestoneOn(ctx, me, project, a.milestone)
    if (milestone === null) throw notFound('milestone not found')
    const b = optionalJson(a.body ?? '')
    refuseUnknownFields(b, ['expected'])
    const expected = parseExpected(
      MILESTONE_MACHINE_FIELDS,
      b.expected,
      Object.keys(MILESTONE_MACHINE_FIELDS),
    )
    await removeMilestoneCore(ctx, {
      me,
      milestone,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
      expected,
      view: 'machine',
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
        'One project you can see, by number, key or uuid: its lead, review time, delay tracking, its completion (done and total tasks), its milestones (kept on the top-level project) and the users and teams given access to it.',
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
            maxLength: LIMITS.projectName.max,
          },
          parent: {
            type: 'string',
          },
          lead_id: {
            type: 'string',
          },
          description: {
            type: 'string',
            maxLength: LIMITS.projectDescription.max,
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
        'Change a project you lead: `name`, `description`, `review_hours` (null uses the parent or default), `track_delay`, or `archived: true/false` to archive or restore it. `lead_id` hands the lead to another user, which only a person may do; the old lead keeps User access. Only tasks take an archive reason. ' +
        EXPECTED_SENTENCE +
        ' Its `lead_id` is the lead get_project shows.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          project: {
            type: 'string',
          },
          name: {
            type: 'string',
            maxLength: LIMITS.projectName.max,
          },
          description: {
            type: 'string',
            maxLength: LIMITS.projectDescription.max,
          },
          review_hours: {
            anyOf: [
              {
                type: 'number',
                minimum: LIMITS.reviewHours.min,
                maximum: LIMITS.reviewHours.max,
              },
              { type: 'null' },
            ],
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
          expected: expectedSchema(PROJECT_MACHINE_FIELDS),
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        name?: string
        description?: string
        review_hours?: number | null
        track_delay?: boolean
        lead_id?: string
        archived?: boolean
        expected?: unknown
      }
      return r.runMutation(internal.machine.projects.mcpUpdateProject, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          PROJECT_MACHINE_FIELDS,
          expected,
          sentKeys(PROJECT_MACHINE_FIELDS, rest),
        ),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'set_project_access',
      title: 'Set project access',
      description:
        'Give one user (`user_id`) or one team (`team_id`) `user` or `viewer` access to a project, or with `level: null` remove it. `on_held_tasks` settles open tasks a removal hides from the people working on them: `leave` (the default; the result lists them), `keep_as_viewer`, or `{"reassign_to": user id or null}`. Needs Lead access, and only a person may change access. ' +
        EXPECTED_SENTENCE +
        ' Its `level` is the access get_project shows, null for none, and takes no removal.',
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
          expected: expectedSchema(GRANT_FIELDS),
        },
        required: ['project', 'level'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { on_held_tasks, expected, ...rest } = args as {
        project: string
        user_id?: string
        team_id?: string
        level: GrantLevel | null
        on_held_tasks?: unknown
        expected?: unknown
      }
      if (rest.level === null && expected !== undefined) {
        throw badRequest('expected applies only when level is not null')
      }
      return r.runMutation(internal.machine.projects.mcpSetProjectAccess, {
        callerId,
        access,
        ...rest,
        ...(on_held_tasks === undefined ? {} : { on_held_tasks: parseHeldTasks(on_held_tasks) }),
        expected: parseExpected(GRANT_FIELDS, expected, ['level']),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'set_milestone',
      title: 'Set milestone',
      description:
        "Without `milestone`, add one to `project` from `name` and `date` (YYYY-MM-DD); a sub-project's goes on its top-level project. With `milestone` (an id from get_project), rename or move it. Needs Edit access on the top-level project. A top-level project holds at most one milestone in each calendar week of its organization, so a `date` in a week that holds another of its milestones is refused. " +
        EXPECTED_SENTENCE,
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
            maxLength: LIMITS.milestoneName.max,
          },
          date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          expected: expectedSchema(MILESTONE_MACHINE_FIELDS),
        },
        required: ['project'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        milestone?: string
        name?: string
        date?: string
        expected?: unknown
      }
      if (rest.milestone === undefined && expected !== undefined) {
        throw badRequest(createExpectedSentence('milestone'))
      }
      return r.runMutation(internal.machine.projects.mcpSetMilestone, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          MILESTONE_MACHINE_FIELDS,
          expected,
          sentKeys(MILESTONE_MACHINE_FIELDS, rest),
        ),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'delete_milestone',
      title: 'Delete milestone',
      description:
        'Delete a milestone (an id from get_project) of `project`. Needs Edit access on the top-level project. ' +
        EXPECTED_DELETE_SENTENCE,
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
          expected: expectedSchema(MILESTONE_MACHINE_FIELDS),
        },
        required: ['project', 'milestone'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as {
        project: string
        milestone: string
        expected?: unknown
      }
      return r.runMutation(internal.machine.projects.mcpDeleteMilestone, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(
          MILESTONE_MACHINE_FIELDS,
          expected,
          Object.keys(MILESTONE_MACHINE_FIELDS),
        ),
      })
    },
  },
]

/** The REST routes of this domain, matched after machine/rest.ts's own. GET
 * /v1/projects/{ref} stays there, with projectDetailJson's fields. */
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
  route({
    method: 'PUT',
    path: 'projects/:ref/access/users/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restSetUserAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/access/users/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restRemoveUserAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'PUT',
    path: 'projects/:ref/access/teams/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restSetTeamAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'projects/:ref/access/teams/:subject',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restRemoveTeamAccess, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        subject: param('subject'),
        body,
      }),
  }),
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
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.projects.restDeleteMilestone, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        milestone: param('milestone'),
        body,
      }),
  }),
]
