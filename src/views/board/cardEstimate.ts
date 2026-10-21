import {
  type BoardCellGroup,
  estimateCardHeight,
  META_ICON_PX,
  META_TEXT_LINE,
  type MetaItem,
} from '@/lib/boardGroups'
import { dateFormatInUse } from '@/lib/dates'
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

/* The meta line's text, measured like the card constants (boardGroups):
   the mono hours and date take 7px a character, the place's sans text at
   most 6.1px (5.8px on average), and a due date its 11px calendar and a
   4px gap before the date. */
const MONO_CHAR_PX = 7
const SANS_CHAR_PX = 6
const ICON: MetaItem = { width: META_ICON_PX, height: META_ICON_PX }
const text = (width: number): MetaItem => ({ width, height: META_TEXT_LINE })

/** What a task row's meta line holds (kanbanCards TaskRow), in its order. */
function metaOf(it: IssueVM, place: ProjectPlace | null) {
  const items: MetaItem[] = []
  if (P.PRIORITIES[it.priority]) items.push(ICON)
  const remaining = P.remainingOf(it)
  if (remaining != null)
    items.push(text(MONO_CHAR_PX * `${it.children.length ? 'Σ ' : ''}${remaining}h`.length))
  if (place) items.push(text(SANS_CHAR_PX * P.placeLabel(place).length))
  if (it.due) items.push(text(META_ICON_PX + 4 + MONO_CHAR_PX * P.fmtISO(it.due).length))
  if (!P.user(it.owner)) items.push(text(SANS_CHAR_PX * 'Unassigned'.length))
  return items
}

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
    meta: (it) => metaOf(it, place(it)),
  })
}

/** estimateBoardCard, remembered per card of each cell while its tasks
    (the same objects), its width, the layout `kind` and the store's
    projects stay the same. A Board renders again on every store change and
    sizes every waiting card, so it works out only the cards that changed. A
    task gets a new object when its title or delay changes; whether it shows
    a delay banner or a place line also follows its project's delay setting
    and the projects' tree, which change P.projects, and the layout, and its
    due date's width follows the organization's date format. Nothing
    else of the store's moves an estimate. A parent's card repeats in each
    cell that holds one of its subtasks, with other tasks, so the cell is
    part of the key. */
export function createEstimateCache() {
  const known = new Map<
    string,
    {
      members: IssueVM[]
      width: number
      kind: string
      projects: typeof P.projects
      dates: string
      value: number
    }
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
      entry.projects === P.projects &&
      entry.dates === dateFormatInUse() &&
      entry.members.length === members.length &&
      entry.members.every((it, i) => it === members[i])
    )
      return entry.value
    const value = estimateBoardCard(group, place, cardWidth)
    known.set(key, {
      members,
      width: cardWidth,
      kind,
      projects: P.projects,
      dates: dateFormatInUse(),
      value,
    })
    return value
  }
}
