/* The tasks the app opened that the workspace may not hold, by the task's
   uuid: a task main Search opened (panels/Palette.tsx openTaskResult),
   which Search finds on the server, and a task a task window opened from
   its Parent, Subtasks or Linked tasks that the workspace does not hold
   (panels/IssueDetail.tsx MiniIssueRow), as while a large workspace still
   loads, and a task a window shows that the workspace does not hold, from
   its own read or as what became of it, so another window on its handle
   finds it too, as the Inbox pane's pop-out. A task Search found may also
   be archived, deleted or moved out of sight since the search. The task window (panels/IssueDetail.tsx) knows
   such a task's uuid and organization from here, and shows it from its own
   read (store/planner.ts P.taskDetail), or what became of it (TaskGone);
   the address names the task's organization and key (lib/router.ts
   taskNamed), and that address resolves to the task again, so Back and
   Forward close and reopen its window as they do a loaded task's
   (findIssueKey).
   An entry keeps the task's identity, never a handle: which handle opens a
   task depends on the home organization, which can change while the entry
   is kept. Every reader derives the handle when it resolves an entry
   (`handleOf`, the store's P.handleNow), so after a change history opens
   the task that was noted, never another organization's task that now has
   its old handle, and the store moves the handle of an open window's task
   with the change (openedTaskList, P.watchHandles).
   It holds the last OPENED_MAX tasks opened and nothing else, and goes once
   the app opens an unloaded task by itself (t3/limits-direct-links). */

/** What the app noted of a task it opened: its uuid, number, display key,
    title, project id and organization. */
export type OpenedTask = {
  uuid: string
  num: number
  key: string
  title: string
  project: string
  org: string
}

/** How many opened tasks the registry keeps, the newest. */
export const OPENED_MAX = 64

const opened = new Map<string, OpenedTask>()

/** Notes `task`, which Search or a task window opens, as the newest one. */
export function noteOpenedTask(task: OpenedTask): void {
  opened.delete(task.uuid)
  opened.set(task.uuid, task)
  if (opened.size > OPENED_MAX) opened.delete(opened.keys().next().value ?? task.uuid)
}

/** Every task noted, oldest first, as the store reads them to move their
    handles when the home organization changes (store/planner.ts). */
export const openedTaskList = (): readonly OpenedTask[] => [...opened.values()]

/** The newest task noted whose handle, as `handleOf` derives it now, is
    `handle`, if it is among the newest OPENED_MAX. */
export function openedTask(
  handle: string,
  handleOf: (task: OpenedTask) => string,
): OpenedTask | undefined {
  let found: OpenedTask | undefined
  for (const task of opened.values()) if (handleOf(task) === handle) found = task
  return found
}

/** The newest task noted that is `key` (QN-12) in organization `org`, or
    that has `uuid`, if it is among the newest OPENED_MAX. */
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
