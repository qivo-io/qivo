/* Check and repair, dry run first, of what a rollback past the favorites
 * release leaves in project_favorites (schema.ts; docs/deployment.md, the
 * favorites paragraph). A release before that one knows no favorites, so
 * while it serves, a rename, an archive or a restore leaves a row's copies
 * stale, and a profile removal, a Deleted items purge or an organization's
 * deletion leaves the rows of what it deleted. The readers skip such rows
 * (model/projectFavorites.ts favoriteShows), so a person sees nothing
 * wrong, but a seat later created with a removed seat's id, or a project
 * that takes a purged id back, would list them.
 *
 * Each row falls into the first of these classes that fits, in this order:
 *   org_gone          no organizations row for its org_id. Deleted.
 *   org_deleting      its organization's deletion began; the teardown's
 *                     last phase drains it. Left.
 *   profile_removing  its seat's removal is under way (profile_removals),
 *                     whose access phase drains it. Left.
 *   profile_gone      no profiles row for its profile_id, or one of another
 *                     organization. Deleted.
 *   profile_newer     a profile created after the row, an earlier seat's
 *                     row on an id taken again. Deleted.
 *   project_gone      no projects row and no Deleted items copy of its
 *                     project. Deleted.
 *   project_elsewhere a projects row, or a Deleted items copy, of another
 *                     organization, an id taken again. Deleted.
 *   in_deleted_items  its project is in its organization's Deleted items;
 *                     the row shows again on a restore and goes with a
 *                     purge. Left.
 *   not_top_level     its project heads no meta tree, as a sub-project,
 *                     which no writer stars. Reported only.
 *   duplicate         an earlier row of the seat on the project stays, so
 *                     this one goes, as setFavoriteCore keeps one. Deleted.
 *   stale_copies      its name_key or live is not its project's
 *                     (copiesOf). Patched, its created_at kept.
 *   ok                left as it is.
 * A row whose seat lost access to its project is ok here: the readers skip
 * it, and it shows again when the access returns. Every writer of this
 * release stamps a row no earlier than its seat (model/projectFavorites.ts):
 * a star, also one that resets a row an earlier seat left, writes the
 * star's time, and the Northstar seed the later of its own time and the
 * seat's. So only the earlier code leaves a row its seat's created_at
 * follows, which is what profile_newer deletes. A Northstar reset under
 * the earlier code that wrote projects with the same ids leaves rows this
 * check cannot tell from real ones.
 *
 * `check` is a query, so a dry run cannot write, and a key that may only
 * run internal queries can run it. `repair` writes what `check` would
 * report. Each reads one page of rows in creation order and answers the
 * counts of every class, up to EXAMPLES.most row ids of each class it
 * would change or reports, the cursor, whether it is done, and what the
 * page read. About seven document reads a row (the organization and its
 * removal, the seat's removal and profile, the project or its Deleted items
 * copy, the seat's rows on the project), fewer where a page reads the same
 * organization, seat or project again, so a page of 200 stays well inside
 * one transaction's limits. `run` walks the pages from `cursor`, sums them
 * and stops after RUN.ms with the cursor to go on from; a page that fails
 * ends the call with its counts so far, the error in `failed` and that
 * page's cursor. It is a stepped job and finishes at any size; it is not
 * timed.
 *
 * Run it after rolling forward past a rollback before the favorites
 * release (v0.1.106), each hosted run with the owner's approval, the dry
 * run first, and on production a repair only after a verified backup:
 *   ~/projects/qivo-internal/scripts/with-deployment staging npx convex run internal/favoritesRepair:run '{"dry_run": true}'
 *   ~/projects/qivo-internal/scripts/with-deployment staging npx convex run internal/favoritesRepair:run '{"dry_run": false}'
 * Pass `"cursor"` from an answer to go on where it stopped. On the demo,
 * whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs it with a short-lived key, a key
 * permission change that needs the owner's approval:
 *   ~/projects/qivo-internal/scripts/with-temp-deploy-key demo --allow deployment:functions:runInternalActions,deployment:functions:runInternalMutations -- npx convex run internal/favoritesRepair:run '{"dry_run": true}'
 */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { inMetaTree } from '../lib/access'
import { deletionBegun } from '../lib/billingAccess'
import { copiesOf, favoriteOf } from '../model/projectFavorites'

/** Rows a page reads by default; `page_size` lowers it in tests. */
export const PAGE = { size: 200 }
/** The most example row ids an answer gives of one class; tests lower it. */
export const EXAMPLES = { most: 20 }
/** How long `run` walks pages before it answers a cursor; tests lower it. */
export const RUN = { ms: 5 * 60_000 }

/** The classes, in the order a row is judged. */
export const CLASSES = [
  'org_gone',
  'org_deleting',
  'profile_removing',
  'profile_gone',
  'profile_newer',
  'project_gone',
  'project_elsewhere',
  'in_deleted_items',
  'not_top_level',
  'duplicate',
  'stale_copies',
  'ok',
] as const
export type FavoriteClass = (typeof CLASSES)[number]

/** The classes a repair deletes. */
const DELETES: ReadonlySet<FavoriteClass> = new Set([
  'org_gone',
  'profile_gone',
  'profile_newer',
  'project_gone',
  'project_elsewhere',
  'duplicate',
])
/** The classes an answer gives examples of: those a repair changes, and
    the row it only reports. */
const EXAMPLED: ReadonlySet<FavoriteClass> = new Set([...DELETES, 'stale_copies', 'not_top_level'])

type Counts = Record<FavoriteClass, number>
type Examples = Partial<Record<FavoriteClass, string[]>>
/** What one page read: documents, index ranges and bytes, as Convex counts
    them against one transaction's limits. */
type Reads = { documents: number; ranges: number; bytes: number }

/** One page's answer. */
export type RepairPage = {
  counts: Counts
  examples: Examples
  cursor: string
  done: boolean
  reads: Reads
}

/** Adds row `id` to the examples of `cls`, up to EXAMPLES.most. */
function addExample(examples: Examples, cls: FavoriteClass, id: string) {
  const list = examples[cls] ?? []
  if (list.length < EXAMPLES.most) list.push(id)
  examples[cls] = list
}

const noCounts = (): Counts => Object.fromEntries(CLASSES.map((c) => [c, 0])) as Counts

/* The reads one page shares, each answered once a page. */
function pageReads(ctx: QueryCtx) {
  const once = <T>(read: (key: string) => Promise<T>) => {
    const held = new Map<string, Promise<T>>()
    return (key: string) => {
      let found = held.get(key)
      if (found === undefined) {
        found = read(key)
        held.set(key, found)
      }
      return found
    }
  }
  return {
    /** Whether the organization exists, and whether its deletion began. */
    org: once(async (id) => {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      return { exists: org !== null, deleting: org !== null && (await deletionBegun(ctx, id)) }
    }),
    /** Whether the seat's removal is under way. */
    removing: once(
      async (id) =>
        (await ctx.db
          .query('profile_removals')
          .withIndex('by_profile', (q) => q.eq('profile_id', id))
          .first()) !== null,
    ),
    profile: once((id) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    ),
    project: once((id) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    ),
    /** The organizations whose Deleted items keep a copy of the project. */
    stored: once(async (id) =>
      (
        await ctx.db
          .query('deleted_rows')
          .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', id))
          .take(4)
      ).map((row) => row.org_id),
    ),
  }
}
type PageReads = ReturnType<typeof pageReads>

/** The class of `row` before the duplicate check, with its project where
    it has one of the row's organization. */
async function baseClassOf(
  reads: PageReads,
  row: Doc<'project_favorites'>,
): Promise<{ cls: FavoriteClass; project: Doc<'projects'> | null }> {
  const none = (cls: FavoriteClass) => ({ cls, project: null })
  const org = await reads.org(row.org_id)
  if (!org.exists) return none('org_gone')
  if (org.deleting) return none('org_deleting')
  if (await reads.removing(row.profile_id)) return none('profile_removing')
  const profile = await reads.profile(row.profile_id)
  if (profile === null || profile.org_id !== row.org_id) return none('profile_gone')
  // strictly later, as the public demo writes a seat and its rows at one time
  if (profile.created_at > row.created_at) return none('profile_newer')
  const project = await reads.project(row.project_id)
  if (project === null) {
    const stored = await reads.stored(row.project_id)
    if (stored.length === 0) return none('project_gone')
    return none(stored.includes(row.org_id) ? 'in_deleted_items' : 'project_elsewhere')
  }
  if (project.org_id !== row.org_id) return none('project_elsewhere')
  if (!inMetaTree(project, project)) return none('not_top_level')
  const copies = copiesOf(project)
  const stale = row.name_key !== copies.name_key || row.live !== copies.live
  return { cls: stale ? 'stale_copies' : 'ok', project }
}

/** The class of `row`, and the project whose copies a stale row takes. A
    row is a duplicate where an earlier row of its seat on its project
    stays, one no class deletes. */
async function classOf(ctx: QueryCtx, reads: PageReads, row: Doc<'project_favorites'>) {
  const base = await baseClassOf(reads, row)
  if (base.cls !== 'ok' && base.cls !== 'stale_copies') return base
  for await (const sibling of favoriteOf(ctx, row.profile_id, row.project_id)) {
    if (sibling._id === row._id) break
    if (!DELETES.has((await baseClassOf(reads, sibling)).cls))
      return { cls: 'duplicate' as const, project: null }
  }
  return base
}

/** One page of rows from `cursor`, classed and, with `writer`, repaired. */
async function pageOf(
  ctx: QueryCtx,
  cursor: string | null,
  size: number,
  writer: MutationCtx | null,
): Promise<RepairPage> {
  if (!Number.isInteger(size) || size < 1)
    throw new Error('page_size must be a whole number of at least 1')
  const before = await ctx.meta.getTransactionMetrics()
  const result = await ctx.db
    .query('project_favorites')
    .order('asc')
    .paginate({ cursor, numItems: size })
  const reads = pageReads(ctx)
  const counts = noCounts()
  const examples: Examples = {}
  for (const row of result.page) {
    const { cls, project } = await classOf(ctx, reads, row)
    counts[cls] += 1
    if (EXAMPLED.has(cls)) addExample(examples, cls, row._id)
    if (writer === null) continue
    if (DELETES.has(cls)) await writer.db.delete(row._id)
    else if (cls === 'stale_copies' && project !== null)
      await writer.db.patch(row._id, copiesOf(project))
  }
  const after = await ctx.meta.getTransactionMetrics()
  return {
    counts,
    examples,
    cursor: result.continueCursor,
    done: result.isDone,
    reads: {
      documents: after.documentsRead.used - before.documentsRead.used,
      ranges: after.databaseQueries.used - before.databaseQueries.used,
      bytes: after.bytesRead.used - before.bytesRead.used,
    },
  }
}

const vPage = {
  cursor: v.optional(v.union(v.string(), v.null())),
  page_size: v.optional(v.number()),
}

/** Reports, without writing, one page of rows from `cursor` (none for the
 * first): each class's count and examples, the cursor of the next page and
 * whether this one was the last. */
export const check = internalQuery({
  args: vPage,
  handler: (ctx, a): Promise<RepairPage> =>
    pageOf(ctx, a.cursor ?? null, a.page_size ?? PAGE.size, null),
})

/** Repairs one page of rows from `cursor`, as `check` reports it: deletes
 * the rows of the classes it deletes and patches stale copies. */
export const repair = internalMutation({
  args: vPage,
  handler: (ctx, a): Promise<RepairPage> =>
    pageOf(ctx, a.cursor ?? null, a.page_size ?? PAGE.size, ctx),
})

type PageArgs = { cursor?: string | null; page_size?: number }
const checkRef = makeFunctionReference<'query', PageArgs, RepairPage>(
  'internal/favoritesRepair:check',
)
const repairRef = makeFunctionReference<'mutation', PageArgs, RepairPage>(
  'internal/favoritesRepair:repair',
)

/** Walks the pages from `cursor`, or from the first, with `check` for a dry
 * run and `repair` otherwise, and answers the summed counts, up to
 * EXAMPLES.most example ids of each class, the most one page read, and the
 * cursor to go on from, null once every row was read. Past RUN.ms it stops
 * after a page, one at least. A page that throws ends the call with what it
 * counted before, the error in `failed` and that page's cursor. */
export const run = internalAction({
  args: { dry_run: v.boolean(), ...vPage },
  handler: async (ctx, a) => {
    const until = Date.now() + RUN.ms
    const counts = noCounts()
    const examples: Examples = {}
    const most: Reads = { documents: 0, ranges: 0, bytes: 0 }
    let pages = 0
    let cursor: string | null = a.cursor ?? null
    const answer = (done: boolean, failed: string | null = null) => ({
      dry_run: a.dry_run,
      pages,
      counts,
      examples,
      most_read_by_a_page: most,
      cursor: done ? null : cursor,
      failed,
    })
    for (;;) {
      let page: RepairPage
      try {
        const args = { cursor, page_size: a.page_size }
        page = a.dry_run
          ? await ctx.runQuery(checkRef, args)
          : await ctx.runMutation(repairRef, args)
      } catch (e) {
        return answer(false, e instanceof Error ? e.message : String(e))
      }
      pages += 1
      for (const cls of CLASSES) counts[cls] += page.counts[cls]
      for (const [cls, ids] of Object.entries(page.examples) as [FavoriteClass, string[]][]) {
        for (const id of ids) addExample(examples, cls, id)
      }
      for (const key of ['documents', 'ranges', 'bytes'] as const)
        most[key] = Math.max(most[key], page.reads[key])
      cursor = page.cursor
      if (page.done) return answer(true)
      if (Date.now() >= until) return answer(false)
    }
  },
})
