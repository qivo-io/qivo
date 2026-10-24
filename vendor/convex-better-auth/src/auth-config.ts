/* Copied from get-convex/better-auth src/auth-config.ts at 3f41cbcf
 * (Apache-2.0, see ../LICENSE). Qivo changed it: it leaves out the static
 * JWKS option, createPublicJwks and the basePath option, so Convex always
 * fetches the keys from /api/auth/convex/jwks. */
import type { AuthProvider } from 'convex/server'

/** The Convex auth provider that checks the JWTs the convex() plugin signs. */
export const getAuthConfigProvider = () =>
  ({
    type: 'customJwt',
    issuer: `${process.env.CONVEX_SITE_URL}`,
    applicationID: 'convex',
    algorithm: 'RS256',
    jwks: `${process.env.CONVEX_SITE_URL}/api/auth/convex/jwks`,
  }) satisfies AuthProvider
