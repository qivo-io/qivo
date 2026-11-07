/* A stand-in for a task's people pickers (convex/pickers.ts taskOwners,
   syncRecipients and canOwn) that answers from a workspace the app holds,
   for the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs), as store/removalStandIn.setup.ts answers the
   Reassign picker.

   It does not apply the server's rules (convex/model/pickers.ts ownerRule
   and recipientRule). It judges the task by the organization it is asked
   for, not by the workspace's tasks, so a task only a view's answer brings
   is answered too, and it answers `unavailable` only for a task the
   workspace holds archived or when `force` asks. Its owners are the
   active admins, users and guests of the organization, agents included,
   with no question of their access to the task's project or the tasks
   above it; its recipients are the organization's active people, not
   agents, other than the caller. The client shows what the server answers
   and never judges a person, so its tests need these answers' states and
   order, not the rule, which convex/tests/pickerParity.test.ts holds to
   the writes.

   It keeps the server's shapes and order: rows in the byte order of the
   name key as Convex compares strings (convex/lib/nameKey.ts), ties by id;
   the search's every whitespace-separated word in the name key, ignoring
   case and accents, an id never matching; LIST_BATCH people a batch with
   `next` and `stopped`; person rows (model/projectSettings.ts PersonRow);
   and canOwn's row for each distinct id in the order asked, `person` null
   for an id the organization does not hold. It refuses as the server
   does a caller without an active seat in the organization, a search past
   LIMITS.search, a cursor of another list, task, field or search, and more
   than BY_IDS_MAX ids in a check. Its cursors are plain JSON of the list,
   the scope and the position, so equal positions give equal text, as the
   server's sealed cursors do. It reads no read budget, so the states a
   budget or a missing name key would bring answer only when `force` asks.
   It imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { BY_IDS_MAX, LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { OwnerChecks, PeopleBatch } from '../../convex/model/pickers'
import type { PersonRow } from '../../convex/model/projectSettings'

/** The reads the stand-in answers, by their function names. */
export const OWNER_PICKER_READS = ['pickers:taskOwners', 'pickers:syncRecipients', 'pickers:canOwn']

/** Whether `name` is one of the reads the stand-in answers. */
export const isOwnerPickerRead = (name: string) => OWNER_PICKER_READS.includes(name)

/** The states the stand-in answers whatever the workspace says, as the
    perf page's `owners` parameter names them:
    - `stopped`, each batch's read stops after half a batch of people;
    - `small`, batches of 5;
    - `not-ready`, the lists answer `not_ready`;
    - `refused`, the lists and checks are refused with NO_WRITE_ACCESS;
    - `group`, a reviewer's list and check are refused with
      REVIEWER_ON_GROUP;
    - `unavailable`, the lists and checks answer `unavailable`;
    - `over-budget`, the lists and checks answer `over_budget`;
    - `error`, every list read fails;
    - `check-error`, every check fails;
    - `check-ineligible`, every check answers each person not eligible;
    - `check-slow`, checks answer after OWNER_CHECK_SLOW_MS, which the
      caller waits, as the stand-in answers at once. */
export type ForcedOwners = ReadonlySet<string>

/** How long a check waits under `check-slow`. */
export const OWNER_CHECK_SLOW_MS = 2000

/* The sentences the server answers with, which the worker cannot import
   from its model code (convex/model/issues.ts NO_WRITE_ACCESS and
   REVIEWER_ON_GROUP, convex/model/pickers.ts OWNERS_CURSOR and
   RECIPIENTS_CURSOR). The stand-in's test compares them. */
export const STAND_IN_SENTENCES = {
  noWrite: 'no write access to this project',
  onGroup: 'a task with subtasks has no reviewer of its own; set reviewers on its subtasks',
  ownersCursor:
    'after and through must be cursors from an earlier answer of this list, for the same task, field and search; start again from the first batch',
  recipientsCursor:
    'after and through must be cursors from an earlier answer of this list, for the same task and search; start again from the first batch',
}

type Profile = Workspace['profiles'][number]
type Field = 'assignee' | 'reviewer' | 'recipient'
/* A place in a list, just after the person with this name key and id. */
type Position = { key: string; id: string }

/** What the lists are asked. */
export type OwnerPickerArgs = {
  org_id: string
  issue_id: string
  field?: string
  search?: string
  after?: string
  through?: string
  ids?: readonly string[]
}

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })

const compare = (a: Position, b: Position) => compareValues([a.key, a.id], [b.key, b.id])
const positionOf = (p: Profile): Position => ({ key: nameKey(p.name), id: p.id })

/** `p` as a person row (convex/model/projectSettings.ts personRow). */
const personRow = (p: Profile): PersonRow => ({
  id: p.id,
  name: p.name,
  org_role: p.org_role,
  kind: p.kind,
  active: p.active,
  pending: p.kind === 'person' && !p.auth_user_id,
})

/* Whether `p` passes the stand-in's rule for `field` in organization
   `org`, asked by seat `me`. */
function passes(p: Profile, field: Field, org: string, me: Profile): boolean {
  if (p.org_id !== org || !p.active) return false
  if (field === 'recipient') return p.kind === 'person' && p.id !== me.id
  return p.org_role === 'admin' || p.org_role === 'user' || p.org_role === 'guest'
}

/* The gate's answer for a task the stand-in will not pick for, or null. */
function gate(
  ws: Pick<Workspace, 'issues'>,
  args: OwnerPickerArgs,
  field: Field,
  force: ForcedOwners,
): { state: 'unavailable' } | { state: 'refused'; message: string } | null {
  const held = ws.issues.find((t) => t.id === args.issue_id)
  if (force.has('unavailable') || (held && 'archived_at' in held && held.archived_at))
    return { state: 'unavailable' }
  if (force.has('refused')) return { state: 'refused', message: STAND_IN_SENTENCES.noWrite }
  if (force.has('group') && field === 'reviewer')
    return { state: 'refused', message: STAND_IN_SENTENCES.onGroup }
  return null
}

/**
 * What read `name` (pickers:taskOwners, syncRecipients or canOwn) answers
 * for `args` while the server holds `ws`, read by the caller the workspace
 * belongs to, with the states `force` asks for. Throws as the server
 * refuses, and for a read `force` fails.
 */
export function ownerPickersStandIn(
  ws: Pick<Workspace, 'myProfileIds' | 'profiles' | 'issues'>,
  name: string,
  args: OwnerPickerArgs,
  force: ForcedOwners = new Set(),
): PeopleBatch | OwnerChecks {
  const org = args.org_id
  const me = ws.profiles.find((p) => p.org_id === org && ws.myProfileIds.includes(p.id) && p.active)
  if (!me) throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  if (name === 'pickers:canOwn') {
    const ids = args.ids ?? []
    if (ids.length > BY_IDS_MAX) throw badRequest(`ids must name at most ${BY_IDS_MAX} people`)
    const field: Field =
      args.field === 'reviewer' || args.field === 'recipient' ? args.field : 'assignee'
    const held = gate(ws, args, field, force)
    if (held) return held
    if (force.has('check-error'))
      throw new Error('the owner check fails, as owners=check-error asks')
    if (force.has('over-budget')) return { state: 'over_budget' }
    const byId = new Map(ws.profiles.map((p) => [p.id, p]))
    return {
      state: 'ready',
      rows: [...new Set(ids)].map((id) => {
        const p = byId.get(id)
        if (!p || p.org_id !== org) return { id, person: null, eligible: false }
        return {
          id,
          person: personRow(p),
          eligible: !force.has('check-ineligible') && passes(p, field, org, me),
        }
      }),
    }
  }
  const field: Field =
    name === 'pickers:syncRecipients'
      ? 'recipient'
      : args.field === 'reviewer'
        ? 'reviewer'
        : 'assignee'
  if (name !== 'pickers:taskOwners' && name !== 'pickers:syncRecipients')
    throw new Error(`the owner pickers stand-in does not answer ${name}`)
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const list = field === 'recipient' ? 'pickers.syncRecipients' : 'pickers.taskOwners'
  const scope = [org, args.issue_id, ...(field === 'recipient' ? [] : [field]), nameKey(search)]
  const refusal =
    field === 'recipient' ? STAND_IN_SENTENCES.recipientsCursor : STAND_IN_SENTENCES.ownersCursor
  const seal = (at: Position) => JSON.stringify([list, scope, [at.key, at.id]])
  const open = (text: string | undefined): Position | null => {
    if (text === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const [named, of, at] = Array.isArray(parsed) ? parsed : []
    const [key, id] = Array.isArray(at) ? at : []
    if (
      named !== list ||
      JSON.stringify(of) !== JSON.stringify(scope) ||
      typeof key !== 'string' ||
      typeof id !== 'string'
    )
      throw badRequest(refusal)
    return { key, id }
  }
  const after = open(args.after)
  const through = open(args.through)
  if (after !== null && through !== null && compare(through, after) <= 0)
    throw badRequest('through must be a cursor after the one in after')
  const held = gate(ws, args, field, force)
  if (held) return held
  if (force.has('not-ready')) return { state: 'not_ready' }
  if (force.has('over-budget')) return { state: 'over_budget' }
  if (force.has('error')) throw new Error('the owner list fails, as owners=error asks')

  const matches = allWordsMatcher(nameKey(search))
  const people = ws.profiles
    .filter((p) => passes(p, field, org, me))
    .sort((a, b) => compare(positionOf(a), positionOf(b)))
  const size = force.has('small') ? 5 : LIST_BATCH
  const limit = through === null ? size : 4 * size
  const stopAfter = force.has('stopped') ? Math.ceil(LIST_BATCH / 2) : Number.POSITIVE_INFINITY
  const rows: PersonRow[] = []
  let at: Position | null = after
  let read = 0
  const answer = (next: Position | null, stopped: boolean): PeopleBatch => ({
    state: 'ready',
    rows,
    next: next === null ? null : seal(next),
    stopped,
  })
  for (const p of people) {
    const position = positionOf(p)
    if (after !== null && compare(position, after) <= 0) continue
    if (through !== null && compare(position, through) > 0) return answer(through, false)
    // a full batch reads one person more, so a batch that ends with the
    // list says so
    if (rows.length >= limit && at !== null) return answer(at, false)
    if (read >= stopAfter && at !== null) return answer(at, true)
    read++
    at = position
    if (matches(position.key)) rows.push(personRow(p))
  }
  return answer(null, false)
}
