import { createElement, Suspense } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lazyFromModule, preloadInBackground, preloadModule } from './lazyModule'
import { createSyncStatus, OFFLINE_DELAY_MS, type SyncStatus } from './syncStatus'

describe('preloaded workspace modules', () => {
  it('defers imports and shares pending and successful loads', async () => {
    const module = { value: 'loaded' }
    const importModule = vi.fn(async () => module)
    const load = preloadModule(importModule)
    expect(importModule).not.toHaveBeenCalled()
    expect(load.peek()).toBeUndefined()
    const first = load()
    expect(load()).toBe(first)
    expect(await first).toBe(module)
    expect(load.peek()).toBe(module)
    expect(await load()).toBe(module)
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('does not retain a failed speculative import as a successful load', async () => {
    const importModule = vi.fn(async () => ({ value: 'recovered' }))
    importModule.mockRejectedValueOnce(new Error('Download failed'))
    const load = preloadModule(importModule)
    await expect(load()).rejects.toThrow('Download failed')
    expect(load.peek()).toBeUndefined()
    await expect(load()).resolves.toEqual({ value: 'recovered' })
    expect(importModule).toHaveBeenCalledTimes(2)
  })

  it('renders preloaded code on its first render without a loading fallback', async () => {
    const load = preloadModule(async () => ({
      View: ({ name }: { name: string }) => createElement('p', null, name),
    }))
    const View = lazyFromModule(load, (module) => module.View)
    await load()
    const html = renderToString(
      createElement(
        Suspense,
        { fallback: 'Waiting for code' },
        createElement(View, { name: 'Board' }),
      ),
    )
    expect(html).toContain('<p>Board</p>')
    expect(html).not.toContain('Waiting for code')
  })

  it('uses Suspense while the requested code is still pending', async () => {
    const module = { View: () => createElement('p', null, 'Ready') }
    let finish: (value: typeof module) => void = () => {}
    const load = preloadModule(
      () =>
        new Promise<typeof module>((resolve) => {
          finish = resolve
        }),
    )
    const View = lazyFromModule(load, (loaded) => loaded.View)
    const html = renderToString(
      createElement(Suspense, { fallback: 'Waiting for code' }, createElement(View)),
    )
    expect(html).toContain('Waiting for code')
    expect(html).not.toContain('<p>Ready</p>')
    finish(module)
    await load()
    expect(renderToString(createElement(View))).toBe('<p>Ready</p>')
  })
})

/** A status that has connected once, as the app's does after boot. */
function connected() {
  const status = createSyncStatus()
  status.setSocket({ connected: true, everConnected: true })
  return status
}

/** Drops `status`'s connection until it counts as offline. */
function goOffline(status: SyncStatus) {
  status.setSocket({ connected: false, everConnected: true })
  vi.advanceTimersByTime(OFFLINE_DELAY_MS)
}

describe('loading while offline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts no import while offline, so the code loads once the connection is back', async () => {
    const status = connected()
    goOffline(status)
    const importModule = vi.fn(async () => ({ value: 'loaded' }))
    const load = preloadModule(importModule, status)
    await expect(load()).rejects.toThrow('connection')
    expect(importModule).not.toHaveBeenCalled()
    status.setSocket({ connected: true, everConnected: true })
    await expect(load()).resolves.toEqual({ value: 'loaded' })
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('keeps answering a module that loaded before the connection dropped', async () => {
    const status = connected()
    const load = preloadModule(async () => ({ value: 'loaded' }), status)
    await load()
    goOffline(status)
    await expect(load()).resolves.toEqual({ value: 'loaded' })
  })
})

describe('background loading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A loader whose import the test finishes, recording the order. */
  function loader(name: string, order: string[], fail = { next: false }) {
    return preloadModule(async () => {
      order.push(name)
      if (fail.next) {
        fail.next = false
        throw new Error(`${name} failed`)
      }
      return { name }
    }, status)
  }
  let status: SyncStatus
  const idleNow = (next: () => void) => {
    queueMicrotask(next)
    return () => {}
  }
  const settle = () => vi.advanceTimersByTimeAsync(0)

  it('loads every module not loaded yet, one at a time', async () => {
    status = connected()
    const order: string[] = []
    const loaded = loader('loaded', order)
    await loaded()
    order.length = 0
    const modules = [loader('a', order), loaded, loader('b', order)]
    preloadInBackground(modules, status, idleNow)
    await settle()
    expect(order).toEqual(['a', 'b'])
    expect(modules.every((load) => load.peek())).toBe(true)
  })

  it('waits while offline and tries a failed module again when the pause ends', async () => {
    status = connected()
    const order: string[] = []
    const fail = { next: true }
    const modules = [loader('a', order, fail), loader('b', order)]
    preloadInBackground(modules, status, idleNow)
    await settle()
    expect(order).toEqual(['a', 'b'])
    expect(modules[0].peek()).toBeUndefined()
    goOffline(status)
    await settle()
    expect(order).toEqual(['a', 'b'])
    status.setSocket({ connected: true, everConnected: true })
    await settle()
    expect(order).toEqual(['a', 'b', 'a'])
    expect(modules.every((load) => load.peek())).toBe(true)
  })

  it('starts nothing while offline and stops when asked', async () => {
    status = connected()
    goOffline(status)
    const order: string[] = []
    const stop = preloadInBackground([loader('a', order)], status, idleNow)
    await settle()
    expect(order).toEqual([])
    stop()
    status.setSocket({ connected: true, everConnected: true })
    await settle()
    expect(order).toEqual([])
  })

  it('covers every workspace module, and the editor only for an editor', async () => {
    const chunks = await import('./workspaceChunks')
    const loaders = Object.entries(chunks).filter(
      ([name, value]) => 'peek' in value && name !== 'loadTaskCreation',
    )
    const all = chunks.workspaceModules(true)
    for (const [name, load] of loaders) expect(all, name).toContain(load)
    expect(all).toHaveLength(loaders.length)
    expect(chunks.workspaceModules(false)).not.toContain(chunks.loadDescEditor)
  })
})
