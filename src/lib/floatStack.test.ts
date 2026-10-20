// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The page makes room for the floating notices (lib/floatStack). jsdom has
   no layout, so the test gives the slots their boxes and fires the resize
   observer itself. */

let observed: () => void = () => {}
let stack: typeof import('./floatStack')

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('innerHeight', 900)
  stack = await import('./floatStack')
})

afterEach(() => {
  document.querySelector('[data-float-stack]')?.remove()
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
})

/** Gives `slot` a box from `top` to `bottom` and lets the column measure. */
function place(slot: 'toasts' | 'update' | 'snapshot', top: number, bottom: number) {
  const element = stack.floatSlot(slot)
  element.getBoundingClientRect = () => ({ top, bottom, height: bottom - top }) as DOMRect
  observed()
}

const band = (side: 'top' | 'bottom') =>
  document.documentElement.style.getPropertyValue(`--float-inset-${side}`)

describe('the notices’ bands', () => {
  it('leave the bottom band free under a desktop notice, and give it back when it goes', () => {
    place('snapshot', 784, 884)
    expect([band('top'), band('bottom')]).toEqual(['0px', '116px'])
    place('snapshot', 0, 0)
    expect([band('top'), band('bottom')]).toEqual(['0px', '0px'])
  })

  it('leave the top band free over the notices on a phone', () => {
    place('update', 16, 120)
    place('snapshot', 120, 220)
    expect([band('top'), band('bottom')]).toEqual(['220px', '0px'])
  })

  it('count only the part of the notices their shared box shows', () => {
    place('update', 16, 144)
    const notices = document.querySelector<HTMLElement>('[data-float-notices]')
    if (!notices) throw new Error('no notices box')
    // the box stops short of the snapshot notice, which scrolls inside it
    notices.getBoundingClientRect = () => ({ top: 16, bottom: 400, height: 384 }) as DOMRect
    place('snapshot', 152, 560)
    expect([band('top'), band('bottom')]).toEqual(['400px', '0px'])
    expect(notices.contains(stack.floatSlot('snapshot'))).toBe(true)
    expect(notices.contains(stack.floatSlot('toasts'))).toBe(false)
  })

  it('take no room for toasts', () => {
    place('toasts', 700, 760)
    expect(band('bottom')).toBe('')
  })

  it('never take more than half the window', () => {
    expect(stack.noticeInsets({ top: 100, bottom: 884 }, 900)).toEqual({ top: 0, bottom: 450 })
    expect(stack.noticeInsets({ top: 16, bottom: 700 }, 900)).toEqual({ top: 450, bottom: 0 })
    expect(stack.noticeInsets(null, 900)).toEqual({ top: 0, bottom: 0 })
  })

  it('leave the visible viewport alone once it has panned past the top band', () => {
    const band = { top: 120, bottom: 0 }
    // the whole window is visible: the task starts under the notices
    expect(stack.roomBeside({ top: 0, height: 800 }, band, 800)).toEqual({ top: 120, height: 680 })
    // the keyboard panned the visible part to 400..700, under the band
    expect(stack.roomBeside({ top: 400, height: 300 }, band, 800)).toEqual({
      top: 400,
      height: 300,
    })
    // the visible part still holds the band's lower 20 px
    expect(stack.roomBeside({ top: 100, height: 300 }, band, 800)).toEqual({
      top: 120,
      height: 280,
    })
    // without a bottom band, a window height the keyboard shrank is ignored
    expect(stack.roomBeside({ top: 350, height: 450 }, { top: 0, bottom: 0 }, 450)).toEqual({
      top: 350,
      height: 450,
    })
    // a bottom band past the visible part takes nothing either
    expect(stack.roomBeside({ top: 0, height: 500 }, { top: 0, bottom: 100 }, 800)).toEqual({
      top: 0,
      height: 500,
    })
  })
})
