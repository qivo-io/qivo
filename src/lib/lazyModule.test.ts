import { createElement, Suspense } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { lazyFromModule, preloadModule } from './lazyModule'

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
