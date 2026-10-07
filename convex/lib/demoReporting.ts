/** Credentials for aggregate reporting are independent of app/demo logins. */
export function demoMetricsSecret(): string | null {
  const value = process.env.DEMO_METRICS_SECRET
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null
}

export function acceptsDemoReport(authorization: string | null): boolean {
  const secret = demoMetricsSecret()
  if (!secret || !authorization?.startsWith('Bearer ')) return false
  const provided = authorization.slice(7)
  let different = secret.length ^ provided.length
  for (let i = 0; i < secret.length; i++)
    different |= secret.charCodeAt(i) ^ (provided.charCodeAt(i) || 0)
  return different === 0
}

/** Only deployment-owned destinations; local targets require a local demo. */
export function demoMetricsDestination(): string | null {
  const value = process.env.DEMO_METRICS_DESTINATION_URL
  if (!value) return null
  const production = /^https:\/\/(?:api\.qivo\.io|[a-z0-9.-]+\.convex\.site)\/?$/
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/
  if (!production.test(value) && !(local.test(value) && local.test(process.env.SITE_URL ?? '')))
    throw new Error('The demo reporting destination must be the main application backend origin.')
  return `${value.replace(/\/$/, '')}/internal/demo-metrics`
}

export const DEMO_REPORT_MAX_BYTES = 900_000
