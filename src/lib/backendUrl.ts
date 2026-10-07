const DEPLOYMENT_PREFIX = '/__qivo_convex'
const SITE_PREFIX = '/__qivo_http'

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      (url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '127.0.0.1')
    )
      return url
  } catch {
    // Missing or malformed configuration remains the client's own error.
  }
  return null
}

/** Vite forwards these development paths to the local backend. Using the
 * page origin also works when an editor forwards only the frontend port. */
function localDemoProxy() {
  if (
    !import.meta.env.DEV ||
    import.meta.env.VITE_APP_MODE !== 'demo' ||
    typeof window === 'undefined'
  )
    return null
  const deployment = loopbackUrl(import.meta.env.VITE_CONVEX_URL as string)
  const site = loopbackUrl(import.meta.env.VITE_CONVEX_SITE_URL as string)
  if (!deployment || !site) return null
  return { deployment, site, origin: window.location.origin }
}

/** The configured deployment identity stays independent of preview routing. */
export function configuredConvexDeploymentUrl(): string {
  return import.meta.env.VITE_CONVEX_URL as string
}

export function convexDeploymentUrl(): string {
  const proxy = localDemoProxy()
  return proxy ? `${proxy.origin}${DEPLOYMENT_PREFIX}` : configuredConvexDeploymentUrl()
}

export function convexSiteUrl(): string {
  const proxy = localDemoProxy()
  return proxy ? `${proxy.origin}${SITE_PREFIX}` : (import.meta.env.VITE_CONVEX_SITE_URL as string)
}

/** Rewrite only configured backend origins; external links, data/blob URLs,
 * relative paths, and already proxied URLs retain their original value. */
export function browserBackendUrl(value: string): string {
  const proxy = localDemoProxy()
  if (!proxy) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.username || url.password) return value
    const prefix =
      url.origin === proxy.deployment.origin
        ? DEPLOYMENT_PREFIX
        : url.origin === proxy.site.origin
          ? SITE_PREFIX
          : null
    if (prefix) return `${proxy.origin}${prefix}${url.pathname}${url.search}${url.hash}`
  } catch {
    // Non-URL strings are outside the transport mapping.
  }
  return value
}
