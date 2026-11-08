/* How an open page, picker or view names the people its loaded rows show,
   so the store's profile cache reads the ones the workspace does not hold
   and the store asks for their pictures, in the rows' order, while the view
   shows (store/profileCache.ts, store/planner.ts P.person). Each host names
   the people of its loaded rows, rows below the visible area and each Load
   more batch included, never a page it has not read. */

import { useEffect, useId, useRef } from 'react'
import { type NamedPerson, P, type PersonView } from '@/store/planner'
import { usePlannerVersion } from '@/store/usePlannerVersion'

/**
 * The people `people` as P.person answers them, in the order given, named
 * under this component while it is mounted and shown: the store's profile
 * cache reads the ones the workspace does not hold and the store asks for
 * the pictures of the named people only. The names follow a change of the
 * list's organizations and ids, never its identity, and are released when
 * the component unmounts or a kept page hides (components/KeptView.tsx,
 * whose effects stop while another page shows), and named again when it
 * shows. A change of the list replaces what it named without releasing it
 * first, so a list that loads more stops no picture. It renders again on
 * every store change, a face or a picture that arrived included. A person
 * with an empty id is left out.
 */
export function usePeople(people: readonly NamedPerson[]): PersonView[] {
  usePlannerVersion()
  const owner = useId()
  // the list's people and signature, worked out again only for a new list
  const memo = useRef<{ list: readonly NamedPerson[]; named: NamedPerson[]; signature: string }>(
    null,
  )
  if (memo.current?.list !== people) {
    const named = people.filter((person) => person.id)
    memo.current = {
      list: people,
      named,
      signature: named.map((person) => `${person.org}\n${person.id}`).join('\t'),
    }
  }
  const { named, signature } = memo.current
  const latest = useRef(named)
  latest.current = named
  // names the list, and again on each change of its people
  useEffect(() => {
    P.namePeople(owner, latest.current)
  }, [owner, signature])
  // releases them when the component unmounts or its kept page hides
  useEffect(() => () => P.namePeople(owner, []), [owner])
  return named.map(
    (person): PersonView => P.person(person.id, person.org) ?? { state: 'loading', id: person.id },
  )
}

/** The people `ids` of organization `org` as usePeople names them, for a
    host whose rows are all of one organization. */
export function useOrgPeople(org: string, ids: readonly (string | null | undefined)[]) {
  return usePeople(ids.flatMap((id) => (id ? [{ org, id }] : [])))
}

/** What a failed read of a person says, in their name's place. */
export const PERSON_FAILED = "Couldn't load this person"

/**
 * The words for `person` in a name's place: their name once named,
 * "Loading…" while their details are on their way, PERSON_FAILED after a
 * failed read, and `gone`, the reader's own word, for no person or one the
 * server's answer says the organization does not hold.
 */
export function personLabel(person: PersonView | null | undefined, gone: string): string {
  if (!person || person.state === 'gone') return gone
  if (person.state === 'ok') return person.name
  return person.state === 'failed' ? PERSON_FAILED : 'Loading…'
}

/** Person `person`'s name once named, else undefined, for a sentence that
    leaves the name out until it is known. */
export const nameOf = (person: PersonView | null | undefined) =>
  person?.state === 'ok' ? person.name : undefined

/** The name a list sorts person `person` by: their name once named, `gone`
    for no person or one the server says is not there, and undefined while
    their details are on their way or failed, which such a list keeps in
    place by id after the named people, never dropping them. */
export function sortName(person: PersonView | null | undefined, gone: string): string | undefined {
  if (!person || person.state === 'gone') return gone
  return person.state === 'ok' ? person.name : undefined
}
