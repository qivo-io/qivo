import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  committedByWeek,
  DEFAULT_PLANNABLE_HOURS,
  fitEndWeek,
  fmtHours,
  hasPlannableWeek,
  issueLoadByPerson,
  type LoadIssue,
  type LoadItem,
  loadByProject,
  loadTone,
  pausedWeeksByPerson,
  plannableHoursOf,
  prepareLoadProjection,
  spreadWindow,
} from './workload'

const item = (o: Partial<LoadItem>): LoadItem => ({
  issueUuid: 'x',
  projectId: 'p',
  projectName: 'P',
  start: 0,
  end: 0,
  remaining: 0,
  visible: true,
  ...o,
})

describe('plannableHoursOf', () => {
  it('reads the person’s own setting', () => {
    expect(plannableHoursOf({ plannableHours: 20 })).toBe(20)
    expect(plannableHoursOf({ plannableHours: 37.5 })).toBe(37.5)
  })
  it('falls back for someone the client has no row for', () => {
    // every planning surface resolves capacity through the issue's ASSIGNEE
    // (0092), and an issue may have none — or one outside the snapshot
    expect(plannableHoursOf(null)).toBe(DEFAULT_PLANNABLE_HOURS)
    expect(plannableHoursOf(undefined)).toBe(DEFAULT_PLANNABLE_HOURS)
    expect(plannableHoursOf({})).toBe(DEFAULT_PLANNABLE_HOURS)
  })
  it('never yields a zero denominator', () => {
    // 0 can't come from the DB (check > 0) but would silently make every
    // load percentage Infinity and stall fitEndWeek at its 520-week bound
    expect(plannableHoursOf({ plannableHours: 0 })).toBe(DEFAULT_PLANNABLE_HOURS)
    expect(plannableHoursOf({ plannableHours: null })).toBe(DEFAULT_PLANNABLE_HOURS)
  })
  it('matches the default NEW members inherit, so a missing row plans like a present one', () => {
    // profiles.plannable_hours has no column default of its own — it is
    // trigger-filled from organizations.default_plannable_hours, whose
    // default this constant has to equal (0092)
    expect(DEFAULT_PLANNABLE_HOURS).toBe(32)
  })
  it('gives an agent an unbounded week rather than the fallback', () => {
    // 0103: an agent's column is NULL, and NULL on a PERSON means "no row
    // loaded" — the same absent value with two different answers, which is
    // why the kind has to decide and not the value
    expect(plannableHoursOf({ kind: 'agent', plannableHours: null })).toBe(Infinity)
    expect(plannableHoursOf({ isAgent: true, plannableHours: null })).toBe(Infinity)
    // and it wins over a stale number, so a row loaded before the migration
    // does not plan an agent as a part-timer
    expect(plannableHoursOf({ kind: 'agent', plannableHours: 8 })).toBe(Infinity)
    expect(hasPlannableWeek(plannableHoursOf({ kind: 'agent', plannableHours: null }))).toBe(false)
    expect(hasPlannableWeek(plannableHoursOf({ plannableHours: 20 }))).toBe(true)
    expect(hasPlannableWeek(plannableHoursOf(null))).toBe(true)
  })
})

describe('fitEndWeek with an unbounded capacity', () => {
  it('finishes in the starting week however much work there is', () => {
    // the whole point of "an agent has no plannable week": its work is never
    // stretched over calendar weeks it does not need
    const cap = plannableHoursOf({ kind: 'agent', plannableHours: null })
    expect(fitEndWeek(5, 400, cap, new Map())).toBe(5)
    // …even against a week that is already fully committed
    expect(fitEndWeek(5, 400, cap, new Map([[5, 999]]))).toBe(5)
  })
})

describe('spreadWindow', () => {
  it('is the plain span without a measurement week', () => {
    expect(spreadWindow(2, 5)).toEqual({ start: 2, end: 5 })
    expect(spreadWindow(2, 5, null)).toEqual({ start: 2, end: 5 })
  })
  it('starts at the measurement week once the issue has begun', () => {
    expect(spreadWindow(2, 5, 4)).toEqual({ start: 4, end: 5 })
  })
  it('never starts before the planned start (covers a future start)', () => {
    expect(spreadWindow(6, 9, 3)).toEqual({ start: 6, end: 9 })
  })
  it('an estimate saved after the planned end piles into its own week', () => {
    expect(spreadWindow(2, 5, 7)).toEqual({ start: 7, end: 7 })
  })
})

describe('committedByWeek', () => {
  it('spreads remaining hours evenly across the span', () => {
    const m = committedByWeek([item({ start: 2, end: 5, remaining: 40 })]) // 4 weeks → 10/wk
    expect(m.get(2)).toBe(10)
    expect(m.get(5)).toBe(10)
    expect(m.get(6)).toBeUndefined()
  })
  it('spreads from the measurement week, not the span start', () => {
    const m = committedByWeek([item({ start: 2, end: 5, remaining: 40, remainingSet: 4 })]) // 2 weeks → 20/wk
    expect(m.get(3)).toBeUndefined()
    expect(m.get(4)).toBe(20)
    expect(m.get(5)).toBe(20)
  })
  it('sums overlapping issues and excludes the planned one', () => {
    const items = [
      item({ issueUuid: 'a', start: 0, end: 1, remaining: 20 }), // 10/wk
      item({ issueUuid: 'b', start: 1, end: 1, remaining: 5 }), // 5 in wk1
      item({ issueUuid: 'self', start: 0, end: 3, remaining: 400 }),
    ]
    const m = committedByWeek(items, 'self')
    expect(m.get(0)).toBe(10)
    expect(m.get(1)).toBe(15)
  })
  it('ignores zero/negative spans and zero remaining time', () => {
    const m = committedByWeek([item({ start: 5, end: 4, remaining: 40 }), item({ remaining: 0 })])
    expect(m.size).toBe(0)
  })
})

describe('fitEndWeek', () => {
  it('returns start when there is no remaining time', () => {
    expect(fitEndWeek(11, 0, 34, new Map())).toBe(11)
  })
  it('fits a free person by ceil(remaining/capacity)', () => {
    // 60h at 34h/wk free → wk11:34 (rem26), wk12:34 (rem<0) → ends wk12 (2 weeks)
    expect(fitEndWeek(11, 60, 34, new Map())).toBe(12)
  })
  it('pushes the end out when the person is partly committed', () => {
    // 10h/wk already committed → 24h/wk free; 60h → wk11:24(36) wk12:24(12) wk13:24(<0) → wk13
    const committed = new Map([
      [11, 10],
      [12, 10],
      [13, 10],
      [14, 10],
    ])
    expect(fitEndWeek(11, 60, 34, committed)).toBe(13)
  })
  it('does not loop forever when fully booked (capacity 0)', () => {
    expect(fitEndWeek(11, 60, 0, new Map(), 50)).toBe(11 + 50 - 1)
  })
  it('skips saturated weeks then lands on the first week with free time', () => {
    // wk11 fully booked (34), wk12 free → all 20h fit in wk12
    const committed = new Map([[11, 34]])
    expect(fitEndWeek(11, 20, 34, committed)).toBe(12)
  })
})

describe('prepared owner projections', () => {
  it('preserves small competing commitments when excluding a much larger task', () => {
    const load = [item({ issueUuid: 'self', remaining: 2 ** 60 }), item({ remaining: 1 })]
    expect(prepareLoadProjection(load)(0, 1.5, 2, 'self')).toBe(1)
  })

  it('excludes every matching row and keeps anonymous hidden-project commitments', () => {
    const load = [
      item({ issueUuid: 'self', remaining: 20 }),
      item({ issueUuid: 'self', start: -2, end: -1, remainingSet: 0, remaining: 10 }),
      item({ issueUuid: null, remaining: 8 }),
    ]
    expect(prepareLoadProjection(load)(0, 3, 10, 'self')).toBe(1)
    expect(prepareLoadProjection(load)(0, 3, 10, 'absent')).toBe(1)
  })

  it('keeps the original completion threshold and bounded/non-finite behavior', () => {
    const loads = [
      [item({ issueUuid: 'self', remaining: 0.1 }), item({ remaining: 0.2 })],
      [item({ issueUuid: 'self', remaining: Infinity }), item({ remaining: 2 })],
    ]
    for (const load of loads) {
      const project = prepareLoadProjection(load)
      for (const capacity of [0, 1, 32, Infinity]) {
        for (const remaining of [0, 0.8 + 1e-9 - Number.EPSILON, 0.8 + 1e-9, Infinity]) {
          expect(project(0, remaining, capacity, 'self', 3)).toBe(
            fitEndWeek(0, remaining, capacity, committedByWeek(load, 'self'), 3),
          )
        }
      }
    }
  })

  it('matches ordered sums across randomized windows, magnitudes and completion boundaries', () => {
    const hours = fc.oneof(
      fc.integer({ min: 0, max: 10000 }).map((value) => value / 10),
      fc.double({ min: 1e-12, max: 1e16, noNaN: true, noDefaultInfinity: true }),
    )
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            issueUuid: fc.constantFrom('self', 'other', null),
            start: fc.integer({ min: -10, max: 15 }),
            end: fc.integer({ min: -10, max: 20 }),
            remainingSet: fc.option(fc.integer({ min: -10, max: 20 }), { nil: undefined }),
            remaining: hours,
          }),
          { maxLength: 60 },
        ),
        fc.integer({ min: -10, max: 15 }),
        hours,
        hours,
        (load, start, remaining, capacity) => {
          const exact = committedByWeek(load, 'self')
          const project = prepareLoadProjection(load)
          const boundary = Math.max(0, capacity - (exact.get(start) || 0)) + 1e-9
          for (const hoursLeft of [remaining, boundary, boundary - Number.EPSILON]) {
            expect(project(start, hoursLeft, capacity, 'self', 50)).toBe(
              fitEndWeek(start, hoursLeft, capacity, exact, 50),
            )
          }
        },
      ),
      { seed: 20261001, numRuns: 400 },
    )
  })
})

describe('loadByProject', () => {
  it('groups visible projects and folds hidden into "Other projects"', () => {
    const items = [
      item({
        issueUuid: 'a',
        projectId: 'p1',
        projectName: 'Alpha',
        start: 0,
        end: 1,
        remaining: 20,
      }), // 10/wk
      item({
        issueUuid: 'b',
        projectId: 'p2',
        projectName: 'Beta',
        start: 0,
        end: 0,
        remaining: 5,
      }),
      item({
        issueUuid: 'c',
        projectId: null,
        projectName: null,
        visible: false,
        start: 0,
        end: 1,
        remaining: 40,
      }), // 20/wk hidden
    ]
    const buckets = loadByProject(items, 0, 1)
    // named projects sort biggest-first (Alpha 20h, Beta 5h); "Other projects"
    // (40h hidden) is always pinned last regardless of size
    expect(buckets.map((b) => [b.name, b.hours])).toEqual([
      ['Alpha', 20],
      ['Beta', 5],
      ['Other projects', 40],
    ])
    expect(buckets[buckets.length - 1].other).toBe(true)
  })
  it('only counts the overlap with the queried window and excludes self', () => {
    const items = [
      item({
        issueUuid: 'a',
        projectId: 'p1',
        projectName: 'Alpha',
        start: 0,
        end: 9,
        remaining: 100,
      }), // 10/wk
      item({ issueUuid: 'self', projectId: 'p1', start: 0, end: 9, remaining: 999 }),
    ]
    const buckets = loadByProject(items, 2, 4, 'self') // 3 weeks overlap × 10 = 30
    expect(buckets).toHaveLength(1)
    expect(buckets[0].hours).toBe(30)
  })
  it('overlaps against the spread window, not the raw span', () => {
    // measured in week 5 of a 0..9 span: 100h over weeks 5..9 = 20/wk;
    // the queried weeks 2..4 predate the measurement → nothing there
    const items = [
      item({
        issueUuid: 'a',
        projectId: 'p1',
        projectName: 'Alpha',
        start: 0,
        end: 9,
        remaining: 100,
        remainingSet: 5,
      }),
    ]
    expect(loadByProject(items, 2, 4)).toHaveLength(0)
    expect(loadByProject(items, 5, 6)[0].hours).toBe(40)
  })
})

describe('issueLoadByPerson', () => {
  const iss = (o: Partial<LoadIssue>) => ({
    owner: 'u1',
    project: 'p1',
    start: 0,
    end: 0,
    remaining: 0,
    ...o,
  })
  it("groups a person's issue hours by week and project", () => {
    const loads = issueLoadByPerson([
      iss({ project: 'p1', start: 0, end: 1, remaining: 20 }), // 10/wk
      iss({ project: 'p2', start: 1, end: 1, remaining: 6 }),
    ])
    expect(loads.get('u1').get(0).get('p1')).toBe(10)
    expect(loads.get('u1').get(1).get('p1')).toBe(10)
    expect(loads.get('u1').get(1).get('p2')).toBe(6)
  })
  it('ignores unowned / unscheduled / no-remaining issues', () => {
    const loads = issueLoadByPerson([
      iss({ owner: null, remaining: 40, end: 3 }),
      iss({ start: null, end: null, remaining: 40 }),
      iss({ start: 0, end: 3, remaining: 0 }),
    ])
    expect(loads.size).toBe(0)
  })
  it('honours the in-scope predicate', () => {
    const loads = issueLoadByPerson(
      [
        iss({ project: 'p1', start: 0, end: 0, remaining: 10 }),
        iss({ project: 'other', start: 0, end: 0, remaining: 10 }),
      ],
      (pid) => pid === 'p1',
    )
    expect(loads.get('u1').get(0).has('p1')).toBe(true)
    expect(loads.get('u1').get(0).has('other')).toBe(false)
  })
  it('spreads from the measurement week', () => {
    const loads = issueLoadByPerson([iss({ start: 0, end: 3, remaining: 30, remainingSet: 2 })]) // wks 2..3 → 15/wk
    expect(loads.get('u1').get(1)).toBeUndefined()
    expect(loads.get('u1').get(2).get('p1')).toBe(15)
    expect(loads.get('u1').get(3).get('p1')).toBe(15)
  })
  it('leaves paused work out of the load', () => {
    const loads = issueLoadByPerson([
      iss({ start: 0, end: 1, remaining: 20 }),
      iss({ project: 'p2', start: 1, end: 1, remaining: 30, paused: true }),
    ])
    expect(loads.get('u1').get(1).get('p1')).toBe(10)
    expect(loads.get('u1').get(1).has('p2')).toBe(false)
  })
})

describe('pausedWeeksByPerson', () => {
  const iss = (o: Partial<LoadIssue>) => ({
    owner: 'u1',
    project: 'p1',
    start: 0,
    end: 0,
    paused: true,
    ...o,
  })
  it('marks every planned week of a paused issue, even with no hours left', () => {
    const weeks = pausedWeeksByPerson([
      iss({ start: 2, end: 4, remaining: 0, remainingSet: 3 }),
      iss({ owner: 'u2', start: 7, end: 7, remaining: 12 }),
    ])
    expect([...weeks.get('u1')]).toEqual([2, 3, 4])
    expect([...weeks.get('u2')]).toEqual([7])
  })
  it('skips running, unowned, unscheduled and out-of-scope issues', () => {
    const weeks = pausedWeeksByPerson(
      [
        iss({ paused: false, remaining: 10 }),
        iss({ owner: null }),
        iss({ start: null, end: null }),
        iss({ project: 'other' }),
      ],
      (pid) => pid === 'p1',
    )
    expect(weeks.size).toBe(0)
  })
})

describe('the Team strip figures', () => {
  it('tones a week near from 90% and over only above 100%', () => {
    expect(loadTone(0)).toBe('normal')
    expect(loadTone(89)).toBe('normal')
    expect(loadTone(90)).toBe('near')
    expect(loadTone(100)).toBe('near')
    expect(loadTone(101)).toBe('over')
  })
  it('prints hours to one decimal without a trailing zero', () => {
    expect(fmtHours(32)).toBe('32')
    expect(fmtHours(12.25)).toBe('12.3')
    expect(fmtHours(7.04)).toBe('7')
    expect(fmtHours(0.1 + 0.2)).toBe('0.3')
    expect(fmtHours(Number.MAX_VALUE)).toBe(String(Number.MAX_VALUE))
  })
})
