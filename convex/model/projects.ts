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
import { type ConvexError, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  canChangeAccess,
  canManageOwnProjectAccess,
  canManageProjectUsers,
  hasProjectLevel,
  levelRank,
  NO_USER_MANAGEMENT,
  projectLevel,
  rootMetaOf,
} from '../lib/access'
import { assertNewRowId, byId, insertUnique, newWindowKey } from '../lib/db'
import type { AccessLevel, GrantLevel, ProjectType } from '../lib/enums'
import { descriptionForm, trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, notFound, type Refusal, require, rule } from '../lib/functions'
import { limitedNumber, limitedText } from '../lib/limitRules'
import { grouped, LIMITS } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { canCreateProjects, projectCreationRefusal } from '../lib/projectCreators'
import { creatorGrant, type Grants, grantsAfterHandover } from '../lib/projectGrants'
import { PROJECT_KEY_SHAPE, projectKeyBase, projectKeyCandidate } from '../lib/projectKeys'
import { resolveReviewHours, roundReviewHours } from '../lib/review'
import { logActivity, signedDetail } from './activity'
import { recheckProject } from './archiveRechecks'
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
import { nextProjectNum, tallyRow } from './orgs'
import {
  archiveStateOf,
  childRows,
  deleteGrant,
  grantBatch,
  patchRows,
  syncLeads,
  type TreeBudget,
  treeBudget,
  treeRows,
  treeSubProjects,
} from './projectNav'
import { renameProjectTotals } from './storageTotals'

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

/** The refusal of a settings edit, an archive or a new sub-project by a
 * caller without Lead access to the project (assertLead). */
export const LEAD_ACCESS_NEEDED = 'requires lead access to this project'

/* projects_update is lead level (0106 left it as the rule — no RPC), so the
 * plain surfaces refuse as the silent 0-row did. */
async function assertLead(ctx: QueryCtx, me: Doc<'profiles'>, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, me, projectId, 'lead'))) {
    throw forbidden(LEAD_ACCESS_NEEDED)
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
 * grant. Refusing silently was the RLS behavior — surfaced as forbidden.
 * Answers the grantee's profile. */
export async function assertGrantee(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  profileId: string,
  level: GrantLevel,
): Promise<Doc<'profiles'>> {
  const p = await byId(ctx, 'profiles', profileId)
  if (p === null || p.org_id !== project.org_id) {
    throw forbidden('the grantee must hold a profile in this organization')
  }
  if (level !== 'viewer' && p.org_role === 'viewer') {
    throw forbidden('a viewer can only receive a viewer grant')
  }
  return p
}

/** A team share's team must belong to the project's organization. Answers
 * the team. */
export async function assertTeamGrantee(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  teamId: string,
): Promise<Doc<'teams'>> {
  const team = await byId(ctx, 'teams', teamId)
  if (team === null || team.org_id !== project.org_id) {
    throw forbidden('the team must belong to this organization')
  }
  return team
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

/** The refusal of a new sub-project whose parent the caller cannot see, in
 * this organization or another, which reads like a missing one. */
export const PARENT_NOT_FOUND = 'parent project not found'

/** The refusal of a new sub-project under a sub-project. */
export const PARENT_NOT_TOP_LEVEL =
  'sub-projects live directly under a project, never under another sub-project'

/** The refusal of a new sub-project under an archived project. */
export const PARENT_ARCHIVED = 'the project is archived, so restore it first'

/** What subProjectParent answers: the parent, a parent that reads as
 * missing (PARENT_NOT_FOUND), or the refusal the create throws. */
export type ParentCheck =
  | { state: 'ok'; parent: Doc<'projects'> }
  | { state: 'missing' }
  | { state: 'refused'; refusal: ConvexError<Refusal> }

/**
 * The checks createProjectCore makes of the row a new sub-project names as
 * its parent, in its order: one `me` cannot see reads as missing, then a
 * parent that is not a meta, an archived parent and a parent `me` holds no
 * Lead access to are refused with the create's own sentences
 * (projects_hierarchy_guard 0078:341-349, archive-parent guard 0106:68). The
 * lead picker of a new sub-project (model/projectSettings.ts
 * leadCandidatesOf) asks the same, so both say the same.
 *
 * `levelOf` answers `me`'s level on the parent, navigation included, which
 * decides both whether they see it (canSeeProject) and whether they have
 * Lead access to it (hasProjectLevel). The create reads it with
 * lib/access.ts projectLevel, which throws not_found for a parent whose own
 * chain of parents is broken; a read passes accessOf's level, which answers
 * the same within bounded reads.
 */
export async function subProjectParent(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  parent: Doc<'projects'> | null,
  levelOf: (parent: Doc<'projects'>) => Promise<AccessLevel | null> = (p) =>
    projectLevel(ctx, me, p),
): Promise<ParentCheck> {
  const level = parent === null ? null : await levelOf(parent)
  if (parent === null || level === null) return { state: 'missing' }
  if (parent.type !== 'meta') return { state: 'refused', refusal: rule(PARENT_NOT_TOP_LEVEL) }
  if (parent.archived_at !== undefined) return { state: 'refused', refusal: rule(PARENT_ARCHIVED) }
  if (levelRank(level) < levelRank('lead'))
    return { state: 'refused', refusal: forbidden(LEAD_ACCESS_NEEDED) }
  return { state: 'ok', parent }
}

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
    const parent = await subProjectParent(ctx, me, await byId(ctx, 'projects', p.parent_id))
    if (parent.state === 'missing') throw rule(PARENT_NOT_FOUND)
    if (parent.state === 'refused') throw parent.refusal
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
      ...named(name),
      lead_id,
      description,
      sort_order,
      num,
      // Teamless projects use the neutral default unless explicitly set.
      track_delay: p.track_delay ?? true,
      created_at: now,
      window_key: newWindowKey(),
      // a parent is never archived (above)
      archive_state: 'live',
    },
    badRequest('a project with this id already exists'),
  )
  const project = await byId(ctx, 'projects', p.id)
  require(project !== null, notFound('project not found'))
  await tallyRow(ctx, 'projects', null, project)
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
  // grants and shares copy their profile's or team's name key
  // (model/nameKeys.ts), and they and the lead write their reach rows
  // (model/projectNav.ts), the grants' and shares' together
  await syncLeads(ctx, project.id, [lead_id])
  const given = grantBatch(ctx)
  for (const [uid, level] of grants) {
    const grantee = await assertGrantee(ctx, project, uid, level)
    await given.grant(project, {
      project_id: project.id,
      profile_id: uid,
      level,
      name_key: nameKey(grantee.name),
    })
  }
  for (const [sharedTeamId, level] of Object.entries(p.team_access ?? {})) {
    const team = await assertTeamGrantee(ctx, project, sharedTeamId)
    await given.share(project, {
      project_id: project.id,
      team_id: sharedTeamId,
      level,
      name_key: nameKey(team.name),
    })
  }
  await given.finish()
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
 * clears. */
export type ProjectPatch = {
  name?: string
  lead_id?: string | null
  description?: string | null
  key?: string
  track_delay?: boolean
  review_hours?: number | null
}

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
 * Applies a field patch in ONE write, and narrates it once, by priority
 * name > lead; same-value name and lead writes are silent no-ops, and
 * description, key, track_delay and review_hours alone narrate nothing. A
 * lead handover keeps the outgoing lead as User and drops the incoming
 * lead's own grant (lib/projectGrants.ts grantsAfterHandover), the only
 * grants this writes; projects.setAccess and projects.removeAccess change
 * the others (model/projectAccess.ts). Changing the lead takes a person.
 * Every patch needs Lead access except a top-level project's lead alone,
 * which needs an organization admin or the project's lead. Returns the
 * project as stored.
 */
export async function updateProjectCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    project: Doc<'projects'>
    patch: ProjectPatch
    now: string
    provenance?: string
    /** What the caller read, in its view (model/expected.ts). */
    expected?: Readonly<Record<string, unknown>>
    view?: View
    /** The tree budget an archive or restore of the same mutation shares
     * (model/projectNav.ts TreeBudget). */
    budget?: TreeBudget
  },
): Promise<Doc<'projects'>> {
  const { me, project, patch, now } = a
  const id = project.id
  const prevLead = project.lead_id
  const nextLead = patch.lead_id === undefined ? prevLead : (patch.lead_id ?? undefined)
  const leadChanged = nextLead !== prevLead
  if (leadChanged && !canChangeAccess(me)) throw forbidden(ACCESS_NEEDS_A_PERSON)
  const managesUsers = project.type === 'meta' && patch.lead_id !== undefined
  const editsSettings = Object.keys(patch).some(
    (key) => !(key === 'lead_id' && project.type === 'meta'),
  )
  // Evaluate all capabilities against the pre-write state. A caller may
  // not attach a settings change to a lead change, or make themselves lead
  // first and use that standing for the rest of this same mutation.
  if (editsSettings || !managesUsers) await assertLead(ctx, me, id)
  if (managesUsers && !(await canManageProjectUsers(ctx, me, project))) {
    throw forbidden(NO_USER_MANAGEMENT)
  }
  const controlsOwnAccess = await canManageOwnProjectAccess(ctx, me, project)
  await assertExpected({
    read: { ctx, me, view: a.view ?? 'app' },
    fields: PROJECT_FIELDS,
    record: 'project',
    id,
    label: `project ${project.key}`,
    row: project,
    expected: a.expected,
    next: patch,
  })
  const db: Partial<Doc<'projects'>> = {}
  if (patch.name !== undefined) Object.assign(db, named(cleanProjectName(patch.name)))
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
  // The reach rows copy the project's name key and key (model/projectNav.ts),
  // read before anything is written, so a change past
  // LIMITS.projectTreeChange is refused whole.
  const copies: { name_key?: string; key?: string } = {}
  if (db.name_key !== undefined && db.name_key !== nameKey(project.name))
    copies.name_key = db.name_key
  if (db.key !== undefined && db.key !== project.key) copies.key = db.key
  const reach =
    Object.keys(copies).length > 0
      ? await treeRows(ctx, project.org_id, [id], a.budget ?? treeBudget())
      : []
  // The project row goes first, so the reach rows the handover's grants
  // below bring in line copy it as it is now.
  if (Object.keys(db).length > 0) await ctx.db.patch(project._id, db)
  await patchRows(ctx, reach, copies)
  if (leadChanged) await syncLeads(ctx, id, [prevLead, nextLead])
  // the handover's new grants write their reach rows together
  const given = grantBatch(ctx)
  if (leadChanged && nextLead !== undefined) {
    const held = await grantRows(ctx, id)
    const current: Grants = Object.fromEntries([...held].map(([uid, row]) => [uid, row.level]))
    const after = grantsAfterHandover(current, prevLead, nextLead)
    await writeGrants(ctx, given, project, held, new Map(Object.entries(after)))
  }
  await given.finish()
  const name = db.name ?? project.name
  const nameChanged = db.name !== undefined && db.name !== project.name
  // the Storage by project breakdown shows the project's current name
  if (nameChanged) await renameProjectTotals(ctx, { ...project, name })
  const event = {
    org_id: me.org_id,
    actor_id: me.id,
    target_type: 'project' as const,
    target_id: id,
    label: name,
    project_id: id,
    ts: now,
  }
  if (nameChanged) {
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

/* Brings a project's individual grant rows to `next`, the grants a lead
 * handover leaves (updateProjectCore): changed levels are patched, new ones
 * checked and inserted through `given`, which writes their reach rows when
 * the caller finishes it, and the ones `next` leaves out deleted. `next`
 * comes from `held`, so only the incoming lead's own grant goes. */
async function writeGrants(
  ctx: MutationCtx,
  given: ReturnType<typeof grantBatch>,
  project: Doc<'projects'>,
  held: Map<string, Doc<'project_access'>>,
  next: Map<string, GrantLevel>,
): Promise<void> {
  for (const [uid, level] of next) {
    const row = held.get(uid)
    if (row !== undefined && row.level === level) continue
    const grantee = await assertGrantee(ctx, project, uid, level)
    const name_key = nameKey(grantee.name)
    if (row !== undefined) await ctx.db.patch(row._id, { level, name_key })
    else await given.grant(project, { project_id: project.id, profile_id: uid, level, name_key })
  }
  for (const [uid, row] of held) if (!next.has(uid)) await deleteGrant(ctx, row)
}

/* ------------------------------------------------------ archive / restore */

/** An archive or a restore as a caller asks for it. `budget` is the tree
 * budget a rename of the same mutation shares (model/projectNav.ts
 * TreeBudget), else the change takes its own. */
type TreeChange = {
  me: Doc<'profiles'>
  project: Doc<'projects'>
  now: string
  provenance?: string
  budget?: TreeBudget
}

/**
 * Archives a project, Lead access required (0106). Subtree-atomic
 * (0106:86-91): a meta stamps its active subs with the parent's OWN instant,
 * which is the only record of "these came along" and what restoring reads.
 * Every sub-project then sits under an archived parent (archive_state
 * 'under'), and the reach rows of the projects it archives say they are no
 * longer live (model/projectNav.ts). A tree whose sub-projects and the
 * rows it reads pass LIMITS.projectTreeChange.max or TREE_READ.bytes is
 * refused before anything is written; when it carries sub-projects, those
 * rows include the archived child rows its restore will read. Existing
 * tasks are untouched; the snapshot stops shipping them because its
 * section filters on project.archived_at. Their inbox messages are marked
 * read for every recipient in the background
 * (model/messages.ts scheduleArchivedReads). Already archived is a silent
 * no-op. Returns whether it archived anything.
 */
export async function archiveProjectCore(ctx: MutationCtx, a: TreeChange): Promise<boolean> {
  const { me, project, now } = a
  await assertLead(ctx, me, project.id)
  if (project.archived_at !== undefined) return false
  const budget = a.budget ?? treeBudget()
  const subs = project.type === 'meta' ? await treeSubProjects(ctx, project.id, budget) : []
  const carried = subs.filter((s) => s.archived_at === undefined)
  const archived = [project.id, ...carried.map((s) => s.id)]
  // the project's rows, and the live child rows of the sub-projects it
  // carries; a sub-project a restore from Deleted items has not revealed
  // yet holds live child rows under it too, which follow its stored copy
  // and stay as they are. With sub-projects to carry it reads the archived
  // child rows too, which it leaves as they are, because the restore that
  // brings those sub-projects back reads them (childRows). Without any, it
  // reads no child row, as that restore reads none.
  const reach = await treeRows(ctx, project.org_id, [project.id], budget)
  if (carried.length > 0) {
    const ids = new Set(carried.map((s) => s.id))
    for (const row of await childRows(ctx, project.org_id, project.id, undefined, budget))
      if (row.live && ids.has(row.project_id)) reach.push(row)
  }
  const parent =
    project.parent_id === undefined ? null : await byId(ctx, 'projects', project.parent_id)
  for (const s of subs) {
    if (s.archived_at === undefined)
      await ctx.db.patch(s._id, { archived_at: now, archive_state: 'under' })
    else if (s.archive_state !== 'under') await ctx.db.patch(s._id, { archive_state: 'under' })
  }
  await ctx.db.patch(project._id, {
    archived_at: now,
    archive_state: archiveStateOf({ archived_at: now }, parent),
  })
  await patchRows(ctx, reach, { live: false })
  await scheduleArchivedReads(ctx, { projects: archived })
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'archived',
    target_type: 'project',
    target_id: project.id,
    label: project.name,
    detail: signedDetail(
      carried.length > 0
        ? `with ${carried.length} sub-project${carried.length > 1 ? 's' : ''}`
        : undefined,
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
 * lead archived. The sub-projects that stay archived then sit under a live
 * parent (archive_state 'listed'), and the reach rows of the projects it
 * restores say they are live again (model/projectNav.ts). A tree whose
 * sub-projects and those rows pass LIMITS.projectTreeChange.max is refused
 * before anything is written. Not archived is a silent no-op. Returns
 * whether it restored anything. The restored projects' tasks make the
 * parents they have in other active projects groups again, which then lose
 * their own remaining hours in background steps (regroup.ts). The next
 * nightly archive checks each restored project in full, because their Done
 * tasks keep their done_at (model/archiveRechecks.ts).
 */
export async function unarchiveProjectCore(ctx: MutationCtx, a: TreeChange): Promise<boolean> {
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
  // the projects whose tasks come back. Tasks live in sub-projects, but a
  // task older code stored under a top-level project comes back too
  // (lib/liveTasks.ts liveTasksOf reads it).
  const restored = [project]
  // the archived sub-projects that stay archived under a parent that is live now
  let left: Doc<'projects'>[] = []
  const budget = a.budget ?? treeBudget()
  let reach: Doc<'project_reach'>[]
  if (project.parent_id !== undefined) {
    if (parentArchived) {
      restored.push(parent)
      left = (await treeSubProjects(ctx, parent.id, budget)).filter(
        (s) => s.id !== project.id && s.archived_at !== undefined,
      )
    }
    reach = await treeRows(
      ctx,
      project.org_id,
      restored.map((p) => p.id),
      budget,
    )
  } else {
    const subs = await treeSubProjects(ctx, project.id, budget)
    const back = subs.filter((s) => s.archived_at === stamp)
    restored.push(...back)
    left = subs.filter((s) => s.archived_at !== undefined && s.archived_at !== stamp)
    // the project's rows, and the child rows of the sub-projects it brings
    // back, among the archived child rows under it
    reach = await treeRows(ctx, project.org_id, [project.id], budget)
    const ids = new Set(back.map((s) => s.id))
    if (ids.size > 0)
      for (const row of await childRows(ctx, project.org_id, project.id, false, budget))
        if (ids.has(row.project_id)) reach.push(row)
  }
  const ids = restored.map((p) => p.id)
  // Their Done tasks keep their done_at, so the nightly archive checks
  // these projects in full (model/archiveRechecks.ts).
  for (const p of restored) {
    await ctx.db.patch(p._id, { archived_at: undefined, archive_state: 'live' })
    await recheckProject(ctx.db, { org_id: p.org_id, project_id: p.id })
  }
  for (const s of left)
    if (s.archive_state !== 'listed') await ctx.db.patch(s._id, { archive_state: 'listed' })
  await patchRows(ctx, reach, { live: true })
  await ctx.scheduler.runAfter(0, restoredStepRef, { projects: ids, restorer_id: me.id })
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
