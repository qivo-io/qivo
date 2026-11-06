/* The people pickers of a task, read from the server. The readers and
 * their rules are in model/pickers.ts.
 *
 * - taskOwners: the people who could become a task's assignee or reviewer,
 *   25 at a time in name order, with a search over every one of them. The
 *   task window's Assignee and Reviewer fields and the owner menus
 *   (src/components/AssigneeAvatar.tsx OwnerPickList) are to read it.
 * - syncRecipients: the people Team sync's Mention window may notify about
 *   a task, 25 at a time in name order, with a search
 *   (src/views/teamSync/SyncCard.tsx MentionCtl is to read it).
 * - canOwn: for a few people by id, their row and whether each could be
 *   chosen in one of those pickers now, for a current assignee or reviewer
 *   and for a suggested or kept recipient that no loaded batch holds.
 *
 * No app control reads them yet; t3/limits-owner-pickers moves those
 * controls onto them. Each is to be read once a batch, or once a check,
 * and never subscribed. Each takes the organization and a task in it, and
 * runs the write's own gate before it reads any person. An unknown task,
 * one of another organization, a deleted or archived one, one in an
 * archived project or under an archived top-level project, and one in a
 * project the caller cannot see all answer `unavailable` alike, and a
 * caller the write would refuse gets `refused` with the write's sentence.
 * A person is offered by the write's own rule (issues.update for an owner,
 * the mention fan-out of comments.create for a recipient), worked out
 * once from the project's side. The lists answer `not_ready` until the
 * organization's names are keyed and `over_budget` when the rule's reads
 * pass their share, and a list cursor opens only for the list,
 * organization, task, field and search it came from. Rows are person rows
 * (model/projectSettings.ts PersonRow), with no email, picture, team,
 * level, task, title or project. None reads a task's title, description,
 * comments or files, and none writes. */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
import {
  canOwnOf,
  type OwnerChecks,
  type PeopleBatch,
  syncRecipientsOf,
  taskOwnersOf,
} from './model/pickers'

/** The arguments every list takes: an optional search, and the cursors of
 * the batch's start (`after`, none for the first batch) and, to keep a
 * loaded batch live, its end (`through`). */
const vListArgs = {
  search: v.optional(v.string()),
  after: v.optional(v.string()),
  through: v.optional(v.string()),
}

/** One batch, in name order, of the people issues.update accepts as task
 * `issue_id`'s new assignee or reviewer (`field`), the active admins, users
 * and guests with User or Lead on the task's project who see the project
 * of every task above it (model/pickers.ts taskOwnersOf). A reviewer asked
 * for a task with an active subtask is refused with the write's sentence.
 * Answers `unavailable`, `refused`, `not_ready`, `over_budget`, or `ready`
 * with the rows, `next` and `stopped` (lib/namedPages.ts ListBatch). */
export const taskOwners = orgQuery({
  args: {
    issue_id: v.string(),
    field: v.union(v.literal('assignee'), v.literal('reviewer')),
    ...vListArgs,
  },
  handler: (ctx, a): Promise<PeopleBatch> => taskOwnersOf(ctx, ctx.me, a),
})

/** One batch, in name order, of the people Team sync's Mention window may
 * notify about task `issue_id`, the active people, not agents, who see the
 * task's project, with the caller left out (model/pickers.ts
 * syncRecipientsOf). Answers as taskOwners. */
export const syncRecipients = orgQuery({
  args: { issue_id: v.string(), ...vListArgs },
  handler: (ctx, a): Promise<PeopleBatch> => syncRecipientsOf(ctx, ctx.me, a),
})

/** For each distinct id of `ids` (at most 100 as sent, repeats counted), in
 * the order asked, the person's row, null for an id the organization does
 * not hold, and whether they could be chosen now in task `issue_id`'s
 * picker for `field`, by the rule its list offers people by
 * (model/pickers.ts canOwnOf). A current holder answers their row also
 * when switched off, and not eligible when the write would refuse them as
 * a new holder. Answers the lists' gate states, `over_budget`, or `ready`
 * with `rows`. */
export const canOwn = orgQuery({
  args: {
    issue_id: v.string(),
    field: v.union(v.literal('assignee'), v.literal('reviewer'), v.literal('recipient')),
    ids: v.array(v.string()),
  },
  handler: (ctx, a): Promise<OwnerChecks> => canOwnOf(ctx, ctx.me, a),
})
