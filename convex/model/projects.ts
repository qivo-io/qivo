/* Project rules shared by the app (projects.ts), REST and MCP
 * (machine/projects.ts): names and keys, creation, settings, the lead,
 * archiving and restoring. Each action is one core here, so every surface
 * applies the same rule. Callers resolve the caller's seat and check the
 * billing pause (orgMutation, asMachineCaller). A machine caller passes its
 * `provenance` ('via MCP', 'via the REST API (<key name>)'), which signs the
 * activity row; the app passes none.
 *
 * Refusal posture (the 0049/0056 no-oracle discipline): a parent the caller
 * cannot see reads as not found, missing rights are `forbidden`, and the
 * hierarchy and archive sentences are `rule`, verbatim. Changing who has
 * access (grants, sharing, the lead) takes a person (lib/access.ts
 * canChangeAccess). */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  canChangeAccess,
  canManageOwnProjectAccess,
  canManageProjectTeams,
  canManageProjectUsers,
  canSeeProject,
  hasProjectLevel,
  rootMetaOf,
} from '../lib/access'
import { assertNewRowId, byId, insertUnique, newWindowKey } from '../lib/db'
import type { GrantLevel, ProjectType } from '../lib/enums'
import { descriptionForm, trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, notFound, require, rule } from '../lib/functions'
import { limitedNumber, limitedText } from '../lib/limitRules'
import { grouped, LIMITS } from '../lib/limits'
import { canCreateProjects, projectCreationRefusal } from '../lib/projectCreators'
import { creatorGrant, type Grants, grantsAfterHandover } from '../lib/projectGrants'
import { PROJECT_KEY_SHAPE, projectKeyBase, projectKeyCandidate } from '../lib/projectKeys'
import { resolveReviewHours, roundReviewHours } from '../lib/review'
import { logActivity, signedDetail } from './activity'
import { estimateDocumentBytes } from './demoMetrics'
import {
  assertExpected,
  BOOLEAN,
  exact,
  type Fields,
  filledText,
  hoursOrNull,
  idForm,
  TEXT,
  textOrNull,
  uuidOf,
  type View,
} from './expected'
import { scheduleArchivedReads } from './messages'
import { nextProjectNum } from './orgs'

/* The first step of a restore's regroup chain (regroup.ts), referenced by
 * name as model/messages.ts references its steps. */
const restoredStepRef = makeFunctionReference<
  'mutation',
  { projects: string[]; restorer_id: string },
  null
>('regroup:restoredStep')

/** The description to store: trimmed, '' for null or absent, refused past
 * LIMITS.projectDescription. */
export function projectDescription(value: string | null | undefined): string {
  return limitedText(LIMITS.projectDescription, value ?? '')
}

/** A project name as stored: trimmed, and refused when nothing is left or
 * past LIMITS.projectName. */
export function cleanProjectName(raw: string): string {
  const name = limitedText(LIMITS.projectName, raw)
  if (name === '') throw rule('a project name cannot be blank')
  return name
}

/** The stored project review time: null clears it (the project inherits
 * again), a value is kept to the 0.1 h grain within LIMITS.reviewHours. */
export function cleanReviewHours(v: number | null): number | undefined {
  if (v === null) return undefined
  return roundReviewHours(limitedNumber(LIMITS.reviewHours, v))
}

/** The remaining time a task in this sub-project gets on entering Review:
 * its own setting, else its project's, else DEFAULT_REVIEW_HOURS. */
export async function reviewHoursFor(ctx: QueryCtx, project: Doc<'projects'>): Promise<number> {
  if (project.review_hours !== undefined) return project.review_hours
  const parent = project.parent_id ? await byId(ctx, 'projects', project.parent_id) : null
  return resolveReviewHours(undefined, parent?.review_hours)
}

/* ----------------------------------------------------------------- keys */

/* projects_key_ck (0001:62): 1–5 uppercase alphanumerics. Bare 23514/23505 in
 * SQL — badRequest lands in the client's same generic toast bucket. */
function cleanKey(raw: string): string {
  if (!PROJECT_KEY_SHAPE.test(raw)) {
    throw badRequest('a project key is 1-5 uppercase letters or digits')
  }
  return raw
}

/** The project holding `key` in the organization, archived or not, or
 * 'trash' when a project in Deleted items holds it: its key stays reserved
 * until it is purged, so a restore gets it back (deleted_rows.by_org_key). */
async function keyHolder(
  ctx: QueryCtx,
  orgId: string,
  key: string,
): Promise<Doc<'projects'> | 'trash' | null> {
  const live = await ctx.db
    .query('projects')
    .withIndex('by_org_key', (q) => q.eq('org_id', orgId).eq('key', key))
    .first()
  if (live !== null) return live
  const trashed = await ctx.db
    .query('deleted_rows')
    .withIndex('by_org_key', (q) => q.eq('org_id', orgId).eq('project_key', key))
    .first()
  return trashed === null ? null : 'trash'
}

/* An explicit key change (update) is refused when another project holds the
 * key. The REST API already admits that a key exists (rest.ts's one
 * deliberate 403 oracle), so this sentence discloses nothing new. A key held
 * in Deleted items reads the same for everyone but organization admins, who
 * see every deleted item and so learn nothing from their own sentence. */
async function assertKeyFree(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  key: string,
  self: string,
): Promise<void> {
  const holder = await keyHolder(ctx, me.org_id, key)
  if (holder === 'trash' && me.org_role === 'admin') {
    throw badRequest('A project in Deleted items has that key.')
  }
  if (holder !== null && (holder === 'trash' || holder.id !== self)) {
    throw badRequest('a project with that key already exists in this organization')
  }
}

// Bounds the reads one create spends looking for a free key.
const KEY_CANDIDATES = 500

/* A new project keeps the key its client previewed while that key is free.
 * Archived projects and projects the caller cannot see keep their keys, and
 * the client never receives those, so a taken key is replaced by the first
 * free candidate derived from the name rather than refusing the project.
 * Without a preview (REST and MCP) the first free candidate is the key.
 * Concurrent creates of one key conflict and Convex retries the loser, which
 * then reads the winner's row. */
async function allocateKey(
  ctx: QueryCtx,
  orgId: string,
  suggested: string | undefined,
  name: string,
): Promise<string> {
  if (suggested !== undefined && (await keyHolder(ctx, orgId, suggested)) === null) return suggested
  const base = projectKeyBase(name)
  for (let n = 1; n <= KEY_CANDIDATES; n++) {
    const key = projectKeyCandidate(base, n)
    if (key !== suggested && (await keyHolder(ctx, orgId, key)) === null) return key
  }
  throw badRequest('no free project key is left for this name; choose another name')
}

/* --------------------------------------------------------------- guards */

/* projects_update is lead level (0106 left it as the rule — no RPC), so the
 * plain surfaces refuse as the silent 0-row did. */
async function assertLead(ctx: QueryCtx, me: Doc<'profiles'>, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, me, projectId, 'lead'))) {
    throw forbidden('requires lead access to this project')
  }
}

/* project_lead_same_org (0102:311-329), on create and on an actual CHANGE of
 * lead. Only reachable for a profile in the caller's own organization, so the
 * viewer sentence says nothing a stranger could not already see. */
async function assertLeadAllowed(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  leadId: string,
): Promise<void> {
  const p = await byId(ctx, 'profiles', leadId)
  if (p === null || p.org_id !== me.org_id) {
    throw rule("the lead must be a member of the project's organization")
  }
  if (!p.active || (p.org_role !== 'admin' && p.org_role !== 'user' && p.org_role !== 'guest')) {
    if (p.org_role === 'viewer') {
      throw rule('a viewer cannot lead a project, so make them a standard user first')
    }
    throw rule('the lead must be an active organization user')
  }
}

/** pa_insert/pa_update's WITH CHECK (0081:275-283 + 0102:365-384): the
 * grantee holds a profile in the project's org (a guest qualifies — that is
 * the whole point), and a viewer-role grantee only ever receives a 'viewer'
 * grant. Refusing silently was the RLS behavior — surfaced as forbidden. */
export async function assertGrantee(
  ctx: QueryCtx,
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

/** A team share's team must belong to the project's organization. */
export async function assertTeamGrantee(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  teamId: string,
): Promise<void> {
  const team = await byId(ctx, 'teams', teamId)
  if (team === null || team.org_id !== project.org_id) {
    throw forbidden('the team must belong to this organization')
  }
}

/* Access-map entries that store a grant row: 'lead' is carried by lead_id
 * and null names no grant, so both are dropped. Anything else goes on to the
 * grant row's schema validator, which refuses a level it does not know. */
const grantEntries = (
  map: Record<string, GrantLevel | 'lead' | null> | undefined,
): [string, GrantLevel][] =>
  Object.entries(map ?? {}).filter(
    (e): e is [string, GrantLevel] => e[1] !== 'lead' && e[1] !== null,
  )

/* The individual grant rows on a project, by profile id. */
async function grantRows(ctx: QueryCtx, projectId: string) {
  const rows = await ctx.db
    .query('project_access')
    .withIndex('by_project', (q) => q.eq('project_id', projectId))
    .collect()
  return new Map(rows.map((r) => [r.profile_id, r]))
}

/* --------------------------------------------------------------- create */

/** A new project as a caller asks for it. The core checks the parent, the
 * lead and every grant itself. */
export type NewProject = {
  id: string
  type: ProjectType
  parent_id?: string
  name: string
  /** the key the app previewed; derived from the name when absent or taken */
  key?: string
  /** the caller when absent */
  lead_id?: string
  description?: string | null
  /** after its siblings when absent */
  sort_order?: number
  track_delay?: boolean
  /** Individual grants. null names no grant, which for the creator also turns
   * off creatorGrant's default. 'lead' entries are carried by lead_id. */
  access?: Record<string, GrantLevel | 'lead' | null>
  team_access?: Record<string, GrantLevel>
}

/* Where a new project goes in its list: after every sibling, archived and
 * hidden ones included. */
async function siblingCount(
  ctx: QueryCtx,
  orgId: string,
  parentId: string | undefined,
): Promise<number> {
  let n = 0
  const rows =
    parentId === undefined
      ? ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', orgId))
      : ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', parentId))
  for await (const p of rows) if (p.type === (parentId === undefined ? 'meta' : 'project')) n++
  return n
}

/**
 * Creates a project or, with `parent_id`, a sub-project, and narrates it. A
 * top-level project follows the organization's project_creators setting
 * (lib/projectCreators.ts), and a sub-project needs Lead access on its
 * parent, which must be a top-level project that is not archived. Naming
 * another lead or any grant takes a person. A creator who is not an org admin
 * and names someone else as lead of a top-level project gets User access
 * unless the request names their own (lib/projectGrants.ts creatorGrant).
 * The org's counter gives the number; the key comes from the name.
 */
export async function createProjectCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; project: NewProject; now: string; provenance?: string },
): Promise<Doc<'projects'>> {
  const { me, now, project: p } = a
  assertNewRowId(p.id)
  const lead_id = p.lead_id ?? me.id
  // Neither products nor sub-projects have an owning team. A parent is the
  // only structural requirement for a sub-project; permissions are explicit
  // grants below.
  const org = await byId(ctx, 'organizations', me.org_id)
  require(org !== null, notFound('organization not found'))
  if (p.type === 'meta') {
    if (p.parent_id !== undefined) throw badRequest('a project cannot have a parent')
    // The organization's project_creators setting decides who may create a
    // product (lib/projectCreators.ts); its lead controls it afterwards.
    if (!canCreateProjects(me, org.project_creators)) {
      throw forbidden(projectCreationRefusal(org.project_creators))
    }
  } else {
    if (p.parent_id === undefined) {
      throw badRequest('a sub-project needs a parent')
    }
    // projects_hierarchy_guard (0078:341-349) + archive-parent guard
    // (0106:68). A parent the caller cannot see, in this organization or
    // another, reads like a missing one.
    const parent = await byId(ctx, 'projects', p.parent_id)
    if (parent === null || !(await canSeeProject(ctx, me, parent))) {
      throw rule('parent project not found')
    }
    if (parent.type !== 'meta') {
      throw rule('sub-projects live directly under a project, never under another sub-project')
    }
    if (parent.archived_at !== undefined) {
      throw rule('the project is archived, so restore it first')
    }
    if (!(await hasProjectLevel(ctx, me, parent.id, 'lead'))) {
      throw forbidden('requires lead access to this project')
    }
  }
  const shares =
    grantEntries(p.access).some(([uid]) => uid !== me.id) ||
    Object.keys(p.team_access ?? {}).length > 0
  if ((lead_id !== me.id || shares) && !canChangeAccess(me)) {
    throw forbidden(ACCESS_NEEDS_A_PERSON)
  }
  const name = cleanProjectName(p.name)
  const key = await allocateKey(
    ctx,
    me.org_id,
    p.key === undefined ? undefined : cleanKey(p.key),
    name,
  )
  const description = projectDescription(p.description)
  await assertLeadAllowed(ctx, me, lead_id)
  const num = await nextProjectNum(ctx, org)
  const parent_id = p.type === 'meta' ? undefined : p.parent_id
  const sort_order = p.sort_order ?? (await siblingCount(ctx, me.org_id, parent_id))
  await insertUnique(
    ctx,
    'projects',
    'by_uuid',
    { id: p.id },
    {
      id: p.id,
      org_id: me.org_id,
      team_id: undefined,
      type: p.type,
      parent_id,
      key,
      name,
      lead_id,
      description,
      sort_order,
      num,
      // Teamless projects use the neutral default unless explicitly set.
      track_delay: p.track_delay ?? true,
      created_at: now,
      window_key: newWindowKey(),
    },
    badRequest('a project with this id already exists'),
  )
  const project = await byId(ctx, 'projects', p.id)
  require(project !== null, notFound('project not found'))
  // Grant rows ride along on either project level. Root grants are inherited
  // by children by the access helpers; child grants can further narrow a
  // workstream without introducing an owning team. A sub-project's creator
  // leads its parent, which keeps them User access, so only a top-level
  // project applies creatorGrant.
  const grants = new Map(grantEntries(p.access))
  if (p.type === 'meta') {
    const own = p.access?.[me.id]
    const mine = creatorGrant({
      admin: me.org_role === 'admin',
      creator: me.id,
      lead: lead_id,
      own: own === 'lead' ? undefined : own,
    })
    if (mine === null) grants.delete(me.id)
    else grants.set(me.id, mine)
  }
  for (const [uid, level] of grants) {
    await assertGrantee(ctx, project, uid, level)
    await ctx.db.insert('project_access', { project_id: project.id, profile_id: uid, level })
  }
  for (const [sharedTeamId, level] of Object.entries(p.team_access ?? {})) {
    await assertTeamGrantee(ctx, project, sharedTeamId)
    await ctx.db.insert('project_team_access', {
      project_id: project.id,
      team_id: sharedTeamId,
      level,
      org_id: project.org_id,
    })
  }
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'created',
    target_type: 'project',
    target_id: project.id,
    label: name,
    detail: signedDetail(undefined, a.provenance),
    project_id: project.id,
    ts: now,
  })
  return project
}

/* --------------------------------------------------------------- update */

/** A project field patch. A key's presence means "set this field"; null
 * clears. `access` and `team_access` are whole grant lists from clients
 * from before projects.setAccess, which give or change grants but may not
 * leave one out (ACCESS_MAP_REMOVES). */
export type ProjectPatch = {
  name?: string
  lead_id?: string | null
  description?: string | null
  key?: string
  track_delay?: boolean
  review_hours?: number | null
  access?: Record<string, GrantLevel | 'lead'>
  team_access?: Record<string, GrantLevel>
}

/** The refusal of an access or team_access map that leaves out a grant the
 * project has. A map from a page loaded before someone else gave that grant
 * would drop it, and a removal must settle the open tasks it hides
 * (projects.removeAccess, model/projectAccess.ts removeProjectGrantCore). */
export const ACCESS_MAP_REMOVES =
  'an access map cannot remove access; remove it one person or team at a time'

/** The keys of a project's `expected`. REST and MCP read a project with no
 * lead of its own as led by its parent's lead, and cannot change the key. */
export const PROJECT_FIELDS: Fields<Doc<'projects'>> = {
  // cleanProjectName's rule
  name: { sends: 'name', type: filledText(LIMITS.projectName), form: trimmedForm },
  // projectDescription's rule
  description: {
    sends: 'description',
    type: textOrNull(LIMITS.projectDescription),
    form: descriptionForm,
  },
  key: { sends: 'key', type: TEXT, form: exact },
  track_delay: { sends: 'track_delay', type: BOOLEAN, form: exact },
  review_hours: {
    sends: 'review_hours',
    // cleanReviewHours's rule
    type: hoursOrNull({
      min: 0,
      max: LIMITS.reviewHours.max,
      says: `a number of hours from 0 to ${grouped(LIMITS.reviewHours.max)}, or null`,
    }),
    form: (value) => (typeof value === 'number' ? roundReviewHours(value) : (value ?? null)),
  },
  lead_id: {
    sends: 'lead_id',
    type: uuidOf('profile', true),
    form: idForm,
    stored: async (project, read) =>
      read.view === 'machine'
        ? (project.lead_id ?? (await rootMetaOf(read.ctx, project)).lead_id)
        : project.lead_id,
  },
}

/** PROJECT_FIELDS over REST and MCP, which cannot change the key. */
export const PROJECT_MACHINE_FIELDS: Fields<Doc<'projects'>> = Object.fromEntries(
  Object.entries(PROJECT_FIELDS).filter(([key]) => key !== 'key'),
)

/** The app's `expected` for a project edit. */
export const vProjectExpected = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.union(v.string(), v.null())),
  key: v.optional(v.string()),
  track_delay: v.optional(v.boolean()),
  review_hours: v.optional(v.union(v.number(), v.null())),
  lead_id: v.optional(v.union(v.string(), v.null())),
})

/**
 * Applies a field patch and any access-map change in ONE write, and narrates
 * it once, by priority access > name > lead; same-value name and lead writes
 * are silent no-ops, and description, key, track_delay and
 * review_hours alone narrate nothing. An access or team_access map gives or
 * changes grants and must hold every grant the project has
 * (ACCESS_MAP_REMOVES), except the own grant of a lead handed over in the
 * same patch. A lead handover without an access map
 * keeps the outgoing lead as User and drops the incoming lead's own grant
 * (lib/projectGrants.ts grantsAfterHandover). Changing access or the lead
 * takes a person. Returns the project as stored.
 */
export async function updateProjectCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    project: Doc<'projects'>
    patch: ProjectPatch
    now: string
    provenance?: string
    /** What the caller read, in its view (model/expected.ts); the access
     * maps take none. */
    expected?: Readonly<Record<string, unknown>>
    view?: View
  },
): Promise<Doc<'projects'>> {
  const { me, project, patch, now } = a
  const id = project.id
  const prevLead = project.lead_id
  const nextLead = patch.lead_id === undefined ? prevLead : (patch.lead_id ?? undefined)
  const leadChanged = nextLead !== prevLead
  if (
    (patch.access !== undefined || patch.team_access !== undefined || leadChanged) &&
    !canChangeAccess(me)
  ) {
    throw forbidden(ACCESS_NEEDS_A_PERSON)
  }
  const managesUsers =
    patch.access !== undefined || (project.type === 'meta' && patch.lead_id !== undefined)
  const managesTeams = patch.team_access !== undefined
  const editsSettings = Object.keys(patch).some(
    (key) =>
      key !== 'access' && key !== 'team_access' && !(key === 'lead_id' && project.type === 'meta'),
  )
  // Evaluate all capabilities against the pre-write state. A delegate may
  // not attach a settings change to an access patch, or grant themselves
  // lead standing first and use it for the rest of this same mutation.
  if (editsSettings || (!managesUsers && !managesTeams)) await assertLead(ctx, me, id)
  if (managesUsers && !(await canManageProjectUsers(ctx, me, project))) {
    throw forbidden('no permission to manage users on this project')
  }
  const controlsOwnAccess = await canManageOwnProjectAccess(ctx, me, project)
  if (managesTeams && !(await canManageProjectTeams(ctx, me, project))) {
    throw forbidden('no permission to manage users on this project')
  }
  const { access: _access, team_access: _teams, ...fields } = patch
  await assertExpected({
    read: { ctx, me, view: a.view ?? 'app' },
    fields: PROJECT_FIELDS,
    record: 'project',
    id,
    label: `project ${project.key}`,
    row: project,
    expected: a.expected,
    next: fields,
  })
  const db: Partial<Doc<'projects'>> = {}
  if (patch.name !== undefined) db.name = cleanProjectName(patch.name)
  if (patch.description !== undefined) db.description = projectDescription(patch.description)
  if (patch.track_delay !== undefined) db.track_delay = patch.track_delay
  // null clears: undefined unsets the column through ctx.db.patch
  if (patch.review_hours !== undefined) db.review_hours = cleanReviewHours(patch.review_hours)
  if (patch.key !== undefined) {
    const key = cleanKey(patch.key)
    await assertKeyFree(ctx, me, key, id)
    db.key = key
  }
  const editsOwnLead = nextLead === me.id || (prevLead === me.id && nextLead === undefined)
  if (project.type === 'meta' && leadChanged && editsOwnLead && !controlsOwnAccess) {
    throw forbidden('only organization admins or project leads can change their own project access')
  }
  if (patch.lead_id !== undefined) {
    if (nextLead === undefined) throw badRequest('a project must have a lead')
    // the 0102 trigger revalidates only an actual CHANGE to a non-null lead
    if (leadChanged && nextLead !== undefined) await assertLeadAllowed(ctx, me, nextLead)
    db.lead_id = nextLead
  }
  // whether a map leaves out a grant it may not remove (ACCESS_MAP_REMOVES)
  let removes = false
  if (patch.access !== undefined) {
    const next = new Map(grantEntries(patch.access))
    const held = await grantRows(ctx, id)
    const selfChanged = held.get(me.id)?.level !== next.get(me.id)
    // Lead handover may retain the outgoing lead as a User in the
    // same atomic patch. Their previous effective Lead access is reduced,
    // never elevated; other self edits remain reserved to the strict role.
    const handsOverLead =
      prevLead === me.id && leadChanged && nextLead !== undefined && next.get(me.id) === 'user'
    if (selfChanged && !controlsOwnAccess && !handsOverLead) {
      throw forbidden(
        'only organization admins or project leads can change their own project access',
      )
    }
    // a lead handed over in the same patch gives up their own grant
    removes = await writeGrants(ctx, project, held, next, (uid) => leadChanged && uid === nextLead)
  } else if (leadChanged && nextLead !== undefined) {
    const held = await grantRows(ctx, id)
    const current: Grants = Object.fromEntries([...held].map(([uid, row]) => [uid, row.level]))
    const after = grantsAfterHandover(current, prevLead, nextLead)
    await writeGrants(ctx, project, held, new Map(Object.entries(after)), () => true)
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
        await ctx.db.insert('project_team_access', {
          project_id: id,
          team_id: teamId,
          level,
          org_id: project.org_id,
        })
      } else if (row.level !== level) await ctx.db.patch(row._id, { level, org_id: project.org_id })
    }
    removes ||= prev.some((row) => !next.has(row.team_id))
  }
  // refused once every entry of both maps was checked, so their own
  // refusals come first
  if (removes) throw rule(ACCESS_MAP_REMOVES)
  if (Object.keys(db).length > 0) await ctx.db.patch(project._id, db)
  const name = db.name ?? project.name
  const nameChanged = db.name !== undefined && db.name !== project.name
  const event = {
    org_id: me.org_id,
    actor_id: me.id,
    target_type: 'project' as const,
    target_id: id,
    label: name,
    project_id: id,
    ts: now,
  }
  if (patch.access !== undefined || patch.team_access !== undefined) {
    await logActivity(ctx, {
      ...event,
      verb: 'changed access on',
      detail: signedDetail(undefined, a.provenance),
    })
  } else if (nameChanged) {
    await logActivity(ctx, {
      ...event,
      verb: 'renamed',
      detail: signedDetail(`from “${project.name}”`, a.provenance),
    })
  } else if (leadChanged) {
    const from = prevLead === undefined ? null : await byId(ctx, 'profiles', prevLead)
    const to = nextLead === undefined ? null : await byId(ctx, 'profiles', nextLead)
    await logActivity(ctx, {
      ...event,
      verb: to !== null ? 'changed the lead of' : 'removed the lead of',
      detail: signedDetail(
        to !== null
          ? `to ${to.name}${from !== null ? ` (was ${from.name})` : ''}`
          : from !== null
            ? `(was ${from.name})`
            : undefined,
        a.provenance,
      ),
    })
  }
  const fresh = await ctx.db.get(project._id)
  require(fresh !== null, notFound('project not found'))
  return fresh
}

/* Brings a project's individual grant rows to `next`: changed levels are
 * patched, new ones checked and inserted, and missing ones deleted when
 * `mayDrop` allows it. Only a lead handover drops one (updateProjectCore).
 * Returns whether `next` leaves out a grant `mayDrop` keeps, which the caller
 * refuses with ACCESS_MAP_REMOVES. */
async function writeGrants(
  ctx: MutationCtx,
  project: Doc<'projects'>,
  held: Map<string, Doc<'project_access'>>,
  next: Map<string, GrantLevel>,
  mayDrop: (uid: string) => boolean,
): Promise<boolean> {
  for (const [uid, level] of next) {
    const row = held.get(uid)
    if (row !== undefined && row.level === level) continue
    await assertGrantee(ctx, project, uid, level)
    if (row !== undefined) await ctx.db.patch(row._id, { level })
    else await ctx.db.insert('project_access', { project_id: project.id, profile_id: uid, level })
  }
  let removes = false
  for (const [uid, row] of held) {
    if (next.has(uid)) continue
    if (mayDrop(uid)) await ctx.db.delete(row._id)
    // a removed person's grant waits for its cleanup (profileRemovals.ts),
    // and no client lists it (lib/workspaceJoin.ts), so leaving it out
    // removes nothing
    else if ((await byId(ctx, 'profiles', uid)) !== null) removes = true
  }
  return removes
}

/* ------------------------------------------------------ archive / restore */

/**
 * Archives a project, Lead access required (0106). Subtree-atomic
 * (0106:86-91): a meta stamps its active subs with the parent's OWN instant,
 * which is the only record of "these came along" and what restoring reads.
 * Existing tasks are untouched; the snapshot stops shipping them because its
 * section filters on project.archived_at. Their inbox messages are marked
 * read for every recipient in the background (model/messages.ts
 * scheduleArchivedReads). Already archived is a silent no-op. Returns
 * whether it archived anything.
 */
export async function archiveProjectCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; project: Doc<'projects'>; now: string; provenance?: string },
): Promise<boolean> {
  const { me, project, now } = a
  await assertLead(ctx, me, project.id)
  if (project.archived_at !== undefined) return false
  const archived = [project.id]
  if (project.type === 'meta') {
    const subs = await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
      .collect()
    for (const s of subs) {
      if (s.archived_at === undefined) {
        await ctx.db.patch(s._id, { archived_at: now })
        archived.push(s.id)
      }
    }
  }
  const carried = archived.length - 1
  await ctx.db.patch(project._id, { archived_at: now })
  await scheduleArchivedReads(ctx, { projects: archived })
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'archived',
    target_type: 'project',
    target_id: project.id,
    label: project.name,
    detail: signedDetail(
      carried > 0 ? `with ${carried} sub-project${carried > 1 ? 's' : ''}` : undefined,
      a.provenance,
    ),
    project_id: project.id,
    ts: now,
  })
  return true
}

/**
 * Restores an archived project, Lead access required. Restore semantics
 * 0106:92-107: restoring a sub surfaces its parent (and nothing else — the
 * parent's other subs stay archived); restoring a meta directly also
 * restores exactly the subs carrying the meta's own archive stamp. Surfacing
 * an archived parent is a restore of that parent, so it needs lead on the
 * parent as well; a sub-project's own lead cannot bring back a project its
 * lead archived. Not archived is a silent no-op. Returns whether it restored
 * anything. The restored projects' tasks make the parents they have in
 * other active projects groups again, which then lose their own remaining
 * hours in background steps (regroup.ts).
 */
export async function unarchiveProjectCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; project: Doc<'projects'>; now: string; provenance?: string },
): Promise<boolean> {
  const { me, project, now } = a
  await assertLead(ctx, me, project.id)
  if (project.archived_at === undefined) return false
  const stamp = project.archived_at
  // an active project never sits under an archived one
  const parent =
    project.parent_id === undefined ? null : await byId(ctx, 'projects', project.parent_id)
  const parentArchived = parent !== null && parent.archived_at !== undefined
  if (parentArchived && !(await hasProjectLevel(ctx, me, parent.id, 'lead'))) {
    throw forbidden('requires lead access to the archived parent project')
  }
  await ctx.db.patch(project._id, { archived_at: undefined })
  // the projects whose tasks come back. Tasks live in sub-projects, but a
  // task older code stored under a top-level project comes back too
  // (lib/liveTasks.ts liveTasksOf reads it).
  const restored = [project.id]
  if (project.parent_id !== undefined) {
    if (parentArchived) {
      await ctx.db.patch(parent._id, { archived_at: undefined })
      restored.push(parent.id)
    }
  } else {
    const subs = await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
      .collect()
    for (const s of subs) {
      if (s.archived_at !== stamp) continue
      await ctx.db.patch(s._id, { archived_at: undefined })
      restored.push(s.id)
    }
  }
  await ctx.scheduler.runAfter(0, restoredStepRef, { projects: restored, restorer_id: me.id })
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'restored',
    target_type: 'project',
    target_id: project.id,
    label: project.name,
    detail: signedDetail('from the archive', a.provenance),
    project_id: project.id,
    ts: now,
  })
  return true
}

/** What a removal summary reads of one project tree: at most `cap` tasks
 * and `bytes` of task documents (estimated), whichever comes first. The
 * bytes stay at half of Convex's 16 MiB read limit, which leaves room for
 * the query's other reads and the one task read past either limit. A
 * mutable object, so tests can lower it. */
export const REMOVAL_COUNT = { cap: 5000, bytes: 8 * 1024 * 1024 }

/** Tasks counted in a project or a tree. `more`: the count stopped at a
 * limit before it read all of them. Where it stopped it read one more task
 * than it counted, so there are more than `tasks`; it counts nothing in the
 * projects after that one. */
export type RemovalCount = { tasks: number; archived_tasks: number; more: boolean }

/**
 * What archiving or deleting `project` takes along, for the app's Archive
 * or delete window (projects.removalSummary): every sub-project, archived
 * ones included, and the tasks of the whole tree, archived ones included,
 * which the client cannot count from what its snapshot holds. Convex has no
 * count, so the tasks are read within REMOVAL_COUNT for the whole tree,
 * which keeps a very large tree, or one of long descriptions, within a
 * query's limits. A count cut short says `more` ("more than 5,000 tasks").
 */
export async function removalSummaryOf(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<RemovalCount & { sub_projects: (RemovalCount & SubProjectName)[] }> {
  let tasksLeft = REMOVAL_COUNT.cap
  let bytesLeft = REMOVAL_COUNT.bytes
  let stopped = false
  const count = async (id: string): Promise<RemovalCount> => {
    let tasks = 0
    let archived_tasks = 0
    if (stopped) return { tasks, archived_tasks, more: true }
    const range = ctx.db.query('issues').withIndex('by_project', (q) => q.eq('project_id', id))
    for await (const task of range) {
      const bytes = estimateDocumentBytes(task)
      // the task past a limit is read but not counted, and shows that more remain
      if (tasksLeft === 0 || bytes > bytesLeft) {
        stopped = true
        return { tasks, archived_tasks, more: true }
      }
      tasksLeft -= 1
      bytesLeft -= bytes
      tasks += 1
      if (task.archived_at !== undefined) archived_tasks += 1
    }
    return { tasks, archived_tasks, more: false }
  }
  const own = await count(project.id)
  const subs = await ctx.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
    .collect()
  const sub_projects: (RemovalCount & SubProjectName)[] = []
  for (const sub of subs.sort((a, b) => a.sort_order - b.sort_order))
    sub_projects.push({
      id: sub.id,
      name: sub.name,
      key: sub.key,
      archived: sub.archived_at !== undefined,
      ...(await count(sub.id)),
    })
  const counted = [own, ...sub_projects]
  return {
    tasks: counted.reduce((n, c) => n + c.tasks, 0),
    archived_tasks: counted.reduce((n, c) => n + c.archived_tasks, 0),
    more: stopped,
    sub_projects,
  }
}

type SubProjectName = { id: string; name: string; key: string; archived: boolean }
