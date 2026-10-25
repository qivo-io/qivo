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

/* A phone layer that closes by itself, as a finished dialog does, moves
   nothing: its marker stays as a spare, and one Back still leaves the page,
   since the page goes on from a spare (lib/pageHistory). */
describe('useMobileBackLayer', () => {
  type Layers = Record<string, boolean | { open: boolean; onClose?: () => unknown }>
  let removeHistory = () => {}
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
    // as main.tsx does before anything adds an entry, and App after its own
    // popstate listener
    const history = await import('./pageHistory')
    const removeIndex = history.installPageHistory()
    heard = []
    stopping = false
    window.addEventListener('popstate', page)
    const stopLayers = history.listenBackLayers()
    removeHistory = () => {
      stopLayers()
      window.removeEventListener('popstate', page)
      removeIndex()
    }
  })
  afterEach(async () => {
    await act(async () => root.render(null))
    await settle()
    removeHistory()
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
  /** Goes Back and waits for a popstate that reaches App's listener. */
  const back = () =>
    act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      )
      history.back()
      await popped
    })
  /** Lets the page's moves and what waits for them land. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  const marker = () => history.state?.qivoLayer

  it("leaves a finished layer's marker as a spare, and one Back leaves the page", async () => {
    const show = await layers({ a: false })
    await show({ a: true })
    expect(marker()).toBeTruthy()
    await show({ a: false })
    await settle()
    expect(location.pathname).toBe('/page')
    expect(heard).toEqual([])
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
    expect(heard).toEqual(['/before'])
  })

  it('keeps an address changed in place over the marker, so one Back still leaves', async () => {
    const show = await layers({ a: true })
    // as App names a task that left the board while its dialog was open
    history.replaceState(history.state, '', '/page/renamed')
    await show({ a: false })
    await settle()
    expect(location.pathname).toBe('/page/renamed')
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
    history.forward()
    await settle()
    expect(location.pathname).toBe('/page/renamed')
  })

  it('gives the page to a layer that opens as the last one closes', async () => {
    const show = await layers({ a: true, b: false })
    const first = marker()
    const length = history.length
    await show({ a: false, b: true })
    await settle()
    expect(marker()).toBeTruthy()
    expect(marker()).not.toBe(first)
    expect(history.length).toBe(length)
    // Back closes the second layer, and the next leaves the page
    await back()
    expect(location.pathname).toBe('/page')
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
  })

  it('keeps a layer under a newer page entry open when a layer over that entry finishes', async () => {
    const landscape = vi.fn()
    const show = await layers({ landscape: { open: true, onClose: landscape } })
    // a task opens over it, with an entry of its own (App's url sync)
    history.pushState({ qivoPrevious: '/page' }, '', '/page/task')
    await show({ landscape: { open: true, onClose: landscape }, dialog: true })
    expect(marker()).toBeTruthy()
    await show({ landscape: { open: true, onClose: landscape }, dialog: false })
    await settle()
    expect(location.pathname).toBe('/page/task')
    expect(landscape).not.toHaveBeenCalled()
    expect(heard).toEqual([])
    // Back closes the task, and the next one the layer under it
    await back()
    await settle()
    expect(location.pathname).toBe('/page')
    expect(landscape).not.toHaveBeenCalled()
    await back()
    expect(landscape).toHaveBeenCalledTimes(1)
  })

  it("leaves alone the person's move that lands before the layer closes", async () => {
    const show = await layers({ a: true })
    // a pick from the browser's Back menu, which the page did not start
    History.prototype.go.call(history, -2)
    await show({ a: false })
    await settle()
    expect(heard).toEqual(['/before'])
    expect(location.pathname).toBe('/before')
  })

  it('leaves two spares for two layers that close together, and one Back leaves the page', async () => {
    const show = await layers({ a: true, b: false })
    await show({ a: true, b: true })
    await show({ a: false, b: false })
    await settle()
    expect(location.pathname).toBe('/page')
    expect(marker()).toBeTruthy()
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
  })

  it('lets the next layer push its marker after the page stopped a popstate', async () => {
    const show = await layers({ a: true, b: false })
    stopping = true
    await show({ a: false, b: false })
    await settle()
    await show({ a: false, b: true })
    await settle()
    expect(marker()).toBeTruthy()
  })

  it('runs a repeated close once and takes no history step', async () => {
    const onClose = vi.fn()
    await layers({ a: { open: true, onClose } })
    await act(async () => {
      closes.a()
      closes.a()
    })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(heard).toEqual([])
  })

  it('runs a repeated close once while another layer has just finished', async () => {
    const onClose = vi.fn()
    const show = await layers({ a: { open: true, onClose }, b: true })
    await show({ a: { open: true, onClose }, b: false })
    await act(async () => {
      closes.a()
      closes.a()
    })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(heard).toEqual([])
  })

  it("runs onClose once when a close and the person's Back arrive together", async () => {
    const onClose = vi.fn()
    const show = await layers({ a: { open: true, onClose }, b: true })
    // b finishes, then a closes as the person presses Back
    await show({ a: { open: true, onClose }, b: false })
    await act(async () => {
      closes.a()
      history.back()
    })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks for each refused close, keeps the marker, and takes no history step', async () => {
    // a dialog holding unsent text asks instead of closing
    const onClose = vi.fn(() => false)
    await layers({ a: { open: true, onClose } })
    await act(async () => {
      closes.a()
      closes.a()
    })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(heard).toEqual([])
    expect(marker()).toBeTruthy()
    // the system Back asks too, and the marker comes back
    await back()
    await settle()
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(marker()).toBeTruthy()
    expect(location.pathname).toBe('/page')
  })

  it('takes no step for a layer that unmounts right after its close', async () => {
    await layers({ a: true })
    await act(async () => {
      closes.a()
      await new Promise((resolve) => setTimeout(resolve, 0))
      root.render(null)
    })
    await settle()
    expect(location.pathname).toBe('/page')
    expect(heard).toEqual([])
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
  })

  it.each([
    ['the dialog closes itself', false],
    ["the person's Back closes it", true],
  ])('lands on the address changed in place under a dialog when %s', async (_, byBack) => {
    const show = await layers({ a: true })
    history.replaceState(history.state, '', '/page/renamed')
    if (byBack) await back()
    else await act(async () => closes.a())
    await settle()
    expect(location.pathname).toBe('/page/renamed')
    expect(heard).toEqual(byBack ? ['/page/renamed'] : [])
    await show({ a: false })
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
  })

  it("after a reload on a dialog's marker, one Back leaves the page", async () => {
    await layers({ a: true })
    expect(marker()).toBeTruthy()
    // a new document on the same history, as after a reload
    removeHistory()
    root.unmount()
    root = createRoot(container)
    vi.resetModules()
    const reloaded = await import('./pageHistory')
    const removeIndex = reloaded.installPageHistory()
    window.addEventListener('popstate', page)
    const stopLayers = reloaded.listenBackLayers()
    removeHistory = () => {
      stopLayers()
      window.removeEventListener('popstate', page)
      removeIndex()
    }
    await back()
    await settle()
    expect(location.pathname).toBe('/before')
  })

  it('keeps a layer open when the person goes Forward onto an entry added over it, and Back returns to it', async () => {
    const landscape = vi.fn()
    await layers({ landscape: { open: true, onClose: landscape } })
    // a task opened from the landscape timeline, with an entry of its own
    history.pushState({ qivoPrevious: '/page' }, '', '/page/task')
    await back()
    await settle()
    expect(location.pathname).toBe('/page')
    history.forward()
    await settle()
    expect(location.pathname).toBe('/page/task')
    expect(landscape).not.toHaveBeenCalled()
    await back()
    await settle()
    expect(landscape).not.toHaveBeenCalled()
    await back()
    expect(landscape).toHaveBeenCalledTimes(1)
  })
})
