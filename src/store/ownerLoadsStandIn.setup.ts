/* A stand-in for planning.ownerLoads (convex/planning.ts) that answers from
   a workspace the app holds, for the jsdom Board fixture
   (src/views/boardFixture.setup.tsx) and the browser benchmark's server
   (scripts/perf/server.mjs).

   Each owner's spans are the workspace's tasks of the organization filed
   through the server's fence (convex/lib/loadRows.ts loadRowFor), each
   with its task's project, and the workspace's own load rows of tasks the
   person is not shown (orgLoad, without a task id or project), in the
   server's total order (convex/lib/ownerLoads.ts byLoadRow, repeated here,
   as the benchmark's worker cannot load the reader). Each owner's `paused`
   list is the workspace's paused tasks of the organization they own
   (convex/lib/review.ts taskOwnerId) that are scheduled, not Done, not
   archived, not groups and in a live project, Backlog ones included, by
   weeks and then task id as the server orders them (repeated here too).
   The workspace holds only tasks of live projects the person can see, so
   that list needs no check of sight. A guest or Viewer gets the first
   owner of a call and `not_read` for the rest, as the server answers them.
   It reads no bounds, so an owner is `unavailable` only when `unavailable`
   names them. src/store/boardParity.test.ts and
   src/store/roadmapParity.test.ts compare it with the real query. */

import { loadRowFor, type OrgLoadRow } from '../../convex/lib/loadRows'
import { taskOwnerId } from '../../convex/lib/review'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { OwnerLoadSpan, OwnerLoadsJson, OwnerPausedSpan } from '../../convex/planning'

/** The arguments planning.ownerLoads takes. */
export type OwnerLoadsArgs = { org_id: string; owner_ids: string[] }

/* The server's total order of load rows (convex/lib/ownerLoads.ts
   byLoadRow): by weeks, the measurement, the hours, then the task id, a
   hidden row's null first. */
function byLoadRow(a: OwnerLoadSpan, b: OwnerLoadSpan): number {
  const keys = (r: OwnerLoadSpan) => [r.start_week, r.end_week, r.remaining_set_at ?? '']
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++)
    if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1
  if (a.remaining !== b.remaining) return a.remaining - b.remaining
  if (a.issue_id === b.issue_id) return 0
  if (a.issue_id === null) return -1
  if (b.issue_id === null) return 1
  return a.issue_id < b.issue_id ? -1 : 1
}

/* The server's order of paused spans (convex/planning.ts byPausedSpan): by
   weeks, then the task id. */
function byPausedSpan(a: OwnerPausedSpan, b: OwnerPausedSpan): number {
  const keys = (r: OwnerPausedSpan) => [r.start_week, r.end_week, r.issue_id]
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++)
    if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1
  return 0
}

/* A load row without its owner, as a span of a task in `project_id`. */
const spanOf = (
  { owner_id: _owner, ...span }: OrgLoadRow,
  project_id: string | null,
): OwnerLoadSpan => ({ ...span, project_id })

/** What planning.ownerLoads answers `args` for the person `workspace` is
    the workspace of. */
export function ownerLoadsStandIn(
  workspace: Workspace,
  args: OwnerLoadsArgs,
  { unavailable = [] }: { unavailable?: readonly string[] } = {},
): OwnerLoadsJson {
  const mine = new Set(workspace.myProfileIds)
  const me = workspace.profiles.find((p) => p.org_id === args.org_id && mine.has(p.id))
  const staff = me?.org_role === 'admin' || me?.org_role === 'user'
  const projects = new Map(workspace.projects.map((p) => [p.id, p]))
  const orgOf = new Map(workspace.profiles.map((p) => [p.id, p.org_id]))
  const parents = new Set(workspace.issues.map((t) => t.parent_id).filter(Boolean))
  // every task of the organization the workspace holds, through the fence,
  // and its paused leaves
  const shown: { owner: string; span: OwnerLoadSpan }[] = []
  const paused: { owner: string; span: OwnerPausedSpan }[] = []
  for (const task of workspace.issues) {
    if (task.org_id !== args.org_id) continue
    const project = projects.get(task.project_id)
    const isGroup = parents.has(task.id) || task.has_hidden_subtasks
    const projectLive = !!project && project.archived_at === undefined
    const row = loadRowFor(task, {
      isGroup,
      projectLive,
      ownerInOrg: (id) => orgOf.get(id) === args.org_id,
      visible: true,
      staff,
      meId: me?.id ?? '',
    })
    if (row !== null) shown.push({ owner: row.owner_id, span: spanOf(row, task.project_id) })
    const owner = taskOwnerId(task)
    if (
      task.paused &&
      !isGroup &&
      projectLive &&
      task.status !== 'done' &&
      task.archived_at === undefined &&
      task.start_week !== undefined &&
      task.end_week !== undefined &&
      owner !== undefined &&
      orgOf.get(owner) === args.org_id
    )
      paused.push({
        owner,
        span: {
          issue_id: task.id,
          project_id: task.project_id,
          start_week: task.start_week,
          end_week: task.end_week,
        },
      })
  }
  const ids = [...new Set(args.owner_ids.map((id) => id.toLowerCase()))]
  const owners: OwnerLoadsJson['owners'] = ids.map((owner_id, i) => {
    if (!staff && i > 0) return { owner_id, state: 'not_read' }
    if (unavailable.includes(owner_id)) return { owner_id, state: 'unavailable' }
    const spans = [
      ...shown.filter((one) => one.owner === owner_id).map((one) => one.span),
      ...workspace.orgLoad
        .filter((row) => row.owner_id === owner_id && row.issue_id === null)
        .map((row) => spanOf(row, null)),
    ].sort(byLoadRow)
    const own = paused
      .filter((one) => one.owner === owner_id)
      .map((one) => one.span)
      .sort(byPausedSpan)
    return { owner_id, state: 'ok', spans, paused: own }
  })
  return { hidden: staff ? 'counted' : 'own_only', owners }
}
