import { createElement, Suspense } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodeWaitsForConnection,
  lazyFromModule,
  preloadInBackground,
  preloadModule,
} from './lazyModule'
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

  it('keeps a failed import failed, as the browser does, and never as loaded', async () => {
    const importModule = vi.fn(async () => ({ value: 'recovered' }))
    importModule.mockRejectedValueOnce(new Error('Download failed'))
    const load = preloadModule(importModule)
    await expect(load()).rejects.toThrow('Download failed')
    expect(load.peek()).toBeUndefined()
    expect(load.failed()).toBe(true)
    await expect(load()).rejects.toThrow('Download failed')
    expect(importModule).toHaveBeenCalledTimes(1)
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

/** Drops `status`'s socket. Qivo counts as offline OFFLINE_DELAY_MS later. */
function drop(status: SyncStatus, { notice = true } = {}) {
  status.setSocket({ connected: false, everConnected: true })
  if (notice) vi.advanceTimersByTime(OFFLINE_DELAY_MS)
}

describe('loading while the connection is down', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts no import while the connection is down, before Qivo counts as offline too', async () => {
    for (const notice of [false, true]) {
      const status = connected()
      drop(status, { notice })
      const importModule = vi.fn(async () => ({ value: 'loaded' }))
      const load = preloadModule(importModule, status)
      await expect(load()).rejects.toBeInstanceOf(CodeWaitsForConnection)
      expect(importModule).not.toHaveBeenCalled()
      expect(load.failed()).toBe(false)
      status.setSocket({ connected: true, everConnected: true })
      await expect(load()).resolves.toEqual({ value: 'loaded' })
      expect(importModule).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps answering a module that loaded before the connection dropped', async () => {
    const status = connected()
    const load = preloadModule(async () => ({ value: 'loaded' }), status)
    await load()
    drop(status)
    await expect(load()).resolves.toEqual({ value: 'loaded' })
  })
})

describe('background loading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  let status: SyncStatus
  /** A loader that records its imports in `order`, and fails while `fail`. */
  function loader(name: string, order: string[], fail = { on: false }) {
    return preloadModule(async () => {
      order.push(name)
      if (fail.on) throw new Error(`${name} failed`)
      return { name }
    }, status)
  }
  const idleNow = (next: () => void) => {
    queueMicrotask(next)
    return () => {}
  }
  const settle = () => vi.advanceTimersByTimeAsync(0)

  it('lets loads under way finish, then loads every module not loaded yet, one at a time', async () => {
    status = connected()
    const order: string[] = []
    const loaded = loader('loaded', order)
    await loaded()
    let finish = () => {}
    const visible = preloadModule(
      () =>
        new Promise<{ name: string }>((resolve) => {
          order.push('visible')
          finish = () => resolve({ name: 'visible' })
        }),
      status,
    )
    void visible()
    order.length = 0
    order.push('visible')
    const modules = [loader('a', order), loaded, visible, loader('b', order)]
    preloadInBackground(() => modules, status, idleNow)
    await settle()
    expect(order).toEqual(['visible'])
    finish()
    await settle()
    expect(order).toEqual(['visible', 'a', 'b'])
    expect(modules.every((load) => load.peek())).toBe(true)
  })

  it('stops at once when the connection drops mid-list and goes on when it is back', async () => {
    status = connected()
    const order: string[] = []
    const modules = [loader('a', order), loader('b', order), loader('c', order)]
    let release = () => {}
    const idleHeld = (next: () => void) => {
      release = next
      return () => {}
    }
    preloadInBackground(() => modules, status, idleHeld)
    await settle()
    release()
    await settle()
    expect(order).toEqual(['a'])
    // the socket goes while the list waits for the browser, before any notice
    drop(status, { notice: false })
    release()
    await settle()
    // nothing downloads while the socket is down, so nothing stays failed
    expect(order).toEqual(['a'])
    status.setSocket({ connected: true, everConnected: true })
    await settle()
    release()
    await settle()
    release()
    await settle()
    expect(order).toEqual(['a', 'b', 'c'])
    expect(modules.every((load) => load.peek())).toBe(true)
  })

  it('goes on after a pass that a drop and return interrupted mid-download', async () => {
    status = connected()
    const order: string[] = []
    let fail = (_: Error) => {}
    const first = preloadModule(
      () =>
        new Promise<{ name: string }>((_, reject) => {
          order.push('a')
          fail = reject
        }),
      status,
    )
    const modules = [first, loader('b', order)]
    preloadInBackground(() => modules, status, idleNow)
    await settle()
    expect(order).toEqual(['a'])
    // the connection drops and returns while a downloads, then a fails
    drop(status, { notice: false })
    status.setSocket({ connected: true, everConnected: true })
    fail(new Error('a failed'))
    await settle()
    expect(order).toEqual(['a', 'b'])
    expect(modules[1].peek()).toBeDefined()
  })

  it('stops at a failure and skips the failed module afterwards', async () => {
    status = connected()
    const order: string[] = []
    const modules = [loader('a', order, { on: true }), loader('b', order)]
    preloadInBackground(() => modules, status, idleNow)
    await settle()
    expect(order).toEqual(['a'])
    // a later change of the status lets it go on
    drop(status, { notice: false })
    status.setSocket({ connected: true, everConnected: true })
    await settle()
    expect(order).toEqual(['a', 'b'])
    expect(modules[0].failed()).toBe(true)
  })

  it('waits during a slow save and while offline, and stops when asked', async () => {
    status = connected()
    const order: string[] = []
    const settleWrite = status.track(true)
    vi.advanceTimersByTime(10_000)
    expect(status.pause()?.kind).toBe('slow')
    let idleCalls = 0
    const idleCounted = (next: () => void) => {
      idleCalls++
      const id = setTimeout(next, 10)
      return () => clearTimeout(id)
    }
    const stop = preloadInBackground(() => [loader('a', order)], status, idleCounted)
    await settle()
    expect(idleCalls).toBe(0)
    settleWrite()
    await settle()
    expect(idleCalls).toBe(1)
    // stopped while it waits for the browser to be idle
    stop()
    await vi.advanceTimersByTimeAsync(50)
    expect(order).toEqual([])
  })

  it('covers every workspace module, the editor only for an editor and the export for an admin', async () => {
    const chunks = await import('./workspaceChunks')
    const loaders = Object.entries(chunks).filter(
      ([name, value]) => 'peek' in value && name !== 'loadTaskCreation',
    )
    const all = chunks.workspaceModules({ editor: true, admin: true })
    for (const [name, load] of loaders) expect(all, name).toContain(load)
    expect(all).toHaveLength(loaders.length)
    const member = chunks.workspaceModules({ editor: false, admin: false })
    expect(member).not.toContain(chunks.loadDescEditor)
    expect(member).not.toContain(chunks.loadOrgExport)
  })

  it('leaves no lazily loaded code outside the shared loaders', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const allowed = new Set([
      'lib/lazyModule.ts',
      'lib/workspaceChunks.ts',
      'lib/workspacePreload.ts',
      'lib/orgExport.ts',
    ])
    const found: string[] = []
    const walk = (dir: string, rel = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), path)
        // test files and the fixtures they share (*.setup.ts) never ship
        else if (/\.tsx?$/.test(entry.name) && !/\.(test|setup)\.tsx?$/.test(entry.name)) {
          const text = readFileSync(join(dir, entry.name), 'utf8')
          if (/\blazy\(\s*\(\)|(?<!typeof )\bimport\(\s*['"]/.test(text) && !allowed.has(path))
            found.push(path)
        }
      }
    }
    walk(new URL('..', import.meta.url).pathname)
    expect(found).toEqual([])
  })
})
