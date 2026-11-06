/** Deployment permissions come from an explicit server setting, never a hostname. */
export function deploymentEnvironment() {
  const value = process.env.QIVO_ENVIRONMENT
  if (
    value !== 'development' &&
    value !== 'preview' &&
    value !== 'staging' &&
    value !== 'production' &&
    value !== 'demo'
  ) {
    throw new Error(
      'QIVO_ENVIRONMENT must explicitly name development, preview, staging, production or demo',
    )
  }
  return value
}

/** Require an exact origin without credentials, paths, query strings or fragments. */
export function deploymentOrigin(): string {
  const site = process.env.SITE_URL
  if (!site) throw new Error('SITE_URL is not set')
  let url: URL
  try {
    url = new URL(site)
  } catch {
    throw new Error('SITE_URL must be an exact http(s) origin')
  }
  if (!/^https?:\/\//.test(site) || url.origin !== site) {
    throw new Error('SITE_URL must be an exact http(s) origin')
  }
  return site
}

export function isLocalDevelopment(): boolean {
  return (
    deploymentEnvironment() === 'development' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(deploymentOrigin()).hostname)
  )
}

/** Internal fixture commands still need a deploy key and an isolated target. */
export function refuseProduction(scope: string): void {
  const environment = deploymentEnvironment()
  const site = deploymentOrigin()
  const hostname = new URL(site).hostname
  if (
    !['development', 'preview', 'staging'].includes(environment) ||
    process.env.APP_MODE === 'demo' ||
    ['qivo.io', 'www.qivo.io', 'demo.qivo.io'].includes(hostname)
  ) {
    throw new Error(`${scope} cannot run on a production or public demo deployment`)
  }
  if (!site.startsWith('https://') && !isLocalDevelopment()) {
    throw new Error(`${scope} requires HTTPS outside local development`)
  }
}

/* SITE_URL is the app's origin (http://localhost:5199 in development,
 * https://qivo.io in production), not the convex.site URL, which Better
 * Auth's baseURL reads from CONVEX_SITE_URL (auth.ts).
 *
 * It is read at call time and checked, the way fileTokens.ts reads
 * CONVEX_SITE_URL. It used to be asserted non-null at module scope, which on
 * a deployment missing the variable handed `undefined` (typed `string`) to
 * trustedOrigins and to crossDomain's redirect target, so every OAuth and
 * reset round trip failed originCheck with nothing naming the missing
 * variable. Reading it at call time also keeps that failure on the routes
 * that need the origin, rather than on every module that imports auth.ts or
 * this one. */
export const requireSiteUrl = () => {
  const url = process.env.SITE_URL
  if (!url) throw new Error('SITE_URL is not set, so the app origin is unknown')
  return url
}

/* The Better Auth component (convex/betterAuth/) bundles auth.ts and
 * evaluates it during push analysis, inside the component sandbox, which by
 * design sees none of the deployment's environment variables. Its two
 * consumers, betterAuth/adapter.ts's createApi and betterAuth/auth.ts's
 * generate-only instance, only read table shapes off the options, so they
 * build with this inert placeholder origin instead of refusing the whole
 * push. Every instance that serves auth (auth.ts createAuth and
 * createCaptureAuth) still refuses an unset SITE_URL by name. `.invalid` is
 * reserved by RFC 2606, so a placeholder that leaked into a real redirect
 * could not resolve. */
export const SCHEMA_ONLY_ORIGIN = 'http://schema-only.invalid'

/* SITE_URL remains the canonical app origin for redirects. A developer may
 * expose the same Vite process through another exact origin (for example a
 * Tailnet IP), so ADDITIONAL_APP_ORIGINS extends only the trust and CORS
 * set. It is a comma-separated list of complete origins, never a wildcard
 * or host suffix. */
const exactOrigin = (value: string, envName: string): string => {
  const trimmed = value.trim().replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${envName} contains an invalid origin`)
  }
  if (!/^https?:\/\//.test(trimmed) || url.origin !== trimmed) {
    throw new Error(`${envName} entries must be exact http(s) origins`)
  }
  return url.origin
}

/** The app's exact origins, SITE_URL's first and then those
 * ADDITIONAL_APP_ORIGINS lists, which Better Auth trusts (auth.ts) and the
 * HTTP router allows in CORS (http.ts). Each is an exact origin, never a
 * wildcard, and outside development each must be HTTPS; a setting that
 * breaks these rules throws. `schemaOnly` answers the placeholder without
 * reading any setting. */
export const appOrigins = (opts?: { schemaOnly?: boolean }): string[] => {
  if (opts?.schemaOnly) return [SCHEMA_ONLY_ORIGIN]
  const primary = exactOrigin(requireSiteUrl(), 'SITE_URL')
  const additional = (process.env.ADDITIONAL_APP_ORIGINS || '')
    .split(',')
    .filter((value) => value.trim() !== '')
    .map((value) => exactOrigin(value, 'ADDITIONAL_APP_ORIGINS'))
  const origins = [...new Set([primary, ...additional])]
  if (
    deploymentEnvironment() !== 'development' &&
    origins.some((origin) => !origin.startsWith('https://'))
  ) {
    throw new Error('Hosted authentication requires HTTPS for every app origin')
  }
  return origins
}
