/* The tasks main Search opened (panels/Palette.tsx openTaskResult), by the
   task's uuid. Search finds tasks on the server, and the workspace may not
   hold one: it was archived, deleted or moved out of sight after the
   search, or it is archived and Search was asked to include archived
   tasks. The task window (panels/IssueDetail.tsx) then shows what Search
   noted, and looks the task up in the archive (TaskGone), the address names
   the task's organization and key (lib/router.ts taskNamed), and that
   address resolves to the task again, so Back and Forward close and reopen
   its window as they do a loaded task's (findIssueKey).
   An entry keeps the task's identity, never a handle: which handle opens a
   task depends on the home organization, which can change while the entry
   is kept. Every reader derives the handle when it resolves an entry
   (`handleOf`, the store's P.handleNow), so after a change history opens
   the task Search found, never another organization's task that now has
   its old handle.
   It holds the last OPENED_MAX tasks opened and nothing else, and goes once
   the app opens an unloaded task by itself (t3/limits-direct-links). */

/** What Search noted of a task it opened: its uuid, number, display key,
    title, project id and organization, and whether it was archived. */
export type OpenedTask = {
  uuid: string
  num: number
  key: string
  title: string
  project: string
  org: string
  archived: boolean
}

/** How many opened tasks the registry keeps, the newest. */
export const OPENED_MAX = 64

const opened = new Map<string, OpenedTask>()

/** Notes `task`, which Search opens, as the newest one. */
export function noteOpenedTask(task: OpenedTask): void {
  opened.delete(task.uuid)
  opened.set(task.uuid, task)
  if (opened.size > OPENED_MAX) opened.delete(opened.keys().next().value ?? task.uuid)
}

/** The newest task Search opened whose handle, as `handleOf` derives it now,
    is `handle`, if it is among the newest OPENED_MAX. */
export function openedTask(
  handle: string,
  handleOf: (task: OpenedTask) => string,
): OpenedTask | undefined {
  let found: OpenedTask | undefined
  for (const task of opened.values()) if (handleOf(task) === handle) found = task
  return found
}

/** The newest task Search opened that is `key` (QN-12) in organization
    `org`, or that has `uuid`, if it is among the newest OPENED_MAX. */
export function openedTaskMatching(
  match: { org: string; key: string } | { uuid: string },
): OpenedTask | undefined {
  let found: OpenedTask | undefined
  for (const task of opened.values())
    if (
      'uuid' in match ? task.uuid === match.uuid : task.org === match.org && task.key === match.key
    )
      found = task
  return found
}
