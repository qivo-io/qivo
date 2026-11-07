/* One section of a list of milestones that the server answers
   (convex/milestones.ts section): the Milestones window's Upcoming and
   Past (panels/Modals.tsx), and the Overview's and the phone Roadmap
   agenda's (views/useScopeMilestones.ts). This module is the pure part,
   the plan of a section's asks and what the section shows; the hook that
   registers the asks with the store and renders on its news is
   views/useMilestoneSection.ts.

   A section is one live read whose limit grows. Its sizes (SectionSizes)
   are an argument of the plan, read when it plans: the window's
   MILESTONE_SECTION, 25 rows a batch, and the Overview's and the agenda's
   OVERVIEW_MILESTONES, 10 for Upcoming and 25 for Past, each up to the
   server's cap of 100. It asks `batch` rows at first, and each Load more
   asks the same read with `batch` more rows under a slot of its own,
   while the slot that shows stays live; once the larger read answers it
   shows that one and the old slot goes. At `rows` rows a Load more moves
   the read on instead: it starts after the shown answer's row `batch`, so
   the first batch leaves and one more comes, and the section says which
   milestones are not shown, with Show from the start. A read that stopped
   at its budget (`stopped`) is a fail-safe path past the design size: its
   Load more continues from the answer's `next` with one batch, which also
   leaves the rows before it, under the same note. A new search, week or
   base starts again at the first batch under a slot of its own, and the
   slot that showed goes at once, so no rows of another search show. A base
   names top-level projects, or My view (`mine`), whose projects the
   server finds.

   Each answer counts only for the arguments it was asked with
   (store/planner.ts P.milestoneRead), and the rows are the store's, with
   the person's own writes painted over them, so a painted answer may hold
   more or fewer rows than its limit. The section shows them as they come:
   it never sorts, cuts or merges the server's rows.

   The module imports nothing from store/planner.ts. From the store it
   takes only structural types and positionOf (store/milestoneRows.ts), so
   it is tested on its own (lib/milestoneSection.test.ts). */

import { MILESTONE_READ_ROWS } from '../../convex/lib/limits'
import { type MilestoneAsk, type MilestonePosition, positionOf } from '../store/milestoneRows'

/** A section's first batch, which each Load more adds, and its row cap,
    past which a Load more moves the read on. */
export type SectionSizes = { batch: number; rows: number }

/** The Milestones window's sections' sizes. Tests and the perf page lower
    these and restore them. The cap is the server's (convex/lib/limits.ts
    MILESTONE_READ_ROWS). */
export const MILESTONE_SECTION: SectionSizes = { batch: 25, rows: MILESTONE_READ_ROWS }

/** The sizes of the Overview's and the phone agenda's sections: 10
    upcoming milestones at first and 10 more for each Load more, and a
    Past of 25 at a time, the owner's batches of 24 October 2026 (the
    window's decision leaves the Overview's 10 as they are), each up to the
    server's cap. Tests and the perf page lower these and restore them. */
export const OVERVIEW_MILESTONES: { upcoming: SectionSizes; past: SectionSizes } = {
  upcoming: { batch: 10, rows: MILESTONE_READ_ROWS },
  past: { batch: 25, rows: MILESTONE_READ_ROWS },
}

/** A section's ask, as the store registers it (store/milestoneRows.ts). */
export type SectionAsk = Extract<MilestoneAsk, { kind: 'section' }>

/** What a section reads: the top-level projects, or My view's (`mine`),
    which the server finds from the person's own tasks, the first day of
    the current week in the app's grid, and the side. */
export type SectionBase = {
  from: string
  side: 'upcoming' | 'past'
} & ({ projects: readonly string[]; mine?: undefined } | { mine: true; projects?: undefined })

/** One answer of a section as the store holds it (store/planner.ts
    MilestoneAnswer): the rows, each one's stored name and day, `next`,
    `stopped` and, on a first upcoming answer, `past`. */
export type SectionAnswer<R> = {
  rows: readonly R[]
  stored: ReadonlyMap<string, { name: string; week: string }>
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
}

/** What one slot of a section holds (store/planner.ts MilestoneRead). */
export type SectionRead<R> =
  | { state: 'loading' }
  | { state: 'too_many' }
  | { state: 'refused'; reason: string; sentence: string; kept: SectionAnswer<R> | null }
  | { state: 'failed'; kept: SectionAnswer<R> | null }
  | { state: 'ok'; current: boolean; answer: SectionAnswer<R> }

/** One slot's ask: the slot's number, where it starts and how many rows,
    and the attempt Retry raises. */
export type SlotPlan = {
  n: number
  after?: MilestonePosition
  limit: number
  attempt: number
}

/** A section's plan: the base and search it asks for (`base` is
    sectionKey's), the slot that shows, a Load more's slot on its way, and
    the last `past` the section showed (sectionView). */
export type SectionPlan = {
  base: string
  search: string
  shown: SlotPlan
  pending: SlotPlan | null
  past?: boolean
}

/** The projects a section ask of `base` names: its projects once each and
    sorted, or none for My view. */
const namedOf = (base: SectionBase): string[] =>
  base.mine ? [] : [...new Set(base.projects)].sort()

/** The key of `base`, its projects once each and sorted, and `mine` for
    My view, so My view's base and an empty named one never share a plan;
    or null for none. */
export function sectionKey(base: SectionBase | null): string | null {
  if (base === null) return null
  return JSON.stringify([namedOf(base), base.from, base.side, ...(base.mine ? [true] : [])])
}

/** The store's slot of a section's ask number `n` under `prefix`. */
export const sectionSlot = (prefix: string, n: number) => `${prefix}:${n}`

/** The ask of slot `slot` of a section of `base` with `search`. */
export function sectionAsk(base: SectionBase, search: string, slot: SlotPlan): SectionAsk {
  return {
    kind: 'section',
    projects: namedOf(base),
    ...(base.mine ? { mine: true as const } : {}),
    from: base.from,
    side: base.side,
    ...(search ? { search } : {}),
    ...(slot.after ? { after: slot.after } : {}),
    limit: slot.limit,
  }
}

/** A plan that asks the first batch of `sizes` of the section `base` (its
    key) with `search` under number `n`, keeping `past` when the base is
    the same. */
export function startPlan(
  base: string,
  search: string,
  n: number,
  sizes: SectionSizes,
  past?: boolean,
): SectionPlan {
  return {
    base,
    search,
    shown: { n, limit: sizes.batch, attempt: 0 },
    pending: null,
    ...(past === undefined ? {} : { past }),
  }
}

/** The plan after Load more over `answer`, the shown slot's answer, with
    the next ask under number `n`, or `plan` itself when nothing follows or
    a Load more is on its way. Below the cap of `sizes` it grows the limit
    by a batch; at the cap it moves on after the answer's row `batch` with
    the same limit; after a read that stopped it continues from `next`
    with one batch (the fail-safe path). */
export function morePlan<R extends { id: string }>(
  plan: SectionPlan,
  answer: SectionAnswer<R>,
  n: number,
  sizes: SectionSizes,
): SectionPlan {
  if (plan.pending !== null || answer.next === null) return plan
  const { batch, rows } = sizes
  const { shown } = plan
  let next: SlotPlan
  if (answer.stopped !== null) next = { n, after: answer.next, limit: batch, attempt: 0 }
  else if (shown.limit < rows)
    next = {
      n,
      ...(shown.after ? { after: shown.after } : {}),
      limit: Math.min(shown.limit + batch, rows),
      attempt: 0,
    }
  else {
    // the row the first batch ends on, as stored; a painted answer shorter
    // than a batch moves on from its last row, an empty one from `next`
    const row = answer.rows[Math.min(batch, answer.rows.length) - 1]
    const stored = row && answer.stored.get(row.id)
    const after = row && stored ? positionOf({ ...stored, id: row.id }) : answer.next
    next = { n, after, limit: shown.limit, attempt: 0 }
  }
  return { ...plan, pending: next }
}

/** The plan after Show from the start: the first batch of `sizes`
    afresh, under number `n`. */
export function fromStartPlan(plan: SectionPlan, n: number, sizes: SectionSizes): SectionPlan {
  return startPlan(plan.base, plan.search, n, sizes, plan.past)
}

/** The plan after Retry: a new attempt for each slot whose read failed or
    was refused. */
export function retryPlan(plan: SectionPlan, shown: boolean, pending: boolean): SectionPlan {
  const again = (slot: SlotPlan) => ({ ...slot, attempt: slot.attempt + 1 })
  return {
    ...plan,
    shown: shown ? again(plan.shown) : plan.shown,
    pending: pending && plan.pending ? again(plan.pending) : plan.pending,
  }
}

/** The plan once the Load more's read answered: its slot shows, and the
    one it replaced goes. */
export function swapPlan(plan: SectionPlan): SectionPlan {
  return plan.pending === null ? plan : { ...plan, shown: plan.pending, pending: null }
}

/** What a section says beside its rows: the latest read failed or was
    refused (`more` when it was a Load more's), or the store asked nothing
    for more projects than one read names. */
export type SectionNote =
  | { kind: 'failed'; more: boolean }
  | { kind: 'refused'; more: boolean; sentence: string; reason: string }
  | { kind: 'too_many' }

/** What a section shows (sectionView):
    - `state`, for data-milestone-section-state: `loading` before any
      answer, `ok`, `refreshing` while the answer shown is kept,
      `failed` or `refused` when the latest read failed or was refused,
      rows kept, and `too_many`;
    - `rows` in the server's order, painted, each id once;
    - `next` and `stopped` of the answer shown;
    - `past`, whether the projects hold a past milestone, from the answer
      shown, else true if a first upcoming answer said so, else unknown,
      and while the next read loads the last value;
    - `whole`, an answer with no `next`, no `stopped` and no `after`;
    - `dropped`, a section moved on, whose first rows are not shown;
    - `more`, Load more ready, or loading while its read is on its way;
    - `note`, a failure, a refusal or too_many, with `retry` naming the
      reads Retry asks again;
    - `empty` and `count`, the empty line and the header's count, only for
      a whole answer. */
export type SectionView<R> = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed' | 'refused' | 'too_many'
  rows: readonly R[]
  answered: boolean
  next: MilestonePosition | null
  stopped: string | null
  past: boolean | undefined
  whole: boolean
  dropped: boolean
  more: 'ready' | 'loading' | null
  note: SectionNote | null
  retry: { shown: boolean; pending: boolean } | null
  empty: boolean
  count: number | null
}

/** The answer a read shows: its current or kept answer, also beside a
    failure or refusal, or null. */
export function answerOf<R>(read: SectionRead<R> | null): SectionAnswer<R> | null {
  if (!read) return null
  if (read.state === 'ok') return read.answer
  return read.state === 'failed' || read.state === 'refused' ? read.kept : null
}

/** What the section of `plan` shows, from its shown slot's read and its
    Load more's (`pending`), if one is on its way. */
export function sectionView<R extends { id: string }>(
  plan: SectionPlan,
  shown: SectionRead<R>,
  pending: SectionRead<R> | null,
): SectionView<R> {
  const answer = answerOf(shown)
  const seen = new Set<string>()
  const rows = (answer?.rows ?? []).filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  // A first upcoming answer says whether the projects hold a past
  // milestone. Once the answer shown carries no `past`, as one that moved
  // on, the read that said false is released and hears no change, so only
  // a true one is kept and false becomes unknown. While the next read
  // loads, the last value stands until its answer.
  const kept = plan.past === true ? true : undefined
  const past = answer ? (answer.past ?? kept) : shown.state === 'loading' ? plan.past : kept
  const dropped = plan.shown.after !== undefined
  const whole = !!answer && answer.next === null && answer.stopped === null && !dropped
  const base = {
    rows,
    answered: !!answer,
    next: answer?.next ?? null,
    stopped: answer?.stopped ?? null,
    past,
    whole,
    dropped,
  }
  const failing = (read: SectionRead<R>, more: boolean): SectionNote | null =>
    read.state === 'failed'
      ? { kind: 'failed', more }
      : read.state === 'refused'
        ? { kind: 'refused', more, sentence: read.sentence, reason: read.reason }
        : null
  // the shown read's own failure first, else a Load more's
  const note =
    shown.state === 'too_many'
      ? ({ kind: 'too_many' } as const)
      : (failing(shown, false) ?? (pending ? failing(pending, true) : null))
  if (note) {
    // a refusal says why and offers no Retry, as the server would refuse again
    const retry =
      note.kind === 'failed'
        ? { shown: !note.more, pending: note.more || pending?.state === 'failed' }
        : null
    return {
      ...base,
      state: note.kind === 'too_many' ? 'too_many' : note.kind,
      more: null,
      note,
      retry,
      empty: false,
      count: null,
    }
  }
  if (shown.state !== 'ok')
    return {
      ...base,
      state: 'loading',
      more: null,
      note: null,
      retry: null,
      empty: false,
      count: null,
    }
  return {
    ...base,
    state: shown.current ? 'ok' : 'refreshing',
    more: pending ? 'loading' : shown.answer.next !== null ? 'ready' : null,
    note: null,
    retry: null,
    empty: whole && rows.length === 0,
    count: whole ? rows.length : null,
  }
}
