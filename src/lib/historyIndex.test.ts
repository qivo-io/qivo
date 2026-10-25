// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterTraversal, installHistoryIndex, lastStep, position, stepBack } from './historyIndex'

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

/* The page's own steps are bookkeeping: the index records them, and no
   other popstate listener hears one. Code that reads history.state to
   decide a move waits for the page's moves to land. */
describe("the page's own moves", () => {
  it('records its own step, which no later listener hears', async () => {
    remove = installHistoryIndex()
    history.pushState(null, '', '/app/g')
    history.pushState({ qivoLayer: 'x' }, '', '/app/g')
    const start = position()
    const later = vi.fn()
    window.addEventListener('popstate', later)
    try {
      expect(await stepBack(1)).toBe(true)
      expect(position()).toBe(start - 1)
      expect(history.state?.qivoLayer).toBeUndefined()
      expect(later).not.toHaveBeenCalled()
      // the next move is the person's again
      await go(-1)
      expect(later).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('popstate', later)
    }
  })

  it("hands a move that lands elsewhere before its own step to later listeners, as the person's", async () => {
    remove = installHistoryIndex()
    history.pushState(null, '', '/app/j')
    history.pushState(null, '', '/app/k')
    history.pushState({ qivoLayer: 'x' }, '', '/app/k')
    const heard: string[] = []
    const later = () => heard.push(location.pathname)
    window.addEventListener('popstate', later)
    try {
      // a pick from the browser's Back menu, which the page did not start
      History.prototype.go.call(history, -2)
      expect(await stepBack(1)).toBe(false)
      expect(heard).toEqual(['/app/j'])
      // the page's own step still lands after it
      await vi.waitFor(() => expect(heard).toHaveLength(2))
    } finally {
      window.removeEventListener('popstate', later)
    }
  })

  it('runs what waits once a move the page started has landed', async () => {
    remove = installHistoryIndex()
    history.pushState(null, '', '/app/h')
    history.pushState(null, '', '/app/i')
    const read: string[] = []
    history.back()
    afterTraversal(() => read.push(location.pathname))
    expect(read).toEqual([])
    await vi.waitFor(() => expect(read).toEqual(['/app/h']))
  })

  it('stops waiting for a move that never lands', async () => {
    remove = installHistoryIndex()
    const ran = vi.fn()
    // past the start of the history: no popstate comes
    history.go(-1000)
    afterTraversal(ran)
    expect(ran).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ran).toHaveBeenCalled(), { timeout: 2000 })
  })
})
