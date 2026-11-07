/* The task window's own answer of a task (taskWindow.task) holds what each
 * write the app sends from it checks: the app builds every expected value
 * from the ok answer's row (src/store/planner.ts updateAnswerTask,
 * expectedOf), and what Move and Archive or delete take along from its
 * whole subtask list (P.familyOf). This stage changes no server function;
 * these pin that the answer is enough, and that the server refuses a write
 * whose values the answer no longer holds, as it does any other. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { SUBTASKS_CHANGED } from '../issues'
import { byId } from '../lib/db'
import { descriptionForm, printOf, trimmedForm } from '../lib/fieldPrints'
import type { Refusal } from '../lib/functions'
import { TASK_WINDOW } from '../lib/taskWindow'
import type { TaskRow } from '../lib/workspaceParts'
import { ARCHIVE_CASCADE_RULE } from '../model/issues'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  type T,
  withReadingAdmin,
} from './helpers.setup'

const DEFAULT_TASK_WINDOW = structuredClone(TASK_WINDOW)
afterEach(() => {
  Object.assign(TASK_WINDOW, structuredClone(DEFAULT_TASK_WINDOW))
})

type Fx = OrgFixture & { t: T }

async function setup(): Promise<Fx> {
  const t = newT()
  return { t, ...(await withReadingAdmin(t)) }
}

/** taskWindow.task of task `id` as `who` reads it. */
const read = (fx: Fx, who: Doc<'profiles'>, id: string) =>
  as(fx.t, who).query(api.taskWindow.task, { org_id: fx.org.id, ref: id })

/** The ok answer of task `id` as `who` reads it. */
async function answerOf(fx: Fx, who: Doc<'profiles'>, id: string) {
  const answer = await read(fx, who, id)
  if (answer.state !== 'ok') throw new Error(`the window answered ${answer.state}`)
  return answer
}

/** The expected values the app sends for `fields` from the answer's row
    `row`: a title and a description as their prints, the parent as the
    pair the answer shows, every other field as it is, null for unset. */
function expectedFrom(row: TaskRow, fields: readonly string[]): Record<string, unknown> {
  const values = row as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = values[field]
    out[field] =
      field === 'title'
        ? printOf(trimmedForm(value))
        : field === 'description'
          ? printOf(descriptionForm(value))
          : (value ?? null)
  }
  if (fields.includes('parent_id'))
    out.has_hidden_parent = row.parent_id === undefined && row.has_hidden_parent
  return out
}

/** Expects a field_changed refusal and answers the fields it names. */
async function changedFields(p: Promise<unknown>): Promise<string[]> {
  const data = (await expectRefusal(p, 'conflict')).data as Refusal
  expect(data.reason).toBe('field_changed')
  return (data.changes ?? []).map((change) => change.field)
}

const update = (
  fx: Fx,
  who: Doc<'profiles'>,
  id: string,
  patch: Record<string, unknown>,
  expected: Record<string, unknown>,
) => as(fx.t, who).mutation(api.issues.update, { org_id: fx.org.id, id, patch, expected })

const stored = (fx: Fx, id: string) => fx.t.run((ctx) => byId(ctx, 'issues', id))

describe('a write from the task window’s own answer', () => {
  /* Each field the window edits: the person's change, and another
     member's change of the same field meanwhile. */
  const fields = (fx: Fx): [Record<string, unknown>, Record<string, unknown>][] => [
    [{ title: 'Measure the gain twice' }, { title: 'Measure the gain later' }],
    [{ description: 'At **two** heights.' }, { description: 'At one height.' }],
    [{ status: 'progress' }, { status: 'review' }],
    [{ priority: 'high' }, { priority: 'low' }],
    [{ assignee_id: fx.admin.id }, { assignee_id: fx.user.id }],
    [{ reviewer_id: fx.admin.id }, { reviewer_id: fx.user.id }],
    [
      { start_week: '2026-01-05', end_week: '2026-01-12' },
      { start_week: '2026-02-02', end_week: '2026-02-09' },
    ],
    [{ due_date: '2026-03-02' }, { due_date: '2026-04-06' }],
    [{ remaining_hours: 6 }, { remaining_hours: 9 }],
    [{ paused: true }, { paused: true }],
  ]

  it('passes each field with the expected values the ok answer’s row gives, and refuses them once another member changed the field', async () => {
    const fx = await setup()
    for (const [mine, theirs] of fields(fx)) {
      const keys = Object.keys(mine)
      const what = keys.join()
      // from the answer, the edit passes
      const task = await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        title: 'Measure the gain',
        description: 'At one metre.',
      })
      const answer = await answerOf(fx, fx.user, task.id)
      await update(fx, fx.user, task.id, mine, expectedFrom(answer.task, keys))
      const after = (await stored(fx, task.id)) as unknown as Record<string, unknown>
      for (const key of keys) {
        if (key === 'description') continue
        expect(after[key], what).toEqual(mine[key])
      }
      // someone changes the field after the window read it: refused, naming it
      const other = await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        title: 'Measure the gain',
        description: 'At one metre.',
      })
      const seen = await answerOf(fx, fx.user, other.id)
      await update(fx, fx.admin, other.id, theirs, expectedFrom(seen.task, Object.keys(theirs)))
      // a switch someone else turned the same way leaves the person's
      // write nothing to change, which the server checks nothing for, and
      // the window sends no switch equal to what it showed
      if ('paused' in mine) {
        await update(fx, fx.user, other.id, mine, expectedFrom(seen.task, keys))
        expect((await stored(fx, other.id))?.paused).toBe(true)
        continue
      }
      const named = await changedFields(
        update(fx, fx.user, other.id, mine, expectedFrom(seen.task, keys)),
      )
      expect([...named].sort(), what).toEqual([...keys].sort())
    }
  })

  it('detaches a hidden parent by the pair the answer shows, also once it became another hidden task, passes as no change once there is none, and refuses once the guest is shown the parent', async () => {
    const fx = await setup()
    const sibling = await plantHiddenSibling(fx.t, fx, fx.guest)
    const parent = await plantIssue(fx.t, { org_id: fx.org.id, project_id: sibling.id })
    const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: sibling.id })
    const plant = () =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: parent.id })
    const detach = (id: string, row: TaskRow) =>
      update(fx, fx.guest, id, { parent_id: null }, expectedFrom(row, ['parent_id']))

    const child = await plant()
    const answer = await answerOf(fx, fx.guest, child.id)
    expect(answer.task.parent_id).toBeUndefined()
    expect(answer.task.has_hidden_parent).toBe(true)
    expect(answer.parent).toBeNull()
    expect(expectedFrom(answer.task, ['parent_id'])).toEqual({
      parent_id: null,
      has_hidden_parent: true,
    })
    await detach(child.id, answer.task)
    expect((await stored(fx, child.id))?.parent_id).toBeUndefined()

    // the hidden parent is another hidden task by the time the window
    // writes, which the answer cannot tell, and the pair still matches
    const moved = await plant()
    const before = await answerOf(fx, fx.guest, moved.id)
    await update(
      fx,
      fx.admin,
      moved.id,
      { parent_id: other.id },
      { parent_id: parent.id, has_hidden_parent: false },
    )
    await detach(moved.id, before.task)
    expect((await stored(fx, moved.id))?.parent_id).toBeUndefined()

    // no parent any more: the detach changes nothing, which the server
    // takes as no change to check
    const gone = await plant()
    const stale = await answerOf(fx, fx.guest, gone.id)
    await update(
      fx,
      fx.admin,
      gone.id,
      { parent_id: null },
      { parent_id: parent.id, has_hidden_parent: false },
    )
    await detach(gone.id, stale.task)
    expect((await stored(fx, gone.id))?.parent_id).toBeUndefined()
    // a new hidden parent meanwhile: the pair still says there is one,
    // so the detach takes it off, as the person asked
    const again = await plant()
    const seenAgain = await answerOf(fx, fx.guest, again.id)
    await update(
      fx,
      fx.admin,
      again.id,
      { parent_id: null },
      { parent_id: parent.id, has_hidden_parent: false },
    )
    await update(
      fx,
      fx.admin,
      again.id,
      { parent_id: other.id },
      { parent_id: null, has_hidden_parent: false },
    )
    await detach(again.id, seenAgain.task)
    expect((await stored(fx, again.id))?.parent_id).toBeUndefined()
    // and a parent the guest is shown since, which the hidden pair does not
    // name, is refused
    const shown = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub2.id })
    const third = await plant()
    const seenThird = await answerOf(fx, fx.guest, third.id)
    await update(
      fx,
      fx.admin,
      third.id,
      { parent_id: shown.id },
      { parent_id: parent.id, has_hidden_parent: false },
    )
    expect(await changedFields(detach(third.id, seenThird.task))).toEqual(['parent_id'])
  })

  it('moves the task with the answer’s project as expected, with and without a detach', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const answer = await answerOf(fx, fx.user, task.id)
    await as(fx.t, fx.user).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: task.id,
      project_id: fx.sub2.id,
      expected: expectedFrom(answer.task, ['project_id']),
    })
    expect((await stored(fx, task.id))?.project_id).toBe(fx.sub2.id)
    // to another top-level project, leaving the parent behind
    const elsewhere = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
    })
    const parent = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const child = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: parent.id,
    })
    const seen = await answerOf(fx, fx.user, child.id)
    expect(seen.parent?.id).toBe(parent.id)
    await as(fx.t, fx.user).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: child.id,
      project_id: elsewhere.id,
      detach_parent: true,
      expected: expectedFrom(seen.task, ['project_id', 'parent_id']),
    })
    const after = await stored(fx, child.id)
    expect([after?.project_id, after?.parent_id]).toEqual([elsewhere.id, undefined])
    // a move the answer's project no longer holds is refused
    const stale = await answerOf(fx, fx.user, task.id)
    await as(fx.t, fx.admin).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: task.id,
      project_id: fx.sub.id,
    })
    expect(
      await changedFields(
        as(fx.t, fx.user).mutation(api.issues.move, {
          org_id: fx.org.id,
          id: task.id,
          project_id: elsewhere.id,
          expected: expectedFrom(stale.task, ['project_id']),
        }),
      ),
    ).toEqual(['project_id'])
  })

  it('refuses an archive over a subtask the answer lists in a project the caller cannot edit, and a delete of one that moved away', async () => {
    const fx = await setup()
    const sibling = await plantHiddenSibling(fx.t, fx, fx.guest)
    // the guest views the sibling, so the answer lists its subtask
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: sibling.id,
        profile_id: fx.guest.id,
        level: 'viewer',
      }),
    )
    const root = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const mine = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: root.id,
    })
    const viewOnly = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: sibling.id,
      parent_id: root.id,
    })
    const answer = await answerOf(fx, fx.guest, root.id)
    expect(answer.subtasks.complete).toBe(true)
    expect(answer.subtasks.rows.map((row) => [row.id, row.level])).toEqual([
      [mine.id, 'user'],
      [viewOnly.id, 'viewer'],
    ])
    await expectRefusal(
      as(fx.t, fx.guest).mutation(api.issues.archive, { org_id: fx.org.id, id: root.id }),
      'rule',
      new RegExp(ARCHIVE_CASCADE_RULE),
    )
    // the subtask the answer listed moves away before the delete
    await update(
      fx,
      fx.admin,
      mine.id,
      { parent_id: null },
      { parent_id: root.id, has_hidden_parent: false },
    )
    await expectRefusal(
      as(fx.t, fx.guest).mutation(api.issues.deleteDeep, {
        org_id: fx.org.id,
        id: root.id,
        subtask_ids: [mine.id],
      }),
      'rule',
      new RegExp(SUBTASKS_CHANGED),
    )
    expect((await stored(fx, root.id))?.archived_at).toBeUndefined()
  })

  it('answers a Viewer and a guest their level, and refuses their writes alike', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    // a Viewer's seat caps its grant
    const viewer = await answerOf(fx, fx.viewer, task.id)
    expect(viewer.level).toBe('viewer')
    // a guest with a view-only grant
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', fx.meta.id).eq('profile_id', fx.guest.id),
        )
        .unique()
      if (row) await ctx.db.patch(row._id, { level: 'viewer' })
    })
    const guest = await answerOf(fx, fx.guest, task.id)
    expect(guest.level).toBe('viewer')
    for (const [who, answer] of [
      [fx.viewer, viewer],
      [fx.guest, guest],
    ] as const) {
      await expectRefusal(
        update(fx, who, task.id, { title: 'Renamed' }, expectedFrom(answer.task, ['title'])),
        'forbidden',
      )
      await expectRefusal(
        as(fx.t, who).mutation(api.labels.toggle, {
          org_id: fx.org.id,
          issue_id: task.id,
          label_id: 'label-none',
          on: true,
        }),
        'forbidden',
      )
    }
    expect((await stored(fx, task.id))?.title).toBe('Planted task')
  })

  it('answers a list that is not whole as hidden subtasks with no subtask counted, which the app takes for a group', async () => {
    const fx = await setup()
    const root = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: root.id })
    TASK_WINDOW.rows = 0
    const answer = await answerOf(fx, fx.user, root.id)
    expect(answer.subtasks).toEqual({ rows: [], complete: false })
    expect(answer.task.has_subtasks).toBe(false)
    expect(answer.task.has_hidden_subtasks).toBe(true)
    // and the server still refuses a group's dates and own hours
    Object.assign(TASK_WINDOW, structuredClone(DEFAULT_TASK_WINDOW))
    await expectRefusal(
      update(
        fx,
        fx.user,
        root.id,
        { remaining_hours: 4 },
        expectedFrom(answer.task, ['remaining_hours']),
      ),
      'rule',
    )
  })
})
