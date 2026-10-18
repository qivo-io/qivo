import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { SUBTASKS_CHANGED } from '../issues'
import {
  activityFor,
  as,
  expectRefusal,
  newT,
  plantIssue,
  plantProject,
  withOrg,
} from './helpers.setup'

/* Deleting a task with the subtasks the delete window listed moves them to
 * Deleted items as one item. The guest edits the Testbed platform (Firmware
 * and Board rev), only views Pilot, and cannot see Skunkworks. */
async function tree() {
  const t = newT()
  const f = await withOrg(t)
  const org_id = f.org.id
  const pilot = await plantProject(t, { org_id, name: 'Pilot' })
  const pilotSub = await plantProject(t, { org_id, type: 'project', parent_id: pilot.id })
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: pilot.id,
      profile_id: f.guest.id,
      level: 'viewer',
    })
  })
  const task = (project_id: string, parent_id?: string, extra = {}) =>
    plantIssue(t, { org_id, project_id, parent_id, ...extra })
  const root = await task(f.sub.id)
  const a = await task(f.sub2.id, root.id) // editable
  const aa = await task(f.sub.id, a.id) // editable, one level down
  const ab = await task(pilotSub.id, a.id) // view only, under a deleted subtask
  const b = await task(pilotSub.id, root.id) // view only
  const ba = await task(f.sub.id, b.id) // editable, but under a kept subtask
  const c = await task(f.hidden.id, root.id) // cannot be seen
  const d = await task(f.sub.id, root.id, { archived_at: '2026-01-02T00:00:00.000Z' })
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
  return { t, f, root, a, aa, ab, b, ba, c, d, read, items }
}

describe('deleting a task with its subtasks', () => {
  it('moves the chosen subtasks with the task, under their parents, and leaves every other one as a top-level task', async () => {
    const { t, f, root, a, aa, ab, b, ba, c, d, read, items } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, {
      org_id: f.org.id,
      id: root.id,
      subtask_ids: [a.id, aa.id],
    })
    const [item] = await items()
    expect(item).toMatchObject({
      target_id: root.id,
      state: 'ready',
      counts: { tasks: 3, subtasks: 2 },
    })
    // one item, and the chosen subtasks keep their parents in it
    expect(await read(root.id)).toEqual({ item: item.id, parent: null })
    expect(await read(a.id)).toEqual({ item: item.id, parent: root.id })
    expect(await read(aa.id)).toEqual({ item: item.id, parent: a.id })
    // view only, unseen, archived: detached from the deleted task above
    for (const kept of [ab, b, c, d]) expect(await read(kept.id)).toEqual({ parent: null })
    // a kept subtask keeps its own subtasks
    expect(await read(ba.id)).toEqual({ parent: b.id })
    // deepest first, so no subtask about to go is detached (and announced) first
    const deleted = (await activityFor(t, f.org.id))
      .filter((e) => e.verb === 'deleted')
      .map((e) => e.target_id)
    expect(deleted).toEqual([aa.id, a.id, root.id])
  })

  it('refuses, deleting nothing, when a listed subtask is not one it may delete', async () => {
    const { t, f, root, a, aa, b, ba, c, d, read, items } = await tree()
    for (const listed of [b, c, d, ba, aa]) {
      // view only, unseen, archived, under a kept subtask, or its parent not listed
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
      await ctx.db.patch(f.sub2._id, { archived_at: '2026-01-02T00:00:00.000Z' })
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
    const { t, f, root, a, aa, b, read, items } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: root.id })
    const [item] = await items()
    expect(item).toMatchObject({ target_id: root.id, counts: { tasks: 1, subtasks: 0 } })
    expect(await read(root.id)).toEqual({ item: item.id, parent: null })
    expect(await read(a.id)).toEqual({ parent: null })
    expect(await read(b.id)).toEqual({ parent: null })
    expect(await read(aa.id)).toEqual({ parent: a.id })
  })
})
