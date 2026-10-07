export type GroupIssue = {
  id: string
  status: string
  children?: readonly string[]
  isGroup?: boolean
  hasHiddenSubtasks?: boolean
}

export function isIssueGroup(issue: GroupIssue): boolean {
  return !!(issue.isGroup || issue.hasHiddenSubtasks || issue.children?.length)
}

/** Only executable leaf work contributes to completion. Missing children and
 * hidden branches cannot establish that a group is finished. */
function descendants(issue: GroupIssue, byId: Readonly<Record<string, GroupIssue>>) {
  const seen = new Set([issue.id])
  const stack = [...(issue.children || [])]
  let unknown = !!issue.hasHiddenSubtasks || (isIssueGroup(issue) && !stack.length)
  let total = 0
  let done = 0
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
    } else {
      total++
      if (child.status === 'done') done++
    }
  }
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
