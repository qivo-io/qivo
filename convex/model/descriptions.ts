/* Task descriptions in issue_descriptions (schema.ts), one row per live
 * task beside its issues row. Every insert of a task row and every write of
 * a task's description, project or archived state goes through this file,
 * in the transaction that writes the task, so the copies stay equal, and
 * only this file writes issue_descriptions. scripts/check-task-writes.mjs
 * fails on any other such write.
 *
 * In this release, the third and last of the move, the description row is
 * the only source of a task's text. Every reader takes it from the task's
 * first description row in creation order that holds the task's copies,
 * else from its first row (descriptionOf, withText, descriptionsOf), and
 * only a task without a row, which internal/descriptionsBackfill has not
 * reached, reads issues.description. Only this file reads either copy for
 * a reader, and scripts/check-task-reads.mjs fails on any other read of
 * issues.description. Writers write the text to the row alone. A create
 * inserts the task row without it (insertTask), a description write unsets
 * the copy the task row may still hold (patchTask), and a move or an
 * archive gives the row the text readers showed before it. No other write
 * unsets the copy. The backfill's clear unsets the copies the releases
 * before wrote, only where the task's one row holds the same text
 * (clearTaskCopy). The second release, v0.1.98, is the rollback floor. It
 * reads the rows too, and its writers write copies equal to the rows
 * again, which the next clear unsets. A release before it reads only issues.description, so it
 * shows no text for a task this release wrote, edited or cleared.
 *
 * A write that changes or checks a task's description passes the task with
 * its text (withText) as its before and after documents, and every other
 * write passes the stored rows on both sides, so the activity diff, the
 * mention diff and a webhook's changed fields (textsOf) see a description
 * change only where a write made one, whether or not the task row still
 * holds a copy.
 *
 * A row names its task and copies its organization, project and archived
 * state, so main Search can filter descriptions by them (schema.ts
 * search_description). Every write of a row writes the copies from the
 * task, and every change of a task's project or archived state goes through
 * patchTask, which brings the copies of its row in line in the same
 * transaction. A task without a row, which the backfill has not reached,
 * gets none from such a change; the backfill inserts it with its copies. A
 * create may choose the id of a task deleted for good before used_ids
 * recorded it (schema.ts), also in another organization, so a write that
 * finds a row for its task resets its text and every copy (putDescription),
 * and an organization's teardown never takes another's row.
 *
 * Deleted items stores a task with its text (withDescription), which reads
 * the task's row only once the task row holds no copy, and its steps
 * delete the description row with the task's messages
 * (model/deletedItems.ts).
 *
 * In a public demo a description row spends none of the visitor's record
 * limit (lib/demo.ts uncountedWriter), because it is part of its task,
 * which counts once. */

import type { TransactionMetrics, WithoutSystemFields } from 'convex/server'
import { type ConvexError, getDocumentSize } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
// a type only: lib/archivedTasks.ts imports this module, so a value import
// would make a cycle that leaves its constants unset while it loads
import type { ReadCeiling } from '../lib/archivedTasks'
import { insertUnique, insertUsed } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import type { Refusal } from '../lib/functions'
import { DOCUMENT_MAX_BYTES } from './comments'

type Reader = QueryCtx['db']
type Writer = MutationCtx['db']

/** A task with its text (descriptionOf) in `description`, in memory only,
 * as a write that changes or checks the description passes it on. */
export type TaskWithText = Doc<'issues'> & { description: string }

/** A task as a reader of its text knows it: its id, the copies its rows
 * hold, and issues.description, the text of a task without a row. */
type TextOwner = Owner & Pick<Doc<'issues'>, 'description'>

/* The description row readers take for task `task`: of its first two rows
 * in creation order, the first that holds the task's copies (holdsCopies),
 * else its first row, or null for a task without one. Every writer keeps
 * the copies on the first row (patchTask), so that is the first row, unless
 * a rollback left the first row's copies stale beside a second row; then
 * this is the row the active range of the task's project holds too
 * (projectTextReader), so every reader takes the same one. It reads two rows at
 * most, so TEXT_DOCUMENTS is a true bound. A task with three or more rows,
 * which repeated rollbacks leave and internal/descriptionsBackfill reports
 * as a duplicate, may read differently there when only a later row holds
 * the copies. */
async function shownRow(db: Reader, task: Owner): Promise<Doc<'issue_descriptions'> | null> {
  const rows = await firstRows(db, task.id)
  return rows.find((row) => holdsCopies(row, task)) ?? rows[0] ?? null
}

/** The first two description rows of task `issueId` in creation order, as
 * shownRow and patchTask read them, in one by_issue range of two documents
 * at most. */
export const firstRows = (db: Reader, issueId: string): Promise<Doc<'issue_descriptions'>[]> =>
  db
    .query('issue_descriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .take(2)

/** The text of task `task` as readers show it: the text of its description
 * row (shownRow), else issues.description for a task the backfill has not
 * given a row, else ''. One by_issue range and one document, two when a
 * rollback left the first row's copies stale. */
export async function descriptionOf(db: Reader, task: TextOwner): Promise<string> {
  return (await shownRow(db, task))?.description ?? task.description ?? ''
}

/** The text readers show for `task` (descriptionOf), and whether its task
 * row holds a different one, which only a rollback leaves: a release from
 * before the table that changed issues.description without the row. Only
 * internal/descriptionsBackfill's repair then takes the task row's text, so
 * a tool that rewrites the text it read from the row would lose that edit;
 * it leaves such a task to the repair. It reads as descriptionOf does. */
export async function textCopiesOf(
  db: Reader,
  task: TextOwner,
): Promise<{ text: string; differs: boolean }> {
  const row = await shownRow(db, task)
  return {
    text: row?.description ?? task.description ?? '',
    differs: row !== null && task.description !== undefined && task.description !== row.description,
  }
}

/** `task` with its text (descriptionOf) in `description`, in memory only.
 * The cores that pass whole task documents on use it, for a write that
 * changes or checks the description. It writes nothing; Deleted items
 * stores a task through withDescription instead. */
export async function withText(db: Reader, task: Doc<'issues'>): Promise<TaskWithText> {
  return { ...task, description: await descriptionOf(db, task) }
}

/* The documents one task's text can read at Convex's document size limit:
 * its first row and, when that row's copies are stale, the next (shownRow). */
const TEXT_DOCUMENTS = 2

/* How many tasks' texts, each one index range and TEXT_DOCUMENTS documents
 * at Convex's document size limit, the reads left under `limit` can hold. */
const textsLeft = (m: TransactionMetrics, limit: ReadCeiling): number =>
  Math.min(
    limit.ranges - m.databaseQueries.used,
    Math.floor((limit.documents - m.documentsRead.used) / TEXT_DOCUMENTS),
    Math.floor((limit.bytes - m.bytesRead.used) / (TEXT_DOCUMENTS * DOCUMENT_MAX_BYTES)),
  )

/** The texts of `tasks` (descriptionOf) by task id, or null when `room` ran
 * out before every one was read. `room` and `steps` are the transaction's
 * totals the reads keep to (ctx.meta.getTransactionMetrics), every document
 * a caller read before counted. It reads a few texts at a time, never more
 * than the ranges, documents and bytes left under `room` could hold with
 * each text at TEXT_DOCUMENTS of Convex's document size limit, and none
 * once the reads have passed `room`. By default `steps` is `room`, so the
 * reads never pass it. A caller whose budget a step may pass, as a
 * workspace part's may, gives Convex's own limits less a reserve as
 * `steps`: while the reads are under `room` a step then reads at least one
 * text, never more than the reads left under `steps` could hold, so the
 * reads pass `room` by one task's text at most and never pass `steps`. Each
 * caller keeps its own answer once the room runs out: a cut window, a
 * refusal or a shorter page. */
export async function descriptionsOf(
  ctx: QueryCtx,
  tasks: readonly TextOwner[],
  room: ReadCeiling,
  steps: ReadCeiling = room,
): Promise<Map<string, string> | null> {
  const out = new Map<string, string>()
  for (let at = 0; at < tasks.length; ) {
    const m = await ctx.meta.getTransactionMetrics()
    if (
      m.databaseQueries.used > room.ranges ||
      m.documentsRead.used > room.documents ||
      m.bytesRead.used > room.bytes
    )
      return null
    const fits = Math.min(textsLeft(m, steps), Math.max(1, textsLeft(m, room)))
    if (fits <= 0) return null
    const step = tasks.slice(at, at + fits)
    const texts = await Promise.all(step.map((task) => descriptionOf(ctx.db, task)))
    for (const [i, task] of step.entries()) out.set(task.id, texts[i])
    at += step.length
  }
  return out
}

/* How many new rows one step of a project's range reads at most
 * (projectTextReader), so a step reads little past the rows a page needs. */
const TEXT_RANGE_ROWS = 64

/* How many bytes of new rows a step reads at most once the task the page
 * waits on is in another project (projectTextReader): 64 rows of 4 KiB, so
 * small rows are read ahead in one range and large ones are not. */
const TEXT_AHEAD_BYTES = 256 * 1024

/** What one step of a projectTextReader did: read a chunk of rows, found
 * the first task without a text in no range, which the caller reads on its
 * own, found every task with a text, or found no room. */
export type RangeStep = 'read' | 'missing' | 'done' | 'full'

/** A reader that adds to `texts` the text of each of `tasks`, in the order
 * the caller answers them, that the active description rows of its project
 * hold (by_project_archived). A caller that needs most of a project's rows
 * so pays a range a chunk of rows rather than one a task; one that needs a
 * few reads them through descriptionsOf instead. Each step reads from the
 * project of the first of `tasks` still without a text, going on where that
 * project's last step ended. Each time that task gets its text the step
 * asks `enough`, the caller's test of whether its page is complete, and
 * ends when it is, else it reads on for the next task without a text. A
 * step ends after TEXT_RANGE_ROWS new rows at most, and once that next task
 * is in another project, as soon as its new rows hold TEXT_AHEAD_BYTES. So
 * the reads follow the tasks' order across projects and stop at the page,
 * and a list whose projects alternate still reads its small rows many to a
 * range rather than one. Of a task's rows the first in the range that holds
 * its copies is the one shownRow takes.
 *
 * A project's range starts at the earliest creation time of the project's
 * tasks among `tasks`, which list order need not follow (a restored task
 * keeps its created_at and gets a new creation time). Every row of a task is
 * created in the transaction that inserts the task or later: insertTask
 * writes it after the task row, patchTask and the backfill insert or patch
 * the rows a task has, and a Deleted items restore inserts the task anew
 * once the item's steps deleted its rows. So the range holds every row of
 * the tasks it is read for, and skips the rows of the tasks before them,
 * which a caller read one by one. Only a row left by a task deleted for good
 * before used_ids recorded its id could be older, if a create took that id
 * (schema.ts issue_descriptions), or a second row a Deleted items step left
 * (withDescription), if a restore took it. A task whose project's range
 * ends without a row holding its copies, such as those, one without a row
 * or one whose rows' copies are stale, which only a rollback leaves, is
 * `missing`, for the caller to read on its own.
 *
 * A step is one index range, read a row at a time, and it checks `room`
 * before the range and as its rows add up, so it passes `room` by one row
 * at most. */
export function projectTextReader(
  ctx: QueryCtx,
  tasks: readonly (TextOwner & Pick<Doc<'issues'>, '_creationTime'>)[],
  room: ReadCeiling,
  texts: Map<string, string>,
): { step(enough: () => boolean): Promise<RangeStep> } {
  const wanted = new Map(tasks.map((task) => [task.id, task]))
  // where each project's range starts: its tasks' earliest creation time
  const starts = new Map<string, number>()
  for (const task of tasks)
    starts.set(
      task.project_id,
      Math.min(starts.get(task.project_id) ?? task._creationTime, task._creationTime),
    )
  // where each project's range goes on from: the creation time read
  // through, the rows of that time read already, and whether it ended
  const ranges = new Map<
    string,
    { from: number; seen: Set<Id<'issue_descriptions'>>; done: boolean }
  >()
  // tasks before `next` have a text
  let next = 0
  return {
    async step(enough) {
      while (next < tasks.length && texts.has(tasks[next].id)) next++
      // the task the step reads for, and the project it reads
      let first = tasks[next]
      if (first === undefined) return 'done'
      const project = first.project_id
      let range = ranges.get(project)
      if (range === undefined) {
        range = { from: starts.get(project) ?? first._creationTime, seen: new Set(), done: false }
        ranges.set(project, range)
      }
      if (range.done) return 'missing'
      const m = await ctx.meta.getTransactionMetrics()
      if (room.ranges - m.databaseQueries.used < 1) return 'full'
      // the rows the reads left under `room` hold at Convex's size limit,
      // counted down and asked again once spent
      let allowance = 0
      const spend = async (): Promise<boolean> => {
        if (--allowance >= 0) return true
        const now = await ctx.meta.getTransactionMetrics()
        allowance = Math.min(
          room.documents - now.documentsRead.used,
          Math.floor((room.bytes - now.bytesRead.used) / DOCUMENT_MAX_BYTES),
        )
        return allowance-- > 0
      }
      if (!(await spend())) return 'full'
      const { from, seen } = range
      const read = ctx.db
        .query('issue_descriptions')
        .withIndex('by_project_archived', (q) =>
          q.eq('project_id', project).eq('archived_at', undefined).gte('_creationTime', from),
        )
      // the rows at the last new row's time, which the next step starts with
      let last: number | undefined
      let tied: Id<'issue_descriptions'>[] = []
      let fresh = 0
      let bytes = 0
      /* where the next step of this project goes on from */
      const pause = () => {
        if (last === undefined) return
        range.seen = new Set([...(last === from ? seen : []), ...tied])
        range.from = last
      }
      for await (const row of read) {
        if (!seen.has(row._id)) {
          const task = wanted.get(row.issue_id)
          if (task !== undefined && !texts.has(task.id) && holdsCopies(row, task))
            texts.set(task.id, row.description)
          if (row._creationTime !== last) tied = []
          last = row._creationTime
          tied.push(row._id)
          bytes += getDocumentSize(row)
          if (texts.has(first.id)) {
            while (next < tasks.length && texts.has(tasks[next].id)) next++
            const following = tasks[next]
            if (following === undefined || enough()) {
              pause()
              return 'read'
            }
            first = following
          }
          // past the rows the page waits on, the step reads ahead small rows
          if (
            ++fresh >= TEXT_RANGE_ROWS ||
            (first.project_id !== project && bytes >= TEXT_AHEAD_BYTES)
          ) {
            pause()
            return 'read'
          }
        }
        if (!(await spend())) {
          pause()
          return 'full'
        }
      }
      range.done = true
      return 'read'
    },
  }
}

/** The texts of a task write's `before` and `after` documents, '' for none.
 * A write that changes or checks the description passes both with their
 * text (withText), and every other write passes the stored rows on both
 * sides, so the texts differ only when the write changed them. */
export const textsOf = (
  before: Doc<'issues'>,
  after: Doc<'issues'>,
): { before: string; after: string } => ({
  before: before.description ?? '',
  after: after.description ?? '',
})

/** The fields of a task a write sets, its description among them, which
 * patchTask writes to the description row alone. */
export type TaskFields = Partial<WithoutSystemFields<Doc<'issues'>>>

/** The fields of a task row a write sets that never changes its
 * description, project or archived state, so it may patch the row itself. */
export type TaskPatch = Omit<TaskFields, 'description' | 'project_id' | 'archived_at'>

/** The task a description row belongs to, with the fields the row copies. */
type Owner = Pick<Doc<'issues'>, 'id' | 'org_id' | 'project_id' | 'archived_at'>

/** The fields a description row copies from task `task`. An absent
 * archived_at stays absent: an insert leaves it out and a patch unsets it. */
const copies = (task: Owner) => ({
  org_id: task.org_id,
  project_id: task.project_id,
  archived_at: task.archived_at,
})

/** Whether description row `row` holds the copies of task `task`: its
 * organization, project and archived state. A row without project_id was
 * written before the copies and holds none. */
export const holdsCopies = (row: Doc<'issue_descriptions'>, task: Owner): boolean =>
  row.org_id === task.org_id &&
  row.project_id === task.project_id &&
  row.archived_at === task.archived_at

/** The description row of task `issueId`, or null for a task stored
 * before the table that the backfill has not reached. */
export async function descriptionRow(
  db: Reader,
  issueId: string,
): Promise<Doc<'issue_descriptions'> | null> {
  return await db
    .query('issue_descriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .unique()
}

/** Sets the description row of `owner` to `description` and the owner's
 * copies (holdsCopies), inserting it when the task has none. `owner` is the
 * task as the transaction leaves it. `known` is the row a caller read
 * already, or null when it found none, so this reads no row again. Answers
 * what it did. */
export async function putDescription(
  db: Writer,
  owner: Owner,
  description: string,
  known?: Doc<'issue_descriptions'> | null,
): Promise<'inserted' | 'updated' | 'same'> {
  const row = known === undefined ? await descriptionRow(db, owner.id) : known
  if (row === null) {
    await uncountedWriter(db).insert('issue_descriptions', {
      issue_id: owner.id,
      description,
      ...copies(owner),
    })
    return 'inserted'
  }
  if (row.description === description && holdsCopies(row, owner)) return 'same'
  await db.patch('issue_descriptions', row._id, { description, ...copies(owner) })
  return 'updated'
}

/** How insertTask takes the id of the task it inserts, which every way
 * records in used_ids (schema.ts). An id a caller chose is refused with the
 * refusal given while a live task, Deleted items or used_ids holds it
 * (lib/db.ts insertUnique). An id the server chose, `{ server }`, is refused
 * with its refusal while used_ids holds it, and 'restore' writes back a
 * task from Deleted items (lib/db.ts insertUsed). */
export type TaskClaim = ConvexError<Refusal> | { server: ConvexError<Refusal> } | 'restore'

/** Inserts task row `doc` without its description, which goes to its
 * description row ('' for none), with the used_ids row of its id, taking
 * the id as `claim` says, and answers the row's id. A `doc` that holds a
 * description, such as a copy Deleted items stored, so leaves the task row
 * without one. */
export async function insertTask(
  db: Writer,
  doc: WithoutSystemFields<Doc<'issues'>>,
  claim: TaskClaim,
): Promise<Id<'issues'>> {
  const { description, ...task } = doc
  const _id =
    claim === 'restore'
      ? await insertUsed(db, 'issues', task, 'restore')
      : 'server' in claim
        ? await insertUsed(db, 'issues', task, claim.server)
        : await insertUnique({ db }, 'issues', 'by_uuid', { id: task.id }, task, claim)
  await putDescription(db, task, description ?? '')
  return _id
}

/** Patches task row `issue` with `fields`, and its description row in the
 * same transaction. A description among them goes to the row alone, '' when
 * it is cleared, and a task without a row gets one; the task row loses the
 * copy an earlier release left in it. A new project or archived state goes
 * to the copies of the task's first row, in creation order, with the text
 * readers showed before the change (shownText), which a second row holding
 * the copies may hold, so the change never shows another text. A copy the
 * task row still holds stays for the backfill's clear, and a task without a
 * row gets none (the backfill inserts it). A second row, which no writer of
 * this release leaves, keeps its copies until the backfill's repair deletes
 * it, so it never stops a move, an archive or the nightly archive. Either
 * reads the task's first two rows (firstRows), which a write of the first
 * reads again, unless the caller passes them as `rows`, as a subtree change
 * does to price each patch first (model/issues.ts patchCost). */
export async function patchTask(
  db: Writer,
  issue: Doc<'issues'>,
  fields: TaskFields,
  rows?: readonly Doc<'issue_descriptions'>[],
) {
  const after = { ...issue, ...fields }
  if ('description' in fields) {
    await db.patch('issues', issue._id, { ...fields, description: undefined })
    await putDescription(db, after, fields.description ?? '')
    return
  }
  await db.patch('issues', issue._id, fields)
  if (!('project_id' in fields) && !('archived_at' in fields)) return
  const read = rows ?? (await firstRows(db, issue.id))
  const [row] = read
  if (row !== undefined) await putDescription(db, after, shownText(read, issue), row)
}

/** The text readers show for task `task` (shownRow) from its first two
 * description rows, `rows`, which a caller read already: of them the first
 * that holds the task's copies, else the first. A move or an archive
 * (patchTask), and the backfill's repair of a task row without a copy,
 * give the first row new copies with this text, so the change keeps the
 * text readers showed. */
export const shownText = (rows: readonly Doc<'issue_descriptions'>[], task: Owner): string =>
  (rows.find((row) => holdsCopies(row, task)) ?? rows[0])?.description ?? ''

/** Unsets the copy of its text that task row `task` holds, which a release
 * before this one wrote, when `rows`, the task's first two description rows
 * (firstRows), are one row that holds the task's copies and the same text,
 * so no text is lost; internal/descriptionsBackfill's clear calls it.
 * Answers whether it did. It changes no other field and writes no
 * updated_at, event or activity, because readers show the same text
 * before and after. */
export async function clearTaskCopy(
  db: Writer,
  task: Doc<'issues'>,
  rows: readonly Doc<'issue_descriptions'>[],
): Promise<boolean> {
  const [row, ...more] = rows
  if (task.description === undefined || row === undefined || more.length > 0) return false
  if (!holdsCopies(row, task) || row.description !== task.description) return false
  await db.patch('issues', task._id, { description: undefined })
  return true
}

/** Deletes the description row of task `issueId`, if it has one, and
 * answers it, for the caller's budget. `known` is the row a caller read
 * already, or null when it found none, so this reads no row again. */
export async function dropDescription(
  db: Writer,
  issueId: string,
  known?: Doc<'issue_descriptions'> | null,
): Promise<Doc<'issue_descriptions'> | null> {
  const row = known === undefined ? await descriptionRow(db, issueId) : known
  if (row !== null) await db.delete(row._id)
  return row
}

/** `task` as Deleted items stores it, with the copy of its text the task
 * row still holds, else with the text readers show from its description
 * rows (shownRow), or ''. Once a dry run of internal/descriptionsBackfill
 * reports no `differ` the copy equals the row, and taking it saves a
 * person's delete one read a task until the backfill's clear unsets the
 * copies. Reads the rows only without a copy, and answers the row it took,
 * for the caller's budget. A caller that deletes it as `known`
 * (model/deletedItems.ts clearTask) leaves a second row, which only a
 * rollback leaves, to the backfill, which counts it `waiting` while the
 * task's item is in its steps, then as an orphan its repair deletes. */
export async function withDescription(
  db: Reader,
  task: Doc<'issues'>,
): Promise<{ task: Doc<'issues'>; row: Doc<'issue_descriptions'> | null }> {
  if (task.description !== undefined) return { task, row: null }
  const row = await shownRow(db, task)
  return { task: { ...task, description: row?.description ?? '' }, row }
}
