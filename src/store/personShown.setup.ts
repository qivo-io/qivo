/* What a Settings page shows of a person or a label the store holds, for
   the tests that send their writes the way the page sends them: the
   store's profile or catalogue entry while it holds them
   (store/viewModels.ts personShownOf). */

import type { PersonShown, UserVM } from './viewModels'
import { personShownOf } from './viewModels'

/** Person `id` as a page showing `P`'s profile of them shows them, or a
    thrown error for a person `P` does not hold. */
export function shownOf(P: { user: (id: string) => UserVM | undefined }, id: string): PersonShown {
  const user = P.user(id)
  if (!user) throw new Error(`the store does not hold ${id}`)
  return personShownOf(user)
}

/** Label `id` as Settings › Labels shows `P`'s catalogue entry of it, or a
    thrown error for a label `P` does not hold. */
export function labelShownOf(
  P: { labelById: Record<string, { name: string; color: string; org: string }> },
  id: string,
): { orgId: string; name: string; color: string } {
  const label = P.labelById[id]
  if (!label) throw new Error(`the store does not hold label ${id}`)
  return { orgId: label.org, name: label.name, color: label.color }
}
