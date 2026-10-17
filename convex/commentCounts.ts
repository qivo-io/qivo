/* The background step that counts on a task's comments when a post found the
 * thread too long to count in its own transaction (model/commentCounts.ts). */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { stepCommentCount } from './model/commentCounts'

/* One counting step, scheduled by name from the post that started the count
 * and from itself (model/commentCounts.ts assertRoomForComment). */
export const step = internalMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, a) => {
    await stepCommentCount(ctx, a.issue_id)
    return null
  },
})
