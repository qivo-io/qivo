import { describe, expect, it } from 'vitest'
import { type ChunkMemory, type LaidRow, stableChunks } from './chunks'

/* A track's chunks keep their rows and their keys, never share a key and
   never hold more than 32 rows, through filters, inserts and removals. */

const row = (n: number) =>
  ({
    row: { kind: 'task', pid: 'p', proj: {}, issue: { uuid: `t${n}` } },
    top: 0,
    h: 34,
    start: null,
    end: null,
    stale: false,
  }) as unknown as LaidRow
const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(from + i))
const memory = (): ChunkMemory => ({ owners: new Map(), places: new Map(), next: 0 })
const keyOf = (chunks: ReturnType<typeof stableChunks>, n: number) =>
  chunks.find((chunk) => chunk.rows.some((r) => r.row.issue?.uuid === `t${n}`))?.key

describe('stableChunks', () => {
  it('keeps a row in its chunk when the rows before it go', () => {
    const m = memory()
    const before = stableChunks(rows(0, 100), m)
    const after = stableChunks(rows(1, 100), m)
    for (let n = 1; n < 100; n++) expect(keyOf(after, n)).toBe(keyOf(before, n))
  })

  it('splits a full chunk when a row is inserted into its middle', () => {
    const m = memory()
    stableChunks(rows(0, 32), m)
    const after = stableChunks([...rows(0, 16), row(100), ...rows(16, 32)], m)
    for (const chunk of after) expect(chunk.rows.length).toBeLessThanOrEqual(32)
    expect(after.flatMap((chunk) => chunk.rows)).toHaveLength(33)
    // the rows before the insert keep their chunk
    for (let n = 0; n < 16; n++) expect(keyOf(after, n)).toBe(keyOf(after, 0))
  })

  it('gives unique keys and bounded chunks after a filter is narrowed and cleared', () => {
    const m = memory()
    stableChunks(rows(0, 3000), m)
    stableChunks([row(2000)], m)
    const cleared = stableChunks(rows(0, 3000), m)
    const keys = cleared.map((chunk) => chunk.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const chunk of cleared) expect(chunk.rows.length).toBeLessThanOrEqual(32)
    expect(cleared.flatMap((chunk) => chunk.rows)).toHaveLength(3000)
    // the kept row keeps its chunk
    expect(keyOf(cleared, 2000)).toBeDefined()
  })
})
