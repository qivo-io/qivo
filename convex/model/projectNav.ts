/* The data project navigation pages through: each project's archive state
 * and the project_reach rows of every seat and team (schema.ts).
 *
 * archiveStateOf derives a project's archive_state from its archived_at and
 * its parent's, and every writer of archived_at stores it.
 *
 * A seat's or a team's reach rows follow the sources of ordinary access
 * they hold: a project's lead_id, a user grant and a team share, in a
 * top-level meta's tree (lib/access.ts inMetaTree). syncReach recomputes the
 * rows of one grantee on one project and its top-level project from those
 * sources, so calling it after any change to them, or again, leaves them
 * exact. Every user grant and team share is inserted and deleted through
 * insertGrant, deleteGrant, insertShare and deleteShare, which call it, and
 * a lead change calls it for both leads (syncLeads). A level change keeps
 * the rows as they are, because a row records that access exists, not its
 * level. A rename, a key change, an archive or a restore updates the copies
 * on the rows of the projects it changes, read with treeRows, which refuses
 * a change past LIMITS.projectTreeChange.max before anything is written.
 * Teardowns delete a grantee's or an organization's rows outright
 * (reachOfGrantee, reachOfOrg).
 *
 * org_ready.nav_at says an organization's rows are complete, and navReady
 * asks it with the name keys stamp, which name-ordered project lists need
 * too. */

import type { WithoutSystemFields } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { inMetaTree } from '../lib/access'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import type { ArchiveState, GranteeKind } from '../lib/enums'
import { rule } from '../lib/functions'
import { LIMITS, MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { readyRow } from './nameKeys'

/** The archive state of `project` (schema.ts projects.archive_state), with
 * `parent` the project above it, if any: 'live' while it is not archived,
 * 'under' when it is archived beneath an archived parent, else 'listed'. */
export function archiveStateOf(
  project: Pick<Doc<'projects'>, 'archived_at'>,
  parent: Pick<Doc<'projects'>, 'archived_at'> | null,
): ArchiveState {
  if (project.archived_at === undefined) return 'live'
  return parent !== null && parent.archived_at !== undefined ? 'under' : 'listed'
}

/** Who reach rows are for: a seat, by its profile id, or a team. */
export type Grantee = { grantee_kind: GranteeKind; grantee_id: string }

/** The project fields reach rows follow. */
export type ReachProject = Pick<
  Doc<'projects'>,
  'id' | 'org_id' | 'type' | 'parent_id' | 'lead_id' | 'name' | 'key' | 'archived_at'
>

/** Reads a project by id for syncReach: the live table by default. A restore
 * from Deleted items passes one that also reads its stored projects, which
 * are absent until its reveal (model/deletedItems.ts restoreAccess). */
export type ProjectRead = (id: string) => Promise<ReachProject | null>

type ReachRow = WithoutSystemFields<Doc<'project_reach'>>

/** The grantee's row on project `projectId`, if any. */
const rowOn = (ctx: QueryCtx, g: Grantee, projectId: string) =>
  ctx.db
    .query('project_reach')
    .withIndex('by_project_grantee', (q) =>
      q
        .eq('project_id', projectId)
        .eq('grantee_kind', g.grantee_kind)
        .eq('grantee_id', g.grantee_id),
    )
    .first()

/** The organization of the grantee, or null when its profile or team is
 * gone. */
async function granteeOrg(ctx: QueryCtx, g: Grantee): Promise<string | null> {
  const row =
    g.grantee_kind === 'profile'
      ? await byId(ctx, 'profiles', g.grantee_id)
      : await byId(ctx, 'teams', g.grantee_id)
  return row?.org_id ?? null
}

/** Whether the grantee holds a source of ordinary access on `project`
 * itself: for a seat the project's own lead_id or a user grant, for a team
 * a team share. A sub-project without a lead of its own is led by its
 * top-level project's lead, whose root row reaches it. */
async function holdsSource(ctx: QueryCtx, g: Grantee, project: ReachProject): Promise<boolean> {
  if (g.grantee_kind === 'profile') {
    if (project.lead_id === g.grantee_id) return true
    const grant = await ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', project.id).eq('profile_id', g.grantee_id),
      )
      .first()
    return grant !== null
  }
  const share = await ctx.db
    .query('project_team_access')
    .withIndex('by_project_team', (q) => q.eq('project_id', project.id).eq('team_id', g.grantee_id))
    .first()
  return share !== null
}

/** The row the grantee should hold on `project`, under top-level `root`. */
const rowFor = (
  g: Grantee,
  kind: ReachRow['kind'],
  project: ReachProject,
  root: ReachProject,
  on_root: boolean,
): ReachRow => ({
  org_id: project.org_id,
  grantee_kind: g.grantee_kind,
  grantee_id: g.grantee_id,
  kind,
  project_id: project.id,
  root_id: root.id,
  name_key: nameKey(project.name),
  key: project.key,
  live: project.archived_at === undefined,
  on_root,
})

/** One reach row as it is (null for none) and as it should be (null for
 * none), where the two differ. */
export type ReachChange = { row: Doc<'project_reach'> | null; want: ReachRow | null }

const FIELDS = [
  'org_id',
  'kind',
  'root_id',
  'name_key',
  'key',
  'live',
  'on_root',
] as const satisfies readonly (keyof ReachRow)[]

const differs = ({ row, want }: ReachChange): boolean =>
  row === null || want === null ? row !== want : FIELDS.some((field) => row[field] !== want[field])

const live: (ctx: QueryCtx) => ProjectRead = (ctx) => (id) => byId(ctx, 'projects', id)

/** What syncReach would change: the grantee's row on project `projectId`
 * and on its top-level project, each recomputed from the sources the
 * grantee holds now. A project that is gone, or outside a top-level meta's
 * tree in the grantee's organization, gets no row. Its top-level project's
 * row stays while the grantee holds a source on it (on_root) or a child row
 * under it besides this project's, which goes. Writes nothing, so a dry run
 * counts with it (internal/navBackfill.ts). `known` is the grantee's
 * organization when the caller has read its profile or team. */
export async function planReach(
  ctx: QueryCtx,
  g: Grantee,
  projectId: string,
  read: ProjectRead = live(ctx),
  known?: string,
): Promise<ReachChange[]> {
  const project = await read(projectId)
  const own = await rowOn(ctx, g, projectId)
  // a project that is gone takes its rows with it, and its top-level
  // project's row follows; the row it leaves names that project
  const child = project === null ? own?.kind === 'child' : project.parent_id !== undefined
  const rootId = project === null ? own?.root_id : (project.parent_id ?? project.id)
  if (rootId === undefined) return []
  const root = project !== null && project.id === rootId ? project : await read(rootId)
  const org = known ?? (await granteeOrg(ctx, g))
  const changes: ReachChange[] = []
  let childRow: ReachRow | null = null
  if (child) {
    if (
      project !== null &&
      root !== null &&
      org === project.org_id &&
      root.org_id === project.org_id &&
      inMetaTree(project, root) &&
      (await holdsSource(ctx, g, project))
    )
      childRow = rowFor(g, 'child', project, root, false)
    changes.push({ row: own, want: childRow })
  }
  let rootRow: ReachRow | null = null
  if (root !== null && org === root.org_id && inMetaTree(root, root)) {
    const onRoot = await holdsSource(ctx, g, root)
    let navigates = childRow !== null
    if (!onRoot && !navigates) {
      // the grantee's child rows under the root, this project's aside
      const children = await ctx.db
        .query('project_reach')
        .withIndex('by_grantee_root', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('root_id', rootId)
            .eq('kind', 'child'),
        )
        .take(2)
      navigates = children.some((row) => row.project_id !== projectId && row.org_id === root.org_id)
    }
    if (onRoot || navigates) rootRow = rowFor(g, 'root', root, root, onRoot)
  }
  changes.push({ row: child ? await rowOn(ctx, g, rootId) : own, want: rootRow })
  return changes.filter(differs)
}

/** Brings the grantee's reach rows on project `projectId` and its top-level
 * project in line with the sources it holds now (planReach). Idempotent, so
 * a writer calls it after every change to a lead, a grant or a share, and
 * a repeated call changes nothing. `read` reads the projects, the live ones
 * unless a restore passes its own, and `known` is as planReach takes it. A
 * reach row is bookkeeping of the grant
 * it follows, so it spends none of a public demo visitor's record limit
 * (lib/demo.ts uncountedWriter). */
export async function syncReach(
  ctx: MutationCtx,
  g: Grantee,
  projectId: string,
  read?: ProjectRead,
  known?: string,
): Promise<void> {
  await applyReach(ctx, await planReach(ctx, g, projectId, read, known))
}

/** Writes the changes planReach found. */
export async function applyReach(ctx: MutationCtx, changes: readonly ReachChange[]): Promise<void> {
  for (const { row, want } of changes) {
    if (want === null) {
      if (row !== null) await ctx.db.delete(row._id)
    } else if (row === null) await uncountedWriter(ctx.db).insert('project_reach', want)
    else await ctx.db.patch(row._id, want)
  }
}

/** The grantee of a user grant and of a team share. */
export const grantee = {
  profile: (id: string): Grantee => ({ grantee_kind: 'profile', grantee_id: id }),
  team: (id: string): Grantee => ({ grantee_kind: 'team', grantee_id: id }),
}

/** How a grant or share write reaches the database: `read` as syncReach
 * takes it, `db`, the writer of the grant row itself, ctx.db unless a
 * restore writes through its uncounted writer, and `org`, the grantee's
 * organization when the caller has read its profile or team, which saves
 * reading it again. */
type GrantWrite = { read?: ProjectRead; db?: MutationCtx['db']; org?: string }

/** Inserts user grant `row` and brings its person's reach rows in line. The
 * one insert into project_access (tests/manifest.test.ts checks). */
export async function insertGrant(
  ctx: MutationCtx,
  row: WithoutSystemFields<Doc<'project_access'>>,
  o: GrantWrite = {},
): Promise<void> {
  await (o.db ?? ctx.db).insert('project_access', row)
  await syncReach(ctx, grantee.profile(row.profile_id), row.project_id, o.read, o.org)
}

/** Deletes user grant `row` and brings its person's reach rows in line. */
export async function deleteGrant(ctx: MutationCtx, row: Doc<'project_access'>): Promise<void> {
  await ctx.db.delete(row._id)
  await syncReach(ctx, grantee.profile(row.profile_id), row.project_id)
}

/** Inserts team share `row` and brings its team's reach rows in line. The
 * one insert into project_team_access (tests/manifest.test.ts checks). */
export async function insertShare(
  ctx: MutationCtx,
  row: WithoutSystemFields<Doc<'project_team_access'>>,
  o: GrantWrite = {},
): Promise<void> {
  await (o.db ?? ctx.db).insert('project_team_access', row)
  await syncReach(ctx, grantee.team(row.team_id), row.project_id, o.read, o.org)
}

/** Deletes team share `row` and brings its team's reach rows in line. */
export async function deleteShare(
  ctx: MutationCtx,
  row: Doc<'project_team_access'>,
): Promise<void> {
  await ctx.db.delete(row._id)
  await syncReach(ctx, grantee.team(row.team_id), row.project_id)
}

/** How many reach rows grantBatch reads between two runs of its guard. */
const BATCH_GUARD_ROWS = 100

/**
 * User grants given to many people on a few projects in one transaction,
 * with their reach rows written together once the grants are in: a removal
 * that keeps many people as Viewers (model/projectAccess.ts
 * removeAndSettle). insertGrant's recompute reads several index ranges a
 * grant, which hundreds of grants in the one transaction a removal has
 * cannot afford; `finish` reads the people's rows on each project, and on
 * its top-level project, once for all of them, and runs `guard` every
 * BATCH_GUARD_ROWS rows it reads and before it changes a row that exists,
 * which Convex reads first, so a removal can refuse before it passes
 * Convex's limits.
 * Call `finish` after the last `insert` of the transaction. Every person is
 * of the project's organization and now holds a grant on it. A person
 * without a row on the top-level project holds no source there, because one
 * would have written that row, so the row a grant on a sub-project adds
 * there is for navigation only, and an existing one keeps its on_root.
 */
export function grantBatch(ctx: MutationCtx) {
  const given = new Map<string, { project: Doc<'projects'>; people: Set<string> }>()
  /* the people's rows on project `id`, by person */
  const rowsOn = async (id: string, guard: () => Promise<void>) => {
    const rows = new Map<string, Doc<'project_reach'>>()
    const range = ctx.db
      .query('project_reach')
      .withIndex('by_project_grantee', (q) => q.eq('project_id', id).eq('grantee_kind', 'profile'))
    for await (const row of range) {
      if (rows.size > 0 && rows.size % BATCH_GUARD_ROWS === 0) await guard()
      rows.set(row.grantee_id, row)
    }
    return rows
  }
  return {
    /** Inserts user grant `row` on `project`, its rows left to `finish`. */
    insert: async (
      project: Doc<'projects'>,
      row: WithoutSystemFields<Doc<'project_access'>>,
    ): Promise<void> => {
      await ctx.db.insert('project_access', row)
      const entry = given.get(project.id) ?? { project, people: new Set<string>() }
      entry.people.add(row.profile_id)
      given.set(project.id, entry)
    },
    /** Writes the reach rows of every grant `insert` gave. */
    finish: async (guard: () => Promise<void>): Promise<void> => {
      for (const { project, people } of given.values()) {
        const root =
          project.parent_id === undefined ? project : await byId(ctx, 'projects', project.parent_id)
        if (root === null || root.org_id !== project.org_id || !inMetaTree(project, root)) continue
        const own = await rowsOn(project.id, guard)
        const top = project.id === root.id ? own : await rowsOn(root.id, guard)
        for (const id of people) {
          const g = grantee.profile(id)
          const changes: ReachChange[] = []
          if (project.id === root.id)
            changes.push({ row: own.get(id) ?? null, want: rowFor(g, 'root', root, root, true) })
          else {
            const above = top.get(id) ?? null
            changes.push(
              { row: own.get(id) ?? null, want: rowFor(g, 'child', project, root, false) },
              { row: above, want: rowFor(g, 'root', root, root, above?.on_root ?? false) },
            )
          }
          const writes = changes.filter(differs)
          // an insert reads nothing; Convex reads a row it patches or deletes
          if (writes.some(({ row }) => row !== null)) await guard()
          await applyReach(ctx, writes)
        }
      }
    },
  }
}

/** Brings the reach rows of a project's leads in line after its lead_id
 * changed or was first written: each of `leads` that names someone. */
export async function syncLeads(
  ctx: MutationCtx,
  projectId: string,
  leads: readonly (string | undefined)[],
  read?: ProjectRead,
): Promise<void> {
  for (const lead of new Set(leads))
    if (lead !== undefined) await syncReach(ctx, grantee.profile(lead), projectId, read)
}

/** The bytes of sub-projects a tree change reads, half of Convex's 16 MiB
 * read limit as removalSummaryOf keeps (model/projects.ts REMOVAL_COUNT),
 * because a project stored before legacy icons were dropped can be large.
 * A mutable object, so tests can lower it. */
export const TREE_READ = { bytes: 8 * MIB }

/**
 * The reach rows of `projectIds` in organization `orgId`, every grantee's,
 * for a change that updates their copies of the projects (a rename, a key
 * change, an archive or a restore) and also writes `writes` sub-projects.
 * Refuses with LIMITS.projectTreeChange's sentence when the rows and those
 * sub-projects together pass its max, reading at most one row past it. Call
 * it before the change writes anything, so a refusal leaves everything as
 * it was. Each row is one of the change's writes, which Convex reads by id
 * first, so the max keeps them to about half of the 4,096 index ranges one
 * transaction may read, as model/labels.ts LABEL_REMOVAL measured, and
 * leaves the rest to the change's own reads. A row another organization
 * left on a reused project id until its teardown deletes it counts but is
 * not returned, so the change never writes it.
 */
export async function treeRows(
  ctx: QueryCtx,
  orgId: string,
  projectIds: readonly string[],
  writes = 0,
): Promise<Doc<'project_reach'>[]> {
  let left = LIMITS.projectTreeChange.max - writes
  if (left < 0) throw rule(LIMITS.projectTreeChange.refusal)
  const rows: Doc<'project_reach'>[] = []
  for (const id of new Set(projectIds)) {
    const got = await ctx.db
      .query('project_reach')
      .withIndex('by_project_grantee', (q) => q.eq('project_id', id))
      .take(left + 1)
    if (got.length > left) throw rule(LIMITS.projectTreeChange.refusal)
    rows.push(...got.filter((row) => row.org_id === orgId))
    left -= got.length
  }
  return rows
}

/** The sub-projects of `parentId`, for a change that writes each of them,
 * refused with LIMITS.projectTreeChange's sentence past its max or past
 * TREE_READ's bytes, reading at most one more. */
export async function treeSubProjects(ctx: QueryCtx, parentId: string): Promise<Doc<'projects'>[]> {
  const { max } = LIMITS.projectTreeChange
  const page = await ctx.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', parentId))
    .paginate({ cursor: null, numItems: max + 1, maximumBytesRead: TREE_READ.bytes })
  if (!page.isDone || page.page.length > max) throw rule(LIMITS.projectTreeChange.refusal)
  return page.page
}

/** Gives each of `rows` the copy `fields` of its project, writing only the
 * rows that differ. */
export async function patchRows(
  ctx: MutationCtx,
  rows: readonly Doc<'project_reach'>[],
  fields: Partial<Pick<ReachRow, 'name_key' | 'key' | 'live'>>,
): Promise<void> {
  for (const row of rows)
    if (Object.entries(fields).some(([field, value]) => row[field as keyof ReachRow] !== value))
      await ctx.db.patch(row._id, fields)
}

/** Every reach row of the grantee, for a teardown that deletes them all: a
 * removed profile's (model/cascade.ts ACCESS_RANGES) and a deleted team's
 * (deleteTeamDeep). */
export const reachOfGrantee = (ctx: QueryCtx, g: Grantee) =>
  ctx.db
    .query('project_reach')
    .withIndex('by_grantee_list', (q) =>
      q.eq('grantee_kind', g.grantee_kind).eq('grantee_id', g.grantee_id),
    )

/** Every reach row of an organization, for the teardowns that delete its
 * projects (model/cascade.ts deleteOrgDeep, model/orgDeletion.ts, the
 * public demo's cleanup). */
export const reachOfOrg = (ctx: QueryCtx, orgId: string) =>
  ctx.db.query('project_reach').withIndex('by_org', (q) => q.eq('org_id', orgId))

/** Whether the organization's navigation data is complete: every project
 * holds its archive state and every source its reach rows (nav_at), and
 * every row its name key (name_keys_at), which name-ordered project lists
 * read too. A navigation list refuses while it is not, instead of leaving
 * projects out. */
export async function navReady(ctx: QueryCtx, orgId: string): Promise<boolean> {
  const row = await readyRow(ctx, orgId)
  return row?.nav_at !== undefined && row.name_keys_at !== undefined
}
