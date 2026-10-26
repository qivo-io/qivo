// @vitest-environment jsdom
import { Activity, act, type ComponentProps, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasTooltip } from '@/lib/passEscapeOn'
import { HoverTooltip, TooltipProvider } from './tooltip'

/* passEscapeOn sends each Escape a tooltip takes on a frame or two and a
   timer later. Each test waits for every one it started (afterEach), so
   none reaches the next test or fires once the file's DOM is gone. Every
   tooltip here leaves after its Escape, so each pass-on ends by sending. */
const passOns = vi.hoisted(() => ({ started: 0, sent: 0 }))
vi.mock('@/lib/passEscapeOn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passEscapeOn')>()
  return {
    ...actual,
    passEscapeOn: (...args: Parameters<typeof actual.passEscapeOn>) => {
      passOns.started++
      actual.passEscapeOn(...args)
    },
  }
})
// the Escapes the tests press themselves, which no pass-on sent
const pressed = new WeakSet<Event>()
const countPassedOn = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !pressed.has(event)) passOns.sent++
}

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
  passOns.started = 0
  passOns.sent = 0
  // capture on window sees a passed-on Escape before anything can stop it
  window.addEventListener('keydown', countPassedOn, { capture: true })
})

afterEach(async () => {
  try {
    await act(() => vi.waitFor(() => expect(passOns.sent).toBe(passOns.started)))
  } finally {
    // a pass-on that never came fails its own test, not the ones after it
    window.removeEventListener('keydown', countPassedOn, { capture: true })
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
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
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    pressed.add(event)
    target.dispatchEvent(event)
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
  it('does not render again as a kept page hides and shows, and still opens after', async () => {
    // the target renders each time the tooltip's trigger renders
    let renders = 0
    const Owner = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(
      function Owner(props, ref) {
        renders++
        return (
          <button ref={ref} type="button" {...props}>
            Owner
          </button>
        )
      },
    )
    // one element throughout, so only the tooltip's own updates render it
    const tooltip = (
      <HoverTooltip content="Change assignee">
        <Owner />
      </HoverTooltip>
    )
    const page = (mode: 'visible' | 'hidden') =>
      act(async () =>
        root.render(
          <TooltipProvider>
            <Activity mode={mode}>{tooltip}</Activity>
          </TooltipProvider>,
        ),
      )
    await page('visible')
    renders = 0
    await page('hidden')
    await page('visible')
    expect(renders).toBe(0)
    const owner = container.querySelector('button') as HTMLButtonElement
    await act(async () => owner.focus())
    expect(content()?.getAttribute('data-state')).toBe('instant-open')
  })
})
