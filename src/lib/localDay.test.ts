import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isoFromDate,
  setWeekConfig,
  TIMELINE_START,
  TODAY_ISO,
  TODAY_POS,
  TODAY_WEEK,
} from './dates'
import { watchLocalDay } from './localDay'

describe('local planner day', () => {
  let browser: EventTarget
  let page: EventTarget & { visibilityState: string }
  let stop: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    browser = new EventTarget()
    page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', page)
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    setWeekConfig()
  })

  it('advances the date, marker and week anchor together at local midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 4, 23, 59, 59, 500))
    stop = watchLocalDay((now) => setWeekConfig(1, 'first4day', now))
    const sundayOrigin = TIMELINE_START.getTime()
    expect(TODAY_ISO).toBe('2026-10-04')
    expect(TODAY_POS).toBeCloseTo(TODAY_WEEK + 6 / 7)
    vi.advanceTimersByTime(500)
    expect(TODAY_ISO).toBe('2026-10-05')
    expect(TODAY_POS).toBe(TODAY_WEEK)
    expect(TIMELINE_START.getTime()).toBeGreaterThan(sundayOrigin)
  })

  it.each(['focus', 'pageshow', 'visibilitychange'])('catches up after sleep on %s', (event) => {
    vi.setSystemTime(new Date(2026, 9, 1, 12))
    const receive = vi.fn()
    stop = watchLocalDay(receive)
    vi.setSystemTime(new Date(2026, 9, 12, 9))
    const target = event === 'visibilitychange' ? page : browser
    target.dispatchEvent(new Event(event))
    target.dispatchEvent(new Event(event))
    expect(receive.mock.calls.map(([now]) => isoFromDate(now))).toEqual([
      '2026-10-01',
      '2026-10-12',
    ])
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each([
    [2, 29],
    [9, 25],
  ])('schedules the next calendar midnight across DST (%s/%s)', (month, day) => {
    const current = new Date(2026, month, day)
    vi.setSystemTime(current)
    const receive = vi.fn()
    stop = watchLocalDay(receive)
    const tomorrow = new Date(current)
    tomorrow.setDate(tomorrow.getDate() + 1)
    vi.advanceTimersByTime(tomorrow.getTime() - current.getTime() - 1)
    expect(receive).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(isoFromDate(receive.mock.calls[1][0])).toBe(isoFromDate(tomorrow))
  })

  it('refreshes on clock rollback and removes timers/listeners on disposal', () => {
    vi.setSystemTime(new Date(2026, 9, 2, 12))
    const receive = vi.fn()
    stop = watchLocalDay(receive)
    vi.setSystemTime(new Date(2026, 9, 1, 12))
    browser.dispatchEvent(new Event('focus'))
    expect(receive.mock.calls.map(([now]) => isoFromDate(now))).toEqual([
      '2026-10-02',
      '2026-10-01',
    ])
    stop()
    vi.advanceTimersByTime(2 * 86400000)
    browser.dispatchEvent(new Event('focus'))
    page.dispatchEvent(new Event('visibilitychange'))
    expect(receive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
