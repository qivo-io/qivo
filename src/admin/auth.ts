import { createAuthSession, SignOutFailed } from '../lib/authSession'
import { convex } from '../lib/convex'

// A fresh operator sign-in is required; never adopt or copy the app's jar.
const session = createAuthSession('qivo-admin', convex)
export const { authClient, armConvexAuth } = session

/** Signs out and reloads. When the server could not sign the operator out
    now, the operator stays signed in, and this resolves with the sentence to
    show instead. */
export async function signOutAndReload(): Promise<string | null> {
  try {
    await session.signOut()
  } catch (failure) {
    if (failure instanceof SignOutFailed) return failure.message
  }
  location.reload()
  return null
}
