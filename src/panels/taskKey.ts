/* Which task a task window is about, as one number, so the window's own
   state and the Inbox pane's mount follow the task rather than the string
   that names it. A task window is opened by a handle or by a reference
   (lib/taskReference.ts), and either can change while the task stays the
   same: a reference turns into its handle once the workspace holds the
   task, a handle moves with a change of the home organization, and a read
   names the key of a task opened by its uuid. */

import { useRef } from 'react'
import { taskFacts } from '../lib/router'

/** What useTaskKey keeps of the task: every string it was named by, and
    its uuid, organization and number once known. */
type TaskIdentity = { n: number; ids: Set<string>; uuid?: string; org?: string; num?: number }

/** A number that stays while `open` names the same task: the same uuid,
    or the same number in the same organization, by what the store knows of
    it (lib/router.ts taskFacts), or while the store knows neither, as of a
    task that left, a string it was named by before. It moves on when
    another task opens, or none. */
export function useTaskKey(open: string | null): number {
  const ident = useRef<TaskIdentity>({ n: 0, ids: new Set() })
  const was = ident.current
  if (!open) {
    if (was.ids.size > 0) ident.current = { n: was.n + 1, ids: new Set() }
    return ident.current.n
  }
  const facts = taskFacts(open)
  const same =
    facts?.uuid && was.uuid
      ? facts.uuid === was.uuid
      : facts?.org && was.org && facts.num !== undefined && was.num !== undefined
        ? facts.org === was.org && facts.num === was.num
        : was.ids.has(open)
  const next: TaskIdentity = same ? was : { n: was.n + 1, ids: new Set() }
  next.ids.add(open)
  next.uuid ??= facts?.uuid
  next.org ??= facts?.org ?? undefined
  next.num ??= facts?.num
  ident.current = next
  return next.n
}
