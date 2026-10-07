import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthSession } from './authSession'
import { convex } from './convex'
import { DEMO_MODE } from './demoMode'

// Preserve the app's existing namespace so current app logins survive the
// separation. The operator entry point uses ../admin/auth instead.
export const { authClient, armConvexAuth, signOut, clearLocalSession } = createAuthSession(
  DEMO_MODE ? 'qivo-demo' : 'better-auth',
  convex,
  oauthProviderClient(),
  DEMO_MODE,
)

/* Replicates ConvexBetterAuthProvider's one-time-token handoff (we skip the
 * React provider): after a social login the crossDomain server plugin lands
 * back on the app with ?ott=<token>. Without this exchange OAuth sign-in
 * never establishes a client session. Called by AuthGate's mount effect.
 * The param is scrubbed before the exchange so a failed verify can't replay. */
export async function handleOAuthReturn(): Promise<void> {
  const url = new URL(window.location.href)
  const ott = url.searchParams.get('ott')
  if (!ott) return
  url.searchParams.delete('ott')
  window.history.replaceState({}, '', url)
  const result = await authClient.crossDomain.oneTimeToken.verify({ token: ott })
  const session = result.data?.session
  if (!session) return
  await authClient.getSession({
    fetchOptions: { headers: { Authorization: `Bearer ${session.token}` } },
  })
  authClient.updateSession()
}
