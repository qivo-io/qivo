/* Which deployment is this? SITE_URL is the per-deployment app origin
 * (localhost in dev, https://<branch>.vercel.app on a Vercel preview,
 * https://qivo.io in production) — the one marker that tells them apart.
 * Everything that plants documented passwords or mintable test credentials
 * asks here first. The deploy-key gate on internal functions is the fence;
 * this is belt and braces against the one deployment where a documented
 * password would be a back door with a published key. */

/* Throws unless SITE_URL names a deployment that is not production. `scope`
 * prefixes the message so a refused `npx convex run` says who refused. */
export function refuseProduction(scope: string): void {
  const siteUrl = process.env.SITE_URL
  if (siteUrl === undefined) {
    throw new Error(
      `${scope}: SITE_URL unset — cannot tell this deployment from production, refusing`,
    )
  }
  if (new URL(siteUrl).hostname.endsWith('qivo.io')) {
    throw new Error(`${scope}: refusing to run against the production deployment`)
  }
}

/* A Vercel preview origin exactly as scripts/vercel-build.mjs writes it:
 * https, a bare origin (no path), a *.vercel.app host. */
export function isPreviewOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return (
    origin.startsWith('https://') && url.origin === origin && url.hostname.endsWith('.vercel.app')
  )
}
