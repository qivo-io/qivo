// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserWindow, settleMoves } from './historyDouble.setup'
import {
  finishLayer,
  historyBusy,
  installPageHistory,
  listenBackLayers,
  openLayer,
  position,
  pushPage,
  whenQuiet,
} from './pageHistory'

/* The page's history on a double that moves as browsers do: a phone layer
   that closes by itself leaves its marker as a spare and moves nothing, and
   one Back still leaves the page. */

let remove = () => {}
afterEach(() => remove())

/** A browser window on `urls`, on the last, with the page's history
    installed, an App-like listener that hears the moves, and the layers'
    listener after it. */
function page(urls: string[]) {
  const browser = browserWindow(urls[0])
  const removeHistory = installPageHistory(browser.window)
  for (const url of urls.slice(1)) pushPage({}, url)
  const heard: string[] = []
  browser.window.addEventListener('popstate', () => heard.push(browser.here()))
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

  it('goes on once from a spare, and a second Back during that step ends two pages back', async () => {
    const browser = page(['/a', '/b', '/page'])
    finishLayer(await layer())
    // two Backs in a row, the second before the page's step has run
    browser.person.back()
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/a')
    expect(browser.heard).toEqual(['/b', '/a'])
  })

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
    expect(layerOf(browser.history.state)).toBe(next.token)
    browser.person.back()
    await settleMoves()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(browser.here()).toBe('/page')
    expect(browser.index()).toBe(1)
  })

  it('closes an open layer under a spare in place on Back, and the next Back leaves', async () => {
    const browser = page(['/before', '/page'])
    const closed = vi.fn()
    const dialog = await layer(closed)
    finishLayer(await layer())
    browser.person.back()
    await settleMoves()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(dialog.state).toBe('closed')
    expect(browser.index()).toBe(2)
    expect(browser.heard).toEqual([])
    browser.person.back()
    await settleMoves()
    expect(browser.here()).toBe('/before')
  })

  it('keeps the Forward that follows a Back-menu pick of the first entry', async () => {
    const browser = page(['/older', '/middle', '/page'])
    finishLayer(await layer())
    // the pick reaches another page, so nothing goes on, and the Forward
    // right after is the person's
    browser.person.pick(0)
    browser.person.forward()
    await new Promise((resolve) => setTimeout(resolve, 1500))
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

  it("gives a refusing layer its marker back on the person's Back, and moves nothing else", async () => {
    const browser = page(['/before', '/page'])
    const asked = vi.fn(() => false)
    const dialog = await layer(asked)
    browser.person.back()
    await settleMoves()
    expect(asked).toHaveBeenCalledTimes(1)
    expect(dialog.state).toBe('open')
    expect(layerOf(browser.history.state)).toBe(dialog.token)
    expect(browser.urls()).toEqual(['/before', '/page', '/page'])
    expect(browser.heard).toEqual(['/page'])
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
    // the step sets out once what closed the layer has committed
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(historyBusy()).toBe(true)
    const next = await layer()
    await settleMoves()
    expect(layerOf(browser.history.state)).toBe(next.token)
    expect(browser.urls()).toEqual(['/page', '/page'])
  })
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
