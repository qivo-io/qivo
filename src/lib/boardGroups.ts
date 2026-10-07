import type { Doc } from '../../convex/_generated/dataModel'
import { taskOwnerId } from '../../convex/lib/review'

export type BoardCellIssue = {
  id: string
  uuid: string
  parent?: string | null
  children?: string[]
  isGroup?: boolean
}

export type BoardCellGroup<T extends BoardCellIssue> = {
  key: string
  parent: T | null
  ancestors: T[]
  issues: T[]
}

export type BoardAssigneeLane<T> = {
  key: string
  owner: string | null
  items: T[]
}

/** Build lanes from scoped leaf tasks before filtering, so Focus can empty a
 * lane without removing it. Visible tasks alone populate cells. A lane's
 * person is its cards' effective owner (IssueVM.owner: the reviewer while a
 * task waits In Review, else the assignee). Profile IDs distinguish people
 * with the same name and preserve historical owners; only unowned tasks
 * belong to Unassigned, which sorts last. Lane keys stay
 * `assignee:<id|unassigned>`, the stable handle drives and data-lane read. */
export function groupBoardAssignees<T extends { owner?: string | null }>(
  scopedTasks: readonly T[],
  visibleTasks: readonly T[],
  nameOf: (id: string) => string,
): BoardAssigneeLane<T>[] {
  const lanes = new Map<string | null, BoardAssigneeLane<T>>()
  for (const task of scopedTasks) {
    const owner = task.owner || null
    if (!lanes.has(owner)) {
      lanes.set(owner, {
        key: `assignee:${owner || 'unassigned'}`,
        owner,
        items: [],
      })
    }
  }
  for (const task of visibleTasks) lanes.get(task.owner || null)?.items.push(task)
  return [...lanes.values()].sort((a, b) => {
    if (a.owner === null) return 1
    if (b.owner === null) return -1
    return nameOf(a.owner).localeCompare(nameOf(b.owner)) || a.key.localeCompare(b.key)
  })
}

type Status = Doc<'issues'>['status']
/** The IssuePatch keys a board drop may write. */
export type BoardDropPatch = { status?: Status; assignee?: string | null; reviewer?: string | null }

/** What one board drop writes, as ONE issues.update patch (the app-side
 * IssuePatch keys), or null when the drop is refused. `lane` is the target
 * swimlane's person (null = Unassigned); undefined means the board has no
 * lanes, so only the status can change.
 *
 * A drop never reassigns work by accident: when the card already belongs to
 * the lane, or the status move alone hands it there (a Review card dragged
 * out of its reviewer's lane returns to its assignee), only the status is
 * written. Otherwise the lane names a new owner: the assignee outside the
 * Review column, the reviewer inside it. Dropping into the assignee's own
 * lane in the Review column clears the reviewer instead, and a Review drop
 * onto Unassigned while the task has an assignee is refused, since no
 * reviewer value can make it unowned. An identical drop returns `{}`. */
export function boardDropPatch(
  task: { status: Status; assignee?: string | null; reviewer?: string | null },
  status: Status,
  lane?: string | null,
): BoardDropPatch | null {
  const patch: BoardDropPatch = {}
  if (task.status !== status) patch.status = status
  if (lane === undefined) return patch
  const people = {
    assignee_id: task.assignee ?? undefined,
    reviewer_id: task.reviewer ?? undefined,
  }
  if ((taskOwnerId({ status: task.status, ...people }) ?? null) === lane) return patch
  if ((taskOwnerId({ status, ...people }) ?? null) === lane) return patch
  if (status !== 'review') {
    patch.assignee = lane
    return patch
  }
  if (lane === (task.assignee ?? null)) {
    patch.reviewer = null
    return patch
  }
  if (lane === null) return null
  patch.reviewer = lane
  return patch
}

/** Group one already-filtered status × swimlane cell, in its supplied priority
 * order. Accessible parents may appear as context even when outside the cell
 * or filter; children are never pulled in from outside the supplied issues.
 *
 * Only leaf tasks occupy status cells. Parents are grouping headings wherever
 * their visible leaves appear; their stored status never places a card. Nested
 * groups include accessible ancestors as headings above the immediate parent.
 *
 * Group order follows the first visible member, and child rows retain their
 * relative input order. Keys use immutable UUIDs. Inputs are never mutated.
 * Parent traversal is cycle-safe; self-parent links are ignored. Duplicate input
 * UUIDs are represented once.
 */
export function groupBoardCell<T extends BoardCellIssue>(
  visibleCellIssues: readonly T[],
  issueById: Readonly<Record<string, T>>,
): BoardCellGroup<T>[] {
  const accessibleParent = (issue: T): T | null => {
    const parent = issue.parent ? issueById[issue.parent] : undefined
    return parent && parent.uuid !== issue.uuid ? parent : null
  }

  // Direct links also identify groups when a caller's children list is incomplete.
  const parentUuids = new Set<string>()
  for (const issue of Object.values(issueById)) {
    const parent = accessibleParent(issue)
    if (parent) parentUuids.add(parent.uuid)
  }

  const groups = new Map<string, BoardCellGroup<T>>()
  const seen = new Set<string>()
  const family = (parent: T): BoardCellGroup<T> => {
    const key = `parent:${parent.uuid}`
    let group = groups.get(key)
    if (!group) {
      const ancestors: T[] = []
      const visited = new Set([parent.uuid])
      let ancestor = accessibleParent(parent)
      while (ancestor && !visited.has(ancestor.uuid)) {
        visited.add(ancestor.uuid)
        ancestors.unshift(ancestor)
        ancestor = accessibleParent(ancestor)
      }
      group = { key, parent, ancestors, issues: [] }
      groups.set(key, group)
    }
    return group
  }

  for (const issue of visibleCellIssues) {
    if (seen.has(issue.uuid)) continue
    seen.add(issue.uuid)
    if (
      issue.isGroup ||
      parentUuids.has(issue.uuid) ||
      issue.children?.some((childId) => childId !== issue.id)
    )
      continue

    const parent = accessibleParent(issue)
    if (parent) {
      family(parent).issues.push(issue)
    } else {
      const key = `issue:${issue.uuid}`
      groups.set(key, { key, parent: null, ancestors: [], issues: [issue] })
    }
  }

  return [...groups.values()]
}
