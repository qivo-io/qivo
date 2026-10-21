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

/** estimateBoardCard, remembered per card while its tasks (the same
    objects), its width, the store's context and the layout `kind` stay the
    same. A Board renders again on every store change and sizes every
    waiting card, so it works out only the cards that changed. */
export function createEstimateCache() {
  const known = new Map<
    string,
    { members: IssueVM[]; width: number; context: unknown; kind: string; value: number }
  >()
  return (
    group: BoardCellGroup<IssueVM>,
    place: (issue: IssueVM) => ProjectPlace | null,
    cardWidth: number,
    kind: string,
  ) => {
    const members = [...group.ancestors, ...(group.parent ? [group.parent] : []), ...group.issues]
    const entry = known.get(group.key)
    if (
      entry &&
      entry.width === cardWidth &&
      entry.context === P.contextVersion &&
      entry.kind === kind &&
      entry.members.length === members.length &&
      entry.members.every((it, i) => it === members[i])
    )
      return entry.value
    const value = estimateBoardCard(group, place, cardWidth)
    known.set(group.key, { members, width: cardWidth, context: P.contextVersion, kind, value })
    return value
  }
}
