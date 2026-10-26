import { noProjectsHint } from '../lib/noProjects'
import { P } from '../store/planner'
import { EmptyState } from './qivo'

/** The empty state of a page with no project to show: the page's own
    `title`, why it is empty (lib/noProjects.ts) and, for a person who may
    create a top-level project (P.canCreateProject), New project, which runs
    `onNewProject`. */
export function NoProjects({
  icon,
  title,
  onNewProject,
}: {
  icon: string
  title: string
  onNewProject?: () => void
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      hint={noProjectsHint()}
      actionLabel={onNewProject && P.canCreateProject() ? 'New project' : undefined}
      onAction={onNewProject}
    />
  )
}
