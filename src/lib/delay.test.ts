import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TODAY_WEEK } from './dates'
import { computeDelayMap, type DelayIssue, delayOf } from './delay'
import type { LoadSpan } from './workload'

const T = TODAY_WEEK

const iss = (o: Partial<DelayIssue>): DelayIssue => ({
  uuid: 'self',
  status: 'progress',
  owner: 'u1',
  start: null,
  end: null,
  dueWeek: null,
  duePast: false,
  remaining: undefined,
  capacity: 34,
  ...o,
})
const span = (o: Partial<LoadSpan>): LoadSpan => ({
  issueUuid: 'other',
  start: T,
  end: T,
  remaining: 0,
  ...o,
})

describe('delayOf — projection with owner + remaining', () => {
  it('is ok when the projected finish lands inside the plan and before due', () => {
    // 34h free/wk, 60h → finishes T+1; plan runs to T+2, due later still
    const d = delayOf(iss({ start: T, end: T + 2, dueWeek: T + 4, remaining: 60 }), [])
    expect(d).toEqual({ status: 'ok', fin: T + 1 })
  })
  it('goes behind when other commitments push the finish past the planned end', () => {
    // 24h/wk committed elsewhere → 10h free/wk; 60h needs 6 weeks, plan allows 2
    const load = [span({ start: T, end: T + 9, remaining: 240 })]
    const d = delayOf(iss({ start: T, end: T + 1, dueWeek: T + 9, remaining: 60 }), load)
    expect(d).toEqual({ status: 'behind', fin: T + 5 })
  })
  it('goes late when the projection also misses the due week', () => {
    const load = [span({ start: T, end: T + 9, remaining: 240 })]
    const d = delayOf(iss({ start: T, end: T + 1, dueWeek: T + 3, remaining: 60 }), load)
    expect(d).toEqual({ status: 'late', fin: T + 5 })
  })
  it('a slipped competitor with a fresh estimate re-anchors to its measurement week', () => {
    // 68h planned wholly in the past, but measured NOW: still to do, so it
    // saturates week T, pushing the subject's 68h past its T+1 due week.
    const load = [
      span({ issueUuid: 'A', start: T - 3, end: T - 1, remaining: 68, remainingSet: T }),
    ]
    const d = delayOf(iss({ uuid: 'B', start: T, end: T + 1, dueWeek: T + 1, remaining: 68 }), load)
    expect(d).toEqual({ status: 'late', fin: T + 2 })
  })
  it('a slipped competitor whose estimate predates its window is assumed done', () => {
    // same 68h, but measured back when the window began: the work is assumed
    // to have happened in T-3..T-1, so it no longer eats the subject's weeks.
    const load = [
      span({ issueUuid: 'A', start: T - 3, end: T - 1, remaining: 68, remainingSet: T - 3 }),
    ]
    const d = delayOf(iss({ uuid: 'B', start: T, end: T + 1, dueWeek: T + 1, remaining: 68 }), load)
    expect(d).toEqual({ status: 'ok', fin: T + 1 })
  })
  it('excludes the issue itself from its owner load', () => {
    // the only load row IS the issue → free capacity, finishes in week T
    const load = [span({ issueUuid: 'self', start: T, end: T + 9, remaining: 340 })]
    const d = delayOf(iss({ start: T, end: T, dueWeek: T + 1, remaining: 30 }), load)
    expect(d).toEqual({ status: 'ok', fin: T })
  })
  it('projects from today when the planned start is past and no measurement week is known', () => {
    // plan was T-4..T-3 but the work is not done: 40h from today at 34h/wk → T+1 > end → behind
    const d = delayOf(iss({ start: T - 4, end: T - 3, remaining: 40 }), [])
    expect(d).toEqual({ status: 'behind', fin: T + 1 })
  })
  it('projects from the measurement week, assuming progress since the estimate', () => {
    // 100h measured at the T-4 start: 34h/wk covers it by T-2. Anchoring at
    // today instead would read 100h still ahead → T+2 > end → falsely behind.
    const d = delayOf(iss({ start: T - 4, end: T + 1, remaining: 100, remainingSet: T - 4 }), [])
    expect(d).toEqual({ status: 'ok', fin: T })
  })
  it('floors the projected finish at today — an open issue past its end is behind, not green', () => {
    // measured T-5, fits by T-5, but the issue is still open at T with its
    // planned end at T-4: the finish can't be in the past.
    const d = delayOf(iss({ start: T - 6, end: T - 4, remaining: 10, remainingSet: T - 5 }), [])
    expect(d).toEqual({ status: 'behind', fin: T })
  })
  it('projects from the planned start when it is still ahead', () => {
    // the measurement week is always ≤ now, so a future start wins the max —
    // the hours spread over the whole planned interval
    const d = delayOf(
      iss({ start: T + 3, end: T + 4, dueWeek: T + 8, remaining: 30, remainingSet: T - 1 }),
      [],
    )
    expect(d).toEqual({ status: 'ok', fin: T + 3 })
  })
  // a stored 0 is an ANSWER ("nothing left to do"), not a missing one: it
  // projects a finish of now, instead of falling back to a planned end the
  // work no longer needs
  it('projects zero remaining hours as finishing now, not as no basis', () => {
    // plan runs to T+4 but the due week is T+2: the planned-end fallback
    // would read T+4 > T+2 and badge finished work "Delayed"
    const d = delayOf(iss({ start: T, end: T + 4, dueWeek: T + 2, remaining: 0 }), [])
    expect(d).toEqual({ status: 'ok', fin: T })
  })
  it('gives an unscheduled zero-remaining issue an on-track verdict', () => {
    // no planned end at all: the fallback left fin null and returned nothing
    const d = delayOf(iss({ dueWeek: T + 2, remaining: 0 }), [])
    expect(d).toEqual({ status: 'ok', fin: T })
  })
  it('still reports a passed due date as late with zero remaining', () => {
    const d = delayOf(iss({ end: T + 1, dueWeek: T - 1, duePast: true, remaining: 0 }), [])
    expect(d!.status).toBe('late')
  })
  it('keeps unset remaining on the planned-end fallback', () => {
    // undefined is a MISSING answer — the plan is all we have to go on
    const d = delayOf(iss({ start: T, end: T + 4, dueWeek: T + 2, remaining: undefined }), [])
    expect(d).toEqual({ status: 'late', fin: T + 4 })
  })
  it('an unscheduled issue can still be late against its due date', () => {
    const load = [span({ start: T, end: T + 9, remaining: 340 })] // saturated
    const d = delayOf(iss({ dueWeek: T + 2, remaining: 10 }), load)
    expect(d!.status).toBe('late')
  })
  it('finishing exactly in the due week is not late', () => {
    const d = delayOf(iss({ dueWeek: T, remaining: 30 }), [])
    expect(d).toEqual({ status: 'ok', fin: T })
  })
})

describe('delayOf — fallback without a projection basis', () => {
  it('uses the planned end as the estimate (no owner)', () => {
    const d = delayOf(iss({ owner: null, start: T, end: T + 2, dueWeek: T + 1, remaining: 60 }), [])
    expect(d).toEqual({ status: 'late', fin: T + 2 }) // planned to end after due
  })
  it('uses the planned end as the estimate (no remaining)', () => {
    const d = delayOf(iss({ start: T, end: T + 1, dueWeek: T + 3 }), [])
    expect(d).toEqual({ status: 'ok', fin: T + 1 })
  })
  it('a passed planned end pushes the estimate to today → behind', () => {
    const d = delayOf(iss({ start: T - 5, end: T - 2 }), [])
    expect(d).toEqual({ status: 'behind', fin: T })
  })
  it('zero capacity falls back to the plan instead of projecting', () => {
    const d = delayOf(iss({ start: T, end: T + 1, capacity: 0, remaining: 999 }), [])
    expect(d).toEqual({ status: 'ok', fin: T + 1 })
  })
})

describe('delayOf — due date and terminal states', () => {
  it('a due date in the past is late outright (the old overdue)', () => {
    const d = delayOf(iss({ dueWeek: T, duePast: true }), [])
    expect(d).toEqual({ status: 'late', fin: null })
  })
  it('done issues have no status, even overdue ones', () => {
    expect(delayOf(iss({ status: 'done', duePast: true, dueWeek: T - 2 }), [])).toBeNull()
  })
  it('no plan and no due date → no status', () => {
    expect(delayOf(iss({ remaining: 40 }), [])).toBeNull()
    expect(delayOf(iss({ owner: null }), [])).toBeNull()
  })
})

describe('computeDelayMap', () => {
  it('matches individual projections for randomized owners, states and hidden load', () => {
    const week = fc.option(fc.integer({ min: T - 10, max: T + 30 }), { nil: null })
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom('backlog', 'progress', 'review', 'done'),
            owner: fc.constantFrom('assignee', 'reviewer', 'agent', null),
            start: week,
            end: week,
            dueWeek: week,
            duePast: fc.boolean(),
            isGroup: fc.boolean(),
            isDone: fc.option(fc.boolean(), { nil: undefined }),
            remaining: fc.option(
              fc.integer({ min: 0, max: 10000 }).map((hours) => hours / 10),
              { nil: undefined },
            ),
            remainingSet: week,
            capacity: fc.constantFrom(0, 16, 32, 37.5, Infinity),
          }),
          { minLength: 1, maxLength: 80 },
        ),
        (tasks) => {
          const issues = tasks.map((task, index) => ({ ...task, uuid: `task-${index}` }))
          const load = new Map<string, LoadSpan[]>()
          for (const task of issues) {
            if (
              !task.owner ||
              task.start === null ||
              task.end === null ||
              task.isGroup ||
              task.status === 'done'
            )
              continue
            const spans = load.get(task.owner) || []
            spans.push({
              issueUuid: task.uuid,
              start: task.start,
              end: task.end,
              remaining: task.remaining ?? 0,
              remainingSet: task.remainingSet,
            })
            load.set(task.owner, spans)
          }
          for (const owner of ['assignee', 'reviewer', 'agent']) {
            const spans = load.get(owner) || []
            spans.push({ issueUuid: null, start: T - 5, end: T + 20, remaining: 101 })
            load.set(owner, spans)
          }
          const baseline = new Map(
            issues.flatMap((task) => {
              const info = delayOf(task, load.get(task.owner) || [])
              return info ? [[task.uuid, info] as const] : []
            }),
          )
          expect(computeDelayMap(issues, load)).toEqual(baseline)
        },
      ),
      { seed: 20261001, numRuns: 250 },
    )
  })

  it('groups by owner and skips issues without a status', () => {
    const load = new Map<string, LoadSpan[]>([
      ['u1', [span({ start: T, end: T + 9, remaining: 240 })]], // 24h/wk committed
    ])
    const m = computeDelayMap(
      [
        iss({ uuid: 'a', start: T, end: T + 1, dueWeek: T + 9, remaining: 60 }), // behind for u1
        iss({ uuid: 'b', owner: 'u2', start: T, end: T + 1, remaining: 60 }), // free u2 → ok
        iss({ uuid: 'c', status: 'done', end: T }),
        iss({ uuid: 'd' }), // nothing to measure
      ],
      load,
    )
    expect(m.get('a')!.status).toBe('behind')
    expect(m.get('b')!.status).toBe('ok')
    expect(m.has('c')).toBe(false)
    expect(m.has('d')).toBe(false)
  })
  it("walks each issue against its own owner's load, not anyone else's", () => {
    // u1 has 10h free a week; the same issue owned by u2 (say, its reviewer) has 34h
    const load = new Map<string, LoadSpan[]>([
      ['u1', [span({ start: T, end: T + 9, remaining: 240 })]],
    ])
    const subject = { start: T, end: T + 1, dueWeek: T + 9, remaining: 30 }
    const m = computeDelayMap(
      [iss({ uuid: 'mine', ...subject }), iss({ uuid: 'theirs', owner: 'u2', ...subject })],
      load,
    )
    expect(m.get('mine')).toEqual({ status: 'behind', fin: T + 2 })
    expect(m.get('theirs')).toEqual({ status: 'ok', fin: T })
  })
})

describe('delayOf — task groups', () => {
  it('keeps an unfinished group accountable to its dates despite a saved Done status', () => {
    const group = iss({
      status: 'done',
      isGroup: true,
      isDone: false,
      start: T - 2,
      end: T - 1,
    })
    expect(delayOf(group, [])).toEqual({ status: 'behind', fin: T })
    expect(delayOf({ ...group, duePast: true, dueWeek: T - 1 }, [])).toEqual({
      status: 'late',
      fin: T,
    })
  })

  it('uses the group date envelope instead of its own hours and assignee capacity', () => {
    const group = iss({ isGroup: true, start: T, end: T + 2, remaining: 999 })
    const load = [span({ start: T, end: T + 9, remaining: 340 })]
    expect(delayOf(group, load)).toEqual({ status: 'ok', fin: T + 2 })
    expect(delayOf({ ...group, remaining: 0 }, load)).toEqual({ status: 'ok', fin: T + 2 })
  })

  it('has no delay once descendant work is complete, regardless of its saved status', () => {
    expect(
      delayOf(iss({ isGroup: true, isDone: true, status: 'backlog', duePast: true }), []),
    ).toBeNull()
  })

  it('resumes the saved task status and own projection after its last child leaves', () => {
    const issue = iss({ status: 'done', isGroup: true, start: T - 2, end: T - 1 })
    expect(delayOf(issue, [])?.status).toBe('behind')
    expect(delayOf({ ...issue, isGroup: false }, [])).toBeNull()
    expect(delayOf({ ...issue, isGroup: false, status: 'progress', remaining: 68 }, [])).toEqual({
      status: 'behind',
      fin: T + 1,
    })
  })
})
