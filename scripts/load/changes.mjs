// The changes phase's plan (scripts/benchmark-load.mjs runChanges): which
// change comes when, which tasks take the comments, and the writes that
// make the changes and put them back, kept here so a test can check it
// without a backend.

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

/** The comment each comment change posts. */
const COMMENT_BODY =
  'Checked the readings against the bench log; the drift stays inside the calibration window.'

/**
 * The changes phase's writes in organization `org`: `next(i)` answers
 * change i's `{ kind, fn, args }` in CHANGE_KINDS' turn, a rename of
 * `renamed`, a move of `moved` to `sibling` and back to `home`, a status
 * change of `renamed` between two open statuses, so no project's open or
 * Done count moves, and a comment on `commented` in turn, and its
 * `landed()` records that the write landed. The tasks' place and status
 * follow only the writes that landed, so `restores()`, the [fn, args]
 * writes that put the title, the status and the place back and remove the
 * posted comments, also undoes a move or status change whose return write
 * failed.
 */
export function changeWrites({ org, renamed, moved, home, sibling, commented }) {
  const original = { title: renamed.title, status: renamed.status }
  let away = false
  let status = original.status
  let commentsMade = 0
  const posted = []
  const update = (patch) => ['issues:update', { org_id: org, id: renamed.id, patch }]
  const write = (kind, [fn, args], landed = () => {}) => ({ kind, fn, args, landed })
  return {
    next(i) {
      const kind = CHANGE_KINDS[i % CHANGE_KINDS.length]
      if (kind === 'rename')
        return write(kind, update({ title: `${original.title} (${i})`.slice(0, 200) }))
      if (kind === 'move')
        return write(
          kind,
          ['issues:move', { org_id: org, id: moved.id, project_id: away ? home : sibling.id }],
          () => {
            away = !away
          },
        )
      if (kind === 'status') {
        const next = status === 'progress' ? 'todo' : 'progress'
        return write(kind, update({ status: next }), () => {
          status = next
        })
      }
      const id = crypto.randomUUID()
      const target = commented[commentsMade++ % commented.length]
      return write(
        kind,
        ['comments:create', { org_id: org, id, issue_id: target.id, body: COMMENT_BODY }],
        () => posted.push(id),
      )
    },
    restores: () => [
      update({ title: original.title }),
      ...(status !== original.status ? [update({ status: original.status })] : []),
      ...(away ? [['issues:move', { org_id: org, id: moved.id, project_id: home }]] : []),
      ...posted.map((id) => ['comments:remove', { org_id: org, id }]),
    ],
    /** The comments asked for and those that landed. */
    comments: () => ({
      made: commentsMade,
      posted: posted.length,
      failed: commentsMade - posted.length,
    }),
  }
}
