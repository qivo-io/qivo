import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundPreview } from './backgroundPreview'

afterEach(() => vi.unstubAllGlobals())

function encoder(blob: Blob | null) {
  const drawImage = vi.fn()
  const toBlob = vi.fn((receive: BlobCallback) => receive(blob))
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob }
  vi.stubGlobal('document', { createElement: () => canvas })
  return { canvas, drawImage, toBlob }
}

describe('background previews', () => {
  it('creates a small WebP derivative without changing the decoded original', async () => {
    const blob = new Blob(['compressed preview'], { type: 'image/webp' })
    const { canvas, drawImage, toBlob } = encoder(blob)
    const image = { naturalWidth: 2560, naturalHeight: 1440 } as HTMLImageElement

    expect(await createBackgroundPreview(image)).toBe(blob)
    expect([canvas.width, canvas.height]).toEqual([960, 540])
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 960, 540)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.5)
    expect([image.naturalWidth, image.naturalHeight]).toEqual([2560, 1440])
  })

  it('does not enlarge an already small source', async () => {
    const { canvas } = encoder(new Blob(['preview'], { type: 'image/webp' }))
    await createBackgroundPreview({ naturalWidth: 320, naturalHeight: 180 } as HTMLImageElement)
    expect([canvas.width, canvas.height]).toEqual([320, 180])
  })

  it.each([
    null,
    new Blob(['fallback PNG'], { type: 'image/png' }),
    new Blob([], { type: 'image/webp' }),
  ])('rejects unavailable encoding instead of substituting original bytes (%s)', async (result) => {
    encoder(result)
    await expect(
      createBackgroundPreview({ naturalWidth: 2560, naturalHeight: 1440 } as HTMLImageElement),
    ).rejects.toThrow('Preview encoding is unavailable')
  })
})
