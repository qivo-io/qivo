/* The one definition of who may create a top-level project, shared by the
 * server (createProjectCore behind projects.create, REST and MCP, and the
 * get_me flag) and the browser (P.canCreateProject, which shows every New
 * project button), so the button appears exactly when the server would
 * accept the create. The rule reads the organization role, never whether the
 * profile is a person or an agent. Sub-projects follow lead access on the
 * parent instead. It also holds the rule for what a profile update stores in
 * can_create_projects, shared by profiles.update and P.updateUser. src/
 * imports this module, so it must stay free of server runtime and import
 * only types. */

import type { Doc } from '../_generated/dataModel'
import type { OrgRole, ProjectCreators } from './enums'

/* The stored organization setting; missing means 'users'. */
type Setting = Doc<'organizations'>['project_creators']

/* The refusal sentence for each setting. Keyed by the enum, so a new setting
 * cannot be added without its sentence. */
const REFUSALS: Record<ProjectCreators, string> = {
  admins: 'only org admins can create projects',
  users: 'only org admins and standard users can create projects',
  selected: 'only org admins and selected standard users can create projects',
}

/* True when a value names a known setting. The browser checks a submitted
 * value with it before writing. */
export function isProjectCreators(value: unknown): value is ProjectCreators {
  return typeof value === 'string' && Object.hasOwn(REFUSALS, value)
}

/* May this profile create a top-level project under the setting? The rule
 * reads the role only, so a Standard user agent counts like a standard user
 * who is a person. Org admins always can. Otherwise only a standard user
 * qualifies: every one under 'users', only those with can_create_projects
 * under 'selected', and nobody under 'admins' or a value this code does not
 * know. Viewers, guests and unknown roles never do. */
export function canCreateProjects(
  me: Pick<Doc<'profiles'>, 'org_role' | 'can_create_projects'>,
  setting: Setting,
): boolean {
  if (me.org_role === 'admin') return true
  if (me.org_role !== 'user') return false
  switch (setting ?? 'users') {
    case 'users':
      return true
    case 'selected':
      return me.can_create_projects === true
    default:
      return false
  }
}

/* The can_create_projects value a profile update leaves stored, shared by
 * profiles.update and the planner's optimistic updateUser. An update that
 * neither changes the role nor names the right keeps the current value, so
 * deactivating keeps it. Otherwise the right is on only when the update
 * turns it on for a standard user, person or agent, so a role change clears
 * it. Off is stored as absent. profiles.update refuses turning it on for
 * anyone else before it gets here. Callers write the result when it differs
 * from the row. */
export function projectRightAfterUpdate(
  row: Pick<Doc<'profiles'>, 'org_role' | 'can_create_projects'>,
  update: { org_role?: OrgRole; can_create_projects?: boolean },
): boolean | undefined {
  const roleChanges = update.org_role !== undefined && update.org_role !== row.org_role
  if (!roleChanges && update.can_create_projects === undefined) return row.can_create_projects
  const role = update.org_role ?? row.org_role
  return (update.can_create_projects === true && role === 'user') || undefined
}

/* The sentence projects.create refuses with: it says who can create projects
 * under the setting. An unknown value reads as 'admins'. */
export function projectCreationRefusal(setting: Setting): string {
  const mode = setting ?? 'users'
  return isProjectCreators(mode) ? REFUSALS[mode] : REFUSALS.admins
}
