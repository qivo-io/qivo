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

/* Deleting a task with the subtasks the delete window listed. The guest
 * edits the Testbed platform (Firmware and Board rev), only views Pilot, and
 * cannot see Skunkworks. */
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
  const read = (id: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      return row ? { parent: row.parent_id ?? null } : 'deleted'
    })
  return { t, f, root, a, aa, ab, b, ba, c, d, read }
}

describe('deleting a task with its subtasks', () => {
  it('deletes the chosen subtasks and leaves every other one as a top-level task', async () => {
    const { t, f, root, a, aa, ab, b, ba, c, d, read } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, {
      org_id: f.org.id,
      id: root.id,
      subtask_ids: [a.id, aa.id],
    })
    expect(await read(root.id)).toBe('deleted')
    expect(await read(a.id)).toBe('deleted')
    expect(await read(aa.id)).toBe('deleted')
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
    const { t, f, root, a, aa, b, ba, c, d, read } = await tree()
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
  })

  it('without subtasks deletes only the task, as before', async () => {
    const { t, f, root, a, aa, b, read } = await tree()
    await as(t, f.guest).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: root.id })
    expect(await read(root.id)).toBe('deleted')
    expect(await read(a.id)).toEqual({ parent: null })
    expect(await read(b.id)).toEqual({ parent: null })
    expect(await read(aa.id)).toEqual({ parent: a.id })
  })
})
