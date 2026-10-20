import { fmtDateYear, fmtTime } from './dates'
import type { SavePause } from './syncStatus'

/* The words of the floating notices (components/SnapshotNotice and
   components/SavePauseNotice) and of a view waiting for the connection
   (components/ViewBoundary), kept apart from the components so a change to
   either side keeps Fast Refresh. */

/** When the view was last current. Today it is the time, on an earlier day
    the date and time ("16 Oct, 14:32"), in the organization's day and month
    order. */
export function asOfText(asOf: string, now = new Date()): string {
  const at = new Date(asOf)
  const sameDay = at.toDateString() === now.toDateString()
  return sameDay ? fmtTime(at) : `${fmtDateYear(at, now)}, ${fmtTime(at)}`
}

/* Each pause's title, and the sentence saying what it pauses. */
const PAUSES: Record<SavePause['kind'], { title: string; paused: string }> = {
  offline: { title: 'You’re offline', paused: 'Editing is paused until the connection is back.' },
  slow: {
    title: 'Saving is taking longer than usual',
    paused: 'Editing is paused until it finishes.',
  },
}

/** The sentence a change refused during the pause `kind` shows, the same
    in the app (store/planner.ts OFFLINE_TEXT and SLOW_TEXT) and in the
    operator console. */
export function pauseSentence(kind: SavePause['kind']): string {
  return `${PAUSES[kind].title}. ${PAUSES[kind].paused}`
}

/** The title and line of a view whose code waits for the connection
    (components/ViewBoundary). It opens once the connection is back. */
export function viewOfflineWords(): { title: string; line: string } {
  return { title: PAUSES.offline.title, line: 'This view opens when the connection is back.' }
}

/** The title and line of the notice while Qivo cannot save. The line
    counts the changes sent before the pause that still wait. */
export function savePauseWords({ kind, waiting }: SavePause): { title: string; line: string } {
  const { title, paused } = PAUSES[kind]
  const changes = waiting === 1 ? '1 change' : `${waiting} changes`
  if (!waiting) return { title, line: paused }
  if (kind === 'slow')
    return { title, line: `${paused} ${changes} ${waiting === 1 ? 'is' : 'are'} still saving.` }
  return {
    title,
    line: `${paused} ${changes} made before the connection dropped will save when it is back. Keep Qivo open until then.`,
  }
}
