// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INLINE_IMAGES, type ObserverFactory } from '../lib/inlineImages'
import { TooltipProvider } from './ui/tooltip'

/* The store's loader over stand-ins: a fake observer the test moves
   elements through, a mint that answers a lease and a fetch of a small
   image, so the views render what a real loader gives them. */
const reach = vi.hoisted(() => ({
  observers: [] as {
    near: boolean
    receive: Parameters<ObserverFactory>[0]
    elements: Set<Element>
  }[],
  // while set, the mint answers once it settles
  mintHeld: null as Promise<void> | null,
}))
vi.mock('../store/planner', async () => {
  const { createInlineImages, INLINE_IMAGES: bounds } = await import('../lib/inlineImages')
  const factory: ObserverFactory = (receive, options) => {
    const obs = {
      near: String(options.rootMargin).startsWith(`${bounds.near * 100}%`),
      receive,
      elements: new Set<Element>(),
    }
    reach.observers.push(obs)
    return {
      observe: (e: Element) => obs.elements.add(e),
      unobserve: (e: Element) => obs.elements.delete(e),
      disconnect: () => obs.elements.clear(),
    }
  }
  const blob = new Blob([new Uint8Array(64)], { type: 'image/webp' })
  const inlineImages = createInlineImages({
    held: () => true,
    mint: async (id) => {
      if (reach.mintHeld) await reach.mintHeld
      return {
        state: 'lease',
        lease: { url: `https://files.test/files/${id}`, exp: Date.now() / 1000 + 600 },
      }
    },
    fetch: async () => ({ ok: true, status: 200, blob: async () => blob }) as unknown as Response,
    createUrl: () => 'blob:inline-1',
    revokeUrl: () => {},
    measure: async () => ({ width: 640, height: 480 }),
    observer: factory,
    rootOf: () => null,
  })
  return { P: { inlineImages, attachmentUrl: async () => null } }
})

const { Markdown } = await import('./markdown')
const { InlineImageBody } = await import('./inlineImage')
const { P } = await import('../store/planner')

let container: HTMLDivElement
let root: Root
const BOUNDS = structuredClone(INLINE_IMAGES)

/* Moves every observed element near, within both observers' margins, or
   far, outside both. */
async function moveAll(near: boolean) {
  await act(async () => {
    for (const obs of reach.observers)
      for (const target of obs.elements) obs.receive([{ target, isIntersecting: near }])
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  reach.observers.length = 0
  reach.mintHeld = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Object.assign(INLINE_IMAGES, structuredClone(BOUNDS))
})

const render = (node: React.ReactNode) =>
  act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))

describe('description images', () => {
  it('shows a placeholder box until an attachment image comes near, then its bytes', async () => {
    await render(
      <Markdown text="Before ![board](att:9d0b7c3e-1111-4222-8333-444455556666) after" />,
    )
    const box = container.querySelector<HTMLElement>('.mdimgbox')
    expect(box?.textContent).toBe('Loading image…')
    expect(box?.style.aspectRatio).toBe('4 / 3')
    // in pixels: a percentage of the shrink-to-fit wrapper would shrink it
    expect(box?.style.width).toBe('453px')
    expect(container.querySelector('img')).toBeNull()
    const watched = container.querySelector('.mdimgreach')
    await moveAll(true)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:inline-1')
    // the loader goes on watching the same element as the image shows
    expect(container.querySelector('.mdimgreach')).toBe(watched)
    expect(reach.observers.some((o) => watched && o.elements.has(watched))).toBe(true)
    expect(img?.getAttribute('decoding')).toBe('async')
    // far again: a placeholder of the recorded size
    await moveAll(false)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector<HTMLElement>('.mdimgbox')?.style.aspectRatio).toBe('640 / 480')
  })

  it('paints no held bytes past their lease before the mint that names them again answers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await render(<Markdown text="![board](att:9d0b7c3e-1111-4222-8333-444455556688)" />)
    await moveAll(true)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:inline-1')
    await moveAll(false)
    expect(container.querySelector('img')).toBeNull()
    // back near once the lease is within its skew, with the mint held
    vi.setSystemTime(Date.now() + 9 * 60_000)
    let answer = () => {}
    reach.mintHeld = new Promise<void>((resolve) => {
      answer = resolve
    })
    // every <img> any render puts in the DOM, also one a later render removes
    const painted: string[] = []
    const watcher = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement)
            for (const img of [
              ...(node.matches('img') ? [node] : []),
              ...node.querySelectorAll('img'),
            ])
              painted.push(img.getAttribute('src') ?? '')
    })
    watcher.observe(container, { childList: true, subtree: true })
    await moveAll(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(painted).toEqual([])
    expect(container.textContent).toContain('Loading image…')
    await act(async () => {
      answer()
      await new Promise((r) => setTimeout(r, 0))
    })
    watcher.disconnect()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:inline-1')
  })

  it('gives an external image its source only near, with no referrer and no lazy loading', async () => {
    await render(<Markdown text="![chart](https://example.com/chart.png)" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Loading image…')
    await moveAll(true)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/chart.png')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img?.getAttribute('decoding')).toBe('async')
    expect(img?.hasAttribute('loading')).toBe(false)
  })

  it('gives a slow external image’s slot back after 15 s and keeps it loading, and shows a failed one as unavailable with a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render(<Markdown text="![chart](https://slow.example.com/chart.png)" />)
    await act(async () => {
      for (const obs of reach.observers)
        for (const target of obs.elements) obs.receive([{ target, isIntersecting: true }])
    })
    expect(container.querySelector('img')).not.toBeNull()
    expect(P.inlineImages.stats().externalLoading).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(INLINE_IMAGES.externalTimeout)
    })
    // the slot went back, and the image goes on loading
    expect(P.inlineImages.stats().externalLoading).toBe(0)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://slow.example.com/chart.png',
    )
    expect(container.textContent).not.toContain('Image unavailable')
    // a load that fails shows it as unavailable, with a retry
    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Image unavailable')
    expect(P.inlineImages.stats().externalLoading).toBe(0)
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    await act(async () => retry?.click())
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://slow.example.com/chart.png',
    )
    expect(P.inlineImages.stats().externalLoading).toBe(1)
  })

  it('opens the editor’s image on a double-click and keeps the editor’s focus on its buttons', async () => {
    await render(
      <span className="mdimgwrap">
        <InlineImageBody
          alt="board"
          attId="9d0b7c3e-1111-4222-8333-444455556677"
          external={null}
          editor
          iconSize={16}
        />
      </span>,
    )
    await moveAll(true)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:inline-1')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    container.querySelector('.mdimgbtns')?.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })
})
