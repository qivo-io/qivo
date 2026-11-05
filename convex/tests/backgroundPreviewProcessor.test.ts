// @vitest-environment node
/* Native decoding is tested in Node, matching the deployed action runtime. */
import { getFunctionName } from 'convex/server'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { ActionCtx } from '../_generated/server'
import { compressedBackgroundPreview, generate } from '../backgroundPreviewProcessor'
import { BACKGROUND_PREVIEW_VERSION } from '../lib/backgroundPreviews'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
  readonly type: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

const pixels = (width = 1920, height = 1080) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 170 } },
  })

describe('compressed background preview encoding', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodes %s into a smaller 960px WebP without changing the original bytes',
    async (format) => {
      const original = await pixels().toFormat(format).toBuffer()
      const saved = new Uint8Array(original)
      const preview = await compressedBackgroundPreview(original)
      expect(await sharp(preview).metadata()).toMatchObject({
        format: 'webp',
        width: 960,
        height: 540,
      })
      expect(preview.byteLength).toBeLessThan(original.byteLength)
      expect(new Uint8Array(original)).toEqual(saved)
    },
  )

  it('honors EXIF orientation, strips original metadata and does not enlarge small images', async () => {
    const rotated = await pixels(1800, 1200).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const metadata = await sharp(await compressedBackgroundPreview(rotated)).metadata()
    expect(metadata).toMatchObject({ width: 960, height: 1440, format: 'webp' })
    expect(metadata.exif).toBeUndefined()
    expect(metadata.orientation).toBeUndefined()
    expect(
      await sharp(
        await compressedBackgroundPreview(await pixels(320, 200).png().toBuffer()),
      ).metadata(),
    ).toMatchObject({ width: 320, height: 200 })
  })

  it('rejects undecodable bytes instead of retaining an original as a preview', async () => {
    await expect(compressedBackgroundPreview(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})

describe('background preview action orchestration', () => {
  const args = { kind: 'library' as const, id: 'image-uuid', storage_id: 'original-storage' }
  const invoke = (ctx: unknown, extra = {}) =>
    (
      generate as unknown as {
        _handler(ctx: ActionCtx, args: unknown): Promise<string>
      }
    )._handler(ctx as ActionCtx, { ...args, ...extra })

  async function context() {
    const blob = new Blob([await pixels().png().toBuffer()], { type: 'image/png' })
    return {
      runQuery: vi.fn(async (_ref: unknown, _args: unknown) => true),
      runMutation: vi.fn(async (_ref: unknown, _args: unknown) => true),
      storage: {
        get: vi.fn(async (_id: unknown) => blob),
        store: vi.fn(async (_blob: Blob) => 'preview-storage'),
      },
      scheduler: {
        runAfter: vi.fn(async (_delay: number, _ref: unknown, _args: unknown) => 'job'),
      },
    }
  }

  it('stores a WebP derivative and attaches it with the original identity fence', async () => {
    const ctx = await context()
    expect(await invoke(ctx)).toBe('ready')
    const saved = ctx.storage.store.mock.calls[0][0]
    expect(saved.type).toBe('image/webp')
    expect(await sharp(new Uint8Array(await saved.arrayBuffer())).metadata()).toMatchObject({
      width: 960,
      height: 540,
    })
    expect(getFunctionName(ctx.runMutation.mock.calls[0][0] as never)).toBe(
      'backgroundPreviews:attach',
    )
    expect(ctx.runMutation.mock.calls[0][1]).toEqual({
      ...args,
      preview_storage_id: 'preview-storage',
      preview_version: BACKGROUND_PREVIEW_VERSION,
    })
  })

  it('does no decoding or storage when the original was replaced or a preview already exists', async () => {
    const ctx = await context()
    ctx.runQuery.mockResolvedValue(false)
    expect(await invoke(ctx)).toBe('skipped')
    expect(ctx.storage.get).not.toHaveBeenCalled()
    expect(ctx.storage.store).not.toHaveBeenCalled()
  })

  it('limits transient retries and cleans up after an ambiguous attachment response through reference-aware cleanup', async () => {
    const ctx = await context()
    ctx.runMutation.mockRejectedValueOnce(new Error('Lost acknowledgment'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await invoke(ctx)).toBe('failed')
      expect(getFunctionName(ctx.runMutation.mock.calls[1][0] as never)).toBe(
        'panoramaImages:discardImport',
      )
      expect(ctx.runMutation.mock.calls[1][1]).toEqual({ storage_id: 'preview-storage' })
      expect(ctx.scheduler.runAfter.mock.calls[0][0]).toBe(1000)
      expect(ctx.scheduler.runAfter.mock.calls[0][2]).toEqual({ ...args, attempt: 1 })
      const exhausted = await context()
      exhausted.storage.get.mockRejectedValue(new Error('Storage unavailable'))
      expect(await invoke(exhausted, { attempt: 2 })).toBe('failed')
      expect(exhausted.scheduler.runAfter).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  it("skips a demo background's preview without retrying when no room was reserved", async () => {
    vi.stubEnv('APP_MODE', 'demo')
    try {
      const ctx = await context()
      ctx.runMutation.mockResolvedValueOnce(null as never)
      expect(await invoke(ctx, { kind: 'custom' })).toBe('skipped')
      expect(getFunctionName(ctx.runMutation.mock.calls[0][0] as never)).toBe(
        'backgroundPreviews:beginDemoWork',
      )
      expect(ctx.storage.get).not.toHaveBeenCalled()
      expect(ctx.scheduler.runAfter).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('stores no demo preview larger than its reservation, records the skip and releases it', async () => {
    vi.stubEnv('APP_MODE', 'demo')
    try {
      const ctx = await context()
      const work = { id: 'reservation', authId: 'login', bytes: 10 }
      ctx.runMutation.mockResolvedValueOnce(work as never)
      expect(await invoke(ctx, { kind: 'custom' })).toBe('skipped')
      const names = ctx.runMutation.mock.calls.map(([ref]) => getFunctionName(ref as never))
      expect(names).toEqual([
        'backgroundPreviews:beginDemoWork',
        'backgroundPreviews:skipDemoPreview',
        'demoUploads:abandon',
      ])
      expect(ctx.runMutation.mock.calls[1][1]).toEqual({ ...args, kind: 'custom', bytes: 10 })
      expect(ctx.runMutation.mock.calls[2][1]).toEqual({
        id: 'reservation',
        minter: 'login',
        storage_id: undefined,
      })
      expect(ctx.storage.store).not.toHaveBeenCalled()
      expect(ctx.scheduler.runAfter).not.toHaveBeenCalled()
      // one that fits is stored and attached against the reservation
      const fits = await context()
      fits.runMutation.mockResolvedValueOnce({ ...work, bytes: 1024 * 1024 } as never)
      expect(await invoke(fits, { kind: 'custom' })).toBe('ready')
      expect(fits.runMutation.mock.calls[1][1]).toMatchObject({ demo_ticket_id: 'reservation' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not retry a corrupt image or write any derivative bytes', async () => {
    const ctx = await context()
    ctx.storage.get.mockResolvedValue(new Blob(['invalid'], { type: 'image/png' }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await invoke(ctx)).toBe('failed')
      expect(ctx.storage.store).not.toHaveBeenCalled()
      expect(ctx.scheduler.runAfter).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})
