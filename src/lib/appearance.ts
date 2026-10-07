/** Each version is displayed only after decoding. The workspace requests the
 * original first; a newer selection or withdrawal wins over pending work. */
export type CanvasImage = {
  key: string
  url: string
  previewUrl?: string | null
  /** Stable byte identities are supplied only for the account-owned cache. */
  fullVersion?: string
  previewVersion?: string | null
}

export type CanvasImageQuality = 'preview' | 'full'
type DecodedCanvasImage = Pick<CanvasImage, 'key' | 'url' | 'previewVersion'>
type CanvasImageLoadOptions = {
  previewOnly?: boolean
  /** Request the original first and use the derivative only after it fails. */
  previewFallback?: boolean
}

export type CanvasImageState = {
  status: 'loading' | 'ready' | 'unavailable'
  image: DecodedCanvasImage | null
  quality: CanvasImageQuality | null
}

export function createCanvasImageLoader(
  decode: (
    url: string,
    image?: CanvasImage,
    quality?: CanvasImageQuality,
  ) => Promise<void | string>,
  receive: (state: CanvasImageState) => void,
) {
  let generation = 0
  let current: CanvasImage | null = null
  let displayed: DecodedCanvasImage | null = null
  let quality: CanvasImageQuality | null = null
  let preview: DecodedCanvasImage | null = null
  let pending = 0
  let disposed = false
  let previewOnly = false
  let previewFallback = false
  let displayedIdentity: string | null = null
  const requests = new Map<string, Promise<void | string>>()
  const publish = () =>
    receive({
      status: displayed ? 'ready' : pending ? 'loading' : 'unavailable',
      image: displayed,
      quality,
    })
  return {
    set(image: CanvasImage | null, options: CanvasImageLoadOptions = {}) {
      const nextPreviewOnly = options.previewOnly ?? false
      const nextPreviewFallback = !nextPreviewOnly && (options.previewFallback ?? false)
      if (
        disposed ||
        (image &&
          nextPreviewOnly === previewOnly &&
          nextPreviewFallback === previewFallback &&
          image.key === current?.key &&
          image.url === current.url &&
          image.fullVersion === current.fullVersion &&
          image.previewVersion === current.previewVersion &&
          (image.previewUrl || null) === (current.previewUrl || null))
      )
        return
      const sameImage = image?.key === current?.key
      const changedPreview = sameImage && image?.previewVersion !== current?.previewVersion
      current = image
      previewOnly = nextPreviewOnly
      previewFallback = nextPreviewFallback
      const request = ++generation
      pending = 0
      if (!sameImage) {
        requests.clear()
        displayed = null
        quality = null
        preview = null
        displayedIdentity = null
      }
      if (changedPreview) {
        requests.clear()
        preview = null
        if (quality === 'preview') {
          displayed = null
          displayedIdentity = null
          quality = null
        }
      }
      if (!image) {
        publish()
        return
      }
      // Preview-only surfaces must not inherit a full-quality paint or start
      // an original request. A missing derivative uses their solid fallback.
      if (previewOnly) {
        if (!image.previewUrl || image.previewUrl === image.url) preview = null
        displayed = preview
        quality = preview ? 'preview' : null
      }
      // A derivative arriving after the full image is already visible adds
      // no useful work. Same-image signed URL renewal keeps the current paint.
      const fullIdentity = image.fullVersion ? `full:${image.fullVersion}` : image.url
      if (quality === 'full' && displayedIdentity === fullIdentity) return
      const sources: { url: string; quality: CanvasImageQuality; identity: string }[] = []
      if (!previewOnly) sources.push({ url: image.url, quality: 'full', identity: fullIdentity })
      const previewSource =
        image.previewUrl && image.previewUrl !== image.url
          ? {
              url: image.previewUrl,
              quality: 'preview' as const,
              identity: image.fullVersion
                ? `preview:${image.fullVersion}:${image.previewVersion}`
                : image.previewUrl,
            }
          : null
      if (!previewFallback && quality !== 'full' && previewSource) sources.push(previewSource)
      const urls = new Set(sources.map((source) => source.identity))
      for (const url of requests.keys()) if (!urls.has(url)) requests.delete(url)
      pending = sources.length
      publish()
      let fallbackStarted = false
      const start = (source: (typeof sources)[number]) => {
        let decoded = requests.get(source.identity)
        if (!decoded) {
          try {
            decoded = image.fullVersion
              ? decode(source.url, image, source.quality)
              : decode(source.url)
          } catch (error) {
            decoded = Promise.reject(error)
          }
          requests.set(source.identity, decoded)
        }
        // Reuse pending/decoded previews when Canvas enables full quality,
        // and in-flight HQ when its preview arrives later. Only the latest
        // selection and loading mode may publish a completion.
        void decoded.then(
          (resolvedUrl) => {
            if (disposed || generation !== request) return
            pending--
            const reusable = !image.fullVersion || (resolvedUrl && resolvedUrl !== source.url)
            if (!reusable) requests.delete(source.identity)
            const ready = {
              key: image.key,
              url: resolvedUrl || source.url,
              ...(image.fullVersion ? { previewVersion: image.previewVersion } : {}),
            }
            if (source.quality === 'preview') {
              preview = ready
              if (quality === 'full') return
            }
            displayed = ready
            displayedIdentity = reusable ? source.identity : source.url
            quality = source.quality
            publish()
          },
          () => {
            if (disposed || generation !== request) return
            pending--
            if (image.fullVersion) requests.delete(source.identity)
            if (previewFallback && source.quality === 'full' && previewSource && !fallbackStarted) {
              fallbackStarted = true
              pending++
              publish()
              start(previewSource)
              return
            }
            // A decoded preview (or previous same-image lease) remains useful
            // if the full-size request fails. Wait if either request is pending.
            if (!displayed) publish()
          },
        )
      }
      for (const source of sources) start(source)
    },
    failed(image: DecodedCanvasImage) {
      if (disposed || image.key !== displayed?.key || image.url !== displayed.url) return
      if (quality === 'full' && previewFallback) {
        // A rare DOM rendering failure after decode gets the same derivative
        // fallback as a failed original request.
        this.set(current, { previewOnly: true })
        return
      }
      // A rendering failure must not cancel the HQ request still loading
      // behind a preview. Ignore errors from an already replaced DOM image.
      if (quality === 'preview') preview = null
      displayed = preview
      quality = preview ? 'preview' : null
      publish()
    },
    dispose() {
      disposed = true
      generation++
      requests.clear()
    },
  }
}

export async function decodeCanvasImage(url: string) {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty background image')
}

/** Operator-entered credit URLs are links, never executable URL schemes. */
export function imageCreditUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}
