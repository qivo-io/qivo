/* The login's connected apps for Settings › Your preferences › MCP access,
 * read a batch at a time (model/connectedApps.ts). It lives apart from
 * oauthConnections.ts, which loads Better Auth for the consent screen, so
 * the list's first call on a fresh isolate loads no Better Auth package
 * (convex/tests/authTriggers.test.ts). */

import { v } from 'convex/values'
import { authedQuery } from './lib/functions'
import { type ConnectedAppBatch, connectedAppsOf } from './model/connectedApps'

/**
 * One batch of the signed-in login's connected apps, at most LIST_BATCH
 * (25) approved OAuth connections, newest approval first, equal times
 * newest connection first, each with its app, its seat's name and its
 * organization's name, or "Removed member" and "Removed organization"
 * once they are gone, its scopes, its dates, whether an admin revoked it
 * and whether its app is gone. `search` keeps the connections whose app,
 * organization or seat name holds every whitespace-separated fragment of
 * it, ignoring case and accents, over the whole list, and `cursor` is an
 * earlier batch's `next` for the same search. Open to any signed-in login,
 * with or without a seat; refused in the demo, as every credential door
 * is, and a search past LIMITS.search and a cursor of another list, login
 * or search are refused too, each before any connection is read.
 *
 * It never reads an unfinished authorization, and reads, counts and leaves
 * out each connection that was deleted. Nothing freezes a snapshot. A
 * connection approved between batches shows once the list starts again,
 * and one deleted leaves no gap. A batch reads at most
 * CONNECTED_APPS.reads and answers `stopped` where that ended it, with a
 * `next` that goes on. It reads no credential hash, task or file. The app
 * reads each batch once (convex.query) and never subscribes to it,
 * because every call made with a connection stamps its last_used_at
 * (oauthAccess.touch).
 */
export const list = authedQuery({
  args: { search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: (ctx, a): Promise<ConnectedAppBatch> => connectedAppsOf(ctx, ctx.authUserId, a),
})
