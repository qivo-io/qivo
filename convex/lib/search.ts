/* One search rule for the planner, pickers, operator console and machine
 * surfaces: every whitespace-separated fragment must occur, in any order.
 * REST also keeps its existing explicit `*` wildcard within a fragment.
 * src/ imports this module, so it must stay free of server runtime. */

import type { IssuePriority, IssueStatus } from './enums'
import { PRIORITY_NAMES, STATUS_NAMES } from './taskRefs'

export function allWordsMatcher(query: string, stars = false): (hay: string) => boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const fragments = words.map((word) => (stars ? word.split('*') : [word]))
  return (hay) => {
    const h = hay.toLowerCase()
    return fragments.every((parts) => {
      let from = 0
      return parts.every((part) => {
        const index = h.indexOf(part, from)
        if (index < 0) return false
        from = index + part.length
        return true
      })
    })
  }
}

export function matchesAllWords(hay: string, query: string): boolean {
  return allWordsMatcher(query)(hay)
}

/** What a task search reads about one task, as the reader knows it. */
export type TaskSearchFields = {
  /** the task ID, such as QN-482 */
  key: string
  title: string
  description: string
  status: IssueStatus
  /** a task with subtasks, whose own status is dormant and is not searched */
  group: boolean
  priority: IssuePriority
  /** the assignee's name, when the task has one the reader knows */
  assigneeName: string | null | undefined
  /** the task's label names; a label the reader does not know is skipped */
  labelNames: readonly (string | null | undefined)[]
}

/**
 * The text a task search matches, one field per line: task ID, title,
 * description, status name (not for a task with subtasks), priority name,
 * assignee name and label names. The app's task filter (src/store/planner.ts
 * matchesSearch) and REST and MCP task search (lib/core.ts listIssuesCore)
 * both build it here, so a word that finds a task in one finds it in all.
 */
export function taskSearchText(task: TaskSearchFields): string {
  return [
    task.key,
    task.title,
    task.description,
    task.group ? null : STATUS_NAMES[task.status],
    PRIORITY_NAMES[task.priority],
    task.assigneeName,
    ...task.labelNames,
  ]
    .filter(Boolean)
    .join('\n')
}
