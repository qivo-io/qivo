/* Stand-ins for the label reads (convex/labels.ts settingsPage, picker and
   byIds) that answer from a workspace the app holds, for the jsdom tests
   and the browser benchmark's server (scripts/perf/server.mjs), as
   store/overviewStandIn.setup.ts answers the Overview.

   Settings › Labels' live query and the task label picker's read share one
   batch reader (labelListStandIn), which applies the server's rules
   (convex/model/labels.ts labelBatch) to the workspace's labels: the
   organization's labels in the order of name_lower as Convex compares
   values (strings by their UTF-8 bytes, not by localeCompare), then the
   time each was made and its id, where the server ties by creation time
   and _id; the search over every label, each whitespace-separated fragment
   of it in the name in any order, ignoring case and accents
   (convex/lib/search.ts over convex/lib/nameKey.ts); at most LIST_BATCH
   labels a batch, or with `through` every match up to and including it,
   stopping past four batches; and `next`, `stopped` and `exact` as the
   server answers them.

   - labelSettingsStandIn answers only an active admin of the organization,
     with each label's count of active tasks. It counts the workspace's
     tasks, which leave out tasks in archived projects that the server's
     counts hold (convex/model/labelCounts.ts), so a test that compares
     counts keeps its labelled tasks in live projects.
   - labelPickerStandIn answers any active seat, with `can_create` in a
     first batch: true for an admin, false for a guest or a viewer, and for
     a user what `force` says, true by default, so no copy of the server's
     rights rule (convex/lib/access.ts canWriteOrgLabels) lives here.
   - labelsByIdsStandIn answers the organization's labels among up to
     BY_IDS_MAX ids, each once, in the order asked.

   The workspace given to a stand-in is what the server holds, which may
   hold labels the app's catalogue was not sent, so the reads answer
   labels the store does not hold.

   Cursors are plain JSON of the list, the organization, the search's name
   key and the position, so equal positions give equal text, as the
   server's sealed cursors do, and a cursor of another list, organization
   or search is refused with bad_request. The stand-ins read no read
   budget, so a stopped batch, a count being prepared, a count not yet
   made, a failure, a smaller batch or a check that could not finish
   answer only when `force` asks for them. src/store/labelPagesParity.test.ts
   compares them with the real queries. It imports nothing the
   benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { BY_IDS_MAX, LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { LabelBatch, LabelRow, SettingsLabelRow } from '../../convex/model/labels'

/** What labels.settingsPage answers. */
export type LabelPageAnswer = LabelBatch<SettingsLabelRow> & { counting: boolean }

/** What labels.picker answers. */
export type LabelPickerAnswer = LabelBatch<LabelRow> & { can_create?: boolean | null }

/** What labels.settingsPage and labels.picker are asked. */
export type LabelPageArgs = {
  org_id: string
  search?: string
  after?: string
  through?: string
}

/** What labels.byIds is asked. */
export type LabelsByIdsArgs = { org_id: string; ids: readonly string[] }

/** States the stand-ins answer whatever the workspace says: the counts
    being prepared (`counting`), an open batch whose read stops after this
    many labels (`stop`, at least one, as the server always reads its
    first), a read that fails (`fail`), a smaller batch (`batch`), counts
    by label id, a number or null for one not counted (`counts`), and the
    picker's `can_create` for any seat (`canCreate`, which the server
    answers null only when its check could not finish). */
export type ForcedLabelPage = {
  counting?: boolean
  stop?: number
  fail?: boolean
  batch?: number
  counts?: Readonly<Record<string, number | null>>
  canCreate?: boolean | null
}

type Label = Workspace['labels'][number]
/** The parts of a workspace the label reads look at. */
type LabelWorkspace = Pick<
  Workspace,
  'myProfileIds' | 'profiles' | 'labels' | 'issueLabels' | 'issues'
>
/* A place in the list, just after the label with this name_lower, time
   and id. */
type Position = { key: string; created: string; id: string }

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

/* The caller's active seat in the organization, or the server's refusal
   of a login without one. */
function seatIn(workspace: Pick<Workspace, 'myProfileIds' | 'profiles'>, orgId: string) {
  const me = workspace.profiles.find(
    (p) => p.org_id === orgId && workspace.myProfileIds.includes(p.id),
  )
  if (!me || me.active === false)
    throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  return me
}

/**
 * One batch of list `list` of the organization's labels for `args`, each
 * label's row from `row`, by the server's rules (labelBatch). Throws as the
 * server refuses a search past LIMITS.search and a cursor this list did not
 * give for the organization and search.
 */
function labelListStandIn<Row>(
  workspace: LabelWorkspace,
  args: LabelPageArgs,
  o: { list: string; row: (label: Label) => Row; force: ForcedLabelPage },
): LabelBatch<Row> {
  const { force } = o
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  if (force.fail) throw new Error('the label list fails, as the stand-in was asked')
  const scope = [args.org_id, nameKey(search)]
  const seal = (at: Position) => JSON.stringify([o.list, scope, [at.key, at.created, at.id]])
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
      list !== o.list ||
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

  const labels = workspace.labels
    .filter((l) => l.org_id === args.org_id)
    .sort((a, b) => compare(positionOf(a), positionOf(b)))
  const named = search === '' ? null : labels.find((l) => l.name_lower === search.toLowerCase())
  const exact = named ? o.row(named) : null
  const matches = allWordsMatcher(nameKey(search))
  const size = force.batch ?? LIST_BATCH
  const limit = through === null ? size : 4 * size
  const rows: Row[] = []
  let at: Position | null = after
  let read = 0
  const answer = (next: Position | null, stopped: boolean): LabelBatch<Row> => ({
    rows,
    next: next === null ? null : seal(next),
    stopped,
    exact,
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
    if (matches(nameKey(label.name))) rows.push(o.row(label))
  }
  return answer(null, false)
}

/** A label as the picker and labels.byIds answer it. */
const labelRow = (label: Label): LabelRow => ({
  id: label.id,
  name: label.name,
  color: label.color,
})

/**
 * What labels.settingsPage answers for `args` while the server holds
 * `workspace`, read by the caller the workspace belongs to. Throws as the
 * server refuses: a caller who is not an active admin of the organization,
 * a search past LIMITS.search and a cursor this list did not give for the
 * organization and search.
 */
export function labelSettingsStandIn(
  workspace: LabelWorkspace,
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
    ...labelRow(label),
    active_tasks:
      force.counts && label.id in force.counts
        ? (force.counts[label.id] ?? null)
        : counting
          ? null
          : (carried.get(label.id)?.size ?? 0),
  })
  const batch = labelListStandIn(workspace, args, { list: 'labels.settings', row, force })
  return { ...batch, counting }
}

/**
 * What labels.picker answers for `args` while the server holds
 * `workspace`, read by the caller the workspace belongs to: any active
 * seat of the organization, guests and viewers included, with
 * `can_create` in a first batch (no `after`). Throws as the server
 * refuses a login without a seat, a search past LIMITS.search and a cursor
 * this list did not give for the organization and search.
 */
export function labelPickerStandIn(
  workspace: LabelWorkspace,
  args: LabelPageArgs,
  options: { force?: ForcedLabelPage } = {},
): LabelPickerAnswer {
  const force = options.force ?? {}
  const me = seatIn(workspace, args.org_id)
  const batch = labelListStandIn(workspace, args, { list: 'labels.picker', row: labelRow, force })
  if (args.after !== undefined) return batch
  const can_create =
    force.canCreate !== undefined
      ? force.canCreate
      : me.org_role === 'admin'
        ? true
        : me.org_role === 'user'
  return { ...batch, can_create }
}

/**
 * What labels.byIds answers for `args` while the server holds `workspace`:
 * the organization's labels among the ids, each once, in the order asked,
 * leaving out unknown, deleted and foreign ids alike. Throws as the server
 * refuses a login without a seat and more than BY_IDS_MAX ids, counted as
 * sent, and fails with `force.fail`.
 */
export function labelsByIdsStandIn(
  workspace: Pick<Workspace, 'myProfileIds' | 'profiles' | 'labels'>,
  args: LabelsByIdsArgs,
  options: { force?: Pick<ForcedLabelPage, 'fail'> } = {},
): { rows: LabelRow[] } {
  seatIn(workspace, args.org_id)
  if (args.ids.length > BY_IDS_MAX)
    throw new ConvexError({
      code: 'bad_request',
      message: `ids must name at most ${BY_IDS_MAX} labels`,
    })
  if (options.force?.fail) throw new Error('the label lookup fails, as the stand-in was asked')
  const byId = new Map(workspace.labels.map((label) => [label.id, label]))
  return {
    rows: [...new Set(args.ids)].flatMap((id) => {
      const label = byId.get(id)
      return label && label.org_id === args.org_id ? [labelRow(label)] : []
    }),
  }
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
