import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchCanvasWeek } from './canvasWeek'

describe('weekly canvas clock', () => {
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('emits today initially and changes at Monday midnight UTC without a reload', () => {
    vi.setSystemTime(new Date('2026-09-20T23:59:59.500Z'))
    const receive = vi.fn()
    stop = watchCanvasWeek(receive)
    expect(receive.mock.calls).toEqual([['2026-09-20']])

    vi.advanceTimersByTime(499)
    expect(receive).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(receive.mock.calls).toEqual([['2026-09-20'], ['2026-09-21']])
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000)
    expect(receive.mock.calls).toEqual([['2026-09-20'], ['2026-09-21'], ['2026-09-28']])
  })

  it('keeps one boundary timer and does not refresh the selection on same-week wake events', () => {
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
    const receive = vi.fn()
    stop = watchCanvasWeek(receive)
    vi.setSystemTime(new Date('2026-09-20T23:59:59Z'))
    browser.dispatchEvent(new Event('focus'))
    browser.dispatchEvent(new Event('pageshow'))
    page.dispatchEvent(new Event('visibilitychange'))
    expect(receive).toHaveBeenCalledExactlyOnceWith('2026-09-19')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(receive.mock.calls).toEqual([['2026-09-19'], ['2026-09-21']])
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(['focus', 'pageshow', 'visibilitychange'])(
    'catches up directly to the actual week after multiple weeks asleep on %s',
    (event) => {
      vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
      const receive = vi.fn()
      stop = watchCanvasWeek(receive)
      vi.setSystemTime(new Date('2026-10-14T09:30:00Z'))
      const target = event === 'visibilitychange' ? page : browser
      target.dispatchEvent(new Event(event))
      expect(receive.mock.calls).toEqual([['2026-09-19'], ['2026-10-14']])
      target.dispatchEvent(new Event(event))
      expect(receive).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)
    },
  )

  it('uses the actual week when a timer callback runs late after a suspended tab wakes', () => {
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
    const receive = vi.fn()
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    stop = watchCanvasWeek(receive)
    const delayed = schedule.mock.calls[0][0] as () => void
    vi.setSystemTime(new Date('2026-10-18T23:59:59Z'))
    delayed()
    expect(receive.mock.calls).toEqual([['2026-09-19'], ['2026-10-18']])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(receive.mock.calls).toEqual([['2026-09-19'], ['2026-10-18'], ['2026-10-19']])
  })

  it('waits for a hidden document to become visible before catching up on visibility changes', () => {
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
    const receive = vi.fn()
    stop = watchCanvasWeek(receive)
    vi.setSystemTime(new Date('2026-09-22T09:30:00Z'))
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    expect(receive).toHaveBeenCalledOnce()
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    expect(receive.mock.calls).toEqual([['2026-09-19'], ['2026-09-22']])
  })

  it('keeps ISO week 53 across New Year and distinguishes the same week in a later year', () => {
    vi.setSystemTime(new Date('2020-12-31T23:59:59Z'))
    const receive = vi.fn()
    stop = watchCanvasWeek(receive)
    vi.advanceTimersByTime(1000)
    browser.dispatchEvent(new Event('focus'))
    expect(receive).toHaveBeenCalledExactlyOnceWith('2020-12-31')
    vi.setSystemTime(new Date('2021-01-03T23:59:59Z'))
    browser.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(1000)
    expect(receive.mock.calls).toEqual([['2020-12-31'], ['2021-01-04']])

    vi.setSystemTime(new Date('2022-01-04T12:00:00Z'))
    browser.dispatchEvent(new Event('pageshow'))
    expect(receive.mock.calls).toEqual([['2020-12-31'], ['2021-01-04'], ['2022-01-04']])
  })

  it('recomputes the week and next boundary when the clock moves backward', () => {
    vi.setSystemTime(new Date('2026-09-21T00:00:01Z'))
    const receive = vi.fn()
    stop = watchCanvasWeek(receive)
    vi.setSystemTime(new Date('2026-09-20T23:59:59Z'))
    browser.dispatchEvent(new Event('focus'))
    browser.dispatchEvent(new Event('focus'))
    expect(receive.mock.calls).toEqual([['2026-09-21'], ['2026-09-20']])
    vi.advanceTimersByTime(1000)
    expect(receive.mock.calls).toEqual([['2026-09-21'], ['2026-09-20'], ['2026-09-21']])
  })

  it('removes listeners and cancels both scheduled and already queued callbacks on cleanup', () => {
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
    const receive = vi.fn()
    const schedule = vi.spyOn(globalThis, 'setTimeout')
    const removeBrowserListener = vi.spyOn(browser, 'removeEventListener')
    const removePageListener = vi.spyOn(page, 'removeEventListener')
    stop = watchCanvasWeek(receive)
    const queued = schedule.mock.calls[0][0] as () => void
    stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeBrowserListener).toHaveBeenCalledTimes(2)
    expect(removePageListener).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date('2026-10-14T09:30:00Z'))
    queued()
    browser.dispatchEvent(new Event('focus'))
    browser.dispatchEvent(new Event('pageshow'))
    page.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000)
    expect(receive).toHaveBeenCalledExactlyOnceWith('2026-09-19')
    expect(vi.getTimerCount()).toBe(0)
  })
})
