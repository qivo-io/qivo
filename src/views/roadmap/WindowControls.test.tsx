// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { DEFAULT_WIN, type RoadmapWin } from '../../lib/dates'
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

/* Types `value` into one end's relative weeks field. */
async function typeWeeks(which: 'start' | 'end', value: string) {
  const input = document.querySelector<HTMLInputElement>(`[data-win-weeks="${which}"]`)
  if (!input) throw new Error(`no ${which} weeks field`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const MOST_WEEKS = LIMITS.roadmapWeeks.max

describe('the Roadmap range picker', () => {
  it(`applies a window of ${MOST_WEEKS} weeks and refuses a wider one with a sentence`, async () => {
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
    await typeWeeks('end', String(start + MOST_WEEKS))
    expect(applied).toEqual([])
    expect(alert()?.textContent).toBe(
      'The Roadmap shows at most 260 weeks (5 years). Move the start or the end closer.',
    )
    // the field keeps what was typed
    expect(document.querySelector<HTMLInputElement>('[data-win-weeks="end"]')?.value).toBe(
      String(start + MOST_WEEKS),
    )
    await typeWeeks('end', String(start + MOST_WEEKS - 1))
    expect(applied).toEqual([
      { ...DEFAULT_WIN, end: { mode: 'weeks', value: start + MOST_WEEKS - 1 } },
    ])
    expect(alert()).toBeNull()
  })

  it('applies the pair the fields show once a refused one is corrected at the other end', async () => {
    const applied: RoadmapWin[] = []
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
    await typeWeeks('end', '300')
    await typeWeeks('start', '50')
    expect(applied).toEqual([
      { start: { mode: 'weeks', value: 50 }, end: { mode: 'weeks', value: 300 } },
    ])
    expect(document.querySelector('[data-win-too-wide]')).toBeNull()
  })
})
