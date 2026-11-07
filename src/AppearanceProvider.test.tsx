// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import type { DailyImage } from './lib/appearanceContext'
import type { AppearancePreferences } from './store/planner'

/* The provider's background and Settings' preview over stand-ins: the
   store's appearance read and custom lease answered by hand, the weekly
   image's subscription recorded, and every download held until the test
   answers it. jsdom has no IndexedDB, so the background cache keeps its
   bytes in memory, as a blocked storage does. */

const store = vi.hoisted(() => {
  // the provider and Settings each subscribe to the preference
  const watchers = new Set<(value: AppearancePreferences) => void>()
  return {
    watchers,
    deliver: (value: AppearancePreferences) => {
      for (const next of watchers) next(value)
    },
    mint: vi.fn(),
  }
})
vi.mock('./store/planner', () => ({
  P: {
    watchAppearance: (next: (value: AppearancePreferences) => void) => {
      store.watchers.add(next)
      return () => {
        store.watchers.delete(next)
      }
    },
    mintAppearanceImageUrl: store.mint,
  },
}))
const weekly = vi.hoisted(() => ({
  subscriptions: [] as { receive: (value: unknown) => void; open: boolean }[],
}))
vi.mock('./lib/convex', () => ({
  convex: {
    onUpdate: (_ref: unknown, _args: unknown, receive: (value: unknown) => void) => {
      const sub = { receive, open: true }
      weekly.subscriptions.push(sub)
      return () => {
        sub.open = false
      }
    },
  },
}))
const demo = vi.hoisted(() => ({ on: false, polls: 0, stops: 0 }))
vi.mock('./lib/demoMode', async (original) => ({
  ...(await original<typeof import('./lib/demoMode')>()),
  get DEMO_MODE() {
    return demo.on
  },
}))
vi.mock('./lib/demoCanvas', () => ({
  watchDemoCanvas: (_date: string, receive: (value: DailyImage | null) => void) => {
    demo.polls++
    receive(daily('week-1', 'https://public.test/preview.webp'))
    return () => {
      demo.stops++
    }
  },
}))

const { AppearanceProvider } = await import('./AppearanceProvider')
const { usePreview } = await import('./lib/appearanceContext')
const { AppearanceSettings } = await import('./panels/AppearanceSettings')

function daily(id: string, preview: string | null): DailyImage {
  return {
    id,
    image_url: `https://storage.test/${id}/original.jpg`,
    preview_url: preview,
    title: 'Harbour',
    location: 'Gothenburg',
    creator: 'A. Photographer',
    filename: 'harbour.jpg',
    attribution: 'A. Photographer',
    source_url: 'https://example.com',
    license: 'CC BY',
    license_url: 'https://example.com/license',
  }
}

const preferences = (
  image_source: AppearancePreferences['image_source'],
  previewVersion: number | null = 1,
): AppearancePreferences => ({
  mode: 'light',
  image_source,
  custom_image:
    image_source === 'custom'
      ? {
          id: 'image-1',
          name: 'Lake.jpg',
          mime: 'image/jpeg',
          width: 1920,
          height: 1080,
          byte_size: 3 * 1024 * 1024,
          uploaded_at: '2026-09-16T12:00:00.000Z',
          preview_ready: previewVersion !== null,
          preview_version: previewVersion,
          preview_skipped: false,
        }
      : null,
})

type Download = {
  url: string
  signal: AbortSignal | undefined
  answer: (ok?: boolean) => void
}
let downloads: Download[] = []
// blob URLs whose bytes no longer decode, as a damaged cached copy's
const corrupt = new Set<string>()
// blob URLs whose decode never settles
const stalled = new Set<string>()
let page: 'visible' | 'hidden' = 'visible'
let container: HTMLDivElement
let root: Root
let serial = 0

/* What a view with usePreview sees. */
function Preview() {
  const { preview } = usePreview()
  return (
    <span
      data-preview-status={preview.status}
      data-preview-url={preview.url ?? ''}
      data-preview-key={preview.key ?? ''}
    />
  )
}

const shown = () => {
  const el = container.querySelector('[data-preview-status]')
  return {
    status: el?.getAttribute('data-preview-status'),
    url: el?.getAttribute('data-preview-url'),
    key: el?.getAttribute('data-preview-key'),
  }
}
const background = () =>
  container.querySelector('[data-appearance-background]')?.getAttribute('src') ?? null
const fetched = (part: string) => downloads.filter((d) => d.url.includes(part))
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++)
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
      else await new Promise((r) => setTimeout(r, 0))
  })

async function render(settings: boolean) {
  await act(async () =>
    root.render(
      <AppearanceProvider accountId="account-1">
        {settings ? <Preview /> : null}
      </AppearanceProvider>,
    ),
  )
  await settle()
}

const turn = async (state: 'visible' | 'hidden') => {
  page = state
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  downloads = []
  corrupt.clear()
  stalled.clear()
  weekly.subscriptions = []
  demo.on = false
  demo.polls = 0
  demo.stops = 0
  store.mint.mockReset()
  page = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => page })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((resolve, reject) => {
        const blob = new Blob([new Uint8Array(32)], { type: 'image/webp' })
        downloads.push({
          url: String(input),
          signal: init?.signal ?? undefined,
          answer: (ok = true) =>
            ok
              ? resolve({ ok: true, status: 200, blob: async () => blob } as unknown as Response)
              : reject(new TypeError('Failed to fetch')),
        })
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    }),
  )
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 1600
      naturalHeight = 900
      decoding = ''
      // an image named broken never decodes, as a failed original
      decode = async () => {
        if (this.src.includes('broken') || corrupt.has(this.src)) throw new Error('Broken image')
        if (stalled.has(this.src)) await new Promise(() => {})
      }
    },
  )
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:bytes-${++serial}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

/* The weekly image's subscription delivering `image`. */
const deliverWeek = (image: DailyImage | null) =>
  act(async () =>
    weekly.subscriptions
      .filter((s) => s.open)
      .at(-1)
      ?.receive(image),
  )

describe('the Canvas background and its preview', () => {
  it('reads the weekly preview from the derivative only, while Settings shows it, and stops it when Settings closes while the canvas loads on', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
    await settle()
    // the canvas asks for the original, the preview for the derivative
    expect(fetched('original').length).toBe(1)
    expect(fetched('preview').length).toBe(1)
    const canvas = fetched('original')[0] as Download
    const preview = fetched('preview')[0] as Download
    await render(false)
    expect(preview.signal?.aborted).toBe(true)
    expect(canvas.signal?.aborted).toBe(false)
    canvas.answer()
    await settle()
    expect(background()).toMatch(/^blob:/)
    expect(fetched('original').length).toBe(1)
  })

  it('goes on reading the preview while the canvas loads beside it', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
    await settle()
    const preview = fetched('preview')[0] as Download
    fetched('original')[0]?.answer()
    await settle()
    expect(background()).toMatch(/^blob:/)
    expect(preview.signal?.aborted).toBe(false)
    expect(fetched('preview')).toHaveLength(1)
    preview.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
  })

  it('shows the cached preview again on a second visit with no download', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
    await settle()
    fetched('preview')[0]?.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
    const first = shown().url
    await render(false)
    await render(true)
    expect(shown()).toMatchObject({ status: 'ready', url: first })
    expect(fetched('preview').length).toBe(1)
  })

  it('replaces a cached preview whose bytes no longer decode with the derivative read again', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
    await settle()
    fetched('preview')[0]?.answer()
    await settle()
    const first = shown().url as string
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
    // the cached bytes stop decoding; Settings opens again
    corrupt.add(first)
    await render(false)
    await render(true)
    expect(shown().status).toBe('loading')
    expect(fetched('preview')).toHaveLength(2)
    fetched('preview')[1]?.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
    expect(shown().url).not.toBe(first)
  })

  it('drops a cached preview whose decode never settles after 10 s and reads the derivative again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await render(true)
      await act(async () => store.deliver(preferences('daily')))
      await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
      await settle()
      fetched('preview')[0]?.answer()
      await settle()
      const first = shown().url as string
      expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
      // the cached bytes' decode stops answering; Settings opens again
      stalled.add(first)
      await render(false)
      await render(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999)
      })
      expect(shown().status).toBe('loading')
      expect(fetched('preview')).toHaveLength(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      await settle()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(first)
      expect(fetched('preview')).toHaveLength(2)
      fetched('preview')[1]?.answer()
      await settle()
      expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-1' })
      expect(shown().url).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the canvas’s own image for a weekly image without a derivative, and unavailable while the canvas has none', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('broken', null))
    await settle()
    expect(shown().status).toBe('loading')
    fetched('original')[0]?.answer(false)
    await settle()
    // the original failed and there is no derivative: nothing to show
    expect(shown().status).toBe('unavailable')
    await deliverWeek(daily('week-2', null))
    await settle()
    fetched('week-2/original')[0]?.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-2', url: background() })
    expect(fetched('preview')).toEqual([])
  })

  it('never shows an older selection’s preview that answers after a newer selection', async () => {
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', 'https://storage.test/week-1/preview.webp'))
    await settle()
    const old = fetched('week-1/preview')[0] as Download
    await deliverWeek(daily('week-2', 'https://storage.test/week-2/preview.webp'))
    await settle()
    old.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'loading', key: 'daily:week-2' })
    fetched('week-2/preview')[0]?.answer()
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', key: 'daily:week-2' })
  })

  it('stops the weekly image’s read while hidden, keeping the background, and reads again on return', async () => {
    await render(false)
    await act(async () => store.deliver(preferences('daily')))
    await deliverWeek(daily('week-1', null))
    await settle()
    fetched('original')[0]?.answer()
    await settle()
    const painted = background()
    expect(painted).toMatch(/^blob:/)
    await turn('hidden')
    expect(weekly.subscriptions.filter((s) => s.open)).toHaveLength(0)
    expect(background()).toBe(painted)
    await turn('visible')
    expect(weekly.subscriptions.filter((s) => s.open)).toHaveLength(1)
    await deliverWeek(daily('week-1', null))
    expect(background()).toBe(painted)
  })

  it('renews the custom lease once on return from a hidden page, keeping the background while hidden, and drops it on a refusal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const lease = () => ({
        image_id: 'image-1',
        url: `https://site.test/backgrounds/image-1?t=${Date.now()}`,
        preview_url: `https://site.test/background-previews/image-1?t=${Date.now()}`,
        expires_at: Date.now() + 600_000,
      })
      store.mint.mockImplementation(async () => lease())
      await render(false)
      await act(async () => store.deliver(preferences('custom')))
      await settle()
      expect(store.mint).toHaveBeenCalledOnce()
      fetched('/backgrounds/')[0]?.answer()
      await settle()
      const painted = background()
      expect(painted).toMatch(/^blob:/)
      await turn('hidden')
      // an hour hidden: no renewal, and the background stays past its lease
      await act(async () => {
        vi.advanceTimersByTime(3_600_000)
      })
      expect(store.mint).toHaveBeenCalledOnce()
      expect(background()).toBe(painted)
      store.mint.mockImplementation(async () => null)
      await turn('visible')
      expect(store.mint).toHaveBeenCalledTimes(2)
      // the refusal at the renewal drops it, as before
      expect(background()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a refused custom lease in Settings as unavailable with Reload preview, which asks for the lease again', async () => {
    store.mint.mockResolvedValue(null)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <AppearanceProvider accountId="account-1">
            <AppearanceSettings />
          </AppearanceProvider>
        </TooltipProvider>,
      ),
    )
    await settle()
    await act(async () => store.deliver(preferences('custom')))
    await settle()
    expect(store.mint).toHaveBeenCalledOnce()
    const text = () => container.querySelector('.aspect-video')?.textContent ?? ''
    expect(text()).toBe('Preview unavailable.')
    const reload = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload preview')
    expect(reload()).toBeDefined()
    // the image is back: Reload asks for the lease, and the preview shows
    store.mint.mockResolvedValue({
      image_id: 'image-1',
      url: 'https://site.test/backgrounds/image-1?t=2',
      preview_url: 'https://site.test/background-previews/image-1?t=2',
      expires_at: Date.now() + 600_000,
    })
    await act(async () => reload()?.click())
    await settle()
    expect(store.mint).toHaveBeenCalledTimes(2)
    fetched('/background-previews/')[0]?.answer()
    await settle()
    expect(container.querySelector('[data-appearance-preview]')?.getAttribute('src')).toMatch(
      /^blob:/,
    )
  })

  it('shows a custom preview whose lease ended after a failed renewal as unavailable with Reload preview, which asks for the lease again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const lease = () => ({
        image_id: 'image-1',
        url: `https://site.test/backgrounds/image-1?t=${Date.now()}`,
        preview_url: `https://site.test/background-previews/image-1?t=${Date.now()}`,
        expires_at: Date.now() + 600_000,
      })
      store.mint.mockImplementation(async () => lease())
      const open = (settings: boolean) =>
        act(async () =>
          root.render(
            <TooltipProvider>
              <AppearanceProvider accountId="account-1">
                {settings ? <AppearanceSettings /> : null}
              </AppearanceProvider>
            </TooltipProvider>,
          ),
        )
      await open(false)
      await act(async () => store.deliver(preferences('custom')))
      await settle()
      fetched('/backgrounds/')[0]?.answer()
      await settle()
      const painted = background()
      expect(painted).toMatch(/^blob:/)
      // the renewal a minute before the end fails, and so does its retry
      // at the end; the background stays
      store.mint.mockRejectedValue(new Error('offline'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(540_000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000)
      })
      expect(store.mint).toHaveBeenCalledTimes(3)
      expect(background()).toBe(painted)
      // Settings opens once the lease has ended
      await open(true)
      await act(async () => store.deliver(preferences('custom')))
      await settle()
      const text = () => container.querySelector('.aspect-video')?.textContent ?? ''
      expect(text()).toBe('Preview unavailable.')
      const reload = () =>
        [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload preview')
      expect(reload()).toBeDefined()
      expect(fetched('/background-previews/')).toEqual([])
      // Reload asks for the lease again, and the preview reads its derivative
      store.mint.mockImplementation(async () => lease())
      await act(async () => reload()?.click())
      await settle()
      expect(store.mint).toHaveBeenCalledTimes(4)
      fetched('/background-previews/')[0]?.answer()
      await settle()
      expect(container.querySelector('[data-appearance-preview]')?.getAttribute('src')).toMatch(
        /^blob:/,
      )
      expect(background()).toBe(painted)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the demo’s derivative URL to the preview and pauses its public feed while hidden', async () => {
    demo.on = true
    await render(true)
    await act(async () => store.deliver(preferences('daily')))
    await settle()
    expect(shown()).toMatchObject({ status: 'ready', url: 'https://public.test/preview.webp' })
    expect(demo.polls).toBe(1)
    await turn('hidden')
    expect(demo.stops).toBe(1)
    await turn('visible')
    expect(demo.polls).toBe(2)
  })
})
