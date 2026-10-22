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

/* The parents' uuids of each task map groupBoardCell was given. A board asks
   once per cell, and the store hands the same map until a task changes. The
   map is read only, never changed in place. */
const parentsOf = new WeakMap<object, Set<string>>()

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
  let parentUuids = parentsOf.get(issueById)
  if (!parentUuids) {
    parentUuids = new Set<string>()
    for (const issue of Object.values(issueById)) {
      const parent = accessibleParent(issue)
      if (parent) parentUuids.add(parent.uuid)
    }
    parentsOf.set(issueById, parentUuids)
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

/* Card geometry for estimateCardHeight, measured in Chromium (Playwright,
   1440 x 1000) on the benchmark's varied workspace at 500 tasks: each row's
   getBoundingClientRect height by shape, with the title's line count from
   its height over its line height. Rows: 8px padding above and below; a
   task title line is 18.9px, then an 8px gap and the meta line; a parent
   title line is 19.6px, then an 8px gap and the 18px portrait line; the
   delay banner is 25.4px; a place line adds its 8px gap and 17.4px. A
   task's meta line wraps its items as flex-wrap does, 8px apart across and
   4px down, and a line of text is 17.4px high, a line of the 11px priority
   mark alone 11px (measured on the 10,000-task local Northstar).
   A title's lines come from wrapping its words at the widths of their
   characters (TITLE_GLYPH_PX). A task title is 54px narrower than its card
   (borders, padding, portrait and gap), a child's another 12px for the
   rail, a parent title 18px. */
const ROW_PAD = 8
const TITLE_LINE = 18.9
const META_TOP = 8
const META_GAP_X = 8
const META_GAP_Y = 4
/** The height of a line of meta text, and the size of the priority mark. */
export const META_TEXT_LINE = 17.4
export const META_ICON_PX = 11
const PARENT_LINE = 19.6
const PARENT_META = 8 + 18
const BANNER = 25.4
const PLACE_LINE = 8 + 17.4
/* The advance of each printable ASCII character, space to tilde, in a card
   title's font (14px Instrument Sans at weight 500), measured with a canvas
   in Chromium. Layout comes out 2% narrower than these sums, so they are
   scaled by TITLE_GLYPH_SCALE; a character past ASCII takes
   TITLE_GLYPH_OTHER_PX. On the 10,000-task local Northstar this predicts
   94% of titles' lines exactly in Swimlanes and 98% in Side-by-side boards,
   where a flat 8px a character got 69% and 80%. */
const TITLE_GLYPH_PX = [
  3, 4, 6, 10, 9, 11, 11, 3, 6, 6, 6, 8, 4, 7, 4, 6, 9, 5, 8, 8, 9, 8, 9, 8, 8, 9, 4, 4, 8, 8, 8, 8,
  12, 10, 9, 10, 11, 9, 8, 11, 10, 4, 6, 10, 8, 13, 10, 11, 9, 11, 9, 9, 9, 10, 10, 15, 10, 10, 9,
  6, 6, 6, 8, 6, 5, 8, 9, 8, 9, 8, 5, 9, 8, 4, 4, 8, 4, 13, 8, 8, 9, 9, 5, 7, 5, 8, 7, 11, 8, 7, 7,
  6, 3, 6, 8,
]
const TITLE_GLYPH_SCALE = 0.98
const TITLE_GLYPH_OTHER_PX = 8
const TASK_CHROME_PX = 54
const CHILD_CHROME_PX = TASK_CHROME_PX + 12
const PARENT_CHROME_PX = 18
const CARD_BORDER = 2
/** The gap between cards in a cell. */
export const CARD_GAP = 8
/** The least a card and the gap after it take: one plain row of one line,
    with the priority mark alone on its meta line. */
export const MIN_CARD_PITCH = Math.floor(
  CARD_BORDER + 2 * ROW_PAD + TITLE_LINE + META_TOP + META_ICON_PX + CARD_GAP,
)

/** One item of a task row's meta line, as wide and high as it draws. */
export type MetaItem = { width: number; height: number }

/** The height of a task row's meta line `width` pixels wide, with its gap
    above: the items in rows as flex-wrap lays them out, each at most the
    line's width, as a place truncates. */
function metaHeight(items: readonly MetaItem[], width: number) {
  let height = META_TOP
  let row = 0
  let x = -1
  for (const item of items) {
    const w = Math.min(item.width, width)
    if (x >= 0 && x + META_GAP_X + w > width) {
      height += row + META_GAP_Y
      row = 0
      x = -1
    }
    x = x < 0 ? w : x + META_GAP_X + w
    row = Math.max(row, item.height)
  }
  return height + row
}

/** The most lines a card shows of a title (views/kanbanCards.tsx clamps
    titles with line-clamp-4). */
const TITLE_LINES_MAX = 4

/** How wide `text` draws in a title, in pixels. */
const titleWidth = (text: string) => {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    width += code >= 32 && code < 127 ? TITLE_GLYPH_PX[code - 32] : TITLE_GLYPH_OTHER_PX
  }
  return width * TITLE_GLYPH_SCALE
}
const SPACE_PX = TITLE_GLYPH_PX[0] * TITLE_GLYPH_SCALE

/** The lines `title` takes in `width` pixels, its words wrapped as the
    browser does and a word wider than a line broken (break-words), at
    most the four a card shows. */
function titleLines(title: string, width: number) {
  const room = Math.max(1, width)
  let lines = 1
  let x = 0
  for (const word of title.split(' ')) {
    let w = titleWidth(word)
    if (x > 0 && x + SPACE_PX + w > room) {
      lines++
      x = 0
    }
    while (w > room) {
      lines++
      w -= room
    }
    x = x > 0 ? x + SPACE_PX + w : w
    if (lines >= TITLE_LINES_MAX) return TITLE_LINES_MAX
  }
  return lines
}

/** The height in pixels a card of `group` takes `cardWidth` pixels wide,
    for a card that has not rendered yet. `banner` says whether a task row
    shows the delay banner, `placed` whether a heading shows its place line,
    and `meta` what a task row's meta line holds. It never falls for a
    longer title, a banner, more rows, more meta or a narrower card. */
export function estimateCardHeight<T extends BoardCellIssue & { title: string }>(
  group: BoardCellGroup<T>,
  cardWidth: number,
  {
    banner,
    placed,
    meta,
  }: {
    banner: (issue: T) => boolean
    placed: (issue: T) => boolean
    meta: (issue: T) => readonly MetaItem[]
  },
) {
  const heading = (issue: T) =>
    2 * ROW_PAD +
    PARENT_LINE * titleLines(issue.title, cardWidth - PARENT_CHROME_PX) +
    PARENT_META +
    (placed(issue) ? PLACE_LINE : 0)
  const task = (issue: T, chrome: number) =>
    (banner(issue) ? BANNER : 0) +
    2 * ROW_PAD +
    TITLE_LINE * titleLines(issue.title, cardWidth - chrome) +
    metaHeight(meta(issue), Math.max(1, cardWidth - chrome))
  let height = CARD_BORDER
  for (const ancestor of group.ancestors) height += heading(ancestor)
  if (group.parent) {
    height += heading(group.parent)
    // the children's bottom padding and the rule between two children
    if (group.issues.length) height += ROW_PAD + group.issues.length - 1
  }
  const chrome = group.parent ? CHILD_CHROME_PX : TASK_CHROME_PX
  for (const issue of group.issues) height += task(issue, chrome)
  return Math.ceil(height)
}

/** A Board at or under this many cards renders them all at once, as it
    always has. Every demo and smoke Board is under it. */
export const SYNC_LIMIT = 300

/* Lane geometry for eagerCounts, measured with the card constants above:
   an assignee lane's heading is 46px (a project lane's 50px, so the walk
   errs toward more cards), a cell's top padding 8px, and the lane's foot
   24px with the 8px --panel-gap after it. A side-board's heading is 50px
   and each status takes 25.4px for its row and 16px of cell padding. */
const LANE_HEAD_PX = 46
const CELL_TOP_PX = 8
const LANE_END_PX = 24 + 8
const SIDE_HEAD_PX = 50
const SIDE_STATUS_PX = 25.4 + 16
const SIDE_PITCH_PX = 248 + 8
const SIDE_START_PX = 20

/** How many cards each cell of the swimlane or pooled Board mounts in its
    first render: the cells' cards that fit in `budgetPx` from the top,
    lane by lane, counting each card at its least height. `lanes` gives
    each lane's heading and its cells' card counts. */
export function eagerCounts(lanes: { headed: boolean; cells: number[] }[], budgetPx: number) {
  let remaining = budgetPx
  return lanes.map(({ headed, cells }) => {
    if (remaining <= 0) return cells.map(() => 0)
    if (headed) remaining -= LANE_HEAD_PX
    const room = Math.max(0, remaining - CELL_TOP_PX)
    const counts = cells.map((count) => Math.min(count, Math.floor(room / MIN_CARD_PITCH)))
    remaining -= CELL_TOP_PX + Math.max(0, ...counts) * MIN_CARD_PITCH + LANE_END_PX
    return counts
  })
}

/** eagerCounts for side-by-side boards: each board walks its own statuses
    from the top, and a board that starts beyond `viewWidth` mounts none. */
export function sideEagerCounts(boards: number[][], budgetPx: number, viewWidth: number) {
  return boards.map((cells, index) => {
    if (SIDE_START_PX + index * SIDE_PITCH_PX >= viewWidth) return cells.map(() => 0)
    let remaining = budgetPx - SIDE_HEAD_PX
    return cells.map((count) => {
      remaining -= SIDE_STATUS_PX
      const eager = Math.min(count, Math.floor(Math.max(0, remaining) / MIN_CARD_PITCH))
      remaining -= eager * MIN_CARD_PITCH
      return eager
    })
  })
}
