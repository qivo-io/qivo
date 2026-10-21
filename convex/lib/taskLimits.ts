/* The size limits of one task's family, followers, attachments, links,
 * labels and remaining hours, shared by the server's model layer and the
 * app, which disables the controls that would pass them. No imports, so the
 * app can import this file as it does textLimits.ts.
 *
 * A task has one level of subtasks: a subtask has no subtasks of its own. */

/** The most active (not archived) subtasks one task may have. Archived
 * subtasks do not count, so a parent whose Done subtasks archive keeps
 * taking new ones. A restore from the archive or from Deleted items that
 * would pass it brings the task back as a top-level task instead
 * (model/issues.ts unarchiveIssueCore, model/deletedItems.ts keptParent).
 * A move to another project, which carries archived subtasks too, has its
 * own bound (model/issues.ts MOVE_SUBTREE_MAX). */
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

/** The refusal of a parent that already has SUBTASK_MAX active subtasks. */
export const PARENT_FULL = `the parent task already has ${SUBTASK_MAX} active subtasks, the most a task can have; archive or remove one of them first`

/** The most attachment rows that count on one task, files in its
 * attachment list and images in its description together. A task also
 * keeps up to DROPPED_IMAGES_MAX images a description save took out
 * (model/descriptionImages.ts), which do not count. */
export const ATTACHMENT_MAX = 100

/** The most links one task may have, counting the links where it is either
 * end. */
export const LINK_MAX = 100

/** The most labels one task may carry. */
export const LABEL_MAX = 20

/** The refusal of an attachment to a task with ATTACHMENT_MAX of them. */
export const ATTACHMENTS_FULL = `this task already has ${ATTACHMENT_MAX} attachments, images in its description included, the most a task can have; remove one first`

/** The refusal of a link to task `key` once it has LINK_MAX links. */
export const linksFull = (key: string): string =>
  `${key} already has ${LINK_MAX} links, the most a task can have; remove one of its links first`

/** The refusal of a label on a task with LABEL_MAX labels. */
export const LABELS_FULL = `this task already has ${LABEL_MAX} labels, the most a task can have; remove one first`

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
