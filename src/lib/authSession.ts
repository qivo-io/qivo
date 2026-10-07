import type { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/client'
import { anonymousClient } from 'better-auth/client/plugins'
import type { ConvexClient } from 'convex/browser'
import { convexSiteUrl } from './backendUrl'

/* Each entry point creates its own session. The cross-domain plugin stores
 * its cookie jar and session cache under this prefix, sends only that jar in
 * Better-Auth-Cookie, and omits ambient browser cookies. App/admin pages can
 * therefore use independent sessions against the same account database. */
export function createAuthSession(
  storagePrefix: string,
  client: ConvexClient,
  oauthPlugin?: ReturnType<typeof oauthProviderClient>,
  anonymous = false,
) {
  const authClient = createAuthClient({
    // Better Auth treats a URL containing a path as the complete auth root.
    // Include /api/auth explicitly so the local proxy prefix is preserved.
    baseURL: `${convexSiteUrl().replace(/\/$/, '')}/api/auth`,
    plugins: [
      convexClient(),
      ...(anonymous ? [anonymousClient()] : []),
      ...(oauthPlugin ? [oauthPlugin] : []),
      crossDomainClient({ storagePrefix }),
    ],
  })

  // /convex/token mints a fresh 15-minute JWT from this session's own jar.
  // A signed-out session or fetch failure yields null, never a thrown error.
  const fetchConvexToken = async () => {
    try {
      const { data } = await authClient.convex.token({ fetchOptions: { throw: false } })
      return data?.token ?? null
    } catch {
      return null
    }
  }

  /* The app, operator and demo gates call this once they have established a
   * session, before issuing authenticated operations. Arming during module
   * import would request a token before that session check (or before sign-in)
   * and then immediately repeat the request here. Convex owns token refresh
   * after this callback is installed. */
  function armConvexAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      client.setAuth(fetchConvexToken, (isAuthenticated) => {
        if (!settled) {
          settled = true
          resolve(isAuthenticated)
        }
      })
    })
  }

  // The plugin clears only this prefix; the server revokes only its session.
  // Callers reload afterward, re-arming this page's socket on the next mount.
  async function signOut(): Promise<void> {
    try {
      await authClient.signOut()
    } finally {
      client.client.clearAuth()
    }
  }

  // Expiry is enforced on the server. This removes the local credential even
  // when an offline browser cannot complete a sign-out request.
  function clearLocalSession() {
    client.client.clearAuth()
    for (const suffix of ['_cookie', '_session_data']) {
      try {
        localStorage.removeItem(`${storagePrefix}${suffix}`)
      } catch {
        // The browser can deny storage access in a private context.
      }
    }
  }

  return { authClient, armConvexAuth, signOut, clearLocalSession }
}
