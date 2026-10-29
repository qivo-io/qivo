/* One-time migration that gives every project stored before archive states
 * existed its `archive_state`, and every lead, user grant and team share
 * its project_reach rows (schema.ts, model/projectNav.ts), then stamps every
 * organization in org_ready (`nav_at`). Navigation lists read those rows
 * and refuse an organization without the stamp (model/projectNav.ts
 * navReady), because a missing row leaves a project out of a person's list.
 * New projects, grants and shares get theirs from their writers, and an
 * organization created since this release is stamped at its creation
 * (model/orgs.ts insertOrgRows).
 *
 * A run walks four tables in turn, each in creation order: the projects,
 * whose archive state it derives from their archive time and their parent's
 * and whose lead's rows it brings in line, the user grants and the team
 * shares, whose grantee's rows it brings in line, and last the reach rows
 * themselves, each checked against the sources it stands for, so a row
 * without one goes and a stale copy of a project's name key, key or state is
 * corrected. Each recompute is model/projectNav.ts planReach, the one the
 * writers use, in its own step's transaction, so a write meanwhile cannot
 * leave a row wrong once the walk has passed it. A project a restore from
 * Deleted items has written access back for, which stays absent until its
 * reveal, counts as present with its stored copy, as the restore reads it
 * (present), so the walk keeps the rows that restore wrote; a restore also
 * brings every grant's rows in line again after its reveal
 * (model/deletedItems.ts restoreGrants). A step goes on from the creation
 * time of the last row it finished, with the ids it finished at that time,
 * so a row sharing that time is neither skipped nor walked twice. A step
 * counts the index ranges and bytes of everything it reads, the projects and
 * teams a recompute reads included, and of every row it patches or deletes,
 * which Convex reads again, and ends when it has spent NAV_STEP, after one
 * row at least, so a step over rows stored before the caps, which can be
 * large, stays inside Convex's limits and every step makes progress. Once every table is walked, a run
 * stamps every organization without `nav_at`, in id order. Deleted items
 * keep no reach rows and a restore writes them from the grants it writes
 * back (model/deletedItems.ts restoreAccess), so this walks no deleted_rows;
 * a reveal computes a restored project's archive state (revealProjects).
 *
 * The walk also finds every kind of drift a release before this one leaves
 * if a deployment is rolled back to it and forward again: projects,
 * grants, shares, leads and renames it wrote without rows, rows of what it
 * deleted, moved to Deleted items or archived, and its organizations
 * without a stamp. After such a rollback, read the dry run again and run
 * it if it finds anything; until then navigation lists can be stale.
 *
 * Read the dry run first. It writes nothing and reports archive states
 * missing or stale, and reach rows missing, extra (no source stands for
 * them) or stale, the organizations with any (`to_fix`) and those without a
 * stamp (`unstamped`). It counts a missing row once for each source that
 * needs it, so its counts can exceed what a run writes, and zero means
 * nothing to fix. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/navBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/navBackfill:run '{"dry_run": false}'
 * A call checks its time before every step and every stamp, stops after
 * RUN.ms, well inside Convex's action time limit, and then answers
 * `done: false` with a `cursor`, an object naming the table and the place
 * in it, or the last organization the stamping passed. Call it again with
 * the same arguments and `"cursor"` set to that object until `done` is
 * true. A step that throws, such as one past a transaction limit, stops the
 * call with `error` and the cursor of that step, so a call with that cursor
 * tries the step again. A dry run's cursor does not resume a run that
 * writes. `check` walks one step of one table without writing, for a key
 * that may only run internal queries:
 *   "$H" staging npx convex run internal/navBackfill:check '{"table": "projects", "at": null}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions, and `check`
 * deployment:functions:runInternalQueries.
 *
 * A call that wrote adds one platform_audit_log row (action 'nav_backfill',
 * actor 'system') with its totals, whether it finished, its cursor and its
 * error, also when a step threw. Running it again is safe, and a finished
 * deployment's dry run reports zeros. It writes no activity, sends no task
 * event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { meterDb } from '../model/deletedItems'
import { estimateDocumentBytes } from '../model/demoMetrics'
import { readyRow } from '../model/nameKeys'
import {
  applyReach,
  archiveStateOf,
  type Grantee,
  grantee,
  type ProjectRead,
  planReach,
  type ReachChange,
  type ReachProject,
} from '../model/projectNav'

/** What one step may spend before it ends: rows walked, index ranges read
 * or written, and bytes read, and the most organizations a run lists.
 * Convex reads a document again to patch or delete it, so those writes
 * count as a range and the document's bytes too. One row's work reads about
 * ten ranges and at most five documents of any size: the row itself, a
 * project, its top-level project, a team and the project its archive state
 * patches, each up to Convex's 1 MiB for a row stored before the caps (a
 * project or team within them is at most lib/limits.ts
 * PROJECT_ROW_MAX_BYTES). A step checks these bounds before
 * each row, so the one it starts past them leaves room for that work: at
 * most 8 MiB and 5 MiB more, inside Convex's 4,096 ranges and 16 MiB.
 * Tests lower them. */
export const NAV_STEP = { rows: 200, ranges: 2000, bytes: 8 * MIB, listed: 100 }

/** Organizations one page of a run's stamping reads, and how long one call
 * of run goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** The tables a run walks, in order. */
const TABLES = ['projects', 'project_access', 'project_team_access', 'project_reach'] as const
type Walked = (typeof TABLES)[number]
const vWalked = v.union(...TABLES.map((table) => v.literal(table)))

/** Where a walk of one table goes on: the creation time of the last row it
 * finished, and the ids of the rows it finished at that time. */
type At = { after: number; seen: string[] }
const vAt = v.union(v.null(), v.object({ after: v.number(), seen: v.array(v.string()) }))

/** Archive states without a value or with the wrong one, and reach rows
 * missing, without a source or holding a stale copy. */
type Counts = {
  archive_state: { missing: number; stale: number }
  reach: { missing: number; extra: number; stale: number }
}
const noCounts = (): Counts => ({
  archive_state: { missing: 0, stale: 0 },
  reach: { missing: 0, extra: 0, stale: 0 },
})

/** What one step found, the organizations it found it in, where the next
 * step starts and whether the table is done. */
type StepResult = { counts: Counts; orgs: string[]; at: At | null; done: boolean }

/* Project `id` as a recompute takes it: the live project, else the stored
 * copy of a project whose item is restoring. A restore writes a project's
 * grants back, with their reach rows, before its reveal writes the project
 * (model/deletedItems.ts restoreAccess, restoreRead); a walk that took the
 * project as gone meanwhile would delete those rows, and the reveal would
 * show the project without them. */
async function present(ctx: QueryCtx, id: string): Promise<ReachProject | null> {
  const live = await byId(ctx, 'projects', id)
  if (live !== null) return live
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', id))
    .first()
  if (stored === null || stored.row.table !== 'projects') return null
  const item = await byId(ctx, 'deleted_items', stored.item_id)
  return item?.state === 'restoring' ? stored.row.doc : null
}

/* Walks one step of `table` from `at`: counts what is missing or wrong and,
 * unless `write` is null, writes it right. The check and the step share
 * it, so both find the same rows. */
async function walk(
  ctx: QueryCtx,
  table: Walked,
  at: At | null,
  write: MutationCtx | null,
): Promise<StepResult> {
  const spent = { ranges: 0, bytes: 0 }
  const db = meterDb(ctx, {
    range: () => {
      spent.ranges += 1
    },
    doc: (doc) => {
      spent.bytes += estimateDocumentBytes(doc)
    },
  })
  // the projects the step read, each once; a step changes none of the
  // fields a recompute reads
  const projects = new Map<string, Promise<ReachProject | null>>()
  const read: ProjectRead = (id) => {
    let project = projects.get(id)
    if (project === undefined) {
      project = present(db, id)
      projects.set(id, project)
    }
    return project
  }
  const counts = noCounts()
  const orgs = new Set<string>()
  const reach = async (g: Grantee, projectId: string) => {
    const changes: ReachChange[] = await planReach(db, g, projectId, read)
    for (const { row, want } of changes) {
      counts.reach[row === null ? 'missing' : want === null ? 'extra' : 'stale'] += 1
      const org = want?.org_id ?? row?.org_id
      if (org !== undefined) orgs.add(org)
    }
    if (write !== null) {
      await applyReach(write, changes)
      // an insert reads nothing; a patch or delete reads its row again
      for (const { row } of changes)
        if (row !== null) {
          spent.ranges += 1
          spent.bytes += estimateDocumentBytes(row)
        }
    }
  }
  const project = async (row: Doc<'projects'>) => {
    // the lead's recompute reads the project the walk already holds
    if (!projects.has(row.id)) projects.set(row.id, Promise.resolve(row))
    const parent = row.parent_id === undefined ? null : await read(row.parent_id)
    const state = archiveStateOf(row, parent)
    if (row.archive_state !== state) {
      counts.archive_state[row.archive_state === undefined ? 'missing' : 'stale'] += 1
      orgs.add(row.org_id)
      if (write !== null) {
        await write.db.patch(row._id, { archive_state: state })
        // the patch reads the whole project again
        spent.ranges += 1
        spent.bytes += estimateDocumentBytes(row)
      }
    }
    if (row.lead_id !== undefined) await reach(grantee.profile(row.lead_id), row.id)
  }
  /* runs `unit` on the rows of `rows` from `at`, until the table ends or
   * the step has spent NAV_STEP */
  const each = async <R extends { _id: string; _creationTime: number }>(
    rows: AsyncIterable<R>,
    unit: (row: R) => Promise<void>,
  ): Promise<{ at: At | null; done: boolean }> => {
    let next = at
    let walked = 0
    for await (const row of rows) {
      if (next !== null && row._creationTime === next.after && next.seen.includes(row._id)) continue
      // a step walks at least one row, so every step makes progress
      if (
        walked > 0 &&
        (walked >= NAV_STEP.rows ||
          spent.ranges >= NAV_STEP.ranges ||
          spent.bytes >= NAV_STEP.bytes)
      )
        return { at: next, done: false }
      await unit(row)
      walked += 1
      next =
        next !== null && next.after === row._creationTime
          ? { after: next.after, seen: [...next.seen, row._id] }
          : { after: row._creationTime, seen: [row._id] }
    }
    return { at: next, done: true }
  }
  // every creation time is past 0
  const from = at?.after ?? 0
  const step = () => {
    switch (table) {
      case 'projects':
        return each(
          db.db
            .query('projects')
            .withIndex('by_creation_time', (q) => q.gte('_creationTime', from)),
          project,
        )
      case 'project_access':
        return each(
          db.db
            .query('project_access')
            .withIndex('by_creation_time', (q) => q.gte('_creationTime', from)),
          (grant) => reach(grantee.profile(grant.profile_id), grant.project_id),
        )
      case 'project_team_access':
        return each(
          db.db
            .query('project_team_access')
            .withIndex('by_creation_time', (q) => q.gte('_creationTime', from)),
          (share) => reach(grantee.team(share.team_id), share.project_id),
        )
      case 'project_reach':
        return each(
          db.db
            .query('project_reach')
            .withIndex('by_creation_time', (q) => q.gte('_creationTime', from)),
          (row) => reach(row, row.project_id),
        )
    }
  }
  const { at: nextAt, done } = await step()
  return { counts, orgs: [...orgs], at: nextAt, done }
}

const vArgs = { table: vWalked, at: vAt }

/** Writes one step of `table`'s fixes, in its own transaction. */
export const step = internalMutation({
  args: vArgs,
  handler: async (ctx, { table, at }): Promise<StepResult> => await walk(ctx, table, at, ctx),
})

/** Counts, without writing, what one step of `table` from `at` finds
 * missing or wrong. Pass null for the first step, then the returned `at`
 * until `done`. */
export const check = internalQuery({
  args: vArgs,
  handler: async (ctx, { table, at }): Promise<StepResult> => await walk(ctx, table, at, null),
})

/** Stamps the organization's org_ready row, unless it is gone or stamped
 * already. Answers whether it stamped it. */
export const stamp = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<boolean> => {
    if ((await byId(ctx, 'organizations', org_id)) === null) return false
    const row = await readyRow(ctx, org_id)
    if (row?.nav_at !== undefined) return false
    const nav_at = new Date().toISOString()
    if (row === null) await ctx.db.insert('org_ready', { org_id, nav_at })
    else await ctx.db.patch(row._id, { nav_at })
    return true
  },
})

/** A page of organizations by id, each with whether it holds its stamp,
 * and whether it is the last page. */
type OrgPage = { orgs: { org_id: string; stamped: boolean }[]; done: boolean }

/** Up to RUN.orgs organizations in id order, after `after` when given. */
export const orgPage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }): Promise<OrgPage> => {
    const rows = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
      .take(RUN.orgs)
    const orgs: OrgPage['orgs'] = []
    for (const org of rows)
      orgs.push({ org_id: org.id, stamped: (await readyRow(ctx, org.id))?.nav_at !== undefined })
    return { orgs, done: rows.length < RUN.orgs }
  },
})

/** Where a call of run goes on: a table and where in it, or the stamping
 * and the last organization it stamped or passed. It names the dry_run of
 * the call that answered it, so a dry run's cursor cannot resume a run that
 * writes. */
const vRunCursor = v.union(
  v.object({ dry_run: v.boolean(), table: vWalked, at: vAt }),
  v.object({
    dry_run: v.boolean(),
    table: v.literal('organizations'),
    after: v.union(v.string(), v.null()),
  }),
)
type RunCursor = Infer<typeof vRunCursor>

/** The totals a call that wrote records, where to go on from and the error
 * that stopped it, if one did. */
const vTotals = {
  stamped: v.number(),
  archive_states: v.number(),
  reach_missing: v.number(),
  reach_extra: v.number(),
  reach_stale: v.number(),
  done: v.boolean(),
  cursor: v.union(vRunCursor, v.null()),
  error: v.optional(v.string()),
}
type Totals = Infer<ReturnType<typeof v.object<typeof vTotals>>>

/** Records a call of run that wrote, with its totals. */
export const audit = internalMutation({
  args: vTotals,
  handler: async (ctx, totals) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'nav_backfill', detail: totals })
    return null
  },
})

type StepArgs = { table: Walked; at: At | null }
const stepRef = makeFunctionReference<'mutation', StepArgs, StepResult>('internal/navBackfill:step')
const checkRef = makeFunctionReference<'query', StepArgs, StepResult>('internal/navBackfill:check')
const stampRef = makeFunctionReference<'mutation', { org_id: string }, boolean>(
  'internal/navBackfill:stamp',
)
const orgPageRef = makeFunctionReference<'query', { after: string | null }, OrgPage>(
  'internal/navBackfill:orgPage',
)
const auditRef = makeFunctionReference<'mutation', Totals, null>('internal/navBackfill:audit')

/** Walks every table from `cursor` on, counts what it finds missing or
 * wrong and, unless `dry_run`, writes it right, then stamps every
 * organization without a stamp. A dry run writes nothing and lists the
 * organizations without a stamp instead. Answers the counts, the first
 * NAV_STEP.listed organizations with something to fix and, in a dry run,
 * those without a stamp. Past RUN.ms it stops before the next step or
 * stamp and answers the `cursor` to go on from, else `done`. A step that
 * throws stops the call with `error` and the cursor of that step. A call
 * that wrote ends with its audit row, which records what committed, whether
 * the call finished and where to go on from. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(vRunCursor) },
  handler: async (ctx, { dry_run, cursor: from }) => {
    if (from !== undefined && from.dry_run !== dry_run)
      throw new Error('this cursor is from a call with the other dry_run')
    const until = Date.now() + RUN.ms
    const counts = noCounts()
    const toFix = new Set<string>()
    const unstamped: string[] = []
    let stamped = 0
    let stepped = false
    // the next step, which a call that stops answers as its cursor
    let next: RunCursor = from ?? { dry_run, table: TABLES[0], at: null }
    let done = false
    let error: string | undefined
    // a call always takes one step, so every call makes progress
    const due = () => stepped && Date.now() >= until
    try {
      walking: for (;;) {
        if (due()) break
        if (next.table === 'organizations') {
          const page: OrgPage = await ctx.runQuery(orgPageRef, { after: next.after })
          for (const org of page.orgs) {
            if (due()) break walking
            if (!org.stamped) {
              if (dry_run) {
                if (unstamped.length < NAV_STEP.listed) unstamped.push(org.org_id)
              } else if (await ctx.runMutation(stampRef, { org_id: org.org_id })) stamped++
            }
            stepped = true
            next = { dry_run, table: 'organizations', after: org.org_id }
          }
          if (page.done) {
            done = true
            break
          }
          continue
        }
        const args: StepArgs = { table: next.table, at: next.at }
        const got: StepResult = dry_run
          ? await ctx.runQuery(checkRef, args)
          : await ctx.runMutation(stepRef, args)
        stepped = true
        counts.archive_state.missing += got.counts.archive_state.missing
        counts.archive_state.stale += got.counts.archive_state.stale
        counts.reach.missing += got.counts.reach.missing
        counts.reach.extra += got.counts.reach.extra
        counts.reach.stale += got.counts.reach.stale
        for (const org of got.orgs) if (toFix.size < NAV_STEP.listed) toFix.add(org)
        const after = TABLES[TABLES.indexOf(next.table) + 1]
        next = !got.done
          ? { dry_run, table: next.table, at: got.at }
          : after === undefined
            ? { dry_run, table: 'organizations', after: null }
            : { dry_run, table: after, at: null }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const cursor = done ? null : next
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        stamped,
        archive_states: counts.archive_state.missing + counts.archive_state.stale,
        reach_missing: counts.reach.missing,
        reach_extra: counts.reach.extra,
        reach_stale: counts.reach.stale,
        done,
        cursor,
        ...(error === undefined ? {} : { error }),
      })
    return {
      dry_run,
      ...counts,
      stamped,
      to_fix: [...toFix],
      ...(dry_run ? { unstamped } : {}),
      done,
      cursor,
      ...(error === undefined ? {} : { error }),
    }
  },
})
