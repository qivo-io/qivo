/* The Better Auth component's row triggers. auth.ts hands authTriggers to
 * the component client and names onCreate and onDelete as its trigger
 * functions. The component calls one as a nested function in the
 * transaction of the row's write, once for each row, so Better Auth's bulk
 * session delete, such as a ban, runs onDelete up to 200 times in one
 * transaction (vendor/convex-better-auth/src/client/adapter.ts deleteMany).
 *
 * A nested call loads the imports of its module again, so this module
 * imports none of Better Auth. On a local backend a trigger in a module that
 * loaded auth.ts cost about 30 ms a session before it did anything, against
 * about 5 ms here, and a ban of 200 sessions failed on Convex's time limit
 * for one transaction. */

import { v } from 'convex/values'
import type { Triggers } from '../vendor/convex-better-auth/src/client'
import type { DataModel } from './_generated/dataModel'
import { internalMutation } from './_generated/server'
import type authSchema from './betterAuth/schema'
import { clampDemoSession, expireDeletedDemoUser, registerDemoUser } from './lib/demo'
import { endSession } from './lib/sessionEnd'

export const authTriggers: Triggers<DataModel, typeof authSchema> = {
  user: {
    onCreate: registerDemoUser,
    onDelete: async (ctx, user) => expireDeletedDemoUser(ctx, user._id),
  },
  session: {
    onCreate: clampDemoSession,
    // A sign-out, a ban or any other delete ends the session now, also one
    // that expired before, so it ends every access token issued in it.
    onDelete: async (ctx, session) => endSession(ctx, session, Date.now()),
  },
}

const triggerArgs = { doc: v.any(), model: v.string() }
type Model = keyof typeof authTriggers

/** Runs the create trigger of the component row `doc` of `model`. */
export const onCreate = internalMutation({
  args: triggerArgs,
  handler: async (ctx, { doc, model }): Promise<null> => {
    await authTriggers[model as Model]?.onCreate?.(ctx, doc)
    return null
  },
})

/** Runs the delete trigger of the component row `doc` of `model`. */
export const onDelete = internalMutation({
  args: triggerArgs,
  handler: async (ctx, { doc, model }): Promise<null> => {
    await authTriggers[model as Model]?.onDelete?.(ctx, doc)
    return null
  },
})

/** The session delete trigger of the nightly cleanup of expired sessions
 * (authRetention.ts). A session that expired ended at its expiry: a code
 * exchange needs a live session, so only a refresh issues a token in it
 * afterwards, and a refresh token could issue that token again anyway. So
 * the cleanup ends the tokens issued before the expiry, and none for a
 * session that expired longer ago than an access token lasts. */
export const onExpiredDelete = internalMutation({
  args: triggerArgs,
  handler: async (ctx, { doc, model }): Promise<null> => {
    if (model === 'session') await endSession(ctx, doc, Math.min(doc.expiresAt, Date.now()))
    return null
  },
})
