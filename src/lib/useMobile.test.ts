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
