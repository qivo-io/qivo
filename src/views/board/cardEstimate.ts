import { type BoardCellGroup, estimateCardHeight } from '@/lib/boardGroups'
import { type IssueVM, P, type ProjectPlace } from '@/store/planner'

/** The place the card's parent heading shows. Repeated child project
    labels already name this shared project, so the parent keeps its label
    only when it has no local children or belongs to another project. */
export const parentPlaceOf = (
  group: BoardCellGroup<IssueVM>,
  place: (issue: IssueVM) => ProjectPlace | null,
) =>
  group.parent &&
  !(group.issues.length > 0 && group.issues.every((it) => it.project === group.parent.project))
    ? place(group.parent)
    : null

/** The height of `group`'s card `cardWidth` pixels wide before it renders,
    with the delay banners and place lines it will show. */
export function estimateBoardCard(
  group: BoardCellGroup<IssueVM>,
  place: (issue: IssueVM) => ProjectPlace | null,
  cardWidth: number,
) {
  return estimateCardHeight(group, cardWidth, {
    banner: (it) => !!P.delayColor(it),
    placed: (it) => !!(it === group.parent ? parentPlaceOf(group, place) : place(it)),
  })
}

/** estimateBoardCard, remembered per card of each cell while its tasks
    (the same objects), its width and the layout `kind` stay the same. A
    Board renders again on every store change and sizes every waiting card,
    so it works out only the cards that changed. A task gets a new object
    when its title or delay changes, and whether a heading shows its place
    follows the layout, so nothing else of the store's moves an estimate. A
    parent's card repeats in each cell that holds one of its subtasks, with
    other tasks, so the cell is part of the key. */
export function createEstimateCache() {
  const known = new Map<
    string,
    { members: IssueVM[]; width: number; kind: string; value: number }
  >()
  return (
    group: BoardCellGroup<IssueVM>,
    place: (issue: IssueVM) => ProjectPlace | null,
    cardWidth: number,
    kind: string,
    cell: string,
  ) => {
    const members = [...group.ancestors, ...(group.parent ? [group.parent] : []), ...group.issues]
    const key = `${cell} ${group.key}`
    const entry = known.get(key)
    if (
      entry &&
      entry.width === cardWidth &&
      entry.kind === kind &&
      entry.members.length === members.length &&
      entry.members.every((it, i) => it === members[i])
    )
      return entry.value
    const value = estimateBoardCard(group, place, cardWidth)
    known.set(key, { members, width: cardWidth, kind, value })
    return value
  }
}
