// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installHistoryIndex, lastStep, position } from './historyIndex'

/* Every entry knows its position, so a refused Back or Forward can step
   back by the same distance instead of adding an entry. */

let remove = () => {}
afterEach(() => remove())

/** Moves `delta` entries and waits for the popstate. */
const go = (delta: number) =>
  new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    history.go(delta)
  })

describe('history positions', () => {
  it('stamps each entry and records how far Back and Forward moved', async () => {
    remove = installHistoryIndex()
    const start = position()
    history.pushState({ qivoPrevious: '/a' }, '', '/app/b')
    history.pushState(null, '', '/app/c')
    history.replaceState({ qivoLayer: 'x' }, '', '/app/c')
    expect(history.state).toEqual({ qivoLayer: 'x', qivoAt: start + 2 })
    await go(-2)
    expect(lastStep()).toBe(-2)
    expect(position()).toBe(start)
    await go(1)
    expect(lastStep()).toBe(1)
    expect(history.state).toEqual({ qivoPrevious: '/a', qivoAt: start + 1 })
    // a new entry after going back takes the next position
    history.pushState(null, '', '/app/d')
    expect(position()).toBe(start + 2)
  })

  it('knows no step for an entry without a position', async () => {
    // both added before the index was installed, as by a page before it
    history.pushState(null, '', '/app/e')
    history.pushState(null, '', '/app/f')
    remove = installHistoryIndex()
    await go(-1)
    expect(lastStep()).toBeNull()
  })
})
