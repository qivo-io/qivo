/* The people pickers of a task, the editor's mention suggestions and the
 * view filter's people, read from the server. The readers and their rules are in model/pickers.ts.
 *
 * - taskOwners: the people who could become a task's assignee or reviewer,
 *   25 at a time in name order, with a search over every one of them. The
 *   task window's Assignee and Reviewer fields and the owner lists behind
 *   the Board's, the Roadmap's, My view's and Team sync's owner controls
 *   read it (src/components/AssigneeAvatar.tsx OwnerPickList).
 * - syncRecipients: the people Team sync's Mention window may notify about
 *   a task, 25 at a time in name order, with a search
 *   (src/views/teamSync/SyncCard.tsx MentionCtl reads it).
 * - canOwn: for a few people by id, their row and whether each could be
 *   chosen in one of those pickers now, for a current assignee or reviewer
 *   and for a suggested or kept recipient that no loaded batch holds. An
 *   open owner list checks its current holder with its first batch, and
 *   the Mention window checks its suggested or kept person on open and the
 *   chosen person before Send.
 *
 * The app reads each once a batch, or once a check, while its control is
 * open, and never subscribes. Each takes the organization and a task in it, and
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
 * comments or files, and none writes.
 *
 * - taskFollowers: the people the follower popover's Add list offers for a
 *   task, 25 at a time in name order, with a search over names
 *   (src/components/IssueSubscribers.tsx reads it once a batch while the
 *   list is open). Its gate is issues.subscribers' and its rule
 *   issues.setSubscriber's, so a caller who may not manage the task's
 *   followers is refused with the write's sentence. Its rows are follower
 *   rows (model/pickers.ts FollowerRow), with the portrait's initials and
 *   color and no email.
 * - mentions: the people the editor's @ mention popup offers in a text of
 *   a task, 8 at a time in name order, with the popup's match over names
 *   and initials (src/components/mentionSuggestion.ts reads it once a
 *   batch while the popup is open). Its gate is the pickers' without the
 *   Edit check, since a comment's author may edit it as a Viewer, and it
 *   offers the active profiles, people and agents, who have access to the
 *   task's project, the caller too, by the sight the mention fan-out
 *   asks of a recipient (the owner's decision of 12 November 2026). Its rows hold
 *   the initials and color and no email (model/pickers.ts mentionsOf).
 * - viewOwners: the people the view filter's Assignee menu offers above a
 *   Board or a Roadmap, the owners of the tasks of the project the view
 *   selects, with the same match and rows, all at once
 *   (src/components/viewFilters.tsx PeopleRows). It takes the project and
 *   no task, and answers nobody for a project the caller's views do not
 *   select (model/pickers.ts viewOwnersOf). */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
import {
  canOwnOf,
  type FollowerBatch,
  followerChoicesOf,
  type MentionBatch,
  mentionsOf,
  type OwnerChecks,
  type PeopleBatch,
  syncRecipientsOf,
  taskOwnersOf,
  type ViewOwnersAnswer,
  viewOwnersOf,
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

/** One batch, in name order, of the people the follower popover's Add
 * list offers for task `issue_id` (model/pickers.ts followerChoicesOf):
 * the active people and Standard user agents who see the task's project
 * and do not follow it yet, the caller left out, whose name holds every
 * word of the search, never their email. Answers `unavailable` for a task the caller
 * cannot see, `refused` for a caller who may not manage its followers,
 * `not_ready`, `over_budget`, or `ready` with rows of id, name, initials,
 * color and active, `next` and `stopped` (lib/namedPages.ts ListBatch).
 * tests/subscribers.test.ts answers it a batch at a time at the design
 * size's people. */
export const taskFollowers = orgQuery({
  args: { issue_id: v.string(), ...vListArgs },
  handler: (ctx, a): Promise<FollowerBatch> => followerChoicesOf(ctx, ctx.me, a),
})

/** One batch, in name order, of the people the editor's @ mention popup
 * offers in a text of task `issue_id`: the active profiles, people and
 * agents, who have access to the task's project, the caller too, whose
 * name and initials hold every word of the search in any order, ignoring
 * case but not accents (model/pickers.ts mentionsOf). Answers
 * `unavailable` for a task the caller cannot see or that is archived,
 * `not_ready`, `over_budget`, or
 * `ready` with rows of id, name, initials and color, never an email,
 * `next` and `stopped` (lib/namedPages.ts ListBatch). */
export const mentions = orgQuery({
  args: { issue_id: v.string(), ...vListArgs },
  handler: (ctx, a): Promise<MentionBatch> => mentionsOf(ctx, ctx.me, a),
})

/** The people the view filter's Assignee menu offers above the Board or
 * the Roadmap of project `project_id`: the owners of the active tasks of
 * that selection, the reviewer of a task In review and else its assignee,
 * whose name and initials hold every word of the search, by mentions'
 * match, in name order (model/pickers.ts viewOwnersOf). Answers
 * `unavailable` for a project the caller's views do not select,
 * `over_budget`, or `ready` with every such owner as rows of id, name,
 * initials and color, never an email, `next` null and `stopped` false. */
export const viewOwners = orgQuery({
  args: { project_id: v.string(), search: v.optional(v.string()) },
  handler: (ctx, a): Promise<ViewOwnersAnswer> => viewOwnersOf(ctx, ctx.me, a),
})
