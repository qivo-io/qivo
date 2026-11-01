/* What the Board says in place of its columns or its phone sections when it
   cannot show a selection's tasks (useBoardView): the chooser of All
   projects, the narrowing message of a selection past the Board's limits,
   a Board that is not available or did not load, a text filter past its
   limit and a wait too large to show tasks during. Each is an empty state
   (data-empty-state), where focus goes once a task window closes over it
   (lib/taskFocus.ts). The filter row stays usable beside every one. */

import type { ReactNode } from 'react'
import { Icon, ProjectName } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { LIMITS } from '../../../convex/lib/limits'
import { NoProjects } from '../../components/NoProjects'
import { limitSentence } from '../../lib/fieldLimits'
import type { ProjectVM, ScopeInfo } from '../../store/planner'
import type { BoardVariant } from './boardArgs'
import type { BoardView } from './useBoardView'

type Actions = Record<string, (...args: unknown[]) => void>

/** What the Board says for `view`'s state, or null when it shows tasks. */
export function BoardNote({
  view,
  info,
  actions,
  variant,
}: {
  view: BoardView
  info: ScopeInfo
  actions: Actions
  variant: BoardVariant
}) {
  const phone = variant === 'phone'
  // a project's Board, by the way each face opens one
  const open = (id: string) => (phone ? actions.openProject(id) : actions.setScope(id))
  /** The ways to narrow a selection past the Board's limits. */
  const narrowing = () => {
    if (info.mine)
      return {
        hint: phone
          ? 'Narrow your filters, such as Focus, Priority or Stale, or open a project.'
          : 'Narrow your filters, such as Focus, Priority, Stale or the text filter, or open a project.',
      }
    if (info.isMeta) {
      // the answer's sub-projects the store knows, in the Board's lane order
      const offered = new Set(view.answer && 'projects' in view.answer ? view.answer.projects : [])
      return {
        hint: 'Choose a sub-project or narrow your filters.',
        projects: info.groups.filter((g) => offered.has(g.proj.id)).map((g) => g.proj),
      }
    }
    return { hint: 'Narrow your filters.' }
  }
  switch (view.state) {
    case 'choose':
      // the phone's own empty card says why no project shows
      if (info.metas.length === 0 && phone) return null
      if (info.metas.length === 0)
        return (
          <NoProjects
            icon="layers"
            title="Nothing to show yet"
            onNewProject={() => actions.newProject({ kind: 'program' })}
          />
        )
      return (
        <Note
          phone={phone}
          icon="layers"
          title="Choose a project"
          hint="The Board shows one project at a time. Pick one to see its tasks."
          projects={info.metas}
          onProject={open}
        />
      )
    case 'over_ceiling': {
      const { hint, projects } = narrowing()
      return (
        <Note
          phone={phone}
          icon="filter"
          title={limitSentence(LIMITS.boardTasks)}
          hint={hint}
          projects={projects}
          onProject={open}
        />
      )
    }
    case 'over_budget': {
      // one sub-project offers nothing smaller to choose, so Search finds
      // its tasks instead
      const sub = !info.wide && !info.isMeta
      const { hint, projects } = narrowing()
      return (
        <Note
          phone={phone}
          icon="filter"
          title="This selection could not be loaded within the Board's limits."
          hint={sub ? 'Narrow your filters, or find its tasks with Search.' : hint}
          projects={projects}
          onProject={open}
          action={
            sub
              ? { label: 'Search this sub-project', onClick: () => actions.openPalette(info.id) }
              : undefined
          }
        />
      )
    }
    case 'unavailable':
      return (
        <Note
          phone={phone}
          icon="eyeOff"
          title="This Board is not available"
          hint={
            view.answer?.state === 'unavailable' && view.answer.message
              ? view.answer.message
              : 'Qivo cannot show this project here. Choose another project.'
          }
        />
      )
    case 'error':
      return (
        <Note
          phone={phone}
          icon="alert"
          title="The Board could not be loaded"
          hint="Try again asks the server for this Board once more."
          action={{ label: 'Try again', onClick: view.retry }}
        />
      )
    case 'search_limit':
      return (
        <Note
          phone={phone}
          icon="search"
          title={limitSentence(LIMITS.search)}
          hint="The Board shows tasks again once the text filter is short enough."
        />
      )
    case 'loading':
    case 'refreshing':
      if (view.shows) return null
      return (
        <Note
          phone={phone}
          icon="board"
          title="Loading tasks…"
          hint="Qivo is checking which tasks this Board shows."
        />
      )
    default:
      return null
  }
}

/** One message in place of the Board: an icon, a title, a hint, the projects
    it offers and one action. */
function Note({
  phone,
  icon,
  title,
  hint,
  projects,
  onProject,
  action,
}: {
  phone: boolean
  icon: string
  title: string
  hint: string
  projects?: readonly ProjectVM[]
  onProject?: (id: string) => void
  action?: { label: string; onClick: () => void }
}) {
  const list = projects && projects.length > 0 && onProject && (
    <div data-board-choices className="flex max-w-[420px] flex-wrap justify-center gap-2">
      {projects.map((p) => (
        <Button key={p.id} type="button" data-board-choice={p.id} onClick={() => onProject(p.id)}>
          <span className="truncate">
            <ProjectName project={p} />
          </span>
        </Button>
      ))}
    </div>
  )
  const button = action && (
    <Button type="button" onClick={action.onClick}>
      {action.label}
    </Button>
  )
  if (phone)
    return (
      <div className="mobile-task-empty" data-empty-state>
        <Icon name={icon} size={24} />
        <h2 data-empty-state-title>{title}</h2>
        <p>{hint}</p>
        {list}
        {button}
      </div>
    )
  // a list taller than the pane scrolls in the message, from its title on
  return (
    <div
      data-empty-state
      className="qivo-empty-state animate-in fade-in slide-in-from-bottom-1 flex min-h-[260px] flex-1 flex-col overflow-y-auto p-10"
    >
      {/* centered while it fits; auto margins, unlike centering, keep the
          top of a taller message in reach of the scroll */}
      <div className="m-auto flex flex-col items-center gap-1.5">
        <div className="mb-2 grid size-[52px] place-items-center rounded-xl border border-border bg-surface-2 shadow-card">
          <Icon name={icon} size={22} color="var(--text-3)" />
        </div>
        <div data-empty-state-title className="max-w-[460px] text-center text-md font-semibold">
          {title}
        </div>
        <div className="max-w-[420px] text-center text-base leading-normal text-text-3">{hint}</div>
        {(list || button) && (
          <div className="mt-3 flex flex-col items-center gap-3">
            {list}
            {button}
          </div>
        )}
      </div>
    </div>
  )
}

/** The note a Board shows above its tasks while some the answer names did
    not reach the store (state incomplete). The workspace counts as loaded
    then, so no part of it waits to be asked again: Try again asks only for
    the Board's answer, and the note says so rather than promise the tasks. */
export function IncompleteNote({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-board-incomplete
      className="board-empty-note flex flex-col items-center gap-1.5 px-4 py-[26px] text-center"
    >
      <span className="text-base text-text-3">
        Some tasks of this Board have not reached this window.
      </span>
      <span className="text-sm text-text-3">
        Try again asks the server for this Board once more. If the tasks still do not show, reload
        the page.
      </span>
      <Button type="button" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** A Board's own root, which names its state for drives, tests and the
    benchmark (data-board-state) and is busy while it waits for an answer.
    The pane inside carries the mount scheduler's marks. */
export function BoardFrame({
  view,
  grow,
  children,
}: {
  view: BoardView
  grow: boolean
  children: ReactNode
}) {
  return (
    <div
      data-board-root
      data-board-state={view.state}
      aria-busy={view.busy || undefined}
      className={`flex min-h-0 flex-col ${grow ? 'flex-1 overflow-hidden' : ''}`}
    >
      {children}
    </div>
  )
}
