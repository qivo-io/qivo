// @vitest-environment jsdom
import { act, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHiddenState, HiddenViewContext } from '@/lib/viewHidden'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

/* The floating layers of a kept page (lib/viewHidden.ts): an open one
   leaves while the page hides and comes back as it shows, and a closed one,
   which draws nothing, does not render for either. */

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
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const LAYERS = {
  tooltip: (open: boolean) => (
    <TooltipProvider>
      <Tooltip open={open}>
        <TooltipTrigger>Owner</TooltipTrigger>
        <TooltipContent>Change the owner</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  popover: (open: boolean) => (
    <Popover open={open}>
      <PopoverTrigger>Owner</PopoverTrigger>
      <PopoverContent>Change the owner</PopoverContent>
    </Popover>
  ),
}

/** Renders `layer` in a kept page; answers the page's hidden state and how
    many commits rendered something in it. */
async function inPage(layer: ReactNode) {
  const hidden = createHiddenState()
  const counted = { commits: 0 }
  await act(async () =>
    root.render(
      <HiddenViewContext.Provider value={hidden}>
        <Profiler id="layer" onRender={() => counted.commits++}>
          {layer}
        </Profiler>
      </HiddenViewContext.Provider>,
    ),
  )
  counted.commits = 0
  return { hidden, counted }
}

const shown = () => document.body.textContent?.includes('Change the owner')

describe.each(Object.entries(LAYERS))('a %s in a kept page', (_, layer) => {
  it('does not render, closed, as the page hides and shows', async () => {
    const { hidden, counted } = await inPage(layer(false))
    await act(async () => hidden.set(true))
    await act(async () => hidden.set(false))
    expect(counted.commits).toBe(0)
  })

  it('leaves, open, while the page hides, and comes back as it shows', async () => {
    const { hidden } = await inPage(layer(true))
    expect(shown()).toBe(true)
    await act(async () => hidden.set(true))
    expect(shown()).toBe(false)
    await act(async () => hidden.set(false))
    expect(shown()).toBe(true)
  })
})
