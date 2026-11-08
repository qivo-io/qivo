/* The project chooser: what the main pane shows in place of the Overview,
   the Board or the Roadmap while no project is chosen (App.tsx startup).
   App renders it outside the kept pages, so it is never one of them, and
   keeps the desktop's top bar up over it, so the Inbox tab and the view
   pills stay in reach; a view pill changes the view a pick opens.

   - `checking`: one projectNav.resolve read checks the project App opens,
     the remembered one or the one an address names, and the chooser says
     "Opening <name>…". No view mounts, and no list reads, until it
     answered.
   - `retry`: the check could not finish, its refusal's sentence or a
     failed read's, with Retry, which checks again. It never shows the
     list or another project.
   - `choose` and `lost`: the shared picker's panel
     (components/ProjectPicker.tsx), every organization's projects from
     the navigation reads, favorites first, one pick and no All projects
     row, under a heading and a line that says where the pick opens; `lost`
     adds App's note of why no project opened. A press opens the row by
     the lists' open rule (components/projectNavRows.tsx useNavOpen),
     whose sentences take the note's place. A new search in the field
     drops a pick that waits, with its sentence, and so does any
     navigation the person makes. The panel's list is live, so a project
     shared meanwhile moves in, and nothing opens by itself.
   - `empty`: once the browse list ended confirmed empty, the panel gives
     way to the empty state, which says the person has no active projects
     and who can give access, with New project where they may create one.
   - `purpose`, App's line for why the chooser shows, as after a Team sync
     person jump ("Choose a project to see Leo's tasks on the Board."),
     takes the place of the line that says where the pick opens, under the
     chooser's own heading, and is announced politely as it comes.

   The page keeps one h1, the top bar's or the phone header's, so the
   chooser's heading is an h2. Its search field takes focus only on a
   desktop where focus is nowhere as it mounts, never on a phone, where the
   keyboard would open over the page. */

import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { announce } from '../lib/announce'
import { cn } from '../lib/utils'
import { NoProjects } from './NoProjects'
import { ProjectPickerPanel } from './ProjectPicker'
import { noNavProjectsHint, useNavOpen } from './projectNavRows'
import { Icon } from './qivo'
import { Button } from './ui/button'

/** What App asks the chooser to show: a check on its way with its line,
    a check that could not finish with its sentence, or the list, with the
    note that says why no project opened, if one does. */
export type ChooserShows =
  | { kind: 'checking'; line: string }
  | { kind: 'retry'; line: string }
  | { kind: 'choose'; note: string | null }

/** The views a pick opens on, as the line names them. */
const VIEW_NAMES: Record<string, string> = {
  overview: 'Overview',
  kanban: 'Board',
  roadmap: 'Roadmap',
}

/* Whether focus is nowhere: on the page itself, or on an element that has
   left it. */
const focusIsNowhere = () => {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/** Calls `onShown` with true as its content mounts and false as it goes. */
function Shown({ onShown, children }: { onShown: (shown: boolean) => void; children: ReactNode }) {
  useLayoutEffect(() => {
    onShown(true)
    return () => onShown(false)
  }, [onShown])
  return children
}

/**
 * The chooser in the state `shows`, on the rules in the module header.
 * `view` is the view a pick opens on, `onOpen` opens a project the
 * workspace holds (App's navScope, or on a phone actions.openProject,
 * which opens its task list), `onRetry` checks again and `onNewProject`
 * opens New project. `purpose`, when given, says why the chooser shows.
 */
export function ProjectChooser({
  shows,
  view,
  mobile,
  onOpen,
  onRetry,
  onNewProject,
  purpose = null,
}: {
  shows: ChooserShows
  view: string
  mobile: boolean
  onOpen: (id: string) => void
  onRetry: () => void
  onNewProject: () => void
  purpose?: string | null
}) {
  // the open rule's line for a pick, which takes the note's place
  const [said, setSaid] = useState<string | null>(null)
  const nav = useNavOpen(onOpen, setSaid)
  const [empty, setEmpty] = useState(false)
  // the field takes focus only where nothing else holds it, on a desktop
  const [focusField] = useState(() => !mobile && focusIsNowhere())
  // the purpose is said once as it comes, through the page's announcer
  useEffect(() => {
    if (purpose) announce(purpose)
  }, [purpose])
  // the empty state brings its own panel
  const frame = (state: string, children: ReactNode) => (
    <div
      data-project-chooser=""
      data-project-chooser-state={state}
      className={cn(
        'animate-in fade-in slide-in-from-bottom-1 flex min-h-0 flex-1 flex-col overflow-hidden',
        mobile ? 'px-4 pb-6' : 'px-5 pb-5',
      )}
    >
      <div
        className={cn(
          'mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col',
          state !== 'empty' && 'project-chooser gap-3 p-4',
        )}
      >
        {children}
      </div>
    </div>
  )
  if (shows.kind === 'checking')
    return frame(
      'checking',
      <p role="status" data-project-chooser-line="" className="m-auto text-base text-text-2">
        {shows.line}
      </p>,
    )
  if (shows.kind === 'retry')
    return frame(
      'retry',
      <div className="m-auto flex flex-col items-center gap-3 text-center">
        <p role="status" data-project-chooser-line="" className="text-base text-text-2">
          {shows.line}
        </p>
        <Button type="button" data-project-chooser-retry="" onClick={onRetry}>
          <Icon name="rotateCcw" size={16} />
          Retry
        </Button>
      </div>,
    )
  const note = said ?? shows.note
  const where = mobile
    ? 'The project you choose opens in its task list.'
    : `The project you choose opens on the ${VIEW_NAMES[view] ?? 'Overview'}.`
  return frame(
    empty ? 'empty' : shows.note === null ? 'choose' : 'lost',
    <>
      <div className="flex flex-col gap-1 px-1">
        {!empty && (
          <>
            <h2 data-project-chooser-title="" className="text-md font-semibold">
              Choose a project
            </h2>
            {purpose ? (
              <p data-project-chooser-purpose="" className="text-base text-text-1">
                {purpose}
              </p>
            ) : (
              <p className="text-base text-text-2">{where}</p>
            )}
          </>
        )}
        <p
          role="status"
          data-project-chooser-note=""
          className={cn('text-base text-text-1', !note && 'sr-only')}
        >
          {note}
        </p>
      </div>
      <ProjectPickerPanel
        pick={null}
        onPick={(pick) => {
          const row = pick?.kind === 'projects' ? pick.projects[0] : undefined
          if (row) nav.open(row)
        }}
        // a new search drops a pick that waits, and its sentence
        onSearch={() => {
          nav.cancel()
          setSaid(null)
        }}
        rules={{ many: false, oneOrg: false, all: 'none' }}
        label="Search your projects"
        autoFocus={focusField}
        fill
        whenEmpty={
          <Shown onShown={setEmpty}>
            <NoProjects
              icon="layers"
              title="Nothing to show yet"
              hint={noNavProjectsHint()}
              onNewProject={onNewProject}
            />
          </Shown>
        }
      />
    </>,
  )
}
