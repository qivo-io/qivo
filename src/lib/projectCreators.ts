/* The pure rules behind the "Who can create new projects?" setting in
   Organization settings: who the summary under it names and which Users rows
   offer the per-user checkbox. Both follow the shared rule in
   convex/lib/projectCreators.ts, the one projects.create enforces, which
   counts a Standard user agent like a standard user who is a person. Nothing
   here imports the store at runtime. */
import { canCreateProjects } from '../../convex/lib/projectCreators'
import type { OrgVM, UserVM } from '../store/planner'

type Setting = OrgVM['projectCreators']

/** The users who can create projects under `setting`, from a home-org
 * roster in roster order: org admins first, then standard users, people and
 * agents alike. Inactive members are left out; pending invitations count,
 * because they can create projects as soon as they join. */
export function projectCreatorsIn(roster: UserVM[], setting: Setting): UserVM[] {
  const creators = roster.filter(
    (user) =>
      user.active &&
      canCreateProjects(
        { org_role: user.orgRole, can_create_projects: user.canCreateProjects },
        setting,
      ),
  )
  return [
    ...creators.filter((user) => user.orgRole === 'admin'),
    ...creators.filter((user) => user.orgRole !== 'admin'),
  ]
}

/** How the summary names a creator: an agent's name says it is one, such as
 * "Atlas (agent)", because the roster shows agents as standard users. */
export function creatorName(user: Pick<UserVM, 'name' | 'isAgent'>): string {
  return user.isAgent ? `${user.name} (agent)` : user.name
}

/** One part of a name list: a name, or the words that join the names. */
export type NamePart = { text: string; name: boolean }

/** A list of names that fits one line: up to three in full ("A", "A and B",
 * "A, B and C"), past three the first two and a count ("A, B and 2 more").
 * Names and joining words are separate parts so the caller can ink them
 * apart. */
export function namePhrase(names: string[]): NamePart[] {
  const name = (text: string): NamePart => ({ text, name: true })
  const words = (text: string): NamePart => ({ text, name: false })
  if (names.length > 3) {
    return [name(names[0]), words(', '), name(names[1]), words(` and ${names.length - 2} more`)]
  }
  return names.flatMap((text, i) => {
    if (i === 0) return [name(text)]
    return [words(i === names.length - 1 ? ' and ' : ', '), name(text)]
  })
}

/** The "Can create projects" checkbox a Users row shows, which happens only
 * under Selected users: 'editable' for an active standard user, person or
 * agent, the one role the right counts for, and 'locked' (ticked,
 * unchangeable) for an active org admin, who can always create projects.
 * Anyone else gets none. */
export function projectRightBox(user: UserVM, setting: Setting): 'editable' | 'locked' | null {
  if (setting !== 'selected' || !user.active) return null
  if (user.orgRole === 'admin') return 'locked'
  return user.orgRole === 'user' ? 'editable' : null
}
