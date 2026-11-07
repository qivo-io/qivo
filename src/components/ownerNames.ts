/* The names of a task's holders, its assignee and reviewer, as the task
   window's Assignee and Reviewer fields, the Inbox pane's owner line and
   an open owner list name them (useOwnerNames): the store's profile when
   the workspace holds the person in the task's organization, else from
   people.byIds, so a holder not loaded shows as loading, never as
   unassigned, and only the server's answer that leaves the id out shows
   one as gone. A module map (keepOwnerName) keeps names from earlier
   answers, picked rows and pickers.canOwn rows, so a hidden tab or a new
   set of ids turns no name back to loading. t3/limits-roster-cache
   replaces the map with its profile cache. While the people part sends
   every profile, every holder is the store's and nothing is read. */

import { api } from '../../convex/_generated/api'
import { BY_IDS_MAX } from '../../convex/lib/limits'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import { useLiveView } from '../lib/liveView'
import { P } from '../store/planner'

/** The most holder names kept after their read, by organization and id,
    the oldest dropped first. */
export const OWNER_NAMES_KEPT = 1000

/** A person's name as the map keeps it. */
type KeptName = { id: string; name: string; active: boolean }

/* Names the reads and picks gave, by organization and id. */
const kept = new Map<string, KeptName>()

/** Keeps `row` of organization `org` named for the task's fields, as an
    owner list does for a person it picked or checked. */
export function keepOwnerName(org: string, row: KeptName) {
  const key = `${org}\n${row.id}`
  kept.delete(key)
  kept.set(key, { id: row.id, name: row.name, active: row.active })
  for (const oldest of kept.keys()) {
    if (kept.size <= OWNER_NAMES_KEPT) break
    kept.delete(oldest)
  }
}

/** Whether the map keeps a name for `id` of `org`, for tests of its
    bound. */
export const ownerNameKept = (org: string, id: string) => kept.has(`${org}\n${id}`)

/** A holder as the fields name them: named (`ok`), not named yet
    (`loading`), its read failed (`failed`), or not a person of the
    organization (`gone`), which only people.byIds' answer tells. */
export type OwnerName =
  | { id: string; state: 'ok'; name: string; active: boolean }
  | { id: string; state: 'loading' | 'failed' | 'gone' }

/**
 * The names of `ids` in organization `org`, in the order given: the
 * store's profile when it holds the person in `org`, at once; else from
 * people.byIds, read live while the caller shows, for the sorted ids the
 * store does not hold, at most BY_IDS_MAX (the rest stay loading). A
 * person an answer holds is `ok` and kept; one the answer for the current
 * ids leaves out is `gone`. A kept name stays `ok` while the current read
 * has no answer. Otherwise `loading`, or `failed` after a failed read.
 */
export function useOwnerNames(org: string, ids: readonly string[]): OwnerName[] {
  const held = (id: string) => {
    const user = P.user(id)
    return user && user.org === org ? user : undefined
  }
  const unheld = [...new Set(ids.filter((id) => !held(id)))].sort().slice(0, BY_IDS_MAX)
  const key = unheld.length === 0 ? null : JSON.stringify({ org_id: org, ids: unheld })
  const read = useLiveView<{ rows: PersonFaceRow[] }>(api.people.byIds, key)
  const current = key !== null && read.key === key
  const answered = new Map<string, PersonFaceRow | null>()
  if (current && read.value) {
    const rows = new Map(read.value.rows.map((row) => [row.id, row]))
    for (const id of unheld) {
      const row = rows.get(id) ?? null
      answered.set(id, row)
      if (row) keepOwnerName(org, row)
    }
  }
  const failed = current && 'error' in read
  return ids.map((id): OwnerName => {
    const user = held(id)
    if (user) return { id, state: 'ok', name: user.name, active: user.active }
    const row = answered.get(id)
    if (row) return { id, state: 'ok', name: row.name, active: row.active }
    if (row === null) return { id, state: 'gone' }
    const name = kept.get(`${org}\n${id}`)
    if (name) return { id, state: 'ok', name: name.name, active: name.active }
    return { id, state: failed && unheld.includes(id) ? 'failed' : 'loading' }
  })
}
