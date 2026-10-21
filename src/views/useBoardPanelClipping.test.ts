// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoardPanelClipping } from './useBoardPanelClipping'

/* The panel clipping follows lanes appearing and going, not the cards a
   status cell gains, and repaints without searching the pane. */

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

/* The pane, then the material portalled after it, as BoardPanelMaterial
   portals it into #root, so the material's ref comes second. */
function MaterialAfter({ host }: { host: HTMLElement }) {
  const { paneRef, materialRef } = useBoardPanelClipping()
  return createElement(
    'div',
    null,
    createElement('div', { ref: paneRef, 'data-pane': '' }),
    createPortal(createElement('div', { ref: materialRef, 'data-material': '' }), host),
  )
}

describe('the Board panel clipping', () => {
  it('paints the material whichever of the two mounts first', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    try {
      await act(async () => root.render(createElement(MaterialAfter, { host })))
      const material = host.querySelector<HTMLElement>('[data-material]')!
      // painted in the commit: nothing to show, so the material is clipped away
      expect(material.style.clipPath).toBe('inset(0 0 100% 0)')
      await act(async () => root.render(null))
      expect(material.style.clipPath).toBe('')
    } finally {
      host.remove()
    }
  })

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

  it('repaints on a scroll without searching the pane', async () => {
    await act(async () => root.render(createElement(Pane)))
    const pane = container.querySelector<HTMLElement>('[data-pane]')!
    const query = vi.spyOn(pane, 'querySelectorAll')
    const lane = vi.spyOn(pane.querySelector<HTMLElement>('.board-lane')!, 'getBoundingClientRect')
    pane.dispatchEvent(new Event('scroll'))
    await act(
      async () => await new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    )
    expect(lane).toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
})
