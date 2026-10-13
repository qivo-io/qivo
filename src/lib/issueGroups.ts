export type GroupIssue = {
  id: string
  status: string
  children?: readonly string[]
  isGroup?: boolean
  hasHiddenSubtasks?: boolean
}

/** A task as groupSpan reads it: week indexes, null when unplanned. */
export type DatedGroupIssue = GroupIssue & { start?: number | null; end?: number | null }

/** A group's calculated dates. `start` and `end` are null when no visible
 * leaf is scheduled; `partial` is the "unknown" flag groupProgress reports. */
export type GroupSpan = { start: number | null; end: number | null; partial: boolean }

export function isIssueGroup(issue: GroupIssue): boolean {
  return !!(issue.isGroup || issue.hasHiddenSubtasks || issue.children?.length)
}

/** Visit the visible leaves under a task. Nested groups contribute only
 * through their own children. Returns true when the walk cannot see the whole
 * subtree: hidden subtasks, a missing child, an empty group or a cycle. */
function walkLeaves<T extends GroupIssue>(
  issue: T,
  byId: Readonly<Record<string, T>>,
  visit: (leaf: T) => void,
): boolean {
  const seen = new Set([issue.id])
  const stack = [...(issue.children || [])]
  let unknown = !!issue.hasHiddenSubtasks || (isIssueGroup(issue) && !stack.length)
  while (stack.length) {
    const id = stack.pop() as string
    if (seen.has(id)) {
      unknown = true
      continue
    }
    seen.add(id)
    const child = byId[id]
    if (!child) {
      unknown = true
      continue
    }
    if (isIssueGroup(child)) {
      unknown ||= !!child.hasHiddenSubtasks || !child.children?.length
      stack.push(...(child.children || []))
    } else visit(child)
  }
  return unknown
}

/** Only executable leaf work contributes to completion. Missing children and
 * hidden branches cannot establish that a group is finished. */
function descendants(issue: GroupIssue, byId: Readonly<Record<string, GroupIssue>>) {
  let total = 0
  let done = 0
  const unknown = walkLeaves(issue, byId, (leaf) => {
    total++
    if (leaf.status === 'done') done++
  })
  return { total, done, unknown }
}

export function groupProgress(issue: GroupIssue, byId: Readonly<Record<string, GroupIssue>>) {
  const { total, done, unknown } = descendants(issue, byId)
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0, unknown }
}

export function isIssueDone(issue: GroupIssue, byId: Readonly<Record<string, GroupIssue>>) {
  if (!isIssueGroup(issue)) return issue.status === 'done'
  const { total, done, unknown } = descendants(issue, byId)
  return !unknown && total > 0 && total === done
}

/** A group's dates: the earliest start to the latest end of its visible
 * scheduled leaves, at any depth. A group's own stored dates are never read
 * (nested groups included), a leaf without an end counts as its start week,
 * and Done leaves count. `datesOf` overrides a leaf's dates when it returns a
 * value (the roadmap passes live drag drafts). Null for a leaf. */
export function groupSpan(
  issue: DatedGroupIssue,
  byId: Readonly<Record<string, DatedGroupIssue>>,
  datesOf?: (leaf: DatedGroupIssue) => { start: number | null; end: number | null } | undefined,
): GroupSpan | null {
  if (!isIssueGroup(issue)) return null
  let start = Infinity
  let end = -Infinity
  const partial = walkLeaves(issue, byId, (leaf) => {
    const dates = datesOf?.(leaf) ?? leaf
    if (dates.start == null) return
    start = Math.min(start, dates.start)
    end = Math.max(end, dates.start, dates.end ?? dates.start)
  })
  return start === Infinity ? { start: null, end: null, partial } : { start, end, partial }
}
