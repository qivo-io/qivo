/* Load more for an open list read a batch at a time (lib/pagedList.ts
   usePagedList), with its focus rule and the marker that loads more as the
   list's end scrolls into view. Settings' sub-project lists
   (panels/settings/ProjectLists.tsx and ProjectSettings.tsx), the All
   projects directory's expanded list (components/ProjectDirectory.tsx)
   and the sidebar's project tree and its expanded list
   (components/SidebarProjects.tsx) share it. Nothing here reads the
   store. */
import { useRef } from 'react'
import { useFocusWhenGone } from './focusWhenGone'
import { type ListEnd, type PagedList, useMoreOnScroll } from './pagedList'

/**
 * Load more for an open list: keeps focus on the button while it reads,
 * and once Load more goes moves it to the first new row's control
 * (`rowControl`), else `rest()`, as Settings › Labels does. Answers the
 * press and the marker ref that loads more as the list's end scrolls into
 * view (lib/pagedList.ts useMoreOnScroll).
 */
export function useLoadMore<A, Row extends { id: string }>(
  list: PagedList<A, Row>,
  end: ListEnd,
  rowControl: (id: string) => HTMLElement | null,
  rest: () => HTMLElement | null,
) {
  const from = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = from.current === null ? undefined : list.rows[from.current]
    return (row ? rowControl(row.id) : null) ?? rest()
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }
  const marker = useMoreOnScroll(more, end === 'more' && list.phase !== 'more')
  return { more, marker }
}
