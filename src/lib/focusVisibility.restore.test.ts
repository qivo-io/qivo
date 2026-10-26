// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreFocus } from './focusVisibility'

/* restoreFocus on a button that the test places in or out of the window,
   after keyboard or pointer use. */

afterEach(() => {
  document.body.innerHTML = ''
  delete document.documentElement.dataset.focusModality
})

/** A button whose box starts at `top`, 40 pixels tall, with its scroll
    recorded. */
function button(top: number) {
  const element = document.body.appendChild(document.createElement('button'))
  element.getBoundingClientRect = () => new DOMRect(16, top, 200, 40)
  element.scrollIntoView = vi.fn()
  return element
}

describe('restoreFocus', () => {
  it('scrolls keyboard focus that lands above the window into view', () => {
    document.documentElement.dataset.focusModality = 'keyboard'
    const above = button(-120)
    restoreFocus(above)
    expect(document.activeElement).toBe(above)
    expect(above.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('scrolls nothing for focus in the window, or after pointer use', () => {
    document.documentElement.dataset.focusModality = 'keyboard'
    const shown = button(200)
    restoreFocus(shown)
    expect(shown.scrollIntoView).not.toHaveBeenCalled()
    document.documentElement.dataset.focusModality = 'pointer'
    const above = button(-120)
    restoreFocus(above)
    expect(document.activeElement).toBe(above)
    expect(above.scrollIntoView).not.toHaveBeenCalled()
  })
})
