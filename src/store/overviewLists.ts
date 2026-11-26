/* The Overview's reads (views/overview/ProjectOverview.tsx and
   views/overview/MyOverview.tsx): its summary, its health table, a
   project's Needs attention list and My view's Your work, over the store's
   view reads (store/planner.ts watchView), which this module asks for
   through the transport it is given, as store/ownerLoadCache.ts takes one.
   It holds no React and reads nothing of the store's own.

   - The page asks for one scope and clock at a time (`watch`), or for
     nothing while its page or the tab is hidden: every read stops, keeps
     what it held and reads again with the same arguments when the page
     asks for them again. Arguments are built here in one fixed key order,
     so equal arguments share one subscription.
   - The summary is one read. The health table, the Needs attention list
     and Your work are each one read of their first rows, with Load more:
     the health table OVERVIEW_BATCH rows at first and as many more each
     time, Needs attention NEEDS_FIRST and NEEDS_STEP, and each group of
     Your work WORK_FIRST and WORK_STEP, apart from the other groups. Each
     asks only while the page asks for it (`watchTable`, `watchNeeds`,
     `watchWork`), apart from the scope's reads, so a new sort, search,
     kind or Load more asks that read alone. A new sort, search or kind
     starts again at the first rows. A new scope forgets them and asks
     none until the page registers its own, so no read asks the new scope
     with the old scope's arguments.
   - While an answer for new arguments is on its way, the last answer
     shown for the same scope and clock stays as `kept`, as the store's
     view read drops what it held for other arguments, and offers no Load
     more beyond the one on its way; a new scope or clock shows nothing
     until its own answer. For a Load more and its Retry the store's read
     keeps that answer and its rows too (OverviewTransport `hold`), so the
     tasks of the rows on screen stay editable until the longer answer
     replaces them. A Load more that fails goes back to the rows it
     showed, asking their arguments again so they keep updating, and offers
     Retry; the store keeps those rows through the failure and that read
     until its answer replaces them. Where those rows fail too, the read
     shows its error, without them, whose Try again asks it afresh.
   - A project or sub-project's page (`page` 'status') asks the summary,
     the health table and Needs attention; My view's page ('mine') the
     summary, the health table and Your work. */

import type { Value } from 'convex/values'
import type {
  HealthAnswer,
  HealthSort,
  OverviewScope,
  SummaryAnswer,
} from '../../convex/lib/overview'
import type { NeedsAnswer, NeedsFilter } from '../../convex/lib/overviewNeeds'
import type { WorkAnswer } from '../../convex/lib/overviewWork'
import { WORK_GROUPS, type WorkGroup } from '../../convex/lib/workGroups'

/** The health table's first rows and its Load more step. */
export const OVERVIEW_BATCH = 10
/** How many local weeks the clock sends: this one and the 52 before
    (convex/lib/viewLoads.ts WEEK_STARTS). */
export const OVERVIEW_WEEKS = 53

/** The Needs attention list's first rows and its Load more step
    (convex/lib/overviewNeeds.ts NEEDS). */
export const NEEDS_FIRST = 20
export const NEEDS_STEP = 20

/** A group of Your work's first rows and its Load more step
    (convex/lib/overviewWork.ts WORK). */
export const WORK_FIRST = 10
export const WORK_STEP = 10

/** The Overview's queries (convex/overview.ts) the app calls. */
export type OverviewQuery = 'summary' | 'health' | 'needs' | 'work'

/** Which Overview page asks: a project or sub-project's ('status') or My
    view's ('mine'). */
export type OverviewPage = 'status' | 'mine'

/** The Needs attention list the page asks for: the kind it shows. */
export type NeedsAsk = { kind: NeedsFilter }

/** The health table the page asks for: the column it sorts by, the
    direction, the search, trimmed, '' for none, and whether it leaves out
    the rows with nothing left (`openOnly`). */
export type HealthTable = {
  sort: HealthSort
  dir: 'asc' | 'desc'
  search: string
  openOnly?: boolean
}

/** One health read's table, with how many rows it asks for. */
export type HealthAsk = HealthTable & { limit: number }

/** How many rows of each group Your work asks for. */
export type WorkLimits = Record<WorkGroup, number>

/** The client's day and weeks the queries are judged by
    (convex/lib/viewLoads.ts clockOf). */
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

const firstWork = (): WorkLimits => ({ progress: WORK_FIRST, review: WORK_FIRST, next: WORK_FIRST })

/**
 * The arguments of `query` for `base`, in a fixed key order: the summary
 * takes the day; the health table every clock field and `table`'s column,
 * direction, search (left out when blank), limit and open_only where set;
 * Needs attention every clock field, `needs`' kind and limit; Your work
 * every clock field and each group's limit.
 */
export function overviewArgs(
  query: OverviewQuery,
  base: OverviewBase,
  table: HealthAsk | null = null,
  needs: (NeedsAsk & { limit: number }) | null = null,
  work: WorkLimits | null = null,
): Record<string, Value> {
  const scope = scopeArgs(base.scope)
  switch (query) {
    case 'summary':
      return { scope, day: base.clock.day }
    case 'needs': {
      const n = needs ?? { kind: 'all', limit: NEEDS_FIRST }
      const at = base.scope.kind === 'project' ? base.scope : { org_id: '', project_id: '' }
      return {
        scope: { org_id: at.org_id, project_id: at.project_id },
        ...clockArgs(base.clock),
        kind: n.kind,
        limit: n.limit,
      }
    }
    case 'work': {
      const w = work ?? firstWork()
      return { ...clockArgs(base.clock), progress: w.progress, review: w.review, next: w.next }
    }
    case 'health': {
      const t = table ?? { sort: 'late', dir: 'desc', search: '', limit: OVERVIEW_BATCH }
      return {
        scope,
        ...clockArgs(base.clock),
        sort: t.sort,
        dir: t.dir,
        ...(t.search === '' ? {} : { search: t.search }),
        limit: t.limit,
        ...(t.openOnly ? { open_only: true } : {}),
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
      afresh. With `hold` the answer it holds for other arguments, and its
      rows, stay until an answer for `key` replaces them. A failure for
      `key` keeps those rows, which stay through a `hold` back to the
      arguments they answer, until that read's result replaces them. */
  watch(
    slot: string,
    query: OverviewQuery,
    key: string | null,
    attempt: number,
    hold: boolean,
  ): void
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

/** What a read of first rows with Load more shows: its answer, or nothing
    (null) before the first one for the scope and clock asked now. */
type LimitedView<Ask, Answer, More, Lim = number> = {
  /** the answer shown: the one for the arguments asked now, or while an
      answer for new arguments is on its way, the last one shown for this
      scope and clock (`kept`) */
  value?: Answer
  /** the error of the first answer for the arguments asked now */
  error?: unknown
  /** the arguments the answer or the error shown answers */
  ask: Ask
  /** whether the answer shown is the live subscription's for the
      arguments asked now, arrived on this connection */
  current: boolean
  /** whether the answer shown answers other arguments than those asked
      now: a sort, a search, a kind or a Load more on its way */
  kept: boolean
  /** Load more: `ready` to press, `loading` while its rows load, none */
  more: More
  /** whether a Load more failed, so the rows are the ones before it and
      Retry asks it again */
  moreFailed: boolean
  /** the rows that failed Load more asked for, null for none */
  failedAt: Lim | null
} | null

type MoreState = 'ready' | 'loading' | null

/** What the health table shows; `table` is the arguments its answer
    answers. */
export type HealthView =
  | (Omit<NonNullable<LimitedView<HealthAsk, HealthAnswer, MoreState>>, 'ask'> & {
      table: HealthAsk
    })
  | null

/** What the Needs attention list shows. */
export type NeedsView = LimitedView<NeedsAsk & { limit: number }, NeedsAnswer, MoreState>

/** What Your work shows: Load more and a failed Load more by group. */
export type WorkView = LimitedView<true, WorkAnswer, Record<WorkGroup, MoreState>, WorkLimits>

/** What the Overview's reads hold for the page. */
export type OverviewView = {
  /** the Overview the reads are for, null for none */
  key: string | null
  summary: FigureView<SummaryAnswer>
  health: HealthView
  needs: NeedsView
  work: WorkView
}

const SUMMARY_SLOT = 'overview:summary'
const HEALTH_SLOT = 'overview:health'
const NEEDS_SLOT = 'overview:needs'
const WORK_SLOT = 'overview:work'

/** An answer of first rows: its rows, how many there are and the most one
    answer holds. */
type Limited = { state: string; rows?: readonly unknown[]; total?: number; most?: number }

/* Whether two health tables ask the same. */
const sameTable = (a: HealthTable, b: HealthTable) =>
  a.sort === b.sort && a.dir === b.dir && a.search === b.search && !a.openOnly === !b.openOnly

/** Creates the Overview's reads over `transport`. */
export function createOverviewReads(transport: OverviewTransport) {
  let base: OverviewBase | null = null
  let baseKey: string | null = null
  // whether the reads are live: the page shows and asked
  let asking = false
  let owner = 0
  let attempt = 0
  let settling = false
  let again = false
  // which page asks: its reads (OverviewPage)
  let page: OverviewPage = 'status'

  /**
   * One read of an answer's first rows with Load more (the module header):
   * what the page asks (`ask`, null for none), how many rows (`limit`),
   * `first` at first and `grow` for each Load more, its Try again count,
   * the last answer it showed for the Overview and the limit it answered,
   * and a Load more that failed, whose Retry asks it again. `Lim` is a
   * number of rows, or one for each part of an answer, as Your work's
   * groups; `pressed` says which parts a limit asks more of than one
   * before, and `ready` which parts of an answer offer Load more. A Load
   * more of one part that failed leaves the other parts' Load more, and
   * `join` keeps the larger of two limits in each part, so a failed part's
   * Retry keeps what another part loaded since.
   */
  function limitedRead<Ask, Answer extends { state: string }, Lim, More, Asked>(o: {
    slot: string
    query: OverviewQuery
    first: () => Lim
    same: (a: Ask, b: Ask) => boolean
    sameLimit: (a: Lim, b: Lim) => boolean
    args: (at: OverviewBase, ask: Ask, limit: Lim) => Record<string, Value>
    /** what the view names as the arguments of `ask` with `limit` */
    asked: (ask: Ask, limit: Lim) => Asked
    /** whether `now` asks more rows than `before` of some part */
    grew: (before: Lim, now: Lim) => boolean
    join: (a: Lim, b: Lim) => Lim
    /** what Load more says for `value`, the answer for limit `answered`,
        `pressed` naming the limit on its way and `failed` the one a failed
        Load more asked (null for none) */
    more: (value: Answer, answered: Lim, pressed: Lim | null, failed: Lim | null) => More
    none: More
  }) {
    let ask: Ask | null = null
    let limit = o.first()
    let tries = 0
    let shown: { base: string; ask: Ask; limit: Lim; value: Answer } | null = null
    let failedMore: Lim | null = null
    const same = (a: Ask | null, b: Ask | null) => a !== null && b !== null && o.same(a, b)

    /** The read's arguments now, null where it asks for none. */
    const key = () =>
      base === null || ask === null ? null : JSON.stringify(o.args(base, ask, limit))

    /** Registers the read as the reads stand: live while asking, holding
        the answer shown and its rows where the arguments ask more rows of
        it, and after a failed Load more, whose read goes back to them. */
    const watch = () =>
      transport.watch(
        o.slot,
        o.query,
        asking ? key() : null,
        tries,
        shown !== null &&
          shown.base === baseKey &&
          same(shown.ask, ask) &&
          (o.grew(shown.limit, limit) || failedMore !== null),
      )

    /** Takes the read's news in: an answer for the arguments asked now is
        the one it shows, and a Load more that failed goes back to the rows
        it showed, asking their arguments again. Where those rows fail too,
        it forgets the Load more, so the read shows its error and Try again
        asks it afresh. */
    function settleRead() {
      const now = key()
      if (now === null || baseKey === null || ask === null) return
      const held = transport.read(o.slot)
      if (held.key !== now) return
      if (held.error === undefined) {
        if (held.value !== undefined)
          shown = { base: baseKey, ask, limit, value: held.value as Answer }
        return
      }
      if (
        shown !== null &&
        shown.base === baseKey &&
        same(shown.ask, ask) &&
        o.grew(shown.limit, limit)
      ) {
        failedMore = failedMore === null ? limit : o.join(failedMore, limit)
        limit = shown.limit
        watch()
        return
      }
      failedMore = null
    }

    /** What the read shows. */
    function view(): LimitedView<Asked, Answer, More, Lim> {
      const now = key()
      if (now === null || ask === null) return null
      const held = transport.read(o.slot)
      const asked = o.asked(ask, limit)
      const offered = (value: Answer, answered: Lim, pressed: Lim | null) =>
        o.more(value, answered, pressed, failedMore)
      if (held.key === now && held.value !== undefined) {
        const value = held.value as Answer
        return {
          value,
          ask: asked,
          current: held.current,
          kept: false,
          more: offered(value, limit, null),
          moreFailed: failedMore !== null,
          failedAt: failedMore,
        }
      }
      // the last answer shown for this scope and clock, and whether the
      // arguments asked now are its own with more rows (a Load more)
      const before = shown !== null && shown.base === baseKey ? shown : null
      const sameAsk = before !== null && same(before.ask, ask)
      const pressed = sameAsk && before !== null && o.grew(before.limit, limit)
      const keptAsk = before === null ? asked : o.asked(before.ask, before.limit)
      if (held.key === now && held.error !== undefined)
        // a Load more that failed shows the rows before it from the first
        // render, as settleRead takes the read back to them; any other
        // error is the read's own, also where the rows a failed Load more
        // went back to failed, which settleRead then forgets
        return pressed && before !== null
          ? {
              value: before.value,
              ask: keptAsk,
              current: false,
              kept: false,
              more: o.none,
              moreFailed: true,
              failedAt: failedMore === null ? limit : o.join(failedMore, limit),
            }
          : {
              error: held.error,
              ask: asked,
              current: held.current,
              kept: false,
              more: o.none,
              moreFailed: false,
              failedAt: null,
            }
      // waiting: the last answer shown for this scope and clock, which
      // offers Load more only where it answers what is asked now, so a press
      // never raises the rows of another sort, search or kind on its way
      if (before === null) return null
      const exact = sameAsk && o.sameLimit(before.limit, limit)
      return {
        value: before.value,
        ask: keptAsk,
        current: false,
        kept: !exact,
        more: exact
          ? offered(before.value, before.limit, null)
          : pressed
            ? offered(before.value, before.limit, limit)
            : o.none,
        moreFailed: failedMore !== null,
        failedAt: failedMore,
      }
    }

    return {
      watch,
      settle: settleRead,
      view,
      /** Asks for `next` (null for none), the first rows again where it
          changed. Answers whether it changed. */
      set(next: Ask | null): boolean {
        if (next === null ? ask === null : same(next, ask)) return false
        limit = o.first()
        failedMore = null
        ask = next
        watch()
        return true
      },
      /** Load more: the limit `grow` gives, keeping the rows shown until
          they answer. */
      more(grow: (limit: Lim, value: Answer) => Lim | null) {
        const v = view()
        if (v?.value?.state !== 'ok' || v.kept) return
        const next = grow(limit, v.value)
        if (next === null) return
        limit = next
        watch()
      },
      /** Asks afresh (Try again), or after a Load more that failed, that
          Load more again (Retry), whose new arguments ask afresh, so the
          rows on screen stay until they answer. */
      retry() {
        if (failedMore !== null) {
          limit = o.join(limit, failedMore)
          failedMore = null
        } else tries++
        watch()
      },
      /** Forgets what the page asked, as for a new scope. */
      forget() {
        ask = null
        limit = o.first()
        failedMore = null
      },
      /** Forgets everything without asking the store. */
      clear() {
        ask = null
        limit = o.first()
        tries = 0
        shown = null
        failedMore = null
      },
    }
  }

  /** Load more of one list of first rows: `step` more, at most its
      `most`, where it holds more rows than it shows. */
  const oneMore = (value: Limited, pressed: boolean): MoreState => {
    if (pressed) return 'loading'
    const rows = value.rows?.length ?? 0
    return value.state === 'ok' && rows < (value.total ?? 0) && rows < (value.most ?? 0)
      ? 'ready'
      : null
  }

  const health = limitedRead<HealthTable, HealthAnswer, number, MoreState, HealthAsk>({
    slot: HEALTH_SLOT,
    query: 'health',
    first: () => OVERVIEW_BATCH,
    same: sameTable,
    sameLimit: (a, b) => a === b,
    args: (at, table, limit) => overviewArgs('health', at, { ...table, limit }),
    asked: (table, limit) => ({ ...table, limit }),
    grew: (a, b) => a < b,
    join: Math.max,
    more: (value, _answered, pressed, failed) =>
      failed === null ? oneMore(value, pressed !== null) : null,
    none: null,
  })

  const needs = limitedRead<NeedsAsk, NeedsAnswer, number, MoreState, NeedsAsk & { limit: number }>(
    {
      slot: NEEDS_SLOT,
      query: 'needs',
      first: () => NEEDS_FIRST,
      same: (a, b) => a.kind === b.kind,
      sameLimit: (a, b) => a === b,
      args: (at, ask, limit) => overviewArgs('needs', at, null, { ...ask, limit }),
      asked: (ask, limit) => ({ ...ask, limit }),
      grew: (a, b) => a < b,
      join: Math.max,
      more: (value, _answered, pressed, failed) =>
        failed === null ? oneMore(value, pressed !== null) : null,
      none: null,
    },
  )

  const noWorkMore: Record<WorkGroup, MoreState> = { progress: null, review: null, next: null }
  const work = limitedRead<true, WorkAnswer, WorkLimits, Record<WorkGroup, MoreState>, true>({
    slot: WORK_SLOT,
    query: 'work',
    first: firstWork,
    same: () => true,
    sameLimit: (a, b) => WORK_GROUPS.every((g) => a[g] === b[g]),
    args: (at, _ask, limit) => overviewArgs('work', at, null, null, limit),
    asked: () => true,
    grew: (a, b) => WORK_GROUPS.some((g) => a[g] < b[g]),
    join: (a, b) => ({
      progress: Math.max(a.progress, b.progress),
      review: Math.max(a.review, b.review),
      next: Math.max(a.next, b.next),
    }),
    // while one group's Load more is on its way, only that group says so,
    // and a group whose Load more failed offers Retry instead
    more: (value, answered, pressed, failed) => {
      if (value.state !== 'ok') return noWorkMore
      const out = { ...noWorkMore }
      for (const g of WORK_GROUPS) {
        const group = value.groups[g]
        if (pressed !== null) out[g] = pressed[g] > answered[g] ? 'loading' : null
        else if (failed !== null && failed[g] > answered[g]) out[g] = null
        else out[g] = oneMore({ state: 'ok', ...group, most: value.most }, false)
      }
      return out
    },
    none: noWorkMore,
  })

  /** What the health table shows (HealthView). */
  function healthView(): HealthView {
    const v = health.view()
    if (v === null) return null
    const { ask, ...rest } = v
    return { ...rest, table: ask }
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
        health.settle()
        needs.settle()
        work.settle()
      } while (again)
    } finally {
      settling = false
    }
  }

  /** Registers every read as the reads stand. */
  function watchAll() {
    transport.watch(
      SUMMARY_SLOT,
      'summary',
      asking && base ? JSON.stringify(overviewArgs('summary', base)) : null,
      attempt,
      false,
    )
    health.watch()
    needs.watch()
    work.watch()
  }

  /** The summary's answer for the arguments asked now. */
  function summaryView(): FigureView<SummaryAnswer> {
    if (!base) return null
    const held = transport.read(SUMMARY_SLOT)
    if (held.key === null || held.key !== JSON.stringify(overviewArgs('summary', base))) return null
    if (held.error !== undefined) return { error: held.error, current: held.current }
    if (held.value === undefined) return null
    return { value: held.value as SummaryAnswer, current: held.current }
  }

  /** Forgets everything without asking the store. */
  function clear() {
    base = null
    baseKey = null
    asking = false
    owner = 0
    attempt = 0
    page = 'status'
    health.clear()
    needs.clear()
    work.clear()
  }

  return {
    /** Asks for the Overview `next`, or for nothing (null) while the page
        or the tab is hidden, which stops every read and keeps what they
        held. `by` names the mounted page: one that leaves after the next
        one asked stops nothing. A new `tries` (the page's Try again) asks
        the summary afresh. A new scope or page forgets the health table,
        the Needs attention list and Your work, so their reads ask nothing
        until the page registers the new scope's (watchTable, watchNeeds,
        watchWork). `as` says which page asks (OverviewPage). */
    watch(next: OverviewBase | null, by: number, tries: number, as: OverviewPage = 'status') {
      if (next === null && by !== owner) return
      owner = by
      if (next === null) {
        if (!asking) return
        asking = false
        watchAll()
        return
      }
      const key = overviewKey(next)
      const sameAsk = asking && key === baseKey && tries === attempt && as === page
      if (sameAsk) return
      // App mounts the page anew for each scope, so no read asks the new
      // scope with the old one's arguments; a new clock keeps them and
      // their rows
      if (
        base === null ||
        as !== page ||
        JSON.stringify(scopeArgs(base.scope)) !== JSON.stringify(scopeArgs(next.scope))
      ) {
        health.forget()
        needs.forget()
        work.forget()
      }
      attempt = tries
      base = next
      baseKey = key
      asking = true
      page = as
      watchAll()
      settle()
    },
    /** Asks for the health table `next` (null for none, as for one
        sub-project), for the page `by` names: a page that is not the one
        asking changes nothing. A new sort or search starts again at the
        first rows. */
    watchTable(next: HealthTable | null, by: number) {
      if (by !== owner) return
      if (health.set(next)) settle()
    },
    /** Load more on the health table: OVERVIEW_BATCH more rows, at most
        the answer's `most`. */
    moreHealth() {
      if (health.view()?.more !== 'ready') return
      health.more((limit, value) =>
        value.state === 'ok' ? Math.min(limit + OVERVIEW_BATCH, value.most) : null,
      )
      settle()
    },
    /** Asks the health table afresh, or a failed Load more again. */
    retryHealth() {
      health.retry()
      settle()
    },
    /** Asks for the Needs attention list's kind `next` (null for none), for
        the page `by` names, as watchTable takes a table. */
    watchNeeds(next: NeedsAsk | null, by: number) {
      if (by !== owner) return
      if (needs.set(next)) settle()
    },
    /** Load more on the Needs attention list: NEEDS_STEP more rows. */
    moreNeeds() {
      if (needs.view()?.more !== 'ready') return
      needs.more((limit, value) =>
        value.state === 'ok' ? Math.min(limit + NEEDS_STEP, value.most) : null,
      )
      settle()
    },
    /** Asks the Needs attention list afresh, or a failed Load more again. */
    retryNeeds() {
      needs.retry()
      settle()
    },
    /** Asks for Your work, or none with false, for the page `by` names. */
    watchWork(on: boolean, by: number) {
      if (by !== owner) return
      if (work.set(on ? true : null)) settle()
    },
    /** Load more on group `group` of Your work: WORK_STEP more of its
        rows, the other groups' limits kept. */
    moreWork(group: WorkGroup) {
      const v = work.view()
      if (v?.more[group] !== 'ready') return
      work.more((limit, value) =>
        value.state === 'ok'
          ? { ...limit, [group]: Math.min(limit[group] + WORK_STEP, value.most) }
          : null,
      )
      settle()
    },
    /** Asks Your work afresh, or a failed Load more again. */
    retryWork() {
      work.retry()
      settle()
    },
    /** Takes the reads' news in: the store calls it after each delivery of
        an Overview read. */
    settle,
    /** What the reads hold for the page. */
    view(): OverviewView {
      return {
        key: baseKey,
        summary: summaryView(),
        health: healthView(),
        needs: needs.view(),
        work: work.view(),
      }
    },
    /** Whether view slot `slot` is one of the Overview's. */
    owns: (slot: string) => slot.startsWith('overview:'),
    /** Forgets every read and its rows: the Overview page left. */
    release() {
      transport.release(SUMMARY_SLOT)
      transport.release(HEALTH_SLOT)
      transport.release(NEEDS_SLOT)
      transport.release(WORK_SLOT)
      clear()
    },
    /** Forgets everything without asking the store, whose own reset
        cleared the reads (a new identity or a disposed demo). */
    clear,
  }
}

export type OverviewReads = ReturnType<typeof createOverviewReads>
