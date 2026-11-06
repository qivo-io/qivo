/* The Inbox badge's rule (src/lib/inboxBadge.ts) for Node scripts, which
 * the staging check's ui/inbox-badge holds the app's top bar to. It loads
 * after scripts/limits.mjs has checked that this Node loads TypeScript, for
 * the reason that module gives. The rule's file imports nothing, so no
 * import needs resolving. */
import './limits.mjs'

export const { inboxBadge, NO_COUNT } = await import('../src/lib/inboxBadge.ts')
