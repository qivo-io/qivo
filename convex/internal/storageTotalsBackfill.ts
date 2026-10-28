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
 * runs. The step that finds no task past `through` ends the count. Rows
 * are found by organization, id and number (model/storageTotals.ts), so a
 * count writes only its own organization's rows of each task's and
 * project's number. A row another task or project of the same id left,
 * here or in another organization, is a row of its own that the count
 * never reads. A recount deletes the stale rows of its organization before
 * it counts, and the stray check those of an organization that is gone.
 *
 * A file counts in its task's project. An attachment row whose task is in
 * neither issues nor deleted_tasks counts nowhere, as in the billing sample
 * today. The dry run lists such rows, and nothing here deletes them.
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
 * inside its count. Organizations and totals rows are read in the order of
 * their organization's id, which no two share, so the cursor names the last
 * one finished and no tie can hide another. Call it again with the same
 * arguments and `"cursor"` set to it until `done` is true. Each call reports
 * what it went through. A call that meets an error answers it in `error`,
 * with the cursor of the organization it failed on and what it counted
 * before.
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
  addToProject,
  orgTotalsRow,
  type ProjectKey,
  projectOf,
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

/** Organizations, or totals rows of the stray check, one page reads, in
 * the order of their organization's id, and how long one call of run goes
 * on before it answers where to go on from. Tests lower them. */
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

/** One task as a count found it, with its own row, if it has one. */
type Counted = { task: Task; files: Amount; row: Doc<'storage_task_totals'> | null }

/* Counts the files of the tasks of `page` in number order, ending early
 * between two numbers once the rows read pass COUNT_PAGE.fileBytes or the
 * transaction passes COUNT_PAGE.room of a limit. Answers each task with its
 * own row and the number counted through. */
async function countTasks(
  ctx: QueryCtx,
  orgId: string,
  page: { tasks: Task[]; through: number },
): Promise<{ counted: Counted[]; through: number }> {
  const counted: Counted[] = []
  let read = 0
  for (const [i, task] of page.tasks.entries()) {
    const files = await filesOf(ctx, orgId, task.id)
    const row = await taskTotalsRow(ctx, orgId, task.id, task.num)
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

/** A project's totals as a count adds them up, keyed by projectKey. */
type ProjectSum = Amount & { project_id: string; num?: number }

/* The key of project `projectId` numbered `num` in a map of ProjectSum. */
const projectKey = (projectId: string, num: number | undefined): string =>
  `${projectId}:${num ?? ''}`

/* Adds `by` to the entry of project `projectId` numbered `num` in `sums`. */
function addTo(
  sums: Map<string, ProjectSum>,
  projectId: string,
  num: number | undefined,
  by: Amount,
): void {
  const key = projectKey(projectId, num)
  const sum = sums.get(key) ?? { project_id: projectId, num, bytes: 0, files: 0 }
  sum.bytes += by.bytes
  sum.files += by.files
  sums.set(key, sum)
}

/* Project `projectId` of organization `orgId` as projectOf finds it, read
 * once per call through `known`. */
async function projectIn(
  ctx: QueryCtx,
  known: Map<string, ProjectKey>,
  orgId: string,
  projectId: string,
): Promise<ProjectKey> {
  let project = known.get(projectId)
  if (project === undefined) {
    project = await projectOf(ctx, orgId, projectId)
    known.set(projectId, project)
  }
  return project
}

/* Deletes up to COUNT_PAGE.drain of the organization's task and project
 * totals rows. True once none is left. */
async function clearRows(ctx: MutationCtx, orgId: string): Promise<boolean> {
  let left = COUNT_PAGE.drain
  const reads = [
    () =>
      ctx.db
        .query('storage_task_totals')
        .withIndex('by_org_issue', (q) => q.eq('org_id', orgId))
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
    const known = new Map<string, ProjectKey>()
    const projects = new Map<string, ProjectSum>()
    const total = { bytes: org.bytes, files: org.files }
    for (const { task, files, row } of counted) {
      // a task's row exists only once it counts, so this is its first
      // count; a row held anyway is replaced and its files moved on
      if (row !== null) {
        addTo(projects, row.project_id, row.project_num, negated(row))
        total.bytes -= row.bytes
        total.files -= row.files
      }
      const project = await projectIn(ctx, known, org_id, task.project_id)
      addTo(projects, task.project_id, project.num, files)
      total.bytes += files.bytes
      total.files += files.files
      const fields = {
        project_id: task.project_id,
        project_num: project.num,
        bytes: files.bytes,
        files: files.files,
      }
      if (files.files > 0 && row !== null) await ctx.db.patch(row._id, fields)
      else if (files.files > 0)
        await uncountedWriter(ctx.db).insert('storage_task_totals', {
          org_id,
          issue_id: task.id,
          num: task.num,
          ...fields,
        })
      else if (row !== null) await ctx.db.delete(row._id)
    }
    for (const { project_id, num, ...by } of projects.values()) {
      const project = await projectIn(ctx, known, org_id, project_id)
      await addToProject(
        ctx,
        org_id,
        project_id,
        num,
        by,
        project.num === num ? project.name : undefined,
      )
    }
    await ctx.db.patch(org._id, { ...total, revision: org.revision + 1, counting: { through } })
    return null
  },
})

/** An organization as a run reads it: whether its deletion has begun, and
 * its totals row, null before a count, with `counting` while one runs. */
type OrgState = {
  org_id: string
  deleting: boolean
  row: (Amount & { revision: number; run: string | null; counting: number | null }) | null
}

/** The state of organization `orgId` (OrgState). */
async function stateOf(ctx: QueryCtx, orgId: string): Promise<OrgState> {
  const row = await orgTotalsRow(ctx, orgId)
  return {
    org_id: orgId,
    deleting: await deletionBegun(ctx, orgId),
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
type OrgPage = { orgs: OrgState[]; done: boolean }

/** Up to RUN.orgs organizations whose id comes after `after`, in id order,
 * with their states. */
export const orgPage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }): Promise<OrgPage> => {
    const page = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => (after === null ? q : q.gt('id', after)))
      .take(RUN.orgs)
    const orgs: OrgState[] = []
    for (const org of page) orgs.push(await stateOf(ctx, org.id))
    return { orgs, done: page.length < RUN.orgs }
  },
})

/** One organization's state, as a dry run reads it after a count, or null
 * once it is gone. */
export const state = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<OrgState | null> =>
    (await byId(ctx, 'organizations', org_id)) === null ? null : await stateOf(ctx, org_id),
})

/** A task whose own row does not give what its files give. */
type TaskDiff = {
  task_id: string
  num: number
  counted: Amount & { project_id: string; project_num?: number }
  stored: (Amount & { project_id: string; project_num?: number }) | null
}

/** One page of a dry count (check). */
type CheckPage = Amount & {
  through: number
  projects: ProjectSum[]
  differing: number
  differ: TaskDiff[]
}

/** Counts, without writing, the files of one page of the organization's
 * tasks numbered past `after`, per project and project number, and the
 * tasks whose own row does not give them, as a step would count them. Null
 * once no task is numbered past `after`. */
export const check = internalQuery({
  args: { org_id: v.string(), after: v.number() },
  handler: async (ctx, { org_id, after }): Promise<CheckPage | null> => {
    const page = await taskPage(ctx, org_id, after)
    if (page === null) return null
    const { counted, through } = await countTasks(ctx, org_id, page)
    const known = new Map<string, ProjectKey>()
    const projects = new Map<string, ProjectSum>()
    const out: CheckPage = { bytes: 0, files: 0, through, projects: [], differing: 0, differ: [] }
    for (const { task, files, row } of counted) {
      const project = await projectIn(ctx, known, org_id, task.project_id)
      addTo(projects, task.project_id, project.num, files)
      out.bytes += files.bytes
      out.files += files.files
      const where = { project_id: task.project_id, project_num: project.num }
      const held = row ?? { ...where, bytes: 0, files: 0 }
      if (
        same(held, files) &&
        held.project_id === where.project_id &&
        held.project_num === where.project_num
      )
        continue
      if (out.differing++ < COUNT_PAGE.listed)
        out.differ.push({
          task_id: task.id,
          num: task.num,
          counted: { ...where, bytes: files.bytes, files: files.files },
          stored:
            row === null
              ? null
              : {
                  project_id: row.project_id,
                  project_num: row.project_num,
                  bytes: row.bytes,
                  files: row.files,
                },
        })
    }
    out.projects = [...projects.values()]
    return out
  },
})

/** A project totals row as a dry run compares it, with whether it still
 * has the name of the project of its number, when a copy of that project is
 * left to tell. */
type ProjectRow = ProjectSum & { named: boolean }

type ProjectRows = { rows: ProjectRow[]; cursor: string; done: boolean }

/** One page of the organization's project totals rows (ProjectRow). */
export const projectRows = internalQuery({
  args: { org_id: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { org_id, cursor }): Promise<ProjectRows> => {
    const page = await ctx.db
      .query('storage_project_totals')
      .withIndex('by_org_bytes', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: COUNT_PAGE.projects })
    const known = new Map<string, ProjectKey>()
    const rows: ProjectRow[] = []
    for (const row of page.page) {
      const project = await projectIn(ctx, known, org_id, row.project_id)
      rows.push({
        project_id: row.project_id,
        num: row.num,
        bytes: row.bytes,
        files: row.files,
        named: project.num !== row.num || project.name === row.name,
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

/** An organization's totals row as the stray check reads it: its
 * organization, and whether that organization is gone. */
type TotalsRow = { org_id: string; stray: boolean }

type TotalsPage = { rows: TotalsRow[]; done: boolean }

/** Up to RUN.orgs organization totals rows whose organization id comes
 * after `after`, in that order (TotalsRow). */
export const totalsPage = internalQuery({
  args: { after: v.union(v.string(), v.null()) },
  handler: async (ctx, { after }): Promise<TotalsPage> => {
    const page = await ctx.db
      .query('storage_org_totals')
      .withIndex('by_org', (q) => (after === null ? q : q.gt('org_id', after)))
      .take(RUN.orgs)
    const rows: TotalsRow[] = []
    for (const row of page)
      rows.push({
        org_id: row.org_id,
        stray: (await byId(ctx, 'organizations', row.org_id)) === null,
      })
    return { rows, done: page.length < RUN.orgs }
  },
})

/** One step of deleting the totals of organization `org_id`, which no
 * longer exists. Each step deletes up to COUNT_PAGE.drain of its task and
 * project rows, and the last its own row. Answers true once all are gone.
 * Once an organization of that id exists again it leaves them, also
 * answering true, for that organization's count to delete
 * (model/storageTotals.ts startOrgTotals). */
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

const orgPageRef = makeFunctionReference<'query', { after: string | null }, OrgPage>(
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
const totalsPageRef = makeFunctionReference<'query', { after: string | null }, TotalsPage>(
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
type ProjectDiff = {
  project_id: string
  num?: number
  counted: Amount
  stored: Amount | null
  renamed?: true
}

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
  sums: ProjectSum[]
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

/** Where a call goes on: the run's id, the stage, the id of the last
 * organization, or of the organization of the last totals row, it
 * finished, and a dry count it was inside. */
type Resume = {
  run: string
  phase: 'orgs' | 'strays'
  after: string | null
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
    const sums = new Map(d.sums.map((sum) => [projectKey(sum.project_id, sum.num), sum]))
    for (const p of got.projects) addTo(sums, p.project_id, p.num, p)
    d.sums = [...sums.values()]
    d.counted.bytes += got.bytes
    d.counted.files += got.files
    d.tasks_differing += got.differing
    d.tasks.push(...got.differ.slice(0, Math.max(0, COUNT_PAGE.listed - d.tasks.length)))
    d.after = got.through
    return false
  }
  if (d.stage === 'projects') {
    const page = await ctx.runQuery(projectRowsRef, { org_id: orgId, cursor: d.page })
    const sums = new Map(d.sums.map((sum) => [projectKey(sum.project_id, sum.num), sum]))
    const differ = (diff: ProjectDiff) => {
      if (d.projects_differing++ < COUNT_PAGE.listed) d.projects.push(diff)
    }
    for (const row of page.rows) {
      const key = projectKey(row.project_id, row.num)
      const counted = sums.get(key) ?? {
        project_id: row.project_id,
        num: row.num,
        bytes: 0,
        files: 0,
      }
      sums.delete(key)
      if (same(row, counted) && row.named) continue
      differ({
        project_id: row.project_id,
        num: row.num,
        counted: { bytes: counted.bytes, files: counted.files },
        stored: { bytes: row.bytes, files: row.files },
        ...(row.named ? {} : { renamed: true as const }),
      })
    }
    d.sums = [...sums.values()]
    if (!page.done) {
      d.page = page.cursor
      return false
    }
    for (const { project_id, num, bytes, files } of d.sums)
      if (files > 0) differ({ project_id, num, counted: { bytes, files }, stored: null })
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
        ? { run: newUuid(), phase: 'orgs', after: null }
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
          const page: OrgPage = await ctx.runQuery(orgPageRef, { after: at.after })
          read = true
          for (const org of page.orgs) {
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
            at.after = org.org_id
          }
          if (page.done) Object.assign(at, { phase: 'strays', after: null })
          continue
        }
        const page: TotalsPage = await ctx.runQuery(totalsPageRef, { after: at.after })
        read = true
        for (const row of page.rows) {
          if (row.stray) {
            // a dry run lists a stray, a run deletes it in steps
            for (let cleared = dry_run; !cleared; ) {
              if (lateForStep()) break work
              cleared = await ctx.runMutation(clearStrayRef, { org_id: row.org_id })
              stepped = true
            }
            if (report.strays++ < COUNT_PAGE.listed) report.stray_orgs.push(row.org_id)
          }
          at.after = row.org_id
        }
        if (page.done) {
          done = true
          break
        }
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
