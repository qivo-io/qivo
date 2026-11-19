import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import { SUBTASKS_CHANGED } from '../issues'
import { activityFor, as, expectRefusal, newT, plantIssue, withOrg } from './helpers.setup'

/* Deleting a task with the subtasks the delete window listed moves them to
 * Deleted items as one item. A task has one level of subtasks, in its own
 * sub-project, Firmware, which the guest edits. */
async function tree() {
  const t = newT()
  const f = await withOrg(t)
  const org_id = f.org.id
  const task = (project_id: string, parent_id?: string, extra = {}) =>
    plantIssue(t, { org_id, project_id, parent_id, ...extra })
  const root = await task(f.sub.id)
  const a = await task(f.sub.id, root.id)
  const a2 = await task(f.sub.id, root.id)
  const d = await task(f.sub.id, root.id, { archived_at: '2026-01-02T00:00:00.000Z' })
  const e = await task(f.sub.id, root.id) // not chosen
  const other = await task(f.sub.id) // not a subtask of the task
  // a live task's parent, or the item a stored one waits in with its parent
  const read = (id: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      if (row) return { parent: row.parent_id ?? null }
      const stored = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', id))
        .unique()
      if (stored?.row.table !== 'issues') return 'gone'
      return { item: stored.item_id, parent: stored.row.doc.parent_id ?? null }
    })
  const items = () => t.run((ctx) => ctx.db.query('deleted_items').collect())
  return { t, f, root, a, a2, d, e, other, read, items }
}

describe('deleting a task with its subtasks', () => {
  // the deleted task's archived subtasks leave it in background steps
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves the chosen subtasks with the task, under it, and leaves every other one as a top-level task', async () => {
    const { t, f, root, a, a2, d, e, read, items } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, {
      org_id: f.org.id,
      id: root.id,
      subtask_ids: [a.id, a2.id],
    })
    // the archived subtask is still under the deleted task until the steps run
    expect(await read(d.id)).toEqual({ parent: root.id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const [item] = await items()
    expect(item).toMatchObject({
      target_id: root.id,
      state: 'ready',
      counts: { tasks: 3, subtasks: 2 },
    })
    // one item, and the chosen subtasks keep their parent in it
    expect(await read(root.id)).toEqual({ item: item.id, parent: null })
    expect(await read(a.id)).toEqual({ item: item.id, parent: root.id })
    expect(await read(a2.id)).toEqual({ item: item.id, parent: root.id })
    // archived or not chosen: detached from the deleted task
    for (const kept of [d, e]) expect(await read(kept.id)).toEqual({ parent: null })
    // the subtasks go first, then the task
    const deleted = (await activityFor(t, f.org.id))
      .filter((row) => row.verb === 'deleted')
      .map((row) => row.target_id)
    expect(deleted).toEqual([a.id, a2.id, root.id])
  })

  it('refuses, deleting nothing, when a listed subtask is not one it may delete', async () => {
    const { t, f, root, a, d, other, read, items } = await tree()
    for (const listed of [d, other]) {
      // archived, or not its subtask
      await expectRefusal(
        as(t, f.guest).mutation(api.issues.deleteDeep, {
          org_id: f.org.id,
          id: root.id,
          subtask_ids: [listed.id],
        }),
        'rule',
        new RegExp(SUBTASKS_CHANGED),
      )
    }
    // a project archived after the window listed its subtask
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { archived_at: '2026-01-02T00:00:00.000Z' })
    })
    await expectRefusal(
      as(t, f.guest).mutation(api.issues.deleteDeep, {
        org_id: f.org.id,
        id: root.id,
        subtask_ids: [a.id],
      }),
      'rule',
      new RegExp(SUBTASKS_CHANGED),
    )
    expect(await read(root.id)).toEqual({ parent: null })
    expect(await read(a.id)).toEqual({ parent: root.id })
    expect(await items()).toEqual([])
  })

  it('without subtasks moves only the task, as before', async () => {
    const { t, f, root, a, e, read, items } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: root.id })
    const [item] = await items()
    expect(item).toMatchObject({ target_id: root.id, counts: { tasks: 1, subtasks: 0 } })
    expect(await read(root.id)).toEqual({ item: item.id, parent: null })
    expect(await read(a.id)).toEqual({ parent: null })
    expect(await read(e.id)).toEqual({ parent: null })
  })
})
