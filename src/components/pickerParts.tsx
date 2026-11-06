/* The parts the server-read pickers share: a search box that clears on
   Escape before its popover closes, and the line that ends a picker's
   list (lib/pagedList.ts listEnd) in that picker's words (pickerWords.ts).
   A project's Settings page uses them for its Add team or user picker and
   its Lead field (components/ProjectAccessEditor.tsx), and the New project
   and New sub-project dialogs for their Project access, Project and Lead
   lists (panels/Modals.tsx, components/ProjectAccessSelect.tsx). Nothing
   here reads the store. */
import { Button } from '@/components/ui/button'
import { LIMITS } from '../../convex/lib/limits'
import { limitSentence } from '../lib/fieldLimits'
import type { ListEnd, PagedList } from '../lib/pagedList'
import { LimitedInput } from './LimitedField'
import type { ChoiceWords, HeldPick } from './pickerWords'
import { MenuItem } from './qivo'

/**
 * The end of a picker's list (lib/pagedList.ts listEnd) in `words`, as the
 * Reassign picker ends its own (panels/Modals.tsx ReassignChoiceList). It
 * says nothing is there only at the list's real end. In a `menu` Load more
 * is a menu row; in a list of checkboxes it is a button marked `moreHook`,
 * which stays focusable while it reads. `onMore` replaces the list's own
 * Load more, as a picker that moves focus to the first new row does.
 */
export function ChoiceEnd<A extends HeldPick, Row>({
  end,
  tooLong,
  list,
  words,
  menu = true,
  moreHook = 'data-picker-more',
  onMore,
}: {
  end: ListEnd
  tooLong: boolean
  list: PagedList<A, Row>
  words: ChoiceWords
  menu?: boolean
  moreHook?: string
  onMore?: () => void
}) {
  const held = end === 'held' ? list.answers[0] : (list.failure ?? undefined)
  const more = onMore ?? list.more
  if (tooLong)
    return <p className="px-2 py-1 text-sm text-text-2">{limitSentence(LIMITS.search)}</p>
  switch (end) {
    case 'loading':
      return (
        <p role="status" className="px-2 py-1 text-sm text-text-2">
          Loading…
        </p>
      )
    case 'held':
      return (
        <p role="status" data-picker-held="" className="px-2 py-1 text-sm text-text-2">
          {words.held(held)}
        </p>
      )
    case 'failed':
      return list.failure !== null ? (
        <p role="status" data-picker-held="" className="px-2 py-1 text-sm text-text-2">
          {words.held(held)}
        </p>
      ) : (
        <div role="alert" className="flex items-center gap-2 px-2 py-1 text-sm text-danger">
          {words.failed}
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm text-sm"
            onClick={() => list.retry()}
          >
            Try again
          </Button>
        </div>
      )
    case 'full':
      return <p className="px-2 py-1 text-sm text-text-2">Search to narrow the list.</p>
    case 'more':
      return (
        <>
          {list.stopped && <p className="px-2 py-1 text-sm text-text-2">{words.stopped}</p>}
          {menu ? (
            <MenuItem {...{ [moreHook]: '' }} disabled={list.phase === 'more'} onClick={more}>
              {list.phase === 'more' ? 'Loading…' : 'Load more'}
            </MenuItem>
          ) : (
            <Button
              type="button"
              variant="ghost"
              {...{ [moreHook]: '' }}
              aria-disabled={list.phase === 'more' || undefined}
              onClick={() => list.phase !== 'more' && more()}
              className="h-control-sm justify-start text-sm"
            >
              {list.phase === 'more' ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )
    case 'none':
      return <p className="px-2 py-1 text-sm text-text-2">{words.none}</p>
    case 'end':
      return list.rows.length === 0 ? (
        <p data-picker-empty="" className="px-2 py-1 text-sm text-text-2">
          {words.empty}
        </p>
      ) : null
    case 'partial':
      return null
  }
}

/** A picker's search box, which clears its text on Escape first; the
    popover closes on the Escape after that (escapeClearsFirst). `probe`
    is the data attribute that marks it. */
export function PickerSearch({
  text,
  onText,
  label,
  probe,
  placeholder = label,
}: {
  text: string
  onText: (text: string) => void
  label: string
  probe: string
  placeholder?: string
}) {
  return (
    <LimitedInput
      limit={LIMITS.search}
      aria-label={label}
      placeholder={placeholder}
      {...{ [probe]: '' }}
      value={text}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation()
          onText('')
        }
      }}
      className="h-control text-sm"
    />
  )
}
