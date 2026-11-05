// @vitest-environment jsdom
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppearancePreferences } from '../store/planner'
import { AppearanceSettings } from './AppearanceSettings'

/* What Settings › Appearance says for a custom background whose preview
   the demo's storage left no room for, and how it shows a refusal. The
   store's appearance read and save are answered by hand. */

const store = vi.hoisted(() => ({
  deliver: null as ((value: AppearancePreferences) => void) | null,
  save: vi.fn(),
}))
vi.mock('../store/planner', () => ({
  P: {
    watchAppearance: (next: (value: AppearancePreferences) => void) => {
      store.deliver = next
      return () => {}
    },
    setAppearance: store.save,
    mintAppearanceImageUrl: async () => null,
  },
}))

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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AppearanceSettings />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const deliver = (value: AppearancePreferences) => act(async () => store.deliver?.(value))
const previewText = () => container.querySelector('.aspect-video')?.textContent ?? ''

describe('Settings › Appearance', () => {
  it("says the demo's full storage left no room for a preview, and that the background shows", async () => {
    await deliver(custom({ preview_skipped: true }))
    expect(previewText()).toBe(
      "No preview, because the demo's file storage is full. Your background still shows.",
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
})
