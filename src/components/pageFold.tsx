/* The line that ends a list shown a page at a time (lib/pagedList.ts
   usePagedPages and pageEnd), with Previous and Next, and the focus that
   follows them. Settings › Projects and Archived projects
   (panels/settings/ProjectLists.tsx), Settings › Users
   (panels/settings/UsersSettings.tsx) and Settings › Projects › Deleted
   items (panels/settings/DeletedItems.tsx) share them, each with its own
   data attributes and words; a later page shown a page at a time takes
   them from here, with the focus and state of pageMoves.ts. Nothing here
   reads the store. */
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../convex/lib/limits'
import { limitSentence } from '../lib/fieldLimits'
import type { PagedPages, PageEnd } from '../lib/pagedList'
import type { MoveFocus } from './pageMoves'

/** The sentences of one paged page (PageFold). `stopped` and
    `stoppedEmpty` say that a page whose read stopped early goes on with
    Next, with rows and without; `stuck` that a read stopped without
    moving, beside Retry. */
export type PageWords = {
  loading: string
  failed: string
  none: string
  empty: string
  nomore: string
  stopped?: string
  stoppedEmpty?: string
  stuck?: string
}

/** What an answer with no rows says (`held`), and whether Retry shows
    beside it. */
export type HeldLine = { line: string; retry: boolean }

/**
 * The line that ends a page (lib/pagedList.ts pageEnd), with Previous and
 * Next. `hook` names its data attributes. A move that runs keeps its
 * button with static text and no action, so keyboard focus stays on it; a
 * move that failed keeps the page, says so with Retry, and keeps the other
 * move beside it. `held` words an answer with no rows. `focus` runs the
 * moves and Retry, so focus follows them (useMoveFocus). `tooLong` says
 * the search is past its limit, which asks nothing new.
 */
export function PageFold<A>({
  page,
  end,
  hook,
  words,
  held,
  tooLong,
  focus,
}: {
  page: PagedPages<A, unknown>
  end: PageEnd
  hook: string
  words: PageWords
  held: (answer: A | null) => HeldLine
  tooLong: boolean
  focus: MoveFocus
}) {
  const running = page.moving
  const button = (to: 'next' | 'previous') => (
    <Button
      key={to}
      type="button"
      variant="quiet"
      size="sm"
      {...{ [`data-${hook}-${to}`]: '' }}
      className={running === to ? 'pointer-events-none italic' : 'text-text-1'}
      aria-disabled={running !== null || undefined}
      onClick={() => running === null && focus.move(to)}
    >
      {running === to ? 'Loading…' : to === 'next' ? 'Next' : 'Previous'}
    </Button>
  )
  const retry = (
    <Button
      key="retry"
      type="button"
      variant="ghost"
      className="h-control-sm text-sm"
      data-page-retry=""
      onClick={focus.retry}
    >
      {end === 'failed' && page.failedMove === null ? 'Try again' : 'Retry'}
    </Button>
  )
  const moves = (failed: 'next' | 'previous' | null) => (
    <>
      {page.hasPrevious && failed !== 'previous' && button('previous')}
      {page.hasNext && failed !== 'next' && button('next')}
    </>
  )
  let line: ReactNode = null
  let alert = false
  let action: ReactNode = null
  if (tooLong) line = limitSentence(LIMITS.search)
  else if (page.failedMove !== null) {
    alert = true
    line = `Couldn't load the ${page.failedMove} page.`
    action = retry
  } else
    switch (end) {
      case 'loading':
        line = words.loading
        break
      case 'held': {
        const said = held(page.answer)
        line = said.line
        action = said.retry ? retry : null
        break
      }
      case 'failed':
        alert = true
        line = words.failed
        action = retry
        break
      case 'stuck':
        line = words.stuck ?? 'Qivo could not check part of the list.'
        action = retry
        break
      case 'more':
        if (page.stopped)
          line =
            page.rows.length === 0
              ? (words.stoppedEmpty ??
                'Qivo checked part of the list and found nothing there yet. Next continues.')
              : (words.stopped ?? 'Qivo checked part of the list. Next continues.')
        break
      case 'none':
        line = words.none
        break
      case 'empty':
        line = words.empty
        break
      case 'nomore':
        line = words.nomore
        break
      case 'end':
        break
    }
  const shownMoves = tooLong || end === 'loading' ? null : moves(page.failedMove)
  if (line === null && action === null && !page.hasPrevious && !page.hasNext) return null
  return (
    <div
      {...{ [`data-${hook}-end`]: tooLong ? 'too_long' : end }}
      role={alert ? 'alert' : end === 'loading' ? 'status' : undefined}
      className={cn(
        'settings-page-fold flex flex-wrap items-center gap-2 pt-2 text-sm',
        alert ? 'text-danger' : 'text-text-2',
      )}
    >
      {line !== null && <span>{line}</span>}
      {action}
      {shownMoves}
    </div>
  )
}
