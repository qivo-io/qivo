/* The task window's Subtasks, Linked tasks and Attachments, as the store
   builds them (store/planner.ts P.sections) from the window's own answers
   (convex/taskWindow.ts task, links and attachments) and the workspace
   rows. The store hands in plain rows and ids and shapes what comes out,
   so nothing here reads the store.

   An answer is the server's word as of its delivery. The workspace rows on
   screen are the server's rows of the last painted delivery
   (store/workspaceBase.ts) with every live layer painted over them
   (store/layers.ts). Where the two disagree about a relation of the open
   task, a live layer of the person's own write made the difference, and the
   painted rows decide; everywhere else the answer decides (shows). So a
   subtask, link or attachment a write adds or takes away shows so at once,
   stays so through the server's echo, and goes back when the server refuses
   the write and its layer goes.

   Group totals (groupTotals), the window's Progress and the Σ of Remaining,
   use a complete list or say they are unknown (the limits plan's item 2).
   A list is complete only when its answer says so. */

/** Where one relation of the open task stands: in the server's applied
    workspace rows (`base`), in the rows on screen (`painted`), and in the
    section's answer. */
export type Standing = { base: boolean; painted: boolean; answer: boolean }

/** Whether a section shows a relation: as the painted rows have it where
    they differ from the applied ones, else as the answer has it. */
export const shows = ({ base, painted, answer }: Standing): boolean =>
  base !== painted ? painted : answer

/** The ids among `candidates` that a section shows (shows), each once, in
    the order first named. The candidates are the answer's ids and those the
    painted rows relate to the open task. A relation that neither holds
    shows under no standing, so no other id needs asking about. */
export function shownIds(
  candidates: Iterable<string>,
  standing: (id: string) => Standing,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    if (shows(standing(id))) out.push(id)
  }
  return out
}

/** -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order,
    as convex/lib/taskWindow.ts and store/taskIndex.ts compare ids. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Subtasks by number, then id, as the task answer and store/taskIndex.ts
    childKeysOf order them. */
export const byNumber = (a: { num: number; id: string }, b: { num: number; id: string }): number =>
  a.num - b.num || order(a.id, b.id)

/** Links and attachments by created_at, then id, as their answers and
    store/taskIndex.ts order them. */
export const byCreation = (
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number => order(a.created_at, b.created_at) || order(a.id, b.id)

/** A link as the window reads it. */
export type LinkEnds = {
  id: string
  source_id: string
  target_id: string
  type: string
  created_at: string
}

/** How a link reads from the task at its other end. */
const REVERSE: Record<string, string> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates: 'relates',
}

/** One row of a task's Linked tasks: the other task, the relation as seen
    from the task, and the link it comes from. */
export type LinkView = { other: string; type: string; link: string }

/** Task `uuid`'s links as its window lists them, by created_at, then id,
    each other task once, from its first link. An outgoing link keeps its
    type and an incoming one takes the reverse. A link whose other task
    `shown` leaves out is not listed. store/taskIndex.ts linkViewsOf reads
    the workspace's links through this. */
export function linkViews(
  uuid: string,
  links: readonly LinkEnds[],
  shown: (other: string) => boolean,
): LinkView[] {
  const out: LinkView[] = []
  const seen = new Set<string>()
  for (const link of [...links].sort(byCreation)) {
    const outgoing = link.source_id === uuid
    const other = outgoing ? link.target_id : link.source_id
    if (seen.has(other) || !shown(other)) continue
    seen.add(other)
    out.push({ other, type: outgoing ? link.type : REVERSE[link.type] || 'relates', link: link.id })
  }
  return out
}

/** Where a section stands: before its first answer, its query failed (and
    Retry runs it again), the server no longer lets this window list the
    task, or its list arrived. */
export type SectionState = 'loading' | 'failed' | 'retrying' | 'unavailable' | 'ready'

/** A subtask as the group totals read it. */
export type TotalsRow = { isGroup: boolean; done: boolean; remaining?: number | null }

/** What a group's Progress says: loading; completion unknown, `partial`
    once rows were read; the visible subtasks of a complete list beside
    hidden ones or a group row; or a complete count. */
export type Progress =
  | { state: 'loading' }
  | { state: 'unknown'; partial: boolean }
  | { state: 'visible'; done: number; total: number }
  | { state: 'complete'; done: number; total: number; pct: number }

/** What a group's Remaining says: loading, unknown, or the open hours of
    the unfinished leaves, undefined when none has hours, of the subtasks
    the person can see (`visible`) or of every subtask (`complete`). */
export type Remaining =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'visible' | 'complete'; hours: number | undefined }

/** A group's Progress and Remaining from its subtask list. The leaves are
    the rows that are no group. A row that is itself a group, stored before
    the one-level rule, holds subtasks the list does not, so Remaining is
    then unknown and Progress counts the visible leaves; so it is beside
    subtasks the person cannot see (`hidden`), where Remaining sums the
    visible ones as the workspace always has. `delivered` says whether an
    answer arrived for the task before a failure. */
export function groupTotals(list: {
  state: SectionState
  complete: boolean
  delivered: boolean
  hidden: boolean
  rows: readonly TotalsRow[]
}): { progress: Progress; remaining: Remaining } {
  const { state, complete, delivered, hidden, rows } = list
  if (state === 'loading' || (state === 'retrying' && !delivered))
    return { progress: { state: 'loading' }, remaining: { state: 'loading' } }
  if (state !== 'ready' || !complete)
    return {
      progress: { state: 'unknown', partial: state !== 'unavailable' && delivered },
      remaining: { state: 'unknown' },
    }
  const leaves = rows.filter((row) => !row.isGroup)
  const total = leaves.length
  const done = leaves.filter((row) => row.done).length
  let sum = 0
  let any = false
  for (const leaf of leaves) {
    if (leaf.done || leaf.remaining == null) continue
    sum += leaf.remaining
    any = true
  }
  const hours = any ? Math.round(sum * 10) / 10 : undefined
  const grouped = rows.some((row) => row.isGroup)
  if (hidden || grouped)
    return {
      progress: { state: 'visible', done, total },
      remaining: grouped ? { state: 'unknown' } : { state: 'visible', hours },
    }
  return {
    progress: { state: 'complete', done, total, pct: total ? Math.round((done / total) * 100) : 0 },
    remaining: { state: 'complete', hours },
  }
}
