/* The create dialogs' rules for every creator, an organization admin as
   anyone, since admin status gives no access to a project's work: when the
   New project dialog shows the creator in Project access by itself, when it
   takes that entry away again, what the dialog sends, which note the footer
   shows, and what follows once the project is saved. The server stores the
   creator's grant by the shared rule (convex/lib/projectGrants.ts
   creatorGrant); the dialog shows that grant before saving and sends only
   what the creator changed. Pure functions of plain inputs, so they test
   without the store or a render. */
import { creatorGrant } from '../../convex/lib/projectGrants'
import type { AccessLevel, NewProjectInput } from '../store/planner'

/** Where the creator's own Project access entry came from: 'none' while
 * there is none and the creator has not touched it, 'auto' while it is the
 * untouched entry the dialog added, 'own' once the creator has added,
 * changed or removed it themselves. */
export type SelfEntry = 'none' | 'auto' | 'own'

/** The dialog's individual grants and where the creator's own entry came from. */
export type AccessDraft = { access: Record<string, AccessLevel>; self: SelfEntry }

/** Who is creating: their profile id, and whether they are an org admin,
 * who keeps managing a project someone else leads, so their footer gives
 * no 'lead' note (creatorNote). */
export type Creator = { id: string; admin: boolean }

/** The draft after the lead changes to `lead`. Whoever becomes lead loses
 * their individual entry, as before, except the creator, an organization
 * admin as anyone:
 * - another lead adds the creator as User, so they keep sight of the
 *   project, unless they already have an entry or removed it themselves;
 * - leading again drops only the untouched automatic entry. An entry the
 *   creator changed stays beside the lead role, and the higher level wins. */
export function afterLeadChange(draft: AccessDraft, lead: string, creator: Creator): AccessDraft {
  const access = { ...draft.access }
  if (lead !== creator.id) delete access[lead]
  if (lead === creator.id) {
    if (draft.self !== 'auto') return { access, self: draft.self }
    delete access[creator.id]
    return { access, self: 'none' }
  }
  if (draft.self === 'none' && !access[creator.id]) {
    // the grant the server gives the creator when they send none
    const level = creatorGrant({ creator: creator.id, lead, own: undefined })
    if (level !== null) {
      access[creator.id] = level
      return { access, self: 'auto' }
    }
  }
  return { access, self: draft.self }
}

/** The Project access the New project dialog sends. The entry the dialog
 * added for the creator by itself is left out, because the server adds the
 * same grant by its own rule, and an entry the creator removed goes as null,
 * so the server adds none. */
export function requestedAccess(
  draft: AccessDraft,
  creator: Creator,
): Record<string, AccessLevel | null> {
  const access: Record<string, AccessLevel | null> = { ...draft.access }
  if (draft.self === 'auto') delete access[creator.id]
  else if (draft.self === 'own' && !access[creator.id]) access[creator.id] = null
  return access
}

/** The draft after the access picker sets a user's level, or clears it with
 * null. Any change to the creator's own entry makes it theirs, so the dialog
 * neither removes nor adds it again by itself. */
export function afterAccessChange(
  draft: AccessDraft,
  userId: string,
  level: AccessLevel | null,
  creator: Creator,
): AccessDraft {
  const access = { ...draft.access }
  if (level) access[userId] = level
  else delete access[userId]
  return { access, self: userId === creator.id ? 'own' : draft.self }
}

/** The footer note of a create dialog: 'hidden' when the creator will not
 * see the project, an organization admin as anyone, 'lead' when someone
 * else leads it and the creator will no longer manage it, null otherwise.
 * An admin keeps managing every project, so gets no 'lead' note. `sees`
 * null is unknown, as when the New sub-project dialog's parent check could
 * not finish, and warns of nothing. */
export function creatorNote({
  creator,
  lead,
  sees,
}: {
  creator: Creator
  lead: string
  sees: boolean | null
}): 'hidden' | 'lead' | null {
  if (sees === false) return 'hidden'
  if (creator.admin) return null
  return lead && lead !== creator.id ? 'lead' : null
}

/** What follows a saved create: the toast, and whether to open the project.
 * A top-level project its creator cannot see is not opened; the toast says
 * so instead. A sub-project opens when `visible`, which App answers with
 * whether the workspace holds it once the create is answered, and `sees`,
 * whether the server's navigation read confirmed that the creator sees it
 * (projectNav.resolve). Its creator manages the parent, which an
 * organization admin does without seeing it, so a sub-project they will
 * not see (`sees` false) says so and stays closed, and one that could not
 * be confirmed (`sees` null, also when a caller passes none) stays closed
 * with the plain toast. A top-level project ignores `sees`. */
export function afterProjectSaved({
  type,
  name,
  visible,
  sees = null,
}: {
  type: NewProjectInput['type']
  name: string
  visible: boolean
  sees?: boolean | null
}): { message: string; open: boolean } {
  if (type === 'project') {
    if (sees === false)
      return { message: `Sub-project “${name}” created. You don't have access to it.`, open: false }
    return { message: `Sub-project “${name}” created`, open: visible && sees === true }
  }
  if (!visible) {
    return { message: `Project “${name}” created. You don't have access to it.`, open: false }
  }
  return { message: `Project “${name}” created`, open: true }
}
