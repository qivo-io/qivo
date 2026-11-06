/* The read of one person of Settings › Users from the server (people.get).
   Settings holds it for its check that a `user:` page is still valid and
   hands it to the Users page, which shows the person on the phone's user
   page. It lives apart from UsersSettings.tsx, which exports components
   only. */
import React from 'react'
import { api } from '../../../convex/_generated/api'
import { useLiveView } from '../../lib/liveView'
import { P, type PersonSettingsAnswer } from '../../store/planner'

/** A person as the server answers them (people.get). */
export type PersonOk = Extract<PersonSettingsAnswer, { state: 'ok' }>

/** What a `user:` page reads now (usePersonSettings):
    - `loading` before the first answer, and after a failure's Try again,
      until one comes;
    - `ok` with a current answer;
    - `refreshing` while the read has no current answer, as after the tab
      showed again, a reconnect or Try again after a failure, with the
      last `ok` answer kept;
    - `failed` when the read failed, with the kept answer if it had one;
    - `unavailable` as the server answers it, with the kept answer, so the
      page holds still while Settings moves on.
    `answer` is the current `ok` answer or the kept one, never one the
    store worked out. */
export type PersonSettingsRead = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed' | 'unavailable'
  /** whether the read failed since its last `ok` answer. It stays true
      until a new `ok` answer, through Try again's `refreshing`, so the
      page keeps its writes off until an answer is current again. */
  afterFailure: boolean
  answer: PersonOk | null
  /** Subscribes afresh, as Try again does, and has the server run the
      read again for every call for the same person. */
  retry: () => void
}

/**
 * The live read of person `personId` of the home organization (people.get),
 * or nothing for null and for a seat that is not an admin, whose read the
 * server would refuse. It subscribes while the page shows, stops while the
 * tab or the desktop window is hidden and when the page is left, and keeps
 * the last `ok` answer for the same person while the read has no current
 * answer, a failure included (PersonSettingsRead). Settings calls it once
 * and passes the read to the Users page.
 */
export function usePersonSettings(personId: string | null): PersonSettingsRead {
  const key =
    personId === null || !P.isAdmin() || !P.homeOrg
      ? null
      : JSON.stringify({ org_id: P.homeOrg, id: personId })
  const view = useLiveView<PersonSettingsAnswer>(api.people.get, key)
  // the last ok answer and its person, with whether its read failed since
  const kept = React.useRef<{ id: string; answer: PersonOk; failed: boolean } | null>(null)
  const value = key !== null && view.key === key ? view.value : undefined
  const failed = key !== null && view.key === key && 'error' in view
  if (value?.state === 'ok' && personId !== null)
    kept.current = { id: personId, answer: value, failed: false }
  else if (failed && kept.current !== null && kept.current.id === personId)
    kept.current = { ...kept.current, failed: true }
  const held = kept.current !== null && kept.current.id === personId ? kept.current : null
  const answer = held ? held.answer : null
  const read = { afterFailure: failed || held?.failed === true, retry: view.retry }
  if (value?.state === 'ok') return { ...read, state: 'ok', answer: value }
  if (value?.state === 'unavailable') return { ...read, state: 'unavailable', answer }
  if (failed) return { ...read, state: 'failed', answer }
  return { ...read, state: answer ? 'refreshing' : 'loading', answer }
}
