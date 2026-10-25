// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserWindow, settleMoves } from './historyDouble.setup'
import { createUnsentScope } from './leaveGuard'
import {
  finishLayer,
  historyBusy,
  installPageHistory,
  listenBackLayers,
  openLayer,
  pushPage,
} from './pageHistory'
import { createPopRefusal } from './popRefusal'

/* A refused Back or Forward returns to the entry it left by key, keeps the
   entries on both sides, hides both popstates from later listeners, asks
   only once it is back, and takes the move again after Discard. */

let remove = () => {}
afterEach(() => remove())

/** A window on `urls`, on the entry at `at`, in `engine`'s order, with an
    App-like listener that refuses while its scope holds text, and a later
    listener, as the phone layers' is. */
async function refusing(urls: string[], at: number, engine: 'chromium' | 'firefox' | 'webkit') {
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
  },
)

describe('without the Navigation API', () => {
  it('answers false, so App pushes the address back itself', async () => {
    const browser = browserWindow('/a')
    const removeHistory = installPageHistory(browser.window)
    remove = removeHistory
    pushPage({}, '/b')
    const scope = createUnsentScope()
    scope.hold('comment')
    const refusal = createPopRefusal(vi.fn())
    const answers: boolean[] = []
    browser.window.addEventListener('popstate', (event) => {
      if (event instanceof PopStateEvent) answers.push(refusal.refuse(event, [scope]))
    })
    browser.person.back()
    await settleMoves()
    expect(answers).toEqual([false])
    expect(refusal.stepping()).toBe(false)
  })
})
