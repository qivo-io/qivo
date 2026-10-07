import { createHmac } from 'node:crypto'

/** Vercel replaces its geolocation headers at the trusted edge. Only the
 * country leaves this function; neither IP nor User-Agent is retained. */
export default function demoVisitor(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (process.env.VITE_APP_MODE !== 'demo') return response.status(404).end()
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).end()
  }
  const secret = process.env.DEMO_METRICS_SECRET
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    return response.status(200).json({ context: null })
  const rawCountry = process.env.VERCEL === '1' ? request.headers['x-vercel-ip-country'] : null
  const country =
    typeof rawCountry === 'string' && /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : 'ZZ'
  const issuedAt = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret)
    .update(`qivo-demo-visitor-v1:${issuedAt}:${country}`)
    .digest('hex')
  return response.status(200).json({ context: `v1.${issuedAt}.${country}.${signature}` })
}
