/* The labels the task window shows for a task (useTaskLabels): every
   label of the task, named from the workspace's catalogue when it holds
   the label, else from labels.byIds, so a label not loaded shows as
   loading and never as taken off, and only the server's answer hides one
   as deleted. The Labels section (IssueDetail.tsx) shows them as chips and
   the label picker (LabelPicker.tsx) lists them first. */

import { api } from '../../convex/_generated/api'
import { BY_IDS_MAX } from '../../convex/lib/limits'
import { useLiveView } from '../lib/liveView'
import { type LabelChoice, P } from '../store/planner'

/** The most label rows the window keeps named after their read, by
    organization and id, the oldest dropped first. */
const NAMED_KEPT = 1000

/* Labels the label reads named, so a label whose read has no current
   answer, as across a hidden tab or a new set of ids, shows its last name,
   and a label picked from a batch shows its name at once. */
const named = new Map<string, LabelChoice>()

/** Keeps `row` of organization `org` named for the task window, as the
    label picker does for a label it put on a task. */
export function keepNamed(org: string, row: LabelChoice) {
  const key = `${org}\n${row.id}`
  named.delete(key)
  named.set(key, row)
  for (const oldest of named.keys()) {
    if (named.size <= NAMED_KEPT) break
    named.delete(oldest)
  }
}

/** A label of a task as the window shows it: named (`ok`), not named yet
    (`loading`), its read failed (`failed`), or deleted (`gone`), which
    only labels.byIds' answer tells. */
export type TaskLabel =
  | { id: string; state: 'ok'; name: string; color: string }
  | { id: string; state: 'loading' | 'failed' | 'gone' }

/** A task's labels as useTaskLabels answers them, whether a read of them
    failed, and its Try again. */
export type TaskLabels = { labels: TaskLabel[]; failed: boolean; retry: () => void }

/** What labels.byIds answers. */
type ByIds = { rows: LabelChoice[] }

/**
 * Every label of task `it`, in the task's order: the workspace's label
 * when it holds it in the task's organization, at once, so this session's
 * writes paint as they always did; else from labels.byIds, read live
 * while the window shows the task, the ids the workspace does not hold,
 * sorted, BY_IDS_MAX a read in two fixed reads (a task's labels and the
 * rows its answer may hold before the cap stay within 200). A label an
 * answer holds is `ok`; one the answer for the current ids leaves out is
 * `gone`, as byIds looked it up. Rows an earlier answer or the picker
 * named stay `ok` while the current read has no answer, so a hidden tab
 * or a new set of ids turns no named label back to loading. Otherwise a
 * label is `loading`, or `failed` after a failed read, with `retry`.
 */
export function useTaskLabels(it: { org: string; labels?: readonly string[] } | null): TaskLabels {
  const org = it?.org ?? ''
  const ids = it?.labels ?? []
  const held = (id: string) => {
    const label = P.labelById[id]
    return label && label.org === org ? label : undefined
  }
  const unheld = [...new Set(ids.filter((id) => !held(id)))].sort()
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
    const label = held(id)
    if (label) return { id, state: 'ok', name: label.name, color: label.color }
    const row = answered.get(id)
    if (row) return { id, state: 'ok', name: row.name, color: row.color }
    if (row === null) return { id, state: 'gone' }
    const kept = named.get(`${org}\n${id}`)
    if (kept) return { id, state: 'ok', name: kept.name, color: kept.color }
    return { id, state: failedIds.has(id) ? 'failed' : 'loading' }
  })
  return {
    labels,
    failed: labels.some((label) => label.state === 'failed'),
    retry: () => {
      for (const read of reads) if ('error' in read) read.retry()
    },
  }
}
