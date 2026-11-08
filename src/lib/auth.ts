import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthSession, NO_QUERY } from './authSession'
import { convex } from './convex'
import { DEMO_MODE } from './demoMode'

/** The app's sign-in storage prefix, under which every tab of a browser
    profile shares one Better Auth session, so the notification leader
    (lib/notificationLeader.ts) names its lock and channel by it. It
    preserves the app's existing namespace so current app logins survive
    the separation; the operator entry point uses ../admin/auth instead. */
export const AUTH_STORAGE_PREFIX = DEMO_MODE ? 'qivo-demo' : 'better-auth'

export const { authClient, armConvexAuth, signOut, clearLocalSession } = createAuthSession(
  AUTH_STORAGE_PREFIX,
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
    ...NO_QUERY,
    fetchOptions: { headers: { Authorization: `Bearer ${session.token}` } },
  })
  authClient.updateSession()
}
