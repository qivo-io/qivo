/* A stand-in for the two lists of people that read the organization by
   name, the view filter's Assignee menu (convex/pickers.ts orgPeople) and
   the editor's @ mention popup (mentions), that answers from a workspace
   the app holds, for the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs), as store/labelPagesStandIn.setup.ts answers
   the label reads.

   It applies orgPeople's rules (convex/model/pickers.ts orgPeopleOf) to
   the workspace's profiles: every profile of the organization, people,
   agents, switched-off people, unclaimed seats and the caller alike, for
   any active seat there; in the order of the name key's UTF-8 bytes
   (convex/lib/nameKey.ts, as Convex compares strings, not by
   localeCompare), ties by id; the lists' match, every
   whitespace-separated word of the search in the name or the initials, in
   any order, ignoring case but not accents (convex/lib/search.ts
   allWordsMatcher); at most MENTION_BATCH people a batch, or with
   `through` every match up to and including it, stopping past four
   batches; and rows of id, name, initials and color (a legacy one as
   gray), never an email.

   Asked with a task (`issue_id`), as the mention popup asks, it answers
   the same people. The workspace holds no access rows, so it runs neither
   the server's gate nor its rule, which convex/tests/mentionAccess.test.ts
   holds; `force.only` narrows its people to the ids a test names, and
   `force.state` answers one of the gate's states.

   Its cursors are plain JSON of the list, the organization, the task if
   any, the search as the match reads it (searchWords), its name key and
   the position, so equal positions give equal text, as the server's
   sealed cursors do, and a cursor of another organization, task or search
   is refused with bad_request. It reads no read budget and keys every
   name, so a stopped batch, a failure, a smaller batch and names not
   ready answer only when `force` asks for them.
   src/store/mentionParity.test.ts compares it with the real orgPeople. It
   imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { shownAvatarColor } from '../../convex/lib/avatarColors'
import { LIMITS, MENTION_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher, searchWords } from '../../convex/lib/search'
import type { MentionBatch, MentionRow } from '../../convex/model/pickers'
import type { Whole } from './guard/liveDouble.setup'

/** What pickers.orgPeople is asked, and pickers.mentions with its task. */
export type MentionArgs = {
  org_id: string
  issue_id?: string
  search?: string
  after?: string
  through?: string
}

/** States the stand-in answers whatever the workspace says: names not yet
    keyed (`notReady`), a batch whose read stops after this many people
    (`stop`, at least one, as the server always reads its first), a read
    that fails (`fail`), a smaller batch (`batch`), only the people with
    these ids (`only`) and one of the mention gate's states (`state`). */
export type ForcedMentions = {
  notReady?: boolean
  stop?: number
  fail?: boolean
  batch?: number
  only?: readonly string[]
  state?: Exclude<MentionBatch, { state: 'ready' }>
}

type Profile = Whole['profiles'][number]
/* A place in the list, just after the profile with this name key and id. */
type Position = { key: string; id: string }

const NOT_A_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same search; start again from the first batch'

/* -1, 0 or 1 as position `a` sorts before, with or after `b`. */
function compare(a: Position, b: Position): number {
  const byKey = compareValues(a.key, b.key)
  if (byKey !== 0) return byKey
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const positionOf = (profile: Profile): Position => ({ key: nameKey(profile.name), id: profile.id })

/** `profile` as a mention row. */
const rowOf = (profile: Profile): MentionRow => ({
  id: profile.id,
  name: profile.name,
  initials: profile.initials,
  // gray for an older color, as the server sends it
  color: shownAvatarColor(profile.color),
})

/**
 * What pickers.orgPeople answers for `args` while the server holds
 * `workspace`, read by the caller the workspace belongs to, and what
 * pickers.mentions answers a caller for whose task every profile passes
 * its rule. Throws as the server refuses: a login without an active seat
 * in the organization, a search past LIMITS.search and a cursor the list
 * did not give for the organization, task and search.
 */
export function mentionStandIn(
  workspace: Pick<Whole, 'myProfileIds' | 'profiles'>,
  args: MentionArgs,
  options: { force?: ForcedMentions } = {},
): MentionBatch {
  const force = options.force ?? {}
  const me = workspace.profiles.find(
    (p) => p.org_id === args.org_id && workspace.myProfileIds.includes(p.id),
  )
  if (!me || me.active === false)
    throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const LIST = args.issue_id === undefined ? 'pickers.orgPeople' : 'pickers.mentions'
  const scope = [args.org_id, args.issue_id ?? null, searchWords(search), nameKey(search)]
  const seal = (at: Position) => JSON.stringify([LIST, scope, [at.key, at.id]])
  const open = (text: string | undefined): Position | null => {
    if (text === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const [list, of, at] = Array.isArray(parsed) ? parsed : []
    const [key, id] = Array.isArray(at) ? at : []
    if (
      list !== LIST ||
      JSON.stringify(of) !== JSON.stringify(scope) ||
      typeof key !== 'string' ||
      typeof id !== 'string'
    )
      throw new ConvexError({ code: 'bad_request', message: NOT_A_CURSOR })
    return { key, id }
  }
  const after = open(args.after)
  const through = open(args.through)
  if (after !== null && through !== null && compare(through, after) <= 0)
    throw new ConvexError({
      code: 'bad_request',
      message: 'through must be a cursor after the one in after',
    })
  if (force.notReady) return { state: 'not_ready' }
  if (force.fail) throw new Error('the mention suggestions fail, as the stand-in was asked')
  if (force.state) return force.state

  const people = workspace.profiles
    .filter((p) => p.org_id === args.org_id && (force.only?.includes(p.id) ?? true))
    .sort((a, b) => compare(positionOf(a), positionOf(b)))
  const matches = allWordsMatcher(search)
  const size = force.batch ?? MENTION_BATCH
  const limit = through === null ? size : 4 * size
  const rows: MentionRow[] = []
  let at: Position | null = after
  let read = 0
  const answer = (next: Position | null, stopped: boolean): MentionBatch => ({
    state: 'ready',
    rows,
    next: next === null ? null : seal(next),
    stopped,
  })
  for (const profile of people) {
    const position = positionOf(profile)
    if (after !== null && compare(position, after) <= 0) continue
    if (through !== null && compare(position, through) > 0) return answer(through, false)
    // a full batch reads one person more, so a batch that ends with the
    // list says so; past four batches a pinned one stops short of its end
    if (rows.length >= limit && at !== null)
      return answer(at, through !== null && compare(at, through) < 0)
    if (force.stop !== undefined && through === null && read >= Math.max(1, force.stop) && at)
      return answer(at, true)
    read++
    at = position
    if (matches(`${profile.name}\n${profile.initials}`)) rows.push(rowOf(profile))
  }
  return answer(null, false)
}
