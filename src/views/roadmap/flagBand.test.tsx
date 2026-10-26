// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FlagView, flagBandHeight } from './flagLanes'
import { FlagBand } from './TimelineMarks'

vi.mock('../../lib/convex', () => ({
  convex: { mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() },
}))
vi.mock('../../lib/auth', () => ({ armConvexAuth: vi.fn(), authClient: {}, signOut: vi.fn() }))

/* A scrolling flag band tells the Roadmap which of its rows are in sight
   and how wide its scrollbar is, so a dragged flag stays in sight and
   labels end before the scrollbar; a band that does not scroll tells null. */

let container: HTMLDivElement
let root: Root
// the band's layout, as a browser with a 10 px scrollbar measures it
let scrollTop = 0

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  scrollTop = 0
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(950)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(flagBandHeight(2))
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop)
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

/** Renders a band of six rows in a box two rows tall and answers what it
    told the Roadmap last. */
async function band(scrolls: boolean) {
  const told: (FlagView | null)[] = []
  await act(async () =>
    root.render(
      <FlagBand
        width={960}
        height={flagBandHeight(2)}
        lanes={6}
        scrolls={scrolls}
        onView={(v) => told.push(v)}
      >
        <span />
      </FlagBand>,
    ),
  )
  return told
}

describe('FlagBand', () => {
  it('tells its rows in sight and its scrollbar, and again when scrolled', async () => {
    const told = await band(true)
    expect(told.at(-1)).toEqual({ lo: 0, hi: 1, bar: 10 })
    // a column-reverse box scrolls up into negative scrollTop
    scrollTop = -(flagBandHeight(6) - flagBandHeight(2))
    const el = container.querySelector('[data-msband]')
    await act(async () => el?.dispatchEvent(new Event('scroll')))
    expect(told.at(-1)).toEqual({ lo: 4, hi: 5, bar: 10 })
  })

  it('tells null when it does not scroll', async () => {
    const told = await band(false)
    expect(told.at(-1)).toBeNull()
    expect(container.querySelector('[data-msband-scrolls]')).toBeNull()
  })
})
