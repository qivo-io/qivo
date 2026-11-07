/* One section of milestones the server answers, as the Milestones window
   (panels/Modals.tsx), the Overview (views/overview/OverviewMilestones.tsx)
   and the phone Roadmap agenda (views/MobileRoadmap.tsx) show it: its
   header (Past's disclosure), then, while open, its search box, the
   moved-on note with Show from the start, its rows, and what it says while
   loading, when it ends empty, when it stopped, failed or was refused, and
   Load more. The three share its states, marks and sentences
   (data-milestone-section, data-milestone-section-state,
   data-milestone-note, data-milestone-more and the rest), so a locator
   scopes a section by its view's root. What a section reads and shows is
   views/useMilestoneSection.ts with lib/milestoneSection.ts.

   On a phone width every control of the app is 44 px tall
   (styles/mobile.css --ctl-*), so its buttons and search box take that
   size from the same classes as on a desktop. */

import {
  type ReactNode,
  useEffect as useEffectS,
  useLayoutEffect as useLayoutEffectS,
  useRef as useRefS,
} from 'react'
import { Button } from '@/components/ui/button'
import { LIMITS } from '../../convex/lib/limits'
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import { SCROLL_ANCHORING } from '../lib/scrollAnchoring'
import { cn } from '../lib/utils'
import type { MilestoneSection } from '../views/useMilestoneSection'
import { LimitedInput } from './LimitedField'

/* The class of a section's notes, as the Overview's lists set theirs. */
const sectionNoteClass = 'flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2'

/** The reason of the refusal of a read whose projects need more reads than
    one request allows (convex/model/milestones.ts MILESTONE_READ_TOO_LARGE),
    whose note takes the view's hint. */
const READ_TOO_LARGE = 'milestone_read_too_large'

/** What a section's search box and empty line say, beyond the window's. */
export type SectionSentences = {
  /** the empty line of an Upcoming whose first answer says its projects
      hold no past milestone, "No milestones yet." unless given */
  noneYet?: string
}

/**
 * One section, Upcoming or Past: `header` (Past's disclosure), then, while
 * `open`, its search box where `searchable`, the moved-on note with Show
 * from the start, its rows (`children`, keyed by milestone, in a container
 * that stays so an editor in it keeps its place), what it says while
 * loading, when it ends empty, when it stopped, failed or was refused, and
 * Load more. Load more keeps focus while its read loads; where it leaves,
 * as the section ends or its read fails, focus it left nowhere goes to that
 * note's Retry, else to the section, and Show from the start and Retry
 * leave focus in the section. The empty line takes focus (tabIndex -1), so
 * a view's focus fallback can land on it. `hint` follows the too-many note
 * and the refusal of a read too large, as My view adds "Open a project to
 * see its milestones." When a section moves on and its first rows leave,
 * the browser's scroll anchoring keeps the rows the person reads in place,
 * and where it lacks that, as in Safari, the section moves the scroller
 * `scroller` names (the nearest ancestor it matches) by hand, measuring the
 * rows by their mark `rowMark`, as the Overview's lists do.
 */
export function MilestoneSectionPart({
  side,
  section,
  open,
  searchable,
  pastKnown = false,
  bodyId,
  header,
  scroller = '[data-modal-scroll]',
  rowMark = 'data-milestone-row',
  sentences = {},
  hint,
  className,
  rowsClassName,
  children,
}: {
  side: 'upcoming' | 'past'
  section: MilestoneSection
  open: boolean
  searchable: boolean
  /** Upcoming's first answer said the projects hold no past milestone */
  pastKnown?: boolean
  bodyId?: string
  header: ReactNode
  /** the selector of the scroller the rows sit in */
  scroller?: string
  /** the attribute each row carries its milestone's id in */
  rowMark?: string
  sentences?: SectionSentences
  /** what follows the too-many note and a read-too-large refusal */
  hint?: string
  className?: string
  /** the row list's spacing where the view's rows need their own, as the
      Overview's cards and the agenda's ruled rows do */
  rowsClassName?: string
  children: ReactNode[]
}) {
  const root = useRefS<HTMLElement>(null)
  const { view } = section
  /** `step` for a button that goes with its press, with focus on the
      section. */
  const inSection = (step: () => void) => () => {
    step()
    root.current?.focus()
  }
  useFocusWhenGone(
    open && view.more !== null,
    () => root.current?.querySelector<HTMLElement>('[data-milestone-note] button') ?? root.current,
  )
  // where the section moved on, the first row left on screen keeps its
  // place in the scroller, from where it stood before the commit. An open
  // editor is passed over for the next row, which moves by as much, since
  // an editor may stay at its last place or above the sections
  const first = view.rows[0]?.id
  const places = useRefS(new Map<string, number>())
  const lastFirst = useRefS(first)
  const scrolled = useRefS<number | null>(null)
  useEffectS(() => {
    const pane = root.current?.closest<HTMLElement>(scroller)
    if (SCROLL_ANCHORING || !pane) return
    const note = () => {
      scrolled.current = pane.scrollTop
    }
    pane.addEventListener('scroll', note, { passive: true })
    return () => pane.removeEventListener('scroll', note)
  }, [scroller])
  useLayoutEffectS(() => {
    const pane = root.current?.closest<HTMLElement>(scroller)
    if (SCROLL_ANCHORING || !root.current || !pane) return
    const top = pane.getBoundingClientRect().top - pane.scrollTop
    const measure = () => {
      const now = new Map<string, number>()
      for (const element of root.current?.querySelectorAll<HTMLElement>(`[${rowMark}]`) ?? [])
        now.set(element.getAttribute(rowMark) ?? '', element.getBoundingClientRect().top - top)
      return now
    }
    const now = measure()
    if (first !== lastFirst.current && first !== undefined && view.dropped) {
      // the first of the answer's milestones that showed here as a row
      // before and does now
      const anchor = view.rows.find((m) => places.current.has(m.id) && now.has(m.id))?.id
      const was = anchor === undefined ? undefined : places.current.get(anchor)
      const is = anchor === undefined ? undefined : now.get(anchor)
      if (was !== undefined && is !== undefined && was !== is)
        pane.scrollTop = (scrolled.current ?? pane.scrollTop) + is - was
    }
    lastFirst.current = first
    places.current = measure()
    scrolled.current = pane.scrollTop
  })
  const searched = section.settled !== ''
  const empty =
    side === 'upcoming'
      ? searched
        ? 'No upcoming milestones match.'
        : pastKnown
          ? (sentences.noneYet ?? 'No milestones yet.')
          : 'No upcoming milestones.'
      : searched
        ? 'No past milestones match.'
        : 'No past milestones.'
  const note = view.note
  const hinted =
    hint &&
    (note?.kind === 'too_many' || (note?.kind === 'refused' && note.reason === READ_TOO_LARGE))
      ? ` ${hint}`
      : ''
  const retry = note?.kind === 'failed' && (
    <Button
      type="button"
      variant="ghost"
      className="h-control-sm text-sm"
      onClick={inSection(section.retry)}
    >
      Retry
    </Button>
  )
  return (
    <section
      ref={root}
      tabIndex={-1}
      data-milestone-section={side}
      data-milestone-section-state={open ? view.state : undefined}
      aria-busy={(open && (view.state === 'refreshing' || view.more === 'loading')) || undefined}
      aria-label={side === 'upcoming' ? 'Upcoming milestones' : 'Past milestones'}
      className={cn('flex flex-col', className)}
    >
      {header}
      <div id={bodyId} className="flex flex-col gap-2">
        {open && searchable && (
          <LimitedInput
            limit={LIMITS.search}
            data-milestone-search
            aria-label={
              side === 'upcoming' ? 'Search upcoming milestones' : 'Search past milestones'
            }
            placeholder="Search"
            value={section.text}
            onChange={(e) => section.setText(e.target.value)}
            className="h-control-sm w-full bg-surface-1 font-sans text-sm"
          />
        )}
        {open && view.dropped && (
          <div data-milestone-dropped className={sectionNoteClass}>
            {side === 'upcoming'
              ? 'Earlier milestones are not shown.'
              : 'More recent milestones are not shown.'}
            <Button
              type="button"
              variant="ghost"
              data-milestone-from-start
              className="h-control-sm text-sm"
              onClick={inSection(section.fromStart)}
            >
              Show from the start
            </Button>
          </div>
        )}
        <div data-milestone-rows className={cn('flex flex-col gap-1', rowsClassName)}>
          {children}
        </div>
        {open && view.state === 'loading' && (
          <div
            role="status"
            data-milestone-note="loading"
            className="px-0.5 py-1 text-sm text-text-3 italic"
          >
            {side === 'upcoming' ? 'Loading milestones…' : 'Loading past milestones…'}
          </div>
        )}
        {open && view.empty && !children.length && (
          <div
            data-milestone-note="empty"
            tabIndex={-1}
            className="px-0.5 py-1 text-sm text-text-3 italic"
          >
            {empty}
          </div>
        )}
        {open && view.stopped !== null && view.answered && (
          <div data-milestone-note="stopped" className="px-0.5 py-1 text-sm text-text-3 italic">
            Qivo checked part of the list. Load more continues.
          </div>
        )}
        {open && note && (
          <div
            role="alert"
            data-milestone-note={
              note.kind === 'failed' && note.more
                ? 'more-failed'
                : note.kind === 'too_many'
                  ? 'too-many'
                  : note.kind
            }
            className={sectionNoteClass}
          >
            {note.kind === 'too_many'
              ? `${limitSentence(LIMITS.milestoneProjects)}${hinted}`
              : note.kind === 'refused'
                ? `${note.sentence}${hinted}`
                : note.more
                  ? "Couldn't load more milestones."
                  : view.answered
                    ? "Couldn't load the latest milestones."
                    : "Couldn't load milestones."}
            {retry}
          </div>
        )}
        {open && view.more !== null && (
          // while its read loads it stays, with no action, so keyboard focus
          // stays on it
          <Button
            type="button"
            variant="outline"
            data-milestone-more
            aria-disabled={view.more === 'loading' || undefined}
            aria-busy={view.more === 'loading' || undefined}
            className={cn('self-start', view.more === 'loading' && 'pointer-events-none italic')}
            onClick={() => {
              if (view.more === 'ready') section.more()
            }}
          >
            {view.more === 'loading' ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </section>
  )
}
