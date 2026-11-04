/* A stand-in for Settings › Labels' live query (convex/labels.ts
   settingsPage) that answers from a workspace the app holds, for the jsdom
   tests and the browser benchmark's server (scripts/perf/server.mjs), as
   store/overviewStandIn.setup.ts answers the Overview.

   It applies the query's rules (convex/model/labels.ts settingsLabels and
   labelBatch) to the workspace's labels: only an active admin of the
   organization may read it; the organization's labels in the order of
   name_lower as Convex compares values (strings by their UTF-8 bytes, not
   by localeCompare), then the time each was made and its id, where the
   server ties by creation time and _id; the search over every label, each
   whitespace-separated fragment of it in the name in any order, ignoring
   case and accents (convex/lib/search.ts over convex/lib/nameKey.ts); at
   most LIST_BATCH labels a batch, or with `through` every match up to and
   including it, stopping past four batches; `next`, `stopped` and `exact`
   as the server answers them; and each label's count of active tasks.

   Its cursors are plain JSON of the list, the organization, the search's
   name key and the position, so equal positions give equal text, as the
   server's sealed cursors do, and a cursor of another organization or
   search is refused with bad_request. It counts the workspace's tasks,
   which leave out tasks in archived projects that the server's counts
   hold (convex/model/labelCounts.ts), so a test that compares counts keeps
   its labelled tasks in live projects. It reads no read budget, so a
   stopped batch, a count being prepared, a count not yet made, a failure
   or a smaller batch answer only when `force` asks for them.
   src/store/labelPagesParity.test.ts compares it with the real query. It
   imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { LabelBatch, SettingsLabelRow } from '../../convex/model/labels'

/** What labels.settingsPage answers. */
export type LabelPageAnswer = LabelBatch<SettingsLabelRow> & { counting: boolean }

/** What labels.settingsPage is asked. */
export type LabelPageArgs = {
  org_id: string
  search?: string
  after?: string
  through?: string
}

/** States the stand-in answers whatever the workspace says: the counts
    being prepared (`counting`), an open batch whose read stops after this
    many labels (`stop`, at least one, as the server always reads its
    first), a read that fails (`fail`), a smaller batch (`batch`), and
    counts by label id, a number or null for one not counted (`counts`). */
export type ForcedLabelPage = {
  counting?: boolean
  stop?: number
  fail?: boolean
  batch?: number
  counts?: Readonly<Record<string, number | null>>
}

type Label = Workspace['labels'][number]
/* A place in the list, just after the label with this name_lower, time
   and id. */
type Position = { key: string; created: string; id: string }

const LIST = 'labels.settings'
const NOT_A_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same search'

/* -1, 0 or 1 as position `a` sorts before, with or after `b`. */
function compare(a: Position, b: Position): number {
  const byKey = compareValues(a.key, b.key)
  if (byKey !== 0) return byKey
  if (a.created !== b.created) return a.created < b.created ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const positionOf = (label: Label): Position => ({
  key: label.name_lower,
  created: label.created_at ?? '',
  id: label.id,
})

/**
 * What labels.settingsPage answers for `args` while the server holds
 * `workspace`, read by the caller the workspace belongs to. Throws as the
 * server refuses: a caller who is not an active admin of the organization,
 * a search past LIMITS.search and a cursor this list did not give for the
 * organization and search.
 */
export function labelSettingsStandIn(
  workspace: Pick<Workspace, 'myProfileIds' | 'profiles' | 'labels' | 'issueLabels' | 'issues'>,
  args: LabelPageArgs,
  options: { force?: ForcedLabelPage } = {},
): LabelPageAnswer {
  const force = options.force ?? {}
  const me = workspace.profiles.find(
    (p) => p.org_id === args.org_id && workspace.myProfileIds.includes(p.id),
  )
  if (me?.org_role !== 'admin' || me.active === false)
    throw new ConvexError({
      code: 'forbidden',
      message: 'only organization admins see the label list with its usage',
    })
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  if (force.fail) throw new Error('the label list fails, as the stand-in was asked')
  const scope = [args.org_id, nameKey(search)]
  const seal = (at: Position) => JSON.stringify([LIST, scope, [at.key, at.created, at.id]])
  const open = (text: string | undefined): Position | null => {
    if (text === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const [list, of, at] = Array.isArray(parsed) ? parsed : []
    const [key, created, id] = Array.isArray(at) ? at : []
    if (
      list !== LIST ||
      JSON.stringify(of) !== JSON.stringify(scope) ||
      typeof key !== 'string' ||
      typeof created !== 'string' ||
      typeof id !== 'string'
    )
      throw new ConvexError({ code: 'bad_request', message: NOT_A_CURSOR })
    return { key, created, id }
  }
  const after = open(args.after)
  const through = open(args.through)
  if (after !== null && through !== null && compare(through, after) <= 0)
    throw new ConvexError({
      code: 'bad_request',
      message: 'through must be a cursor after the one in after',
    })

  const counting = force.counting === true
  // each label's active tasks, which are its assignments on the
  // workspace's tasks, each task once
  const tasks = new Set(workspace.issues.filter((t) => t.org_id === args.org_id).map((t) => t.id))
  const carried = new Map<string, Set<string>>()
  for (const { issue_id, label_id } of workspace.issueLabels) {
    if (!tasks.has(issue_id)) continue
    const on = carried.get(label_id) ?? new Set<string>()
    on.add(issue_id)
    carried.set(label_id, on)
  }
  const row = (label: Label): SettingsLabelRow => ({
    id: label.id,
    name: label.name,
    color: label.color,
    active_tasks:
      force.counts && label.id in force.counts
        ? (force.counts[label.id] ?? null)
        : counting
          ? null
          : (carried.get(label.id)?.size ?? 0),
  })

  const labels = workspace.labels
    .filter((l) => l.org_id === args.org_id)
    .sort((a, b) => compare(positionOf(a), positionOf(b)))
  const named = search === '' ? null : labels.find((l) => l.name_lower === search.toLowerCase())
  const exact = named ? row(named) : null
  const matches = allWordsMatcher(nameKey(search))
  const size = force.batch ?? LIST_BATCH
  const limit = through === null ? size : 4 * size
  const rows: SettingsLabelRow[] = []
  let at: Position | null = after
  let read = 0
  const answer = (next: Position | null, stopped: boolean): LabelPageAnswer => ({
    rows,
    next: next === null ? null : seal(next),
    stopped,
    exact,
    counting,
  })
  for (const label of labels) {
    const position = positionOf(label)
    if (after !== null && compare(position, after) <= 0) continue
    // a batch kept live between two cursors ends at its own
    if (through !== null && compare(position, through) > 0) return answer(through, false)
    // a full batch reads one label more, so a batch that ends with the
    // list says so; past four batches a pinned one stops short of its end
    if (rows.length >= limit && at !== null)
      return answer(at, through !== null && compare(at, through) < 0)
    if (force.stop !== undefined && through === null && read >= Math.max(1, force.stop) && at)
      return answer(at, true)
    read++
    at = position
    if (matches(nameKey(label.name))) rows.push(row(label))
  }
  return answer(null, false)
}

/** Answers a test double's subscription to labels:settingsPage with
    `args` over `workspace` through `next`, or through `fail` where the
    stand-in refuses, as answerOverview answers the Overview's. */
export function answerLabelPages(
  workspace: Parameters<typeof labelSettingsStandIn>[0],
  args: unknown,
  next: (value: unknown) => void,
  fail?: (error: unknown) => void,
  options?: { force?: ForcedLabelPage },
) {
  let answer: LabelPageAnswer
  try {
    answer = labelSettingsStandIn(workspace, args as LabelPageArgs, options)
  } catch (error) {
    fail?.(error)
    return
  }
  next(structuredClone(answer))
}
