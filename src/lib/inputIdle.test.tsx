// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInputIdle } from './inputIdle'

const MINUTE = 60_000

function Probe({ onIdle }: { onIdle: () => void }) {
  useInputIdle(30 * MINUTE, onIdle)
  return null
}

let root: Root
const render = (element: React.ReactNode) => {
  root = createRoot(document.createElement('div'))
  act(() => root.render(element))
  return { unmount: () => act(() => root.unmount()) }
}

describe('useInputIdle', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('calls once 30 minutes pass without input, and again after 30 more', () => {
    const idle = vi.fn()
    render(<Probe onIdle={idle} />)
    act(() => vi.advanceTimersByTime(30 * MINUTE - 1))
    expect(idle).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(idle).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(30 * MINUTE))
    expect(idle).toHaveBeenCalledTimes(2)
  })

  it('starts the 30 minutes again on every kind of input', () => {
    const idle = vi.fn()
    render(<Probe onIdle={idle} />)
    for (const event of [
      new PointerEvent('pointermove'),
      new PointerEvent('pointerdown'),
      new KeyboardEvent('keydown', { key: 'a' }),
      new TouchEvent('touchstart'),
      new WheelEvent('wheel'),
    ]) {
      act(() => vi.advanceTimersByTime(20 * MINUTE))
      document.body.dispatchEvent(event)
    }
    expect(idle).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(30 * MINUTE - 1))
    expect(idle).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('does not count other events as input', () => {
    const idle = vi.fn()
    render(<Probe onIdle={idle} />)
    act(() => vi.advanceTimersByTime(20 * MINUTE))
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('focus'))
    act(() => vi.advanceTimersByTime(10 * MINUTE))
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('stops once unmounted', () => {
    const idle = vi.fn()
    render(<Probe onIdle={idle} />).unmount()
    act(() => vi.advanceTimersByTime(60 * MINUTE))
    expect(idle).not.toHaveBeenCalled()
  })
})
