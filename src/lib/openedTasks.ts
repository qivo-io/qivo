/* The tasks main Search opened (panels/Palette.tsx openTaskResult), by the
   handle the app opened each by. Search finds tasks on the server, and the
   workspace may not hold one: it was archived, deleted or moved out of
   sight after the search, or it is archived and Search was asked to include
   archived tasks. The task window (panels/IssueDetail.tsx) then shows what
   Search noted, and looks the task up in the archive (TaskGone), and the
   address names the task's organization and key (lib/router.ts taskNamed).
   It holds the last OPENED_MAX tasks opened and nothing else, and goes once
   the app opens an unloaded task by itself (t3/limits-direct-links). */

/** What Search noted of a task it opened: its uuid, display key, title,
    project id and organization, and whether it was archived. */
export type OpenedTask = {
  uuid: string
  key: string
  title: string
  project: string
  org: string
  archived: boolean
}

/** How many opened tasks the registry keeps, the newest. */
export const OPENED_MAX = 64

const opened = new Map<string, OpenedTask>()

/** Notes `task`, which Search opens by `handle`, as the newest one. */
export function noteOpenedTask(handle: string, task: OpenedTask): void {
  opened.delete(handle)
  opened.set(handle, task)
  if (opened.size > OPENED_MAX) opened.delete(opened.keys().next().value ?? handle)
}

/** What Search noted of the task it opened by `handle`, if it is among the
    newest OPENED_MAX. */
export const openedTask = (handle: string): OpenedTask | undefined => opened.get(handle)
