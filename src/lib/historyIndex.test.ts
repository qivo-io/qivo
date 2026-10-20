// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installHistoryIndex, stepTo } from './historyIndex'

/* Every entry knows its position, so a refused Back or Forward can step
   back by the same distance instead of adding an entry. */

let remove = () => {}
afterEach(() => remove())

/** Waits for the popstate a history.go causes, and answers its state. */
const popped = () =>
  new Promise<unknown>((resolve) =>
    window.addEventListener('popstate', (event) => resolve(event.state), { once: true }),
  )

describe('history positions', () => {
  it('stamps each entry and tells how far Back and Forward moved', async () => {
    remove = installHistoryIndex()
    history.pushState({ qivoPrevious: '/a' }, '', '/app/b')
    history.pushState(null, '', '/app/c')
    history.replaceState({ qivoLayer: 'x' }, '', '/app/c')
    expect(history.state).toEqual({ qivoLayer: 'x', qivoAt: 2 })

    let back = popped()
    history.go(-2)
    expect(stepTo(await back)).toBe(-2)
    back = popped()
    history.go(1)
    expect(stepTo(await back)).toBe(1)
    expect(history.state).toEqual({ qivoPrevious: '/a', qivoAt: 1 })
    // a new entry after going back takes the next position
    history.pushState(null, '', '/app/d')
    expect(history.state.qivoAt).toBe(2)
  })

  it('knows no step for an entry without a position', () => {
    expect(stepTo(null)).toBeNull()
    expect(stepTo({ qivoPrevious: '/a' })).toBeNull()
  })
})
