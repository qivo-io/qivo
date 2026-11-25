/** The room a bar leaves before the next week's line. */
export const BAR_GAP = 6

export type BarPart = {
  left: number
  width: number
  /** the part goes on past the window's left or right edge */
  cutStart: boolean
  cutEnd: boolean
}

export type BarShape = {
  /** the planned weeks, which a drag moves */
  plan: BarPart | null
  /** the width of the plan's part before the today line */
  past: number
  /** an unfinished task's time from its plan's end to the current week's end */
  runOn: BarPart | null
  /** stripes from where the plan or its run-on ends to the end of `stripesTo` */
  projection: BarPart | null
  /** the week the stripes run to, also when they lie outside the window */
  stripesTo: number | null
}

export type BarShapeInput = {
  /** the plan's first and last week, inclusive */
  start: number
  end: number
  /** the window's first and last week, inclusive */
  w0: number
  w1: number
  weekW: number
  todayWeek: number
  /** today as a fractional week index, where the today line is drawn */
  todayPos: number
  done: boolean
  /** the projected finish week of a Slipping or Delayed task, else null */
  finish: number | null
  showProjection: boolean
}

/* A plan that reaches into the current week keeps this much of its colour
   where the today line falls after the bar's end, as on the last days of
   a narrow week. */
const NOW_MIN = 3

/** A task bar's parts in pixels from the timeline's left edge, each cut at
    the window's edges and null where none of it is in the window. */
export function barShape(it: BarShapeInput): BarShape {
  const x = (week: number) => (week - it.w0) * it.weekW
  const endX = (week: number) => x(week + 1) - BAR_GAP
  const right = x(it.w1 + 1)
  const part = (from: number, to: number): BarPart | null => {
    const left = Math.max(from, 0)
    const width = Math.min(to, right) - left
    return width > 0 ? { left, width, cutStart: from < 0, cutEnd: to > right } : null
  }
  const plan = part(x(it.start), endX(it.end))
  if (it.done) return { plan, past: 0, runOn: null, projection: null, stripesTo: null }
  let past = 0
  if (plan) {
    past = Math.min(Math.max(x(it.todayPos) - plan.left, 0), plan.width)
    if (it.end >= it.todayWeek && !plan.cutEnd)
      past = Math.min(past, Math.max(plan.width - NOW_MIN, 0))
  }
  const runOn = it.end < it.todayWeek ? part(endX(it.end), endX(it.todayWeek)) : null
  const solidEnd = Math.max(it.end, it.todayWeek)
  const stripesTo =
    it.showProjection && it.finish !== null && it.finish > solidEnd ? it.finish : null
  const projection = stripesTo === null ? null : part(endX(solidEnd), endX(stripesTo))
  return { plan, past, runOn, projection, stripesTo }
}

/** A press on a bar's run-on or stripes: where it began, whether it ever
    travelled more than a few pixels, and when it was released (event time,
    null while it is held). */
export type TailPress = { x: number; y: number; far: boolean; releasedAt: number | null }

/** How long after a release its click can still come. A phone's browser can
    hold a tap's click back for about a third of a second. */
const CLICK_AFTER_RELEASE_MS = 1000

/** Whether a click on a bar's run-on or stripes opens the task. A click
    that belongs to no press opens it: one an assistive tool sends alone
    (`detail` 0, or no press at all), or one that comes long after a
    release that sent no click of its own, as a long press does. The click
    of a press opens the task only where the press never travelled and
    ended on the part (`inside`). */
export function tailClickOpens(
  press: TailPress | null,
  click: { detail: number; at: number; inside: boolean },
): boolean {
  if (!press || click.detail === 0) return true
  if (press.releasedAt !== null && click.at - press.releasedAt > CLICK_AFTER_RELEASE_MS) return true
  return !press.far && click.inside
}
