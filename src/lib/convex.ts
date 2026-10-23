import { ConvexClient } from 'convex/browser'
import { convexDeploymentUrl } from './backendUrl'
import { createLiveQueries } from './liveQueries'

const url = convexDeploymentUrl()

if (!url) {
  throw new Error('Missing VITE_CONVEX_URL. Copy .env.example to .env.local.')
}

// Module singleton: the store is a pub-sub singleton (P), not a React tree,
// so this is the vanilla browser client — no React hooks anywhere. Its own
// leave warning counts only writes already sent, not ones made after the
// socket closed, so each page installs its own instead (lib/leaveGuard).
export const convex = new ConvexClient(url, { unsavedChangesWarning: false })

/* The workspace's live parts, read by transition (lib/liveQueries.ts) over
   the same connection. */
export const live = createLiveQueries(convex.client, (ref, args) => convex.query(ref, args))
