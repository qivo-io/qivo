import { P } from '../store/planner'

/** Whether the user can see no project at all, not even a sub-project, or
    with `org` none of that organization's, by the workspace, for the
    Inbox's and Team sync's notes. Startup and the access guard do not
    read it: they open a project only on the server's check, else the
    project chooser (App.tsx). */
export const seesNoProject = (org?: string): boolean =>
  !P.projects.some((p) => (org === undefined || p.org === org) && P.canSee(p.id))

/** Why a page is empty for a person who can see no active project, and
    what they can do about it. An organization admin sees, like anyone, the
    projects their own leads, grants and team shares reach, and manages
    every project, so they are told where the organization's projects are
    listed. Anyone else may lack access to projects that exist, which these
    words neither confirm nor deny. */
export function noProjectsHint(): string {
  return P.isAdmin()
    ? 'You take part in no active projects. Settings › Projects › All projects lists every project of your organization.'
    : 'No active projects are shared with you. Ask an organization admin or a project lead for access.'
}

/** noProjectsHint for Team sync, which covers the home organization only
    (seesNoProject(P.homeOrg)). A person with seats in more than one
    organization is told which one that is. */
export function syncNoProjectsHint(): string {
  const home = P.orgs.length > 1 ? P.orgs.find((o) => o.id === P.homeOrg) : undefined
  if (!home) return noProjectsHint()
  return P.isAdmin()
    ? `Team sync covers ${home.name}, where you take part in no active projects. Settings › Projects › All projects lists every project of your organization.`
    : `Team sync covers ${home.name}, where no active projects are shared with you. Ask an organization admin or a project lead for access.`
}
