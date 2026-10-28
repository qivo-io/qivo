/* Task descriptions in issue_descriptions (schema.ts), one row per live
 * task beside its issues row. Every insert of a task row and every write of
 * a task's description goes through this file, in the transaction that
 * writes the task, so the two copies stay equal, and only this file writes
 * issue_descriptions. scripts/check-task-writes.mjs fails on any other
 * such write.
 *
 * In this release issues.description stays the source of truth. Readers
 * read it, and a task stored before the table, which has no row until
 * internal/descriptionsBackfill gives it one, reads as it did. A release
 * before this one can run again after it and change issues.description
 * without the row, so every path here takes the text from the task row
 * while it holds one, and only then from the row.
 *
 * A row names its task and its organization. A create may choose the id of
 * a task deleted for good, also in another organization, so a write that
 * finds a row for its task resets both its text and its organization
 * (putDescription), and an organization's teardown never takes another's
 * row.
 *
 * Deleted items stores a task with this text (withDescription), and its
 * steps delete the task's description row with its messages
 * (model/deletedItems.ts), so the person's own delete reads no row.
 *
 * In a public demo a description row spends none of the visitor's record
 * limit (lib/demo.ts uncountedWriter), because it is part of its task,
 * which counts once. */

import type { WithoutSystemFields } from 'convex/server'
import type { ConvexError } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { insertUnique } from '../lib/db'
import { uncountedWriter } from '../lib/demo'
import type { Refusal } from '../lib/functions'

type Reader = QueryCtx['db']
type Writer = MutationCtx['db']

/** The fields of a task row a write sets, its description among them. */
export type TaskFields = Partial<WithoutSystemFields<Doc<'issues'>>>

/** The fields of a task row a write sets that never changes its
 * description, so it may patch the row itself. */
export type TaskPatch = Omit<TaskFields, 'description'>

/** The task and organization a description row belongs to. */
type Owner = Pick<Doc<'issues'>, 'id' | 'org_id'>

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
 * organization, inserting it when the task has none. `known` is the row a
 * caller read already, or null when it found none, so this reads no row
 * again. Answers what it did. */
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
      org_id: owner.org_id,
      description,
    })
    return 'inserted'
  }
  if (row.description === description && row.org_id === owner.org_id) return 'same'
  await db.patch('issue_descriptions', row._id, { description, org_id: owner.org_id })
  return 'updated'
}

/** Inserts task row `doc` with its description row and answers the row's
 * id. With `duplicate`, an id that a live task or Deleted items holds
 * already is refused with it (lib/db.ts insertUnique). */
export async function insertTask(
  db: Writer,
  doc: WithoutSystemFields<Doc<'issues'>>,
  duplicate?: ConvexError<Refusal>,
): Promise<Id<'issues'>> {
  const _id =
    duplicate === undefined
      ? await db.insert('issues', doc)
      : await insertUnique({ db }, 'issues', 'by_uuid', { id: doc.id }, doc, duplicate)
  await putDescription(db, doc, doc.description ?? '')
  return _id
}

/** Patches task row `issue` with `fields`. A description among them goes
 * to the task's description row too, '' when it is cleared. */
export async function patchTask(db: Writer, issue: Doc<'issues'>, fields: TaskFields) {
  await db.patch('issues', issue._id, fields)
  if ('description' in fields) await putDescription(db, issue, fields.description ?? '')
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
