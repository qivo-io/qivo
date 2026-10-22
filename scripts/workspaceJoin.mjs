/* The workspace reader (convex/lib/workspaceJoin.ts) for Node scripts. It
 * loads after scripts/limits.mjs has checked that this Node loads
 * TypeScript, for the reason that module gives, so an older Node stops with
 * a sentence that names the version to use. */
import './limits.mjs'

export const { readWorkspace } = await import('../convex/lib/workspaceJoin.ts')
