import { noProjectsHint } from '../lib/noProjects'
import { P } from '../store/planner'
import { EmptyState } from './qivo'

/** The empty state of a page with no project to show: the page's own
    `title`, why it is empty (`hint`, by default noProjectsHint in
    lib/noProjects.ts) and, for a person who may create a top-level project
    (P.canCreateProject), New project, which runs `onNewProject`. */
export function NoProjects({
  icon,
  title,
  hint = noProjectsHint(),
  onNewProject,
}: {
  icon: string
  title: string
  hint?: string
  onNewProject?: () => void
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      hint={hint}
      actionLabel={onNewProject && P.canCreateProject() ? 'New project' : undefined}
      onAction={onNewProject}
    />
  )
}
