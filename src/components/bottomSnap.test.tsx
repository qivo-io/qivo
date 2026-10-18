// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* useBottomSnap keeps a thread's scroller at its end when it opens, and for
   a few seconds follows images that load and grow it, unless the reader has
   scrolled meanwhile. jsdom has no layout, so the scroller's heights are
   set by hand: 1,000 px of content in a 200 px window. */

vi.mock('../lib/convex', () => ({
  convex: { mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() },
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))

let qivo: typeof import('./qivo')
let container: HTMLDivElement
let root: Root
let scroller: HTMLDivElement
let height: number

function Thread() {
  const ref = useRef<HTMLDivElement>(null)
  qivo.useBottomSnap(ref, 'task')
  return (
    <div ref={ref} data-scroller>
      <img alt="" />
    </div>
  )
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  qivo = await import('./qivo')
  height = 1000
  // jsdom keeps scrollTop at 0, so the scroller gets a working one
  let top = 0
  Object.defineProperties(HTMLDivElement.prototype, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200))
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Thread />))
  scroller = container.querySelector<HTMLDivElement>('[data-scroller]') as HTMLDivElement
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop'])
    Reflect.deleteProperty(HTMLDivElement.prototype, name)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/* An image in the thread loads and makes it 300 px taller. */
function imageLoads() {
  height += 300
  scroller.querySelector('img')?.dispatchEvent(new Event('load'))
}

describe('useBottomSnap', () => {
  it('opens at the end and follows images that load after', () => {
    expect(scroller.scrollTop).toBe(800)
    imageLoads()
    expect(scroller.scrollTop).toBe(1100)
  })

  it('leaves a reader who scrolled up where they are', () => {
    scroller.scrollTop = 100
    scroller.dispatchEvent(new Event('scroll'))
    imageLoads()
    expect(scroller.scrollTop).toBe(100)
  })

  it('leaves a reader who scrolled up before the scroll event of a snap where they are', () => {
    imageLoads()
    // the reader moves up from the snapped end before its scroll event runs
    scroller.scrollTop = 900
    scroller.dispatchEvent(new Event('scroll'))
    imageLoads()
    expect(scroller.scrollTop).toBe(900)
  })

  it('leaves a reader who started a wheel or touch scroll where they are', () => {
    scroller.dispatchEvent(new Event('wheel'))
    imageLoads()
    expect(scroller.scrollTop).toBe(800)
  })

  it('stops following after a few seconds', () => {
    vi.advanceTimersByTime(4000)
    imageLoads()
    expect(scroller.scrollTop).toBe(800)
  })
})
