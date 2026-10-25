// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserWindow, settleMoves } from './historyDouble.setup'
import { createUnsentScope } from './leaveGuard'
import {
  finishLayer,
  historyBusy,
  installPageHistory,
  listenBackLayers,
  onHistorySettled,
  openLayer,
  pushPage,
  reloadPage,
} from './pageHistory'
import { createPopRefusal } from './popRefusal'

/* A refused Back or Forward returns to the entry it left, by key with the
   Navigation API and by position without it, keeps the entries on both
   sides, hides both popstates from later listeners, asks only once it is
   back, and takes the move again after Discard. */

let remove = () => {}
afterEach(() => remove())

/** A window on `urls`, on the entry at `at`, in `engine`'s order (none
    without the Navigation API), with an App-like listener that refuses
    while its scope holds text, and a later listener, as the phone layers'
    is. */
async function refusing(
  urls: string[],
  at: number,
  engine?: 'chromium' | 'firefox' | 'webkit' | 'ios',
) {
  const browser = browserWindow(urls[0], engine)
  const removeHistory = installPageHistory(browser.window)
  for (const url of urls.slice(1)) pushPage({}, url)
  if (at !== urls.length - 1) {
    browser.person.pick(at)
    await settleMoves()
  }
  const scope = createUnsentScope()
  scope.hold('comment')
  let discard = () => {}
  const ask = vi.fn((_: unknown, go: () => void) => {
    discard = go
  })
  const refusal = createPopRefusal(ask)
  const applied: string[] = []
  browser.window.addEventListener('popstate', (event) => {
    if (!(event instanceof PopStateEvent)) return
    if (scope.held().length && refusal.refuse(event, [scope])) return
    refusal.accepted()
    applied.push(browser.here())
  })
  const later = vi.fn()
  browser.window.addEventListener('popstate', later)
  const stopLayers = listenBackLayers(browser.window)
  remove = () => {
    stopLayers()
    removeHistory()
  }
  return { ...browser, scope, ask, applied, later, discard: () => discard() }
}

describe.each(['chromium', 'firefox', 'webkit'] as const)(
  'a refused Back or Forward in %s',
  (engine) => {
    it('returns to the page shown by key, unheard, and asks there', async () => {
      const browser = await refusing(['/a', '/b', '/c'], 1, engine)
      browser.person.back()
      await settleMoves()
      expect(browser.ask).toHaveBeenCalledTimes(1)
      expect(browser.here()).toBe('/b')
      expect(browser.applied).toEqual([])
      expect(browser.later).not.toHaveBeenCalled()
      expect(historyBusy()).toBe(false)
      // Keep editing: the entries on both sides are still there
      browser.scope.discard()
      browser.person.forward()
      await settleMoves()
      expect(browser.here()).toBe('/c')
      browser.person.pick(0)
      await settleMoves()
      expect(browser.here()).toBe('/a')
    })

    it('takes the refused move again after Discard', async () => {
      const browser = await refusing(['/a', '/b', '/c'], 1, engine)
      browser.person.forward()
      await settleMoves()
      expect(browser.here()).toBe('/b')
      browser.scope.discard()
      browser.discard()
      await settleMoves()
      expect(browser.here()).toBe('/c')
      expect(browser.applied).toEqual(['/c'])
    })

    it('keeps one return on its way for two refused moves, lands it on the page shown and asks once', async () => {
      const browser = await refusing(['/a', '/b', '/c', '/d'], 3, engine)
      // a second Back before the return has run
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(browser.ask).toHaveBeenCalledTimes(1)
      expect(browser.here()).toBe('/d')
      expect(browser.urls()).toEqual(['/a', '/b', '/c', '/d'])
      expect(browser.later).not.toHaveBeenCalled()
      // Discard takes the latest refused move
      browser.scope.discard()
      browser.discard()
      await settleMoves()
      expect(browser.here()).toBe('/b')
    })

    it('keeps the entries and the page in step after a refused pick and a refused Forward, and Discard takes the Forward', async () => {
      const browser = await refusing(['/older', '/middle', '/task'], 2, engine)
      // the task's finished dialog left its spare on top
      const dialog = openLayer(() => {})
      await Promise.resolve()
      finishLayer(dialog)
      // the first entry from the Back menu, then Forward, both before the
      // return has run
      browser.person.pick(0)
      browser.person.forward()
      await settleMoves()
      expect(browser.ask).toHaveBeenCalledTimes(1)
      expect(browser.urls()).toEqual(['/older', '/middle', '/task', '/task'])
      expect(browser.index()).toBe(3)
      expect(browser.reloads()).toBe(0)
      browser.scope.discard()
      browser.discard()
      await settleMoves()
      expect(browser.here()).toBe('/middle')
      expect(browser.reloads()).toBe(0)
    })

    it('takes a Forward to the page shown, merged with the return, as the return, and asks once', async () => {
      const browser = await refusing(['/e1', '/e2', '/e3', '/e4', '/e5'], 3, engine)
      // Back, refused, and Forward to the page shown before the return runs
      browser.person.back()
      browser.person.forward()
      await settleMoves()
      expect(browser.ask).toHaveBeenCalledTimes(1)
      expect(browser.here()).toBe('/e4')
      // WebKit turns the merged return into a reload, which the page cancels
      expect(browser.reloads()).toBe(0)
      expect(browser.later).not.toHaveBeenCalled()
      browser.scope.discard()
      browser.person.forward()
      await settleMoves()
      expect(browser.here()).toBe('/e5')
      browser.person.back()
      await settleMoves()
      expect(browser.here()).toBe('/e4')
    })

    it("lets the browser's Reload and a script's reload through after Keep editing", async () => {
      const browser = await refusing(['/a', '/b', '/c'], 2, engine)
      browser.person.back()
      await settleMoves()
      expect(browser.ask).toHaveBeenCalledTimes(1)
      browser.window.location.reload()
      expect(browser.reloads()).toBe(1)
      await settleMoves()
      browser.person.reload()
      expect(browser.reloads()).toBe(2)
    })

    it('answers false for a popstate that moved nothing, so App puts the page back itself', async () => {
      const browser = await refusing(['/a', '/b', '/c'], 1, engine)
      const refusal = createPopRefusal(vi.fn())
      const answers: boolean[] = []
      browser.window.addEventListener('popstate', (event) => {
        if (event instanceof PopStateEvent) answers.push(refusal.refuse(event, [browser.scope]))
      })
      // a popstate onto the entry the page was on, which no return can undo
      browser.window.dispatchEvent(new PopStateEvent('popstate'))
      await settleMoves()
      expect(answers).toEqual([false])
      expect(browser.here()).toBe('/b')
      expect(historyBusy()).toBe(false)
    })

    it('lands the return heard when the app takes a move that came first', async () => {
      const browser = browserWindow('/a', engine)
      remove = installPageHistory(browser.window)
      for (const url of ['/b', '/c']) pushPage({}, url)
      const ask = vi.fn()
      const refusal = createPopRefusal(ask)
      const scope = createUnsentScope()
      scope.hold('comment')
      const applied: string[] = []
      let refusals = 1
      browser.window.addEventListener('popstate', (event) => {
        if (refusals && event instanceof PopStateEvent && refusal.refuse(event, [scope])) {
          refusals -= 1
          return
        }
        refusal.accepted()
        applied.push(browser.here())
      })
      // the first Back is refused, the second, before the return runs, taken
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(ask).not.toHaveBeenCalled()
      expect(applied.at(-1)).toBe('/c')
      expect(browser.here()).toBe('/c')
      expect(historyBusy()).toBe(false)
    })
  },
)

describe('a return that a move the app took overtook', () => {
  it.each(['chromium', 'webkit', 'firefox'] as const)(
    'lands heard, with no going-on, when that move reached a spare of the page shown, in %s',
    async (engine) => {
      const browser = browserWindow('/a', engine)
      const removeHistory = installPageHistory(browser.window)
      pushPage({}, '/x')
      const stopLayers = listenBackLayers(browser.window)
      remove = () => {
        stopLayers()
        removeHistory()
      }
      // a dialog over /x closed by itself; the person left /x and came back
      const dialog = openLayer(() => {})
      await Promise.resolve()
      finishLayer(dialog)
      browser.person.back()
      await settleMoves()
      browser.person.forward()
      await settleMoves()
      expect(browser.urls()).toEqual(['/a', '/x', '/x'])
      expect(browser.index()).toBe(1)
      const scope = createUnsentScope()
      scope.hold('comment')
      const ask = vi.fn()
      const refusal = createPopRefusal(ask)
      browser.window.addEventListener('popstate', (event) => {
        if (!(event instanceof PopStateEvent)) return
        if (browser.here() !== '/x' && refusal.refuse(event, [scope])) return
        refusal.accepted()
      })
      // a refused Back, then a pick of the spare before the return runs
      browser.person.back()
      browser.person.pick(2)
      await settleMoves()
      expect(browser.here()).toBe('/x')
      expect(ask).not.toHaveBeenCalled()
      expect(historyBusy()).toBe(false)
    },
  )
})

describe.each(['webkit', 'ios'] as const)('WebKit, %s', (engine) => {
  it('cancels the reload of each of two merged returns', async () => {
    const browser = await refusing(['/e1', '/e2', '/e3', '/e4', '/e5'], 3, engine)
    // Back, Forward, Back, Forward, all before the first return runs
    browser.person.back()
    browser.person.forward()
    browser.person.back()
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/e4')
    expect(browser.reloads()).toBe(0)
    expect(browser.urls()).toEqual(['/e1', '/e2', '/e3', '/e4', '/e5'])
  })

  it("lets the app's own reload through while a merged return may still run once more", async () => {
    const browser = await refusing(['/a', '/b', '/c'], 2, engine)
    browser.person.back()
    await settleMoves()
    reloadPage()
    expect(browser.reloads()).toBe(1)
  })
})

describe('WebKit on a phone, which fires no beforeunload', () => {
  it("cancels a script's reload after a return until the page pushes an entry", async () => {
    const browser = await refusing(['/a', '/b', '/c'], 2, 'ios')
    browser.person.back()
    await settleMoves()
    // a known limit: it cannot be told from a merged return's reload
    browser.window.location.reload()
    expect(browser.reloads()).toBe(0)
    pushPage({}, '/d')
    browser.window.location.reload()
    expect(browser.reloads()).toBe(1)
  })
})

describe('without the Navigation API', () => {
  it('returns to the page shown by position, unheard, asks there, and keeps the entries on both sides', async () => {
    const browser = await refusing(['/a', '/b', '/c'], 1)
    browser.person.back()
    await settleMoves()
    expect(browser.ask).toHaveBeenCalledTimes(1)
    expect(browser.here()).toBe('/b')
    expect(browser.applied).toEqual([])
    expect(browser.later).not.toHaveBeenCalled()
    expect(historyBusy()).toBe(false)
    expect(browser.urls()).toEqual(['/a', '/b', '/c'])
    // Keep editing: Forward still reaches the next page
    browser.scope.discard()
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/c')
  })

  it('keeps the forward history after a refused Forward, and Discard takes the Forward', async () => {
    const browser = await refusing(['/a', '/b', '/c', '/d'], 1)
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/b')
    expect(browser.urls()).toEqual(['/a', '/b', '/c', '/d'])
    browser.scope.discard()
    browser.discard()
    await settleMoves()
    expect(browser.here()).toBe('/c')
    expect(browser.applied).toEqual(['/c'])
  })

  it('takes a second Back that lands before the return as the move, and returns from it', async () => {
    const browser = await refusing(['/a', '/b', '/c', '/d'], 3)
    // a second Back before the return has run
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/d')
    expect(browser.urls()).toEqual(['/a', '/b', '/c', '/d'])
    expect(historyBusy()).toBe(false)
  })

  it.each([
    ['two Backs', ['back', 'back']],
    ['three Backs', ['back', 'back', 'back']],
  ] as const)(
    'returns to the page shown after %s refused before the return ran, with entries on both sides, and asks once',
    async (_, moves) => {
      const browser = await refusing(['/a', '/b', '/task', '/d', '/e'], 2)
      for (const move of moves) browser.person[move]()
      await settleMoves()
      expect(browser.here()).toBe('/task')
      expect(browser.ask).toHaveBeenCalledTimes(1)
      expect(browser.applied).toEqual([])
      expect(browser.later).not.toHaveBeenCalled()
      expect(historyBusy()).toBe(false)
      expect(browser.urls()).toEqual(['/a', '/b', '/task', '/d', '/e'])
    },
  )

  it("writes no address while the overtaken return's step is on its way, as App's address sync would", async () => {
    const browser = await refusing(['/a', '/b', '/task', '/d', '/e'], 2)
    // App writes the page's address once the page's own moves have landed
    const stop = onHistorySettled(() => {
      if (!historyBusy() && browser.here() !== '/task') pushPage({}, '/task')
    })
    browser.person.back()
    browser.person.back()
    await settleMoves()
    stop()
    expect(browser.here()).toBe('/task')
    expect(browser.urls()).toEqual(['/a', '/b', '/task', '/d', '/e'])
    expect(browser.ask).toHaveBeenCalledTimes(1)
  })

  it("takes the person's latest refused move on Discard, not the return's own step", async () => {
    const browser = await refusing(['/a', '/b', '/c', '/task'], 3)
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/task')
    expect(browser.ask).toHaveBeenCalledTimes(1)
    browser.scope.discard()
    browser.discard()
    await settleMoves()
    expect(browser.here()).toBe('/b')
  })

  it('ends on the page shown after Back, Back and Forward before the return ran', async () => {
    const browser = await refusing(['/a', '/b', '/c', '/task'], 3)
    browser.person.back()
    browser.person.back()
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/task')
    expect(browser.ask).toHaveBeenCalledTimes(1)
    expect(historyBusy()).toBe(false)
    browser.scope.discard()
    browser.discard()
    await settleMoves()
    // a known limit: the Forward goes by the overtaken return's own step,
    // so it is taken for that step, and Discard takes the Back before it
    expect(browser.here()).toBe('/b')
  })

  it('ends on the page shown after a pick from the Back menu and a Forward before the return ran', async () => {
    const browser = await refusing(['/a', '/b', '/task'], 2)
    // the return of the pick would now land past the last entry
    browser.person.pick(0)
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/task')
    expect(browser.ask).toHaveBeenCalledTimes(1)
    expect(browser.applied).toEqual([])
    expect(historyBusy()).toBe(false)
    expect(browser.urls()).toEqual(['/a', '/b', '/task'])
  })

  it('ends quiet when a second Back reaches an entry without a position before the return ran', async () => {
    // an entry from before the page's history was installed, without a position
    const browser = browserWindow('/before')
    browser.history.pushState(null, '', '/start')
    const removeHistory = installPageHistory(browser.window)
    pushPage({}, '/task')
    const stopLayers = listenBackLayers(browser.window)
    remove = () => {
      stopLayers()
      removeHistory()
    }
    const scope = createUnsentScope()
    scope.hold('comment')
    const ask = vi.fn()
    const refusal = createPopRefusal(ask)
    browser.window.addEventListener('popstate', (event) => {
      if (!(event instanceof PopStateEvent) || !refusal.refuse(event, [scope])) {
        // as App does when the page cannot return: the task's address again
        event.stopImmediatePropagation()
        browser.history.pushState({}, '', '/task')
        ask()
      }
    })
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/task')
    expect(historyBusy()).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('ends on the page shown after a Back and a Forward before the return ran', async () => {
    const browser = await refusing(['/a', '/b', '/task', '/d', '/e'], 2)
    browser.person.back()
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/task')
    expect(browser.applied).toEqual([])
    expect(historyBusy()).toBe(false)
    expect(browser.urls()).toEqual(['/a', '/b', '/task', '/d', '/e'])
    // a known limit: the Forward goes by the return's own step, so it is
    // taken for the return, and the return's step for a refused Forward,
    // which asks once more
    expect(browser.ask).toHaveBeenCalledTimes(2)
  })
})
