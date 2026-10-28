/* One-time migration that counts the bytes and files of every
 * organization's task attachments and description images, in the live
 * tables and in Deleted items, into its stored-byte totals (schema.ts
 * storage_org_totals, storage_project_totals and storage_task_totals, kept
 * by model/storageTotals.ts). Nothing
 * reads the totals in this release, and a later reader uses an
 * organization's totals only once it is counted (storageTotalsOf), so an
 * organization that is not counted yet reads as not counted, never as
 * empty. Organizations created since this release are counted from their
 * start (model/orgs.ts insertOrgRows).
 *
 * A count runs in steps, each its own transaction, in task number order
 * across issues and deleted_tasks (index by_org_num), so tasks in Deleted
 * items count too. The first step creates the organization's row with
 * `counting.through` below every task number. Each step reads the tasks
 * numbered past it, counts every attachment row of each, live
 * (issue_attachments.by_issue) and stored (deleted_rows.by_table_org_owner,
 * whichever item holds them), writes each task's row and adds them to their
 * projects' and the organization's rows, then moves `through` to the last
 * number it counted. A writer moves the totals only for a task numbered at
 * or below `through` or one that has its row (model/storageTotals.ts), so
 * each file counts once however rows are attached, moved, restored or
 * deleted while the count runs. The step that finds no task past `through`
 * ends the count.
 *
 * A file counts in its task's project. An attachment row whose task is in
 * neither issues nor deleted_tasks counts nowhere, as in the billing sample
 * today. The dry run lists such rows, and nothing here deletes them. A
 * purge of Deleted items leaves such rows for a few steps, because it
 * deletes a task's deleted_tasks row before its stored attachments. A count
 * that passes the task's number then leaves those files out, and the purge
 * deletes them without changing the totals.
 *
 * Read the dry run first. It writes nothing and reports, for every
 * organization, the totals it would count, and for one counted already
 * whether its organization, project and task rows match its files. It lists
 * an organization whose totals kept changing while it counted as unsettled,
 * to check again with a later dry run (dryCount), and the attachment rows
 * whose task is gone (orphans). With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/storageTotalsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/storageTotalsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, and
 * then answers `done: false` with a `cursor`. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. Each call reports
 * the organizations it went through.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the organizations not counted yet, finishes a count an
 * earlier call left, and leaves the others as they are. `"recount": true`
 * counts every organization again, to mend totals a dry run lists as
 * differing. Its first step deletes the organization's row, so writers
 * leave the totals alone, the next steps delete its project and task rows,
 * and the count then starts from zero. Until it ends, the organization reads
 * as not counted. An organization whose deletion has begun is listed as
 * skipped and left to its deletion. A call that wrote adds one
 * platform_audit_log row (action 'storage_totals_backfill', actor
 * 'system') with its totals. Running it again is safe. It writes no
 * activity, sends no task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { deletionBegun } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { type Amount, addToProject, orgTotalsRow, taskTotalsRow } from '../model/storageTotals'

/** What one step reads. `tasks` and `bytes` bound the tasks it reads from
 * each table and their documents, as Convex counts a document's size, and
 * `files` the attachment rows it counts before it ends early, between two
 * task numbers. A stored description can come close to Convex's document
 * size limit, so tasks are read no more at a time than the unspent bytes
 * could hold at that size (numbered), and a table's tasks pass `bytes` by
 * at most one document. An attachment row stays within about 2 KB, its name
 * and media type within LIMITS (lib/limits.ts), and a task holds about 200,
 * so a step reads at most about 3 MiB of tasks from each table and 5 MB of
 * attachment rows, inside Convex's 16 MiB. `drain` is the rows a recount
 * deletes per step and a dry run reads per page of project rows, `orphans`
 * the attachment rows per page of the dry run's orphan check, and `listed`
 * the most of each kind a dry run lists. Tests lower them. */
export const COUNT_PAGE = {
  tasks: 100,
  bytes: 2 * MIB,
  files: 2000,
  drain: 500,
  orphans: 256,
  listed: 100,
}

/** Organizations one page of a run reads, and how long one call of run
 * goes on before it answers where to go on from. Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** Where a count starts, below every task number. */
const START = Number.MIN_SAFE_INTEGER

/** A task as a count reads it, from issues or from deleted_tasks. */
type Task = { id: string; num: number; project_id: string }

/** Reads the organization's rows of one table by task number. */
type ByNum<R> = {
  past: (after: number, n: number) => Promise<R[]>
  at: (num: number) => Promise<R[]>
  task: (row: R) => Task
}

const liveTasks = (ctx: QueryCtx, orgId: string): ByNum<Doc<'issues'>> => ({
  past: (after, n) =>
    ctx.db
      .query('issues')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', after))
      .take(n),
  at: (num) =>
    ctx.db
      .query('issues')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', num))
      .collect(),
  task: (row) => ({ id: row.id, num: row.num, project_id: row.project_id }),
})

const storedTasks = (ctx: QueryCtx, orgId: string): ByNum<Doc<'deleted_tasks'>> => ({
  past: (after, n) =>
    ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', after))
      .take(n),
  at: (num) =>
    ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', num))
      .collect(),
  task: (row) => ({ id: row.task_id, num: row.num, project_id: row.project_id }),
})

/* The tasks one table numbers past `after`: at most COUNT_PAGE.tasks, or
 * as many as COUNT_PAGE.bytes holds, read in parts no larger than the
 * unspent bytes could hold at Convex's document size limit, each with every
 * row of its last number, should two share one. `last` is the number they
 * reach while more may follow, and null once the table has no more. */
async function numbered<R extends Doc<'issues'> | Doc<'deleted_tasks'>>(
  read: ByNum<R>,
  after: number,
): Promise<{ tasks: Task[]; last: number | null }> {
  const tasks: Task[] = []
  const seen = new Set<string>()
  let from = after
  let bytes = 0
  const add = (row: R) => {
    if (seen.has(row._id)) return
    seen.add(row._id)
    bytes += getDocumentSize(row)
    tasks.push(read.task(row))
  }
  for (;;) {
    const fits = Math.max(1, Math.floor((COUNT_PAGE.bytes - bytes) / DOCUMENT_MAX_BYTES))
    const want = Math.min(COUNT_PAGE.tasks - tasks.length, fits)
    const part = await read.past(from, want)
    for (const row of part) add(row)
    const last = part.at(-1)?.num
    if (part.length < want || last === undefined) return { tasks, last: null }
    for (const row of await read.at(last)) add(row)
    from = last
    if (tasks.length >= COUNT_PAGE.tasks || bytes >= COUNT_PAGE.bytes) return { tasks, last }
  }
}

/* The organization's tasks numbered past `after`, live and in Deleted
 * items, in number order, each once, up to the number both tables were
 * read through, which it answers as `through`. Null when neither table
 * numbers a task past `after`. */
async function taskPage(
  ctx: QueryCtx,
  orgId: string,
  after: number,
): Promise<{ tasks: Task[]; through: number } | null> {
  const live = await numbered(liveTasks(ctx, orgId), after)
  const stored = await numbered(storedTasks(ctx, orgId), after)
  const all = [...live.tasks, ...stored.tasks]
  const ends = [live.last, stored.last].filter((n): n is number => n !== null)
  const through = ends.length > 0 ? Math.min(...ends) : Math.max(after, ...all.map((t) => t.num))
  if (through === after) return null
  const ids = new Set<string>()
  const tasks = all
    .filter((task) => task.num <= through && !ids.has(task.id) && ids.add(task.id))
    .sort((x, y) => x.num - y.num)
  return { tasks, through }
}

/* The bytes and files of task `taskId`'s attachment rows, live and stored
 * in any item, with the number of rows read. */
async function filesOf(
  ctx: QueryCtx,
  orgId: string,
  taskId: string,
): Promise<Amount & { rows: number }> {
  const out = { bytes: 0, files: 0, rows: 0 }
  const live = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
    .collect()
  for (const row of live) {
    out.bytes += row.size_bytes
    out.files += 1
  }
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_table_org_owner', (q) =>
      q.eq('table', 'issue_attachments').eq('org_id', orgId).eq('owner_id', taskId),
    )
    .collect()
  for (const row of stored)
    if (row.row.table === 'issue_attachments') {
      out.bytes += row.row.doc.size_bytes
      out.files += 1
    }
  out.rows = live.length + stored.length
  return out
}

/** One task as a count found it, with the row it holds. */
type Counted = { task: Task; files: Amount; row: Doc<'storage_task_totals'> | null }

/* Counts the files of the tasks of `page` in number order, ending early
 * once COUNT_PAGE.files attachment rows were read, between two numbers.
 * Answers each task with its totals row and the number counted through. */
async function countTasks(
  ctx: QueryCtx,
  orgId: string,
  page: { tasks: Task[]; through: number },
): Promise<{ counted: Counted[]; through: number }> {
  const counted: Counted[] = []
  let rows = 0
  for (const [i, task] of page.tasks.entries()) {
    const files = await filesOf(ctx, orgId, task.id)
    rows += files.rows
    counted.push({ task, files, row: await taskTotalsRow(ctx, task.id) })
    const next = page.tasks[i + 1]
    if (rows >= COUNT_PAGE.files && next !== undefined && next.num > task.num)
      return { counted, through: task.num }
  }
  return { counted, through: page.through }
}

const same = (x: Amount, y: Amount): boolean => x.bytes === y.bytes && x.files === y.files

/* Adds `by` to `projectId`'s entry of `sums`. */
function addTo(sums: Map<string, Amount>, projectId: string, by: Amount): void {
  const sum = sums.get(projectId) ?? { bytes: 0, files: 0 }
  sum.bytes += by.bytes
  sum.files += by.files
  sums.set(projectId, sum)
}

/* Deletes up to COUNT_PAGE.drain of the organization's task and project
 * totals rows. True once none is left. */
async function clearRows(ctx: MutationCtx, orgId: string): Promise<boolean> {
  let left = COUNT_PAGE.drain
  const reads = [
    () =>
      ctx.db
        .query('storage_task_totals')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .take(left + 1),
    () =>
      ctx.db
        .query('storage_project_totals')
        .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId))
        .take(left + 1),
  ]
  for (const read of reads) {
    const rows = await read()
    for (const row of rows.slice(0, left)) await ctx.db.delete(row._id)
    if (rows.length > left) return false
    left -= rows.length
  }
  return true
}

/** One step of the organization's count, in its own transaction. With
 * `recount` it first deletes a counted organization's row and then its
 * project and task rows; an organization without a row starts there too,
 * so nothing it held before counts twice. It then starts the count, counts
 * one page of tasks, and ends the count once no task is numbered past where
 * it counted. Leaves an organization counted already alone unless
 * `recount`. Answers its totals once it is counted, null while it counts,
 * and 'skipped' for an organization that is gone or whose deletion has
 * begun. */
export const step = internalMutation({
  args: { org_id: v.string(), recount: v.boolean() },
  handler: async (ctx, { org_id, recount }): Promise<Amount | 'skipped' | null> => {
    if ((await byId(ctx, 'organizations', org_id)) === null) return 'skipped'
    if (await deletionBegun(ctx, org_id)) return 'skipped'
    let org = await orgTotalsRow(ctx, org_id)
    if (org !== null && org.counting === undefined) {
      if (!recount) return { bytes: org.bytes, files: org.files }
      await ctx.db.delete(org._id)
      return null
    }
    if (org === null) {
      if (!(await clearRows(ctx, org_id))) return null
      const _id = await ctx.db.insert('storage_org_totals', {
        org_id,
        bytes: 0,
        files: 0,
        counting: { through: START },
      })
      org = (await ctx.db.get(_id)) as Doc<'storage_org_totals'>
    }
    const page = await taskPage(ctx, org_id, org.counting?.through ?? START)
    if (page === null) {
      await ctx.db.patch(org._id, { counting: undefined })
      return { bytes: org.bytes, files: org.files }
    }
    const { counted, through } = await countTasks(ctx, org_id, page)
    const projects = new Map<string, Amount>()
    const total = { bytes: org.bytes, files: org.files }
    for (const { task, files, row } of counted) {
      // a task's row exists only once it counts, so this is its first
      // count; a row held anyway is replaced and its files moved on
      if (row !== null) {
        addTo(projects, row.project_id, { bytes: -row.bytes, files: -row.files })
        total.bytes -= row.bytes
        total.files -= row.files
      }
      addTo(projects, task.project_id, files)
      total.bytes += files.bytes
      total.files += files.files
      const fields = { project_id: task.project_id, bytes: files.bytes, files: files.files }
      if (files.files > 0 && row !== null) await ctx.db.patch(row._id, fields)
      else if (files.files > 0)
        await uncountedWriter(ctx.db).insert('storage_task_totals', {
          org_id,
          issue_id: task.id,
          ...fields,
        })
      else if (row !== null) await ctx.db.delete(row._id)
    }
    for (const [projectId, by] of projects) await addToProject(ctx, org_id, projectId, by)
    await ctx.db.patch(org._id, { ...total, counting: { through } })
    return null
  },
})

/** An organization as a run reads it, with whether its deletion has begun
 * and its totals row, null before a count, with `counting` while one runs. */
type OrgState = {
  org_id: string
  deleting: boolean
  row: (Amount & { counting: number | null }) | null
}

/** The organization's state (OrgState). */
async function stateOf(ctx: QueryCtx, orgId: string): Promise<OrgState> {
  const row = await orgTotalsRow(ctx, orgId)
  return {
    org_id: orgId,
    deleting: await deletionBegun(ctx, orgId),
    row:
      row === null
        ? null
        : { bytes: row.bytes, files: row.files, counting: row.counting?.through ?? null },
  }
}

/** A page of organizations with their states. */
type OrgPage = { orgs: OrgState[]; cursor: string; done: boolean }

/** One page of organizations, by id, with their states. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    const orgs: OrgState[] = []
    for (const org of page.page) orgs.push(await stateOf(ctx, org.id))
    return { orgs, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One organization's state, as a dry run reads it after a count. */
export const state = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgState> => await stateOf(ctx, org_id),
})

/** A task whose totals row does not hold what its files give. */
type TaskDiff = {
  task_id: string
  counted: Amount & { project_id: string }
  stored: (Amount & { project_id: string }) | null
}

/** One page of a dry count (check). */
type CheckPage = Amount & {
  through: number
  projects: (Amount & { project_id: string })[]
  differing: number
  differ: TaskDiff[]
}

/** Counts, without writing, the files of one page of the organization's
 * tasks numbered past `after`, per project, and the tasks whose totals row
 * does not hold them, as a step would count them. Null once no task is
 * numbered past `after`. */
export const check = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<CheckPage | null> => {
    const page = await taskPage(ctx, org_id, after)
    if (page === null) return null
    const { counted, through } = await countTasks(ctx, org_id, page)
    const projects = new Map<string, Amount>()
    const out: CheckPage = { bytes: 0, files: 0, through, projects: [], differing: 0, differ: [] }
    for (const { task, files, row } of counted) {
      addTo(projects, task.project_id, files)
      out.bytes += files.bytes
      out.files += files.files
      const held = row ?? { project_id: task.project_id, bytes: 0, files: 0 }
      if (same(held, files) && held.project_id === task.project_id) continue
      if (out.differing++ < COUNT_PAGE.listed)
        out.differ.push({
          task_id: task.id,
          counted: { project_id: task.project_id, bytes: files.bytes, files: files.files },
          stored:
            row === null
              ? null
              : { project_id: row.project_id, bytes: row.bytes, files: row.files },
        })
    }
    out.projects = [...projects].map(([project_id, sum]) => ({ project_id, ...sum }))
    return out
  },
})

/** One page of the organization's project totals rows. */
export const projectRows = internalQuery({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }) => {
    const page = await ctx.db
      .query('storage_project_totals')
      .withIndex('by_org_bytes', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: COUNT_PAGE.drain })
    return {
      rows: page.page.map((row) => ({
        project_id: row.project_id,
        bytes: row.bytes,
        files: row.files,
      })),
      cursor: page.continueCursor,
      done: page.isDone,
    }
  },
})

/** An attachment row whose task is in neither issues nor deleted_tasks. */
type Orphan = { attachment_id: string; task_id: string; size_bytes: number; stored: boolean }

/** A page of the orphan check, or the smaller size to read it at. */
type OrphanPage = { orphans: Orphan[]; cursor: string; done: boolean } | { split: number }

/** One page of the organization's attachment rows, live or stored, and
 * those whose task is in neither issues nor deleted_tasks. Each task is
 * looked up once per page. When the tasks it read pass COUNT_PAGE.bytes,
 * it answers `split`, and the caller reads the same page again at that
 * smaller size; a page of one row always completes. */
export const orphanPage = internalQuery({
  args: {
    org_id: v.string(),
    stored: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    size: v.number(),
  },
  handler: async (ctx, { org_id, stored, cursor, size }): Promise<OrphanPage> => {
    const opts = { cursor, numItems: Math.max(1, size), maximumBytesRead: COUNT_PAGE.bytes }
    const rows: { id: string; task_id: string; size_bytes: number }[] = []
    let next: { cursor: string; done: boolean }
    if (stored) {
      const page = await ctx.db
        .query('deleted_rows')
        .withIndex('by_table_org_owner', (q) =>
          q.eq('table', 'issue_attachments').eq('org_id', org_id),
        )
        .paginate(opts)
      for (const row of page.page)
        if (row.row.table === 'issue_attachments')
          rows.push({
            id: row.row.doc.id,
            task_id: row.owner_id,
            size_bytes: row.row.doc.size_bytes,
          })
      next = { cursor: page.continueCursor, done: page.isDone }
    } else {
      const page = await ctx.db
        .query('issue_attachments')
        .withIndex('by_org_task_archived_issue', (q) => q.eq('org_id', org_id))
        .paginate(opts)
      for (const row of page.page)
        rows.push({ id: row.id, task_id: row.issue_id, size_bytes: row.size_bytes })
      next = { cursor: page.continueCursor, done: page.isDone }
    }
    const known = new Map<string, boolean>()
    let taskBytes = 0
    const orphans: Orphan[] = []
    for (const [i, row] of rows.entries()) {
      let found = known.get(row.task_id)
      if (found === undefined) {
        const light = await ctx.db
          .query('deleted_tasks')
          .withIndex('by_task', (q) => q.eq('task_id', row.task_id))
          .first()
        const live = light === null ? await byId(ctx, 'issues', row.task_id) : null
        if (live !== null) taskBytes += getDocumentSize(live)
        // the rows before this one fit, and a page of one always completes
        if (taskBytes > COUNT_PAGE.bytes && rows.length > 1) return { split: Math.max(1, i) }
        found = light !== null || live !== null
        known.set(row.task_id, found)
      }
      if (!found)
        orphans.push({
          attachment_id: row.id,
          task_id: row.task_id,
          size_bytes: row.size_bytes,
          stored,
        })
    }
    return { orphans, ...next }
  },
})

/** Records a run that wrote, with its totals. */
export const audit = internalMutation({
  args: { counted: v.number(), bytes: v.number(), files: v.number() },
  handler: async (ctx, totals) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'storage_totals_backfill',
      detail: totals,
    })
    return null
  },
})

type ProjectRows = { rows: (Amount & { project_id: string })[]; cursor: string; done: boolean }

const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/storageTotalsBackfill:orgPage',
)
const stateRef = makeFunctionReference<'query', { org_id: string }, OrgState>(
  'internal/storageTotalsBackfill:state',
)
const checkRef = makeFunctionReference<
  'query',
  { org_id: string; after: number },
  CheckPage | null
>('internal/storageTotalsBackfill:check')
const projectRowsRef = makeFunctionReference<
  'query',
  { org_id: string; cursor: string | null },
  ProjectRows
>('internal/storageTotalsBackfill:projectRows')
const orphanPageRef = makeFunctionReference<
  'query',
  { org_id: string; stored: boolean; cursor: string | null; size: number },
  OrphanPage
>('internal/storageTotalsBackfill:orphanPage')
const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; recount: boolean },
  Amount | 'skipped' | null
>('internal/storageTotalsBackfill:step')
const auditRef = makeFunctionReference<'mutation', Amount & { counted: number }, null>(
  'internal/storageTotalsBackfill:audit',
)

/** A project whose totals row does not hold what its tasks' files give. */
type ProjectDiff = { project_id: string; counted: Amount; stored: Amount | null }

/** What a dry count of one organization found. */
type DryCount = {
  counted: Amount
  state: OrgState
  settled: boolean
  projects: ProjectDiff[]
  projects_differing: number
  tasks: TaskDiff[]
  tasks_differing: number
}

/** How many times a dry run counts an organization whose totals a write
 * moves while it counts. */
const DRY_TRIES = 3

/** Counts the organization's files without writing, page by page in
 * queries of their own, compares its project rows with the counted
 * projects, then reads its state again. Writes can land between those
 * queries, so the counts match a state only when it held still across the
 * count; it counts again while the state moved, at most DRY_TRIES times.
 * A task's comparison is exact, because one query reads the task's files
 * and its row. A move between projects changes no organization total, so
 * a move during the count can still show as a project difference that a
 * later dry run no longer shows, and so can a task that a purge has
 * already taken out of deleted_tasks. */
async function dryCount(ctx: Pick<ActionCtx, 'runQuery'>, before: OrgState): Promise<DryCount> {
  let state = before
  for (let tries = 1; ; tries++) {
    const counted = { bytes: 0, files: 0 }
    const sums = new Map<string, Amount>()
    const tasks: TaskDiff[] = []
    let tasksDiffering = 0
    let after = START
    for (;;) {
      const got = await ctx.runQuery(checkRef, { org_id: state.org_id, after })
      if (got === null) break
      counted.bytes += got.bytes
      counted.files += got.files
      for (const p of got.projects) addTo(sums, p.project_id, p)
      tasksDiffering += got.differing
      tasks.push(...got.differ.slice(0, Math.max(0, COUNT_PAGE.listed - tasks.length)))
      after = got.through
    }
    const stored = new Map<string, Amount>()
    for (let cursor: string | null = null; ; ) {
      const page: ProjectRows = await ctx.runQuery(projectRowsRef, {
        org_id: state.org_id,
        cursor,
      })
      for (const row of page.rows) addTo(stored, row.project_id, row)
      if (page.done) break
      cursor = page.cursor
    }
    const projects: ProjectDiff[] = []
    let projectsDiffering = 0
    for (const id of new Set([...sums.keys(), ...stored.keys()])) {
      const sum = sums.get(id) ?? { bytes: 0, files: 0 }
      const held = stored.get(id) ?? null
      if (held !== null && same(held, sum)) continue
      if (held === null && sum.files === 0) continue
      if (projectsDiffering++ < COUNT_PAGE.listed)
        projects.push({ project_id: id, counted: sum, stored: held })
    }
    const now = await ctx.runQuery(stateRef, { org_id: state.org_id })
    // stateOf builds both, so their keys come in the same order
    const settled = JSON.stringify(now) === JSON.stringify(state)
    if (settled || tries === DRY_TRIES)
      return {
        counted,
        state: now,
        settled,
        projects,
        projects_differing: projectsDiffering,
        tasks,
        tasks_differing: tasksDiffering,
      }
    state = now
  }
}

/** The attachment rows of the organization, live and stored, whose task is
 * in neither issues nor deleted_tasks, read page by page (orphanPage):
 * how many, their bytes, and up to `room` of them. */
async function orphansOf(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  room: number,
): Promise<{ rows: number; bytes: number; listed: (Orphan & { org_id: string })[] }> {
  const out = { rows: 0, bytes: 0, listed: [] as (Orphan & { org_id: string })[] }
  for (const stored of [false, true]) {
    let cursor: string | null = null
    let size = COUNT_PAGE.orphans
    for (;;) {
      const page: OrphanPage = await ctx.runQuery(orphanPageRef, {
        org_id: orgId,
        stored,
        cursor,
        size,
      })
      if ('split' in page) {
        size = page.split
        continue
      }
      for (const orphan of page.orphans) {
        out.rows += 1
        out.bytes += orphan.size_bytes
        if (out.listed.length < room) out.listed.push({ org_id: orgId, ...orphan })
      }
      if (page.done) break
      cursor = page.cursor
      size = COUNT_PAGE.orphans
    }
  }
  return out
}

/** One organization as a dry run lists it, with the totals its files give
 * and those it holds once counted. */
type OrgReport = Amount & { org_id: string; stored?: Amount }

/** A counted organization whose rows do not hold what its files give. */
type OrgDiff = OrgReport & {
  projects_differing: number
  projects: ProjectDiff[]
  tasks_differing: number
  tasks: TaskDiff[]
}

/** Counts every organization not counted yet, or every one with
 * `recount`, from `cursor` on, and answers how many it counted and their
 * totals. Past RUN.ms it stops after a page of organizations and answers
 * the `cursor` to go on from, else `done`. A dry run writes nothing. It
 * counts each organization's files (dryCount), answers the same totals for
 * those it would count, lists up to COUNT_PAGE.listed of them, and lists
 * the organizations counted already whose organization, project or task
 * rows their files do not give (`differ`, `differing` in all), with up to
 * COUNT_PAGE.listed of each kind of row. An organization whose totals kept
 * changing through every count is listed in `unsettled_orgs` (`unsettled`
 * in all) instead, for a later dry run. A dry run also counts the
 * attachment rows whose task is gone (`orphan_rows`, `orphan_bytes`) and
 * lists up to COUNT_PAGE.listed of them (`orphans`). Both list the
 * organizations whose deletion has begun in `skipped_orgs` (`skipped` in
 * all). A call that wrote ends with its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { orgs: 0, counted: 0, bytes: 0, files: 0 }
    const add = (sum: Amount) => {
      totals.counted++
      totals.bytes += sum.bytes
      totals.files += sum.files
    }
    const toCount: OrgReport[] = []
    const differ: OrgDiff[] = []
    const unsettledOrgs: string[] = []
    const skippedOrgs: string[] = []
    const orphans: (Orphan & { org_id: string })[] = []
    let differing = 0
    let unsettled = 0
    let skipped = 0
    let orphanRows = 0
    let orphanBytes = 0
    const skip = (orgId: string) => {
      if (skipped++ < COUNT_PAGE.listed) skippedOrgs.push(orgId)
    }
    let cursor: string | null = from ?? null
    let done = false
    for (;;) {
      const page: OrgPage = await ctx.runQuery(orgPageRef, { cursor })
      for (const org of page.orgs) {
        const { org_id } = org
        totals.orgs++
        if (org.deleting) {
          skip(org_id)
          continue
        }
        const due = org.row === null || org.row.counting !== null || recount
        if (!dry_run) {
          if (!due) continue
          let got: Amount | 'skipped' | null = null
          while (got === null) got = await ctx.runMutation(stepRef, { org_id, recount })
          if (got === 'skipped') skip(org_id)
          else add(got)
          continue
        }
        const found = await dryCount(ctx, org)
        const lost = await orphansOf(ctx, org_id, COUNT_PAGE.listed - orphans.length)
        orphanRows += lost.rows
        orphanBytes += lost.bytes
        orphans.push(...lost.listed)
        const report: OrgReport = { org_id, ...found.counted }
        const row = found.state.row
        if (!found.settled) {
          if (unsettled++ < COUNT_PAGE.listed) unsettledOrgs.push(org_id)
        } else if (row !== null && row.counting === null) {
          report.stored = { bytes: row.bytes, files: row.files }
          const matches =
            same(report.stored, found.counted) &&
            found.projects_differing === 0 &&
            found.tasks_differing === 0
          if (!matches && differing++ < COUNT_PAGE.listed)
            differ.push({
              ...report,
              projects_differing: found.projects_differing,
              projects: found.projects,
              tasks_differing: found.tasks_differing,
              tasks: found.tasks,
            })
        }
        if (!due) continue
        add(report)
        if (toCount.length < COUNT_PAGE.listed) toCount.push(report)
      }
      done = page.done
      cursor = page.cursor
      if (done || Date.now() >= until) break
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: totals.counted,
        bytes: totals.bytes,
        files: totals.files,
      })
    return {
      dry_run,
      ...totals,
      differing,
      to_count: toCount,
      differ,
      unsettled,
      unsettled_orgs: unsettledOrgs,
      skipped,
      skipped_orgs: skippedOrgs,
      orphan_rows: orphanRows,
      orphan_bytes: orphanBytes,
      orphans,
      done,
      cursor: done ? null : cursor,
    }
  },
})
