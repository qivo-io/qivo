import { P } from '../store/planner'

/** Whether the user can see no project at all, not even a sub-project, or
    with `org` none of that organization's. */
export const seesNoProject = (org?: string): boolean =>
  !P.projects.some((p) => (org === undefined || p.org === org) && P.canSee(p.id))

/** Why a page is empty for a person who can see no active project, and
    what they can do about it. An organization admin sees every project, so
    for one the organization has none. Anyone else may lack access to
    projects that exist, which these words neither confirm nor deny. */
export function noProjectsHint(): string {
  return P.isAdmin()
    ? 'Your organization has no active projects.'
    : 'No active projects are shared with you. Ask an organization admin or a project lead for access.'
}

/* This tab's note that its All projects is App's own choice (App's autoAll),
   not the person's, per profile. It outlives a reload, so a reload of that
   page stays App's. A new tab starts without it, and a page load that opens
   an address anew ignores it, so an address to All projects typed or
   followed is the person's. */
const autoAllKey = () => `planner.autoAll.v1:${P.CURRENT_USER}`

/** Whether this page load returns to the address the tab had open: a reload,
    or Back or Forward into Qivo. */
const returning = () =>
  performance
    .getEntriesByType('navigation')
    .some((load) => 'type' in load && (load.type === 'reload' || load.type === 'back_forward'))

/** Whether this tab noted its All projects as App's own (noteAutoAll) and
    this page load returns to it. Storage that cannot be read counts as no
    note. */
export function autoAllNoted(): boolean {
  if (!returning()) return false
  try {
    return sessionStorage.getItem(autoAllKey()) === '1'
  } catch {
    return false
  }
}

/** Notes that this tab's All projects is App's own, or with `false` that it
    is not. */
export function noteAutoAll(on: boolean) {
  try {
    if (on) sessionStorage.setItem(autoAllKey(), '1')
    else sessionStorage.removeItem(autoAllKey())
  } catch {
    // Without the note a reload counts All projects as the person's and stays.
  }
}

/** noProjectsHint for Team sync, which covers the home organization only
    (seesNoProject(P.homeOrg)). A person with seats in more than one
    organization is told which one that is. */
export function syncNoProjectsHint(): string {
  const home = P.orgs.length > 1 ? P.orgs.find((o) => o.id === P.homeOrg) : undefined
  if (!home) return noProjectsHint()
  return P.isAdmin()
    ? `Team sync covers ${home.name}, which has no active projects.`
    : `Team sync covers ${home.name}, where no active projects are shared with you. Ask an organization admin or a project lead for access.`
}
