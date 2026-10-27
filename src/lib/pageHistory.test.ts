// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserWindow, fakeTime, settleMoves } from './historyDouble.setup'
import {
  finishLayer,
  historyBusy,
  holdLayers,
  installPageHistory,
  leavePage,
  listenBackLayers,
  openLayer,
  position,
  pushPage,
  whenQuiet,
} from './pageHistory'

/* The page's history on a double that moves as browsers do. Each open
   phone layer has a marker of its own; a layer that closes by itself moves
   nothing, its marker is a spare, and one Back still leaves the page. */

let remove = () => {}
beforeEach(fakeTime)
afterEach(() => {
  try {
    remove()
  } finally {
    // drops the fake timers still pending, so none runs in the next test
    vi.useRealTimers()
  }
})

/** A browser window on `urls`, on the last, with the page's history
    installed, an App-like listener that hears the moves no layer held, and
    the layers' listener after it; with `engine`'s Navigation API when given,
    after another site's entry at `elsewhere` when given. */
function page(urls: string[], engine?: 'chromium' | 'webkit' | 'firefox', elsewhere?: string) {
  const browser = browserWindow(urls[0], engine, elsewhere)
  const removeHistory = installPageHistory(browser.window)
  for (const url of urls.slice(1)) pushPage({}, url)
  const heard: string[] = []
  browser.window.addEventListener('popstate', (event) => {
    if (event instanceof PopStateEvent && holdLayers(event)) return
    heard.push(browser.here())
  })
  const stopLayers = listenBackLayers(browser.window)
  remove = () => {
    stopLayers()
    removeHistory()
  }
  return { ...browser, heard }
}
/** Opens a layer, which closes on a Back unless `onBack` answers false, and
    waits for its marker. */
async function layer(onBack: () => unknown = () => {}) {
  const opened = openLayer(onBack)
  await Promise.resolve()
  return opened
}
const layerOf = (state: unknown) => (state as { qivoLayer?: string } | null)?.qivoLayer

describe('positions', () => {
  it('stamps each entry and reads its position after Back and Forward', async () => {
    const browser = page(['/a', '/b', '/c'])
    expect(browser.history.state).toEqual({ qivoAt: 2 })
    browser.history.replaceState({ qivoPrevious: '/b' }, '', '/c2')
    expect(browser.history.state).toEqual({ qivoPrevious: '/b', qivoAt: 2 })
    browser.person.pick(0)
    await settleMoves()
    expect(position()).toBe(0)
    browser.person.forward()
    await settleMoves()
    expect(position()).toBe(1)
    expect(browser.heard).toEqual(['/a', '/b'])
  })
})

describe('a layer that closes by itself', () => {
  it('leaves its marker as a spare, moves nothing, and one Back leaves the page', async () => {
    const browser = page(['/before', '/page'])
    const dialog = await layer()
    expect(browser.urls()).toEqual(['/before', '/page', '/page'])
    finishLayer(dialog)
    await settleMoves()
    expect(browser.index()).toBe(2)
    expect(browser.heard).toEqual([])
    browser.person.back()
    await settleMoves()
    // the landing on the page's own entry is hidden, and the page goes on
    expect(browser.here()).toBe('/before')
    expect(browser.heard).toEqual(['/before'])
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'goes on once from a spare, and a second Back during that step ends two pages back, in %s',
    async (engine) => {
      const browser = page(['/a', '/b', '/page'], engine)
      finishLayer(await layer())
      // two Backs in a row, the second before the page's step has run
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(browser.here()).toBe('/a')
      expect(browser.heard).toEqual(['/b', '/a'])
    },
  )

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    "goes on in turn with another script's Back one task later, so two script Backs leave two pages, in %s",
    async (engine) => {
      const browser = page(['/a', '/b', '/page'], engine)
      finishLayer(await layer())
      // WebKit keeps one script traversal at a time
      browser.history.back()
      setTimeout(() => browser.history.back(), 0)
      await settleMoves()
      expect(browser.here()).toBe('/a')
      expect(browser.heard).toEqual(['/b', '/a'])
    },
  )

  it('carries an address written in place over its marker down, and Forward shows it', async () => {
    const browser = page(['/before', '/page'])
    const dialog = await layer()
    // as App names a task that changed while its dialog was open
    browser.history.replaceState(browser.history.state, '', '/page/renamed')
    finishLayer(dialog)
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/before')
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/page/renamed')
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'carries an address written in place down two spares through two quick Backs, in %s',
    async (engine) => {
      const browser = page(['/before', '/page'], engine)
      const dialog = await layer()
      const menu = await layer()
      // as App names a task whose organization's address changed
      browser.history.replaceState(browser.history.state, '', '/page/renamed')
      finishLayer(menu)
      finishLayer(dialog)
      browser.person.back()
      browser.person.back()
      await settleMoves()
      browser.person.pick(1)
      await settleMoves()
      expect(browser.here()).toBe('/page/renamed')
    },
  )

  it('gives its spare to the next page, so Back returns to the page under it', async () => {
    const browser = page(['/before', '/page'])
    finishLayer(await layer())
    pushPage({ qivoPrevious: '/page' }, '/next')
    expect(browser.urls()).toEqual(['/before', '/page', '/next'])
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/page')
    expect(browser.heard).toEqual(['/page'])
  })

  it('keeps an address written in place on a spare under the next page, and Back reaches it', async () => {
    const browser = page(['/before', '/page'])
    finishLayer(await layer())
    browser.history.replaceState(browser.history.state, '', '/page/renamed')
    pushPage({}, '/next')
    expect(browser.urls()).toEqual(['/before', '/page', '/page/renamed', '/next'])
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/page/renamed')
    browser.person.back()
    await settleMoves()
    // carried down to the page's entry, then on
    expect(browser.here()).toBe('/before')
    expect(browser.urls()).toEqual(['/before', '/page/renamed', '/page/renamed', '/next'])
  })

  it('gives its spare to the next layer, and Back closes that layer', async () => {
    const browser = page(['/before', '/page'])
    finishLayer(await layer())
    const closed = vi.fn()
    const next = await layer(closed)
    expect(browser.urls()).toEqual(['/before', '/page', '/page'])
    expect(layerOf(browser.history.state)).toBe(next.marker)
    browser.person.back()
    await settleMoves()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(browser.here()).toBe('/page')
    expect(browser.index()).toBe(1)
  })

  it('keeps the marker for an open layer when one opened over it finishes, and Back closes that one and stays', async () => {
    const browser = page(['/before', '/page'])
    const closed = vi.fn()
    const dialog = await layer(closed)
    // a menu in the dialog, picked
    finishLayer(await layer())
    expect(browser.urls()).toEqual(['/before', '/page', '/page', '/page'])
    // the Back reaches the dialog's marker, which changes nothing on screen,
    // so it closes the dialog there
    browser.person.back()
    await settleMoves()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(dialog.state).toBe('closed')
    expect(browser.here()).toBe('/page')
    expect(browser.index()).toBe(2)
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/before')
  })

  it('closes the top one of two open layers on Back, and the next Back the other', async () => {
    const browser = page(['/before', '/page'])
    const dialogClosed = vi.fn()
    const menuClosed = vi.fn()
    const dialog = await layer(dialogClosed)
    await layer(menuClosed)
    expect(browser.urls()).toEqual(['/before', '/page', '/page', '/page'])
    browser.person.back()
    await settleMoves()
    expect(menuClosed).toHaveBeenCalledTimes(1)
    expect(dialogClosed).not.toHaveBeenCalled()
    expect(layerOf(browser.history.state)).toBe(dialog.marker)
    browser.person.back()
    await settleMoves()
    expect(dialogClosed).toHaveBeenCalledTimes(1)
    expect(browser.here()).toBe('/page')
    expect(browser.index()).toBe(1)
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'closes one of two open layers per Back when the browser queued both before the page ran, in %s',
    async (engine) => {
      const browser = page(['/before', '/page'], engine)
      const dialogClosed = vi.fn()
      const menuClosed = vi.fn()
      await layer(dialogClosed)
      await layer(menuClosed)
      // Firefox counts the second Back from the first one's entry, so it
      // reaches past a marker the page would add once the first has landed
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(menuClosed).toHaveBeenCalledTimes(1)
      expect(dialogClosed).toHaveBeenCalledTimes(1)
      expect(browser.here()).toBe('/page')
      expect(browser.index()).toBe(1)
      expect(browser.heard).toEqual(['/page', '/page'])
    },
  )

  it('gives the marker back to the layer under one that App closed on the same Back', async () => {
    const browser = browserWindow('/before')
    const removeHistory = installPageHistory(browser.window)
    pushPage({}, '/page')
    const dialogClosed = vi.fn()
    const dialog = await layer(dialogClosed)
    const menu = await layer()
    // React's commit of App's popstate unmounts the menu before the layers'
    // listener runs, as browsers run it between the two
    browser.window.addEventListener('popstate', () => finishLayer(menu))
    const stopLayers = listenBackLayers(browser.window)
    remove = () => {
      stopLayers()
      removeHistory()
    }
    browser.person.back()
    await settleMoves()
    expect(dialogClosed).not.toHaveBeenCalled()
    expect(dialog.state).toBe('open')
    expect(layerOf(browser.history.state)).toBe(dialog.marker)
    expect(browser.here()).toBe('/page')
  })

  it('closes every layer over a page that a Back-menu pick leaves', async () => {
    const browser = page(['/before', '/page'])
    const dialog = await layer()
    const menu = await layer()
    browser.person.pick(0)
    await settleMoves()
    expect([dialog.state, menu.state]).toEqual(['closed', 'closed'])
    expect(browser.here()).toBe('/before')
    expect(browser.heard).toEqual(['/before'])
  })

  it.each([undefined, 'firefox'] as const)(
    'leaves a spare for each of two nested layers that close by themselves, and one Back leaves the page, in %s',
    async (engine) => {
      const browser = page(['/a', '/b', '/c', '/page'], engine)
      const dialog = await layer()
      const menu = await layer()
      finishLayer(menu)
      finishLayer(dialog)
      expect(browser.urls()).toEqual(['/a', '/b', '/c', '/page', '/page', '/page'])
      browser.person.back()
      await settleMoves()
      expect(browser.here()).toBe('/c')
      expect(browser.heard).toEqual(['/c'])
    },
  )

  it('takes no step past the first entry when Firefox queued Backs reach it', async () => {
    const browser = page(['/a', '/b', '/page'], 'firefox')
    finishLayer(await layer())
    // the third Back reaches the first entry, with no entry before it
    browser.person.back()
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/a')
    expect(browser.heard.at(-1)).toBe('/a')
    expect(historyBusy()).toBe(false)
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    "goes on to another site's entry when quick Backs reach the first entry listed, in %s",
    async (engine) => {
      const browser = page(['/a', '/page'], engine, '/elsewhere')
      finishLayer(await layer())
      // in Firefox the second Back's navigate event comes before the first
      // lands, so no key names the entry the going-on is for
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(browser.here()).toBe('/elsewhere')
      expect(browser.heard).toEqual(['/a'])
      expect(historyBusy()).toBe(false)
    },
  )

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'goes on one step per spare, so two quick Backs over two spares leave two pages, in %s',
    async (engine) => {
      const browser = page(['/a', '/b', '/c', '/page'], engine)
      const dialog = await layer()
      const menu = await layer()
      finishLayer(menu)
      finishLayer(dialog)
      // the second Back before the page's step has run
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(browser.here()).toBe('/b')
      expect(browser.heard).toEqual(['/c', '/b'])
    },
  )

  it('keeps the Forward that follows a Back-menu pick of the first entry', async () => {
    const browser = page(['/older', '/middle', '/page'])
    finishLayer(await layer())
    // the pick reaches another page, so nothing goes on, and the Forward
    // right after is the person's
    browser.person.pick(0)
    browser.person.forward()
    await settleMoves()
    expect(browser.heard).toEqual(['/older', '/middle'])
    expect(browser.here()).toBe('/middle')
  })

  it('keeps a layer open when Forward reaches a page added over it, and Back returns to it', async () => {
    const browser = page(['/before', '/page'])
    const closed = vi.fn()
    await layer(closed)
    // a task opened from the landscape roadmap, with an entry of its own
    pushPage({ qivoPrevious: '/page' }, '/page/task')
    browser.person.back()
    await settleMoves()
    expect(closed).not.toHaveBeenCalled()
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/page/task')
    expect(closed).not.toHaveBeenCalled()
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(browser.here()).toBe('/page')
  })

  it.each(['chromium', 'webkit', 'firefox'] as const)(
    'keeps the page under a refusing layer when two quick Backs pass a spare over it, in %s',
    async (engine) => {
      const browser = page(['/before', '/page'], engine)
      const asked = vi.fn(() => false)
      const dialog = await layer(asked)
      // a menu over the dialog, picked
      finishLayer(await layer())
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(asked).toHaveBeenCalled()
      expect(dialog.state).toBe('open')
      expect(browser.here()).toBe('/page')
      expect(layerOf(browser.history.state)).toBe(dialog.marker)
    },
  )

  it("gives a refusing layer its marker back on the person's Back, and moves nothing else", async () => {
    const browser = page(['/before', '/page'])
    const asked = vi.fn(() => false)
    const dialog = await layer(asked)
    browser.person.back()
    await settleMoves()
    expect(asked).toHaveBeenCalledTimes(1)
    expect(dialog.state).toBe('open')
    expect(layerOf(browser.history.state)).toBe(dialog.marker)
    expect(browser.urls()).toEqual(['/before', '/page', '/page'])
    expect(browser.heard).toEqual(['/page'])
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'holds the page for a layer that refused its close when quick Backs past it reach the pages before, in %s',
    async (engine) => {
      const browser = page(['/a', '/b', '/page'], engine)
      const asked = vi.fn(() => false)
      const dialog = await layer(asked)
      // the first Back asks; Chromium and Firefox count the others past the
      // page, from the entry the one before goes to
      browser.person.back()
      browser.person.back()
      browser.person.back()
      await settleMoves()
      expect(dialog.state).toBe('open')
      expect(browser.here()).toBe('/page')
      expect(layerOf(browser.history.state)).toBe(dialog.marker)
      expect(browser.heard.every((url) => url === '/page')).toBe(true)
      expect(historyBusy()).toBe(false)
    },
  )

  it.each([undefined, 'chromium', 'firefox'] as const)(
    'holds the page for a refusing layer that a Back-menu pick leaves, and returns to its marker unheard, in %s',
    async (engine) => {
      const browser = page(['/a', '/b', '/page'], engine)
      const menu = await layer()
      const dialog = await layer(() => false)
      browser.person.pick(0)
      await settleMoves()
      expect([menu.state, dialog.state]).toEqual(['open', 'open'])
      expect(browser.here()).toBe('/page')
      expect(layerOf(browser.history.state)).toBe(dialog.marker)
      expect(browser.heard).toEqual([])
      expect(historyBusy()).toBe(false)
    },
  )
})

describe('a layer that refuses a move to an entry without a position', () => {
  it('gets its marker back only once App has read that entry', async () => {
    // an entry from before the page's history was installed, without a position
    const browser = browserWindow('/before')
    browser.history.pushState(null, '', '/start')
    const removeHistory = installPageHistory(browser.window)
    pushPage({}, '/page')
    const read: unknown[] = []
    browser.window.addEventListener('popstate', (event) => {
      if (event instanceof PopStateEvent && holdLayers(event)) return
      read.push(browser.history.state)
    })
    const stopLayers = listenBackLayers(browser.window)
    remove = () => {
      stopLayers()
      removeHistory()
    }
    const dialog = await layer(() => false)
    browser.person.pick(0)
    await settleMoves()
    expect(read).toEqual([null])
    expect(dialog.state).toBe('open')
    expect(browser.urls()).toEqual(['/before', '/before'])
    expect(layerOf(browser.history.state)).toBe(dialog.marker)
  })
})

describe("a spare over the session's first entry", () => {
  it('steps off it, so the next Back has nowhere to land on the same page', async () => {
    const browser = page(['/page'])
    finishLayer(await layer())
    await settleMoves()
    expect(browser.index()).toBe(0)
    expect(layerOf(browser.history.state)).toBeUndefined()
    expect(historyBusy()).toBe(false)
  })

  it("ends its step on the person's Back that came first, and nothing waits", async () => {
    const browser = page(['/page'])
    finishLayer(await layer())
    browser.person.back()
    await settleMoves()
    expect(browser.index()).toBe(0)
    const ran = vi.fn()
    whenQuiet(ran)
    expect(ran).toHaveBeenCalled()
  })

  it("holds a new layer's marker until its step has landed, so the step cannot take it", async () => {
    const browser = page(['/page'])
    finishLayer(await layer())
    // the step sets out once what closed the layer has committed, in a
    // timer due now, and lands in the timers it sets, which run later
    await vi.advanceTimersByTimeAsync(0)
    expect(historyBusy()).toBe(true)
    const next = await layer()
    await settleMoves()
    expect(layerOf(browser.history.state)).toBe(next.marker)
    expect(browser.urls()).toEqual(['/page', '/page'])
  })

  it.each([undefined, 'chromium', 'webkit', 'firefox'] as const)(
    'steps off a spare left by the lower of two layers after a Back closed the upper one, in %s',
    async (engine) => {
      const browser = page(['/page'], engine)
      const dialog = await layer()
      await layer()
      browser.person.back()
      await settleMoves()
      // the dialog closes by itself; the menu's marker is a Forward entry
      finishLayer(dialog)
      await settleMoves()
      expect(browser.index()).toBe(0)
      expect(historyBusy()).toBe(false)
    },
  )

  it('takes no step while a page that took a spare follows, so Forward still reaches it', async () => {
    const browser = page(['/roadmap'])
    const landscape = await layer()
    // a menu over the landscape roadmap, picked, then a task opened from it
    finishLayer(await layer())
    pushPage({ qivoPrevious: '/roadmap' }, '/task')
    expect(browser.urls()).toEqual(['/roadmap', '/roadmap', '/task'])
    browser.person.back()
    await settleMoves()
    finishLayer(landscape)
    await settleMoves()
    expect(browser.index()).toBe(1)
    browser.person.forward()
    await settleMoves()
    expect(browser.here()).toBe('/task')
  })

  it('takes one step for two layers that close together, and a Back first leaves the page on that entry', async () => {
    const browser = page(['/page'])
    const dialog = await layer()
    const menu = await layer()
    finishLayer(menu)
    finishLayer(dialog)
    browser.person.back()
    await settleMoves()
    expect(browser.index()).toBe(0)
    expect(layerOf(browser.history.state)).toBeUndefined()
    expect(historyBusy()).toBe(false)
  })

  it.each(['chromium', 'webkit', 'firefox'] as const)(
    "takes no step while an entry follows the spare, so a Forward right after the close is the person's, in %s",
    async (engine) => {
      const browser = page(['/roadmap'], engine)
      const landscape = await layer()
      // a task opened from the landscape roadmap, then Back to the roadmap
      pushPage({ qivoPrevious: '/roadmap' }, '/task')
      browser.person.back()
      await settleMoves()
      expect(landscape.state).toBe('open')
      // the layer closes by itself, and the person presses Forward at once
      finishLayer(landscape)
      browser.person.forward()
      await settleMoves()
      expect(browser.here()).toBe('/task')
      expect(browser.heard).toEqual(['/roadmap', '/task'])
    },
  )
})

describe('a reload on a marker', () => {
  it("makes the earlier load's marker a spare, so one Back leaves the page", async () => {
    const browser = browserWindow('/before')
    browser.history.pushState({ qivoAt: 1 }, '', '/page')
    // the marker of a layer from the document before the reload
    browser.history.pushState(
      { qivoAt: 2, qivoLayer: 'gone:1', qivoDepth: 1, qivoPageUrl: 'https://qivo.test/page' },
      '',
      '/page',
    )
    const removeHistory = installPageHistory(browser.window)
    const stopLayers = listenBackLayers(browser.window)
    remove = () => {
      stopLayers()
      removeHistory()
    }
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/before')
  })
})

describe('after a reload with entries after it', () => {
  it('pushes the next page over a spare that has Forward entries, without the Navigation API', async () => {
    const browser = browserWindow('/before')
    browser.history.pushState({ qivoAt: 1 }, '', '/page')
    browser.history.pushState(
      { qivoAt: 2, qivoLayer: 'gone:1', qivoPageUrl: 'https://qivo.test/page' },
      '',
      '/page',
    )
    browser.history.pushState({ qivoAt: 3 }, '', '/next')
    // the person went Back to the spare, and the page reloaded there
    browser.person.back()
    await settleMoves()
    remove = installPageHistory(browser.window)
    pushPage({ qivoPrevious: '/page' }, '/other')
    expect(browser.urls()).toEqual(['/before', '/page', '/page', '/other'])
  })
})

describe("the page's steps in turn", () => {
  it('lets later steps through after one that throws', async () => {
    const browser = browserWindow('/page')
    const go = vi
      .spyOn(browser.history, 'go')
      .mockImplementationOnce(() => {
        throw new Error('blocked')
      })
      .mockImplementation(() => {})
    remove = installPageHistory(browser.window)
    expect(() => leavePage()).toThrow('blocked')
    await settleMoves()
    // shown again from the back/forward cache, so the next close steps again
    browser.window.dispatchEvent(new Event('pageshow'))
    leavePage()
    browser.history.back()
    await settleMoves()
    expect(go.mock.calls).toEqual([[-1], [-1], [-1]])
  })
})

describe('the development check on writes after a page step', () => {
  it('warns of a write in the task of a page step', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    page(['/a', '/page'])
    leavePage()
    pushPage({}, '/next')
    expect(errors).toHaveBeenCalledWith('History written right after a page step')
    errors.mockRestore()
  })

  it("stays quiet for a write in a later popstate's task, as a browser runs each in its own", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const browser = page(['/a', '/b', '/page'], 'firefox')
    finishLayer(await layer())
    // App writes the address in place as it hears a move
    browser.window.addEventListener('popstate', () =>
      browser.history.replaceState(browser.history.state, ''),
    )
    // the double lands both Backs in one task: the first one's going-on,
    // then the second one's popstate
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/a')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe("a phone close's step past the page", () => {
  it('steps past the marker once for two closes before it lands', async () => {
    const browser = page(['/before', '/page'])
    await layer()
    leavePage()
    leavePage()
    await settleMoves()
    expect(browser.here()).toBe('/before')
    expect(browser.heard).toEqual(['/before'])
  })

  it.each([
    ['the person stays when the browser asks to leave', 'beforeunload'],
    ['the page comes back from the back/forward cache', 'pageshow'],
  ])('steps again when %s', async (_, event) => {
    const browser = browserWindow('/page')
    const go = vi.spyOn(browser.history, 'go').mockImplementation(() => {})
    remove = installPageHistory(browser.window)
    // the step leaves the document, so no popstate ends it here
    leavePage()
    leavePage()
    await settleMoves()
    expect(go).toHaveBeenCalledTimes(1)
    browser.window.dispatchEvent(new Event(event))
    leavePage()
    await settleMoves()
    expect(go).toHaveBeenCalledTimes(2)
  })
})
