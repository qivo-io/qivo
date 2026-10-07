import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'

export type DemoCanvasImage = NonNullable<FunctionReturnType<typeof api.appearance.dailyImage>>
export const DEMO_CANVAS_FEED_URL = 'https://api.qivo.io/public/canvas'
export const DEMO_CANVAS_REFRESH_MS = 60_000
export const DEMO_CANVAS_TIMEOUT_MS = 10_000

function publicUrl(value: string, development: boolean): URL {
  const url = new URL(value)
  const local =
    development &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !local) || url.username || url.password)
    throw new Error('Invalid public Canvas URL')
  return url
}

export function demoCanvasFeedUrl(
  value = import.meta.env.VITE_DEMO_CANVAS_FEED_URL || DEMO_CANVAS_FEED_URL,
  development = import.meta.env.DEV,
): string {
  const url = publicUrl(value, development)
  if (url.search || url.hash) throw new Error('The public Canvas feed must not contain URL state')
  return url.href
}

function readImage(value: unknown): DemoCanvasImage | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid public Canvas response')
  const row = value as Record<string, unknown>
  for (const name of [
    'id',
    'title',
    'creator',
    'attribution',
    'source_url',
    'license',
    'license_url',
  ])
    if (typeof row[name] !== 'string') throw new Error('Invalid public Canvas metadata')
  for (const name of ['location', 'filename'])
    if (row[name] !== undefined && typeof row[name] !== 'string')
      throw new Error('Invalid public Canvas metadata')
  for (const name of ['image_url', 'preview_url']) {
    const url = row[name]
    if (url !== null) {
      if (typeof url !== 'string') throw new Error('Invalid public Canvas image')
      publicUrl(url, import.meta.env.DEV)
    }
  }
  return {
    id: row.id as string,
    image_url: row.image_url as string | null,
    preview_url: row.preview_url as string | null,
    title: row.title as string,
    location: row.location as string | undefined,
    creator: row.creator as string,
    filename: row.filename as string | undefined,
    attribution: row.attribution as string,
    source_url: row.source_url as string,
    license: row.license as string,
    license_url: row.license_url as string,
  }
}

/** Each watcher uses its supplied UTC date; the provider replaces it when the
 * week changes. A withdrawal or failed refresh
 * clears its image; stopping aborts work and prevents any late reply painting. */
export function watchDemoCanvas(date: string, receive: (image: DemoCanvasImage | null) => void) {
  let endpoint: URL
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new Error('Invalid Canvas date')
    endpoint = new URL(demoCanvasFeedUrl())
    endpoint.searchParams.set('date', date)
  } catch {
    receive(null)
    return () => {}
  }

  let active = true
  let pending: { controller: AbortController; timer?: ReturnType<typeof setTimeout> } | null = null
  const refresh = () => {
    if (!active || pending) return
    const request = {
      controller: new AbortController(),
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    pending = request
    request.timer = setTimeout(() => {
      if (!active || pending !== request) return
      pending = null
      request.controller.abort()
      receive(null)
    }, DEMO_CANVAS_TIMEOUT_MS)
    void (async () => {
      try {
        const response = await fetch(endpoint.href, {
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: request.controller.signal,
        })
        if (!response.ok) throw new Error('Public Canvas feed unavailable')
        const image = readImage(await response.json())
        if (active && pending === request) receive(image)
      } catch {
        if (active && pending === request) receive(null)
      } finally {
        clearTimeout(request.timer)
        if (pending === request) pending = null
      }
    })()
  }
  const resume = () => {
    if (document.visibilityState === 'visible') refresh()
  }
  const interval = setInterval(refresh, DEMO_CANVAS_REFRESH_MS)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('focus', resume)
  refresh()
  return () => {
    active = false
    clearInterval(interval)
    clearTimeout(pending?.timer)
    pending?.controller.abort()
    pending = null
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('focus', resume)
  }
}
