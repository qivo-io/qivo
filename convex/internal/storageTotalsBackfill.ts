/* One-time migration that counts the bytes and files of every
 * organization's task attachments and description images, in the live
 * tables and in Deleted items, into its stored-byte totals (schema.ts
 * storage_org_totals, storage_project_totals and storage_task_totals, kept
 * by model/storageTotals.ts). Nothing reads the totals in this release, and
 * a later reader uses an organization's totals only once it is counted
 * (storageTotalsOf), so an organization that is not counted yet reads as
 * not counted, never as empty. Organizations created since this release
 * are counted from their start (model/orgs.ts insertOrgRows).
 *
 * A count runs in steps, each its own transaction, in task number order
 * across issues and deleted_tasks (index by_org_num), so tasks in Deleted
 * items count too. The first step deletes any project and task rows left
 * under the organization, then creates its row with `counting.through`
 * below every task number. Each step reads the tasks numbered past it,
 * counts every attachment row of each, live (issue_attachments.by_issue)
 * and stored (deleted_rows.by_table_org_owner, whichever item holds them),
 * writes each task's row and adds them to their projects' and the
 * organization's rows, then moves `through` to the last number it counted.
 * A writer moves the totals only for a task numbered at or below `through`
 * or one that has its row (model/storageTotals.ts), so each file counts once
 * however rows are attached, moved, restored or deleted while the count
 * runs. The step that finds no task past `through` ends the count. A task
 * or project row under the id of one of the organization's tasks or
 * projects that names another organization belongs to one that had the id
 * before and is gone, which only a release without these totals can leave.
 * The step takes it out of that organization's totals before it counts.
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
 * whether its organization, project and task rows match its files and its
 * project rows the projects' names. An organization whose totals changed
 * while it counted, as its row's revision tells, is counted again, and
 * listed as unsettled when it changed through every count, to check again
 * with a later dry run. It also lists the attachment rows whose task is
 * gone (orphans) and the totals rows of organizations that no longer exist
 * (strays), which a release without these totals leaves when it deletes an
 * organization. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/storageTotalsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/storageTotalsBackfill:run '{"dry_run": false}'
 * A call checks its deadline, RUN.ms, before each step and each page it
 * reads, well inside Convex's action time limit, and then answers
 * `done: false` with a `cursor`, which goes on inside an organization and
 * inside its count. Call it again with the same arguments and `"cursor"`
 * set to it until `done` is true. Each call reports what it went through.
 * A call that meets an error answers it in `error`, with the cursor of the
 * organization it failed on and what it counted before.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with
 * a short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the organizations not counted yet, finishes a count an
 * earlier run left, deletes the strays, and leaves the others as they are.
 * `"recount": true` counts every organization again from zero, to mend
 * totals a dry run lists as differing, such as after a rollback past this
 * release. Each run has its own id, which it keeps in the cursor and on
 * each organization row it counts. A recount starts over any count another
 * run began, and goes on with its own. Its first step deletes the
 * organization's row, so writers leave the totals alone, the next steps
 * delete its project and task rows, and the count then starts from zero.
 * Until it ends, the organization reads as not counted. An organization
 * whose deletion has begun is listed as skipped and left to its deletion.
 * A call that wrote adds one platform_audit_log row (action
 * 'storage_totals_backfill', actor 'system') with its totals, also when it
 * met an error. Running it again is safe. It writes no activity, sends no
 * task event and changes nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { deletionBegun } from '../lib/billingAccess'
import { byId, usedMoreThan } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'
import { newUuid } from '../model/orgs'
import {
  type Amount,
  addToOrg,
  addToProject,
  orgTotalsRow,
  projectNameOf,
  projectTotalsRow,
  taskTotalsRow,
} from '../model/storageTotals'

/** What one step reads. `tasks` and `bytes` bound the tasks it reads from
 * each table and their documents, as Convex counts a document's size. A
 * table's page ends at the first number past either, so it reads at most
 * `bytes` and two documents more, the last it keeps and the one that shows
 * the next number, which counts too. `fileBytes` bounds the attachment rows
 * and task totals rows it reads, and `room` the share of every Convex
 * transaction limit the count may use, as the transaction itself measures
 * every read (lib/db.ts usedMoreThan), so the project rows its writes read
 * stay inside the rest. A step ends early only between two task numbers
 * and counts at least one. `drain` is the rows a recount deletes per step,
 * `projects` the project rows per page of a dry run's comparison, `orphans`
 * the attachment rows per page of its orphan check, and `listed` the most
 * of each kind a dry run lists. Tests lower them. */
export const COUNT_PAGE = {
  tasks: 100,
  bytes: 2 * MIB,
  fileBytes: 4 * MIB,
  room: 0.5,
  drain: 500,
  projects: 100,
  orphans: 256,
  listed: 100,
}

/** Organizations, or totals rows of the stray check, one page reads, and
 * how long one call of run goes on before it answers where to go on from.
 * Tests lower them. */
export const RUN = { orgs: 100, ms: 5 * 60_000 }

/** Where a count starts, below every task number. */
const START = Number.MIN_SAFE_INTEGER

/** A task as a count reads it, from issues or from deleted_tasks. */
type Task = { id: string; num: number; project_id: string }

/** Reads the organization's rows of one table past a task number. */
type ByNum<R> = { past: (after: number) => AsyncIterable<R>; task: (row: R) => Task }

const liveTasks = (ctx: QueryCtx, orgId: string): ByNum<Doc<'issues'>> => ({
  past: (after) =>
    ctx.db.query('issues').withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', after)),
  task: (row) => ({ id: row.id, num: row.num, project_id: row.project_id }),
})

const storedTasks = (ctx: QueryCtx, orgId: string): ByNum<Doc<'deleted_tasks'>> => ({
  past: (after) =>
    ctx.db
      .query('deleted_tasks')
      .withIndex('by_org_num', (q) => q.eq('org_id', orgId).gt('num', after)),
  task: (row) => ({ id: row.task_id, num: row.num, project_id: row.project_id }),
})

/* The tasks one table numbers past `after`, read once each, in number
 * order, up to the first number past COUNT_PAGE.tasks or COUNT_PAGE.bytes,
 * every task of the last number included should two share one. `last` is
 * the number they reach while more follow, and null once the table has no
 * more. `bytes` counts every document read, the one past the page too. */
async function numbered<R extends Doc<'issues'> | Doc<'deleted_tasks'>>(
  read: ByNum<R>,
  after: number,
): Promise<{ tasks: Task[]; last: number | null; bytes: number }> {
  const tasks: Task[] = []
  let bytes = 0
  for await (const row of read.past(after)) {
    const kept = bytes
    bytes += getDocumentSize(row)
    const prev = tasks.at(-1)
    const full = tasks.length >= COUNT_PAGE.tasks || kept >= COUNT_PAGE.bytes
    if (prev !== undefined && row.num !== prev.num && full) return { tasks, last: prev.num, bytes }
    tasks.push(read.task(row))
  }
  return { tasks, last: null, bytes }
}

/** The organization's tasks numbered past `after`, live and in Deleted
 * items, in number order, each once, up to the number both tables were
 * read through, which it answers as `through`. Null when neither table
 * numbers a task past `after`. Exported for its tests. */
export async function taskPage(
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
 * in any item of the organization, with the bytes of the rows read. */
async function filesOf(
  ctx: QueryCtx,
  orgId: string,
  taskId: string,
): Promise<Amount & { read: number }> {
  const out = { bytes: 0, files: 0, read: 0 }
  const live = ctx.db
    .query('issue_attachments')
    .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
  for await (const row of live) {
    out.read += getDocumentSize(row)
    out.bytes += row.size_bytes
    out.files += 1
  }
  const stored = ctx.db
    .query('deleted_rows')
    .withIndex('by_table_org_owner', (q) =>
      q.eq('table', 'issue_attachments').eq('org_id', orgId).eq('owner_id', taskId),
    )
  for await (const row of stored) {
    out.read += getDocumentSize(row)
    if (row.row.table !== 'issue_attachments') continue
    out.bytes += row.row.doc.size_bytes
    out.files += 1
  }
  return out
}

/** One task as a count found it, with the row its id holds. */
type Counted = { task: Task; files: Amount; row: Doc<'storage_task_totals'> | null }

/* Counts the files of the tasks of `page` in number order, ending early
 * between two numbers once the rows read pass COUNT_PAGE.fileBytes or the
 * transaction passes COUNT_PAGE.room of a limit. Answers each task with
 * the row its id holds and the number counted through. */
async function countTasks(
  ctx: QueryCtx,
  orgId: string,
  page: { tasks: Task[]; through: number },
): Promise<{ counted: Counted[]; through: number }> {
  const counted: Counted[] = []
  let read = 0
  for (const [i, task] of page.tasks.entries()) {
    const files = await filesOf(ctx, orgId, task.id)
    const row = await taskTotalsRow(ctx, task.id)
    read += files.read + (row === null ? 0 : getDocumentSize(row))
    counted.push({ task, files, row })
    const next = page.tasks[i + 1]
    if (next === undefined || next.num === task.num) continue
    if (read >= COUNT_PAGE.fileBytes || (await usedMoreThan(ctx, COUNT_PAGE.room)))
      return { counted, through: task.num }
  }
  return { counted, through: page.through }
}

const same = (x: Amount, y: Amount): boolean => x.bytes === y.bytes && x.files === y.files
const negated = (x: Amount): Amount => ({ bytes: -x.bytes, files: -x.files })

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

/* Takes task row `row` of another organization, whose task had the id
 * before and is gone, out of that organization's project and organization
 * totals, and deletes it. */
async function dropAnothers(ctx: MutationCtx, row: Doc<'storage_task_totals'>): Promise<void> {
  console.warn('A storage count took over a task row of another organization', {
    issue_id: row.issue_id,
    org_id: row.org_id,
  })
  await ctx.db.delete(row._id)
  await addToProject(ctx, row.org_id, row.project_id, negated(row))
  const other = await orgTotalsRow(ctx, row.org_id)
  if (other !== null) await addToOrg(ctx, other, negated(row))
}

/* Takes over project `projectId`'s totals row when it names another
 * organization while the project, live or stored, is organization
 * `orgId`'s. Such a row is of a project that had the id before and is
 * gone, which only a release without these totals can leave. Its files
 * leave that organization's totals with it. */
async function claimProject(ctx: MutationCtx, orgId: string, projectId: string): Promise<void> {
  const row = await projectTotalsRow(ctx, projectId)
  if (row === null || row.org_id === orgId) return
  const live = await byId(ctx, 'projects', projectId)
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', projectId))
    .first()
  if ((live ?? stored)?.org_id !== orgId) return
  console.warn('A storage count took over a project row of another organization', {
    project_id: projectId,
    org_id: row.org_id,
  })
  await ctx.db.delete(row._id)
  const other = await orgTotalsRow(ctx, row.org_id)
  if (other !== null) await addToOrg(ctx, other, negated(row))
}

/** One step of the organization's count by run `run`, in its own
 * transaction. With `recount` it first deletes the organization's row,
 * unless this run counted it or is counting it, and then its project and
 * task rows; an organization without a row starts there too, so nothing it
 * held before counts twice. It then starts the count, counts one page of
 * tasks, and ends the count once no task is numbered past where it counted.
 * Without `recount` it leaves a counted organization alone and goes on with
 * a count any run began. Answers its totals once it is counted, null while
 * it counts, and 'skipped' for an organization that is gone or whose
 * deletion has begun. */
export const step = internalMutation({
  args: { org_id: v.string(), recount: v.boolean(), run: v.string() },
  handler: async (ctx, { org_id, recount, run }): Promise<Amount | 'skipped' | null> => {
    if ((await byId(ctx, 'organizations', org_id)) === null) return 'skipped'
    if (await deletionBegun(ctx, org_id)) return 'skipped'
    let org = await orgTotalsRow(ctx, org_id)
    if (org !== null && recount && org.run !== run) {
      await ctx.db.delete(org._id)
      return null
    }
    if (org !== null && org.counting === undefined) return { bytes: org.bytes, files: org.files }
    if (org === null) {
      if (!(await clearRows(ctx, org_id))) return null
      const _id = await ctx.db.insert('storage_org_totals', {
        org_id,
        bytes: 0,
        files: 0,
        revision: 0,
        run,
        counting: { through: START },
      })
      org = (await ctx.db.get(_id)) as Doc<'storage_org_totals'>
    }
    const page = await taskPage(ctx, org_id, org.counting?.through ?? START)
    if (page === null) {
      await ctx.db.patch(org._id, { counting: undefined, revision: org.revision + 1 })
      return { bytes: org.bytes, files: org.files }
    }
    const { counted, through } = await countTasks(ctx, org_id, page)
    const projects = new Map<string, Amount>()
    const total = { bytes: org.bytes, files: org.files }
    for (const { task, files, row: held } of counted) {
      let row = held
      if (row !== null && row.org_id !== org_id) {
        await dropAnothers(ctx, row)
        row = null
      }
      // a task's row exists only once it counts, so this is its first
      // count; a row held anyway is replaced and its files moved on
      if (row !== null) {
        addTo(projects, row.project_id, negated(row))
        total.bytes -= row.bytes
        total.files -= row.files
      }
      addTo(projects, task.project_id, files)
      total.bytes += files.bytes
      total.files += files.files
      const fields = {
        num: task.num,
        project_id: task.project_id,
        bytes: files.bytes,
        files: files.files,
      }
      if (files.files > 0 && row !== null) await ctx.db.patch(row._id, fields)
      else if (files.files > 0)
        await uncountedWriter(ctx.db).insert('storage_task_totals', {
          org_id,
          issue_id: task.id,
          ...fields,
        })
      else if (row !== null) await ctx.db.delete(row._id)
    }
    for (const [projectId, by] of projects) {
      await claimProject(ctx, org_id, projectId)
      await addToProject(ctx, org_id, projectId, by)
    }
    await ctx.db.patch(org._id, { ...total, revision: org.revision + 1, counting: { through } })
    return null
  },
})

/** An organization as a run reads it: its creation time, which orders the
 * page, whether its deletion has begun, and its totals row, null before a
 * count, with `counting` while one runs. */
type OrgState = {
  org_id: string
  ct: number
  deleting: boolean
  row: (Amount & { revision: number; run: string | null; counting: number | null }) | null
}

/** The state of organization `org` (OrgState). */
async function stateOf(ctx: QueryCtx, org: Doc<'organizations'>): Promise<OrgState> {
  const row = await orgTotalsRow(ctx, org.id)
  return {
    org_id: org.id,
    ct: org._creationTime,
    deleting: await deletionBegun(ctx, org.id),
    row:
      row === null
        ? null
        : {
            bytes: row.bytes,
            files: row.files,
            revision: row.revision,
            run: row.run ?? null,
            counting: row.counting?.through ?? null,
          },
  }
}

/** A page of organizations with their states. */
type OrgPage = { orgs: OrgState[]; cursor: string; done: boolean }

/** One page of organizations, in creation order, with their states. */
export const orgPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<OrgPage> => {
    const page = await ctx.db.query('organizations').paginate({ cursor, numItems: RUN.orgs })
    const orgs: OrgState[] = []
    for (const org of page.page) orgs.push(await stateOf(ctx, org))
    return { orgs, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One organization's state, as a dry run reads it after a count, or null
 * once it is gone. */
export const state = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgState | null> => {
    const org = await byId(ctx, 'organizations', org_id)
    return org === null ? null : await stateOf(ctx, org)
  },
})

/** A task whose id holds no row of the task that gives what its files
 * give. */
type TaskDiff = {
  task_id: string
  counted: Amount & { project_id: string }
  stored: (Amount & { org_id: string; num: number; project_id: string }) | null
}

/** One page of a dry count (check). */
type CheckPage = Amount & {
  through: number
  projects: (Amount & { project_id: string })[]
  differing: number
  differ: TaskDiff[]
}

/** Counts, without writing, the files of one page of the organization's
 * tasks numbered past `after`, per project, and the tasks whose id holds no
 * row of the task that gives them, as a step would count them. Null once
 * no task is numbered past `after`. */
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
      const held = row ?? { org_id, num: task.num, project_id: task.project_id, bytes: 0, files: 0 }
      const its = held.org_id === org_id && held.num === task.num
      if (its && same(held, files) && held.project_id === task.project_id) continue
      if (out.differing++ < COUNT_PAGE.listed)
        out.differ.push({
          task_id: task.id,
          counted: { project_id: task.project_id, bytes: files.bytes, files: files.files },
          stored:
            row === null
              ? null
              : {
                  org_id: row.org_id,
                  num: row.num,
                  project_id: row.project_id,
                  bytes: row.bytes,
                  files: row.files,
                },
        })
    }
    out.projects = [...projects].map(([project_id, sum]) => ({ project_id, ...sum }))
    return out
  },
})

/** A project totals row as a dry run compares it, with whether it still
 * has the project's name, when a copy of the project is left to tell. */
type ProjectRow = Amount & { project_id: string; named: boolean }

type ProjectRows = { rows: ProjectRow[]; cursor: string; done: boolean }

/** One page of the organization's project totals rows (ProjectRow). */
export const projectRows = internalQuery({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }): Promise<ProjectRows> => {
    const page = await ctx.db
      .query('storage_project_totals')
      .withIndex('by_org_bytes', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: COUNT_PAGE.projects })
    const rows: ProjectRow[] = []
    for (const row of page.page) {
      const name = await projectNameOf(ctx, row.project_id)
      rows.push({
        project_id: row.project_id,
        bytes: row.bytes,
        files: row.files,
        named: name === undefined || name === row.name,
      })
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
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
        for (const doc of [light, live]) if (doc !== null) taskBytes += getDocumentSize(doc)
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

/** A totals row of the stray check: its organization, its creation time,
 * which orders the page, and whether the organization is gone. */
type TotalsRow = { org_id: string; ct: number; stray: boolean }

type TotalsPage = { rows: TotalsRow[]; cursor: string; done: boolean }

/** One page of every organization's totals row (TotalsRow). */
export const totalsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<TotalsPage> => {
    const page = await ctx.db.query('storage_org_totals').paginate({ cursor, numItems: RUN.orgs })
    const rows: TotalsRow[] = []
    for (const row of page.page)
      rows.push({
        org_id: row.org_id,
        ct: row._creationTime,
        stray: (await byId(ctx, 'organizations', row.org_id)) === null,
      })
    return { rows, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One step of deleting the totals of organization `org_id`, which no
 * longer exists. Each step deletes up to COUNT_PAGE.drain of its task and
 * project rows, and the last its own row. Answers true once all are gone. Once an organization of
 * that id exists again it leaves them, also answering true, for that
 * organization's count to delete (model/storageTotals.ts startOrgTotals). */
export const clearStray = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<boolean> => {
    if ((await byId(ctx, 'organizations', org_id)) !== null) return true
    if (!(await clearRows(ctx, org_id))) return false
    const row = await orgTotalsRow(ctx, org_id)
    if (row !== null) await ctx.db.delete(row._id)
    return true
  },
})

/** Records a call that wrote, with its totals and the error it met, if
 * any. */
export const audit = internalMutation({
  args: {
    counted: v.number(),
    bytes: v.number(),
    files: v.number(),
    strays: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, totals) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'storage_totals_backfill',
      detail: totals,
    })
    return null
  },
})

const orgPageRef = makeFunctionReference<'query', { cursor: string | null }, OrgPage>(
  'internal/storageTotalsBackfill:orgPage',
)
const stateRef = makeFunctionReference<'query', { org_id: string }, OrgState | null>(
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
const totalsPageRef = makeFunctionReference<'query', { cursor: string | null }, TotalsPage>(
  'internal/storageTotalsBackfill:totalsPage',
)
const stepRef = makeFunctionReference<
  'mutation',
  { org_id: string; recount: boolean; run: string },
  Amount | 'skipped' | null
>('internal/storageTotalsBackfill:step')
const clearStrayRef = makeFunctionReference<'mutation', { org_id: string }, boolean>(
  'internal/storageTotalsBackfill:clearStray',
)
const auditRef = makeFunctionReference<
  'mutation',
  Amount & { counted: number; strays: number; error?: string },
  null
>('internal/storageTotalsBackfill:audit')

/** A project whose totals row does not give what its tasks' files give, or
 * no longer has the project's name. */
type ProjectDiff = { project_id: string; counted: Amount; stored: Amount | null; renamed?: true }

/** How many times a dry run counts an organization whose totals a write
 * changes while it counts. */
const DRY_TRIES = 3

/** Where a dry count of one organization stands. Its stages run one query
 * each. `tasks` counts the tasks past `after`. `projects` compares the
 * project rows from `page` with the counted `sums`, which it takes out as
 * it compares them, and ends by reading the organization's state again.
 * `orphans` checks its attachment rows from `page`, live and then `stored`,
 * `size` at a time. */
type DryCount = {
  before: OrgState
  tries: number
  stage: 'tasks' | 'projects' | 'orphans'
  after: number
  page: string | null
  stored: boolean
  size: number
  counted: Amount
  sums: [project_id: string, bytes: number, files: number][]
  projects: ProjectDiff[]
  projects_differing: number
  tasks: TaskDiff[]
  tasks_differing: number
  settled: boolean
  now: OrgState | null
}

/** A dry count of organization `org` from its start, try `tries`. */
const freshCount = (org: OrgState, tries: number): DryCount => ({
  before: org,
  tries,
  stage: 'tasks',
  after: START,
  page: null,
  stored: false,
  size: COUNT_PAGE.orphans,
  counted: { bytes: 0, files: 0 },
  sums: [],
  projects: [],
  projects_differing: 0,
  tasks: [],
  tasks_differing: 0,
  settled: false,
  now: null,
})

/** Where a call goes on: the run's id, the stage, the page it was in, by
 * the cursor that read it, the creation time of the last organization or
 * totals row of that page it finished, and a dry count it was inside. */
type Resume = {
  run: string
  phase: 'orgs' | 'strays'
  page: string | null
  after: number
  dry?: DryCount
}

/** One organization as a dry run lists it, with the totals its files give
 * and those it holds once counted. */
type OrgReport = Amount & { org_id: string; stored?: Amount }

/** A counted organization whose rows do not give what its files give. */
type OrgDiff = OrgReport & {
  projects_differing: number
  projects: ProjectDiff[]
  tasks_differing: number
  tasks: TaskDiff[]
}

/** What one call reports. */
type Report = Amount & {
  orgs: number
  counted: number
  differing: number
  to_count: OrgReport[]
  differ: OrgDiff[]
  unsettled: number
  unsettled_orgs: string[]
  skipped: number
  skipped_orgs: string[]
  orphan_rows: number
  orphan_bytes: number
  orphans: (Orphan & { org_id: string })[]
  strays: number
  stray_orgs: string[]
}

/* Runs one query of dry count `d` of organization `orgId`, adding the
 * orphans it finds to `report`. Answers true once the count is done. */
async function dryStep(
  ctx: Pick<ActionCtx, 'runQuery'>,
  orgId: string,
  d: DryCount,
  report: Report,
): Promise<boolean> {
  if (d.stage === 'tasks') {
    const got = await ctx.runQuery(checkRef, { org_id: orgId, after: d.after })
    if (got === null) {
      d.stage = 'projects'
      d.page = null
      return false
    }
    const sums = new Map(d.sums.map(([id, bytes, files]) => [id, { bytes, files }]))
    for (const p of got.projects) addTo(sums, p.project_id, p)
    d.sums = [...sums].map(([id, sum]) => [id, sum.bytes, sum.files])
    d.counted.bytes += got.bytes
    d.counted.files += got.files
    d.tasks_differing += got.differing
    d.tasks.push(...got.differ.slice(0, Math.max(0, COUNT_PAGE.listed - d.tasks.length)))
    d.after = got.through
    return false
  }
  if (d.stage === 'projects') {
    const page = await ctx.runQuery(projectRowsRef, { org_id: orgId, cursor: d.page })
    const sums = new Map(d.sums.map(([id, bytes, files]) => [id, { bytes, files }]))
    const differ = (diff: ProjectDiff) => {
      if (d.projects_differing++ < COUNT_PAGE.listed) d.projects.push(diff)
    }
    for (const row of page.rows) {
      const counted = sums.get(row.project_id) ?? { bytes: 0, files: 0 }
      sums.delete(row.project_id)
      if (same(row, counted) && row.named) continue
      differ({
        project_id: row.project_id,
        counted,
        stored: { bytes: row.bytes, files: row.files },
        ...(row.named ? {} : { renamed: true as const }),
      })
    }
    d.sums = [...sums].map(([id, sum]) => [id, sum.bytes, sum.files])
    if (!page.done) {
      d.page = page.cursor
      return false
    }
    for (const [project_id, bytes, files] of d.sums)
      if (files > 0) differ({ project_id, counted: { bytes, files }, stored: null })
    d.sums = []
    const now = await ctx.runQuery(stateRef, { org_id: orgId })
    // stateOf builds both, so their keys come in the same order, and the
    // revision only rises, so a change undone before the end still shows
    d.settled = now !== null && JSON.stringify(now) === JSON.stringify(d.before)
    if (!d.settled && now !== null && d.tries < DRY_TRIES) {
      Object.assign(d, freshCount(now, d.tries + 1))
      return false
    }
    d.now = now
    d.stage = 'orphans'
    d.page = null
    return false
  }
  const page = await ctx.runQuery(orphanPageRef, {
    org_id: orgId,
    stored: d.stored,
    cursor: d.page,
    size: d.size,
  })
  if ('split' in page) {
    d.size = page.split
    return false
  }
  for (const orphan of page.orphans) {
    report.orphan_rows += 1
    report.orphan_bytes += orphan.size_bytes
    if (report.orphans.length < COUNT_PAGE.listed) report.orphans.push({ org_id: orgId, ...orphan })
  }
  d.size = COUNT_PAGE.orphans
  if (!page.done) {
    d.page = page.cursor
    return false
  }
  if (d.stored) return true
  d.stored = true
  d.page = null
  return false
}

/** Lists finished dry count `d` of organization `orgId` in `report`;
 * `due` tells whether a real run would count it. */
function reportDry(report: Report, orgId: string, d: DryCount, due: boolean): void {
  const row = d.now?.row ?? null
  const entry: OrgReport = { org_id: orgId, ...d.counted }
  if (!d.settled) {
    if (report.unsettled++ < COUNT_PAGE.listed) report.unsettled_orgs.push(orgId)
  } else if (row !== null && row.counting === null) {
    entry.stored = { bytes: row.bytes, files: row.files }
    const matches =
      same(entry.stored, d.counted) && d.projects_differing === 0 && d.tasks_differing === 0
    if (!matches && report.differing++ < COUNT_PAGE.listed)
      report.differ.push({
        ...entry,
        projects_differing: d.projects_differing,
        projects: d.projects,
        tasks_differing: d.tasks_differing,
        tasks: d.tasks,
      })
  }
  if (!due) return
  report.counted++
  report.bytes += d.counted.bytes
  report.files += d.counted.files
  if (report.to_count.length < COUNT_PAGE.listed) report.to_count.push(entry)
}

/** A fresh call's report. */
const emptyReport = (): Report => ({
  orgs: 0,
  counted: 0,
  bytes: 0,
  files: 0,
  differing: 0,
  to_count: [],
  differ: [],
  unsettled: 0,
  unsettled_orgs: [],
  skipped: 0,
  skipped_orgs: [],
  orphan_rows: 0,
  orphan_bytes: 0,
  orphans: [],
  strays: 0,
  stray_orgs: [],
})

/** Counts every organization not counted yet, or every one with
 * `recount`, from `cursor` on, then deletes the strays, and answers how
 * many it counted and their totals. Before each step and each page it
 * checks RUN.ms, and past it answers the `cursor` to go on from, else
 * `done`. A call always takes one step first, so it moves on however late
 * it starts. A dry run writes nothing. It counts each organization's files
 * (dryStep), answers the same totals for those it would count, lists up to
 * COUNT_PAGE.listed of them, and lists the organizations counted already
 * whose organization, project or task rows their files do not give, or
 * whose project rows have another name than their project (`differ`,
 * `differing` in all), with up to COUNT_PAGE.listed of each kind of row.
 * An organization whose totals kept changing through every count is listed
 * in `unsettled_orgs` (`unsettled` in all) instead, for a later dry run. A
 * dry run also counts the attachment rows whose task is gone
 * (`orphan_rows`, `orphan_bytes`) and lists up to COUNT_PAGE.listed of them
 * (`orphans`), and the totals rows of organizations that no longer exist
 * (`strays`, `stray_orgs`), which a real run deletes. Both list the
 * organizations whose deletion has begun in `skipped_orgs` (`skipped` in
 * all). An error ends the call with `error`, the cursor of the organization
 * it failed on and what it did before. A call that is no dry run ends with
 * its audit row, also after an error. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, { dry_run, recount = false, cursor }) => {
    const until = Date.now() + RUN.ms
    const at: Resume =
      cursor === undefined
        ? { run: newUuid(), phase: 'orgs', page: null, after: 0 }
        : (JSON.parse(cursor) as Resume)
    const report = emptyReport()
    const skip = (orgId: string) => {
      if (report.skipped++ < COUNT_PAGE.listed) report.skipped_orgs.push(orgId)
    }
    // Past RUN.ms a call reads no further page once it has read one or
    // taken a step, and takes no further step once it has taken one, so
    // each call moves on by at least a page or a step.
    let read = false
    let stepped = false
    const past = () => Date.now() >= until
    const lateForPage = () => (read || stepped) && past()
    const lateForStep = () => stepped && past()
    let done = false
    let error: string | undefined
    try {
      work: for (;;) {
        if (lateForPage()) break
        if (at.phase === 'orgs') {
          const page: OrgPage = await ctx.runQuery(orgPageRef, { cursor: at.page })
          read = true
          for (const org of page.orgs) {
            if (org.ct <= at.after) continue
            if (org.deleting) skip(org.org_id)
            else if (!dry_run) {
              const ours = org.row?.run === at.run && org.row.counting === null
              if (org.row === null || org.row.counting !== null || (recount && !ours)) {
                let got: Amount | 'skipped' | null = null
                while (got === null) {
                  if (lateForStep()) break work
                  got = await ctx.runMutation(stepRef, {
                    org_id: org.org_id,
                    recount,
                    run: at.run,
                  })
                  stepped = true
                }
                if (got === 'skipped') skip(org.org_id)
                else {
                  report.counted++
                  report.bytes += got.bytes
                  report.files += got.files
                }
              }
            } else {
              // a dry count the cursor carries is this organization's, unless
              // the one it was inside is gone
              if (at.dry?.before.org_id !== org.org_id) at.dry = freshCount(org, 1)
              for (;;) {
                if (lateForStep()) break work
                const finished = await dryStep(ctx, org.org_id, at.dry, report)
                stepped = true
                if (finished) break
              }
              const due = org.row === null || org.row.counting !== null || recount
              reportDry(report, org.org_id, at.dry, due)
              at.dry = undefined
            }
            report.orgs++
            at.after = org.ct
          }
          if (page.done) Object.assign(at, { phase: 'strays', page: null, after: 0 })
          else Object.assign(at, { page: page.cursor, after: 0 })
          continue
        }
        const page: TotalsPage = await ctx.runQuery(totalsPageRef, { cursor: at.page })
        read = true
        for (const row of page.rows) {
          if (row.ct <= at.after) continue
          if (row.stray) {
            // a dry run lists a stray, a run deletes it in steps
            for (let cleared = dry_run; !cleared; ) {
              if (lateForStep()) break work
              cleared = await ctx.runMutation(clearStrayRef, { org_id: row.org_id })
              stepped = true
            }
            if (report.strays++ < COUNT_PAGE.listed) report.stray_orgs.push(row.org_id)
          }
          at.after = row.ct
        }
        if (page.done) {
          done = true
          break
        }
        Object.assign(at, { page: page.cursor, after: 0 })
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        counted: report.counted,
        bytes: report.bytes,
        files: report.files,
        strays: report.strays,
        ...(error === undefined ? {} : { error }),
      })
    return {
      dry_run,
      ...report,
      ...(error === undefined ? {} : { error }),
      done,
      cursor: done ? null : JSON.stringify(at),
    }
  },
})
