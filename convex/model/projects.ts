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
} from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import type { GrantLevel, ProjectType } from '../lib/enums'
import { badRequest, forbidden, notFound, require, rule } from '../lib/functions'
import { canCreateProjects, projectCreationRefusal } from '../lib/projectCreators'
import { creatorGrant, type Grants, grantsAfterHandover } from '../lib/projectGrants'
import { PROJECT_KEY_SHAPE, projectKeyBase, projectKeyCandidate } from '../lib/projectKeys'
import { PROJECT_DESCRIPTION_MAX } from '../lib/projectLimits'
import { REVIEW_HOURS_MAX, resolveReviewHours, roundReviewHours } from '../lib/review'
import { logActivity, signedDetail } from './activity'
import { scheduleArchivedReads } from './messages'
import { ICON_COLOR_SHAPE, nextProjectNum } from './orgs'

/** Preserve the supplied text; null/omitted create values mean no description. */
export function projectDescription(value: string | null | undefined): string {
  const description = value ?? ''
  // String.length matches the browser's native textarea maxLength exactly.
  if (description.length > PROJECT_DESCRIPTION_MAX) {
    throw badRequest(`a project description must be ${PROJECT_DESCRIPTION_MAX} characters or fewer`)
  }
  return description
}

/** A project name as stored: trimmed, and refused when nothing is left. The
 * app trims and skips a blank name before it writes, and sets no length
 * limit, so neither does this. */
export function cleanProjectName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a project name cannot be blank')
  return name
}

/** The stored project review time: null clears it (the project inherits
 * again), a value is kept to the 0.1 h grain within 0..REVIEW_HOURS_MAX. */
export function cleanReviewHours(v: number | null): number | undefined {
  if (v === null) return undefined
  if (!Number.isFinite(v) || v < 0 || v > REVIEW_HOURS_MAX) {
    throw badRequest(
      `review_hours must be a number of hours from 0 to ${REVIEW_HOURS_MAX}, or null`,
    )
  }
  return roundReviewHours(v)
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

/** The project holding `key` in the organization, archived or not. */
async function keyHolder(
  ctx: QueryCtx,
  orgId: string,
  key: string,
): Promise<Doc<'projects'> | null> {
  return await ctx.db
    .query('projects')
    .withIndex('by_org_key', (q) => q.eq('org_id', orgId).eq('key', key))
    .first()
}

/* An explicit key change (update) is refused when another project holds the
 * key. The REST API already admits that a key exists (rest.ts's one
 * deliberate 403 oracle), so this sentence discloses nothing new. */
async function assertKeyFree(
  ctx: QueryCtx,
  orgId: string,
  key: string,
  self: string,
): Promise<void> {
  const holder = await keyHolder(ctx, orgId, key)
  if (holder !== null && holder.id !== self) {
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
      throw rule('a viewer cannot lead a project — make them a standard user first')
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
  icon?: string | null
  icon_color?: string | null
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
      throw rule('the project is archived — restore it first')
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
  if (p.type === 'project' && (p.icon != null || p.icon_color != null)) {
    throw badRequest('sub-projects carry no icon')
  }
  const iconColor = p.icon_color === '' ? undefined : (p.icon_color ?? undefined)
  if (iconColor !== undefined && !ICON_COLOR_SHAPE.test(iconColor)) {
    throw badRequest('an icon color must be a #rrggbb hex')
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
      icon: p.icon ?? undefined,
      icon_color: iconColor,
      lead_id,
      description,
      sort_order,
      num,
      // Teamless projects use the neutral default unless explicitly set.
      track_delay: p.track_delay ?? true,
      created_at: now,
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
 * clears. `access` and `team_access` replace the project's whole grant
 * lists, as the app's Project access editor sends them. */
export type ProjectPatch = {
  name?: string
  icon?: string | null
  icon_color?: string | null
  lead_id?: string | null
  description?: string | null
  key?: string
  track_delay?: boolean
  review_hours?: number | null
  access?: Record<string, GrantLevel | 'lead'>
  team_access?: Record<string, GrantLevel>
}

/**
 * Applies a field patch and any access-map diff in ONE write, and narrates
 * it once, by priority access > name > lead; same-value name and lead writes
 * are silent no-ops, and icon, description, key, track_delay and
 * review_hours alone narrate nothing. A lead handover without an access map
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
  // projects_sub_no_icon (0069): the glyph/tint stays a meta feature
  if (project.type === 'project' && (patch.icon != null || patch.icon_color != null)) {
    throw badRequest('sub-projects carry no icon')
  }
  const db: Partial<Doc<'projects'>> = {}
  if (patch.name !== undefined) db.name = cleanProjectName(patch.name)
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
    await assertKeyFree(ctx, me.org_id, key, id)
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
    await writeGrants(ctx, project, held, next)
  } else if (leadChanged && nextLead !== undefined) {
    const held = await grantRows(ctx, id)
    const current: Grants = Object.fromEntries([...held].map(([uid, row]) => [uid, row.level]))
    const after = grantsAfterHandover(current, prevLead, nextLead)
    await writeGrants(ctx, project, held, new Map(Object.entries(after)))
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
 * patched, new ones checked and inserted, missing ones deleted. */
async function writeGrants(
  ctx: MutationCtx,
  project: Doc<'projects'>,
  held: Map<string, Doc<'project_access'>>,
  next: Map<string, GrantLevel>,
): Promise<void> {
  for (const [uid, level] of next) {
    const row = held.get(uid)
    if (row !== undefined && row.level === level) continue
    await assertGrantee(ctx, project, uid, level)
    if (row !== undefined) await ctx.db.patch(row._id, { level })
    else await ctx.db.insert('project_access', { project_id: project.id, profile_id: uid, level })
  }
  for (const [uid, row] of held) {
    if (!next.has(uid)) await ctx.db.delete(row._id)
  }
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
 * anything.
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
  if (project.parent_id !== undefined) {
    if (parentArchived) await ctx.db.patch(parent._id, { archived_at: undefined })
  } else {
    const subs = await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', project.id))
      .collect()
    for (const s of subs) {
      if (s.archived_at === stamp) await ctx.db.patch(s._id, { archived_at: undefined })
    }
  }
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
