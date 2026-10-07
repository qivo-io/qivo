// A presentation flag only. Convex independently verifies its deployment mode
// and the caller's owned, unexpired demo before granting any access.
export const DEMO_MODE = import.meta.env.VITE_APP_MODE === 'demo'
export const WORKSPACE_SIGNUP_URL = 'https://qivo.io/app#signup'
export const DEMO_ENDED_EVENT = 'qivo:demo-ended'

export function notifyDemoEnded(phase: 'expired' | 'lost' = 'expired') {
  if (DEMO_MODE) window.dispatchEvent(new CustomEvent(DEMO_ENDED_EVENT, { detail: phase }))
}
