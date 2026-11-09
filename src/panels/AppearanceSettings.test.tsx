// @vitest-environment jsdom
import { ConvexError } from 'convex/values'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AppearanceContext,
  type BackgroundPreview,
  NO_PREVIEW,
  useAppearance,
} from '../lib/appearanceContext'
import type { AppearancePreferences } from '../store/planner'
import { AppearanceSettings } from './AppearanceSettings'

/* What Settings › Appearance says for a custom background whose preview
   the demo's storage left no room for, how it shows a refusal, and that
   its previews come from the provider's preview, never a mint of its own.
   The page shows the account's appearance from the provider's context,
   answered here by a stand-in, and the store's save is answered by hand. */

const store = vi.hoisted(() => ({
  deliver: null as ((value: AppearancePreferences) => void) | null,
  save: vi.fn(),
  mint: vi.fn(async () => null),
}))
vi.mock('../store/planner', () => ({
  P: {
    setAppearance: store.save,
    mintAppearanceImageUrl: store.mint,
  },
}))

/* The provider's context with `preview`, counting who asks for it. */
const context = vi.hoisted(() => ({
  preview: null as BackgroundPreview | null,
  asks: 0,
  retries: 0,
  dailyImage: null as ReturnType<typeof useAppearance>['dailyImage'],
}))
function Provider({ children }: { children: React.ReactNode }) {
  const base = useAppearance()
  const [preferences, setPreferences] = useState<AppearancePreferences | null>(null)
  useEffect(() => {
    store.deliver = setPreferences
  }, [])
  return (
    <AppearanceContext.Provider
      value={{
        ...base,
        preferences,
        preferencesState: preferences ? 'ok' : 'loading',
        preferencesCurrent: true,
        dailyImage: context.dailyImage,
        preview: context.preview ?? NO_PREVIEW,
        wantPreview: () => {
          context.asks++
          return () => {
            context.asks--
          }
        },
        retryPreview: () => {
          context.retries++
        },
      }}
    >
      {children}
    </AppearanceContext.Provider>
  )
}

const custom = (
  image: Partial<NonNullable<AppearancePreferences['custom_image']>>,
): AppearancePreferences => ({
  mode: 'dark',
  image_source: 'custom',
  custom_image: {
    id: 'image-1',
    name: 'Lake.jpg',
    mime: 'image/jpeg',
    width: 1920,
    height: 1080,
    byte_size: 3 * 1024 * 1024,
    uploaded_at: '2026-09-16T12:00:00.000Z',
    preview_ready: false,
    preview_version: null,
    preview_skipped: false,
    ...image,
  },
})

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  store.save.mockReset()
  store.mint.mockClear()
  context.preview = null
  context.asks = 0
  context.retries = 0
  context.dailyImage = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await draw()
})

const draw = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <Provider>
          <AppearanceSettings />
        </Provider>
      </TooltipProvider>,
    ),
  )

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  // Settings never mints a URL of its own
  expect(store.mint).not.toHaveBeenCalled()
})

const deliver = (value: AppearancePreferences) => act(async () => store.deliver?.(value))
const previewText = () => container.querySelector('.aspect-video')?.textContent ?? ''

describe('Settings › Appearance', () => {
  it("says the demo's full storage left no room for a preview yet, and that the background shows", async () => {
    await deliver(custom({ preview_skipped: true }))
    expect(previewText()).toBe(
      "No preview yet, because the demo's file storage is full. Qivo makes one once 1 MiB is free, and your background still shows.",
    )
    // a preview still on its way says so
    await deliver(custom({ preview_skipped: false }))
    expect(previewText()).toBe('Preparing preview…')
  })

  it('shows a refusal with its first letter capitalized', async () => {
    await deliver(custom({}))
    store.save.mockRejectedValue(
      new ConvexError({ code: 'rule', message: 'the demo stores at most 5 MiB of files in total' }),
    )
    const none = container.querySelector<HTMLInputElement>('[data-appearance-source="none"]')
    await act(async () => none?.click())
    expect(container.querySelector('[data-appearance-error]')?.textContent).toBe(
      'The demo stores at most 5 MiB of files in total',
    )
  })

  it('shows the custom preview the provider read for this image and version, and asks only while open', async () => {
    const ready = custom({ preview_ready: true, preview_version: 2 })
    context.preview = {
      status: 'ready',
      url: 'blob:preview-2',
      key: 'custom:image-1',
      previewVersion: '1',
    }
    await deliver(ready)
    expect(context.asks).toBeGreaterThan(0)
    // a preview of an older version is not this one's
    expect(container.querySelector('[data-appearance-preview]')).toBeNull()
    expect(previewText()).toBe('Loading preview…')
    context.preview = { ...context.preview, previewVersion: '2' }
    await draw()
    expect(container.querySelector('[data-appearance-preview]')?.getAttribute('src')).toBe(
      'blob:preview-2',
    )
    await act(async () => root.unmount())
    expect(context.asks).toBe(0)
    root = createRoot(container)
  })

  it('offers Reload preview when the preview is unavailable, which asks the provider again', async () => {
    context.preview = {
      status: 'unavailable',
      url: null,
      key: 'custom:image-1',
      previewVersion: '2',
    }
    await draw()
    await deliver(custom({ preview_ready: true, preview_version: 2 }))
    expect(previewText()).toBe('Preview unavailable.')
    const reload = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reload preview',
    )
    await act(async () => reload?.click())
    expect(context.retries).toBe(1)
  })

  it('says the weekly preview loads while the provider waits for the week’s image', async () => {
    context.preview = { status: 'loading', url: null, key: null, previewVersion: null }
    await draw()
    await deliver({ mode: 'dark', image_source: 'daily', custom_image: null })
    expect(previewText()).toBe('Loading preview…')
    // nothing asked for or nothing to show is no loading
    context.preview = { status: 'unavailable', url: null, key: null, previewVersion: null }
    await draw()
    expect(previewText()).toBe('Preview unavailable.')
  })

  it('shows the weekly preview from the provider and never the original image', async () => {
    context.dailyImage = {
      id: 'week-1',
      image_url: 'https://storage.test/original.jpg',
      preview_url: null,
      title: 'Harbour',
      location: 'Gothenburg',
      creator: 'A. Photographer',
      filename: 'harbour.jpg',
      attribution: 'A. Photographer',
      source_url: 'https://example.com',
      license: 'CC BY',
      license_url: 'https://example.com/license',
    }
    context.preview = {
      status: 'unavailable',
      url: null,
      key: 'daily:week-1',
      previewVersion: null,
    }
    await draw()
    await deliver({ mode: 'dark', image_source: 'daily', custom_image: null })
    expect(previewText()).toBe('Preview unavailable.')
    expect(container.querySelector('img')).toBeNull()
    context.preview = {
      status: 'ready',
      url: 'blob:canvas-week-1',
      key: 'daily:week-1',
      previewVersion: null,
    }
    await draw()
    const img = container.querySelector('[data-appearance-weekly-preview]')
    expect(img?.getAttribute('src')).toBe('blob:canvas-week-1')
    expect(container.innerHTML).not.toContain('original.jpg')
  })
})
