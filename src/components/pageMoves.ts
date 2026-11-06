/* The focus that follows Previous and Next on a list shown a page at a
   time, and the list's state for its data attributes, beside the line
   that ends the page (pageFold.tsx). Nothing here reads the store. */
import { useLayoutEffect, useRef } from 'react'
import { restoreFocus } from '../lib/focusVisibility'
import type { PagedPages } from '../lib/pagedList'

/** A page list's state for its `data-*-state` and aria-busy, which is
    loading, failed, refreshing after the tab showed again, or ok. */
export const pagesState = (page: Pick<PagedPages<unknown, unknown>, 'phase' | 'refreshing'>) =>
  page.phase === 'first'
    ? 'loading'
    : page.phase === 'failed'
      ? 'failed'
      : page.refreshing
        ? 'refreshing'
        : 'ok'

/** A page's Previous and Next, and its Retry, through useMoveFocus. */
export type MoveFocus = { move: (to: 'next' | 'previous') => void; retry: () => void }

/**
 * Focus for a page shown a page at a time. After a move that replaced the
 * page it goes to `first()`, the first row's button, else to `rest()`, the
 * search box, and after one that failed to its Retry. It moves only while
 * focus is on the page's fold or nowhere, so focus that moved on stays.
 * Answers the move to call for Previous and Next, and the page's Retry,
 * which for a failed move counts as that move again, since Retry leaves as
 * the move starts.
 */
export function useMoveFocus(
  page: PagedPages<unknown, unknown>,
  hook: string,
  first: () => HTMLElement | null,
  rest: () => HTMLElement | null,
): MoveFocus {
  const moved = useRef(false)
  const at = `${page.starts.length}:${String(page.starts[page.starts.length - 1])}`
  useLayoutEffect(() => {
    if (!moved.current || page.moving !== null) return
    moved.current = false
    const active = document.activeElement
    const free =
      !active ||
      active === document.body ||
      !active.isConnected ||
      !!active.closest(`[data-${hook}-end]`)
    if (!free) return
    if (page.failedMove !== null)
      restoreFocus(document.querySelector<HTMLElement>(`[data-${hook}-end] [data-page-retry]`))
    else restoreFocus(first() ?? rest())
  }, [at, page.moving, page.failedMove])
  return {
    move: (to) => {
      moved.current = true
      if (to === 'next') page.next()
      else page.previous()
    },
    retry: () => {
      if (page.failedMove !== null) moved.current = true
      page.retry()
    },
  }
}
