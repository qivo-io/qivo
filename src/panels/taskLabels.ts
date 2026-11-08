/* The labels the task window shows for a task (useTaskLabels): every
   label of the task, named from labels.byIds, as the workspace holds no
   label, so a label not loaded shows as loading and never as taken off,
   and only the server's answer hides one as deleted. The labels come in
   name order, those not named yet after them by id, and reorder as names
   arrive. The Labels section (IssueDetail.tsx) shows them as chips and the
   label picker (LabelPicker.tsx) lists them first. Its bounded map of
   names (keepNamed) keeps the labels a picker put on a task and the ones
   the picker and Settings › Labels created, so a new label's chip names it
   at once, also while labels.byIds answers before the picker's create
   commits; the store's profile cache holds people, not labels. */

import { api } from '../../convex/_generated/api'
import { BY_IDS_MAX } from '../../convex/lib/limits'
import { useLiveView } from '../lib/liveView'
import type { LabelChoice } from '../store/planner'

/** The most label rows the window keeps named after their read, by
    organization and id, the oldest dropped first. */
const NAMED_KEPT = 1000

/* Labels the label reads named, so a label whose read has no current
   answer, as across a hidden tab or a new set of ids, shows its last name,
   and a label picked from a batch shows its name at once. */
const named = new Map<string, LabelChoice>()

/* The labels whose create, from the picker, the server has not answered
   yet, by organization and id. */
const creating = new Set<string>()

/** Keeps `row` of organization `org` named for the task window, as the
    label picker does for a label it put on a task. With `saved`, the
    label's create on its way, a labels.byIds answer that leaves it out
    does not show it as deleted until the create answered, as the read may
    run before the create commits. */
export function keepNamed(org: string, row: LabelChoice, saved?: Promise<boolean>) {
  const key = `${org}\n${row.id}`
  named.delete(key)
  named.set(key, row)
  for (const oldest of named.keys()) {
    if (named.size <= NAMED_KEPT) break
    named.delete(oldest)
  }
  if (saved) {
    creating.add(key)
    void saved.finally(() => creating.delete(key))
  }
}

/** A label of a task as the window shows it: named (`ok`), not named yet
    (`loading`), its read failed (`failed`), or deleted (`gone`), which
    only labels.byIds' answer tells. */
export type TaskLabel =
  | { id: string; state: 'ok'; name: string; color: string }
  | { id: string; state: 'loading' | 'failed' | 'gone' }

/** A task's labels as useTaskLabels answers them, whether a current read
    of them failed, also one whose labels show names kept from before, and
    its Try again. */
export type TaskLabels = { labels: TaskLabel[]; failed: boolean; retry: () => void }

/** What labels.byIds answers. */
type ByIds = { rows: LabelChoice[] }

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `labels` in the order the window shows them: the named ones by their
    name in lower case, then id, and after them, by id, those still loading
    or whose read failed, and those the server left out, which the window
    hides. */
export function inNameOrder(labels: readonly TaskLabel[]): TaskLabel[] {
  const key = (label: TaskLabel) => (label.state === 'ok' ? `0${label.name.toLowerCase()}` : '1')
  return [...labels].sort((a, b) => order(key(a), key(b)) || order(a.id, b.id))
}

/**
 * Every label of task `it`, from labels.byIds, read live while the window
 * shows the task, its ids sorted, BY_IDS_MAX a read in two fixed reads (a
 * task's labels and the rows its answer may hold before the cap stay
 * within 200), in name order (inNameOrder). A label an answer holds is
 * `ok`; one the answer for the current ids leaves out is `gone`, as byIds
 * looked it up, unless the picker's create of it has not answered yet.
 * Rows an earlier answer or the picker named stay `ok` while
 * the current read has no answer, so a hidden tab or a new set of ids
 * turns no named label back to loading. Otherwise a label is `loading`, or
 * `failed` after a failed read. `failed` says that a current read failed,
 * whether or not its labels show kept names, so a name that may be out of
 * date comes with `retry`.
 */
export function useTaskLabels(it: { org: string; labels?: readonly string[] } | null): TaskLabels {
  const org = it?.org ?? ''
  const ids = it?.labels ?? []
  const unheld = [...new Set(ids)].sort()
  const parts = [unheld.slice(0, BY_IDS_MAX), unheld.slice(BY_IDS_MAX, 2 * BY_IDS_MAX)]
  const keys = parts.map((part) =>
    part.length === 0 ? null : JSON.stringify({ org_id: org, ids: part }),
  )
  const reads = [
    useLiveView<ByIds>(api.labels.byIds, keys[0]),
    useLiveView<ByIds>(api.labels.byIds, keys[1]),
  ]
  // what the current answers say of each id: its row, or null when the
  // answer leaves it out
  const answered = new Map<string, LabelChoice | null>()
  const failedIds = new Set<string>()
  reads.forEach((read, n) => {
    const key = keys[n]
    if (key === null || read.key !== key) return
    if (read.value) {
      const rows = new Map(read.value.rows.map((row) => [row.id, row]))
      for (const id of parts[n]) {
        const row = rows.get(id) ?? null
        answered.set(id, row)
        if (row) keepNamed(org, row)
      }
    } else if ('error' in read) for (const id of parts[n]) failedIds.add(id)
  })
  const labels = ids.map((id): TaskLabel => {
    const row = answered.get(id)
    if (row) return { id, state: 'ok', name: row.name, color: row.color }
    if (row === null && !creating.has(`${org}\n${id}`)) return { id, state: 'gone' }
    const kept = named.get(`${org}\n${id}`)
    if (kept) return { id, state: 'ok', name: kept.name, color: kept.color }
    return { id, state: failedIds.has(id) ? 'failed' : 'loading' }
  })
  return {
    labels: inNameOrder(labels),
    failed: failedIds.size > 0,
    retry: () => {
      for (const read of reads) if ('error' in read) read.retry()
    },
  }
}
