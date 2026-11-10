// The changes phase's plan (scripts/benchmark-load.mjs runChanges): which
// change comes when and which tasks take the comments, kept here so a test
// can check it without a backend.

/** The kinds of change the changes phase makes in turn, one a second. */
export const CHANGE_KINDS = ['rename', 'move', 'status', 'comment']

/** The comments one person may post on one task in any 60 seconds
    (convex/lib/limits.ts LIMITS.commentRate, which the test compares). */
export const COMMENT_RATE_MAX = 10

/** The comments a run of the changes phase posts in a minute at one
    change a second. */
export const COMMENTS_PER_MINUTE = 60 / CHANGE_KINDS.length

/** The most comments one of `targets` tasks, taking the comments in turn,
    gets in any 60 seconds, its ends included: one every
    `CHANGE_KINDS.length * targets` seconds. */
export const mostInAMinute = (targets) => Math.floor(60 / (CHANGE_KINDS.length * targets)) + 1

/**
 * The tasks of `candidates` that take the comments, in turn: as few as
 * keep each one under half the comment rule in any 60 seconds, so two runs
 * back to back, such as the changes and the busy phase, stay under the
 * rule together and it refuses no comment. Throws an Error when
 * `candidates` holds too few.
 */
export function commentTargets(candidates) {
  let needed = 1
  while (2 * mostInAMinute(needed) >= COMMENT_RATE_MAX) needed++
  if (candidates.length < needed)
    throw new Error(
      `the recorded Board shows ${candidates.length} other open tasks, fewer than the ${needed} the comments need to stay inside the comment rule`,
    )
  return candidates.slice(0, needed)
}
