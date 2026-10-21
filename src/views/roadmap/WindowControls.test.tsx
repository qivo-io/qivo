// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { DEFAULT_WIN, type RoadmapWin, WIN_TOO_WIDE, WIN_WEEKS_MAX } from '../../lib/dates'
import { WinRangePicker } from './WindowControls'

vi.mock('../../lib/convex', () => ({
  convex: { mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() },
}))
vi.mock('../../lib/auth', () => ({ armConvexAuth: vi.fn(), authClient: {}, signOut: vi.fn() }))

/* The custom range picker refuses a window wider than the Roadmap shows,
   with a sentence, instead of moving the end without a word. */

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

/* Types `value` into the end's relative weeks field. */
async function typeEndWeeks(value: string) {
  const input = document.querySelector<HTMLInputElement>('[data-win-weeks="end"]')
  if (!input) throw new Error('no end weeks field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the Roadmap range picker', () => {
  it(`applies a window of ${WIN_WEEKS_MAX} weeks and refuses a wider one with a sentence`, async () => {
    const applied: RoadmapWin[] = []
    const start = DEFAULT_WIN.start.value as number
    await act(async () =>
      root.render(
        <TooltipProvider>
          <WinRangePicker
            x={0}
            y={0}
            win={DEFAULT_WIN}
            onApply={(w) => applied.push(w)}
            onClose={() => {}}
          />
        </TooltipProvider>,
      ),
    )
    const alert = () => document.querySelector('[data-win-too-wide]')
    await typeEndWeeks(String(start + WIN_WEEKS_MAX))
    expect(applied).toEqual([])
    expect(alert()?.textContent).toBe(WIN_TOO_WIDE)
    // the field keeps what was typed
    expect(document.querySelector<HTMLInputElement>('[data-win-weeks="end"]')?.value).toBe(
      String(start + WIN_WEEKS_MAX),
    )
    await typeEndWeeks(String(start + WIN_WEEKS_MAX - 1))
    expect(applied).toEqual([
      { ...DEFAULT_WIN, end: { mode: 'weeks', value: start + WIN_WEEKS_MAX - 1 } },
    ])
    expect(alert()).toBeNull()
  })
})
