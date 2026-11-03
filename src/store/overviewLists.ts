/* The Overview's reads (views/Overview.tsx): its summary, its projected
   delays, its two lists in batches and its health table, over the store's
   view reads (store/planner.ts watchView), which this module asks for
   through the transport it is given, as store/ownerLoadCache.ts takes one.
   It holds no React and reads nothing of the store's own.

   - The page asks for one scope and clock at a time (`watch`), or for
     nothing while its page or the tab is hidden: every read stops, keeps
     what it held and reads again with the same arguments when the page
     asks for them again. Arguments are built here in one fixed key order,
     so equal arguments share one subscription.
   - The summary and the delays are one read each. A list is a run of
     batches, each one read of overview.attention or overview.paused under
     a view slot of its own (`overview:<list>:<id>`), whose rows the store
     keeps for the page to show (store/viewRows.ts).
   - Only the last batch is open (no `end`). Load more freezes it: the
     batch is read again between its cursor and the end it answered, and
     the next one opens at its `next`. The frozen read and the new open one
     replace the open batch together, once both answered, and until then
     the page shows the open batch's answer from the press
     (convex/lib/overview.ts listBatch).
   - A frozen batch that grew past OVERVIEW.split rows answers `split`, and
     one whose reads stopped answers `complete: false` with the last
     position it judged: each gives way to two batches that meet there, and
     shows its earlier answer until both answered. A Load more's frozen
     read that splits waits for its halves the same way. Reads that stopped
     at the batch's own end judged every row in it, so it gives way to
     nothing. Two frozen batches next to each other whose rows fit
     OVERVIEW.split become one read.
   - While a batch shows its earlier answer, for a Load more or for its
     halves, the list's other batches keep what they show as well and take
     their new answers with the batches that replace it, so the list shows
     the answers of one moment. A row that moved out of that batch never
     shows twice, and one that moved into it never goes missing. A batch
     whose answer splits in the same change that answers a Load more's or
     a split's last batch holds them as well.
   - A list keeps at most LIST_ROWS rows and LIST_READS reads, split halves
     and merges included. Past either, a merge still on its way gives way
     first. Next, where a batch on screen waits for its halves, a Load more
     on its way gives way, as the list would hold the reads of both until
     they all answered: the rows on screen stay, and the list offers Load
     more again. Then the list drops its first batches until both fit and
     says that earlier tasks are not shown, with a way back to the start,
     so every task stays reachable by going on. Where only the open batch
     is left and a Load more's frozen read keeps splitting past the reads,
     the Load more gives way: the open batch takes its current answer and
     offers Load more again.
   - A batch refused for its position, as after the server's secret
     rotated, starts its list again from the first batch, once for one
     list key; a second refusal is the list's error. A new day restarts
     the At-risk list, whose positions follow the day, and keeps Paused.
   - Any other failure, `unavailable` or `over_budget` shows in place of
     that batch, with Try again, and the list shows no end while it stands.
   - The health table is one read (overview.health) of its first rows in
     the order and with the search the page asks (`watchTable`), apart
     from the scope's reads, so a new sort, search or Load more asks the
     health read alone. It asks only while the page asks and has a table,
     OVERVIEW_BATCH rows at first and as many more for each Load more. A new
     sort or search, or a new scope, starts again at the first rows. While
     an answer for new table arguments is on its way, the last answer shown
     for the same scope and clock stays as `kept`, as the store's view read
     drops what it held for other arguments; a new scope or clock shows
     nothing until its own answer. A Load more that fails goes back to the
     rows it showed, asking their arguments again so they keep updating,
     and offers Retry. */

import { ConvexError, type Value } from 'convex/values'
import type {
  HealthAnswer,
  HealthSort,
  ListAnswer,
  OverviewRow,
  OverviewScope,
  RiskAnswer,
  SummaryAnswer,
} from '../../convex/lib/overview'

/** The rows one batch holds, the page's Load more step
    (convex/lib/overview.ts OVERVIEW.batch, pinned by
    store/overviewParity.test.ts). */
export const OVERVIEW_BATCH = 10
/** The rows a batch read again with its fixed end may hold before it
    answers a position to split at (OVERVIEW.split). */
export const OVERVIEW_SPLIT = 20
/** How many local weeks the clock sends: this one and the 52 before
    (convex/lib/overview.ts WEEK_STARTS). */
export const OVERVIEW_WEEKS = 53
/** The rows one list keeps on screen at most. Past it, Load more drops the
    list's first batches. */
export const LIST_ROWS = 50
/** The reads one list holds at most, split halves and merges included: with
    the summary, the delays and the health table an Overview holds at most
    3 + 2 * LIST_READS reads. */
export const LIST_READS = 5

/** The Overview's two lists. */
export type ListKind = 'attention' | 'paused'
/** The Overview's five queries (convex/overview.ts). */
export type OverviewQuery = 'summary' | 'risk' | ListKind | 'health'

/** The health table the page asks for: the column it sorts by, the
    direction and the search, trimmed, '' for none. */
export type HealthTable = { sort: HealthSort; dir: 'asc' | 'desc'; search: string }

/** One health read's table, with how many rows it asks for. */
export type HealthAsk = HealthTable & { limit: number }

/** The client's day and weeks the queries are judged by
    (convex/lib/overview.ts clockOf). */
export type OverviewClock = {
  day: string
  week: string
  week_starts: number[]
  week_end: number
}

/** One Overview the page asks for: its scope and its clock. */
export type OverviewBase = { scope: OverviewScope; clock: OverviewClock }

/* The scope in its fixed key order. */
const scopeArgs = (scope: OverviewScope): Record<string, Value> =>
  scope.kind === 'mine'
    ? { kind: 'mine' }
    : { kind: 'project', org_id: scope.org_id, project_id: scope.project_id }

/* The clock in its fixed key order. */
const clockArgs = (c: OverviewClock): Record<string, Value> => ({
  day: c.day,
  week: c.week,
  week_starts: [...c.week_starts],
  week_end: c.week_end,
})

/**
 * The arguments of `query` for `base`, in a fixed key order: the summary
 * takes the day, the delays and the At-risk list every clock field, the
 * Paused list none, and a list batch its `cursor` and `end` where set; the
 * health table every clock field and `table`'s column, direction, search
 * (left out when blank) and limit.
 */
export function overviewArgs(
  query: OverviewQuery,
  base: OverviewBase,
  cursor: string | null = null,
  end: string | null = null,
  table: HealthAsk | null = null,
): Record<string, Value> {
  const scope = scopeArgs(base.scope)
  const at = {
    ...(cursor === null ? {} : { cursor }),
    ...(end === null ? {} : { end }),
  }
  switch (query) {
    case 'summary':
      return { scope, day: base.clock.day }
    case 'risk':
      return { scope, ...clockArgs(base.clock) }
    case 'attention':
      return { scope, ...clockArgs(base.clock), ...at }
    case 'paused':
      return { scope, ...at }
    case 'health': {
      const t = table ?? { sort: 'late', dir: 'desc', search: '', limit: OVERVIEW_BATCH }
      return {
        scope,
        ...clockArgs(base.clock),
        sort: t.sort,
        dir: t.dir,
        ...(t.search === '' ? {} : { search: t.search }),
        limit: t.limit,
      }
    }
  }
}

/** The key of one Overview, which the page registers with the store
    (P.watchOverview): its scope and its clock, JSON in a fixed order. */
export const overviewKey = (base: OverviewBase): string =>
  JSON.stringify({ scope: scopeArgs(base.scope), ...clockArgs(base.clock) })

/** The Overview `key` names (overviewKey). */
export function baseOfKey(key: string): OverviewBase {
  const { scope, ...clock } = JSON.parse(key) as { scope: OverviewScope } & OverviewClock
  return { scope, clock }
}

/** The key of a list's positions (convex/lib/overview.ts listKey): its
    scope, and for At risk the clock, so a new day restarts it and keeps
    Paused. */
const listKeyOf = (kind: ListKind, base: OverviewBase) => JSON.stringify(overviewArgs(kind, base))

/** What one read holds, as the store's view reads answer it
    (store/planner.ts viewRead). */
export type HeldRead = {
  /** the arguments' key its result answers, null for none */
  key: string | null
  value?: unknown
  error?: unknown
  /** whether it is the live subscription's on the current connection */
  current: boolean
}

/** What the module asks of the store. */
export type OverviewTransport = {
  /** Registers read `slot` of `query` for the arguments `key` (JSON), or
      stops it with null, keeping what it held; a new `attempt` asks
      afresh. */
  watch(slot: string, query: OverviewQuery, key: string | null, attempt: number): void
  /** What read `slot` holds. */
  read(slot: string): HeldRead
  /** Forgets read `slot`, its result and its rows. */
  release(slot: string): void
}

/** A figure read as the page reads it: its answer for the arguments asked
    now, whether that answer is current, or nothing yet. */
export type FigureView<T> = {
  value?: T
  error?: unknown
  /** whether an answer for these arguments arrived on the live
      subscription on this connection; false for one kept while the read
      stopped or before it arrived again after a reconnect */
  current: boolean
} | null

/** What one batch shows in place: its rows, and its note where it has one. */
export type BatchView = {
  id: number
  /** the view slot whose rows hold the models of its tasks */
  slot: string
  rows: readonly OverviewRow[]
  /** what it says after its rows: its reads stopped before the batch ended
      (`incomplete`), or it failed (`over_budget`, `unavailable` with the
      answer's sentence, `error`), with Try again */
  note:
    | null
    | { kind: 'incomplete' }
    | { kind: 'over_budget' }
    | { kind: 'unavailable'; message?: string }
    | { kind: 'error' }
  /** whether its answer is on its way (Try again pressed) */
  waiting: boolean
}

/** What one list shows. */
export type ListView = {
  state: 'loading' | 'refreshing' | 'ok' | 'incomplete' | 'over_budget' | 'error'
  /** the batches on screen, in order */
  batches: readonly BatchView[]
  /** whether earlier batches were dropped (LIST_ROWS, LIST_READS) */
  dropped: boolean
  /** whether the list reached its true end */
  end: boolean
  /** Load more: `ready` to press, `loading` while its batches load, none */
  more: 'ready' | 'loading' | null
  /** whether the list failed as a whole (a second position refusal) */
  failed: boolean
  /** the reads it holds now */
  reads: number
}

/** What the health table shows: its answer, or nothing (null) before the
    first one for the scope and clock asked now. */
export type HealthView = {
  /** the answer shown: the one for the table asked now, or while an answer
      for new table arguments is on its way, the last one shown for this
      scope and clock (`kept`) */
  value?: HealthAnswer
  /** the error of the first answer for the table asked now */
  error?: unknown
  /** whether the answer shown is the live subscription's for the table
      asked now, arrived on this connection */
  current: boolean
  /** whether the answer shown answers other table arguments than those
      asked now: a sort, a search or a Load more on its way */
  kept: boolean
  /** Load more: `ready` to press, `loading` while its rows load, none */
  more: 'ready' | 'loading' | null
  /** whether a Load more failed, so the rows are the ones before it and
      Retry asks it again */
  moreFailed: boolean
} | null

/** What the Overview's reads hold for the page. */
export type OverviewView = {
  /** the Overview the reads are for, null for none */
  key: string | null
  summary: FigureView<SummaryAnswer>
  risk: FigureView<RiskAnswer>
  attention: ListView
  paused: ListView
  health: HealthView
}

type OkList = Extract<ListAnswer, { state: 'ok' }>

/* What a batch shows: its last answer that needs no successor, or its
   failure. */
type Shown =
  | { kind: 'ok'; answer: OkList }
  | { kind: 'refused'; value: Exclude<ListAnswer, { state: 'ok' }> }
  | { kind: 'error'; error: unknown }

type Batch = {
  id: number
  slot: string
  cursor: string | null
  /** its fixed end, null for the open batch */
  end: string | null
  attempt: number
  shown: Shown | null
  /** a merge with it failed, so it is not merged again */
  alone?: boolean
}

/* Batches that replace `from`, contiguous on screen, once each of `to`
   answered: Load more's frozen and open batch, a split's halves, a merge. */
type Swap = { from: Batch[]; to: Batch[]; why: 'more' | 'split' | 'merge' }

type List = {
  kind: ListKind
  /** the key the list's positions are bound to, null before any */
  key: string | null
  shown: Batch[]
  swaps: Swap[]
  dropped: boolean
  /** the list key a position refusal restarted the list for */
  restarted: string | null
  failed: boolean
}

/**
 * Where fixed batch (`cursor`, `end`] gives way to two halves after its ok
 * answer `v`: the position it split at, or the last one it judged where its
 * reads stopped. Null where it gives way to nothing: an open batch (no
 * `end`), an answer that fits, or reads that stopped at the batch's own end
 * or cursor, where one half would ask again with the batch's own arguments
 * and get the same answer. The store keeps a batch's rows exactly while it
 * gives way (store/planner.ts listQuery).
 */
export function splitAt(cursor: string | null, end: string | null, v: OkList): string | null {
  if (end === null) return null
  if (v.split !== undefined) return v.split
  if (v.complete || v.next === null || v.next === end || v.next === cursor) return null
  return v.next
}

/** The refusal code of a query's error (convex/lib/functions.ts Refusal). */
const codeOf = (error: unknown): string | undefined =>
  error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined

const SUMMARY_SLOT = 'overview:summary'
const RISK_SLOT = 'overview:risk'
const HEALTH_SLOT = 'overview:health'

/* Whether two health tables ask the same. */
const sameTable = (a: HealthTable | null, b: HealthTable | null) =>
  a !== null && b !== null && a.sort === b.sort && a.dir === b.dir && a.search === b.search

/** Creates the Overview's reads over `transport`. */
export function createOverviewReads(transport: OverviewTransport) {
  let base: OverviewBase | null = null
  let baseKey: string | null = null
  // whether the reads are live: the page shows and asked
  let asking = false
  let owner = 0
  let attempt = 0
  let nextId = 0
  let settling = false
  let again = false
  const lists: Record<ListKind, List> = {
    attention: emptyList('attention'),
    paused: emptyList('paused'),
  }
  // the health table the page asks for (null for none), how many rows it
  // asks for and its Try again count
  let table: HealthTable | null = null
  let limit = OVERVIEW_BATCH
  let healthTries = 0
  // the last answer the table showed, with the Overview and the table
  // arguments it answered
  let shownHealth: { base: string; ask: HealthAsk; value: HealthAnswer } | null = null
  // a Load more that failed: the limit it asked for, which Retry asks again
  let failedMore: number | null = null

  function emptyList(kind: ListKind): List {
    return { kind, key: null, shown: [], swaps: [], dropped: false, restarted: null, failed: false }
  }

  const batchKey = (list: List, b: Batch) =>
    base === null ? null : JSON.stringify(overviewArgs(list.kind, base, b.cursor, b.end))

  /** Registers batch `b`'s read as the reads stand: live while asking. */
  const watchBatch = (list: List, b: Batch) =>
    transport.watch(b.slot, list.kind, asking ? batchKey(list, b) : null, b.attempt)

  function newBatch(list: List, cursor: string | null, end: string | null): Batch {
    const id = ++nextId
    const b: Batch = {
      id,
      slot: `overview:${list.kind}:${id}`,
      cursor,
      end,
      attempt: 0,
      shown: null,
    }
    watchBatch(list, b)
    return b
  }

  /** The reads list `list` holds. */
  const readsOf = (list: List) =>
    list.shown.length + list.swaps.reduce((n, s) => n + s.to.length, 0)

  /** The rows list `list` shows. */
  const rowsOf = (list: List) =>
    list.shown.reduce((n, b) => n + (b.shown?.kind === 'ok' ? b.shown.answer.rows.length : 0), 0)

  /** Starts list `list` again from its first batch, releasing every read. */
  function restart(list: List) {
    for (const b of list.shown) transport.release(b.slot)
    for (const s of list.swaps) for (const b of s.to) transport.release(b.slot)
    list.shown = []
    list.swaps = []
    list.dropped = false
    list.failed = false
    list.shown = [newBatch(list, null, null)]
  }

  /** Drops batch `b`, the first on screen, and the swaps it is part of.
      Where that was a split the other batches waited for, they take their
      answers in the next pass. */
  function drop(list: List, b: Batch) {
    for (const s of list.swaps.filter((s) => s.from.includes(b))) {
      if (s.why === 'split') again = true
      cancel(list, s)
    }
    transport.release(b.slot)
    list.shown = list.shown.filter((x) => x !== b)
    list.dropped = true
  }

  /** Gives up swap `s`, releasing the batches that were to replace. */
  function cancel(list: List, s: Swap) {
    for (const b of s.to) transport.release(b.slot)
    list.swaps = list.swaps.filter((x) => x !== s)
  }

  /** Batch `b`'s answer for the arguments it asks with, or undefined. */
  function answerOf(list: List, b: Batch): { value?: ListAnswer; error?: unknown } | undefined {
    const held = transport.read(b.slot)
    if (held.key === null || held.key !== batchKey(list, b)) return undefined
    if (held.error !== undefined) return { error: held.error }
    if (held.value === undefined) return undefined
    return { value: held.value as ListAnswer }
  }

  /** Whether batch `b`'s answer `a` refuses its position. */
  const refusedPosition = (b: Batch, a: { error?: unknown }) =>
    a.error !== undefined &&
    codeOf(a.error) === 'bad_request' &&
    (b.cursor !== null || b.end !== null)

  /** What `a` shows, or null where batch `b` gives way to two halves: a
      fixed batch that split, or whose reads stopped before its end
      (splitAt). A fixed batch whose reads stopped at its end shows its
      rows as the whole batch; one whose reads stopped at its cursor judged
      nothing, which the server answers over_budget. */
  function settledOf(b: Batch, a: { value?: ListAnswer; error?: unknown }): Shown | null {
    if (a.error !== undefined) return { kind: 'error', error: a.error }
    const v = a.value as ListAnswer
    if (v.state !== 'ok') return { kind: 'refused', value: v }
    if (splitAt(b.cursor, b.end, v) !== null) return null
    if (b.end !== null && !v.complete)
      return v.next === b.end
        ? { kind: 'ok', answer: { ...v, complete: true } }
        : { kind: 'refused', value: { state: 'over_budget' } }
    return { kind: 'ok', answer: v }
  }

  /** The two batches that replace fixed batch `b`, whose answer `v` split
      or stopped, meeting where it split or the last position it judged. */
  function halves(list: List, b: Batch, v: OkList): Batch[] {
    const at = splitAt(b.cursor, b.end, v) as string
    return [newBatch(list, b.cursor, at), newBatch(list, at, b.end)]
  }

  /** A position refusal: the list starts again once for its key, then
      fails. Answers false to stop settling the list. */
  function refused(list: List): false {
    if (list.restarted === list.key) {
      for (const b of list.shown) transport.release(b.slot)
      for (const s of list.swaps) for (const b of s.to) transport.release(b.slot)
      list.shown = []
      list.swaps = []
      list.failed = true
      return false
    }
    list.restarted = list.key
    restart(list)
    return false
  }

  /** Takes list `list`'s answers in, as the module header describes.
      Answers false where a refusal restarted it. */
  function settleList(list: List): boolean {
    if (list.failed) return true
    // batches waiting to replace others take each answer as it comes, as
    // nothing shows them yet, so they replace with their current one. One
    // that split or stopped gives way to its halves at once; a merged read
    // that would, as a guest's stops at its second owner, gives the merge
    // up (cancel puts a new array in list.swaps, so this walks the one it
    // was)
    for (const s of list.swaps)
      for (let i = 0; i < s.to.length; i++) {
        const b = s.to[i] as Batch
        const a = answerOf(list, b)
        if (a === undefined) continue
        if (refusedPosition(b, a)) return refused(list)
        const settled = settledOf(b, a)
        if (settled !== null) b.shown = settled
        else if (s.why === 'merge') {
          for (const x of s.from) x.alone = true
          cancel(list, s)
          break
        } else {
          transport.release(b.slot)
          s.to.splice(i, 1, ...halves(list, b, a.value as OkList))
          i--
        }
      }
    // the batches on screen read their current answers, and start or end
    // their splits, before any swap replaces what it stood for, so a split
    // that starts with this change also holds a Load more or a split whose
    // last batch answered in it
    const fresh: [Batch, Shown][] = []
    for (const b of list.shown) {
      const a = answerOf(list, b)
      if (a === undefined) continue
      if (refusedPosition(b, a)) return refused(list)
      const swap = list.swaps.find((s) => s.from.includes(b))
      // Load more shows the open batch's answer from the press
      if (swap?.why === 'more') continue
      const settled = settledOf(b, a)
      if (settled === null) {
        // it gives way to its halves, also where it waited to merge
        if (swap?.why === 'merge') cancel(list, swap)
        if (swap?.why !== 'split')
          list.swaps.push({ from: [b], to: halves(list, b, a.value as OkList), why: 'split' })
        continue
      }
      fresh.push([b, settled])
      // an answer that fits again ends the split it started
      if (swap?.why === 'split') cancel(list, swap)
    }
    // swaps whose batches all answered replace what they stood for, all at
    // once with every Load more's and split's batches, halves included:
    // while a batch on screen still shows its older answer for them, a
    // current answer beside it could show a row that left it a second time
    // or miss one that moved into it
    const waiting = list.swaps.some(
      (s) => s.why !== 'merge' && !s.to.every((b) => b.shown !== null),
    )
    for (const s of list.swaps) {
      if (!s.to.every((b) => b.shown !== null)) continue
      if (s.why === 'merge' && s.to.some((b) => b.shown?.kind !== 'ok')) {
        // a merge that failed keeps the two batches it would have joined
        for (const b of s.from) b.alone = true
        cancel(list, s)
        continue
      }
      if (waiting) continue
      const at = list.shown.indexOf(s.from[0] as Batch)
      if (at < 0) {
        cancel(list, s)
        continue
      }
      list.shown.splice(at, s.from.length, ...s.to)
      for (const b of s.from) transport.release(b.slot)
      list.swaps = list.swaps.filter((x) => x !== s)
    }
    // and the batches on screen take their current answers with them, so
    // the list shows one moment's answers
    if (!list.swaps.some((s) => s.why !== 'merge')) for (const [b, shown] of fresh) b.shown = shown
    // two frozen batches whose rows fit one read become one
    for (let i = 0; i + 1 < list.shown.length; i++) {
      const x = list.shown[i] as Batch
      const y = list.shown[i + 1] as Batch
      if (x.end === null || y.end === null || x.alone || y.alone) continue
      if (x.shown?.kind !== 'ok' || y.shown?.kind !== 'ok') continue
      if (list.swaps.some((s) => s.from.includes(x) || s.from.includes(y))) continue
      if (x.shown.answer.rows.length + y.shown.answer.rows.length > OVERVIEW_SPLIT) continue
      // the merged read stands beside the two until it answers
      if (readsOf(list) + 1 > LIST_READS) break
      list.swaps.push({ from: [x, y], to: [newBatch(list, x.cursor, y.end)], why: 'merge' })
      i++
    }
    cap(list, 0, 0)
    return true
  }

  /** Fits list `list` to LIST_ROWS with room for `rows` more rows and to
      LIST_READS with room for `reads` more reads: a merge still on its way
      gives way first, as it only saves reads, then a Load more on its way
      beside a batch on screen that waits for its halves, which keeps every
      row on screen, then the first batches on screen. The open batch
      stays. Where it is the only one left and a Load more's frozen read
      split past LIST_READS, the Load more gives way too. The open batch
      takes its current answer once nothing holds the list (settleList). */
  function cap(list: List, rows: number, reads: number) {
    const over = () => readsOf(list) + reads > LIST_READS
    /** Gives up the Load more on its way, if there is one. */
    const unpress = () => {
      const pressed = list.swaps.find((s) => s.why === 'more')
      if (!pressed) return
      cancel(list, pressed)
      again = true
    }
    for (const s of list.swaps.filter((x) => x.why === 'merge')) if (over()) cancel(list, s)
    if (over() && list.swaps.some((s) => s.why === 'split')) unpress()
    while (list.shown.length > 1 && (list.shown[0] as Batch).end !== null) {
      if (rowsOf(list) + rows <= LIST_ROWS && !over()) return
      drop(list, list.shown[0] as Batch)
    }
    if (over()) unpress()
  }

  /** Takes every read's news in, until nothing more changes. */
  function settle() {
    if (settling) {
      again = true
      return
    }
    settling = true
    try {
      do {
        again = false
        for (const list of Object.values(lists)) settleList(list)
        settleHealth()
      } while (again)
    } finally {
      settling = false
    }
  }

  /** The health read's arguments now, null where it asks for none. */
  const healthKey = () =>
    base === null || table === null
      ? null
      : JSON.stringify(overviewArgs('health', base, null, null, { ...table, limit }))

  /** Registers the health read as the reads stand: live while asking with
      a table. */
  const watchHealth = () =>
    transport.watch(HEALTH_SLOT, 'health', asking ? healthKey() : null, healthTries)

  /** Takes the health read's news in: an answer for the table asked now is
      the one it shows, and a Load more that failed goes back to the rows
      it showed, asking their arguments again. */
  function settleHealth() {
    const key = healthKey()
    if (key === null || baseKey === null || table === null) return
    const held = transport.read(HEALTH_SLOT)
    if (held.key !== key) return
    if (held.error === undefined) {
      if (held.value !== undefined)
        shownHealth = { base: baseKey, ask: { ...table, limit }, value: held.value as HealthAnswer }
      return
    }
    const before = shownHealth
    if (
      before !== null &&
      before.base === baseKey &&
      sameTable(before.ask, table) &&
      before.ask.limit < limit &&
      failedMore === null
    ) {
      failedMore = limit
      limit = before.ask.limit
      watchHealth()
    }
  }

  /** What the health table shows (HealthView). */
  function healthView(): HealthView {
    const key = healthKey()
    if (key === null || table === null) return null
    const held = transport.read(HEALTH_SLOT)
    const ask = { ...table, limit }
    const more = (
      value: HealthAnswer | undefined,
      pressed: boolean,
    ): NonNullable<HealthView>['more'] => {
      if (failedMore !== null) return null
      if (pressed) return 'loading'
      return value?.state === 'ok' &&
        value.rows.length < value.total &&
        value.rows.length < value.most
        ? 'ready'
        : null
    }
    if (held.key === key && held.value !== undefined) {
      const value = held.value as HealthAnswer
      return {
        value,
        current: held.current,
        kept: false,
        more: more(value, false),
        moreFailed: failedMore !== null,
      }
    }
    if (held.key === key && held.error !== undefined && failedMore === null)
      return {
        error: held.error,
        current: held.current,
        kept: false,
        more: null,
        moreFailed: false,
      }
    // waiting: the last answer shown for this scope and clock
    const before = shownHealth
    if (before === null || before.base !== baseKey) return null
    const same = sameTable(before.ask, ask) && before.ask.limit === ask.limit
    const pressed = sameTable(before.ask, ask) && before.ask.limit < ask.limit
    return {
      value: before.value,
      current: false,
      kept: !same,
      more: more(before.value, pressed),
      moreFailed: failedMore !== null,
    }
  }

  /** Registers every read as the reads stand. */
  function watchAll() {
    const figure = (slot: string, query: 'summary' | 'risk') =>
      transport.watch(
        slot,
        query,
        asking && base ? JSON.stringify(overviewArgs(query, base)) : null,
        attempt,
      )
    figure(SUMMARY_SLOT, 'summary')
    figure(RISK_SLOT, 'risk')
    watchHealth()
    for (const list of Object.values(lists)) {
      for (const b of list.shown) watchBatch(list, b)
      for (const s of list.swaps) for (const b of s.to) watchBatch(list, b)
    }
  }

  /** The figure read `slot` holds for the arguments asked now. */
  function figureOf<T>(slot: string, query: 'summary' | 'risk'): FigureView<T> {
    if (!base) return null
    const held = transport.read(slot)
    if (held.key === null || held.key !== JSON.stringify(overviewArgs(query, base))) return null
    if (held.error !== undefined) return { error: held.error, current: held.current }
    if (held.value === undefined) return null
    return { value: held.value as T, current: held.current }
  }

  /** What list `list` shows. */
  function listView(list: List): ListView {
    const batches: BatchView[] = []
    let refreshing = false
    // while a batch on screen waits for its halves the list shows older
    // answers (settleList), so it cannot say it reached its end; nor while
    // a batch waits for its answer, as after Try again; a merge's batches
    // keep taking their answers, and a Load more on its way, which holds
    // older answers too, says no end by itself (`pressed`)
    let older = false
    for (const b of list.shown) {
      if (list.swaps.some((s) => s.why === 'split' && s.from.includes(b))) older = true
      const held = transport.read(b.slot)
      if (!held.current) refreshing = true
      const shown = b.shown
      const view: BatchView = {
        id: b.id,
        slot: b.slot,
        rows: [],
        note: null,
        waiting: shown === null,
      }
      if (shown?.kind === 'ok') {
        view.rows = shown.answer.rows
        if (!shown.answer.complete) view.note = { kind: 'incomplete' }
      } else if (shown?.kind === 'refused')
        view.note =
          shown.value.state === 'over_budget'
            ? { kind: 'over_budget' }
            : {
                kind: 'unavailable',
                ...(shown.value.message === undefined ? {} : { message: shown.value.message }),
              }
      else if (shown?.kind === 'error') view.note = { kind: 'error' }
      batches.push(view)
    }
    const last = list.shown[list.shown.length - 1]
    const lastShown = last?.shown
    const open = last !== undefined && last.end === null
    const pressed =
      last !== undefined && list.swaps.some((s) => s.why === 'more' && s.from.includes(last))
    const failedIn = batches.some((b) => b.note?.kind === 'error' || b.note?.kind === 'unavailable')
    const overBudget = batches.some((b) => b.note?.kind === 'over_budget')
    const stopped = batches.some((b) => b.note?.kind === 'incomplete')
    const answered = batches.some((b) => !b.waiting)
    const end =
      open &&
      !pressed &&
      !older &&
      !batches.some((b) => b.waiting) &&
      lastShown?.kind === 'ok' &&
      lastShown.answer.next === null &&
      lastShown.answer.complete &&
      !failedIn &&
      !overBudget
    const state: ListView['state'] = list.failed
      ? 'error'
      : failedIn
        ? 'error'
        : overBudget
          ? 'over_budget'
          : !answered
            ? 'loading'
            : refreshing
              ? 'refreshing'
              : stopped
                ? 'incomplete'
                : 'ok'
    return {
      state,
      batches,
      dropped: list.dropped,
      end,
      more: pressed
        ? 'loading'
        : open && lastShown?.kind === 'ok' && lastShown.answer.next !== null
          ? 'ready'
          : null,
      failed: list.failed,
      reads: readsOf(list),
    }
  }

  /** Finds batch `id` of list `list`, on screen or waiting to replace. */
  const findBatch = (list: List, id: number) =>
    list.shown.find((b) => b.id === id) ?? list.swaps.flatMap((s) => s.to).find((b) => b.id === id)

  /** Forgets everything without asking the store. */
  function clear() {
    base = null
    baseKey = null
    asking = false
    owner = 0
    attempt = 0
    lists.attention = emptyList('attention')
    lists.paused = emptyList('paused')
    table = null
    limit = OVERVIEW_BATCH
    healthTries = 0
    shownHealth = null
    failedMore = null
  }

  return {
    /** Asks for the Overview `next`, or for nothing (null) while the page
        or the tab is hidden, which stops every read and keeps what they
        held. `by` names the mounted page: one that leaves after the next
        one asked stops nothing. A new `tries` (the page's Try again) asks
        the summary and the delays afresh. */
    watch(next: OverviewBase | null, by: number, tries: number) {
      if (next === null && by !== owner) return
      owner = by
      if (next === null) {
        if (!asking) return
        asking = false
        watchAll()
        return
      }
      const key = overviewKey(next)
      const sameAsk = asking && key === baseKey && tries === attempt
      if (sameAsk) return
      // a new scope starts the health table at its first rows; a new clock
      // keeps them
      if (
        base === null ||
        JSON.stringify(scopeArgs(base.scope)) !== JSON.stringify(scopeArgs(next.scope))
      ) {
        limit = OVERVIEW_BATCH
        failedMore = null
      }
      attempt = tries
      base = next
      baseKey = key
      asking = true
      for (const list of Object.values(lists)) {
        const listKey = listKeyOf(list.kind, next)
        if (list.key !== listKey) {
          list.key = listKey
          list.restarted = null
          restart(list)
        }
      }
      watchAll()
      settle()
    },
    /** Asks for the health table `next` (null for none, as for one
        sub-project), apart from the scope's reads, so only the health read
        asks again. `by` names the mounted page, as `watch` takes it; a page
        that is not the one asking changes nothing. A new sort or search
        starts again at the first rows. */
    watchTable(next: HealthTable | null, by: number) {
      if (by !== owner) return
      if (next === null ? table === null : sameTable(next, table)) return
      // a new sort or search starts again at the first rows
      limit = OVERVIEW_BATCH
      failedMore = null
      table = next
      watchHealth()
      settle()
    },
    /** Load more on the health table: asks OVERVIEW_BATCH more rows, at most
        the answer's `most`, keeping the rows shown until they answer. */
    moreHealth() {
      const view = healthView()
      if (view?.more !== 'ready' || view.value?.state !== 'ok') return
      limit = Math.min(limit + OVERVIEW_BATCH, view.value.most)
      watchHealth()
      settle()
    },
    /** Asks the health table afresh (its Try again), or after a Load more
        that failed, that Load more again (its Retry). */
    retryHealth() {
      if (failedMore !== null) {
        limit = failedMore
        failedMore = null
      }
      healthTries++
      watchHealth()
      settle()
    },
    /** Takes the reads' news in: the store calls it after each delivery of
        an Overview read. */
    settle,
    /** Load more on list `kind`: freezes its open batch and opens the next
        one at its `next`, after the cap gave up a merge on its way or
        dropped the first batches it needs to (cap). */
    more(kind: ListKind) {
      const list = lists[kind]
      const last = list.shown[list.shown.length - 1]
      if (!last || last.end !== null || last.shown?.kind !== 'ok') return
      const answer = last.shown.answer
      if (answer.next === null || list.swaps.some((s) => s.from.includes(last))) return
      // room for the next batch's rows and the reads both new batches take,
      // beside the open batch's until then
      cap(list, OVERVIEW_BATCH, 2)
      list.swaps.push({
        from: [last],
        to: [newBatch(list, last.cursor, answer.end), newBatch(list, answer.next, null)],
        why: 'more',
      })
      settle()
    },
    /** Shows list `kind` from its first batch again. */
    fromStart(kind: ListKind) {
      const list = lists[kind]
      if (base === null) return
      list.restarted = null
      restart(list)
      settle()
    },
    /** Asks batch `id` of list `kind` afresh (its Try again or Retry). */
    retry(kind: ListKind, id: number) {
      const list = lists[kind]
      const b = findBatch(list, id)
      if (!b) return
      b.attempt++
      b.shown = null
      watchBatch(list, b)
      settle()
    },
    /** What the reads hold for the page. */
    view(): OverviewView {
      return {
        key: baseKey,
        summary: figureOf<SummaryAnswer>(SUMMARY_SLOT, 'summary'),
        risk: figureOf<RiskAnswer>(RISK_SLOT, 'risk'),
        attention: listView(lists.attention),
        paused: listView(lists.paused),
        health: healthView(),
      }
    },
    /** Whether view slot `slot` is one of the Overview's. */
    owns: (slot: string) => slot.startsWith('overview:'),
    /** Forgets every read and its rows: the Overview page left. */
    release() {
      transport.release(SUMMARY_SLOT)
      transport.release(RISK_SLOT)
      transport.release(HEALTH_SLOT)
      for (const list of Object.values(lists)) {
        for (const b of list.shown) transport.release(b.slot)
        for (const s of list.swaps) for (const b of s.to) transport.release(b.slot)
      }
      clear()
    },
    /** Forgets everything without asking the store, whose own reset
        cleared the reads (a new identity or a disposed demo). */
    clear,
  }
}

export type OverviewReads = ReturnType<typeof createOverviewReads>
