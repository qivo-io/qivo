/* The pure rules behind the "Who can create new projects?" setting in
   Organization settings: who the summary under it names and which Users rows
   offer the per-person checkbox. Both follow the shared rule in
   convex/lib/projectCreators.ts, the one projects.create enforces. Nothing
   here imports the store at runtime. */
import { canCreateProjects } from '../../convex/lib/projectCreators'
import type { OrgVM, UserVM } from '../store/planner'

type Setting = OrgVM['projectCreators']

/** The people who can create projects under `setting`, from a home-org
 * roster in roster order: org admins first, then standard users. Inactive
 * members are left out; pending invitations count, because they can create
 * projects as soon as they join. */
export function projectCreatorsIn(roster: UserVM[], setting: Setting): UserVM[] {
  const creators = roster.filter(
    (user) =>
      user.active &&
      canCreateProjects(
        { org_role: user.orgRole, kind: user.kind, can_create_projects: user.canCreateProjects },
        setting,
      ),
  )
  return [
    ...creators.filter((user) => user.orgRole === 'admin'),
    ...creators.filter((user) => user.orgRole !== 'admin'),
  ]
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

/** Does this Users row offer the "Can create projects" checkbox? Only under
 * Selected users, and only for an active standard user who is a person, the
 * one kind of member the right counts for. */
export function offersProjectRight(user: UserVM, setting: Setting): boolean {
  return setting === 'selected' && user.active && user.orgRole === 'user' && !user.isAgent
}
