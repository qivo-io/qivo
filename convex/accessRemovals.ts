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
 * tasks among those the caller may read (at most PREVIEW.items, by task
 * number, with items_total), how many are in projects the caller cannot see
 * (`hidden`, a count without ids, numbers or titles), and whether keeping
 * those people as Viewers or reassigning their tasks would pass the write's
 * rules, with the write's sentence when not. The write itself reports how
 * many tasks it stranded (projects.removeAccess `stranded`), so `hidden`
 * tells the caller nothing new.
 *
 * A one-shot read: the app fetches it when a removal starts and again before
 * it submits, and never subscribes, because one call can read a few
 * thousand rows. It answers `unavailable` for an unknown project, team or
 * person, `refused` with the write's sentence when the write would refuse
 * the removal itself, and `too_large` when working out who loses sight would
 * not fit in one request, or its answer would not (model/removalPreview.ts
 * PREVIEW.bytes), with model/projectAccess.ts REMOVAL_FULL. Every list is
 * bounded: each project it names appears once, and each person who can still
 * change projects names a few of them and counts the rest. A grant or
 * member removal that leaves the tasks reads the same, so it is then
 * expected to refuse with that sentence too; the preview also reads the
 * caller's sight, so it can run out slightly sooner. A team deletion that
 * leaves the tasks does not read them at all (model/teams.ts
 * deleteTeamCore), so it still goes ahead and strands them without a list.
 */
export const preview = orgQuery({
  args: { change: vRemovalChange },
  handler: (ctx, { change }) => previewRemoval(ctx, ctx.me, change),
})
