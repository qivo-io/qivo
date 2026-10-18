import { ConvexError } from 'convex/values'

/** What the sign-in gate's load-failed card says about a failed boot. A
    refusal (ConvexError) carries the server's own sentence. Any other failure
    is a fault whose text is meant for support, such as Convex's
    "[CONVEX Q(snapshot:forMe)] [Request ID: …] Server Error", so the card
    says it plainly and the caller logs the raw text. */
export function loadFailureText(e: unknown): string {
  const message = e instanceof ConvexError ? e.data?.message : null
  const m = typeof message === 'string' ? message.trim() : ''
  if (!m) return 'Something went wrong while loading. Try again in a moment.'
  return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.')
}
