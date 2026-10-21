/* Names of records for display, shared by the app and the server's
 * sentences. A team, project, sub-project or milestone saved before names
 * were required (until 2026-10-16) can have a blank name; each shows a
 * fallback label instead of nothing. Edits still send and compare the
 * stored name. */

/** A team's name for display, or "Unnamed team" when it is blank. */
export const teamLabel = (t: { name: string }): string => t.name.trim() || 'Unnamed team'

/** A project's name for display, or "Unnamed project" ("Unnamed
 * sub-project" for a sub-project) when it is blank. */
export const projectName = (p: { name: string; type: 'meta' | 'project' }): string =>
  p.name.trim() || (p.type === 'meta' ? 'Unnamed project' : 'Unnamed sub-project')

/** A milestone's name for display, or "Unnamed milestone" when it is blank. */
export const milestoneLabel = (m: { name: string }): string => m.name.trim() || 'Unnamed milestone'
