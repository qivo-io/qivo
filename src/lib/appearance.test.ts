import { describe, expect, it, vi } from 'vitest'
import { createCanvasImageLoader, imageCreditUrl } from './appearance'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
const first = { key: 'daily:lake', url: 'https://images.test/lake.jpg' }
const second = { key: 'custom:mountain', url: 'https://images.test/private?token=first' }

describe('Canvas background request lifetime', () => {
  it('waits for successful decoding and falls back when decoding fails', async () => {
    const request = deferred()
    const receive = vi.fn()
    const loader = createCanvasImageLoader(() => request.promise, receive)
    loader.set(first)
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    request.reject(new Error('broken file'))
    await request.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
  })

  it('cannot resurrect an image withdrawn while it was loading', async () => {
    const request = deferred()
    const receive = vi.fn()
    const loader = createCanvasImageLoader(() => request.promise, receive)
    loader.set(first)
    loader.set(null)
    request.resolve()
    await request.promise
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
  })

  it('ignores a superseded image even if its request finishes after the new choice', async () => {
    const oldRequest = deferred()
    const newRequest = deferred()
    const receive = vi.fn()
    const loader = createCanvasImageLoader(
      (url) => (url === first.url ? oldRequest.promise : newRequest.promise),
      receive,
    )
    loader.set(first)
    loader.set(second)
    newRequest.resolve()
    await newRequest.promise
    oldRequest.resolve()
    await oldRequest.promise
    expect(receive).toHaveBeenCalledTimes(3)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: second, quality: 'full' })
  })

  it('preserves a decoded image during signed URL renewal, but clears it on replacement', async () => {
    const request = deferred()
    const receive = vi.fn()
    const decode = vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(request.promise)
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(second)
    await Promise.resolve()
    const renewed = { ...second, url: 'https://images.test/private?token=renewed' }
    loader.set(renewed)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: second, quality: 'full' })
    loader.set(first)
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    request.resolve()
    await request.promise
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('does not redownload unchanged selections and ignores completion after unmount', async () => {
    const request = deferred()
    const receive = vi.fn()
    const decode = vi.fn(() => request.promise)
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(first)
    loader.set({ ...first })
    expect(decode).toHaveBeenCalledTimes(1)
    loader.dispose()
    request.resolve()
    await request.promise
    expect(receive).toHaveBeenCalledTimes(1)
  })
})

const progressive = { ...first, previewUrl: 'https://images.test/lake-preview.webp' }
const readyPreview = { key: first.key, url: progressive.previewUrl }

function progressiveLoader(options: { previewFallback?: boolean } = {}) {
  const full = deferred()
  const preview = deferred()
  const receive = vi.fn()
  const decode = vi.fn((url: string) => (url === first.url ? full.promise : preview.promise))
  const loader = createCanvasImageLoader(decode, receive)
  loader.set(progressive, options)
  return { full, preview, receive, decode, loader }
}

describe('preview-only background loading', () => {
  it('decodes only the preview and deduplicates unchanged preview-only selections', async () => {
    const preview = deferred()
    const receive = vi.fn()
    const decode = vi.fn(() => preview.promise)
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(progressive, { previewOnly: true })
    loader.set({ ...progressive }, { previewOnly: true })
    expect(decode.mock.calls).toEqual([[progressive.previewUrl]])
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'decoded'] as const)(
    'reuses a %s preview and keeps its paint when Canvas enables full quality for the same URLs',
    async (state) => {
      const preview = deferred()
      const full = deferred()
      const receive = vi.fn()
      const decode = vi.fn((url: string) => (url === first.url ? full.promise : preview.promise))
      const loader = createCanvasImageLoader(decode, receive)
      loader.set(progressive, { previewOnly: true })
      if (state === 'decoded') {
        preview.resolve()
        await preview.promise
      }
      loader.set({ ...progressive })
      expect(decode.mock.calls.map(([url]) => url)).toEqual([progressive.previewUrl, first.url])
      if (state === 'decoded') {
        expect(receive).toHaveBeenLastCalledWith({
          status: 'ready',
          image: readyPreview,
          quality: 'preview',
        })
      } else {
        expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
        preview.resolve()
        await preview.promise
        expect(receive).toHaveBeenLastCalledWith({
          status: 'ready',
          image: readyPreview,
          quality: 'preview',
        })
      }
      full.resolve()
      await full.promise
      expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
      expect(decode).toHaveBeenCalledTimes(2)
    },
  )

  it('does not downgrade when full quality finishes before the reused preview', async () => {
    const preview = deferred()
    const full = deferred()
    const receive = vi.fn()
    const loader = createCanvasImageLoader(
      (url) => (url === first.url ? full.promise : preview.promise),
      receive,
    )
    loader.set(progressive, { previewOnly: true })
    loader.set(progressive, { previewOnly: false })
    full.resolve()
    await full.promise
    const paints = receive.mock.calls.length
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenCalledTimes(paints)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it.each([undefined, null, first.url])(
    'settles unavailable without downloading the original when previewUrl is %s',
    async (previewUrl) => {
      const receive = vi.fn()
      const decode = vi.fn().mockResolvedValue(undefined)
      const loader = createCanvasImageLoader(decode, receive)
      const image = { ...first, previewUrl }
      loader.set(image, { previewOnly: true })
      expect(decode).not.toHaveBeenCalled()
      expect(receive).toHaveBeenLastCalledWith({
        status: 'unavailable',
        image: null,
        quality: null,
      })
      loader.set(image)
      expect(decode.mock.calls).toEqual([[first.url]])
      await Promise.resolve()
      expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
    },
  )

  it('does not fall through to the original on a failed preview, but can enable full quality later', async () => {
    const preview = deferred()
    const full = deferred()
    const receive = vi.fn()
    const decode = vi.fn((url: string) => (url === first.url ? full.promise : preview.promise))
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(progressive, { previewOnly: true })
    preview.reject(new Error('preview unavailable'))
    await preview.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
    expect(decode.mock.calls).toEqual([[progressive.previewUrl]])
    loader.set(progressive)
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
    expect(decode.mock.calls.map(([url]) => url)).toEqual([progressive.previewUrl, first.url])
  })

  it('ignores an ongoing full request after returning to preview-only mode', async () => {
    const { full, preview, receive, loader, decode } = progressiveLoader()
    preview.resolve()
    await preview.promise
    loader.set(progressive, { previewOnly: true })
    await Promise.resolve()
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
    const paints = receive.mock.calls.length
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenCalledTimes(paints)
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it.each(['withdraw', 'replace', 'dispose'] as const)(
    'ignores pending preview completion after %s',
    async (operation) => {
      const preview = deferred()
      const receive = vi.fn()
      const decode = vi.fn(() => preview.promise)
      const loader = createCanvasImageLoader(decode, receive)
      loader.set(progressive, { previewOnly: true })
      if (operation === 'withdraw') loader.set(null)
      if (operation === 'replace') loader.set(second, { previewOnly: true })
      if (operation === 'dispose') loader.dispose()
      const paints = receive.mock.calls.length
      preview.resolve()
      await preview.promise
      expect(receive).toHaveBeenCalledTimes(paints)
      expect(decode.mock.calls).toEqual([[progressive.previewUrl]])
    },
  )
})

describe('progressive Canvas backgrounds', () => {
  it('keeps the original first and uses the derivative only after the original fails', async () => {
    const { full, preview, receive, decode } = progressiveLoader({ previewFallback: true })
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url])
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    full.reject(new Error('original unavailable'))
    await full.promise.catch(() => {})
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url, progressive.previewUrl])
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
  })

  it('displays a decoded original directly without starting the derivative', async () => {
    const { full, preview, receive, decode } = progressiveLoader({ previewFallback: true })
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url])
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('loads the derivative if the decoded original later fails to render', async () => {
    const { full, preview, receive, decode, loader } = progressiveLoader({ previewFallback: true })
    full.resolve()
    await full.promise
    loader.failed(first)
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url, progressive.previewUrl])
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
  })

  it('settles on the solid fallback when both sequential requests fail', async () => {
    const { full, preview, receive } = progressiveLoader({ previewFallback: true })
    full.reject(new Error('original unavailable'))
    await full.promise.catch(() => {})
    preview.reject(new Error('derivative unavailable'))
    await preview.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
  })

  it.each(['withdraw', 'replace', 'dispose'] as const)(
    'does not start a stale fallback after %s',
    async (operation) => {
      const { full, receive, decode, loader } = progressiveLoader({ previewFallback: true })
      if (operation === 'withdraw') loader.set(null, { previewFallback: true })
      if (operation === 'replace') loader.set(second, { previewFallback: true })
      if (operation === 'dispose') loader.dispose()
      const paints = receive.mock.calls.length
      full.reject(new Error('old original unavailable'))
      await full.promise.catch(() => {})
      expect(decode.mock.calls.map(([url]) => url)).not.toContain(progressive.previewUrl)
      expect(receive).toHaveBeenCalledTimes(paints)
    },
  )

  it('starts both requests together, paints the decoded preview, then swaps to decoded HQ', async () => {
    const { full, preview, receive, decode } = progressiveLoader()
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url, progressive.previewUrl])
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('never downgrades when HQ decodes before the preview', async () => {
    const { full, preview, receive } = progressiveLoader()
    full.resolve()
    await full.promise
    const paints = receive.mock.calls.length
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenCalledTimes(paints)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it.each(['before', 'after'])(
    'retains a preview when HQ fails %s preview decoding',
    async (order) => {
      const { full, preview, receive } = progressiveLoader()
      if (order === 'before') {
        full.reject(new Error('HQ unavailable'))
        await full.promise.catch(() => {})
        expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
      }
      preview.resolve()
      await preview.promise
      if (order === 'after') {
        full.reject(new Error('HQ unavailable'))
        await full.promise.catch(() => {})
      }
      expect(receive).toHaveBeenLastCalledWith({
        status: 'ready',
        image: readyPreview,
        quality: 'preview',
      })
    },
  )

  it('can display HQ when the preview fails', async () => {
    const { full, preview, receive } = progressiveLoader()
    preview.reject(new Error('preview unavailable'))
    await preview.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('uses solid fallback only after both versions fail', async () => {
    const { full, preview, receive } = progressiveLoader()
    full.reject(new Error('HQ unavailable'))
    await full.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    preview.reject(new Error('preview unavailable'))
    await preview.promise.catch(() => {})
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
  })

  it('withdrawal clears a painted preview and ignores its pending HQ completion', async () => {
    const { full, preview, receive, loader } = progressiveLoader()
    preview.resolve()
    await preview.promise
    loader.set(null)
    const paints = receive.mock.calls.length
    full.resolve()
    await full.promise
    expect(receive).toHaveBeenCalledTimes(paints)
    expect(receive).toHaveBeenLastCalledWith({ status: 'unavailable', image: null, quality: null })
  })

  it.each([false, true])(
    'replacement ignores both old versions (preview already painted: %s)',
    async (painted) => {
      const oldFull = deferred()
      const oldPreview = deferred()
      const newFull = deferred()
      const receive = vi.fn()
      const loader = createCanvasImageLoader(
        (url) =>
          url === first.url
            ? oldFull.promise
            : url === progressive.previewUrl
              ? oldPreview.promise
              : newFull.promise,
        receive,
      )
      loader.set(progressive)
      if (painted) {
        oldPreview.resolve()
        await oldPreview.promise
      }
      const paints = receive.mock.calls.length
      loader.set(second)
      expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
      newFull.resolve()
      await newFull.promise
      oldPreview.resolve()
      oldFull.resolve()
      await Promise.all([oldPreview.promise, oldFull.promise])
      expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: second, quality: 'full' })
      expect(
        receive.mock.calls
          .slice(paints)
          .every(([state]) => !state.image || state.image.key === second.key),
      ).toBe(true)
    },
  )

  it('adds a late derivative without restarting HQ or downgrading a finished full image', async () => {
    const full = deferred()
    const preview = deferred()
    const receive = vi.fn()
    const decode = vi.fn((url: string) => (url === first.url ? full.promise : preview.promise))
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(first)
    loader.set(progressive)
    expect(decode.mock.calls.map(([url]) => url)).toEqual([first.url, progressive.previewUrl])
    preview.resolve()
    await preview.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
    full.resolve()
    await full.promise
    loader.set({ ...progressive, previewUrl: 'https://images.test/unused-preview.webp' })
    expect(decode).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('retains the decoded preview if renewed private URLs fail and ignores the old HQ completion', async () => {
    const oldFull = deferred()
    const oldPreview = deferred()
    const renewed = deferred()
    const receive = vi.fn()
    const image = { ...second, previewUrl: 'https://images.test/private-preview?token=first' }
    const decode = vi.fn((url: string) =>
      url === image.url
        ? oldFull.promise
        : url === image.previewUrl
          ? oldPreview.promise
          : renewed.promise,
    )
    const loader = createCanvasImageLoader(decode, receive)
    loader.set(image)
    oldPreview.resolve()
    await oldPreview.promise
    const displayed = { key: image.key, url: image.previewUrl }
    loader.set({
      ...image,
      url: 'https://images.test/private?token=new',
      previewUrl: 'https://images.test/private-preview?token=new',
    })
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: displayed,
      quality: 'preview',
    })
    renewed.reject(new Error('temporary renewal failure'))
    await renewed.promise.catch(() => {})
    oldFull.resolve()
    await oldFull.promise
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: displayed,
      quality: 'preview',
    })
  })

  it('keeps loading HQ if a decoded preview fails to render, and ignores errors from old DOM images', async () => {
    const { full, preview, receive, loader } = progressiveLoader()
    preview.resolve()
    await preview.promise
    loader.failed(readyPreview)
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading', image: null, quality: null })
    full.resolve()
    await full.promise
    const paints = receive.mock.calls.length
    loader.failed(readyPreview)
    expect(receive).toHaveBeenCalledTimes(paints)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })

  it('can recover the decoded preview if HQ subsequently fails to render', async () => {
    const { full, preview, receive, loader } = progressiveLoader()
    preview.resolve()
    await preview.promise
    full.resolve()
    await full.promise
    loader.failed(first)
    expect(receive).toHaveBeenLastCalledWith({
      status: 'ready',
      image: readyPreview,
      quality: 'preview',
    })
  })

  it('deduplicates unchanged pairs, decodes identical preview/HQ URLs once, and stays silent after disposal', async () => {
    const { full, preview, receive, decode, loader } = progressiveLoader()
    loader.set({ ...progressive })
    expect(decode).toHaveBeenCalledTimes(2)
    loader.dispose()
    loader.set(second)
    full.resolve()
    preview.resolve()
    await Promise.all([full.promise, preview.promise])
    expect(receive).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(2)

    const sameUrlDecode = vi.fn().mockResolvedValue(undefined)
    const sameUrlLoader = createCanvasImageLoader(sameUrlDecode, receive)
    sameUrlLoader.set({ ...first, previewUrl: first.url })
    await Promise.resolve()
    expect(sameUrlDecode).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenLastCalledWith({ status: 'ready', image: first, quality: 'full' })
  })
})

describe('background image credit links', () => {
  it('permits web attribution links and makes unsupported schemes plain text', () => {
    expect(imageCreditUrl('https://example.org/image')).toBe('https://example.org/image')
    for (const value of ['javascript:alert(1)', 'data:text/html,x', '', '/relative'])
      expect(imageCreditUrl(value)).toBeUndefined()
  })
})
