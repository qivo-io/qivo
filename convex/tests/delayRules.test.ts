/* The delay rules the app and the REST and MCP reads share (lib/delay.ts).
 * The app judges them on its week grid, where the current week is
 * TODAY_WEEK, and the server on weekGrid's, where it is about 2,900. Every
 * verdict on one grid is the other's moved by the difference, so the move
 * to the shared module keeps the app's verdicts (src/lib/delay.test.ts) and
 * gives the server the same ones. */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TODAY_WEEK } from '../../src/lib/dates'
import { delayOf as appDelayOf, type DelayIssue } from '../../src/lib/delay'
import type { LoadSpan } from '../../src/lib/workload'
import { delayOf } from '../lib/delay'

describe('the shared delay rules give the app’s verdicts on any week grid', () => {
  it('shifts every verdict with the grid, so the server’s weeks agree with the app’s', () => {
    const week = fc.option(fc.integer({ min: TODAY_WEEK - 12, max: TODAY_WEEK + 30 }), {
      nil: null,
    })
    const issue = fc.record({
      status: fc.constantFrom('backlog', 'todo', 'progress', 'review', 'done'),
      owner: fc.constantFrom('u1', null),
      start: week,
      end: week,
      dueWeek: week,
      duePast: fc.boolean(),
      isGroup: fc.boolean(),
      isDone: fc.option(fc.boolean(), { nil: undefined }),
      partial: fc.boolean(),
      remaining: fc.option(
        fc.integer({ min: 0, max: 4000 }).map((h) => h / 10),
        {
          nil: undefined,
        },
      ),
      remainingSet: week,
      capacity: fc.constantFrom(0, 16, 32, 37.5, Infinity),
    })
    const span = fc.record({
      issueUuid: fc.constantFrom('self', 'other', null),
      start: fc.integer({ min: TODAY_WEEK - 12, max: TODAY_WEEK + 30 }),
      length: fc.integer({ min: -2, max: 12 }),
      remaining: fc.integer({ min: 0, max: 2000 }).map((h) => h / 10),
      remainingSet: week,
    })
    fc.assert(
      fc.property(
        issue,
        fc.array(span, { maxLength: 6 }),
        fc.constantFrom(2900, 2901, -40, 100_000),
        (it, spans, shift) => {
          const base: DelayIssue = { uuid: 'self', ...it }
          const load: LoadSpan[] = spans.map(({ length, ...s }) => ({
            ...s,
            end: s.start + length,
          }))
          const move = (w: number | null | undefined) => (w == null ? w : w + shift - TODAY_WEEK)
          const moved: DelayIssue = {
            ...base,
            start: move(base.start) ?? null,
            end: move(base.end) ?? null,
            dueWeek: move(base.dueWeek) ?? null,
            remainingSet: move(base.remainingSet),
          }
          const movedLoad = load.map((s) => ({
            ...s,
            start: s.start + shift - TODAY_WEEK,
            end: s.end + shift - TODAY_WEEK,
            remainingSet: move(s.remainingSet),
          }))
          // the app's own entry point, on its grid where today is TODAY_WEEK
          const app = appDelayOf(base, load)
          const server = delayOf(moved, movedLoad, shift)
          expect(server).toEqual(
            app === null ? null : { status: app.status, fin: move(app.fin) ?? null },
          )
        },
      ),
      { numRuns: 400 },
    )
  })
})
