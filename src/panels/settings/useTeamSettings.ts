/* The read of a team's Settings page from the server (teams.get). Settings
   holds it for its check that a team's page may still show and hands it
   to the page, as it holds a project's (useProjectSettings.ts). It lives
   apart from TeamSettings.tsx, which exports components only. */
import React from 'react'
import { api } from '../../../convex/_generated/api'
import { useLiveView } from '../../lib/liveView'
import { P, type TeamSettingsAnswer } from '../../store/planner'

/** A team's page as the server answers it (teams.get). */
export type TeamSettingsOk = Extract<TeamSettingsAnswer, { state: 'ok' }>

/** What a team's Settings page reads now (useTeamSettings):
    - `loading` before the first answer, and after a failure's Try again
      until one comes;
    - `ok` with a current answer;
    - `refreshing` while the read has no current answer, as after the tab
      showed again, a reconnect or Try again after a failure, with the
      last `ok` answer kept;
    - `failed` when the read failed, with the kept answer if it had one;
    - `unavailable` as the server answers it, for a team that is gone or
      not the caller's organization's, with the kept answer, so the page
      holds still while Settings moves on.
    `answer` is the current `ok` answer or the kept one, never one the
    store worked out. */
export type TeamSettingsRead = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed' | 'unavailable'
  /** whether the read failed since its last `ok` answer. It stays true
      until a new `ok` answer, through Try again's `refreshing`, so the
      page keeps its writes off until an answer is current again. */
  afterFailure: boolean
  answer: TeamSettingsOk | null
  /** Subscribes afresh, as Try again does, and has the server run the
      read again for every call for the same team. */
  retry: () => void
}

/**
 * The live read of team `teamId` of the home organization (teams.get), or
 * nothing for null. It subscribes while the page shows, stops while the tab
 * or the desktop window is hidden and when the page is left, and keeps the
 * last `ok` answer for the same team while the read has no current answer,
 * a failure included (TeamSettingsRead). Settings calls it and passes the
 * read to TeamPage, and a TeamPage rendered on its own calls it itself.
 * Calls for the same team share one subscription (lib/liveView.ts).
 */
export function useTeamSettings(teamId: string | null): TeamSettingsRead {
  const key = teamId === null ? null : JSON.stringify({ org_id: P.homeOrg, id: teamId })
  const view = useLiveView<TeamSettingsAnswer>(api.teams.get, key)
  // the last ok answer and its team, with whether its read failed since
  const kept = React.useRef<{ id: string; answer: TeamSettingsOk; failed: boolean } | null>(null)
  const value = key !== null && view.key === key ? view.value : undefined
  const failed = key !== null && view.key === key && 'error' in view
  if (value?.state === 'ok' && teamId !== null)
    kept.current = { id: teamId, answer: value, failed: false }
  else if (failed && kept.current !== null && kept.current.id === teamId)
    kept.current = { ...kept.current, failed: true }
  const held = kept.current !== null && kept.current.id === teamId ? kept.current : null
  const answer = held ? held.answer : null
  const read = { afterFailure: failed || held?.failed === true, retry: view.retry }
  if (value?.state === 'ok') return { ...read, state: 'ok', answer: value }
  if (value?.state === 'unavailable') return { ...read, state: 'unavailable', answer }
  if (failed) return { ...read, state: 'failed', answer }
  return { ...read, state: answer ? 'refreshing' : 'loading', answer }
}
