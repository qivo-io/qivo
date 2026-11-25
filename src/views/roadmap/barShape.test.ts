import { describe, expect, it } from 'vitest'
import { type BarShapeInput, barShape, tailClickOpens } from './barShape'

/* Weeks 9 to 17 at 100 px a week, today in the middle of week 11: week w
   starts at (w - 9) * 100, and a bar ending in week w ends 6 px before the
   next week's line. */
const shape = (task: Partial<BarShapeInput>) =>
  barShape({
    start: 10,
    end: 12,
    w0: 9,
    w1: 17,
    weekW: 100,
    todayWeek: 11,
    todayPos: 11.5,
    done: false,
    finish: null,
    showProjection: true,
    ...task,
  })

describe('barShape', () => {
  it('draws a plan grey up to the today line and gives a plan that has not ended no run-on', () => {
    const bar = shape({ start: 10, end: 12 })
    expect(bar.plan).toEqual({ left: 100, width: 294, cutStart: false, cutEnd: false })
    expect(bar.past).toBe(150)
    expect(bar.runOn).toBeNull()
  })

  it("runs a plan that ended weeks ago on to this week's end, then stripes it to the projected finish", () => {
    const bar = shape({ start: 9, end: 9, finish: 13 })
    expect(bar.plan).toEqual({ left: 0, width: 94, cutStart: false, cutEnd: false })
    expect(bar.past).toBe(94)
    expect(bar.runOn).toEqual({ left: 94, width: 200, cutStart: false, cutEnd: false })
    expect(bar.projection).toEqual({ left: 294, width: 200, cutStart: false, cutEnd: false })
  })

  it('hides only the stripes when projected delay is off', () => {
    const bar = shape({ start: 9, end: 9, finish: 13, showProjection: false })
    expect(bar.runOn).toEqual({ left: 94, width: 200, cutStart: false, cutEnd: false })
    expect(bar.projection).toBeNull()
    expect(bar.stripesTo).toBeNull()
  })

  it('starts the stripes at the planned end of a plan that ends after this week', () => {
    const bar = shape({ start: 10, end: 12, finish: 14 })
    expect(bar.runOn).toBeNull()
    expect(bar.projection).toEqual({ left: 394, width: 200, cutStart: false, cutEnd: false })
  })

  it('draws no stripes for a task projected to finish this week', () => {
    const bar = shape({ start: 9, end: 10, finish: 11 })
    expect(bar.runOn).toEqual({ left: 194, width: 100, cutStart: false, cutEnd: false })
    expect(bar.projection).toBeNull()
  })

  it('draws a finished task as its plan alone, without grey past', () => {
    const bar = shape({ start: 9, end: 9, done: true, finish: 13 })
    expect(bar).toEqual({
      plan: { left: 0, width: 94, cutStart: false, cutEnd: false },
      past: 0,
      runOn: null,
      projection: null,
      stripesTo: null,
    })
  })

  it("cuts a run-on and stripes at the window's edges, also when the plan lies before the window", () => {
    const bar = shape({ start: 5, end: 7, finish: 20 })
    expect(bar.plan).toBeNull()
    expect(bar.runOn).toEqual({ left: 0, width: 294, cutStart: true, cutEnd: false })
    expect(bar.projection).toEqual({ left: 294, width: 606, cutStart: false, cutEnd: true })
    expect(bar.stripesTo).toBe(20)
  })

  it('keeps some colour on a plan ending this week when the today line falls past its end', () => {
    const bar = shape({ start: 11, end: 11, weekW: 20, todayPos: 11 + 6 / 7 })
    expect(bar.plan).toEqual({ left: 40, width: 14, cutStart: false, cutEnd: false })
    expect(bar.past).toBe(11)
  })
})

describe('a click on a run-on or stripes', () => {
  const still = { x: 100, y: 10, far: false, releasedAt: 5000 }
  const click = { detail: 1, at: 5010, inside: true }

  it('opens the task after a press that stayed in place and ended on the part', () => {
    expect(tailClickOpens(still, click)).toBe(true)
  })

  it('opens nothing after a press that travelled, also when it ended where it began', () => {
    expect(tailClickOpens({ ...still, far: true }, click)).toBe(false)
  })

  it('opens nothing after a press released off the part', () => {
    expect(tailClickOpens(still, { ...click, inside: false })).toBe(false)
  })

  it('opens the task on a click that belongs to no press, whatever press was left behind', () => {
    expect(tailClickOpens(null, { detail: 1, at: 9000, inside: false })).toBe(true)
    // an assistive tool's click
    expect(tailClickOpens({ ...still, far: true }, { detail: 0, at: 5010, inside: false })).toBe(
      true,
    )
    // a long press is released without a click, and the next click comes later
    expect(tailClickOpens({ ...still, far: true }, { detail: 1, at: 9000, inside: false })).toBe(
      true,
    )
  })

  it("counts a phone's late click as the click of its press", () => {
    expect(tailClickOpens({ ...still, far: true }, { ...click, at: 5350 })).toBe(false)
  })
})
