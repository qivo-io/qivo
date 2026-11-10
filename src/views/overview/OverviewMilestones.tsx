/* The Overview's Milestones section (views/Overview.tsx): Upcoming, then a
   collapsed Past, from the server (views/useScopeMilestones.ts), through the
   section part the Milestones window and the phone agenda share
   (components/MilestoneSectionPart.tsx). The rows come in the server's
   order and are never sorted, cut or merged here. The page reads the
   sections itself, above its decision whether a note is the whole page,
   and passes them in. */

import { type Ref, useId } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { relativeWeek, weekToISO } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { grouped, LIMITS } from '../../../convex/lib/limits'
import { MilestoneSectionPart } from '../../components/MilestoneSectionPart'
import { Icon } from '../../components/qivo'
import { type MilestoneVM, P } from '../../store/planner'
import type { ScopeMilestones } from '../useScopeMilestones'

/** What My view's notes add where a read needs more reads than one
    request allows, as My view cannot choose fewer projects. */
export const MINE_MILESTONES_HINT = 'Open a project to see its milestones.'

/** My view's note where the person's own work lies in more top-level
    projects than one read names (LIMITS.milestoneProjects), in place of
    the limit's sentence, which asks to choose fewer projects, something My
    view cannot do. */
export const MINE_TOO_MANY = `Your work spans more than ${grouped(LIMITS.milestoneProjects.max)} projects, so their milestones are not listed here. ${MINE_MILESTONES_HINT}`

/** One milestone of the Overview's list: the diamond, the project in My
    view, the name, the relative week and the date. The next milestone is
    emphasised; a past one is dimmed, as the window's are. */
export function OvMilestoneRow({
  m,
  next,
  past = false,
  owner,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  past?: boolean
  owner?: string | null
  /** opens the milestone, naming the project it sits on */
  onEdit: (id: string, project: string) => void
}) {
  const delta = relativeWeek(m.week)
  return (
    <Button
      type="button"
      onClick={() => onEdit(m.id, m.project)}
      title={`Edit “${m.name}”${owner ? `, ${owner}` : ''}`}
      data-overview-milestone={m.id}
      data-next={next ? '' : undefined}
      data-past={past ? '' : undefined}
      className={cn(
        'overview-milestone min-h-16 w-full justify-start gap-3 whitespace-normal rounded-md p-3 text-left font-sans',
        next && 'border-primary bg-primary-soft hover:border-primary hover:bg-primary-soft',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-[9px] shrink-0 rotate-45 rounded-[var(--r-2xs)] bg-[var(--milestone)]',
          past && 'opacity-45',
        )}
      />
      <span className="overview-milestone-text flex min-w-0 flex-1 flex-col gap-1">
        {/* Project context stays with the name instead of competing with the dates. */}
        {owner && <span className="break-words text-xs text-text-3">{owner}</span>}
        <span
          className={cn(
            'break-words text-base leading-snug',
            next ? 'font-semibold' : 'font-medium',
            past && 'text-text-2',
          )}
        >
          {m.name}
        </span>
      </span>
      <span className="overview-milestone-date flex shrink-0 flex-col items-end gap-1">
        <Badge variant="secondary" className="bg-hover font-medium text-text-1">
          {delta}
        </Badge>
        <time
          dateTime={weekToISO(m.week)}
          className="whitespace-nowrap font-mono text-xs text-text-2"
        >
          {P.weekLabel(m.week)}
        </time>
      </span>
    </Button>
  )
}

/** A section's header with its count, shown where its answer is whole. */
function SectionHeader({ label, count }: { label: string; count: number | null }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-2">
      {label}
      {count !== null && (
        <span data-milestone-count className="font-normal text-text-3">
          {count}
        </span>
      )}
    </div>
  )
}

/**
 * The Overview's milestone sections in their root (data-overview-milestones):
 * Upcoming with no search, the next milestone's row emphasised, and Past's
 * disclosure, collapsed until the person opens it, with its search by the
 * window's rule. In My view each row names its project, the too-many note
 * says the person's work spans more projects than one read names
 * (MINE_TOO_MANY), and a read-too-large note adds that a project shows its
 * milestones. The empty
 * line of an Upcoming whose projects hold no milestone at all says "No
 * milestones yet." in a project, with the + where the person may add one,
 * and "No milestones in any of your projects yet." in My view.
 */
export function OverviewMilestones({
  rootRef,
  ms,
  mine,
  canAdd,
  onEdit,
}: {
  /** the root, for the page's focus fallback */
  rootRef?: Ref<HTMLDivElement>
  ms: ScopeMilestones
  mine: boolean
  /** whether the section's + shows */
  canAdd: boolean
  onEdit: (id: string, project: string) => void
}) {
  const pastBodyId = useId()
  const noneYet = mine
    ? 'No milestones in any of your projects yet.'
    : canAdd
      ? 'No milestones yet. Add one with the + button.'
      : 'No milestones yet.'
  const hint = mine ? MINE_MILESTONES_HINT : undefined
  const tooMany = mine ? MINE_TOO_MANY : undefined
  const label = (m: MilestoneVM) => (mine ? P.projectLabelOf(m.project) : null)
  const { upcoming, past } = ms
  return (
    <div ref={rootRef} data-overview-milestones className="flex flex-col gap-4">
      <MilestoneSectionPart
        side="upcoming"
        section={upcoming}
        open
        searchable={false}
        pastKnown={upcoming.view.past === false}
        header={<SectionHeader label="Upcoming" count={upcoming.view.count} />}
        scroller="[data-overview-root]"
        rowMark="data-overview-milestone"
        rowsClassName="gap-2"
        sentences={{ noneYet, tooMany }}
        hint={hint}
      >
        {upcoming.view.rows.map((m) => (
          <OvMilestoneRow
            key={m.id}
            m={m}
            next={m.id === ms.nextId}
            owner={label(m)}
            onEdit={onEdit}
          />
        ))}
      </MilestoneSectionPart>
      {ms.showPast && (
        <MilestoneSectionPart
          side="past"
          section={past}
          open={ms.pastOpen}
          searchable={ms.pastSearchable}
          bodyId={pastBodyId}
          scroller="[data-overview-root]"
          rowMark="data-overview-milestone"
          rowsClassName="gap-2"
          sentences={{ tooMany }}
          hint={hint}
          header={
            <Button
              type="button"
              variant="ghost"
              data-milestone-past-toggle
              aria-expanded={ms.pastOpen}
              aria-controls={pastBodyId}
              onClick={() => ms.setPastOpen(!ms.pastOpen)}
              className="mb-2 -ml-2 gap-1.5 self-start px-2 text-sm font-semibold text-text-2"
            >
              <Icon
                name={ms.pastOpen ? 'chevronDown' : 'chevronRight'}
                size={14}
                color="var(--text-2)"
              />
              Past
              {ms.pastOpen && past.view.count !== null && (
                <span data-milestone-count className="font-normal text-text-3">
                  {past.view.count}
                </span>
              )}
            </Button>
          }
        >
          {ms.pastOpen
            ? past.view.rows.map((m) => (
                <OvMilestoneRow
                  key={m.id}
                  m={m}
                  next={false}
                  past
                  owner={label(m)}
                  onEdit={onEdit}
                />
              ))
            : []}
        </MilestoneSectionPart>
      )}
    </div>
  )
}
