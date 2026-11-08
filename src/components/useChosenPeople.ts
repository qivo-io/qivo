/* The people a view filter's Assignee menu has chosen, named by id in the
   organizations of the login (components/viewFilters.tsx). The App keeps
   one set of filters across scopes, so a person chosen in a project of one
   organization can come along to a project of another, where the filter
   still applies to them. The profile cache reads a person in one
   organization at a time, the one asked by the earliest registered of the
   views that name them (store/profileCache.ts sync), so a chosen person
   the cache already names in one of the login's organizations, as another
   open view such as Team sync, the Inbox list or a task window does, is
   asked there. Anyone else is asked in the scope's organization first and,
   once its answer leaves them out, in the login's other organizations one
   by one. */

import { useEffect, useState } from 'react'
import { P, type PersonView } from '@/store/planner'
import { usePeople } from './usePeople'

/** The most chosen people whose organizations' answers are kept. */
const OUTSIDE_KEPT = 1000

/* The organizations whose answer left each chosen person out, by profile
   id, for the login that read them. A profile belongs to one organization
   for good, so an answer holds while the login stays; the oldest go first
   past OUTSIDE_KEPT. Every hook reads it, so the trigger and the open menu
   ask the same organization for a person. */
let outside: { login: string; orgs: Map<string, ReadonlySet<string>> } = {
  login: '',
  orgs: new Map(),
}

/** The organizations that answered `id` is not theirs, for the login now. */
const outsideOf = (id: string): ReadonlySet<string> | undefined =>
  outside.login === P.myProfileIds.join(',') ? outside.orgs.get(id) : undefined

/** Keeps that organization `org` answered `id` is not theirs. */
function keepOutside(id: string, org: string) {
  const login = P.myProfileIds.join(',')
  if (outside.login !== login) outside = { login, orgs: new Map() }
  const orgs = new Set(outside.orgs.get(id))
  orgs.add(org)
  outside.orgs.delete(id)
  outside.orgs.set(id, orgs)
  for (const oldest of outside.orgs.keys()) {
    if (outside.orgs.size <= OUTSIDE_KEPT) break
    outside.orgs.delete(oldest)
  }
}

/**
 * The chosen people `ids`, named while they show (usePeople): each in the
 * first of the login's organizations in which the store already names them,
 * else in organization `org`, the scope's, else in the first of the
 * login's other organizations whose answer has not left them out, and
 * `gone` once every organization's answer did.
 */
export function useChosenPeople(ids: readonly string[], org: string): PersonView[] {
  const orgs = [org, ...P.orgs.map((o) => o.id).filter((id) => id !== org)]
  const asked = ids.map((id) => ({
    id,
    org:
      orgs.find((o) => P.person(id, o)?.state === 'ok') ?? orgs.find((o) => !outsideOf(id)?.has(o)),
  }))
  usePeople(asked.flatMap((a) => (a.org === undefined ? [] : [{ org: a.org, id: a.id }])))
  const views = asked.map(
    (a): PersonView =>
      a.org === undefined
        ? { state: 'gone', id: a.id }
        : (P.person(a.id, a.org) ?? { state: 'loading', id: a.id }),
  )
  // an organization whose answer leaves a person out passes them to the
  // next, which the next render asks, until none is left to ask
  const [, setTurn] = useState(0)
  useEffect(() => {
    let moved = false
    asked.forEach((a, i) => {
      if (a.org === undefined || views[i].state !== 'gone') return
      keepOutside(a.id, a.org)
      moved = true
    })
    if (moved) setTurn((n) => n + 1)
  })
  return views
}
