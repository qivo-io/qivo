/* The removal window's server reads (model/removalPreview.ts): what
 * removing a person's or a team's project access, a member from a team or a
 * whole team would do to the open tasks the people losing access work on,
 * before anything is removed, and who could take those tasks. The writes
 * stay projects.removeAccess, teams.removeMember and teams.deleteDeep. */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
import {
  previewRemoval,
  type ReassignChoices,
  reassignChoicesOf,
  vRemovalChange,
} from './model/removalPreview'

/**
 * What removing `change` would do, worked out without writing: the people
 * who would lose sight of open tasks they are assigned to or reviewing, the
 * holdings among those the caller may read (one row per task, person and
 * role, for at most PREVIEW.items tasks by task number, with items_total
 * counting every such holding), how many tasks are in projects the caller
 * cannot see (`hidden`, a count without ids, numbers or titles), and
 * whether keeping those people as Viewers or reassigning their tasks would
 * pass the write's rules, with the write's sentence when not. `offered` and
 * `permitted` say whether Keep as Viewer is a choice for this removal at
 * all and whether the caller has the authority each choice needs, whatever
 * a size or read-only sentence says first (model/removalPreview.ts
 * RemovalEffect). Reassigning is answered for a new holder who can take
 * every task once the access is gone; the write checks the new holder's
 * standing on each task's project before the caller's Edit access, and
 * their sight of a subtask's parent after it. With `reassign_to`, the
 * answer says whether that person can take them
 * (reassign.holder_eligible), by the rule reassignChoices lists people by.
 * The write itself reports how many tasks it stranded
 * (projects.removeAccess `stranded`), so `hidden` tells the caller nothing
 * new.
 *
 * A one-shot read: the app fetches it when a removal is pressed, again
 * before it saves (with `reassign_to` when it reassigns) and after a
 * refused write, and never subscribes, because one call can read a few
 * thousand rows. It answers `unavailable` for a project or team that is not
 * the organization's, and for a grant's person who is not; a member removal
 * of someone without a membership, whoever it names, answers `pending:
 * false`, as the write removes nothing. It answers `refused` with the
 * write's sentence when the write would refuse the removal itself, and
 * `too_large` when working out who loses sight would not fit in one
 * request, or its answer would not (model/removalPreview.ts PREVIEW.bytes),
 * with model/projectAccess.ts REMOVAL_FULL. Every list is bounded: each
 * project it names appears once, and each person who can still change
 * projects names a few of them and counts the rest.
 *
 * The preview and the write agree on who loses sight of which tasks and on
 * the rules each choice meets. They do not always agree on the room one
 * request leaves, either way (model/removalPreview.ts). A grant or member
 * removal that leaves the tasks reads what the preview reads, without the
 * caller's sight and the Keep checks, so after a too_large it is likely to
 * refuse with the same sentence, though it may go through. A team deletion
 * that leaves the tasks does not read them at all (model/teams.ts
 * deleteTeamCore), so it goes ahead and strands them without a list. The
 * app removes nothing on a too_large. Keeping people as Viewers or
 * reassigning their tasks also writes, and a team deletion deletes, so
 * near the limit such a write can refuse with a room sentence where the
 * preview allowed the choice.
 */
export const preview = orgQuery({
  args: { change: vRemovalChange, reassign_to: v.optional(v.string()) },
  handler: (ctx, { change, reassign_to }) => previewRemoval(ctx, ctx.me, change, reassign_to),
})

/**
 * One batch of the people who could take every open task `change` takes
 * out of its holders' sight, once the access is gone, in name order, 25 at
 * a time with a search, for the removal window's Reassign picker
 * (model/removalPreview.ts reassignChoicesOf). A person is listed when the
 * write's handover would accept them: someone who can hold work, with User
 * or Lead on every lost task's project and sight of every task above a lost
 * subtask, never one of the people who lose sight of those tasks. It works
 * the removal out from the change on every batch, with the preview's own
 * checks in the write's order, and answers the preview's `unavailable`,
 * `refused` and `too_large`, `refused` with Reassign's own sentence while
 * Reassign is refused, `not_ready` until the organization's people hold
 * their name keys, or `ready` with the rows, `next` and `stopped`
 * (lib/namedPages.ts ListBatch). A cursor opens only for the same
 * organization, removal and search. A one-shot read like the preview: the
 * app reads a batch when the picker opens, a search settles or Load more
 * is pressed, and never subscribes.
 */
export const reassignChoices = orgQuery({
  args: { change: vRemovalChange, search: v.optional(v.string()), after: v.optional(v.string()) },
  handler: (ctx, a): Promise<ReassignChoices> => reassignChoicesOf(ctx, ctx.me, a),
})
