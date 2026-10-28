/* Task descriptions in issue_descriptions (schema.ts), one row per live
 * task beside its issues row. Every insert of a task row and every write of
 * a task's description, project or archived state goes through this file,
 * in the transaction that writes the task, so the copies stay equal, and
 * only this file writes issue_descriptions. scripts/check-task-writes.mjs
 * fails on any other such write.
 *
 * In this release, the second of the move, readers and writers follow
 * different rules. Every reader takes a task's text from its first
 * description row in creation order that holds the task's copies, else
 * from its first row (descriptionOf, withText, descriptionsOf), and only a
 * task without a row, which
 * internal/descriptionsBackfill has not reached, reads issues.description.
 * Only this file reads either copy for a reader, and
 * scripts/check-task-reads.mjs fails on any other read of
 * issues.description. Writers keep the first release's rule: every path
 * that writes a row takes the text from the task row while it holds one,
 * and only then from the row. Every release so far writes
 * issues.description, and the releases from before the table write only
 * it, so the task row holds the freshest text. So readers prove the rows on
 * every deployment while the task row still holds a copy, and a rollback to
 * the first release of the move, which reads only issues.description,
 * loses nothing. The third release stops writing
 * issues.description and clears it; a rollback from it to this release
 * still shows every description, because this one reads the rows.
 *
 * A write that changes or checks a task's description passes the task with
 * its text (withText) as its before and after documents, and every other
 * write passes the stored rows on both sides, so the activity diff, the
 * mention diff and a webhook's changed fields (textsOf) see a description
 * change only where a write made one, also once the third release has
 * cleared issues.description.
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
 * Deleted items stores a task with this text (withDescription), and its
 * steps delete the task's description row with its messages
 * (model/deletedItems.ts), so the person's own delete reads no row.
 *
 * In a public demo a description row spends none of the visitor's record
 * limit (lib/demo.ts uncountedWriter), because it is part of its task,
 * which counts once. */

import type { TransactionMetrics, WithoutSystemFields } from 'convex/server'
import type { ConvexError } from 'convex/values'
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

/* The description row readers take for task `task`: its first row in
 * creation order that holds the task's copies (holdsCopies), else its first
 * row, or null for a task without one. Every writer keeps the copies on the
 * first row (patchTask), so that is the first row, unless a rollback left
 * the first row's copies stale beside a second row; then this is the row
 * the active range of the task's project holds too (projectTextsOf), so
 * every reader takes the same one. It reads rows until one holds the
 * copies: one normally, two when the first's copies are stale, more only
 * for a task with three or more rows, which repeated rollbacks leave and
 * the backfill reports. */
async function shownRow(db: Reader, task: Owner): Promise<Doc<'issue_descriptions'> | null> {
  let first: Doc<'issue_descriptions'> | null = null
  const rows = db
    .query('issue_descriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
  for await (const row of rows) {
    if (holdsCopies(row, task)) return row
    first ??= row
  }
  return first
}

/** The text of task `task` as readers show it: the text of its description
 * row (shownRow), else issues.description for a task the backfill has not
 * given a row, else ''. One by_issue range and one document, two when a
 * rollback left the first row's copies stale. */
export async function descriptionOf(db: Reader, task: TextOwner): Promise<string> {
  return (await shownRow(db, task))?.description ?? task.description ?? ''
}

/** The text readers show for `task` (descriptionOf), and whether its task
 * row holds a different one, which only a rollback leaves: a release from
 * before the table that changed issues.description without the row. A
 * writer then takes the task row's text (patchTask), so a tool that rewrites
 * the text it read from the row would lose that edit; it leaves such a task
 * to internal/descriptionsBackfill's repair. It reads as descriptionOf
 * does. */
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

/** Adds to `texts` the text of each of `tasks` (descriptionOf) that the
 * active description rows of its project hold (by_project_archived), one
 * range a project, the projects in the order `tasks` first names them. A
 * caller that needs most of a project's rows so pays one range and each row
 * once, rather than one range a task. The range holds the rows of every
 * active task of the project, so a caller that needs a few reads them
 * through descriptionsOf instead. Of a task's rows the first in the range
 * that holds its copies is the one shownRow takes. A task the ranges hold
 * no such row for, one without a row or whose rows' copies are stale, which
 * only a rollback leaves, is left out, for the caller to read on its own.
 * After each text it adds it asks `enough`, and it stops once that answers
 * true. It checks `room` before each range and as its rows add up, so it
 * passes `room` by one row at most. Answers false when `room` ran out
 * first. */
export async function projectTextsOf(
  ctx: QueryCtx,
  tasks: readonly TextOwner[],
  room: ReadCeiling,
  texts: Map<string, string>,
  enough: () => boolean,
): Promise<boolean> {
  const wanted = new Map(tasks.map((task) => [task.id, task]))
  const projects = [...new Set(tasks.map((task) => task.project_id))]
  // the rows the reads left under `room` hold at Convex's size limit,
  // counted down and asked again once spent
  let allowance = 0
  const spend = async (): Promise<boolean> => {
    if (--allowance >= 0) return true
    const m = await ctx.meta.getTransactionMetrics()
    allowance = Math.min(
      room.documents - m.documentsRead.used,
      Math.floor((room.bytes - m.bytesRead.used) / DOCUMENT_MAX_BYTES),
    )
    return allowance-- > 0
  }
  for (const projectId of projects) {
    const m = await ctx.meta.getTransactionMetrics()
    if (room.ranges - m.databaseQueries.used < 1) return false
    if (!(await spend())) return false
    const rows = ctx.db
      .query('issue_descriptions')
      .withIndex('by_project_archived', (q) =>
        q.eq('project_id', projectId).eq('archived_at', undefined),
      )
    for await (const row of rows) {
      const task = wanted.get(row.issue_id)
      if (task !== undefined && !texts.has(task.id) && holdsCopies(row, task)) {
        texts.set(task.id, row.description)
        if (enough()) return true
      }
      if (!(await spend())) return false
    }
  }
  return true
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

/** The fields of a task row a write sets, its description among them. */
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

/** Inserts task row `doc` with its description row and the used_ids row of
 * its id, taking the id as `claim` says, and answers the row's id. */
export async function insertTask(
  db: Writer,
  doc: WithoutSystemFields<Doc<'issues'>>,
  claim: TaskClaim,
): Promise<Id<'issues'>> {
  const _id =
    claim === 'restore'
      ? await insertUsed(db, 'issues', doc, 'restore')
      : 'server' in claim
        ? await insertUsed(db, 'issues', doc, claim.server)
        : await insertUnique({ db }, 'issues', 'by_uuid', { id: doc.id }, doc, claim)
  await putDescription(db, doc, doc.description ?? '')
  return _id
}

/** Patches task row `issue` with `fields`, and its description row in the
 * same transaction. A description among them goes to the row, '' when it
 * is cleared, and a task without a row gets one. A new project or archived
 * state goes to the copies of the task's first row, in creation order,
 * with the text of issues.description while the task row holds one, and a
 * task without a row gets none (the backfill inserts it). A second row,
 * which no writer of this release leaves, keeps its copies until the
 * backfill's repair deletes it, so it never stops a move, an archive or
 * the nightly archive. Either reads the row, which a write of it reads
 * again. */
export async function patchTask(db: Writer, issue: Doc<'issues'>, fields: TaskFields) {
  await db.patch('issues', issue._id, fields)
  const after = { ...issue, ...fields }
  if ('description' in fields) {
    await putDescription(db, after, fields.description ?? '')
    return
  }
  if (!('project_id' in fields) && !('archived_at' in fields)) return
  const row = await db
    .query('issue_descriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
    .first()
  if (row !== null) await putDescription(db, after, after.description ?? row.description, row)
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

/** `task` as Deleted items stores it, with issues.description while the
 * task row holds one, else with the text of its description row, or ''.
 * Reads the row only then, and answers it, for the caller's budget. */
export async function withDescription(
  db: Reader,
  task: Doc<'issues'>,
): Promise<{ task: Doc<'issues'>; row: Doc<'issue_descriptions'> | null }> {
  if (task.description !== undefined) return { task, row: null }
  const row = await descriptionRow(db, task.id)
  return { task: { ...task, description: row?.description ?? '' }, row }
}
