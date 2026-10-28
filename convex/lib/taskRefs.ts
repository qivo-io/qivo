/* How tasks are named to people, with the task ID prefix, the grammar of a
 * task ref and the status and priority display names. src/ imports this
 * module through lib/search.ts, and the app's task window
 * (lib/taskWindow.ts) reads refs through it without the machine core, so it
 * must stay free of server runtime. Its only other import is a type. */

import type { IssuePriority, IssueStatus } from './enums'

/** The task display prefix is fixed across organizations. */
export const ISSUE_PREFIX = 'QN'

export const issueKey = (num: number): string => `${ISSUE_PREFIX}-${num}`

/** A uuid in any case. Stored uuids are lowercase, so a ref is lowercased
 * before a lookup. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The largest task or project number a ref may name. A larger one is a
 * clean miss, never a crash (verify-mcp pins QN-3000000000 → not-found). */
export const INT4_MAX = 2147483647

const ISSUE_REF = new RegExp(`^(?:${ISSUE_PREFIX}-)?(\\d+)$`, 'i')

/** What a task ref names: "QN-482" or a bare "482" (a number within one
 * organization), or a uuid in any case, lowercased. null when it can name
 * no task. */
export function parseIssueRef(ref: string): { uuid: string } | { num: number } | null {
  if (UUID.test(ref)) return { uuid: ref.toLowerCase() }
  const m = ref.match(ISSUE_REF)
  if (m === null) return null
  const num = Number(m[1])
  return num >= 1 && num <= INT4_MAX ? { num } : null
}

/** Status display names, shared by activity, inbox narration and search. */
export const STATUS_NAMES: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
}

/** Priority display names, shared by activity, inbox narration and search. */
export const PRIORITY_NAMES: Record<IssuePriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
