import { createAuthSession, SignOutFailed } from '../lib/authSession'
import { convex } from '../lib/convex'
import { beginUpdateBlock } from '../lib/updateSafety'

// A fresh operator sign-in is required; never adopt or copy the app's jar.
const session = createAuthSession('qivo-admin', convex)
export const { authClient, armConvexAuth } = session

export async function signOut() {
  const releaseUpdateBlock = beginUpdateBlock()
  try {
    await session.signOut()
  } finally {
    releaseUpdateBlock()
  }
}

/** Signs out and reloads. A sign-out the server refused keeps the operator
    signed in and hands its sentence to `onRefused` to show. */
export function signOutAndReload(onRefused: (message: string) => void) {
  void signOut().then(
    () => location.reload(),
    (failure: unknown) => {
      if (failure instanceof SignOutFailed) onRefused(failure.message)
      else location.reload()
    },
  )
}
