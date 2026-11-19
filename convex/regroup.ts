/* A step a project restore used to schedule, which cleared the own hours of
 * tasks the restore made groups again. A subtask shares its parent's
 * sub-project and the group rule asks no project's state (lib/liveTasks.ts
 * countsAsSubtask), so archiving or restoring a project never turns a task
 * into a group and no restore schedules the step. It stays registered under its name, doing nothing,
 * so a chain a restore scheduled before this release ends; a later release
 * removes it. */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'

/** Ends a restore's regroup chain scheduled before this release. Its
 * arguments are those the chain was scheduled with. */
export const restoredStep = internalMutation({
  args: {
    projects: v.array(v.string()),
    at: v.optional(v.number()),
    cursor: v.optional(v.string()),
    after: v.optional(v.object({ time: v.number(), ids: v.array(v.string()) })),
    restorer_id: v.string(),
  },
  handler: async (): Promise<null> => null,
})
