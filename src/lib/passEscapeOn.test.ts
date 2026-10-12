import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { passEscapeOn } from './passEscapeOn'

/* Just enough of the DOM: elements that record the keys dispatched on them,
   and a connected flag the tests flip. */
class FakeElement {
  isConnected = true
  keys: string[] = []
  dispatchEvent(event: { key: string }) {
    this.keys.push(event.key)
    return true
  }
}

describe('passEscapeOn', () => {
  let active: FakeElement

  beforeEach(() => {
    vi.useFakeTimers()
    active = new FakeElement()
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal(
      'KeyboardEvent',
      class {
        constructor(
          public type: string,
          init: { key: string },
        ) {
          Object.assign(this, init)
        }
      },
    )
    vi.stubGlobal('document', { activeElement: active, body: new FakeElement() })
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const pressedAndTooltip = () => [new FakeElement(), new FakeElement()] as const
  const pass = (pressed: FakeElement, tooltip: FakeElement) =>
    passEscapeOn(pressed as unknown as Element, tooltip as unknown as HTMLElement)

  it('waits for the tooltip to leave the DOM, then sends Escape from where it was pressed', () => {
    const [pressed, tooltip] = pressedAndTooltip()
    pass(pressed, tooltip)
    vi.advanceTimersByTime(500)
    expect(pressed.keys).toEqual([])
    tooltip.isConnected = false
    vi.advanceTimersByTime(100)
    expect(pressed.keys).toEqual(['Escape'])
    vi.advanceTimersByTime(2000)
    expect(pressed.keys).toEqual(['Escape'])
  })

  it('sends it from the focused element when the pressed one is gone', () => {
    const [pressed, tooltip] = pressedAndTooltip()
    pressed.isConnected = false
    tooltip.isConnected = false
    pass(pressed, tooltip)
    vi.advanceTimersByTime(100)
    expect(pressed.keys).toEqual([])
    expect(active.keys).toEqual(['Escape'])
  })

  it('drops the Escape when the tooltip stays in the DOM', () => {
    const [pressed, tooltip] = pressedAndTooltip()
    pass(pressed, tooltip)
    vi.advanceTimersByTime(1100)
    tooltip.isConnected = false
    vi.advanceTimersByTime(1000)
    expect(pressed.keys).toEqual([])
  })
})
