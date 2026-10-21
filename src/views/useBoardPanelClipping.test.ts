// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoardPanelClipping } from './useBoardPanelClipping'

/* The panel clipping follows lanes appearing and going, not the cards a
   status cell gains. */

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
})

/* One lane with one status cell, as Kanban draws it. */
function Pane() {
  const { paneRef, materialRef } = useBoardPanelClipping()
  return createElement(
    'div',
    { ref: paneRef, 'data-pane': '' },
    createElement('div', { ref: materialRef }),
    createElement(
      'div',
      { className: 'board-lane' },
      createElement(
        'div',
        { className: 'board-lane-body' },
        createElement('div', { 'data-board-cell': 'pool', 'data-status': 'todo' }),
      ),
      createElement('div', { 'data-lane-foot': '' }),
    ),
  )
}

/** Lets the mutation observer's callback run. */
const observed = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))

describe('the Board panel clipping', () => {
  it('leaves the pane alone when a status cell gains a card', async () => {
    await act(async () => root.render(createElement(Pane)))
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const query = vi.spyOn(pane, 'querySelectorAll')
    pane.querySelector('[data-board-cell]')!.append(document.createElement('div'))
    await observed()
    expect(query).not.toHaveBeenCalled()
  })

  it('follows a lane that appears', async () => {
    await act(async () => root.render(createElement(Pane)))
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const query = vi.spyOn(pane, 'querySelectorAll')
    const lane = document.createElement('div')
    lane.className = 'board-lane'
    pane.append(lane)
    await observed()
    expect(query).toHaveBeenCalled()
  })
})
