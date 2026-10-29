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
 * a change past LIMITS.projectTreeChange.max or TREE_READ.bytes before
 * anything is written.
 * Teardowns delete a grantee's or an organization's rows outright
 * (reachOfGrantee, reachOfOrg).
 *
 * org_ready.nav_at says an organization's rows are complete, and navReady
 * asks it with the name keys stamp, which name-ordered project lists need
 * too; reachReady asks it alone. projectSight judges a project a name
 * search found from these rows, without walking a top-level project's
 * sub-projects (main Search, lib/mainSearch.ts). */

import type { GenericDocument, WithoutSystemFields } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { type Access, inMetaTree, receivesTeamAccess } from '../lib/access'
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

/** A reach row as stored, by its id: a row read, or one a writer just
 * wrote. */
type StoredReach = ReachRow & { _id: Id<'project_reach'> }

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

/** Whether the grantee holds a reach row on live project `project` whose
 * copies are the project's: its organization, kind, top-level project,
 * name key, key and live state. A row that does not, or no row, needs a
 * recompute (syncReach); whether it reaches the whole tree depends on the
 * sources, which this does not read. */
export async function reachFollows(
  ctx: QueryCtx,
  g: Grantee,
  project: ReachProject,
): Promise<boolean> {
  const row = await rowOn(ctx, g, project.id)
  return (
    row !== null &&
    row.org_id === project.org_id &&
    row.kind === (project.parent_id === undefined ? 'root' : 'child') &&
    row.root_id === (project.parent_id ?? project.id) &&
    row.name_key === nameKey(project.name) &&
    row.key === project.key &&
    row.live === (project.archived_at === undefined)
  )
}

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
export type ReachChange = { row: StoredReach | null; want: ReachRow | null }

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
  // A project under a sub-project, which no writer makes now, is outside
  // every tree: only its own row goes. Its parent is no top-level project,
  // so the grantee's row there is the parent's own, which this leaves.
  if (project !== null && root?.parent_id !== undefined)
    return [{ row: own, want: null }].filter(differs)
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

/** Writes the changes planReach found, and answers each row as it is now,
 * null for none, in their order. */
export async function applyReach(
  ctx: MutationCtx,
  changes: readonly ReachChange[],
): Promise<(StoredReach | null)[]> {
  const now: (StoredReach | null)[] = []
  for (const { row, want } of changes) {
    if (want === null) {
      if (row !== null) await ctx.db.delete(row._id)
      now.push(null)
    } else if (row === null)
      now.push({ ...want, _id: await uncountedWriter(ctx.db).insert('project_reach', want) })
    else {
      await ctx.db.patch(row._id, want)
      now.push({ ...want, _id: row._id })
    }
  }
  return now
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

/** Inserts user grant `row` and brings its person's reach rows in line.
 * Only this module inserts into project_access (here and in grantBatch),
 * and only it and the teardowns delete from it, which
 * tests/projectReach.test.ts checks. */
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

/** Inserts team share `row` and brings its team's reach rows in line.
 * Only this module inserts into project_team_access (here and in
 * grantBatch), and only it and the teardowns delete from it, which
 * tests/projectReach.test.ts checks. */
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
 * User grants and team shares given to many people and teams on a few
 * projects in one transaction, with their reach rows written together once
 * they are all in: a removal that keeps many people as Viewers
 * (model/projectAccess.ts removeAndSettle), and the access maps of a new
 * project and a lead handover (model/projects.ts). insertGrant's recompute
 * reads several index ranges a grant, which hundreds of grants in one
 * transaction cannot afford. `finish` reads the rows of each kind of
 * grantee on each project, and on its top-level project, once, keeps them
 * current with what it writes, and runs `guard` before each project's
 * reads, after every BATCH_GUARD_ROWS rows it reads and before it changes a row
 * that exists, which Convex reads first, so a removal can refuse before it
 * passes Convex's limits. Call `finish` after the last grant or share of the
 * transaction. Every grantee is of the project's organization and now holds
 * a source on it. A grantee without a row on the top-level project holds no
 * source there, because one would have written that row, so the row a
 * source on a sub-project adds there is for navigation only, and an
 * existing one keeps its on_root.
 */
export function grantBatch(ctx: MutationCtx) {
  const given = new Map<string, { grantees: Map<string, Grantee> }>()
  const add = (project: Pick<Doc<'projects'>, 'id'>, g: Grantee) => {
    const entry = given.get(project.id) ?? { grantees: new Map<string, Grantee>() }
    entry.grantees.set(`${g.grantee_kind}:${g.grantee_id}`, g)
    given.set(project.id, entry)
  }
  return {
    /** Inserts user grant `row` on `project`, its rows left to `finish`. */
    grant: async (
      project: Pick<Doc<'projects'>, 'id'>,
      row: WithoutSystemFields<Doc<'project_access'>>,
    ): Promise<void> => {
      await ctx.db.insert('project_access', row)
      add(project, grantee.profile(row.profile_id))
    },
    /** Inserts team share `row` on `project`, its rows left to `finish`. */
    share: async (
      project: Pick<Doc<'projects'>, 'id'>,
      row: WithoutSystemFields<Doc<'project_team_access'>>,
    ): Promise<void> => {
      await ctx.db.insert('project_team_access', row)
      add(project, grantee.team(row.team_id))
    },
    /** Writes the reach rows of every grant and share given. */
    finish: async (guard: () => Promise<void> = async () => {}): Promise<void> => {
      // each project's rows of each grantee kind, by grantee id, read once
      const known = new Map<string, Map<string, StoredReach>>()
      const rowsOn = async (projectId: string, kind: GranteeKind) => {
        const key = `${projectId}:${kind}`
        const cached = known.get(key)
        if (cached !== undefined) return cached
        const rows = new Map<string, StoredReach>()
        const range = ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) =>
            q.eq('project_id', projectId).eq('grantee_kind', kind),
          )
        for await (const row of range) {
          if (rows.size > 0 && rows.size % BATCH_GUARD_ROWS === 0) await guard()
          rows.set(row.grantee_id, row)
        }
        known.set(key, rows)
        return rows
      }
      for (const [id, { grantees }] of given) {
        await guard()
        // as it is now, which a rename in the same transaction may have changed
        const project = await byId(ctx, 'projects', id)
        if (project === null) continue
        const root =
          project.parent_id === undefined ? project : await byId(ctx, 'projects', project.parent_id)
        if (root === null || root.org_id !== project.org_id || !inMetaTree(project, root)) continue
        for (const g of grantees.values()) {
          const own = await rowsOn(project.id, g.grantee_kind)
          const top = project.id === root.id ? own : await rowsOn(root.id, g.grantee_kind)
          const changes: ReachChange[] = []
          const above = top.get(g.grantee_id) ?? null
          if (project.id === root.id)
            changes.push({ row: above, want: rowFor(g, 'root', root, root, true) })
          else
            changes.push(
              {
                row: own.get(g.grantee_id) ?? null,
                want: rowFor(g, 'child', project, root, false),
              },
              { row: above, want: rowFor(g, 'root', root, root, above?.on_root ?? false) },
            )
          const writes = changes.filter(differs)
          // an insert reads nothing; Convex reads a row it patches or deletes
          if (writes.some(({ row }) => row !== null)) await guard()
          const now = await applyReach(ctx, writes)
          for (const [i, { want }] of writes.entries()) {
            const map = want?.kind === 'child' ? own : top
            const row = now[i]
            if (row !== null) map.set(g.grantee_id, row)
          }
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

/** The bytes of sub-projects and reach rows the tree changes of one
 * mutation may read, as Convex counts a document's size (TreeBudget).
 * Convex reads a document again to patch it, and an archive or a restore
 * patches nearly every row it read, so the change reads up to twice this
 * and one row more, beside the project, its parent and the rest of the
 * mutation: about 14 MiB, under Convex's 16 MiB read limit (measured in
 * tests/projectReach.test.ts, "a tree at the row bounds"). Rows near their
 * bounds (lib/limits.ts PROJECT_ROW_MAX_BYTES, about 4.9 KB a sub-project
 * at the name and description caps and about 3 KB a reach row) reach it
 * before LIMITS.projectTreeChange.max, once 2,000 entries average more
 * than about 3.7 KB. A rename or a key change alone reads at most 2,001
 * reach rows, about 5.9 MB at the name cap, so only one that a REST or MCP
 * update makes after an archive or a restore, which share one budget, can
 * reach it. Such an update also reads every project of the organization
 * (lib/core.ts loadCatalogue), which nothing bounds yet, so near this bound
 * at the row bounds it can pass Convex's read limit there. A mutable
 * object, so tests can lower it. */
export const TREE_READ = { bytes: 7 * MIB }

/** The index ranges a mutation's tree changes may spend on their queries,
 * besides LIMITS.projectTreeChange.max for what they write: at most four
 * for one change (its sub-projects, the rows of the project, of its parent
 * and of the sub-projects under it), and two changes, an archive or a
 * restore and a rename, in one REST or MCP update. */
const TREE_QUERIES = 8

/** The refusal of a tree change whose sub-projects and reach rows pass
 * TREE_READ.bytes. Archiving or restoring some sub-projects on their own
 * first does not help, as the change reads every sub-project all the same,
 * so it names what does. */
export const TREE_TOO_LARGE =
  "this project's sub-projects and access entries hold more data than one change can read, so it cannot be archived or restored at once. Delete some of its sub-projects or remove some access first."

/**
 * What the tree changes of one mutation may still spend: `entries`, the
 * sub-projects they write and the reach rows they read, each of which a
 * write may change and Convex reads by id first, within
 * LIMITS.projectTreeChange.max, which keeps them to about half of the
 * 4,096 index ranges one transaction may read, as model/labels.ts
 * LABEL_REMOVAL measured; `bytes`, what those rows hold, within
 * TREE_READ.bytes; and `queries`, the ranges their reads take.
 * A rename, a key change, an archive and a restore each take one unless the
 * caller passes the one it shares, as a REST or MCP update that archives or
 * restores a project and changes its fields does.
 */
export type TreeBudget = { entries: number; queries: number; bytes: number }

/** A fresh budget for a mutation's tree changes. */
export const treeBudget = (): TreeBudget => ({
  entries: LIMITS.projectTreeChange.max,
  queries: TREE_QUERIES,
  bytes: TREE_READ.bytes,
})

/* Spends one query of `budget`; a change that needs more is a bug, not the
 * size of a tree. */
function query(budget: TreeBudget): void {
  budget.queries -= 1
  if (budget.queries < 0) throw new Error('a tree change read more ranges than TREE_QUERIES')
}

/* The rows of `rows`, one query of `budget`, each spent from it as it is
 * read: an entry, refused with LIMITS.projectTreeChange's sentence past
 * them, and its bytes, refused with TREE_TOO_LARGE past them. So a read
 * stops at the first row past either, and as every caller reads before it
 * writes, a refusal leaves everything as it was. */
async function spent<D extends GenericDocument>(
  budget: TreeBudget,
  rows: AsyncIterable<D>,
  size: (row: D) => number = getDocumentSize,
): Promise<D[]> {
  query(budget)
  const out: D[] = []
  for await (const row of rows) {
    budget.entries -= 1
    if (budget.entries < 0) throw rule(LIMITS.projectTreeChange.refusal)
    budget.bytes -= size(row)
    if (budget.bytes < 0) throw rule(TREE_TOO_LARGE)
    out.push(row)
  }
  return out
}

/**
 * The reach rows of `projectIds` in organization `orgId`, every grantee's,
 * for a change that updates their copies of the projects (a rename, a key
 * change, an archive or a restore), each read row spent from `budget`
 * (spent). Call it before the change writes anything, so a refusal leaves
 * everything as it was. A row another organization left on a reused
 * project id until its teardown deletes it counts but is not returned, so
 * the change never writes it.
 */
export async function treeRows(
  ctx: QueryCtx,
  orgId: string,
  projectIds: readonly string[],
  budget: TreeBudget,
): Promise<Doc<'project_reach'>[]> {
  const rows: Doc<'project_reach'>[] = []
  for (const id of new Set(projectIds)) {
    const got = await spent(
      budget,
      ctx.db.query('project_reach').withIndex('by_project_grantee', (q) => q.eq('project_id', id)),
    )
    rows.push(...got.filter((row) => row.org_id === orgId))
  }
  return rows
}

/** The child rows under top-level project `rootId` whose `live` copy is
 * `live`, every grantee's, in one range, spent from `budget` as treeRows
 * spends. An archive of the project reads the live ones, which are those
 * of the sub-projects it archives, and a restore the archived ones, among
 * them those of the sub-projects it restores. */
export async function childRows(
  ctx: QueryCtx,
  orgId: string,
  rootId: string,
  live: boolean,
  budget: TreeBudget,
): Promise<Doc<'project_reach'>[]> {
  const got = await spent(
    budget,
    ctx.db
      .query('project_reach')
      .withIndex('by_root_child', (q) =>
        q.eq('root_id', rootId).eq('kind', 'child').eq('live', live),
      ),
  )
  return got.filter((row) => row.org_id === orgId)
}

/* An archive stamp, as long as every stamp new Date().toISOString() writes. */
const STAMP = new Date(0).toISOString()

/* The size of sub-project `p` once archived, with a stamp and the longest
 * archive state, the most it holds in either state. An archive adds the
 * stamp to every sub-project it carries, so counting it here lets the
 * restore of a tree an archive took take it too, unless its rows grew in
 * between. */
const archivedSize = (p: Doc<'projects'>) =>
  getDocumentSize({ ...p, archived_at: p.archived_at ?? STAMP, archive_state: 'listed' })

/** The sub-projects of `parentId`, for a change that writes each of them,
 * each spent from `budget` as treeRows spends, at its size once archived. */
export async function treeSubProjects(
  ctx: QueryCtx,
  parentId: string,
  budget: TreeBudget,
): Promise<Doc<'projects'>[]> {
  return await spent(
    budget,
    ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', parentId)),
    archivedSize,
  )
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

/** Whether every project of the organization holds its archive state and
 * every source its reach rows (nav_at), without the name keys navReady also
 * asks for. A search of project names (projects search_name, which filters
 * by archive_state) and projectSight need only these. */
export async function reachReady(ctx: QueryCtx, orgId: string): Promise<boolean> {
  return (await readyRow(ctx, orgId))?.nav_at !== undefined
}

/** The bounds of projectSight's reads of the person's rows: at most `teams`
 * of their teams are read, and at most `roots` live root rows of their seat
 * and those teams, to leave out the projects none of them reaches (past
 * either, each project is checked by itself, with the seat's own child rows
 * alone), and at most `children` child rows of one grantee under one
 * top-level project. A child row fails to show its parent only while a
 * Deleted items move or restore holds its project, after a reused id, or
 * for a lead the person's role turns into nothing, so a few suffice. Tests
 * lower them. */
export const PROJECT_SIGHT = { teams: 64, roots: 512, children: 4 }

/** What projectSight reads through: `need` throws unless `ranges` more
 * index ranges and `documents` more documents of any size fit, and
 * `recount` follows reads it was not asked about, those of an access check.
 * lib/mainSearch.ts readBudget is one. */
export type SightBudget = {
  need(ranges: number, documents: number): Promise<void>
  recount(): void
}

/* What projectSight learns of the person's rows: their grantees, and
 * whether those are all of them (`all`). */
type Grantees = { grantees: Grantee[]; all: boolean }

/* The grantees that hold a live root row on one top-level project, and
 * whether one of those rows records a source on the project itself. */
type Held = { grantees: Grantee[]; onRoot: boolean }

/**
 * Whether seat `me`, who sees through `access`, sees project `p`, a live
 * project a search of names read in this transaction, under the rule of
 * lib/access.ts canSeeProject, without the walk of a top-level project's
 * sub-projects that the rule's navigation reads whole (projectLevelsOf
 * navigates). Main Search's seats searched whole ask it (lib/mainSearch.ts),
 * and so can the directory's name search. Each project is judged once.
 *
 * A sub-project shows when the person sees it (access.visible), which never
 * walks navigation. A top-level project must be a meta, and shows when the
 * person sees it for a reason of its own (access.accessible), or, for
 * navigation, when one of the first PROJECT_SIGHT.children child rows of
 * one of their grantees under it (project_reach by_grantee_root, live or
 * archived, as navigation counts archived sub-projects) names a sub-project
 * of it in their organization that they see. The grantees are their seat
 * and, when their role receives team access, each of their teams
 * (team_members by_profile) that holds a root row on the project. A reach
 * row records a source and grants nothing, so its project decides: a
 * viewer's lead counts for nothing there, and a row a Deleted items move or
 * restore left on a project it no longer describes, or one naming another
 * top-level project's sub-project, fails. When every row in the bound
 * fails, the project stays out though the person may see it, which misses
 * a match and never shows one.
 *
 * For a person who is not an organization admin, it first reads once the
 * live root rows of all their grantees (project_reach by_grantee_list), up
 * to PROJECT_SIGHT.roots. Once the organization's reach rows are complete
 * (org_ready nav_at, reachReady, which the caller asks first), every
 * top-level project such a person sees holds a root row of one of their
 * grantees, for a source on it (on_root) or for navigation, and so does the
 * one above every sub-project they see. A project without one is left out
 * with no read, so a hidden candidate costs no grant or share read, and a
 * top-level project with navigation rows only is not asked about its own
 * grants and shares. Past PROJECT_SIGHT.teams teams or PROJECT_SIGHT.roots
 * root rows, each project is checked by itself, and only the seat's own
 * child rows show a top-level project for navigation, one range a
 * candidate: a top-level project the person sees only for navigation
 * through a team's share on one of its sub-projects then stays out, a
 * missed match. An organization admin sees every project of a meta's tree
 * (lib/access.ts levelUnder), which no reach row records, so their
 * candidates skip the root rows and are checked the same way; the admin
 * access split changes that rule in lib/access.ts.
 *
 * Every read goes through `budget`, which throws to stop the caller: each
 * project above a sub-project, each reach row and each sub-project a row
 * names, and after each access check its own reads (`recount`), which for a
 * project shared with many teams can be many rows (projectLevelsOf). A read
 * that throws fails every later answer that awaits it (the grantees, the
 * root rows, a project asked again), so a caller stops at the first throw.
 */
export function projectSight(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  access: Access,
  budget: SightBudget,
): (p: Doc<'projects'>) => Promise<boolean> {
  let grantees: Promise<Grantees> | undefined
  const granteesOf = () => {
    grantees ??= (async (): Promise<Grantees> => {
      const seat = grantee.profile(me.id)
      if (!receivesTeamAccess(me)) return { grantees: [seat], all: true }
      await budget.need(1, 1)
      const teams: Grantee[] = []
      const rows = ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
      for await (const row of rows) {
        if (teams.length === PROJECT_SIGHT.teams) return { grantees: [seat], all: false }
        teams.push(grantee.team(row.team_id))
        await budget.need(0, 1)
      }
      return { grantees: [seat, ...teams], all: true }
    })()
    return grantees
  }
  let roots: Promise<Map<string, Held> | null> | undefined
  const rootsOf = () => {
    roots ??= (async () => {
      const who = await granteesOf()
      if (!who.all) return null
      const held = new Map<string, Held>()
      let read = 0
      for (const g of who.grantees) {
        await budget.need(1, 1)
        const rows = ctx.db
          .query('project_reach')
          .withIndex('by_grantee_list', (q) =>
            q
              .eq('grantee_kind', g.grantee_kind)
              .eq('grantee_id', g.grantee_id)
              .eq('kind', 'root')
              .eq('live', true),
          )
        for await (const row of rows) {
          if (++read > PROJECT_SIGHT.roots) return null
          if (row.org_id === me.org_id) {
            const known = held.get(row.project_id) ?? { grantees: [], onRoot: false }
            known.grantees.push(g)
            known.onRoot ||= row.on_root
            held.set(row.project_id, known)
          }
          await budget.need(0, 1)
        }
      }
      return held
    })()
    return roots
  }
  /* Whether one of `who` holds a child row under top-level project `p`,
   * among its first few, whose sub-project the person sees. */
  const navigates = async (p: Doc<'projects'>, who: readonly Grantee[]) => {
    for (const g of who) {
      await budget.need(1, 1)
      const rows = ctx.db
        .query('project_reach')
        .withIndex('by_grantee_root', (q) =>
          q
            .eq('grantee_kind', g.grantee_kind)
            .eq('grantee_id', g.grantee_id)
            .eq('root_id', p.id)
            .eq('kind', 'child'),
        )
      let read = 0
      for await (const row of rows) {
        // the row's sub-project, and the access rows its check reads
        await budget.need(1, 1)
        const sub = await access.project(row.project_id)
        // parent_id never changes, so a row whose project is not a
        // sub-project of p says nothing of p
        if (sub !== null && sub.org_id === me.org_id && sub.parent_id === p.id) {
          const sees = await access.visible(sub.id)
          budget.recount()
          if (sees) return true
        }
        if (++read === PROJECT_SIGHT.children) break
        await budget.need(0, 1)
      }
    }
    return false
  }
  const judge = async (p: Doc<'projects'>): Promise<boolean> => {
    if (p.org_id !== me.org_id || p.archived_at !== undefined) return false
    access.seen(p)
    const held = me.org_role === 'admin' ? null : await rootsOf()
    const reached = held?.get(p.parent_id ?? p.id)
    if (held !== null && reached === undefined) return false
    if (p.parent_id !== undefined) {
      // the top-level project above it, and the access rows its check reads
      await budget.need(1, 1)
      const sees = await access.visible(p.id)
      budget.recount()
      return sees
    }
    if (!inMetaTree(p, p)) return false
    if (reached === undefined || reached.onRoot) {
      // the access rows its check reads
      await budget.need(1, 1)
      const sees = await access.accessible(p.id)
      budget.recount()
      if (sees) return true
    }
    // without root rows, the seat's own rows alone, one range
    return await navigates(p, reached?.grantees ?? [grantee.profile(me.id)])
  }
  const asked = new Map<string, Promise<boolean>>()
  return (p) => {
    let known = asked.get(p.id)
    if (known === undefined) {
      known = judge(p)
      asked.set(p.id, known)
    }
    return known
  }
}
