/* The size limits of one task's family, followers and remaining hours,
 * shared by the server's model layer and the app, which disables the
 * controls that would pass them. No imports, so the app can import this file as it does
 * textLimits.ts.
 *
 * A task has one level of subtasks: a subtask has no subtasks of its own.
 * Tasks stored before these rules keep their shape, and only new links,
 * creates and follows are refused. */

/** The most subtasks one task may have, archived ones included, because a
 * restore from the archive brings them back without asking. */
export const SUBTASK_MAX = 100

/** The most followers one task may have. Following by hand, commenting and
 * being mentioned stop adding followers here. A new assignee or reviewer
 * still follows, so the owners of a task can pass it. */
export const FOLLOWER_MAX = 100

/** The refusal of a parent that is itself a subtask. */
export const PARENT_IS_SUBTASK =
  'the parent task is a subtask, and a subtask cannot have subtasks of its own'

/** The refusal of a parent for a task that has subtasks, which would make it
 * a subtask with subtasks. */
export const SUBTASK_WITH_SUBTASKS =
  'this task has subtasks, so it cannot become a subtask; a subtask cannot have subtasks of its own'

/** The refusal of a parent that already has SUBTASK_MAX subtasks. */
export const PARENT_FULL = `the parent task already has ${SUBTASK_MAX} subtasks, the most a task can have`

/** The refusal of a follow by hand on a task with FOLLOWER_MAX followers. */
export const FOLLOWERS_FULL = `this task already has ${FOLLOWER_MAX} followers, the most a task can have`

/** The most remaining hours a task takes, the range of the numeric(6,1)
 * column the hours came from. The app, REST and MCP refuse more with
 * REMAINING_HOURS_RULE (model/taskValues.ts cleanRemaining), and MCP's task
 * schemas publish it as `maximum`. */
export const REMAINING_HOURS_MAX = 99_999.9

/** The refusal of remaining hours outside 0..REMAINING_HOURS_MAX. A `rule`,
 * so the app shows it, in its own words (src/store/planner.ts asSentence);
 * REST answers it as a 400 either way. */
export const REMAINING_HOURS_RULE = `remaining_hours must be a number of hours from 0 to ${REMAINING_HOURS_MAX}, or null`
