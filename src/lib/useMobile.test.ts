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
   does, leaves no entry with the page's address behind it. The page steps
   back over its marker as its own move: no other popstate listener, such
   as another layer's or App's, hears it. */
describe('useMobileBackLayer', () => {
  type Layers = Record<string, boolean | { open: boolean; onClose?: () => unknown }>
  let removeIndex = () => {}
  // what the page's own popstate listener (App's) heard, and whether it
  // stops each popstate, as App does when it refuses one
  let heard: string[] = []
  let stopping = false
  const page = (event: PopStateEvent) => {
    heard.push(location.pathname)
    if (stopping) event.stopImmediatePropagation()
  }
  // each rendered layer's close, by key
  const closes: Record<string, () => void> = {}
  beforeEach(async () => {
    // as main.tsx does before anything adds an entry
    removeIndex = (await import('./historyIndex')).installHistoryIndex()
    heard = []
    stopping = false
    window.addEventListener('popstate', page)
  })
  afterEach(() => {
    window.removeEventListener('popstate', page)
    removeIndex()
  })

  /** Renders the phone layers `which` names at /page, below an earlier
      /before entry: each key's layer, open or not, in that order. Answers
      a function that renders them again. */
  async function layers(which: Layers) {
    matches = true
    history.pushState(null, '', '/before')
    history.pushState(null, '', '/page')
    const { useMobileBackLayer } = await import('./useMobile')
    const Layer = ({
      name,
      open,
      onClose,
    }: {
      name: string
      open: boolean
      onClose?: () => unknown
    }) => {
      closes[name] = useMobileBackLayer(open, onClose ?? (() => {}))
      return null
    }
    const show = (next: Layers) =>
      act(async () => {
        root.render(
          Object.entries(next).map(([name, layer]) =>
            createElement(Layer, {
              key: name,
              name,
              ...(typeof layer === 'boolean' ? { open: layer } : layer),
            }),
          ),
        )
        // the markers are pushed after mounting
        await Promise.resolve()
      })
    await show(which)
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
  /** Lets the page's own steps and the layers waiting for them land. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)))

  it('steps back over the marker, so the next Back leaves the page', async () => {
    const show = await layers({ a: false })
    await show({ a: true })
    expect(history.state?.qivoLayer).toBeTruthy()
    await show({ a: false })
    await settle()
    expect(location.pathname).toBe('/page')
    expect(history.state?.qivoLayer).toBeUndefined()
    expect(heard).toEqual([])
    await back()
    expect(location.pathname).toBe('/before')
  })

  it('keeps an address changed in place over the marker, so the next Back still leaves', async () => {
    const show = await layers({ a: true })
    // as App names a task that left the board while its dialog was open
    history.replaceState(history.state, '', '/page/renamed')
    await show({ a: false })
    await settle()
    expect(location.pathname).toBe('/page/renamed')
    expect(history.state?.qivoLayer).toBeUndefined()
    await back()
    expect(location.pathname).toBe('/before')
  })

  it('gives the page to a layer that opens as the last one closes', async () => {
    const show = await layers({ a: true, b: false })
    const first = history.state?.qivoLayer
    await show({ a: false, b: true })
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
    expect(history.state?.qivoLayer).not.toBe(first)
    // Back closes the second layer, and the next leaves the page
    await back()
    expect(location.pathname).toBe('/page')
    expect(history.state?.qivoLayer).toBeUndefined()
    await back()
    expect(location.pathname).toBe('/before')
  })

  it('keeps a layer under a newer page entry open when a layer over that entry finishes', async () => {
    const landscape = vi.fn()
    const show = await layers({ landscape: { open: true, onClose: landscape } })
    // a task opens over it, with an entry of its own (App's url sync)
    history.pushState({ qivoPrevious: '/page' }, '', '/page/task')
    await show({ landscape: { open: true, onClose: landscape }, dialog: true })
    expect(history.state?.qivoLayer).toBeTruthy()
    await show({ landscape: { open: true, onClose: landscape }, dialog: false })
    await settle()
    expect(location.pathname).toBe('/page/task')
    expect(history.state?.qivoLayer).toBeUndefined()
    expect(landscape).not.toHaveBeenCalled()
    expect(heard).toEqual([])
    // Back closes the task, and the next one the layer under it
    await back()
    expect(location.pathname).toBe('/page')
    expect(landscape).not.toHaveBeenCalled()
    await back()
    expect(landscape).toHaveBeenCalledTimes(1)
  })

  it('steps back over two layers that close together', async () => {
    const show = await layers({ a: true, b: false })
    await show({ a: true, b: true })
    await show({ a: false, b: false })
    await settle()
    expect(location.pathname).toBe('/page')
    expect(history.state?.qivoLayer).toBeUndefined()
    await back()
    expect(location.pathname).toBe('/before')
  })

  it('lets the next layer push its marker after the page stopped a popstate', async () => {
    const show = await layers({ a: true, b: false })
    stopping = true
    await show({ a: false, b: false })
    await settle()
    await show({ a: false, b: true })
    await settle()
    expect(history.state?.qivoLayer).toBeTruthy()
  })

  it('takes no second step for a layer that unmounts while its Back step is on its way', async () => {
    await layers({ a: true })
    await act(async () => {
      closes.a()
      // the step has set out and not landed yet
      await new Promise((resolve) => setTimeout(resolve, 0))
      root.render(null)
    })
    await settle()
    expect(location.pathname).toBe('/page')
    await back()
    expect(location.pathname).toBe('/before')
  })
})
