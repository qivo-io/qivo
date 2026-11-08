/* What a Settings page shows of a person or a label, for the tests that
   send their writes the way the page sends them. The store holds only the
   signed-in person's own profiles and no label, so a page shows anyone
   else from its own answer: these build what it shows from the server's
   data a test published (store/guard/liveDouble.setup.ts Whole), as the
   answer rows carry it, or from the store's own profile of the signed-in
   person (store/viewModels.ts personShownOf). */

import type { Whole } from './guard/liveDouble.setup'
import type { PersonShown, PersonView, UserVM } from './viewModels'
import { personShownOf } from './viewModels'

/** Names every person of the server's data `whole` but the signed-in
    person with the profile cache of store `P`, under `key`, as the views
    on screen name the people they show, and waits until each face has
    arrived. For a test whose people:byIds reads answer from `whole`
    (store/peopleSettingsStandIn.setup.ts), such as the parity tests that
    compare the store's delays, whose capacities come from the faces. */
export async function nameEveryone(
  P: {
    namePeople: (key: string, people: readonly { org: string; id: string }[]) => void
    person: (id: string) => PersonView | null
  },
  whole: Pick<Whole, 'profiles' | 'myProfileIds'>,
  key = 'everyone',
): Promise<void> {
  const others = whole.profiles.filter((p) => !whole.myProfileIds.includes(p.id))
  P.namePeople(
    key,
    others.map((p) => ({ org: p.org_id, id: p.id })),
  )
  // polled on the timers, never vi.waitFor, which moves a faked clock and
  // with it the store's day, as the parity tests fake Date alone
  for (let tries = 0; ; tries++) {
    const missing = others.filter((p) => P.person(p.id)?.state !== 'ok')
    if (missing.length === 0) return
    if (tries >= 1000) throw new Error(`${missing.length} faces have not arrived`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Person `id` as a Settings page shows them: from the store's profile
    when `source` is a store that holds them, else from the server's data
    `source` (a whole), or a thrown error for a person neither holds. */
export function shownOf(
  source: { user: (id: string) => UserVM | undefined } | Pick<Whole, 'profiles'>,
  id: string,
): PersonShown {
  if ('user' in source) {
    const user = source.user(id)
    if (!user) throw new Error(`the store does not hold ${id}`)
    return personShownOf(user)
  }
  const p = source.profiles.find((row) => row.id === id)
  if (!p) throw new Error(`the server's data holds no ${id}`)
  return {
    orgId: p.org_id,
    name: p.name,
    isAgent: p.kind === 'agent',
    pending: p.kind !== 'agent' && !p.auth_user_id,
    orgRole: p.org_role,
    active: p.active,
    plannableHours: p.kind === 'agent' ? null : (p.plannable_hours ?? null),
    email: p.email ?? null,
    canCreateProjects: p.can_create_projects === true,
  }
}

/** Label `id` as Settings › Labels shows it, from the server's data
    `whole`, or a thrown error for a label it does not hold. */
export function labelShownOf(
  whole: Pick<Whole, 'labels'>,
  id: string,
): { orgId: string; name: string; color: string } {
  const label = whole.labels.find((row) => row.id === id)
  if (!label) throw new Error(`the server's data holds no label ${id}`)
  return { orgId: label.org_id, name: label.name, color: label.color }
}
