/* One search rule for the planner, pickers, operator console and machine
 * surfaces: every whitespace-separated fragment must occur, in any order.
 * REST also keeps its existing explicit `*` wildcard within a fragment.
 * src/ imports this module, so it must stay free of server runtime. */

import type { IssuePriority, IssueStatus } from './enums'
import { PRIORITY_NAMES, STATUS_NAMES } from './taskRefs'

/* Each whitespace-separated fragment of `query`, lowercased and split into
 * the pieces that must occur in it in order, at every `*` with `stars` and
 * nowhere without. */
function searchFragments(query: string, stars: boolean): string[][] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.map((word) => (stars ? word.split('*') : [word]))
}

/**
 * A test of whether a text contains every whitespace-separated fragment of
 * `query`, in any order, ignoring case. The query is parsed once, so one
 * test can check many texts. A blank query matches any text. With `stars`,
 * each `*` in a fragment stands for any run of text.
 */
export function allWordsMatcher(query: string, stars = false): (hay: string) => boolean {
  const fragments = searchFragments(query, stars)
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

/** Whether `hay` matches `query` under allWordsMatcher, for one-off checks. */
export function matchesAllWords(hay: string, query: string): boolean {
  return allWordsMatcher(query)(hay)
}

/**
 * The distinct non-empty pieces of `query`'s fragments, lowercased, as
 * allWordsMatcher reads them. A piece holds no whitespace, so it never spans
 * the line between two taskSearchText fields, and leaving out a field that
 * contains none of these pieces never changes whether a task matches. A
 * query with no pieces (blank, or only `*` with `stars`) matches any text.
 */
export function searchPieces(query: string, stars = false): string[] {
  return [...new Set(searchFragments(query, stars).flat())].filter(Boolean)
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
