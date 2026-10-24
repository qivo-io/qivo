import type { AuthConfig } from 'convex/server'
import { getAuthConfigProvider } from '../vendor/convex-better-auth/src/auth-config'

/* No static JWKS: keys are fetched from `${CONVEX_SITE_URL}/api/auth/convex/jwks`.
 * If a static JWKS is ever adopted, the same string must also go to the
 * convex() plugin in auth.ts or it throws at startup. */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig
