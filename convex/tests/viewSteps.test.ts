/* The view reader's stepping and budget guard (lib/viewReads.ts inSteps,
 * viewBudget) over ranges held in memory, for what convex-test never
 * produces: rows that share one creation time, more of them than a step
 * reads. A stand-in context counts every range and row a read takes, as
 * Convex's transaction metrics do, so the cases also check that a step
 * never starts more ranges than the budget holds. */

import { describe, expect, it } from 'vitest'
import type { QueryCtx } from '../_generated/server'
import { inSteps, OverBudget, type Reads, type StepRange, viewBudget } from '../lib/viewReads'

/** A row as the ranges here hold it. */
type Row = { _id: string; _creationTime: number }

/** A stand-in for a query context whose metrics count what the ranges
 * read: one range for each take and each row it returns, at `size` bytes. */
function counting(size = 100) {
  const used = { ranges: 0, documents: 0, bytes: 0 }
  const metric = (n: number, limit: number) => ({ used: n, remaining: limit - n })
  const ctx = {
    meta: {
      getTransactionMetrics: async () => ({
        databaseQueries: metric(used.ranges, 4096),
        documentsRead: metric(used.documents, 32_000),
        bytesRead: metric(used.bytes, 16 << 20),
      }),
    },
  } as unknown as QueryCtx
  /** A range over `rows`, sorted as an index orders them: creation time,
   * then id. `start` makes it start after a row read before. */
  const range = (rows: readonly Row[], start?: StepRange<Row>['start']): StepRange<Row> => {
    const sorted = [...rows].sort(
      (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : 1),
    )
    return {
      open: (from) => ({
        take: async (n: number) => {
          const got = sorted
            .filter((row) => from === undefined || row._creationTime >= from)
            .slice(0, n)
          used.ranges += 1
          used.documents += got.length
          used.bytes += got.length * size
          return got
        },
      }),
      ...(start === undefined ? {} : { start }),
    }
  }
  return { ctx, used, range }
}

/** `n` rows at creation time `at`, ids from `prefix`. */
const tied = (prefix: string, n: number, at: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    _id: `${prefix}${String(i).padStart(4, '0')}`,
    _creationTime: at,
  }))

/** Every row `ranges` yield, in yield order. */
async function readAll(reads: Reads, ranges: StepRange<Row>[], ctx: QueryCtx): Promise<Row[]> {
  const guard = viewBudget(ctx, reads)
  const out: Row[] = []
  for await (const step of inSteps(guard, ranges)) out.push(...step)
  return out
}

const roomy: Reads = { bytes: 12 << 20, documents: 24_000, ranges: 3600 }

describe('rows that share a creation time', () => {
  it('yields each of more rows than a step reads at one creation time once, and the rows after them', async () => {
    const { ctx, range } = counting()
    const rows = [...tied('a', 150, 1000), ...tied('b', 3, 999), ...tied('c', 20, 1001)]
    const got = await readAll(roomy, [range(rows)], ctx)
    expect(got.map((row) => row._id).sort()).toEqual(rows.map((row) => row._id).sort())
  })

  it('starts after a row read before with the rows at its time skipped, as a group check reads the rest after the first', async () => {
    const { ctx, range } = counting()
    const rows = tied('a', 130, 1000)
    const first = rows[0]
    const got = await readAll(
      roomy,
      [range(rows, { from: first._creationTime, seen: [first] })],
      ctx,
    )
    expect(got.map((row) => row._id).sort()).toEqual(
      rows
        .slice(1)
        .map((row) => row._id)
        .sort(),
    )
  })
})

describe('the guard', () => {
  it("takes a step's ranges with its rows, so no look between them lets more ranges start than the budget holds", async () => {
    const { ctx, used, range } = counting()
    const ranges = Array.from({ length: 40 }, (_, i) => range(tied(`r${i}-`, 1, i)))
    let stopped = false
    try {
      await readAll({ ...roomy, ranges: 20 }, ranges, ctx)
    } catch (e) {
      if (!(e instanceof OverBudget)) throw e
      stopped = true
    }
    expect(stopped).toBe(true)
    expect(used.ranges).toBeLessThanOrEqual(20)
    expect(used.ranges).toBeGreaterThan(10)
  })

  it('never starts more ranges than the budget holds, whatever the budget and the number of short ranges', async () => {
    const over: string[] = []
    for (let budget = 4; budget <= 40; budget += 3)
      for (let n = budget - 3; n <= budget + 20; n += 1) {
        const { ctx, used, range } = counting()
        const ranges = Array.from({ length: n }, (_, i) => range(tied(`r${i}-`, 1, i)))
        try {
          await readAll({ ...roomy, ranges: budget }, ranges, ctx)
        } catch (e) {
          if (!(e instanceof OverBudget)) throw e
        }
        if (used.ranges > budget) over.push(`${n} ranges, budget ${budget}: ${used.ranges}`)
      }
    expect(over).toEqual([])
  })
})
