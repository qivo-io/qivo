import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config'
import type { AuthConfig } from 'convex/server'

/* No static JWKS: keys are fetched from `${CONVEX_SITE_URL}/api/auth/convex/jwks`.
 * If a static JWKS is ever adopted, the same string must also go to the
 * convex() plugin in auth.ts or it throws at startup. */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig
