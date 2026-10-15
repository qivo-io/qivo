/* The background steps that mark the relation rows of archived tasks, so the
 * app snapshot's reads skip them, and clear those marks after a restore
 * (model/archiveMarks.ts). */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { clearMarkedTasks, markArchivedTasks } from './model/archiveMarks'

/* One step over archived tasks, scheduled by name from the archive paths and
 * from itself (model/archiveMarks.ts scheduleArchiveMarks). */
export const markTasks = internalMutation({
  args: { issues: v.array(v.string()) },
  handler: async (ctx, a) => {
    await markArchivedTasks(ctx, a.issues)
    return null
  },
})

/* One step over restored tasks, scheduled by name from the restore paths,
 * the nightly sweep and itself (model/archiveMarks.ts scheduleMarkClears). */
export const clearTasks = internalMutation({
  args: { issues: v.array(v.string()) },
  handler: async (ctx, a) => {
    await clearMarkedTasks(ctx, a.issues)
    return null
  },
})
