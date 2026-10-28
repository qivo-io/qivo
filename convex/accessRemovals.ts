/* The removal window's server preview (model/removalPreview.ts): what
 * removing a person's or a team's project access, a member from a team or a
 * whole team would do to the open tasks the people losing access work on,
 * before anything is removed. The writes stay projects.removeAccess,
 * teams.removeMember and teams.deleteDeep. */

import { orgQuery } from './lib/functions'
import { previewRemoval, vRemovalChange } from './model/removalPreview'

/**
 * What removing `change` would do, worked out without writing: the people
 * who would lose sight of open tasks they are assigned to or reviewing, the
 * holdings among those the caller may read (one row per task, person and
 * role, for at most PREVIEW.items tasks by task number, with items_total
 * counting every such holding), how many tasks are in projects the caller
 * cannot see (`hidden`, a count without ids, numbers or titles), and
 * whether keeping those people as Viewers or reassigning their tasks would
 * pass the write's rules, with the write's sentence when not. Reassigning
 * is answered for a new holder who can take every task once the access is
 * gone; the write checks the new holder first, so another one is refused
 * with the sentence about them (model/removalPreview.ts RemovalEffect).
 * The write itself reports how many tasks it stranded
 * (projects.removeAccess `stranded`), so `hidden` tells the caller nothing
 * new.
 *
 * A one-shot read: the app fetches it when a removal starts and again before
 * it submits, and never subscribes, because one call can read a few
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
 * The preview and the write agree on who loses sight of which tasks and,
 * save the checks of a new holder, on the rules each choice meets. They do
 * not always agree on the room one request leaves, either way
 * (model/removalPreview.ts). A grant or member removal that leaves the
 * tasks reads what the preview reads, without the caller's sight and the
 * Keep checks, so after a too_large it is likely to refuse with the same
 * sentence, though it may go through. A team deletion that leaves the
 * tasks does not read them at all (model/teams.ts deleteTeamCore), so it
 * goes ahead and strands them without a list. Keeping people as Viewers or
 * reassigning their tasks also writes, and a team deletion deletes, so near
 * the limit such a write can refuse with a room sentence where the preview
 * allowed the choice.
 */
export const preview = orgQuery({
  args: { change: vRemovalChange },
  handler: (ctx, { change }) => previewRemoval(ctx, ctx.me, change),
})
