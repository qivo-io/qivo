// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Every component that asks whether this is a phone shares one media query
   list and one listener. */

let container: HTMLDivElement
let root: Root
let matches = false
const listening = new Set<() => void>()
const addListener = vi.fn((_: string, listener: () => void) => {
  listening.add(listener)
})
const removeListener = vi.fn((_: string, listener: () => void) => {
  listening.delete(listener)
})
const matchMedia = vi.fn(() => ({
  get matches() {
    return matches
  },
  addEventListener: addListener,
  removeEventListener: removeListener,
}))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', matchMedia)
  matches = false
  listening.clear()
  matchMedia.mockClear()
  addListener.mockClear()
  removeListener.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Renders fifty components that each ask, and the answers they show. */
async function fifty() {
  const { useMobile } = await import('./useMobile')
  const Asks = () => createElement('i', null, useMobile() ? 'phone' : 'desk')
  await act(async () =>
    root.render(Array.from({ length: 50 }, (_, n) => createElement(Asks, { key: n }))),
  )
  return () => new Set([...container.querySelectorAll('i')].map((i) => i.textContent))
}

describe('useMobile', () => {
  it('asks the browser once for any number of components', async () => {
    await fifty()
    expect(matchMedia).toHaveBeenCalledTimes(1)
    expect(addListener).toHaveBeenCalledTimes(1)
  })

  it('tells every component when the breakpoint is crossed', async () => {
    const answers = await fifty()
    expect(answers()).toEqual(new Set(['desk']))
    matches = true
    await act(async () => {
      for (const listener of listening) listener()
    })
    expect(answers()).toEqual(new Set(['phone']))
  })

  it('stops listening once no component asks', async () => {
    await fifty()
    await act(async () => root.render(null))
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(listening.size).toBe(0)
  })
})

/* A phone layer that closes without its Back step, as a finished dialog
   does, leaves no entry with the page's address behind it. */
describe('useMobileBackLayer', () => {
  /** Renders layers `a` and `b` on a phone at /page, below an earlier
      /before entry. Answers a function that sets which are open. */
  async function layers() {
    matches = true
    history.pushState(null, '', '/before')
    history.pushState(null, '', '/page')
    const { useMobileBackLayer } = await import('./useMobile')
    const Layer = ({ open }: { open: boolean }) => {
      useMobileBackLayer(open, () => {})
      return null
    }
    const show = (a: boolean, b: boolean) =>
      act(async () => {
        root.render([
          createElement(Layer, { key: 'a', open: a }),
          createElement(Layer, { key: 'b', open: b }),
        ])
        // the markers are pushed after mounting
        await Promise.resolve()
      })
    await show(false, false)
    return show
  }
  /** Goes Back and waits for its popstate. */
  const back = () =>
    act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      )
      history.back()
      await popped
    })
  /** Lets a closed layer's step back over its marker land. */
  const settle = () =>
    act(async () => {
      await vi.waitFor(() => {
        if (history.state?.qivoLayer) throw new Error('marker still on top')
      })
    })

  it('steps back over the marker, so the next Back leaves the page', async () => {
    const show = await layers()
    await show(true, false)
    expect(history.state?.qivoLayer).toBeTruthy()
    await show(false, false)
    await settle()
    expect(location.pathname).toBe('/page')
    await back()
    expect(location.pathname).toBe('/before')
  })

  it("keeps the entry as the page's own when its address changed in place", async () => {
    const show = await layers()
    await show(true, false)
    history.replaceState(history.state, '', '/page/renamed')
    await show(false, false)
    await settle()
    // no step back to the address below, which the page no longer has
    expect(location.pathname).toBe('/page/renamed')
  })

  it('gives the entry to a layer that opens as the last one closes', async () => {
    const show = await layers()
    await show(true, false)
    const first = history.state?.qivoLayer
    await show(false, true)
    expect(history.state?.qivoLayer).toBeTruthy()
    expect(history.state?.qivoLayer).not.toBe(first)
    // Back closes the second layer, and the next leaves the page
    await back()
    expect(location.pathname).toBe('/page')
    expect(history.state?.qivoLayer).toBeUndefined()
    await back()
    expect(location.pathname).toBe('/before')
  })
})
