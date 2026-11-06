/* The message a view shows in place of what it cannot show: the Board's
   (views/board/BoardNote.tsx), the Overview's (views/Overview.tsx) and
   Team sync's (views/teamSync/SyncNote.tsx) choosers, limits and failures. Each is an empty state (data-empty-state),
   where focus goes once a task window closes over it (lib/taskFocus.ts). */

import { Icon, ProjectName } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import type { ProjectVM } from '../store/planner'

/** One message in place of a view: an icon, a title, a hint, the projects
    it offers and one action. `hooks` names the choices' data attributes,
    `data-<hooks>-choices` on the list and `data-<hooks>-choice` on each
    project, so each view's drives and tests find their own. `phone` draws
    it as the phone's card. */
export function ViewNote({
  hooks,
  phone,
  icon,
  title,
  hint,
  projects,
  onProject,
  action,
}: {
  hooks: 'board' | 'ov' | 'sync'
  phone: boolean
  icon: string
  title: string
  hint: string
  projects?: readonly ProjectVM[]
  onProject?: (id: string) => void
  action?: { label: string; onClick: () => void }
}) {
  const list = projects && projects.length > 0 && onProject && (
    <div
      {...{ [`data-${hooks}-choices`]: '' }}
      className="flex max-w-[420px] flex-wrap justify-center gap-2"
    >
      {projects.map((p) => (
        <Button
          key={p.id}
          type="button"
          {...{ [`data-${hooks}-choice`]: p.id }}
          onClick={() => onProject(p.id)}
        >
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
