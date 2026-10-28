/* Whether an archived task's single read has a subtask past the last one it
 * lists (lib/core.ts subtaskFollows), when many subtasks share one
 * _creationTime. Convex can give two documents the same _creationTime and
 * convex-test never does, so ties are tested on a fake by_parent index, as
 * convex/tests/commentPages.test.ts tests them. The answer must read two
 * documents at most, which TASK_READ_RESERVE counts, however many subtasks
 * share the last one's time. */

import { getDocumentSize } from 'convex/values'
import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { subtaskFollows } from '../lib/core'
import { NOW, uuid } from './helpers.setup'

/* The range subtaskFollows asks the by_parent index for. */
type Range = { eq?: number; gt?: number; gte?: number }
type RangeBuilder = {
  eq(field: string, value: string | number): RangeBuilder
  gt(field: string, value: number): RangeBuilder
  gte(field: string, value: number): RangeBuilder
  range: Range
}
const rangeOf = (range: Range): RangeBuilder => ({
  eq: (field, value) =>
    rangeOf(field === '_creationTime' ? { ...range, eq: value as number } : range),
  gt: (_, value) => rangeOf({ ...range, gt: value }),
  gte: (_, value) => rangeOf({ ...range, gte: value }),
  range,
})

/* A QueryCtx holding one parent's `subtasks` and nothing else, ordered as
 * the by_parent index orders them, _creationTime and then the document id.
 * `read()` is the bytes its reads returned, as Convex counts them toward
 * the read limit. */
function subtasksCtx(subtasks: Doc<'issues'>[]): { ctx: QueryCtx; read: () => number } {
  const ordered = [...subtasks].sort(
    (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : 1),
  )
  let read = 0
  const answer = (rows: Doc<'issues'>[]) => {
    for (const row of rows) read += getDocumentSize(row)
    return rows
  }
  const query = () => ({
    withIndex: (_index: string, build: (q: RangeBuilder) => RangeBuilder) => {
      const { eq, gt, gte } = build(rangeOf({})).range
      const rows = ordered.filter(
        (t) =>
          (eq === undefined || t._creationTime === eq) &&
          (gt === undefined || t._creationTime > gt) &&
          (gte === undefined || t._creationTime >= gte),
      )
      const reads = (list: Doc<'issues'>[]) => ({
        take: async (n: number) => answer(list.slice(0, n)),
        first: async () => answer(list.slice(0, 1))[0] ?? null,
      })
      return {
        ...reads(rows),
        order: (direction: 'asc' | 'desc') =>
          reads(direction === 'asc' ? rows : [...rows].reverse()),
      }
    },
  })
  return { ctx: { db: { query } } as unknown as QueryCtx, read: () => read }
}

/* An archived subtask of 900 KB, the `n`th, created at `time`. */
const subtask = (n: number, time: number): Doc<'issues'> =>
  ({
    _id: `s${String(n).padStart(2, '0')}`,
    _creationTime: time,
    id: uuid(),
    org_id: 'org',
    project_id: 'project',
    parent_id: 'parent',
    num: n,
    title: 'Subtask',
    description: 's'.repeat(900 * 1024),
    status: 'done',
    priority: 'low',
    paused: false,
    archived_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  }) as unknown as Doc<'issues'>

describe('subtasks that share a _creationTime', () => {
  // two earlier subtasks, then twelve that share one time, then one later
  const subtasks = [
    subtask(0, 1_000),
    subtask(1, 1_001),
    ...Array.from({ length: 12 }, (_, n) => subtask(2 + n, 2_000)),
    subtask(14, 3_000),
  ]
  const oneRow = getDocumentSize(subtasks[0])

  it('tells whether one follows, reading two subtasks at most', async () => {
    for (const [last, follows] of [
      [subtasks[1], true],
      [subtasks[2], true],
      [subtasks[8], true],
      [subtasks[13], true],
      [subtasks[14], false],
    ] as const) {
      const { ctx, read } = subtasksCtx(subtasks)
      expect(await subtaskFollows(ctx, 'parent', last)).toBe(follows)
      expect(read()).toBeLessThanOrEqual(2 * oneRow)
    }
    // the last of a tie with nothing after it
    const { ctx, read } = subtasksCtx(subtasks.slice(0, 14))
    expect(await subtaskFollows(ctx, 'parent', subtasks[13])).toBe(false)
    expect(read()).toBeLessThanOrEqual(2 * oneRow)
  })
})
