/* The create dialogs' rules for a creator who is not an org admin: when the
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

/** Who is creating: their profile id, and whether they are an org admin. */
export type Creator = { id: string; admin: boolean }

/** The draft after the lead changes to `lead`. Whoever becomes lead loses
 * their individual entry, as before, except a creator who is not an org
 * admin:
 * - another lead adds the creator as User, so they keep sight of the
 *   project, unless they already have an entry or removed it themselves;
 * - leading again drops only the untouched automatic entry. An entry the
 *   creator changed stays beside the lead role, and the higher level wins. */
export function afterLeadChange(draft: AccessDraft, lead: string, creator: Creator): AccessDraft {
  const access = { ...draft.access }
  if (creator.admin || lead !== creator.id) delete access[lead]
  if (creator.admin) return { access, self: draft.self }
  if (lead === creator.id) {
    if (draft.self !== 'auto') return { access, self: draft.self }
    delete access[creator.id]
    return { access, self: 'none' }
  }
  if (draft.self === 'none' && !access[creator.id]) {
    // the grant the server gives the creator when they send none
    const level = creatorGrant({ admin: false, creator: creator.id, lead, own: undefined })
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

/** The footer note of a create dialog: 'hidden' when the creator would not
 * see the project, 'lead' when someone else leads it, null otherwise. Org
 * admins see every project and manage it, so they get none. */
export function creatorNote({
  creator,
  lead,
  sees,
}: {
  creator: Creator
  lead: string
  sees: boolean
}): 'hidden' | 'lead' | null {
  if (creator.admin) return null
  if (!sees) return 'hidden'
  return lead && lead !== creator.id ? 'lead' : null
}

/** What follows a saved create: the toast, and whether to open the project.
 * A top-level project its creator cannot see is not opened; the toast says
 * so instead. A sub-project always opens, since its creator leads the parent. */
export function afterProjectSaved({
  type,
  name,
  visible,
}: {
  type: NewProjectInput['type']
  name: string
  visible: boolean
}): { message: string; open: boolean } {
  if (type === 'project') return { message: `Sub-project “${name}” created`, open: true }
  if (!visible) {
    return { message: `Project “${name}” created. You don't have access to it.`, open: false }
  }
  return { message: `Project “${name}” created`, open: true }
}
