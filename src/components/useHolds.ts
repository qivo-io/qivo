/* Whether the person sees any project and any sub-project, from the
   server's answer (convex/projectNav.ts holds), for every "no project"
   and "no sub-project" note: My view's Overview, Board, Roadmap and phone
   list, the Inbox's empty note and Team sync before it shows a meeting.
   The store holds no project, so no page can tell from what it holds. A
   page mounts the read only where its note could show, through the
   hidden-tab gate (lib/liveView.ts useLiveView), so a hidden tab reads
   nothing. Only a confirmed answer says so: while the read loads, stops
   (the read budget ended its walk), is not ready, is refused or fails, it
   answers `unknown`, which a page shows as its own answer's note, never
   as "no project". */

import { api } from '../../convex/_generated/api'
import type { NavHolds } from '../../convex/model/projectNavReads'
import { useLiveView } from '../lib/liveView'

/** What the person holds, as a "no project" note reads it: `none` (no live
    top-level project), `no_sub` (a top-level project but no live
    sub-project), `some` (both), or `unknown` while the server has not
    confirmed either. */
export type HoldsNote = 'none' | 'no_sub' | 'some' | 'unknown'

/** What holds' answer `answer` says for a note. */
export function holdsNote(answer: NavHolds | undefined): HoldsNote {
  if (answer?.state !== 'ok') return 'unknown'
  if (!answer.top) return 'none'
  return answer.sub ? 'some' : 'no_sub'
}

/**
 * Whether the person sees any project and sub-project, across every seat or
 * in organization `org` (projectNav.holds), while `active`, which a page
 * sets only where its note could show; `unknown` otherwise and until a
 * current answer confirms it.
 */
export function useHolds(active: boolean, org?: string): HoldsNote {
  const key = active ? JSON.stringify(org === undefined ? {} : { org_id: org }) : null
  const read = useLiveView<NavHolds>(api.projectNav.holds, key)
  return read.key === key ? holdsNote(read.value) : 'unknown'
}
