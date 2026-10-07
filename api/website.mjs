import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Proxy the protected staging website without exposing its automation credential. */
export async function websiteProxy(
  request,
  response,
  { env = process.env, fetchImpl = fetch } = {},
) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Robots-Tag', 'noindex, nofollow')
  if (env.QIVO_ENVIRONMENT !== 'staging' || request.headers.host !== 'preview.qivo.io') {
    response.statusCode = 404
    return response.end()
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.statusCode = 405
    response.setHeader('Allow', 'GET, HEAD')
    return response.end()
  }
  if (!env.QIVO_SITE_PROTECTION_BYPASS) {
    response.statusCode = 503
    return response.end('Website preview is not configured.')
  }
  const incoming = new URL(request.url, 'https://preview.qivo.io')
  const paths = incoming.searchParams.getAll('__qivo_path')
  if (
    paths.length !== 1 ||
    paths[0].includes('\\') ||
    Array.from(paths[0]).some((character) => character.charCodeAt(0) < 32) ||
    paths[0].startsWith('/')
  ) {
    response.statusCode = 400
    return response.end()
  }
  const upstream = new URL(`/${paths[0]}`, 'https://site-preview.qivo.io')
  incoming.searchParams.delete('__qivo_path')
  upstream.search = incoming.searchParams.toString()
  try {
    const result = await fetchImpl(upstream, {
      method: request.method,
      headers: { 'x-vercel-protection-bypass': env.QIVO_SITE_PROTECTION_BYPASS },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    response.statusCode = result.status
    const contentType = result.headers.get('content-type')
    if (contentType) response.setHeader('Content-Type', contentType)
    const location = result.headers.get('location')
    if (location) {
      const redirect = new URL(location, upstream)
      if (!['https://site-preview.qivo.io', 'https://preview.qivo.io'].includes(redirect.origin)) {
        response.statusCode = 502
        return response.end()
      }
      response.setHeader(
        'Location',
        `https://preview.qivo.io${redirect.pathname}${redirect.search}${redirect.hash}`,
      )
    }
    // No browser cookies, authorization headers or provider bypass headers cross this boundary.
    if (request.method === 'HEAD' || !result.body) return response.end()
    await pipeline(Readable.fromWeb(result.body), response)
  } catch {
    // Fetch errors can contain provider URLs. Do not expose them to clients or build logs.
    if (!response.headersSent) {
      response.statusCode = 502
      response.end('Website preview is unavailable.')
    } else response.destroy()
  }
}

export default websiteProxy
