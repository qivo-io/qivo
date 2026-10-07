import { ConvexClient } from 'convex/browser'
import { convexDeploymentUrl } from './backendUrl'

const url = convexDeploymentUrl()

if (!url) {
  throw new Error('Missing VITE_CONVEX_URL — copy .env.example to .env.local')
}

// Module singleton: the store is a pub-sub singleton (P), not a React tree,
// so this is the vanilla browser client — no React hooks anywhere.
export const convex = new ConvexClient(url)
