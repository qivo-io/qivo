/* The shared name-ordered reader (lib/namedPages.ts): the comparator agrees
 * with the order of an index, mergeNamed merges ordered streams lazily, a
 * batch always moves forward and never claims an end it did not reach, the
 * read guard looks at the metrics only a few times a batch, and a cursor
 * opens only for the list and scope it came from. */

import { compareValues, getDocumentSize, type Value } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { archiveCursorText, ceilingGuard } from '../lib/archivedTasks'
import {
  compareNamed,
  indexAfter,
  mergeNamed,
  NAMED_READ,
  type Named,
  type NamedAt,
  type NamedBatch,
  type NamedIndex,
  type NamedStream,
  type NamedTie,
  namedCursor,
  openNamedCursor,
  readBatch,
  readGuard,
  STOPPED,
} from '../lib/namedPages'
import { type LabelTie, labelIndex } from '../model/labels'
import { NOW, newT, type T, uuid } from './helpers.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'named-pages-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
})

/** Labels of one organization planted raw with these name_lower keys, in
 * this order, so their _creationTime follows it. */
const plantKeys = (t: T, orgId: string, keys: readonly string[]) =>
  t.run(async (ctx) => {
    for (const key of keys) {
      await ctx.db.insert('labels', {
        id: uuid(),
        org_id: orgId,
        name: key,
        name_lower: key,
        color: '#4C9AFF',
        created_at: NOW,
      })
    }
  })

/* The organization of the fake labels. */
const ORG = 'org'

/** A label of ORG as the index holds it, with the creation time given,
 * which convex-test cannot plant: it gives every insert its own. */
const fakeLabel = (name_lower: string, created: number, id: string): Doc<'labels'> => ({
  _id: id as Id<'labels'>,
  _creationTime: created,
  id,
  org_id: ORG,
  name: name_lower,
  name_lower,
  color: '#4C9AFF',
  created_at: NOW,
})

/** One range a fake query reads: fields equal to or past a value. */
type Term = { field: string; op: 'eq' | 'gt'; value: Value }

/** What labelIndex asks a fake index for. */
type Range = { eq(field: string, value: Value): Range; gt(field: string, value: Value): Range }

/**
 * A query context over `rows`, which reads model/labels.ts labelIndex's
 * ranges in the order of labels.by_org_name_lower (org_id, name_lower, then
 * _creationTime and _id) and counts each range and document it reads in its
 * own transaction metrics, so a read guard sees them. It answers only the
 * reads labelIndex makes, and `ranges` holds what each range asked for.
 */
function labelsCtx(rows: readonly Doc<'labels'>[]) {
  const used = { ranges: 0, documents: 0, bytes: 0 }
  const ranges: Term[][] = []
  const fields = (row: Doc<'labels'>) => [row.org_id, row.name_lower, row._creationTime, row._id]
  const sorted = [...rows].sort((a, b) => compareValues(fields(a), fields(b)))
  const query = (table: string) => ({
    withIndex(name: string, build: (q: Range) => unknown) {
      expect([table, name]).toEqual(['labels', 'by_org_name_lower'])
      const terms: Term[] = []
      const term = (op: Term['op']) => (field: string, value: Value) => {
        terms.push({ field, op, value })
        return q
      }
      const q: Range = { eq: term('eq'), gt: term('gt') }
      build(q)
      ranges.push(terms)
      return {
        async *[Symbol.asyncIterator]() {
          used.ranges++
          for (const row of sorted) {
            const fieldsOf = row as unknown as Record<string, Value>
            const holds = terms.every(({ field, op, value }) => {
              const order = compareValues(fieldsOf[field], value)
              return op === 'eq' ? order === 0 : order > 0
            })
            if (!holds) continue
            used.documents++
            used.bytes += getDocumentSize(row)
            yield row
          }
        },
      }
    },
  })
  const metric = (n: number, limit: number) => ({ used: n, remaining: limit - n })
  const ctx = {
    db: { query },
    meta: {
      getTransactionMetrics: async () => ({
        databaseQueries: metric(used.ranges, 4096),
        documentsRead: metric(used.documents, 32_000),
        bytesRead: metric(used.bytes, 16 << 20),
      }),
    },
  } as unknown as QueryCtx
  return { ctx, used, ranges }
}

/* Keys that differ only past their first character: characters past U+FFFF
 * (surrogate pairs in UTF-16) against characters in U+E000 to U+FFFF, where
 * JavaScript's `<` and UTF-8 byte order disagree, and the edges around them. */
const TRICKY = [
  'a\u{1F600}', // a grinning face, past U+FFFF
  'a\u{FF21}', // fullwidth A
  'a\u{E000}', // the first private use character
  'a\u{D7FB}', // the last character before the surrogates
  'a\u{10000}', // the first character past U+FFFF
  'a\u{FFFD}',
  'a\u{1F600}b',
  'a',
  'ab',
  'a\u{E9}',
]

/** Every label of `orgId` read through `limit`-row batches from the start,
 * following `at` until the end, with the batches' answers. */
async function walk(t: T, orgId: string, limit: number, through: NamedAt | null = null) {
  const keys: string[] = []
  const batches: { ended: boolean; stopped: boolean; n: number }[] = []
  let after: NamedAt<LabelTie> | null = null
  for (let round = 0; round < 1000; round++) {
    const batch = await t.run(async (ctx) => {
      const ceiling = { ranges: 1e9, documents: 1e9, bytes: 1e12 }
      return await readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), after),
        keep: async (label: Doc<'labels'>) => label.name_lower,
        limit,
        through,
        ceiling,
      })
    })
    keys.push(...batch.rows)
    batches.push({ ended: batch.ended, stopped: batch.stopped, n: batch.rows.length })
    if (batch.ended) return { keys, batches }
    if (through !== null && compareNamed(batch.at, through) === 0) return { keys, batches }
    after = labelAt(batch.at)
  }
  throw new Error('the walk did not end')
}

/* A position readBatch reached in a label list, with its tie's types. */
const labelAt = (at: NamedAt): NamedAt<LabelTie> => ({
  key: at.key,
  tie: [Number(at.tie[0]), String(at.tie[1])],
})

/* Keys in index order, as positions without a tie. */
const byKey = (a: string, b: string) => compareNamed({ key: a, tie: [] }, { key: b, tie: [] })

describe('the order', () => {
  it('compares keys as the index orders them, unlike JavaScript', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, TRICKY)
    const indexed = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('labels')
          .withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId))
          .collect()
      ).map((label) => label.name_lower),
    )
    expect([...TRICKY].sort(byKey)).toEqual(indexed)
    // JavaScript's own order puts the face before the fullwidth A, the index after it
    const [face, fullwidth] = ['a\u{1F600}', 'a\u{FF21}']
    expect([...TRICKY].sort()).not.toEqual(indexed)
    expect(indexed.indexOf(fullwidth)).toBeLessThan(indexed.indexOf(face))
    expect(face < fullwidth).toBe(true)
    expect(byKey(face, fullwidth)).toBeGreaterThan(0)
  })

  it('pages through those keys one row a batch and through a cursor in their midst', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, TRICKY)
    const sorted = [...TRICKY].sort(byKey)
    for (const limit of [1, 2, 3, 25]) {
      expect((await walk(t, orgId, limit)).keys, `limit ${limit}`).toEqual(sorted)
    }
    // `through` at the character past U+FFFF keeps the fullwidth A before it
    const astral = await t.run(async (ctx) =>
      ctx.db
        .query('labels')
        .withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId).eq('name_lower', 'a\u{1F600}'))
        .unique(),
    )
    const through = { key: 'a\u{1F600}', tie: [astral?._creationTime ?? 0, astral?._id ?? ''] }
    const upTo = await walk(t, orgId, 100, through)
    expect(upTo.keys).toEqual(sorted.slice(0, sorted.indexOf('a\u{1F600}') + 1))
    expect(upTo.keys).toContain('a\u{FF21}')
  })

  it('orders equal keys by their tie, field by field, numbers before strings', () => {
    const at = (key: string, ...tie: NamedTie) => ({ key, tie })
    expect(compareNamed(at('x', 2), at('x', 10))).toBeLessThan(0)
    expect(compareNamed(at('x', 'b'), at('x', 'a'))).toBeGreaterThan(0)
    expect(compareNamed(at('x', 9), at('x', 'a'))).toBeLessThan(0)
    expect(compareNamed(at('w', 9), at('x', 1))).toBeLessThan(0)
    expect(compareNamed(at('x', 1, 'b'), at('x', 1, 'c'))).toBeLessThan(0)
    expect(compareNamed(at('x', 1, 'z'), at('x', 2, 'a'))).toBeLessThan(0)
    expect(compareNamed(at('x', 1, 'a'), at('x', 1, 'a'))).toBe(0)
  })

  it('counts the labels of a creation instant that a resume reads again', async () => {
    // 60 labels of one name stored at one instant, which convex-test cannot plant
    const group = Array.from({ length: 60 }, (_, i) =>
      fakeLabel('same', 1000, `id${String(i).padStart(2, '0')}`),
    )
    const { ctx } = labelsCtx(group)
    // after the 40th, under a ceiling of ten documents
    const batch = await readBatch(ctx, {
      stream: indexAfter(labelIndex(ctx, ORG), { key: 'same', tie: [1000, 'id39'] }),
      keep: async (label: Doc<'labels'>) => label._id,
      limit: 25,
      through: null,
      ceiling: { ranges: 1e9, documents: 10, bytes: 1e12 },
    })
    // the 40 read again fill the ceiling, so the batch moves on by one and stops
    expect(batch).toMatchObject({ rows: ['id40'], ended: false, stopped: true })
  })

  it('resumes inside a creation instant that rows of one key share', async () => {
    // rows as an index holds them: key, creation time, id
    type Entry = { key: string; time: number; id: string }
    const entries: Entry[] = [
      { key: 'k', time: 1, id: 'a' },
      { key: 'k', time: 1, id: 'b' },
      { key: 'k', time: 1, id: 'c' },
      { key: 'k', time: 2, id: 'a' },
      { key: 'l', time: 1, id: 'a' },
    ]
    const range = (keep: (e: Entry) => boolean) =>
      async function* () {
        for (const e of entries) if (keep(e)) yield e
      }
    // the three ranges model/labels.ts labelIndex reads after a position
    const index: NamedIndex<Entry, readonly [number, string]> = {
      all: range(() => true),
      after: ({ key, tie: [time] }) => [
        range((e) => e.key === key && e.time === time),
        range((e) => e.key === key && e.time > time),
        range((e) => e.key > key),
      ],
      at: (e) => ({ key: e.key, tie: [e.time, e.id] }),
    }
    const t = newT()
    const seen: string[] = []
    let after: NamedAt<readonly [number, string]> | null = null
    for (let round = 0; round < 10; round++) {
      const from: NamedAt<readonly [number, string]> | null = after
      const batch: NamedBatch<string> = await t.run((ctx) =>
        readBatch(ctx, {
          stream: indexAfter(index, from),
          keep: async (e: Entry) => `${e.key}${e.time}${e.id}`,
          limit: 1,
          through: null,
          ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
        }),
      )
      seen.push(...batch.rows)
      if (batch.ended) break
      after = { key: batch.at.key, tie: [Number(batch.at.tie[0]), String(batch.at.tie[1])] }
    }
    expect(seen).toEqual(['k1a', 'k1b', 'k1c', 'k2a', 'l1a'])
  })
})

/* ------------------------------------------------------------- the merge */

type Row = { name: string; from: string }

/** An in-memory stream of `rows`, [key, tie] pairs in order, that counts
 * the rows handed out in `pulled` and hands out STOPPED after `stopAfter`
 * rows when given. */
function memory(
  from: string,
  rows: readonly (readonly [string, number | string])[],
  pulled: Record<string, number>,
  stopAfter?: number,
): NamedStream<Row> {
  pulled[from] = 0
  return (async function* () {
    for (const [i, [key, tie]] of rows.entries()) {
      if (i === stopAfter) {
        yield STOPPED
        return
      }
      pulled[from]++
      yield { row: { name: key, from }, at: { key, tie: [tie] } } satisfies Named<Row>
    }
  })()
}

/** Everything `stream` hands out, as `key/tie@from` and `STOPPED`. */
async function drain(stream: NamedStream<Row>, most = Number.POSITIVE_INFINITY) {
  const out: string[] = []
  for await (const item of stream) {
    out.push(item === STOPPED ? 'STOPPED' : `${item.at.key}/${item.at.tie}@${item.row.from}`)
    if (out.length >= most) break
  }
  return out
}

describe('mergeNamed', () => {
  it('merges by key, then tie, then the order of the streams', async () => {
    const pulled: Record<string, number> = {}
    const merged = mergeNamed([
      memory(
        'admins',
        [
          ['ann', 'id3'],
          ['bo', 'id1'],
          ['zed', 'id9'],
        ],
        pulled,
      ),
      memory(
        'users',
        [
          ['ann', 'id1'],
          ['bo', 'id1'],
          ['cy', 'id2'],
        ],
        pulled,
      ),
      memory('empty', [], pulled),
      memory('viewers', [['bo', 'id0']], pulled),
    ])
    expect(await drain(merged)).toEqual([
      'ann/id1@users',
      'ann/id3@admins',
      'bo/id0@viewers',
      // equal positions in two streams come in stream order
      'bo/id1@admins',
      'bo/id1@users',
      'cy/id2@users',
      'zed/id9@admins',
    ])
  })

  it('reads a stream only when its next row may come next', async () => {
    const pulled: Record<string, number> = {}
    const long = Array.from(
      { length: 1000 },
      (_, i) => [`k${String(i).padStart(4, '0')}`, i] as const,
    )
    const merged = mergeNamed([memory('long', long, pulled), memory('late', [['zzz', 1]], pulled)])
    expect(await drain(merged, 10)).toHaveLength(10)
    // the ten handed out and the other stream's head: the row after the
    // tenth is read only when someone asks for an eleventh
    expect(pulled).toEqual({ long: 10, late: 1 })
    expect(await drain(mergeNamed([memory('only', long, {})]))).toHaveLength(1000)
  })

  it('stops once a stream stops, after the rows known to come before', async () => {
    const pulled: Record<string, number> = {}
    const merged = mergeNamed([
      memory(
        'a',
        [
          ['a1', 1],
          ['a2', 1],
          ['a3', 1],
        ],
        pulled,
        2,
      ),
      memory(
        'b',
        [
          ['a1', 2],
          ['b1', 1],
        ],
        pulled,
      ),
    ])
    // after a2, a's next row is unknown, so b1 may not come before it
    expect(await drain(merged)).toEqual(['a1/1@a', 'a1/2@b', 'a2/1@a', 'STOPPED'])
    const first = mergeNamed([memory('a', [['a1', 1]], {}), memory('b', [['b1', 1]], {}, 0)])
    expect(await drain(first)).toEqual(['STOPPED'])
    expect(await drain(mergeNamed([]))).toEqual([])
  })
})

/* ------------------------------------------------------------- the batch */

describe('readBatch', () => {
  it('answers a stream that stops as stopped, never as the end', async () => {
    const t = newT()
    const rows: [string, number][] = [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]
    const read = (limit: number) =>
      t.run((ctx) =>
        readBatch(ctx, {
          stream: () => memory('m', rows, {}, 2),
          keep: async (row: Row) => row.name,
          limit,
          through: null,
          ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
        }),
      )
    expect(await read(25)).toEqual({
      rows: ['a', 'b'],
      at: { key: 'b', tie: [1] },
      ended: false,
      stopped: true,
    })
    // a full batch whose peek stops is full, not stopped, and not the end
    expect(await read(2)).toEqual({
      rows: ['a', 'b'],
      at: { key: 'b', tie: [1] },
      ended: false,
      stopped: false,
    })
  })

  const someKeys = Array.from({ length: 30 }, (_, i) => `k${String(i).padStart(2, '0')}`)

  it('says the end in a full batch that ends with the list, and only then', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, someKeys.slice(0, 10))
    const { batches } = await walk(t, orgId, 5)
    // the second batch is full and ends with the list, so a third is not needed
    expect(batches).toEqual([
      { ended: false, stopped: false, n: 5 },
      { ended: true, stopped: false, n: 5 },
    ])
    expect((await walk(t, uuid(), 5)).batches).toEqual([{ ended: true, stopped: false, n: 0 }])
  })

  it('moves forward by one row when the request has no room left, and never claims the end', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, someKeys)
    const seen: string[] = []
    let after: NamedAt<LabelTie> | null = null
    let calls = 0
    for (;;) {
      // a batch that does not move forward would loop here
      if (++calls > 2 * someKeys.length) throw new Error('the batches did not move forward')
      const batch = await t.run((ctx) =>
        readBatch(ctx, {
          stream: indexAfter(labelIndex(ctx, orgId), after),
          keep: async (label: Doc<'labels'>) => label.name_lower,
          limit: 25,
          through: null,
          // a ceiling the request has passed already
          ceiling: { ranges: 0, documents: 0, bytes: 0 },
        }),
      )
      seen.push(...batch.rows)
      if (batch.ended) break
      expect(batch.stopped).toBe(true)
      expect(batch.rows).toHaveLength(1)
      after = labelAt(batch.at)
    }
    expect(seen).toEqual(someKeys)
    // one row a call, and a last call that finds the end
    expect(calls).toBe(someKeys.length + 1)
  })

  it('counts what keep reads and stops after the row whose reads reach the ceiling', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, someKeys)
    const batch = await t.run(async (ctx) => {
      const m = await ctx.meta.getTransactionMetrics()
      return await readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), null),
        // every row looks up two labels, which the ceiling's ranges count
        keep: async (label: Doc<'labels'>, guard) => {
          for (let i = 0; i < 2; i++) {
            await guard.lookup(() =>
              ctx.db
                .query('labels')
                .withIndex('by_uuid', (q) => q.eq('id', label.id))
                .unique(),
            )
          }
          return label.name_lower
        },
        limit: 25,
        through: null,
        ceiling: {
          ranges: m.databaseQueries.used + 7,
          documents: 1e9,
          bytes: 1e12,
        },
      })
    })
    // one range for the list and two a row fill seven after three rows; the
    // fourth row's reads find the ceiling reached, finish, and end the batch
    expect(batch.rows).toEqual(someKeys.slice(0, 4))
    expect(batch).toMatchObject({ ended: false, stopped: true })
  })

  it('looks at the metrics a few times for a long scan of small rows', async () => {
    const t = newT()
    const orgId = uuid()
    const many = Array.from({ length: 3000 }, (_, i) => `m${String(i).padStart(5, '0')}`)
    await plantKeys(t, orgId, many)
    const looks = await t.run(async (ctx) => {
      let n = 0
      const meta = ctx.meta as {
        getTransactionMetrics: () => ReturnType<QueryCtx['meta']['getTransactionMetrics']>
      }
      const real = meta.getTransactionMetrics.bind(meta)
      meta.getTransactionMetrics = () => {
        n++
        return real()
      }
      const m = await real()
      const batch = await readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), null),
        keep: async () => null,
        limit: 25,
        through: null,
        ceiling: {
          ranges: m.databaseQueries.used + NAMED_READ.ranges,
          documents: m.documentsRead.used + NAMED_READ.documents,
          bytes: m.bytesRead.used + NAMED_READ.bytes,
        },
      })
      expect(batch).toMatchObject({ rows: [], ended: true, stopped: false })
      const sized = n
      // the same scan under ceilingGuard, which counts 1 MiB a document
      n = 0
      const after = await real()
      const old = ceilingGuard(ctx, {
        ranges: after.databaseQueries.used + NAMED_READ.ranges,
        documents: after.documentsRead.used + NAMED_READ.documents,
        bytes: after.bytesRead.used + NAMED_READ.bytes,
      })
      await old.range()
      for await (const _label of labelIndex(ctx, orgId).all()) await old.document()
      return { sized, old: n }
    })
    console.log(
      `a scan of ${many.length} small labels looked at the metrics ${looks.sized} times, ` +
        `and ${looks.old} times under ceilingGuard`,
    )
    expect(looks.sized).toBeLessThanOrEqual(3)
    expect(looks.old).toBeGreaterThan(many.length / 8)
  })

  it('stops at `through` and answers it as the position reached', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, someKeys.slice(0, 10))
    const k05 = await t.run(async (ctx) =>
      ctx.db
        .query('labels')
        .withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId).eq('name_lower', 'k05'))
        .unique(),
    )
    const through = { key: 'k05', tie: [k05?._creationTime ?? 0, k05?._id ?? ''] }
    const batch = await t.run((ctx) =>
      readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), null),
        keep: async (label: Doc<'labels'>) => label.name_lower,
        limit: 100,
        through,
        ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
      }),
    )
    expect(batch).toMatchObject({ rows: someKeys.slice(0, 6), ended: false, stopped: false })
    expect(batch.at).toEqual(through)
    // the label at `through` gone, the batch still ends there
    await t.run(async (ctx) => {
      if (k05 !== null) await ctx.db.delete(k05._id)
    })
    const after = await t.run((ctx) =>
      readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), null),
        keep: async (label: Doc<'labels'>) => label.name_lower,
        limit: 100,
        through,
        ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
      }),
    )
    expect(after.rows).toEqual(someKeys.slice(0, 5))
    expect(after.at).toEqual(through)
  })

  it('answers a batch that reached `through` as complete when the budget ends there too', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, someKeys.slice(0, 10))
    const k05 = await t.run(async (ctx) =>
      ctx.db
        .query('labels')
        .withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId).eq('name_lower', 'k05'))
        .unique(),
    )
    const through = { key: 'k05', tie: [k05?._creationTime ?? 0, k05?._id ?? ''] }
    // a ceiling of six documents fills at k05, the sixth label
    const filled = await t.run(async (ctx) => {
      const m = await ctx.meta.getTransactionMetrics()
      return await readBatch(ctx, {
        stream: indexAfter(labelIndex(ctx, orgId), null),
        keep: async (label: Doc<'labels'>) => label.name_lower,
        limit: 100,
        through,
        ceiling: { ranges: 1e9, documents: m.documentsRead.used + 6, bytes: 1e12 },
      })
    })
    expect(filled).toMatchObject({ rows: someKeys.slice(0, 6), ended: false, stopped: false })
    expect(filled.at).toEqual(through)
    // a stream that stops right after the row at `through`
    const rows: [string, number][] = [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]
    const stopped = await t.run((ctx) =>
      readBatch(ctx, {
        stream: () => memory('m', rows, {}, 2),
        keep: async (row: Row) => row.name,
        limit: 100,
        through: { key: 'b', tie: [1] },
        ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
      }),
    )
    expect(stopped).toEqual({
      rows: ['a', 'b'],
      at: { key: 'b', tie: [1] },
      ended: false,
      stopped: false,
    })
  })
})

describe('readGuard', () => {
  it('refuses a range once the ceiling is reached and stays refused', async () => {
    const t = newT()
    const out = await t.run(async (ctx) => {
      const m = await ctx.meta.getTransactionMetrics()
      const guard = readGuard(ctx, {
        ranges: m.databaseQueries.used + 2,
        documents: 1e9,
        bytes: 1e12,
      })
      const answers = [await guard.range(), await guard.range()]
      // two ranges read, as the guard counted them
      await ctx.db.query('labels').first()
      await ctx.db.query('labels').first()
      answers.push(await guard.range(), await guard.range())
      return { answers, full: guard.full }
    })
    expect(out).toEqual({ answers: [true, true, false, false], full: true })
  })
})

/* ----------------------------------------------------------- the cursors */

describe('named cursors', () => {
  const at = { key: 'café \u{1F600}', tie: [1767225600000.123, 'a-label-id'] }

  it('open for their own list and scope only', async () => {
    const text = await namedCursor('labels.settings', ['org', 'cafe'], at)
    expect(text).toMatch(/^[0-9a-f]+$/)
    expect(text).not.toContain('caf')
    expect(await openNamedCursor(text, 'labels.settings', ['org', 'cafe'])).toEqual(at)
    expect(await openNamedCursor(text, 'labels.picker', ['org', 'cafe'])).toBeNull()
    expect(await openNamedCursor(text, 'labels.settings', ['other', 'cafe'])).toBeNull()
    expect(await openNamedCursor(text, 'labels.settings', ['org', 'caf'])).toBeNull()
    const id = await namedCursor('people', ['org'], { key: 'ann', tie: ['a-uuid'] })
    expect(await openNamedCursor(id, 'people', ['org'])).toEqual({ key: 'ann', tie: ['a-uuid'] })
    // a tie of more than four fields is never written
    await expect(
      namedCursor('people', ['org'], { key: 'ann', tie: [1, 2, 3, 4, 5] }),
    ).rejects.toThrow()
  })

  it('refuse a changed, malformed, archive or overlong text', async () => {
    const scope = ['org', '']
    const text = await namedCursor('labels.picker', scope, at)
    const flipped = `${text.slice(0, 10)}${text[10] === '0' ? '1' : '0'}${text.slice(11)}`
    const archive = await archiveCursorText({ created: 1, id: 'abc', archived_at: NOW }, 'p')
    for (const bad of [
      flipped,
      text.slice(0, -2),
      'not hex',
      '',
      archive,
      archive.slice(2),
      `${text}${'0'.repeat(40_000)}`,
      'ab'.repeat(30_000),
    ]) {
      expect(await openNamedCursor(bad, 'labels.picker', scope), bad.slice(0, 40)).toBeNull()
    }
    // a key of a few KB still opens
    const long = { key: '\u{1F600}'.repeat(1000), tie: [5] }
    const big = await namedCursor('labels.picker', scope, long)
    expect(await openNamedCursor(big, 'labels.picker', scope)).toEqual(long)
  })
})
