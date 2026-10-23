// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasTooltip } from '@/lib/passEscapeOn'
import { HoverTooltip, TooltipProvider } from './tooltip'

let container: HTMLDivElement
let root: Root

/* The tooltip's animations as a browser runs them: the content plays
   `enter` while open and `exit` once closed, and none under the class that
   skips them. jsdom applies no stylesheet, so its computed style is this. */
const animationOf = (element: Element) =>
  element.className.includes('!animate-none')
    ? 'none'
    : element.getAttribute('data-state') === 'closed'
      ? 'exit'
      : 'enter'

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
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (value: string) => value })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (!element.matches('[data-slot="tooltip-content"]')) return computed(element, pseudo)
    // live, as the browser's is
    return new Proxy(computed(element, pseudo), {
      get: (style, key) =>
        key === 'animationName' ? animationOf(element) : Reflect.get(style, key, style),
    })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const content = () => document.querySelector('[data-slot="tooltip-content"]')

/* Ends the closing animation the way the browser does: an exit animation
   the content still plays ends, and one a class removed was cancelled. */
async function endExitAnimation() {
  const element = content()
  if (!element) return
  const type = animationOf(element) === 'exit' ? 'animationend' : 'animationcancel'
  await act(async () => {
    element.dispatchEvent(Object.assign(new Event(type), { animationName: 'exit' }))
  })
}

const pressEscape = (target: Element) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })

describe('HoverTooltip', () => {
  it('leaves, and passes Escape on once, when Escape comes while it closes', async () => {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <HoverTooltip content="Change assignee">
            <button type="button">Owner</button>
          </HoverTooltip>
          <button type="button">Title</button>
        </TooltipProvider>,
      ),
    )
    const [owner, title] = container.querySelectorAll('button')
    const passed: string[] = []
    const record = (event: KeyboardEvent) => passed.push(event.key)
    window.addEventListener('keydown', record)
    // a handler that sees the press beside the tooltip's own (an inline
    // editor's) defers to the tooltip and acts on the press passed on
    const acted: string[] = []
    const editor = (event: KeyboardEvent) => {
      if (!hasTooltip()) acted.push(event.key)
    }
    document.addEventListener('keydown', editor, { capture: true })
    await act(async () => owner.focus())
    expect(content()?.getAttribute('data-state')).toBe('instant-open')
    // focus leaves: the tooltip closes and plays its exit animation
    await act(async () => title.focus())
    expect(content()?.getAttribute('data-state')).toBe('closed')
    await pressEscape(title)
    await endExitAnimation()
    expect(content()).toBeNull()
    // passEscapeOn sends the press on once the tooltip is gone
    await act(() => vi.waitFor(() => expect(passed).toEqual(['Escape'])))
    window.removeEventListener('keydown', record)
    document.removeEventListener('keydown', editor, { capture: true })
    expect(acted).toEqual(['Escape'])
  })

  it('closes at once on Escape while it shows', async () => {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <HoverTooltip content="Change assignee">
            <button type="button">Owner</button>
          </HoverTooltip>
        </TooltipProvider>,
      ),
    )
    const owner = container.querySelector('button') as HTMLButtonElement
    await act(async () => owner.focus())
    expect(content()?.getAttribute('data-state')).toBe('instant-open')
    await pressEscape(owner)
    // no exit animation to wait for
    expect(content()).toBeNull()
  })
})
