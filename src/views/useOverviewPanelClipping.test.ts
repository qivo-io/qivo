// @vitest-environment jsdom
import { Activity, type ActivityProps, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverviewPanelClipping } from './useOverviewPanelClipping'

/* The section clipping follows sections appearing, not the rows a
   section's lists mount in slices, and a kept page that hides and shows
   again does not render for it. */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let renders = 0

/* One section with a list in its body, as the Overview draws it. */
function Pane() {
  renders++
  const { paneRef } = useOverviewPanelClipping(true)
  return createElement(
    'div',
    { ref: paneRef, 'data-pane': '' },
    createElement(
      'section',
      { className: 'overview-section' },
      createElement(
        'div',
        { className: 'overview-section-body' },
        createElement('div', { 'data-list': '' }),
      ),
      createElement('div', { className: 'overview-section-foot' }),
    ),
  )
}

/** Lets the mutation observer's callback run. */
const observed = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))

describe('the Overview section clipping', () => {
  it('leaves the pane alone when a list in a section gains rows', async () => {
    await act(async () => root.render(createElement(Pane)))
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const list = pane.querySelector('[data-list]')!
    const query = vi.spyOn(pane, 'querySelectorAll')
    list.append(document.createElement('div'), document.createElement('div'))
    await observed()
    expect(query).not.toHaveBeenCalled()
  })

  it('follows a section that appears', async () => {
    await act(async () => root.render(createElement(Pane)))
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const query = vi.spyOn(pane, 'querySelectorAll')
    const section = document.createElement('section')
    section.className = 'overview-section'
    pane.append(section)
    await observed()
    expect(query).toHaveBeenCalled()
  })

  it('does not render the page again as a kept page hides and shows', async () => {
    const page = (mode: 'visible' | 'hidden') =>
      act(async () =>
        root.render(createElement(Activity, { mode } as ActivityProps, createElement(Pane))),
      )
    await page('visible')
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const section = pane.querySelector<HTMLElement>('.overview-section')!
    expect(section.style.getPropertyValue('clip-path')).not.toBe('')
    renders = 0
    await page('hidden')
    await page('visible')
    // one render each for the new mode, none for the pane's ref
    expect(renders).toBe(2)
    // and the clipping is back on the pane shown again
    expect(section.style.getPropertyValue('clip-path')).not.toBe('')
  })
})
