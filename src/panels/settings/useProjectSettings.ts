/* The read of a project's settings from the server (projectSettings.get).
   Settings holds it for its check that a project's page is still valid and
   the phone's Back, and hands it to the page; the New sub-project dialog
   reads it for the parent it would create under (panels/Modals.tsx). A
   page names its project by id, or a numbered page by its organization and
   number (lib/router.ts projectPageRef), and the read asks by the form it
   was given. It lives apart from ProjectSettings.tsx, which exports
   components only. */
import React from 'react'
import { api } from '../../../convex/_generated/api'
import { useLiveView } from '../../lib/liveView'
import type { ProjectPageRef } from '../../lib/router'
import type { ProjectSettingsAnswer } from '../../store/planner'

/** A project's settings as the server answers them (projectSettings.get). */
export type SettingsOk = Extract<ProjectSettingsAnswer, { state: 'ok' }>
type SettingsArchived = Extract<ProjectSettingsAnswer, { state: 'archived' }>

/** What a project's Settings page reads now (useProjectSettings):
    - `loading` before the first answer, and after a failure's Try again,
      in this call or another for the same project, until one comes;
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
      page keeps its writes off until an answer is current again. It is
      kept with the project's kept answer, so another project's failure
      while the page was elsewhere neither sets nor clears it. */
  afterFailure: boolean
  answer: SettingsOk | null
  /** an archived answer's names */
  archived: SettingsArchived | null
  /** Subscribes afresh, as Try again does, and has the server run the
      read again for every call for the same project. */
  retry: () => void
}

/**
 * The live read of the settings of the project `project` names, by its id
 * or as a page reference (lib/router.ts ProjectPageRef), by id or by
 * organization and number (projectSettings.get), or nothing for null. It
 * subscribes while the page shows, stops while the tab or the desktop
 * window is hidden and when the page is left, and keeps the last `ok`
 * answer for the same form while the read has no current answer, a failure
 * included (ProjectSettingsRead). Call it once
 * per page or dialog for a project. Settings calls it and passes the read
 * to ProjectPage, a ProjectPage rendered on its own calls it itself, and
 * the New sub-project dialog calls it for its parent, which the project
 * page under the dialog may read as well. Calls for the same project
 * share one subscription (lib/liveView.ts), and `retry` in any of them
 * has the server run the read again for all of them, each of which then
 * answers `loading` or `refreshing` until the new answer comes.
 */
export function useProjectSettings(project: string | ProjectPageRef | null): ProjectSettingsRead {
  const key = keyOf(project)
  const view = useLiveView<ProjectSettingsAnswer>(api.projectSettings.get, key)
  // the last ok answer and its read's key, with whether its read failed
  // since; kept by the key, as the reference may be a new object each render
  const kept = React.useRef<{ key: string; answer: SettingsOk; failed: boolean } | null>(null)
  const value = key !== null && view.key === key ? view.value : undefined
  const failed = key !== null && view.key === key && 'error' in view
  if (value?.state === 'ok' && key !== null) kept.current = { key, answer: value, failed: false }
  else if (failed && kept.current !== null && kept.current.key === key)
    kept.current = { ...kept.current, failed: true }
  const held = kept.current !== null && kept.current.key === key ? kept.current : null
  const answer = held ? held.answer : null
  const read = { afterFailure: failed || held?.failed === true, retry: view.retry }
  if (value?.state === 'ok') return { ...read, state: 'ok', answer: value, archived: null }
  if (value?.state === 'unavailable')
    return { ...read, state: 'unavailable', answer, archived: null }
  if (value?.state === 'archived') return { ...read, state: 'archived', answer, archived: value }
  if (failed) return { ...read, state: 'failed', answer, archived: null }
  return { ...read, state: answer ? 'refreshing' : 'loading', answer, archived: null }
}

/* The read's arguments for `project` as one key, in a fixed key order:
   `{ id }` for an id, else the reference's own form. */
function keyOf(project: string | ProjectPageRef | null): string | null {
  if (project === null) return null
  if (typeof project === 'string') return JSON.stringify({ id: project })
  return JSON.stringify(
    'id' in project ? { id: project.id } : { org_id: project.org_id, num: project.num },
  )
}
