import { P } from '../store/planner'

/** Whether the user can see no project at all, not even a sub-project. */
export const seesNoProject = (): boolean => !P.projects.some((p) => P.canSee(p.id))

/** Why a page is empty for a person who can see no active project, and
    what they can do about it. An organization admin sees every project, so
    for one the organization has none. Anyone else may lack access to
    projects that exist, which these words neither confirm nor deny. */
export function noProjectsHint(): string {
  return P.isAdmin()
    ? 'Your organization has no active projects.'
    : 'No active projects are shared with you. Ask an organization admin or a project lead for access.'
}
