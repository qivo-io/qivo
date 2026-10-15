/* The background step that marks the relation rows of archived tasks, so the
 * app snapshot's reads skip them (model/archiveMarks.ts). */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { markArchivedTasks } from './model/archiveMarks'

/* One step over archived tasks, scheduled by name from the archive paths and
 * from itself (model/archiveMarks.ts scheduleArchiveMarks). */
export const markTasks = internalMutation({
  args: { issues: v.array(v.string()) },
  handler: async (ctx, a) => {
    await markArchivedTasks(ctx, a.issues)
    return null
  },
})
