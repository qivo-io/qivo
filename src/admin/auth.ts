import { createAuthSession } from '../lib/authSession'
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
