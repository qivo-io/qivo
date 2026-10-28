/* Name-ordered lists read a batch at a time: Settings > Labels and the task
 * label picker (model/labels.ts labelBatch), and later the people, team and
 * picker lists of Settings and the REST and MCP lists. A list is one index,
 * or a merge of several (mergeNamed), in the order of a name key (a label's
 * name_lower, a profile's or a team's name_key, lib/nameKey.ts) and then of
 * the fields the index orders equal keys by, the tie: the id or profile_id
 * for the name indexes that end in one, and _creationTime and _id, Convex's
 * implicit last fields, for an index that ends in nothing else. Convex does
 * not promise distinct creation times, so a tie on _creationTime alone could
 * skip a row. Positions compare as Convex orders values (compareNamed), with
 * strings in UTF-8 byte order, so the order differs from JavaScript's `<`
 * for characters past the Basic Multilingual Plane and from the browser's
 * localeCompare.
 *
 * A position names a place in that order, just after the row with its key
 * and tie, so a batch reads only what follows it, however long the list, and
 * a row created, renamed or deleted between batches lands where its name puts
 * it. Each list names the index ranges that hold everything past a position
 * (NamedIndex), and indexAfter leaves out any row they hold that is not past
 * it. Callers get positions sealed together with the list and its scope
 * (namedCursor, lib/archiveCursorSeal.ts), so a cursor is opaque and opens
 * only for the list and scope it came from.
 *
 * A batch (readBatch) reads rows in order and keeps those its caller wants,
 * under a read guard (readGuard) that counts every index range and document
 * the batch reads, the caller's own reads for each row included, against a
 * ceiling (namedCeiling). These lists are subscription queries that run again
 * on every change of what they read, so one call keeps to NAMED_READ. Past it
 * the batch stops at the position it reached: a search that matches little
 * answers part of the list and goes on from there, and a batch never answers
 * an end of list it did not reach.
 *
 * This module imports no model code, so lib/access.ts and model/labels.ts can
 * use it without an import cycle through lib/archivedTasks.ts, whose
 * ARCHIVE_RESERVE reads model/comments.ts when it loads. */

import type { GenericDocument, TransactionMetric } from 'convex/server'
import { compareValues, getDocumentSize } from 'convex/values'
import type { QueryCtx } from '../_generated/server'
import { openCursorText, sealCursorText } from './archiveCursorSeal'
import type { ReadCeiling } from './archivedTasks'

/* ------------------------------------------------------------- the order */

/** The fields an index orders equal name keys by, in index order. */
export type NamedTie = readonly (number | string)[]

/** A place in a name-ordered list, just after the row with this `key`, the
 * list's name key, and this `tie`. Keys need not be unique: rows stored with
 * one key before a list's names were unique still page, one tie at a time. */
export type NamedAt<Tie extends NamedTie = NamedTie> = { key: string; tie: Tie }

/** A row of a name-ordered list with its position. */
export type Named<Row> = { row: Row; at: NamedAt }

/** What a stream hands out instead of a row once the read guard refused an
 * index range it needed. Nothing is known about the rows after it. */
export const STOPPED = 'stopped'

/** A read of a name-ordered list: its rows in order, then its end, or
 * STOPPED. */
export type NamedStream<Row> = AsyncIterable<Named<Row> | typeof STOPPED>

/** Compares two positions as an index orders them, key first and then the
 * tie's fields, with Convex's own order of values (compareValues), which
 * compares strings by their UTF-8 bytes. JavaScript's `<` compares UTF-16
 * units instead and puts a character past U+FFFF before one in U+E000 to
 * U+FFFF. Every comparison of positions in this module goes through it,
 * since a merge or a `through` check that disagreed with the index would
 * skip rows. Answers a negative number, 0 or a positive number. */
export const compareNamed = (a: NamedAt, b: NamedAt): number =>
  compareValues([a.key, ...a.tie], [b.key, ...b.tie])

/* ----------------------------------------------------------- the streams */

/** One index read in name order: the whole list from its start; the index
 * ranges, in order, that hold every row past a position, such as the rest of
 * its key and then every greater key, which may also hold rows at or before
 * it; and the position of a row. */
export type NamedIndex<Row, Tie extends NamedTie> = {
  all: () => AsyncIterable<Row>
  after: (at: NamedAt<Tie>) => readonly (() => AsyncIterable<Row>)[]
  at: (row: Row) => NamedAt<Tie>
}

/** What a stream tells the batch that reads it (readBatch): `open` asks
 * whether it may start one more index range, and `skip` counts a row it read
 * and left out, so the read budget sees it. */
export type NamedReads = {
  open(): Promise<boolean>
  skip(row: GenericDocument): Promise<void>
}

/** The rows of `index` after `after`, or from its start, as a stream for
 * readBatch. It reads the index's ranges in turn, each opened only once the
 * one before it is read to its end, and only when `reads.open` agrees; when
 * it does not, the stream hands out STOPPED and ends. A row a range holds
 * that is not past `after`, such as one created at the same instant before
 * it, is read, counted (`reads.skip`) and left out, so a resume inside a
 * large instant fills the budget instead of passing it. */
export function indexAfter<Row extends GenericDocument, Tie extends NamedTie>(
  index: NamedIndex<Row, Tie>,
  after: NamedAt<Tie> | null,
): (reads: NamedReads) => NamedStream<Row> {
  const ranges = after === null ? [index.all] : index.after(after)
  return async function* (reads) {
    for (const range of ranges) {
      if (!(await reads.open())) {
        yield STOPPED
        return
      }
      for await (const row of range()) {
        const at = index.at(row)
        if (after === null || compareNamed(at, after) > 0) yield { row, at }
        else await reads.skip(row)
      }
    }
  }
}

/** The rows of `streams`, each in name order, as one stream in name order.
 * Rows at equal positions come in the order of their streams. It reads every
 * stream's first row before it hands out one, and after that reads a
 * stream's next row only when the next row asked for may be it, so a batch
 * reads at most one row past its last from each stream. Once a stream hands
 * out STOPPED, its later rows are unknown, so the merge hands out STOPPED and
 * ends too: the rows it handed out are every row up to the last of them. */
export async function* mergeNamed<Row>(
  streams: readonly NamedStream<Row>[],
): AsyncGenerator<Named<Row> | typeof STOPPED> {
  const open = streams.map((stream) => stream[Symbol.asyncIterator]())
  // the next row of stream `i`, or null at its end
  const pull = async (i: number) => {
    const step = await open[i].next()
    return step.done === true ? null : step.value
  }
  const heads: (Named<Row> | null)[] = []
  try {
    for (let i = 0; i < open.length; i++) {
      const head = await pull(i)
      if (head === STOPPED) {
        yield STOPPED
        return
      }
      heads.push(head)
    }
    for (;;) {
      let best = -1
      heads.forEach((head, i) => {
        const leader = best < 0 ? null : heads[best]
        if (head !== null && (leader === null || compareNamed(head.at, leader.at) < 0)) best = i
      })
      const head = best < 0 ? null : heads[best]
      if (head === null) return
      yield head
      const next = await pull(best)
      if (next === STOPPED) {
        yield STOPPED
        return
      }
      heads[best] = next
    }
  } finally {
    for (const stream of open) await stream.return?.()
  }
}

/* ------------------------------------------------------------- the budget */

/** What one call of a name-ordered list may read, counted from the call's
 * start with Convex's own transaction metrics: 2,000 index ranges, 8,000
 * documents and 4 MiB. It is the share a workspace part reads before it asks
 * to be cut (lib/workspaceParts.ts PAGE.soft), because these lists are
 * subscription queries too and run again on every change of what they read.
 * Tests lower it. */
export const NAMED_READ: ReadCeiling = { ranges: 2000, documents: 8000, bytes: 4 * 1024 * 1024 }

/** What a call keeps back from the request's limits whatever its share: the
 * first row a batch reads whatever the guard says, with the reads its caller
 * makes for it, and a few lookups around the walk. The bytes hold four
 * documents at Convex's 1 MiB size limit. */
export const NAMED_RESERVE: ReadCeiling = { ranges: 16, documents: 64, bytes: 4 * 1024 * 1024 }

/** A ceiling as transaction totals: `share` past what the request has read
 * so far, NAMED_READ for a walk of a list, never more than the request has
 * left less NAMED_RESERVE. Reads after this point count against it, also
 * those made before a walk starts. */
export async function namedCeiling(
  ctx: QueryCtx,
  share: ReadCeiling = NAMED_READ,
): Promise<ReadCeiling> {
  const m = await ctx.meta.getTransactionMetrics()
  const under = (metric: TransactionMetric, more: number, reserve: number) =>
    Math.min(metric.used + more, metric.used + metric.remaining - reserve)
  return {
    ranges: under(m.databaseQueries, share.ranges, NAMED_RESERVE.ranges),
    documents: under(m.documentsRead, share.documents, NAMED_RESERVE.documents),
    bytes: under(m.bytesRead, share.bytes, NAMED_RESERVE.bytes),
  }
}

/** A walk's check of the request's reads against a ceiling. The walk reports
 * every index range before it starts it and every document it reads, and
 * the guard counts each document at its own size (getDocumentSize, Convex's
 * own measure), looking at the transaction's metrics only once the counted
 * reads could have used what the last look left. A list of small rows then
 * looks a few times a batch. lib/archivedTasks.ts ceilingGuard counts every
 * document at Convex's 1 MiB limit instead, which under a 4 MiB ceiling looks
 * every few documents, and a look costs about as much as an index range. */
export type ReadGuard = {
  /** Counts an index range the walk is about to start, and answers whether
   * the ceiling had room for it. */
  range(): Promise<boolean>
  /** Counts `doc`, a document the walk just read, and answers whether the
   * walk may go on. */
  document(doc: GenericDocument): Promise<boolean>
  /** `read()`, a lookup of at most one document in one index range, counted.
   * It reads whatever the ceiling says, so a row's own reads always finish,
   * and `full` then tells the walk to stop. */
  lookup<D extends GenericDocument>(read: () => Promise<D | null>): Promise<D | null>
  /** Whether a check found the ceiling reached. Every later check answers
   * no. */
  readonly full: boolean
}

/** A ReadGuard for `ceiling`, transaction totals such as namedCeiling's. */
export function readGuard(ctx: QueryCtx, ceiling: ReadCeiling): ReadGuard {
  // what the reads counted since the last look may still use
  let left = { ranges: 0, documents: 0, bytes: 0 }
  let full = false
  const look = async (): Promise<boolean> => {
    const m = await ctx.meta.getTransactionMetrics()
    left = {
      ranges: ceiling.ranges - m.databaseQueries.used,
      documents: ceiling.documents - m.documentsRead.used,
      bytes: ceiling.bytes - m.bytesRead.used,
    }
    full = left.ranges <= 0 || left.documents <= 0 || left.bytes <= 0
    return !full
  }
  const guard: ReadGuard = {
    async range() {
      if (full || (left.ranges <= 0 && !(await look()))) return false
      left.ranges -= 1
      return true
    },
    async document(doc) {
      left.documents -= 1
      left.bytes -= getDocumentSize(doc)
      if (full) return false
      return (left.documents > 0 && left.bytes > 0) || (await look())
    },
    async lookup(read) {
      await guard.range()
      const doc = await read()
      if (doc !== null) await guard.document(doc)
      return doc
    },
    get full() {
      return full
    },
  }
  return guard
}

/* -------------------------------------------------------------- the batch */

/** One batch of a name-ordered list (readBatch). */
export type NamedBatch<Out> = {
  /** what `keep` answered for the rows it kept, in order */
  rows: Out[]
  /** whether the guard ended the batch before it held `limit` rows, reached
   * `through` or reached the end */
  stopped: boolean
} & (
  | {
      /** no row follows `at` */
      ended: true
      /** the last row passed to `keep`, or null when the batch read none */
      at: NamedAt | null
    }
  | {
      ended: false
      /** the position the batch reached: the last row passed to `keep`,
       * kept or not, or `through` once the batch read a row past it */
      at: NamedAt
    }
)

/**
 * One batch of a name-ordered list. It reads `stream`'s rows in order and
 * passes each to `keep`, which answers what to send for it or null to leave
 * it out (a search miss, a person a list does not show), counting its own
 * reads with the guard it is given. It stops once `limit` rows are kept,
 * when the next row lies past `through`, when the stream ends, or when the
 * guard on `ceiling` refuses the next read or finds the ceiling reached
 * after a row. The rows the stream reads and leaves out count too
 * (NamedReads). A full batch reads one row more, so a batch that ends with
 * the list says so. `limit` is at least 1.
 *
 * It always reads its first row, and the ranges before it, whatever the
 * guard says, so a caller that follows `at` always moves forward, also in a
 * request that has almost no room left. It never answers `ended` for a batch
 * the guard stopped. A position past `through` answers `through` as `at`, so
 * a batch kept live between two cursors ends at its own, and a batch that
 * read the row at `through` is complete, never stopped, also when the guard
 * ends it right there.
 */
export async function readBatch<Row extends GenericDocument, Out>(
  ctx: QueryCtx,
  o: {
    stream: (reads: NamedReads) => NamedStream<Row>
    keep: (row: Row, guard: ReadGuard) => Promise<Out | null>
    limit: number
    through: NamedAt | null
    ceiling: ReadCeiling
  },
): Promise<NamedBatch<Out>> {
  if (o.limit < 1) throw new Error('a batch holds at least one row')
  const guard = readGuard(ctx, o.ceiling)
  // whether the batch has read a row; before it, every range opens
  let moved = false
  const rows: Out[] = []
  let at: NamedAt | null = null
  const stream = o
    .stream({
      open: async () => (await guard.range()) || !moved,
      skip: async (row) => {
        await guard.document(row)
      },
    })
    [Symbol.asyncIterator]()
  // whether the batch has read the row at `through`, which completes it
  const reached = (last: NamedAt) => o.through !== null && compareNamed(last, o.through) >= 0
  try {
    for (;;) {
      const step = await stream.next()
      const full = rows.length >= o.limit
      if (step.done === true) return { rows, at, ended: true, stopped: false }
      if (step.value === STOPPED) {
        if (at === null) throw new Error('a batch reads its first row whatever the guard says')
        return { rows, at, ended: false, stopped: !full && !reached(at) }
      }
      await guard.document(step.value.row)
      if (o.through !== null && compareNamed(step.value.at, o.through) > 0) {
        return { rows, at: o.through, ended: false, stopped: false }
      }
      if (full && at !== null) return { rows, at, ended: false, stopped: false }
      moved = true
      at = step.value.at
      const kept = await o.keep(step.value.row, guard)
      if (kept !== null) rows.push(kept)
      if (guard.full) {
        return { rows, at, ended: false, stopped: rows.length < o.limit && !reached(at) }
      }
    }
  } finally {
    await stream.return?.()
  }
}

/* ------------------------------------------------------------ the cursors */

/* The version of the text a cursor seals. */
const CURSOR_VERSION = 1

/* The most a position takes as JSON, its key and its tie: a key of a few KB,
 * since a name key of NAME_MAX units can take 2,640 bytes, and JSON writes a
 * control character as six, and a tie of a time and an id or two. The scope,
 * whose normalized search NFKD can make many times longer than the search,
 * counts on its own (openNamedCursor). */
const POSITION_BYTES = 8 * 1024

/* The most fields a tie has. */
const TIE_FIELDS = 4

/* The tag GCM-SIV adds to a sealed text (lib/archiveCursorSeal.ts). */
const TAG_BYTES = 16

/** `at` as a cursor of the list named `list` with scope `scope`, such as an
 * organization's id and a normalized search: a versioned JSON array of the
 * list, the scope and the position, sealed (lib/archiveCursorSeal.ts), so it
 * shows nothing and opens only for that list and scope (openNamedCursor). A
 * tie holds at most four fields. */
export async function namedCursor(
  list: string,
  scope: readonly string[],
  at: NamedAt,
): Promise<string> {
  if (at.tie.length > TIE_FIELDS) throw new Error('a tie holds at most four fields')
  return await sealCursorText(JSON.stringify([CURSOR_VERSION, list, scope, [at.key, at.tie]]))
}

/** The position `text` names, or null when it is not a cursor namedCursor
 * wrote for `list` and `scope`: it does not open, it names another list or
 * scope, or it is longer than any such cursor can be, a bound that grows
 * with the scope, so a long normalized search never makes the server refuse
 * its own cursor. Callers refuse null, and check that the tie has the fields
 * their index orders by. */
export async function openNamedCursor(
  text: string,
  list: string,
  scope: readonly string[],
): Promise<NamedAt | null> {
  // UTF-8 takes at most three bytes a UTF-16 unit, and hex two characters a byte
  const most =
    2 * (3 * JSON.stringify([CURSOR_VERSION, list, scope]).length + POSITION_BYTES + TAG_BYTES)
  if (text.length > most) return null
  const opened = await openCursorText(text)
  if (opened === null) return null
  let sealed: unknown
  try {
    sealed = JSON.parse(opened)
  } catch {
    return null
  }
  if (!Array.isArray(sealed) || sealed.length !== 4) return null
  const [version, name, from, at] = sealed as unknown[]
  if (version !== CURSOR_VERSION || name !== list) return null
  if (JSON.stringify(from) !== JSON.stringify(scope)) return null
  if (!Array.isArray(at) || at.length !== 2) return null
  const [key, tie] = at as unknown[]
  if (typeof key !== 'string' || !Array.isArray(tie) || tie.length > TIE_FIELDS) return null
  const fields: (number | string)[] = []
  for (const field of tie as unknown[]) {
    if (typeof field !== 'number' && typeof field !== 'string') return null
    fields.push(field)
  }
  return { key, tie: fields }
}
