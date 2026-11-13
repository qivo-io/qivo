import { createAuthSession } from '../lib/authSession'
import { convex } from '../lib/convex'

// A fresh operator sign-in is required; never adopt or copy the app's jar.
const session = createAuthSession('qivo-admin', convex)
export const { authClient, armConvexAuth } = session

/** Signs out and reloads. The sign-out holds in this browser whatever the
    server answers (lib/authSession.ts signOut). */
export async function signOutAndReload(): Promise<void> {
  await session.signOut()
  location.reload()
}
