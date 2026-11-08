/* The closing review's read-only count of the Deleted items rows stored
 * before v0.1.122 (internal/olderDeletedTasks.ts): one organization with
 * an older row in a ready item and one in a stuck item beside a newer row
 * without an assignee, and one organization with none. The pages are
 * lowered through the call's own arguments, never by seeding more. */

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { olderRowsPage } from '../internal/olderDeletedTasks'
import { expectRefusal, NOW, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

const DAY = 86_400_000

/** A deleted_items row of `f`'s organization in `state`. */
const item = (f: OrgFixture, state: Doc<'deleted_items'>['state'], purge_after: number) => ({
  id: uuid(),
  org_id: f.org.id,
  kind: 'task' as const,
  target_id: uuid(),
  num: 1,
  name: 'Calibrate the scale',
  archived: false,
  project_id: f.sub.id,
  parent_project_id: f.meta.id,
  path: ['Testbed platform', 'Firmware'],
  projects: [],
  counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
  deleted_at: NOW,
  state,
  purge_after,
})

/** A stored task row of item `item_id`, as a release before v0.1.122 wrote
 * it (neither assignee_id nor deleted_at) or, with `newer`, as every later
 * delete of an unassigned task writes it. */
const task = (f: OrgFixture, item_id: string, num: number, newer = false) => ({
  org_id: f.org.id,
  item_id,
  task_id: uuid(),
  num,
  title: `Secret title ${num}`,
  project_id: f.sub.id,
  archived: false,
  ...(newer
    ? {
        search_text: `Secret title ${num}\n`,
        deleted_at: NOW,
        item_project_id: f.sub.id,
        item_parent_id: f.meta.id,
      }
    : {}),
})

/** The fixture with its two items, each holding an older row, and a newer
 * row without an assignee in the ready one. */
async function world(t: T) {
  const f = await withOrg(t)
  const ready = item(f, 'ready', Date.parse(NOW) + 30 * DAY)
  const stuck = item(f, 'stuck', Date.parse(NOW) + 2 * DAY)
  await t.run(async (ctx) => {
    await ctx.db.insert('deleted_items', ready)
    await ctx.db.insert('deleted_items', stuck)
    await ctx.db.insert('deleted_tasks', task(f, ready.id, 11))
    await ctx.db.insert('deleted_tasks', task(f, stuck.id, 12))
    await ctx.db.insert('deleted_tasks', task(f, ready.id, 13, true))
  })
  return { f, ready, stuck }
}

const count = (t: T, a: { cursor?: string | null; page_size?: number; row_cap?: number } = {}) =>
  t.query(internal.internal.olderDeletedTasks.count, a)

describe('the count of rows stored before v0.1.122', () => {
  it('answers the organization that holds them with each item and its state, and leaves out one with none', async () => {
    const t = newT()
    const { f, ready, stuck } = await world(t)
    const answer = await count(t)
    expect(answer).toEqual({
      orgs: [
        {
          org_id: f.org.id,
          rows: 2,
          more: false,
          items: expect.arrayContaining([
            { item_id: ready.id, state: 'ready', purge_after: ready.purge_after },
            { item_id: stuck.id, state: 'stuck', purge_after: stuck.purge_after },
          ]),
        },
      ],
      next: null,
    })
    expect(answer.orgs[0].items).toHaveLength(2)
    // no task title, of the older rows or the newer one
    expect(JSON.stringify(answer)).not.toContain('Secret')
    // once the older rows are gone, nothing is left to count
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_tasks').collect())
        if (row.deleted_at === undefined) await ctx.db.delete(row._id)
    })
    expect(await count(t)).toEqual({ orgs: [], next: null })
  })

  it('visits every organization a page at a time, and says more past the row cap', async () => {
    const t = newT()
    const { f } = await world(t)
    const seen: string[] = []
    let cursor: string | null = null
    let calls = 0
    while (calls < 10) {
      const page = await count(t, { cursor, page_size: 1 })
      calls += 1
      expect(page.orgs.length).toBeLessThanOrEqual(1)
      seen.push(...page.orgs.map((o) => o.org_id))
      cursor = page.next
      if (cursor === null) break
    }
    // two organizations, one a page, and the one that holds rows once
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(seen).toEqual([f.org.id])
    const capped = await count(t, { row_cap: 1 })
    expect(capped.orgs).toEqual([
      { org_id: f.org.id, rows: 1, more: true, items: [expect.any(Object)] },
    ])
    for (const a of [{ page_size: 0 }, { page_size: 101 }, { page_size: 1.5 }, { row_cap: 0 }])
      await expectRefusal(count(t, a), 'bad_request')
  })

  it('reads only organizations, the stored task rows and their items, and writes nothing', async () => {
    const t = newT()
    await world(t)
    const before = await t.run(async (ctx) => ({
      tasks: await ctx.db.query('deleted_tasks').collect(),
      items: await ctx.db.query('deleted_items').collect(),
    }))
    const tables = await t.run(async (ctx) => {
      const read = new Set<string>()
      const db = new Proxy(ctx.db, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key)
          if (key === 'query')
            return (table: string) => {
              read.add(table)
              return (value as (table: string) => unknown).call(target, table)
            }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      await olderRowsPage({ ...ctx, db } as QueryCtx, {})
      return [...read].sort()
    })
    expect(tables).toEqual(['deleted_items', 'deleted_tasks', 'organizations'])
    expect(
      await t.run(async (ctx) => ({
        tasks: await ctx.db.query('deleted_tasks').collect(),
        items: await ctx.db.query('deleted_items').collect(),
      })),
    ).toEqual(before)
  })
})
