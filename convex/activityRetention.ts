/* The organization trim's old entry point. Each subject now keeps its own
 * newest rows as they are written (model/activity.ts insertActivity), so
 * nothing trims an organization's activity any more. */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'

/** Does nothing. Trims that the previous release scheduled run it and finish
 * without deleting a row. Remove it in a later release. */
export const trim = internalMutation({
  args: { org_id: v.string() },
  handler: async (): Promise<null> => null,
})
