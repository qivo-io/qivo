// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterTraversal, installHistoryIndex, lastStep, position, stepBack } from './historyIndex'
import { createUnsentScope } from './leaveGuard'
import { createPopRefusal } from './popRefusal'

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
      await new Promise((resolve) => setTimeout(resolve, 30))
      // jsdom lands the page's own step where it aimed from, after the
      // pick, and the page then steps back to the entry the person picked
      expect(heard).toEqual(['/app/j'])
      expect(location.pathname).toBe('/app/j')
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

/** A window on `url` whose history counts each move's distance from the
    entry it is on when the move runs, after the moves before it landed, as
    browsers do (the HTML spec's "traverse the history by a delta"). jsdom
    counts it from the entry it was on when the page called go. `pick`
    moves to the entry at `index`, as the browser's Back menu does. */
function browserWindow(url: string) {
  const win = new EventTarget()
  const entries: { state: unknown; url: string }[] = [{ state: null, url }]
  let index = 0
  let queue = Promise.resolve()
  const traverse = (target: () => number) => {
    queue = queue.then(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            const to = target()
            if (to !== index && to >= 0 && to < entries.length) {
              index = to
              win.dispatchEvent(new PopStateEvent('popstate', { state: entries[to].state }))
            }
            resolve()
          }, 0),
        ),
    )
  }
  // methods on the prototype, as on History, which the index's removal restores
  class BrowserHistory {
    get state() {
      return entries[index].state
    }
    pushState(state: unknown, _: string, next = entries[index].url) {
      entries.splice(index + 1, entries.length, { state, url: next })
      index += 1
    }
    replaceState(state: unknown, _: string, next = entries[index].url) {
      entries[index] = { state, url: next }
    }
    go(delta = 0) {
      traverse(() => index + delta)
    }
    back() {
      this.go(-1)
    }
    forward() {
      this.go(1)
    }
  }
  const history = new BrowserHistory()
  return {
    window: Object.assign(win, { history }) as unknown as Window,
    history: history as unknown as History,
    /** The current entry's address. */
    here: () => entries[index].url,
    pick: (to: number) => traverse(() => to),
  }
}

/* In a browser a step of the page's own that the person's move overtook
   lands past the person's entry, so the page steps back to it. */
describe("a person's move that overtakes the page's own step", () => {
  /** A browser window on `urls`, the index over it from the first, and
      phone layers' markers over the last, `layers` deep. */
  function overMarkers(urls: string[], layers: number) {
    const browser = browserWindow(urls[0])
    remove = installHistoryIndex(browser.window)
    for (const url of urls.slice(1)) browser.history.pushState(null, '', url)
    for (let n = 0; n < layers; n += 1) browser.history.pushState({ qivoLayer: n }, '')
    return browser
  }
  /** The addresses a listener added now hears popstates at. */
  function hear({ window: win, here }: ReturnType<typeof browserWindow>) {
    const heard: string[] = []
    win.addEventListener('popstate', () => heard.push(here()))
    return heard
  }
  /** Lets every move on its way land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  it.each([
    [1, ['/start', '/before', '/page']],
    [2, ['/start', '/older', '/before', '/page']],
  ])('keeps the person on their pick over %i markers, heard once', async (layers, urls) => {
    const browser = overMarkers(urls, layers)
    const heard = hear(browser)
    // a pick from the Back menu, queued before the page's own step
    browser.pick(urls.indexOf('/before'))
    expect(await stepBack(layers)).toBe(false)
    await settle()
    expect(heard).toEqual(['/before'])
    expect(browser.here()).toBe('/before')
    expect(position()).toBe(urls.indexOf('/before'))
  })

  it('stops waiting for an overtaken step that lands past the start of the history', async () => {
    const browser = overMarkers(['/before', '/page'], 2)
    const heard = hear(browser)
    browser.pick(0)
    expect(await stepBack(2)).toBe(false)
    expect(heard).toEqual(['/before'])
    expect(browser.here()).toBe('/before')
    const ran = vi.fn()
    afterTraversal(ran)
    expect(ran).toHaveBeenCalled()
  })

  it('steps a refused pick back to the entry the page aimed for, and asks there', async () => {
    const browser = overMarkers(['/start', '/older', '/before', '/page'], 2)
    const scope = createUnsentScope()
    scope.hold('comment')
    const ask = vi.fn()
    // App's listener, the first after the index's
    const refusal = createPopRefusal(ask, browser.history)
    browser.window.addEventListener('popstate', (event) => {
      if (event instanceof PopStateEvent && !refusal.landed(event)) refusal.refuse(event, [scope])
    })
    const heard = hear(browser)
    browser.pick(2)
    await stepBack(2)
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    // the page's own entry, not the marker the person picked from
    expect(browser.here()).toBe('/page')
    expect(position()).toBe(3)
    expect(browser.history.state?.qivoLayer).toBeUndefined()
    expect(heard).toEqual([])
  })
})
