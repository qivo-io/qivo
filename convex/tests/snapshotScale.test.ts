/* The snapshot of a large organization: long lists go in parts
 * (lib/arrayLimit.ts), and the relation reads plan with the ranges the
 * seat's other reads have left (lib/snapshotRelations.ts). */
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { ARRAY_LIMIT, joinLists } from '../lib/arrayLimit'
import { as, NOW, newT, withOrg } from './helpers.setup'

describe('the relation reads of a snapshot', () => {
  it("leave the ranges the seat's other reads need", async () => {
    // 100 tasks restored so recently that their rows carry archive marks,
    // each read through its own indexes and its follow, and 200 tasks with
    // five labels each, past the label table's bulk cap. Before, the labels
    // were read task by task with the ranges left before the follows, and
    // the follows then passed a limit of 700 index ranges.
    const t = newT({ transactionLimits: { databaseQueries: 700 } })
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const id = `task-${i}`
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: f.sub.id,
          num: i + 1,
          title: `Task ${i}`,
          description: '',
          status: 'progress',
          priority: 'medium',
          paused: false,
          ...(i < 100 ? { relations_marked: true as const } : {}),
          created_at: NOW,
          updated_at: NOW,
        })
        if (i >= 100)
          for (let l = 0; l < 5; l++)
            await ctx.db.insert('issue_labels', {
              org_id: f.org.id,
              issue_id: id,
              label_id: `label-${l}`,
            })
      }
    })
    const snapshot = await as(t, f.admin).query(api.snapshot.forMe, {})
    expect(snapshot?.issues).toHaveLength(300)
    expect(snapshot?.issueLabels).toHaveLength(1000)
  })
})

/* The length of the longest array anywhere in `value`. */
function longestArray(value: unknown): number {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(longestArray))
  if (value !== null && typeof value === 'object')
    return Math.max(0, ...Object.values(value).map(longestArray))
  return 0
}

describe('the snapshot of an organization with long lists', () => {
  afterEach(() => {
    ARRAY_LIMIT.max = 8192
  })

  it('sends no array past the limit, and joins back to the same snapshot', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        const id = `task-${i}`
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: f.sub.id,
          num: i + 1,
          title: `Task ${i}`,
          description: '',
          status: 'progress',
          priority: 'medium',
          paused: false,
          assignee_id: f.user.id,
          start_week: '2026-10-05',
          end_week: '2026-10-05',
          remaining_hours: 4,
          remaining_set_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id: id, label_id: 'l' })
      }
    })
    const read = () => as(t, f.admin).query(api.snapshot.forMe, {})
    const whole = await read()
    ARRAY_LIMIT.max = 4
    const parts = await read()
    if (whole === null || parts === null) throw new Error('no snapshot')
    expect(longestArray(parts)).toBeLessThanOrEqual(4)
    expect(parts.issues).toHaveLength(4)
    expect(parts.more?.issues?.flat()).toHaveLength(6)
    expect({ ...joinLists(parts), delivered_at: '' }).toEqual({ ...whole, delivered_at: '' })
  })
})
