/* The task window's thread budget: how many comments and changes the store
   keeps loaded for the watched task, which of them go when it holds more,
   and how Show newer reads released rows back. The store
   (store/planner.ts keepThread, P.loadNewerComments, P.loadNewerHistory)
   applies the answers; this module holds no state and imports nothing from
   the store, so it is tested on its own (lib/threadBudget.test.ts).

   Each kind, the comments and, while a window shows All, the changes, is
   held in thread order as at most two runs and one gap: the older run,
   from the thread's start or the oldest row loaded down to the gap, the
   ids released between the runs, and the newer run, from the gap down to
   the live window or page, which the subscription delivers and which never
   goes. Without a gap every held row is in the older run.

   A release walks rows out one at a time on the side its trigger names
   (ReleaseMove), both kinds together in time order, so the two gaps run
   between the same kept instants as far as the rows allow. It keeps the
   first state on its walk that holds at most the budget and splits no
   instant, where no kept row shares a time with a row this release took
   and every row kept above a gap is older than every row kept below one,
   both kinds counted.

   The live rows never go, so no held row at one of their instants goes
   for good either. One write can log several changes at one instant, and
   the live page can start among them. Those changes sit right above the
   live page, and a kind without a gap opens it above its first row at an
   instant its own live rows hold, so they stay below the gap with the
   rows after them. An archive with a reason logs its change and posts its
   comment at one instant, so one of the two can sit anywhere in its run
   while the other is live. A move passes over a row at an instant that
   only the other kind's live rows hold: the row leaves its run like any
   row taken, its id joins the gap or the rows taken from the top, and the
   store holds it apart (KindAfter `apart`), counted in the budget, until a
   run holds it again or no held row of the other kind shares its instant.
   So such a row never stops a release, wherever Show earlier or an
   arrival brings it in the run.

   A move stops before a row at an instant of its own kind's live rows or
   of a row it must keep, and, walking `up`, at the instant of a kind's
   oldest kept row, which `up` never takes. So it never takes part of an
   instant it cannot finish, and the moves after it still run, where
   stepping back from a split instant would undo them too. Where the walk
   still ends in a state that splits an instant or breaks the order, it
   steps back to the last state on the walk that does neither, which holds
   more than the budget, and the next release tries again. A row the
   person edits (`pinned`) is passed over as well, and leaves its run. The
   store holds it apart, outside the count, until a page holds it again. */

import { LIMITS } from '../../convex/lib/limits'

/** How many comments and changes the store keeps loaded for the task the
    window shows (convex/lib/limits.ts threadRows), which each release
    brings what it holds back to: the live comment window and the live
    history page, the earlier pages Show earlier loaded, the rows that left
    the live window or page, and the pages Show newer read back. The
    history counts only while a window shows All.

    The kept set can pass the figure. A release never takes the live
    window (50 comments) or the live page (50 changes), the pages of the
    last press, and of a press made while it still loaded (up to 50 a kind
    each, 100 under All, where one press reads both), the row the window
    measures to keep the reader's place, the rows on screen around the
    place each window reported (the reported row and the 50 after it), or
    the changes of one write that the live page starts among, and it never
    splits an instant. So under All the store can hold about 200 rows after
    one press, and the rows it held plus both pages after a Show newer
    press made while Show earlier still loads, past the budget, until the
    next release. A row at an instant only the other kind's live
    rows hold is held apart within the count, so it never stops a release.
    A comment open in an editor is held besides, outside the count, until
    its editor closes or a page holds it again.

    The figure follows the coordinator's rule for it, checked with the
    browser benchmark's thread phase (scripts/benchmark-browser.mjs
    --thread), each case one figure raised: the largest candidate whose
    median longest frame after a delivered comment and after a Show earlier
    press stays under 100 ms under Comments and under All, and never less
    than 150, which holds the live window, the live page and one more page.
    The closing review's sweep, with the window's comment rows memoized,
    found no candidate that meets it, so the figure is the rule's floor,
    which the owner decides on. Design specification row 441 holds the
    budget, and the closing review's report in qivo-internal
    (evaluations/limits/closing-review-2026-11-09/closing-report.md,
    "Comment budget sweep") the figures. Tests lower it and restore it. */
export const THREAD_KEEP: { rows: number } = { rows: LIMITS.threadRows.max }

/** How many rows one read of a released span answers: the server's page of
    comments (convex/model/comments.ts COMMENT_PAGE_MAX) and of history
    (convex/lib/activityVisibility.ts WINDOW_HISTORY_PAGE), both 50. */
export const NEWER_PAGE = 50

/** A row the store holds: its id, and its time in ms, which the spine
    orders by. */
export type HeldRow = { readonly id: string; readonly ts: number }

/** What the store holds of one kind, in thread order: the run above the
    gap (every held row older than the live ones when there is no gap),
    the released ids between the runs or null with no gap, the run below
    the gap, empty with no gap, and the live window or page. */
export type HeldKind<R extends HeldRow = HeldRow> = {
  older: readonly R[]
  gap: readonly string[] | null
  newer: readonly R[]
  live: readonly R[]
}

/** Which side a release walks. `down` takes the newer run from the gap
    down, toward the live rows. `up` takes the older run from its newest
    row up. A kind without a gap opens one for either at the other kind's
    gap, or just above its own live rows when neither kind has one, and in
    either case no lower than its first row at an instant its own live
    rows hold, which stays below the gap with every row after it. `top`
    takes the older run from its oldest row down; once it empties, the gap
    joins the start and the walk goes on into the newer run. */
export type ReleaseMove = 'down' | 'up' | 'top'

/** One kind after a release: its runs and gap, whether rows went from its
    top, so its start is no longer loaded, every row this release took, the
    pinned one included, and `apart`, the rows among them at an instant
    only the other kind's live rows hold, which the store holds apart at
    their time and counts in the budget. */
export type KindAfter<R extends HeldRow = HeldRow> = {
  older: R[]
  gap: string[] | null
  newer: R[]
  fromTop: boolean
  released: R[]
  apart: R[]
}

/** What one release is asked: each kind as the store holds it (the
    history null while it is not held), the ids it must keep, the ids of
    the comments in an editor, which it passes over, the moves in order and
    the budget. */
export type ReleaseAsk<C extends HeldRow, E extends HeldRow> = {
  comments: HeldKind<C>
  history: HeldKind<E> | null
  keep: ReadonlySet<string>
  pinned: ReadonlySet<string>
  moves: readonly ReleaseMove[]
  budget: number
}

/* One kind while a release walks it. `seq` is the older run and the newer
   run, the gap's place in it `cut`, the existing gap ids `gap`. The walk
   has taken seq[0, t) from the top and seq[a, b) around the cut. `join`
   says the older run emptied, so the gap went and the walk reads seq from
   b on as its only run. `own` holds the instants of the kind's live rows,
   `apartAt` those only the other kind's live rows hold, and
   `apartBefore[i]` counts the rows of seq[0, i) at the latter, which a
   move passes over and the store holds apart. */
type Walk<R extends HeldRow> = {
  seq: readonly R[]
  live: readonly R[]
  own: ReadonlySet<number>
  apartAt: ReadonlySet<number>
  apartBefore: readonly number[]
  cut: number
  gap: readonly string[] | null
  t: number
  a: number
  b: number
  join: boolean
}
type Place = Pick<Walk<HeldRow>, 't' | 'a' | 'b' | 'join'>

/* Whether walk `w` has a gap now: one it held, or rows taken around the
   cut, and not joined to the start. */
const gapOf = (w: Place & { gap: readonly string[] | null }) =>
  !w.join && (w.gap !== null || w.a < w.b)

/* The rows walk `w` keeps above its gap and below it, or all of them with
   no gap (`above` empty then). */
function keptOf<R extends HeldRow>(w: Walk<R>): { above: readonly R[]; below: readonly R[] } {
  if (!gapOf(w)) return { above: [], below: [...w.seq.slice(w.t), ...w.live] }
  return { above: w.seq.slice(w.t, w.a), below: [...w.seq.slice(w.b), ...w.live] }
}

/* The rows walk `w` took, in thread order. */
const takenOf = <R extends HeldRow>(w: Walk<R>): R[] =>
  w.join ? w.seq.slice(0, w.b) : [...w.seq.slice(0, w.t), ...w.seq.slice(w.a, w.b)]

/* Whether the walks keep every row above a gap older than every row below
   one, per kind and across both kinds. */
function ordered(walks: readonly Walk<HeldRow>[]): boolean {
  let above = Number.NEGATIVE_INFINITY
  let below = Number.POSITIVE_INFINITY
  for (const w of walks) {
    if (!gapOf(w)) continue
    const kept = keptOf(w)
    const top = kept.above.reduce((max, r) => Math.max(max, r.ts), Number.NEGATIVE_INFINITY)
    const bottom = kept.below.reduce((min, r) => Math.min(min, r.ts), Number.POSITIVE_INFINITY)
    if (top >= bottom) return false
    above = Math.max(above, top)
    below = Math.min(below, bottom)
  }
  return above < below
}

/* How many rows walk `w` took that the store holds apart. */
const apartOf = (w: Walk<HeldRow>) =>
  w.join ? w.apartBefore[w.b] : w.apartBefore[w.t] + w.apartBefore[w.b] - w.apartBefore[w.a]

/* Whether no row the walks keep shares its time with a row they took,
   over both kinds; the pinned rows are left out, since they show at their
   time whatever went, and so are the rows taken to be held apart, which
   stay held beside the live rows at their instant. */
function whole(walks: readonly Walk<HeldRow>[], pinned: ReadonlySet<string>): boolean {
  const taken = new Set<number>()
  for (const w of walks) for (const r of takenOf(w)) if (!w.apartAt.has(r.ts)) taken.add(r.ts)
  if (taken.size === 0) return true
  for (const w of walks) {
    const kept = keptOf(w)
    for (const r of [...kept.above, ...kept.below])
      if (!pinned.has(r.id) && taken.has(r.ts)) return false
  }
  return true
}

/* The row walk `w` takes next on `move`, by its index in seq, or -1.
   Only `top` empties the run above the gap: `down` and `up` keep at least
   one row there, so they never make a kind's start unloaded. */
function nextOf(w: Walk<HeldRow>, move: ReleaseMove): number {
  if (move === 'top') return w.t < w.a ? w.t : w.b < w.seq.length ? w.b : -1
  if (w.join) return -1
  if (move === 'down') return w.b < w.seq.length && w.a > w.t ? w.b : -1
  return w.a - 1 > w.t ? w.a - 1 : -1
}

/* Takes row `at` of walk `w` on `move`. Once `top` empties the older run,
   the gap joins the start and the walk reads on from the newer run. */
function take(w: Walk<HeldRow>, move: ReleaseMove, at: number) {
  if (move === 'down') w.b = at + 1
  else if (move === 'up') w.a = at
  else if (at < w.a) {
    w.t = at + 1
    if (w.t === w.a && gapOf(w)) {
      w.join = true
      w.t = w.a = w.b
    }
  } else {
    w.join = true
    w.t = w.a = w.b = at + 1
  }
}

/** Releases rows of the watched thread until it holds at most `budget`, on
    the moves `ask.moves` names in turn, or answers null when it takes
    none. See the module's header for the rules. */
export function releaseThread<C extends HeldRow, E extends HeldRow>(
  ask: ReleaseAsk<C, E>,
): { comments: KindAfter<C>; history: KindAfter<E> | null } | null {
  const kinds: HeldKind<HeldRow>[] = ask.history ? [ask.comments, ask.history] : [ask.comments]
  // where a kind without a gap opens one: under the latest row kept above
  // the other kind's gap, or just above its own live rows
  const gapEnd = kinds.reduce(
    (max, k) => (k.gap === null ? max : k.older.reduce((m, r) => Math.max(m, r.ts), max)),
    Number.NEGATIVE_INFINITY,
  )
  // The instants of each kind's live rows. The live rows stay, so a held
  // row at an instant of its own kind's live rows stays with them, and a
  // kind without a gap opens it above its first such row. A held row at an
  // instant only the other kind's live rows hold is passed over and held
  // apart.
  const lives = kinds.map((k) => new Set(k.live.map((r) => r.ts)))
  const walks: Walk<HeldRow>[] = kinds.map((k, i) => {
    const seq = [...k.older, ...k.newer]
    const own = lives[i]
    const apartAt = new Set(
      lives.flatMap((other, j) => (j === i ? [] : [...other].filter((ts) => !own.has(ts)))),
    )
    const apartBefore = [0]
    for (const r of seq) apartBefore.push(apartBefore[apartBefore.length - 1] + +apartAt.has(r.ts))
    let cut = k.older.length
    if (k.gap === null) {
      if (gapEnd > Number.NEGATIVE_INFINITY) {
        const later = seq.findIndex((r) => r.ts > gapEnd)
        cut = later === -1 ? seq.length : later
      }
      const stay = seq.findIndex((r) => own.has(r.ts))
      if (stay !== -1) cut = Math.min(cut, stay)
    }
    return {
      seq,
      live: k.live,
      own,
      apartAt,
      apartBefore,
      cut,
      gap: k.gap,
      t: 0,
      a: cut,
      b: cut,
      join: false,
    }
  })
  // The instants no move takes a row at: those of the rows this release
  // must keep, of the moving kind's own live rows, and walking `up` also
  // the instant of each kind's oldest kept row, which `up` never takes.
  const stays = new Set<number>()
  for (const w of walks) for (const r of w.seq) if (ask.keep.has(r.id)) stays.add(r.ts)
  const stops = (w: Walk<HeldRow>, move: ReleaseMove, ts: number) =>
    stays.has(ts) ||
    w.own.has(ts) ||
    (move === 'up' && walks.some((v) => !v.join && v.t < v.seq.length && v.seq[v.t].ts === ts))
  // the rows held, those held apart included
  const held = () =>
    walks.reduce(
      (n, w) =>
        n +
        w.live.length +
        apartOf(w) +
        (gapOf(w) ? w.a - w.t + (w.seq.length - w.b) : w.seq.length - w.t),
      0,
    )
  // a thread already out of order (a join can bring rows whose times run
  // past the rows below, in a seeded thread) only has to stay whole
  const untidy = !ordered(walks)
  const fine = () => whole(walks, ask.pinned) && (untidy || ordered(walks))
  // the places the walk passed, to step back to the last one that splits
  // no instant
  const passed: Place[][] = []
  const places = () => walks.map(({ t, a, b, join }) => ({ t, a, b, join }))
  let done = held() <= ask.budget
  for (const move of ask.moves) {
    while (!done) {
      let pick = -1
      let at = -1
      for (let k = 0; k < walks.length; k++) {
        const i = nextOf(walks[k], move)
        if (i === -1) continue
        const ts = walks[k].seq[i].ts
        const best = pick === -1 ? 0 : walks[pick].seq[at].ts
        if (pick === -1 || (move === 'up' ? ts > best : ts < best)) {
          pick = k
          at = i
        }
      }
      if (pick === -1) break
      // a row the move cannot take with the rest of its instant ends the
      // move here, so the next move still runs
      if (stops(walks[pick], move, walks[pick].seq[at].ts)) break
      take(walks[pick], move, at)
      passed.push(places())
      done = held() <= ask.budget && fine()
    }
    if (done) break
  }
  if (!done) {
    // the last place on the walk that splits no instant and keeps the
    // order, or none
    let back = passed.length - 1
    for (; back >= 0; back--) {
      for (const [k, place] of passed[back].entries()) Object.assign(walks[k], place)
      if (fine()) break
    }
    if (back < 0) return null
  }
  // a walk that only moved rows apart lets nothing go
  if (walks.every((w) => takenOf(w).length === apartOf(w))) return null
  const after = <R extends HeldRow>(w: Walk<HeldRow>): KindAfter<R> => {
    const seq = w.seq as readonly R[]
    const released = takenOf(w) as R[]
    const apart = released.filter((r) => w.apartAt.has(r.ts))
    if (w.join)
      return { older: seq.slice(w.b), gap: null, newer: [], fromTop: true, released, apart }
    if (!gapOf(w))
      return { older: seq.slice(w.t), gap: null, newer: [], fromTop: w.t > 0, released, apart }
    return {
      older: seq.slice(w.t, w.a),
      gap: [
        ...seq.slice(w.a, w.cut).map((r) => r.id),
        ...(w.gap ?? []),
        ...seq.slice(w.cut, w.b).map((r) => r.id),
      ],
      newer: seq.slice(w.b),
      fromTop: w.t > 0,
      released,
      apart,
    }
  }
  return {
    comments: after<C>(walks[0]),
    history: ask.history ? after<E>(walks[1]) : null,
  }
}

/** The row a Show newer read asks before: the 50th released id while the
    gap holds at least a page of them, so the page holds the last row kept
    above the gap and joins in one read, else the first row kept below the
    gap (`below`), whose page reaches past every released id. */
export function newerAnchor(gap: readonly string[], below: string | undefined): string | undefined {
  return gap.length >= NEWER_PAGE ? gap[NEWER_PAGE - 1] : below
}

/** How the pages a Show newer read brought meet the run above the gap:
    `join` with the run and the gap after them (null once the gap closed)
    and the rows added; `short` when they reach no row of the run yet and
    do not start the thread, so the read goes on before their first row (or
    the history's `next`); or, for the history (`strict`), `restart` when
    they hold rows the store never had without reaching the run, which only
    a change in what the person may see makes, so the store starts the
    history over from the run below the gap rather than stitching across a
    gap it cannot prove. */
export type NewerJoin<R> =
  | { kind: 'join'; older: R[]; gap: string[] | null; added: R[] }
  | { kind: 'short' }
  | { kind: 'restart' }

/** Joins `page`, the rows read before `anchor` this press, oldest first,
    to the run `older` above gap `gap`. It joins when it holds any row of
    the run, after the newest such row, or when it starts the thread
    (`starts`) while holding none, which replaces the run. The run's rows
    after the newest one the page holds are gone, as deleted comments are
    (or, for the history, changes the person no longer receives). The gap
    keeps the ids from the anchor on, and closes when the anchor was the
    first row kept below it. */
export function joinNewer<R extends { id: string }>(
  older: readonly R[],
  gap: readonly string[],
  anchor: string,
  page: readonly R[],
  starts: boolean,
  strict: boolean,
): NewerJoin<R> {
  const at = new Map(page.map((r, i) => [r.id, i]))
  let held = -1
  for (let i = older.length - 1; i >= 0 && held === -1; i--) if (at.has(older[i].id)) held = i
  if (held === -1 && !starts) {
    const released = new Set(gap)
    return strict && page.some((r) => !released.has(r.id)) ? { kind: 'restart' } : { kind: 'short' }
  }
  const added = held === -1 ? [...page] : page.slice((at.get(older[held].id) ?? -1) + 1)
  const from = gap.indexOf(anchor)
  return {
    kind: 'join',
    older: [...older.slice(0, held + 1), ...added],
    gap: from === -1 ? null : gap.slice(from),
    added,
  }
}
