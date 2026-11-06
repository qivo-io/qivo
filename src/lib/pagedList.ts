/* A list the server answers a batch at a time in its own order, with a
   search over the whole list and Load more, as Settings' lists and the
   pickers read them: API access's person filter, Settings › Labels,
   Billing's Storage by project (panels/BillingStorage.tsx, largest
   first), the removal window's Reassign picker, the task window's
   relation pickers, the shared project picker
   (components/ProjectPicker.tsx), and later Settings' teams and people
   (the limits plan's "Settings team list
   loading"). It holds only what the page shows, in the page, and drops it
   when the page is left. It imports nothing from the store.

   A list reads its batches from one of two sources (BatchSource):

   - `once`: each batch is one read on demand, never subscribed to, as API
     access, Billing's Storage by project and the removal window's Reassign
     picker read everything. Load
     more reads after the last batch's `next`; one read runs at a time, so a
     second press or a Retry while one runs reads nothing. A failed batch
     keeps the rows and the place, and Retry reads it again, or starts again
     when the first batch failed. A first answer with no rows stays in
     `answers`, as the live engine keeps it, and a later one, which fails
     the list, in `failure`, so a page can say why. Nothing is subscribed,
     so a hidden tab has nothing to pause.
   - `live`: each batch is a live read (lib/liveView.ts watchLive) that
     runs again whenever what it read changes, on the rules of the
     Overview's lists (store/overviewLists.ts):
     - Only the last batch is open (no `through`). Load more pins it. The
       batch is read again between its `after` and the `next` it answered,
       and the next batch opens at that `next`. The pinned read and the new
       open one replace the open batch together once both answered; until
       then the list shows the open batch's answer from the press. A label
       or person added before the end of a pinned batch therefore shows in
       it, and pushes no row behind Load more. An open batch keeps moving:
       a row added before its end can push its last row behind Load more,
       where the next batch shows it.
     - A pinned batch whose read stopped before its `through`, with a
       `next` between its `after` and its `through`, such as a batch that
       grew past what one read holds (convex/model/labels.ts labelBatch),
       gives way to two batches that meet at that `next`, and shows its
       earlier answer until both answered. One that stopped without moving
       (`next` equal to its `after`, as equal positions give equal cursor
       text) checked nothing, so it shows its note in place, with Retry.
     - While a batch shows its earlier answer, for a Load more or for its
       halves, the other batches keep what they show as well and take their
       new answers with the batches that replace it, so the list shows the
       answers of one moment. A row that moved out of that batch never
       shows twice, and one that moved into it never goes missing.
     - A batch refused for its position, as after the server's secret
       rotated, starts the list again from its first batch, once for one
       key; a second refusal is the list's failure, and Retry starts it
       again. Any other failure shows in place of that batch with its last
       rows, and the list shows no end while it stands.
     - While the tab or the desktop window is hidden (lib/viewVisibility.ts)
       every batch's read stops and the answers stay. On return the same
       batches read again, and the list is `refreshing` until each has
       answered on the connection the socket holds now, as after a
       reconnect, when Convex sends every result again. Batches waiting to
       replace others, for a Load more or a split, wait the same way before
       they replace them, so no swap joins an answer from before the tab hid
       or the socket reconnected with one from after.

   Rows show in batch order, each id once, from the first batch that holds
   it. Load more adds a batch while the rows are fewer than `most` and, for
   a live list, the batches on screen fewer than `most` / LIST_BATCH, since
   splits add batches; past either the list is `full` and asks for a
   search. Growth inside loaded live batches is not trimmed. Whether more
   rows follow, and the end, come from the last batch, and a stopped batch
   is never an end (listEnd). */

import type { FunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { useEffect, useReducer, useRef } from 'react'
import { LIST_BATCH, type Limit } from '../../convex/lib/limits'
import { overLimit } from './fieldLimits'
import { watchLive } from './liveView'
import { useRested } from './useRested'
import { useViewVisibility } from './viewVisibility'

/** How long typing rests before a search goes to the server, as on
    Archived tasks. */
export const SEARCH_DELAY_MS = 250

/** One batch of a name-ordered list as the server answers it
    (convex/lib/namedPages.ts): its rows, a cursor at the position it
    reached or null at the list's end, and whether the read budget stopped
    it before it was full. */
export type ListBatch<Row> = { rows: readonly Row[]; next: string | null; stopped: boolean }

/** Where one batch reads: after `after` (null from the list's start) and,
    once its end is pinned, up to and including `through`. */
export type BatchAt = { after: string | null; through: string | null }

/** How a list reads its batches: once each on demand, or live while the
    page shows. A list keeps the kind it started with. */
export type BatchSource<A> =
  | {
      kind: 'once'
      /** the answer for one batch, or null for a read that failed */
      read: (at: BatchAt) => Promise<A | null>
    }
  | {
      kind: 'live'
      query: FunctionReference<'query'>
      /** the query's arguments for one batch, in a fixed key order with
          empty fields left out, so equal batches share one subscription */
      args: (at: BatchAt) => Record<string, Value>
    }

/** What a page asks of usePagedList. */
export type PagedListOptions<A, Row> = {
  /** the list's identity, such as its organization and settled search; a
      new key starts the list again, and null reads nothing */
  key: string | null
  source: BatchSource<A>
  /** the batch an answer holds, or null for an answer with no rows, such
      as not ready; a first batch's null is `held`, a later one a failure */
  batch: (answer: A) => ListBatch<Row> | null
  id: (row: Row) => string
  /** the most rows Load more gathers; past it the list asks for a search */
  most: number
}

/** One batch as the list shows it, with its rows (each id once across the
    list) and its note where it has one, which a page shows after its rows
    with Retry. A page shows a `stuck` note, for a read that stopped
    without checking anything, wherever the batch is, since listEnd answers
    `partial` with no line for a stuck last batch. It shows a `failed`
    note when the batch is not the last, as listEnd answers the last
    batch's failure as `failed`. */
export type PagedBatch<Row> = {
  id: number
  rows: readonly Row[]
  note: 'failed' | 'stuck' | null
  /** whether its Retry is on its way */
  retrying: boolean
}

/** What a paged list holds now. */
export type PagedList<A, Row> = {
  /** every batch's rows in batch order, each id once */
  rows: readonly Row[]
  /** the answers on screen, in batch order, for fields beside the rows */
  answers: readonly A[]
  /** for a list read once, the answer with no rows of the Load more that
      failed the list, so a page can say why; null otherwise */
  failure: A | null
  batches: readonly PagedBatch<Row>[]
  /** `first` until the first batch answers; `held` for a first answer with
      no rows; `failed` when the list's last read failed; `more` while Load
      more reads; else `ready` */
  phase: 'first' | 'ready' | 'more' | 'failed' | 'held'
  /** whether more rows follow the last batch, for Load more */
  next: boolean
  /** whether the last batch's read stopped before it was full */
  stopped: boolean
  /** whether the list holds as many rows or batches as it gathers */
  full: boolean
  /** whether a batch before the last failed or stopped, so the list
      claims no end */
  partial: boolean
  /** whether a live batch waits for the halves it splits into, so the
      list shows older answers and claims no end */
  settling: boolean
  /** whether a live list waits for fresh answers to what it shows, after
      the page showed again or the socket reconnected */
  refreshing: boolean
  /** Load more: one batch after the last, while `next` and not `full`,
      and none while one is on its way */
  more: () => void
  /** Reads again what failed: batch `id`, or with no id every failed
      batch, or the whole list from its start when it failed as a whole or
      its first batch did */
  retry: (id?: number) => void
}

/** Which line ends a list, one of:
    - `loading`, its first batch or a split's halves on their way;
    - `held`, a first answer with no rows;
    - `failed`, a failure of the list or of its last batch;
    - `full`, the cap reached with more to read;
    - `more`, Load more, with `stopped` beside it;
    - `partial`, no line, for a batch above the last that failed or
      stopped without moving, or a last batch that stopped without moving,
      each with its own note, so the end is unknown;
    - `none`, a search with no match;
    - `end`, the list's end. */
export type ListEnd = 'loading' | 'held' | 'failed' | 'full' | 'more' | 'partial' | 'none' | 'end'

/** The line that ends `list`, where `searching` says a search is active.
    It never answers `none` or `end` where a batch stopped or failed. */
export function listEnd(
  list: Pick<
    PagedList<unknown, unknown>,
    'phase' | 'next' | 'full' | 'stopped' | 'partial' | 'settling' | 'rows'
  >,
  searching: boolean,
): ListEnd {
  if (list.phase === 'first') return 'loading'
  if (list.phase === 'held') return 'held'
  if (list.phase === 'failed') return 'failed'
  if (list.settling) return 'loading'
  if (list.next) return list.full ? 'full' : 'more'
  if (list.partial || list.stopped) return 'partial'
  if (list.rows.length === 0 && searching) return 'none'
  return 'end'
}

/** A search box's text as a list asks the server with it: `typed`, the
    trimmed text; `tooLong`, whether it is past `limit`; and `settled`, the
    trimmed text once typing rests for SEARCH_DELAY_MS, at once when
    cleared, which stays at the last text within the limit while the box
    holds more. */
export function useSettledSearch(
  text: string,
  limit: Limit,
): { typed: string; tooLong: boolean; settled: string } {
  const typed = text.trim()
  const tooLong = overLimit(limit, typed)
  const last = useRef('')
  if (!tooLong) last.current = typed
  const settled = useRested(tooLong ? last.current : typed, SEARCH_DELAY_MS)
  return { typed, tooLong, settled }
}

/* ------------------------------------------------------------ the engines */

/** What both engines show, before the hook adds its two calls. */
type ListState<A, Row> = Omit<PagedList<A, Row>, 'more' | 'retry'>

/** One engine under usePagedList: `open` starts it for a key (again after
    `stop`), `show` follows the page's visibility, and `stop` drops every
    read and answer, as leaving the page does. */
type Engine<A, Row> = {
  open(key: string | null): void
  show(visible: boolean): void
  stop(): void
  view(): ListState<A, Row>
  more(): void
  retry(id?: number): void
}

/** A list that reads nothing. */
const empty = <A, Row>(): ListState<A, Row> => ({
  rows: [],
  answers: [],
  failure: null,
  batches: [],
  phase: 'first',
  next: false,
  stopped: false,
  full: false,
  partial: false,
  settling: false,
  refreshing: false,
})

/** Rows `rows` with each id once, the first kept, skipping ids in `seen`,
    which it adds to. */
function unique<Row>(rows: readonly Row[], id: (row: Row) => string, seen: Set<string>): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const key = id(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/** The `once` engine: batches read on demand, one read at a time. */
function onceEngine<A, Row>(
  options: () => PagedListOptions<A, Row>,
  changed: () => void,
): Engine<A, Row> {
  type Read = { answer: A; batch: ListBatch<Row> }
  let key: string | null = null
  // every read carries the sequence it started under; a new key, a fresh
  // start and leaving the page move it on, so an older answer is dropped
  let sequence = 0
  let reads: Read[] = []
  // a first answer with no rows, which `answers` shows
  let held: A | null = null
  // a later answer with no rows, which failed the list (`failure`)
  let failure: A | null = null
  let phase: PagedList<A, Row>['phase'] = 'first'
  // a read on its way, so a second press or a Retry reads nothing
  let reading = false

  const last = () => reads[reads.length - 1]
  const place = () => last()?.batch.next ?? null

  /** Reads the batch after `after`, the first when null. */
  function read(after: string | null) {
    const o = options()
    if (o.source.kind !== 'once') return
    const n = sequence
    reading = true
    void o.source.read({ after, through: null }).then(
      (answer) => land(n, after, answer),
      () => land(n, after, null),
    )
  }

  function land(n: number, after: string | null, answer: A | null) {
    if (n !== sequence) return
    reading = false
    const batch = answer === null ? null : options().batch(answer)
    failure = null
    if (answer === null || batch === null) {
      // a first answer with no rows is held; a later one is a failure that
      // keeps the rows and the place, and the answer for `failure`
      phase = answer !== null && after === null ? 'held' : 'failed'
      if (phase === 'held') held = answer
      else failure = answer
    } else {
      reads = [...reads, { answer, batch }]
      phase = 'ready'
    }
    changed()
  }

  function start() {
    sequence++
    reads = []
    held = null
    failure = null
    phase = 'first'
    reading = false
    if (key !== null) read(null)
    changed()
  }

  function more() {
    const at = place()
    if (key === null || at === null || reading) return
    if (phase !== 'ready' && phase !== 'failed') return
    phase = 'more'
    read(at)
    changed()
  }

  return {
    open(next) {
      key = next
      start()
    },
    show() {},
    stop() {
      sequence++
      reads = []
      held = null
      failure = null
      reading = false
    },
    view() {
      const o = options()
      const seen = new Set<string>()
      const batches = reads.map((r, i) => ({
        id: i,
        rows: unique(r.batch.rows, o.id, seen),
        note: null,
        retrying: false,
      }))
      const rows = batches.flatMap((b) => b.rows)
      const end = last()?.batch
      return {
        rows,
        answers: held !== null && phase === 'held' ? [held] : reads.map((r) => r.answer),
        failure: phase === 'failed' ? failure : null,
        batches,
        phase,
        next: (end?.next ?? null) !== null,
        stopped: end?.stopped ?? false,
        full: rows.length >= o.most,
        partial: false,
        settling: false,
        refreshing: false,
      }
    },
    more,
    retry() {
      if (key === null || reading) return
      // a failed first batch, or one with no rows, starts again; a failed
      // Load more reads its place again
      if (phase === 'held' || (phase === 'failed' && reads.length === 0)) start()
      else if (phase === 'failed') more()
    },
  }
}

/** The refusal code of a query's error (convex/lib/functions.ts Refusal). */
const codeOf = (error: unknown): string | undefined =>
  error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined

/** The `live` engine: batches kept live with pinned ends, on the rules in
    the module header. */
function liveEngine<A, Row>(
  options: () => PagedListOptions<A, Row>,
  changed: () => void,
): Engine<A, Row> {
  /* What a batch shows: an answer with rows, a first answer with none, or
     the rows it showed before beside an answer whose read stopped without
     moving or beside a failure. */
  type Shown =
    | { kind: 'ok'; answer: A; batch: ListBatch<Row> }
    | { kind: 'held'; answer: A }
    | { kind: 'stuck'; answer: A; rows: readonly Row[] }
    | { kind: 'error'; error: unknown; rows: readonly Row[] }
  type Batch = {
    id: number
    after: string | null
    through: string | null
    /** the way to stop its read, null while it reads nothing */
    stop: (() => void) | null
    /** the latest result of its read, and the connection it came on */
    held: { value?: A; error?: unknown; connection: number | null } | null
    /** whether `held` came from the read open now */
    fresh: boolean
    shown: Shown | null
    /** the rows a failure shows before the batch answered once. A Load
        more's pinned batch keeps the rows of the open batch it replaces,
        and a split's first half those of the batch it splits. */
    kept: readonly Row[]
    retrying: boolean
  }
  /* Batches that replace `from` once each of `to` answered: Load more's
     pinned and open batch, or a split's halves. */
  type Swap = { from: Batch[]; to: Batch[]; why: 'more' | 'split' }

  let key: string | null = null
  let visible = true
  let shown: Batch[] = []
  let swaps: Swap[] = []
  // the key a position refusal started the list again for, and whether a
  // second one made the list fail
  let restarted: string | null = null
  let failed = false
  let nextId = 0
  // the newest connection count a transition brought
  let connection = 0
  let settling = false

  /** Whether batch `b`'s answer is current, which is to say it came from
      the read open now, on the connection the socket holds now. */
  const current = (b: Batch) =>
    b.fresh && (b.held?.connection === null || b.held?.connection === connection)

  const argsOf = (b: Batch): Record<string, Value> | null => {
    const o = options()
    return o.source.kind === 'live' ? o.source.args({ after: b.after, through: b.through }) : null
  }

  /** Opens batch `b`'s read while the page shows, replacing any before. */
  function watch(b: Batch) {
    b.stop?.()
    b.stop = null
    b.fresh = false
    const o = options()
    const args = argsOf(b)
    if (!visible || key === null || o.source.kind !== 'live' || args === null) return
    b.stop = watchLive<A>(
      o.source.query,
      args,
      (result, at) => {
        b.held =
          'value' in result
            ? { value: result.value, connection: at }
            : { error: result.error, connection: at }
        b.fresh = true
        b.retrying = false
        if (at !== null && at > connection) connection = at
        later()
      },
      (at) => {
        if (at <= connection) return
        connection = at
        changed()
      },
    )
  }

  function unwatch(b: Batch) {
    b.stop?.()
    b.stop = null
  }

  function newBatch(
    after: string | null,
    through: string | null,
    kept: readonly Row[] = [],
  ): Batch {
    const b: Batch = {
      id: ++nextId,
      after,
      through,
      stop: null,
      held: null,
      fresh: false,
      shown: null,
      kept,
      retrying: false,
    }
    watch(b)
    return b
  }

  const every = () => [...shown, ...swaps.flatMap((s) => s.to)]

  function stopAll() {
    for (const b of every()) unwatch(b)
    shown = []
    swaps = []
  }

  /** Starts the list again from its first batch. */
  function restart() {
    stopAll()
    failed = false
    if (key !== null) shown = [newBatch(null, null)]
  }

  /* Settles once the transition that brought a result is over, so every
     batch it answered is in (store/planner.ts settleOverview). */
  function later() {
    if (settling) return
    settling = true
    queueMicrotask(() => {
      settling = false
      settle()
    })
  }

  /** Where pinned batch `b` gives way to two halves after `batch`, or null
      where it gives way to nothing: an open batch, a read that did not
      stop, or one that stopped at its own `after`, its own `through` or
      the list's end. */
  const splitAt = (b: Batch, batch: ListBatch<Row>): string | null =>
    b.through === null ||
    !batch.stopped ||
    batch.next === null ||
    batch.next === b.through ||
    batch.next === b.after
      ? null
      : batch.next

  /** What batch `b` shows for its latest result, or null where it gives
      way to two halves (splitAt). */
  function settledOf(b: Batch): Shown | null | undefined {
    const held = b.held
    if (held === null) return undefined
    // the rows it showed, which a failure or a stop without moving keeps
    const rows = rowsOf(b)
    if ('error' in held && held.error !== undefined)
      return { kind: 'error', error: held.error, rows }
    const answer = held.value as A
    const batch = options().batch(answer)
    if (batch === null)
      return b.after === null
        ? { kind: 'held', answer }
        : { kind: 'error', error: new Error('a later batch answered no rows'), rows }
    if (splitAt(b, batch) !== null) return null
    // a pinned batch that stopped at its own end read every row in it
    if (b.through !== null && batch.stopped && batch.next === b.through)
      return { kind: 'ok', answer, batch: { ...batch, stopped: false } }
    if (batch.stopped && batch.next !== null && batch.next === b.after)
      return { kind: 'stuck', answer, rows: [...rows, ...batch.rows] }
    return { kind: 'ok', answer, batch }
  }

  /** Whether batch `b`'s latest result refuses its position. */
  const refusedPosition = (b: Batch) =>
    b.held?.error !== undefined &&
    codeOf(b.held.error) === 'bad_request' &&
    (b.after !== null || b.through !== null)

  /** The two batches that replace pinned batch `b`, meeting at `at`. */
  const halves = (b: Batch, at: string) => [
    newBatch(b.after, at, rowsOf(b)),
    newBatch(at, b.through),
  ]

  /** The rows batch `b` shows, or keeps for a failure before it answered. */
  function rowsOf(b: Batch): readonly Row[] {
    const s = b.shown
    if (s?.kind === 'ok') return s.batch.rows
    if (s?.kind === 'stuck' || s?.kind === 'error') return s.rows
    return b.kept
  }

  /** Answers a position refusal. The list starts again once for its key,
      then fails. */
  function refused() {
    if (restarted === key) {
      stopAll()
      failed = true
    } else {
      restarted = key
      restart()
    }
    changed()
  }

  /** Takes every batch's latest result in, as the module header says. */
  function settle() {
    if (failed || key === null) return
    // batches waiting to replace others take each result as it comes, as
    // nothing shows them yet; one that splits gives way to its halves
    for (const s of swaps)
      for (let i = 0; i < s.to.length; i++) {
        const b = s.to[i] as Batch
        if (refusedPosition(b)) return refused()
        const settled = settledOf(b)
        if (settled === undefined) continue
        if (settled !== null) b.shown = settled
        else {
          unwatch(b)
          const at = splitAt(b, options().batch(b.held?.value as A) as ListBatch<Row>) as string
          s.to.splice(i, 1, ...halves(b, at))
          i--
        }
      }
    // the batches on screen read their results, and start or end their
    // splits, before any swap replaces what it stood for
    const fresh: [Batch, Shown][] = []
    for (const b of shown) {
      if (refusedPosition(b)) return refused()
      const swap = swaps.find((s) => s.from.includes(b))
      // Load more shows the open batch's answer from the press
      if (swap?.why === 'more') continue
      const settled = settledOf(b)
      if (settled === undefined) continue
      if (settled === null) {
        if (swap?.why !== 'split') {
          const at = splitAt(b, options().batch(b.held?.value as A) as ListBatch<Row>) as string
          swaps.push({ from: [b], to: halves(b, at), why: 'split' })
        }
        continue
      }
      fresh.push([b, settled])
      // a result that fits again ends the split it started
      if (swap?.why === 'split') cancel(swap)
    }
    // swaps whose batches all hold a current answer replace what they stood
    // for, all at once, so no row shows twice or goes missing between
    // batches. A batch that answered before the page hid or the socket
    // reconnected waits for an answer from its read open now, so no swap
    // joins an answer from before with one from after.
    const waiting = swaps.some((s) => !s.to.every((b) => b.shown !== null && current(b)))
    if (!waiting) {
      for (const s of swaps) {
        const at = shown.indexOf(s.from[0] as Batch)
        if (at >= 0) {
          shown.splice(at, s.from.length, ...s.to)
          for (const b of s.from) unwatch(b)
        } else for (const b of s.to) unwatch(b)
      }
      swaps = []
    }
    // and the batches on screen take their results with them
    if (swaps.length === 0) for (const [b, settled] of fresh) b.shown = settled
    changed()
  }

  /** Gives up swap `s`, stopping the batches that were to replace. */
  function cancel(s: Swap) {
    for (const b of s.to) unwatch(b)
    swaps = swaps.filter((x) => x !== s)
  }

  /** The batches on screen as the page shows them. */
  function batchesView(): PagedBatch<Row>[] {
    const o = options()
    const seen = new Set<string>()
    return shown.map((b) => {
      const s = b.shown
      const rows =
        s?.kind === 'ok' ? s.batch.rows : s?.kind === 'stuck' || s?.kind === 'error' ? s.rows : []
      return {
        id: b.id,
        rows: unique(rows, o.id, seen),
        note: s?.kind === 'error' ? 'failed' : s?.kind === 'stuck' ? 'stuck' : null,
        retrying: b.retrying,
      }
    })
  }

  /** What the list shows now. */
  function view(): ListState<A, Row> {
    if (key === null) return empty()
    const o = options()
    const batches = batchesView()
    const rows = batches.flatMap((b) => b.rows)
    const answers = shown.flatMap((b) =>
      b.shown && b.shown.kind !== 'error' ? [b.shown.answer] : [],
    )
    const first = shown[0]
    const last = shown[shown.length - 1]
    const lastShown = last?.shown
    const open = last !== undefined && last.through === null
    const pressed = !!last && swaps.some((s) => s.why === 'more' && s.from.includes(last))
    const nextAt = lastShown?.kind === 'ok' ? lastShown.batch.next : null
    const phase: PagedList<A, Row>['phase'] = failed
      ? 'failed'
      : !first || first.shown === null
        ? 'first'
        : first.shown.kind === 'held'
          ? 'held'
          : lastShown?.kind === 'error'
            ? 'failed'
            : pressed
              ? 'more'
              : 'ready'
    return {
      rows,
      answers,
      failure: null,
      batches,
      phase,
      next: open && nextAt !== null && nextAt !== last.after,
      // a last batch that stopped, or one that could not move, ends nothing
      stopped: lastShown?.kind === 'stuck' || (lastShown?.kind === 'ok' && lastShown.batch.stopped),
      full: rows.length >= o.most || shown.length >= Math.ceil(o.most / LIST_BATCH),
      partial: batches.slice(0, -1).some((b) => b.note !== null),
      settling: swaps.some((s) => s.why === 'split'),
      refreshing: visible && shown.some((b) => b.shown !== null && !current(b)),
    }
  }

  return {
    open(next) {
      key = next
      restarted = null
      restart()
      changed()
    },
    show(next) {
      if (next === visible) return
      visible = next
      // while hidden every read stops and the answers stay, and once shown
      // the same batches read again
      for (const b of every()) {
        if (visible) watch(b)
        else unwatch(b)
      }
      changed()
    },
    stop() {
      stopAll()
      failed = false
    },
    view,
    more() {
      const last = shown[shown.length - 1]
      const now = view()
      if (!last || last.through !== null || last.shown?.kind !== 'ok') return
      if (!now.next || now.full || swaps.some((s) => s.from.includes(last))) return
      const at = last.shown.batch.next as string
      swaps.push({
        from: [last],
        to: [newBatch(last.after, at, rowsOf(last)), newBatch(at, null)],
        why: 'more',
      })
      settle()
    },
    retry(id) {
      if (key === null) return
      const first = shown[0]
      // the whole list, or its first batch, starts again from the start
      if (
        failed ||
        !first ||
        first.shown?.kind === 'held' ||
        (shown.length === 1 && first.shown?.kind === 'error')
      ) {
        restarted = null
        restart()
        changed()
        return
      }
      for (const b of every()) {
        if (id !== undefined && b.id !== id) continue
        if (b.retrying || (b.shown?.kind !== 'error' && b.shown?.kind !== 'stuck')) continue
        b.retrying = true
        b.held = null
        watch(b)
      }
      changed()
    },
  }
}

/**
 * A list read a batch at a time from `source`, on the rules in the module
 * header, for the list `key` names. The page renders `rows` or `batches`
 * and the line listEnd answers, and calls `more` and `retry`. Its answers
 * live in the hook and go when the page unmounts or the key changes, so a
 * later visit reads again.
 */
export function usePagedList<A, Row>(o: PagedListOptions<A, Row>): PagedList<A, Row> {
  const { visible } = useViewVisibility()
  const [, changed] = useReducer((n: number) => n + 1, 0)
  const latest = useRef(o)
  latest.current = o
  const engine = useRef<Engine<A, Row> | null>(null)
  if (engine.current === null)
    engine.current = (o.source.kind === 'once' ? onceEngine : liveEngine)(
      () => latest.current,
      changed,
    )
  const e = engine.current
  // the key the engine opened, so a page that shows again or a parent's
  // render opens nothing new
  const opened = useRef<{ key: string | null } | null>(null)
  useEffect(() => {
    e.show(visible)
    if (opened.current === null || opened.current.key !== o.key) {
      opened.current = { key: o.key }
      e.open(o.key)
    }
  }, [o.key, visible])
  useEffect(
    () => () => {
      opened.current = null
      e.stop()
    },
    [],
  )
  return { ...e.view(), more: () => e.more(), retry: (id) => e.retry(id) }
}
