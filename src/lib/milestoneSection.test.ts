/* One section of milestones the server answers (lib/milestoneSection.ts):
 * the plan of its asks, from the first batch through Load more, the move
 * on at the cap, a continuation after a read that stopped, Show from the
 * start and Retry, and what the section shows from its reads. */

import { afterEach, describe, expect, it } from 'vitest'
import { positionOf } from '../store/milestoneRows'
import {
  answerOf,
  fromStartPlan,
  MILESTONE_SECTION,
  morePlan,
  retryPlan,
  type SectionAnswer,
  type SectionBase,
  type SectionPlan,
  type SectionRead,
  sectionAsk,
  sectionKey,
  sectionView,
  startPlan,
  swapPlan,
} from './milestoneSection'

const SECTION = structuredClone(MILESTONE_SECTION)
afterEach(() => {
  Object.assign(MILESTONE_SECTION, structuredClone(SECTION))
})

type Row = { id: string; name: string }

const BASE: SectionBase = { projects: ['plan'], from: '2026-11-02', side: 'upcoming' }
const KEY = sectionKey(BASE) ?? ''

/** `count` rows named Step n, from Step `from` on. */
function rowsOf(count: number, from = 1): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${from + i}`, name: `Step ${from + i}` }))
}

/** An answer of `rows`, each stored on its own Monday from 2026-11-02 on,
    in the order given, with `next` at the last row unless `whole`. */
function answerWith(
  rows: Row[],
  o: { whole?: boolean; stopped?: string; past?: boolean } = {},
): SectionAnswer<Row> {
  const stored = new Map(
    rows.map((row, i) => [
      row.id,
      { name: row.name, week: new Date(Date.UTC(2026, 10, 2 + 7 * i)).toISOString().slice(0, 10) },
    ]),
  )
  const last = rows.at(-1)
  const lastStored = last && stored.get(last.id)
  return {
    rows,
    stored,
    next:
      o.whole || !last || !lastStored
        ? o.stopped
          ? { week: o.stopped, key: '', id: '' }
          : null
        : positionOf({ ...lastStored, id: last.id }),
    stopped: o.stopped ?? null,
    ...(o.past === undefined ? {} : { past: o.past }),
  }
}

const ok = (answer: SectionAnswer<Row>, current = true): SectionRead<Row> => ({
  state: 'ok',
  current,
  answer,
})

describe('the plan of a section', () => {
  it('asks the first batch, then grows the limit by a batch for each Load more', () => {
    const plan = startPlan(KEY, '', 1)
    expect(sectionAsk(BASE, plan.search, plan.shown)).toEqual({
      kind: 'section',
      projects: ['plan'],
      from: '2026-11-02',
      side: 'upcoming',
      limit: 25,
    })
    const grown = morePlan(plan, answerWith(rowsOf(25)), 2)
    expect(grown.shown).toBe(plan.shown)
    expect(grown.pending).toEqual({ n: 2, limit: 50, attempt: 0 })
    // a Load more on its way asks nothing more
    expect(morePlan(grown, answerWith(rowsOf(25)), 3)).toBe(grown)
    const shown = swapPlan(grown)
    expect(shown).toMatchObject({ shown: { n: 2, limit: 50 }, pending: null })
  })

  it('moves on at the cap: after the row a batch ends on, with the same limit', () => {
    MILESTONE_SECTION.batch = 2
    MILESTONE_SECTION.rows = 4
    let plan = startPlan(KEY, '', 1)
    plan = swapPlan(morePlan(plan, answerWith(rowsOf(2)), 2))
    expect(plan.shown).toMatchObject({ limit: 4 })
    expect(plan.shown.after).toBeUndefined()
    const answer = answerWith(rowsOf(4))
    const moved = morePlan(plan, answer, 3)
    const second = answer.stored.get('m2')
    if (!second) throw new Error('no stored m2')
    expect(moved.pending).toEqual({
      n: 3,
      after: positionOf({ ...second, id: 'm2' }),
      limit: 4,
      attempt: 0,
    })
    // must fail: a Load more past the cap that keeps growing
    expect(moved.pending?.limit).not.toBeGreaterThan(MILESTONE_SECTION.rows)
    // moved on again, it starts after the row a batch ends on in its own answer
    const again = morePlan(swapPlan(moved), answerWith(rowsOf(4, 3)), 4)
    expect(again.pending?.after?.id).toBe('m4')
  })

  it.each([
    ['shorter than a batch', 1, 'm1'],
    ['with no row', 0, null],
  ] as const)(
    'moves on at the cap from a painted answer %s, never past the rows it shows',
    (_, count, from) => {
      MILESTONE_SECTION.batch = 2
      MILESTONE_SECTION.rows = 4
      const plan = swapPlan(morePlan(startPlan(KEY, '', 1), answerWith(rowsOf(2)), 2))
      expect(plan.shown.limit).toBe(4)
      // the server's answer held four, and the person's own writes took the
      // rest out of it, so its next is past every row it shows
      const full = answerWith(rowsOf(4))
      const painted = { ...full, rows: full.rows.slice(0, count) }
      const stored = from === null ? undefined : full.stored.get(from)
      const after = from === null || !stored ? full.next : positionOf({ ...stored, id: from })
      expect(morePlan(plan, painted, 3).pending).toEqual({ n: 3, after, limit: 4, attempt: 0 })
    },
  )

  it('continues from `next` with one batch after a read that stopped, then grows from there', () => {
    const plan = startPlan(KEY, '', 1)
    const stopped = answerWith(rowsOf(3), { whole: true, stopped: '2026-12-07' })
    const next = morePlan(plan, stopped, 2)
    expect(next.pending).toEqual({ n: 2, after: stopped.next, limit: 25, attempt: 0 })
    // the continuation answers a full batch, and the next Load more grows it
    // where it starts
    const again = morePlan(swapPlan(next), answerWith(rowsOf(25, 4)), 3)
    expect(again.pending).toEqual({ n: 3, after: stopped.next, limit: 50, attempt: 0 })
  })

  it('offers nothing to load past an answer with no next', () => {
    const plan = startPlan(KEY, '', 1)
    expect(morePlan(plan, answerWith(rowsOf(3), { whole: true }), 2)).toBe(plan)
  })

  it('starts again at the first batch from the start, keeping the last past', () => {
    let plan: SectionPlan = { ...startPlan(KEY, 'gate', 1), past: true }
    plan = swapPlan(morePlan(plan, answerWith(rowsOf(25)), 2))
    const fresh = fromStartPlan(plan, 3)
    expect(fresh).toEqual({
      base: KEY,
      search: 'gate',
      shown: { n: 3, limit: 25, attempt: 0 },
      pending: null,
      past: true,
    })
  })

  it('keys a base by its projects once each and sorted, and by week and side', () => {
    expect(sectionKey({ ...BASE, projects: ['b', 'a', 'b'] })).toBe(
      sectionKey({ ...BASE, projects: ['a', 'b'] }),
    )
    expect(sectionKey({ ...BASE, from: '2026-11-09' })).not.toBe(KEY)
    expect(sectionKey({ ...BASE, side: 'past' })).not.toBe(KEY)
    expect(sectionKey(null)).toBeNull()
    expect(sectionAsk(BASE, 'gate', { n: 1, limit: 25, attempt: 0 }).search).toBe('gate')
  })

  it('raises the attempt of the slots whose reads failed', () => {
    const plan = morePlan(startPlan(KEY, '', 1), answerWith(rowsOf(25)), 2)
    const retried = retryPlan(plan, false, true)
    expect(retried.shown.attempt).toBe(0)
    expect(retried.pending?.attempt).toBe(1)
    expect(retryPlan(plan, true, false).shown.attempt).toBe(1)
  })
})

describe('what a section shows', () => {
  it('shows the old answer, live, while a Load more loads, and nothing of the new one until ok', () => {
    const plan = morePlan(startPlan(KEY, '', 1), answerWith(rowsOf(25)), 2)
    const view = sectionView(plan, ok(answerWith(rowsOf(25))), { state: 'loading' })
    expect(view.rows.map((r) => r.id)).toEqual(rowsOf(25).map((r) => r.id))
    expect(view).toMatchObject({ state: 'ok', more: 'loading', note: null })
  })

  it.each([
    ['failed', { state: 'failed', kept: null }],
    ['refused', { state: 'refused', reason: 'r', sentence: 'Too large.', kept: null }],
  ] as const)(
    'keeps the rows before a Load more that %s, with its note and Retry in place of Load more',
    (state, pending) => {
      const plan = morePlan(startPlan(KEY, '', 1), answerWith(rowsOf(25)), 2)
      const view = sectionView(plan, ok(answerWith(rowsOf(25))), pending)
      expect(view.rows).toHaveLength(25)
      expect(view.state).toBe(state)
      expect(view.note).toMatchObject({ kind: state, more: true })
      expect(view.more).toBeNull()
      // a refusal offers no Retry, as the server would refuse again
      expect(view.retry).toEqual(state === 'failed' ? { shown: false, pending: true } : null)
    },
  )

  it('says whole, counts and offers the empty line only for an answer with nothing after it', () => {
    const plan = startPlan(KEY, '', 1)
    const whole = sectionView(plan, ok(answerWith(rowsOf(3), { whole: true, past: false })), null)
    expect(whole).toMatchObject({ whole: true, count: 3, empty: false, more: null, past: false })
    const empty = sectionView(plan, ok(answerWith([], { whole: true })), null)
    expect(empty).toMatchObject({ whole: true, count: 0, empty: true })
    const partial = sectionView(plan, ok(answerWith(rowsOf(25))), null)
    expect(partial).toMatchObject({ whole: false, count: null, empty: false, more: 'ready' })
  })

  it('must fail: an empty line or a count for a stopped answer with no rows', () => {
    const plan = startPlan(KEY, '', 1)
    const view = sectionView(plan, ok(answerWith([], { whole: true, stopped: '2026-12-07' })), null)
    expect(view.stopped).toBe('2026-12-07')
    expect(view.empty).toBe(false)
    expect(view.count).toBeNull()
    expect(view.more).toBe('ready')
  })

  it('must fail: an empty line for a read that failed before any answer', () => {
    const view = sectionView(startPlan(KEY, '', 1), { state: 'failed', kept: null }, null)
    expect(view).toMatchObject({ state: 'failed', empty: false, count: null, answered: false })
    expect(view.note).toEqual({ kind: 'failed', more: false })
    expect(view.retry).toEqual({ shown: true, pending: false })
  })

  it('keeps the rows of a failure or refusal after an answer, marked as the latest read', () => {
    const kept = answerWith(rowsOf(4), { whole: true })
    const failed = sectionView(startPlan(KEY, '', 1), { state: 'failed', kept }, null)
    expect(failed).toMatchObject({ state: 'failed', answered: true, empty: false, count: null })
    expect(failed.rows).toHaveLength(4)
    const refused = sectionView(
      startPlan(KEY, '', 1),
      { state: 'refused', reason: 'r', sentence: 'Too large.', kept },
      null,
    )
    expect(refused.note).toEqual({ kind: 'refused', more: false, sentence: 'Too large.' })
    expect(refused.rows).toHaveLength(4)
  })

  it('is refreshing while the answer shown is kept, and loading before any', () => {
    const plan = startPlan(KEY, '', 1)
    expect(sectionView(plan, ok(answerWith(rowsOf(2)), false), null).state).toBe('refreshing')
    expect(sectionView(plan, { state: 'loading' }, null)).toMatchObject({
      state: 'loading',
      rows: [],
      empty: false,
      more: null,
    })
    expect(sectionView(plan, { state: 'too_many' }, null)).toMatchObject({
      state: 'too_many',
      note: { kind: 'too_many' },
      retry: null,
    })
  })

  it('says moved on once the plan starts after a row, and is never whole then', () => {
    MILESTONE_SECTION.batch = 2
    MILESTONE_SECTION.rows = 4
    let plan = swapPlan(morePlan(startPlan(KEY, '', 1), answerWith(rowsOf(2)), 2))
    plan = swapPlan(morePlan(plan, answerWith(rowsOf(4)), 3))
    const view = sectionView(plan, ok(answerWith(rowsOf(3, 3), { whole: true })), null)
    expect(view).toMatchObject({ dropped: true, whole: false, count: null, empty: false })
  })

  it('keeps the last past a first upcoming answer gave once an answer has none', () => {
    const plan: SectionPlan = { ...startPlan(KEY, '', 1), past: true }
    expect(sectionView(plan, ok(answerWith(rowsOf(2))), null).past).toBe(true)
    expect(sectionView(plan, ok(answerWith(rowsOf(2), { past: false })), null).past).toBe(false)
  })

  it('forgets a false past once the answer shown has none, and keeps it while the next read loads', () => {
    const plan: SectionPlan = { ...startPlan(KEY, '', 1), past: false }
    // a moved-on answer carries no past, and the read that said false is released
    expect(sectionView(plan, ok(answerWith(rowsOf(2))), null).past).toBeUndefined()
    expect(sectionView(plan, { state: 'failed', kept: null }, null).past).toBeUndefined()
    expect(sectionView(plan, { state: 'loading' }, null).past).toBe(false)
  })

  it('shows a painted answer longer or shorter than its limit as painted, each id once', () => {
    const plan = startPlan(KEY, '', 1)
    const longer = answerWith(rowsOf(26))
    expect(sectionView(plan, ok(longer), null).rows).toHaveLength(26)
    const shorter = answerWith(rowsOf(20))
    expect(sectionView(plan, ok(shorter), null).rows).toHaveLength(20)
    const twice = { ...shorter, rows: [...shorter.rows, shorter.rows[0]] }
    expect(sectionView(plan, ok(twice), null).rows).toHaveLength(20)
    expect(answerOf(ok(shorter))).toBe(shorter)
    expect(answerOf({ state: 'loading' })).toBeNull()
  })
})
