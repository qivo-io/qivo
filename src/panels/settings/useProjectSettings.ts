/* A project's Settings page's read of its settings from the server
   (projectSettings.get). Settings holds it for its check that the page is
   still valid and the phone's Back, and hands it to the page. It lives
   apart from ProjectSettings.tsx, which exports components only. */
import React from 'react'
import { api } from '../../../convex/_generated/api'
import { useLiveView } from '../../lib/liveView'
import type { ProjectSettingsAnswer } from '../../store/planner'

/** A project's settings as the server answers them (projectSettings.get). */
export type SettingsOk = Extract<ProjectSettingsAnswer, { state: 'ok' }>
type SettingsArchived = Extract<ProjectSettingsAnswer, { state: 'archived' }>

/** What a project's Settings page reads now (useProjectSettings):
    - `loading` before the first answer, and after a failure's Try again
      until one comes;
    - `ok` with a current answer;
    - `refreshing` while the read has no current answer, as after the tab
      showed again, a reconnect or Try again after a failure, with the
      last `ok` answer kept;
    - `failed` when the read failed, with the kept answer if it had one;
    - `unavailable` and `archived` as the server answers them, with the
      kept answer, so the page holds still while Settings moves on.
    `answer` is the current `ok` answer or the kept one, never one the
    store worked out. */
export type ProjectSettingsRead = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed' | 'unavailable' | 'archived'
  /** whether the read failed since its last `ok` answer. It stays true
      until a new `ok` answer, through Try again's `refreshing`, so the
      page keeps its writes off until an answer is current again. */
  afterFailure: boolean
  answer: SettingsOk | null
  /** an archived answer's names */
  archived: SettingsArchived | null
  /** Subscribes afresh, as Try again does. */
  retry: () => void
}

/**
 * The live read of project `projectId`'s settings (projectSettings.get),
 * or nothing for null. It subscribes while the page shows, stops while the
 * tab or the desktop window is hidden and when the page is left, and
 * keeps the last `ok` answer for the same project while the read has no
 * current answer, a failure included (ProjectSettingsRead). Call it once
 * per page: Settings calls it and passes the read to ProjectPage, and a
 * ProjectPage rendered on its own calls it itself. A second call with
 * equal arguments joins the first one's subscription (lib/liveView.ts),
 * so its `retry` reads back the result Convex holds, a failure included,
 * and asks the server nothing while the first call still subscribes.
 */
export function useProjectSettings(projectId: string | null): ProjectSettingsRead {
  const key = projectId === null ? null : JSON.stringify({ id: projectId })
  const view = useLiveView<ProjectSettingsAnswer>(api.projectSettings.get, key)
  const kept = React.useRef<{ id: string; answer: SettingsOk } | null>(null)
  // the key whose read failed since its last ok answer
  const failedKey = React.useRef<string | null>(null)
  const value = key !== null && view.key === key ? view.value : undefined
  const failed = key !== null && view.key === key && 'error' in view
  if (value?.state === 'ok' && projectId !== null) kept.current = { id: projectId, answer: value }
  if (value?.state === 'ok') failedKey.current = null
  else if (failed) failedKey.current = key
  const answer = kept.current && kept.current.id === projectId ? kept.current.answer : null
  const read = { afterFailure: key !== null && failedKey.current === key, retry: view.retry }
  if (value?.state === 'ok') return { ...read, state: 'ok', answer: value, archived: null }
  if (value?.state === 'unavailable') return { ...read, state: 'unavailable', answer, archived: null }
  if (value?.state === 'archived') return { ...read, state: 'archived', answer, archived: value }
  if (failed) return { ...read, state: 'failed', answer, archived: null }
  return { ...read, state: answer ? 'refreshing' : 'loading', answer, archived: null }
}
