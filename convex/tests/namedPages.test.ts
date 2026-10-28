/* The shared name-ordered reader (lib/namedPages.ts): the comparator agrees
 * with the order of an index, mergeNamed merges ordered streams lazily, a
 * batch always moves forward and never claims an end it did not reach, the
 * read guard looks at the metrics only a few times a batch, and a cursor
 * opens only for the list and scope it came from. */

import { afterEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { archiveCursorText, ceilingGuard } from '../lib/archivedTasks'
import {
  compareKeys,
  compareNamed,
  indexAfter,
  mergeNamed,
  NAMED_READ,
  type Named,
  type NamedAt,
  type NamedIndex,
  type NamedStream,
  namedCursor,
  openNamedCursor,
  readBatch,
  readGuard,
  STOPPED,
} from '../lib/namedPages'
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

/* The labels of `orgId` as a NamedIndex, as model/labels.ts reads them. */
const labels = (ctx: QueryCtx, orgId: string): NamedIndex<Doc<'labels'>, number> => ({
  all: () => ctx.db.query('labels').withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId)),
  sameKey: (at) =>
    ctx.db
      .query('labels')
      .withIndex('by_org_name_lower', (q) =>
        q.eq('org_id', orgId).eq('name_lower', at.key).gt('_creationTime', at.tie),
      ),
  pastKey: (at) =>
    ctx.db
      .query('labels')
      .withIndex('by_org_name_lower', (q) => q.eq('org_id', orgId).gt('name_lower', at.key)),
  at: (label) => ({ key: label.name_lower, tie: label._creationTime }),
})

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
  let after: NamedAt<number> | null = null
  for (let round = 0; round < 1000; round++) {
    const batch = await t.run(async (ctx) => {
      const ceiling = { ranges: 1e9, documents: 1e9, bytes: 1e12 }
      return await readBatch(ctx, {
        stream: indexAfter(labels(ctx, orgId), after),
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
    after = { key: batch.at.key, tie: Number(batch.at.tie) }
  }
  throw new Error('the walk did not end')
}

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
    expect([...TRICKY].sort(compareKeys)).toEqual(indexed)
    // JavaScript's own order puts the face before the fullwidth A, the index after it
    const [face, fullwidth] = ['a\u{1F600}', 'a\u{FF21}']
    expect([...TRICKY].sort()).not.toEqual(indexed)
    expect(indexed.indexOf(fullwidth)).toBeLessThan(indexed.indexOf(face))
    expect(face < fullwidth).toBe(true)
    expect(compareKeys(face, fullwidth)).toBeGreaterThan(0)
  })

  it('pages through those keys one row a batch and through a cursor in their midst', async () => {
    const t = newT()
    const orgId = uuid()
    await plantKeys(t, orgId, TRICKY)
    const sorted = [...TRICKY].sort(compareKeys)
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
    const through = { key: 'a\u{1F600}', tie: astral?._creationTime ?? 0 }
    const upTo = await walk(t, orgId, 100, through)
    expect(upTo.keys).toEqual(sorted.slice(0, sorted.indexOf('a\u{1F600}') + 1))
    expect(upTo.keys).toContain('a\u{FF21}')
  })

  it('orders equal keys by their tie, numbers before strings', () => {
    expect(compareNamed({ key: 'x', tie: 2 }, { key: 'x', tie: 10 })).toBeLessThan(0)
    expect(compareNamed({ key: 'x', tie: 'b' }, { key: 'x', tie: 'a' })).toBeGreaterThan(0)
    expect(compareNamed({ key: 'x', tie: 9 }, { key: 'x', tie: 'a' })).toBeLessThan(0)
    expect(compareNamed({ key: 'w', tie: 9 }, { key: 'x', tie: 1 })).toBeLessThan(0)
    expect(compareNamed({ key: 'x', tie: 1 }, { key: 'x', tie: 1 })).toBe(0)
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
      yield { row: { name: key, from }, at: { key, tie } } satisfies Named<Row>
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
    let after: NamedAt<number> | null = null
    let calls = 0
    for (;;) {
      calls++
      const batch = await t.run((ctx) =>
        readBatch(ctx, {
          stream: indexAfter(labels(ctx, orgId), after),
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
      after = { key: batch.at.key, tie: Number(batch.at.tie) }
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
        stream: indexAfter(labels(ctx, orgId), null),
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
        stream: indexAfter(labels(ctx, orgId), null),
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
      for await (const _label of labels(ctx, orgId).all()) await old.document()
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
    const through = { key: 'k05', tie: k05?._creationTime ?? 0 }
    const batch = await t.run((ctx) =>
      readBatch(ctx, {
        stream: indexAfter(labels(ctx, orgId), null),
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
        stream: indexAfter(labels(ctx, orgId), null),
        keep: async (label: Doc<'labels'>) => label.name_lower,
        limit: 100,
        through,
        ceiling: { ranges: 1e9, documents: 1e9, bytes: 1e12 },
      }),
    )
    expect(after.rows).toEqual(someKeys.slice(0, 5))
    expect(after.at).toEqual(through)
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
  const at = { key: 'café \u{1F600}', tie: 1767225600000.123 }

  it('open for their own list and scope only', async () => {
    const text = await namedCursor('labels.settings', ['org', 'cafe'], at)
    expect(text).toMatch(/^[0-9a-f]+$/)
    expect(text).not.toContain('caf')
    expect(await openNamedCursor(text, 'labels.settings', ['org', 'cafe'])).toEqual(at)
    expect(await openNamedCursor(text, 'labels.picker', ['org', 'cafe'])).toBeNull()
    expect(await openNamedCursor(text, 'labels.settings', ['other', 'cafe'])).toBeNull()
    expect(await openNamedCursor(text, 'labels.settings', ['org', 'caf'])).toBeNull()
    const id = await namedCursor('people', ['org'], { key: 'ann', tie: 'a-uuid' })
    expect(await openNamedCursor(id, 'people', ['org'])).toEqual({ key: 'ann', tie: 'a-uuid' })
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
    const long = { key: '\u{1F600}'.repeat(1000), tie: 5 }
    const big = await namedCursor('labels.picker', scope, long)
    expect(await openNamedCursor(big, 'labels.picker', scope)).toEqual(long)
  })
})
