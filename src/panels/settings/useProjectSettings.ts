/* A project's Settings page's read of its settings from the server
   (projectSettings.get), which Settings holds too for its check that the
   page is still valid and the phone's Back. It lives apart from
   ProjectSettings.tsx, which exports components only. */
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
      showed again or a reconnect, with the last `ok` answer kept;
    - `failed` when the read failed, with the kept answer if it had one;
    - `unavailable` and `archived` as the server answers them, with the
      kept answer, so the page holds still while Settings moves on.
    `answer` is the current `ok` answer or the kept one, never one the
    store worked out. */
export type ProjectSettingsRead = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed' | 'unavailable' | 'archived'
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
 * current answer, a failure included (ProjectSettingsRead). Settings and
 * the page both call it with equal arguments, which share one
 * subscription (lib/liveView.ts).
 */
export function useProjectSettings(projectId: string | null): ProjectSettingsRead {
  const key = projectId === null ? null : JSON.stringify({ id: projectId })
  const view = useLiveView<ProjectSettingsAnswer>(api.projectSettings.get, key)
  const kept = React.useRef<{ id: string; answer: SettingsOk } | null>(null)
  const value = key !== null && view.key === key ? view.value : undefined
  if (value?.state === 'ok' && projectId !== null) kept.current = { id: projectId, answer: value }
  const answer = kept.current && kept.current.id === projectId ? kept.current.answer : null
  const retry = view.retry
  if (value?.state === 'ok') return { state: 'ok', answer: value, archived: null, retry }
  if (value?.state === 'unavailable') return { state: 'unavailable', answer, archived: null, retry }
  if (value?.state === 'archived') return { state: 'archived', answer, archived: value, retry }
  if (key !== null && view.key === key && 'error' in view)
    return { state: 'failed', answer, archived: null, retry }
  return { state: answer ? 'refreshing' : 'loading', answer, archived: null, retry }
}
