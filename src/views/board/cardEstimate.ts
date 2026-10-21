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
