/* A stand-in for the follower popover's two reads (convex/issues.ts
   subscribers and convex/pickers.ts taskFollowers) that answers from the
   server's data a test publishes (store/guard/liveDouble.setup.ts Whole),
   for the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs).

   - subscribers: the task's followers as rows, in name key order, at most
     LIMITS.followers.max with `more` past it, and whether the caller
     manages them (`canManage`, given, as the stand-in reads no level);
   - taskFollowers: the active people and Standard user agents of the
     organization who do not follow the task yet, the caller left out,
     whose name or email holds every word of the search, LIST_BATCH a
     batch in name key order, `refused` for a caller who may not manage.
   Who may follow is given (`sees`), as the stand-in reads no level. Its
   cursors are plain JSON of the list, the scope and the position, and one
   of another task or search is refused with bad_request. It imports
   nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { FollowerBatch, FollowerRow } from '../../convex/model/pickers'
import type { Whole } from './guard/liveDouble.setup'

/** The rows of the server's data the stand-in reads. */
export type FollowerWorkspace = Pick<Whole, 'myProfileIds' | 'profiles' | 'issueSubs'>

/** What the stand-in is told beyond the data: whether the caller may
    manage the task's followers, who may follow it, and states to answer
    whatever the data says (`batch`, a smaller batch; `fail`, a failed
    read). */
export type FollowerOptions = {
  canManage: boolean
  sees?: (profileId: string) => boolean
  batch?: number
  fail?: boolean
}

/* The sentence the follow write refuses another person's follow with
   (convex/model/pickers.ts MANAGE_FOLLOWERS_RULE). */
const MANAGE_FOLLOWERS_RULE =
  'only project leads and organization admins can manage other subscribers'

type Profile = Whole['profiles'][number]

const rowOf = (p: Profile): FollowerRow => ({
  id: p.id,
  name: p.name,
  initials: p.initials,
  color: p.color,
  active: p.active,
})

const byKey = (a: Profile, b: Profile) =>
  compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id])

/** What issues.subscribers answers for task `issueId` of organization
    `org`. */
export function subscribersStandIn(
  ws: FollowerWorkspace,
  args: { org_id: string; issue_id: string },
  o: FollowerOptions,
) {
  if (o.fail) throw new Error('issues.subscribers fails, as the stand-in was asked')
  const people = new Map(ws.profiles.filter((p) => p.org_id === args.org_id).map((p) => [p.id, p]))
  const follows = ws.issueSubs.filter((s) => s.issue_id === args.issue_id)
  const most = LIMITS.followers.max
  const rows = follows
    .slice(0, most)
    .flatMap((s) => {
      const p = people.get(s.profile_id)
      return p ? [p] : []
    })
    .sort(byKey)
    .map(rowOf)
  return { canManage: o.canManage, subscribers: rows, more: follows.length > most }
}

/** What pickers.taskFollowers answers for `args`. */
export function taskFollowersStandIn(
  ws: FollowerWorkspace,
  args: { org_id: string; issue_id: string; search?: string; after?: string },
  o: FollowerOptions,
): FollowerBatch {
  if (o.fail) throw new Error('pickers.taskFollowers fails, as the stand-in was asked')
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const scope = [args.org_id, args.issue_id, nameKey(search)]
  let after: [string, string] | null = null
  if (args.after !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(args.after)
    } catch {
      parsed = null
    }
    const [list, from, at] = Array.isArray(parsed) ? parsed : []
    if (list !== 'pickers.taskFollowers' || JSON.stringify(from) !== JSON.stringify(scope))
      throw new ConvexError({ code: 'bad_request', message: 'not a cursor of this list' })
    after = at as [string, string]
  }
  if (!o.canManage) return { state: 'refused', message: MANAGE_FOLLOWERS_RULE }
  const following = new Set(
    ws.issueSubs.filter((s) => s.issue_id === args.issue_id).map((s) => s.profile_id),
  )
  const me = new Set(ws.myProfileIds)
  const matches = allWordsMatcher(nameKey(search))
  const people = ws.profiles
    .filter(
      (p) =>
        p.org_id === args.org_id &&
        p.active &&
        !me.has(p.id) &&
        !following.has(p.id) &&
        (o.sees ?? (() => true))(p.id) &&
        matches(`${nameKey(p.name)}\n${nameKey(p.email ?? '')}`),
    )
    .sort(byKey)
    .filter(
      (p) => after === null || compareValues([nameKey(p.name), p.id], [after[0], after[1]]) > 0,
    )
  const size = o.batch ?? LIST_BATCH
  const rows = people.slice(0, size)
  const last = rows.at(-1)
  return {
    state: 'ready',
    rows: rows.map(rowOf),
    next:
      people.length > size && last
        ? JSON.stringify(['pickers.taskFollowers', scope, [nameKey(last.name), last.id]])
        : null,
    stopped: false,
  }
}
