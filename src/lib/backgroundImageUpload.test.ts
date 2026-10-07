import { afterEach, describe, expect, it, vi } from 'vitest'
import { importBackgroundImages, prepareBackgroundImage } from './backgroundImageUpload'
import fixture from './fixtures/background-windows-exif.json'

const app1 = Uint8Array.from(atob(fixture.app1Base64), (char) => char.charCodeAt(0))

function file(name: string, metadata = app1) {
  // Valid JPEG frame header; pixel decoding is exercised by the browser drive.
  const frame = [0xff, 0xc0, 0, 11, 8, 4, 56, 7, 128, 1, 1, 0x11, 0]
  const bytes = new Uint8Array([0xff, 0xd8, ...metadata, ...frame, 0xff, 0xd9])
  return new File([bytes], name, { type: 'image/jpeg' })
}

function withoutCredit(field: 'title' | 'creator') {
  const bytes = app1.slice()
  const view = new DataView(bytes.buffer, 10)
  const count = view.getUint16(8)
  for (let index = 0; index < count; index++) {
    const entry = 10 + index * 12
    const tag = view.getUint16(entry)
    if ((field === 'title' ? [0x9c9b, 0x010e] : [0x9c9d, 0x013b]).includes(tag))
      view.setUint16(entry, 0)
  }
  return bytes
}

function decoder() {
  const decode = vi.fn().mockResolvedValue(undefined)
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 1920
      naturalHeight = 1080
      decode = decode
    },
  )
  return { decode, revoke }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const message = (error: unknown) => (error instanceof Error ? error.message : 'Upload failed')

describe('background image batch upload', () => {
  it('skips missing title or author before decoding or uploading, regardless of the filename', async () => {
    const { decode, revoke } = decoder()
    const save = vi.fn()
    const files = [
      file('Known title - Known author.jpg', new Uint8Array()),
      file('without-title.jpg', withoutCredit('title')),
      file('without-author.jpg', withoutCredit('creator')),
    ]
    const result = await importBackgroundImages(files, save, vi.fn(), message)
    expect(result).toEqual({
      added: 0,
      reused: 0,
      missingMetadata: files.map((image) => image.name),
      failed: [],
    })
    expect(save).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('uploads credited originals one at a time, including optional location, and counts reused images', async () => {
    const { decode, revoke } = decoder()
    const files = [file('first.jpg'), file('second.jpg')]
    const progress = vi.fn()
    const save = vi.fn(async (image: File) => {
      // The next image must not be decoded until this save has completed.
      expect(decode).toHaveBeenCalledTimes(image === files[0] ? 1 : 2)
      await Promise.resolve()
      return { reused: image === files[1] }
    })
    const result = await importBackgroundImages(files, save, progress, message)
    expect(result).toEqual({ added: 1, reused: 1, missingMetadata: [], failed: [] })
    expect(save).toHaveBeenNthCalledWith(1, files[0], fixture.expected)
    expect(save).toHaveBeenNthCalledWith(2, files[1], fixture.expected)
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { current: 1, total: 2, name: 'first.jpg' },
      { current: 2, total: 2, name: 'second.jpg' },
    ])
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('keeps successful uploads and continues after invalid files, decode failures and refused saves', async () => {
    const { decode, revoke } = decoder()
    decode.mockRejectedValueOnce(new Error('Broken pixels'))
    const files = [
      new File(['invalid'], 'invalid.jpg', { type: 'image/jpeg' }),
      file('broken.jpg'),
      file('refused.jpg'),
      file('successful.jpg'),
    ]
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Previously removed by a reviewer'))
      .mockResolvedValueOnce({ reused: false })
    const result = await importBackgroundImages(files, save, vi.fn(), message)
    expect(result.added).toBe(1)
    expect(result.missingMetadata).toEqual([])
    expect(result.failed).toEqual([
      { name: 'invalid.jpg', message: expect.stringMatching(/not a JPEG/) },
      { name: 'broken.jpg', message: expect.stringMatching(/could not be decoded/) },
      { name: 'refused.jpg', message: 'Previously removed by a reviewer' },
    ])
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(files[3], fixture.expected)
    expect(revoke).toHaveBeenCalledTimes(3)
  })

  it('retains the single-file editable workflow for files without credits and releases its original URL', async () => {
    const { revoke } = decoder()
    // An unavailable preview encoder leaves a placeholder.
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
    const image = file('edit-me.jpg', new Uint8Array())
    expect(await prepareBackgroundImage(image, { preview: true })).toEqual({
      metadata: {},
      dimensions: { width: 1920, height: 1080 },
      preview: null,
    })
    expect(revoke).toHaveBeenCalledTimes(1)
  })
})
