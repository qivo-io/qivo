/* A stand-in for the task window's relation pickers' read
   (convex/taskWindow.ts relationCandidates) that answers from a workspace
   the app holds, for the browser benchmark's server
   (scripts/perf/server.mjs), as store/labelPagesStandIn.setup.ts answers
   Settings › Labels.

   It applies the reader's rules (convex/lib/relationPicker.ts) to the
   workspace's tasks, every one shown to the person, as the benchmark's
   task window reads assume, at the person's one `level`: the opened
   task's own block as a code with no row; the scope in the reader's
   order, the opened task's own sub-project, the family's other live
   sub-projects by creation and then its top-level project, and for
   Linked tasks after Search all your projects (`all_projects`) the
   organization's other live top-level projects, each with its live
   sub-projects by creation and then itself; each project's tasks by
   creation; never the opened task or its current parent, subtasks or
   linked tasks; the Parent picker's tasks without a parent and with room
   for one more subtask, and the Subtasks picker's tasks without
   subtasks, with their parent pair; every fragment of the search in the
   task's ID or title (convex/lib/search.ts allWordsMatcher); a search that
   is one task ID answers that task first, marked `exact`, and every later
   batch leaves it out; at most RELATION_PICKER.rows tasks a batch.

   Its cursors are plain JSON of the picker, the task, the search, the
   phase and the place in the scope, and one of another picker, task or
   search is refused with bad_request. It reads no read budget, so a
   stopped batch, a failure, an unavailable or over-budget answer or a
   smaller batch answer only when `force` asks for them. It imports nothing
   the benchmark's worker cannot load. */

import { ConvexError } from 'convex/values'
import { LIMITS, overText } from '../../convex/lib/limits'
import type {
  RelationArgs,
  RelationBlock,
  RelationCandidate,
  RelationCandidates,
} from '../../convex/lib/relationPicker'
import { allWordsMatcher } from '../../convex/lib/search'
import { issueKey, parseIssueRef } from '../../convex/lib/taskRefs'
import type { Workspace } from '../../convex/lib/workspaceJoin'

/** States the stand-in answers whatever the workspace says: a batch whose
    scan stops after this many tasks (`stop`), a read that fails (`fail`),
    an opened task the person may not open (`unavailable`), a request past
    the picker's budget (`over`), a smaller batch (`rows`), and the opened
    task's own block (`blocked`), as for subtasks the window cannot see:
    has_subtasks for Parent, full for Subtasks and Linked tasks. */
export type ForcedRelations = {
  stop?: number
  fail?: boolean
  unavailable?: boolean
  over?: boolean
  rows?: number
  blocked?: boolean
}

type Task = Workspace['issues'][number]
type Project = Workspace['projects'][number]
/* Where a batch starts: the phase, the family or all your projects, and
   how many tasks of that phase's scope earlier batches looked at. */
type Place = { phase: 'family' | 'all'; at: number }

/* The reader's batch (convex/lib/relationPicker.ts RELATION_PICKER.rows). */
const ROWS = 25
const NOT_A_CURSOR = 'This list changed. Search again to go on.'

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byCreation = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  order(a.created_at, b.created_at) || order(a.id, b.id)

/**
 * What taskWindow.relationCandidates answers for `args` over workspace
 * `snap`, for a person at `o.level` on every project, with `o.force`'s
 * states.
 */
export function relationPickerStandIn(
  snap: Workspace,
  args: RelationArgs & { org_id: string },
  o: { level?: RelationCandidate['level']; force?: ForcedRelations } = {},
): RelationCandidates {
  const force = o.force ?? {}
  const level = o.level ?? 'user'
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  if (force.fail) throw new Error('the relation picker fails, as relations=failed asks')
  const key = JSON.stringify([args.kind, args.issue_id, search])
  let place: Place = { phase: 'family', at: 0 }
  let typedTaken = false
  if (args.cursor !== undefined) {
    const read = (() => {
      try {
        return JSON.parse(args.cursor) as [string, Place, boolean]
      } catch {
        return null
      }
    })()
    if (!read || read[0] !== key)
      throw new ConvexError({ code: 'bad_request', message: NOT_A_CURSOR })
    place = read[1]
    typedTaken = read[2]
    if (place.phase === 'all' && args.kind !== 'link')
      throw new ConvexError({ code: 'bad_request', message: NOT_A_CURSOR })
  }
  const task = snap.issues.find((row) => row.id === args.issue_id && row.org_id === args.org_id)
  const projects = new Map(snap.projects.map((p) => [p.id, p]))
  const home = task ? projects.get(task.project_id) : undefined
  if (!task || !home || home.archived_at || force.unavailable) return { state: 'unavailable' }
  if (force.over) return { state: 'over_budget' }

  const kids = snap.issues.filter((row) => row.parent_id === task.id)
  const linked = new Set(
    snap.links.flatMap((l) =>
      l.source_id === task.id ? [l.target_id] : l.target_id === task.id ? [l.source_id] : [],
    ),
  )
  const block: RelationBlock | null = force.blocked
    ? args.kind === 'parent'
      ? 'has_subtasks'
      : 'full'
    : args.kind === 'parent'
      ? kids.length > 0 || task.has_hidden_subtasks
        ? 'has_subtasks'
        : null
      : args.kind === 'subtask'
        ? task.parent_id || task.has_hidden_parent
          ? 'is_subtask'
          : kids.length >= LIMITS.subtasks.max
            ? 'full'
            : null
        : linked.size >= LIMITS.links.max
          ? 'full'
          : null
  if (block)
    return { state: 'ok', rows: [], next: null, all_projects: null, stopped: false, blocked: block }

  // the scope: the family, and for Linked tasks the organization's other
  // top-level projects after Search all your projects
  const live = (p: Project) => !p.archived_at && p.org_id === task.org_id
  const top = home.parent_id ? projects.get(home.parent_id) : home
  const subsOf = (parent: Project) =>
    snap.projects.filter((p) => p.parent_id === parent.id && live(p)).sort(byCreation)
  const family: Project[] = top
    ? [home, ...subsOf(top).filter((p) => p.id !== home.id), ...(top.id === home.id ? [] : [top])]
    : [home]
  const others: Project[] =
    args.kind === 'link' && top
      ? snap.projects
          .filter((p) => !p.parent_id && p.type === 'meta' && live(p) && p.id !== top.id)
          .sort(byCreation)
          .flatMap((p) => [...subsOf(p), p])
      : []
  const scopeOf = (list: readonly Project[]) =>
    list.flatMap((p) => snap.issues.filter((row) => row.project_id === p.id).sort(byCreation))
  const scope = scopeOf(place.phase === 'family' ? family : others)
  const parents = new Set(snap.issues.flatMap((row) => (row.parent_id ? [row.parent_id] : [])))
  const activeKids = (id: string) => snap.issues.filter((row) => row.parent_id === id).length

  const eligible = (row: Task) => {
    if (row.id === task.id || row.id === task.parent_id || row.parent_id === task.id) return false
    if (linked.has(row.id)) return false
    if (args.kind === 'parent')
      return !row.parent_id && !row.has_hidden_parent && activeKids(row.id) < LIMITS.subtasks.max
    if (args.kind === 'subtask') return !parents.has(row.id) && !row.has_hidden_subtasks
    return true
  }
  const shortOf = (row: Task, exact?: boolean): RelationCandidate => {
    const {
      description: _text,
      parent_id: parent,
      has_hidden_parent: hidden,
      has_hidden_subtasks: _hiddenKids,
      ...fields
    } = row
    return {
      ...fields,
      level,
      ...(args.kind === 'subtask'
        ? hidden
          ? { has_hidden_parent: true }
          : parent
            ? { parent_id: parent }
            : {}
        : {}),
      ...(exact ? { exact: true as const } : {}),
    }
  }
  const matches = allWordsMatcher(search)
  const rows: RelationCandidate[] = []
  const most = force.rows ?? ROWS
  // a search that is one task ID answers that task first, in the first
  // batch only, and every later batch leaves it out
  const named = parseIssueRef(search)
  const typedNum = named && 'num' in named ? named.num : null
  if (typedNum !== null && place.at === 0 && place.phase === 'family') {
    const found = snap.issues.find((row) => row.org_id === task.org_id && row.num === typedNum)
    const reach = args.kind === 'link' ? [...family, ...others] : family
    if (found && reach.some((p) => p.id === found.project_id) && eligible(found)) {
      rows.push(shortOf(found, true))
      typedTaken = true
    }
  }
  let at = place.at
  let looked = 0
  let stopped = false
  while (at < scope.length && rows.length < most) {
    if (force.stop !== undefined && looked >= force.stop) {
      stopped = true
      break
    }
    const row = scope[at]
    at++
    looked++
    if (typedTaken && row.num === typedNum) continue
    if (!eligible(row) || !matches(`${issueKey(row.num)}\n${row.title}`)) continue
    rows.push(shortOf(row))
  }
  const cursor = (next: Place) => JSON.stringify([key, next, typedTaken])
  const more = at < scope.length
  return {
    state: 'ok',
    rows,
    next: more ? cursor({ phase: place.phase, at }) : null,
    all_projects:
      !more && place.phase === 'family' && args.kind === 'link' && others.length > 0
        ? cursor({ phase: 'all', at: 0 })
        : null,
    stopped,
    blocked: null,
  }
}
