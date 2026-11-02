/* A stand-in for planning.ownerLoads (convex/planning.ts) that answers from
   a workspace the app holds, for the jsdom Board fixture
   (src/views/boardFixture.setup.tsx) and the browser benchmark's server
   (scripts/perf/server.mjs).

   Each owner's spans are the workspace's tasks of the organization filed
   through the server's fence (convex/lib/loadRows.ts loadRowFor) and the
   workspace's own load rows of tasks the person is not shown (orgLoad,
   without a task id), in the server's total order (convex/lib/ownerLoads.ts
   byLoadRow, repeated here, as the benchmark's worker cannot load the
   reader). A guest or Viewer gets the first owner of a call and `not_read`
   for the rest, as the server answers them. It reads no bounds, so an
   owner is `unavailable` only when `unavailable` names them.
   src/store/boardParity.test.ts compares it with the real query. */

import { loadRowFor, type OrgLoadRow } from '../../convex/lib/loadRows'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { OwnerLoadSpan, OwnerLoadsJson } from '../../convex/planning'

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

/* A load row without its owner, as a span. */
const spanOf = ({ owner_id: _owner, ...span }: OrgLoadRow): OwnerLoadSpan => span

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
  // every task of the organization the workspace holds, through the fence
  const shown: OrgLoadRow[] = []
  for (const task of workspace.issues) {
    if (task.org_id !== args.org_id) continue
    const project = projects.get(task.project_id)
    const row = loadRowFor(task, {
      isGroup: parents.has(task.id) || task.has_hidden_subtasks,
      projectLive: !!project && project.archived_at === undefined,
      ownerInOrg: (id) => orgOf.get(id) === args.org_id,
      visible: true,
      staff,
      meId: me?.id ?? '',
    })
    if (row !== null) shown.push(row)
  }
  const ids = [...new Set(args.owner_ids.map((id) => id.toLowerCase()))]
  const owners: OwnerLoadsJson['owners'] = ids.map((owner_id, i) => {
    if (!staff && i > 0) return { owner_id, state: 'not_read' }
    if (unavailable.includes(owner_id)) return { owner_id, state: 'unavailable' }
    const spans = [
      ...shown.filter((row) => row.owner_id === owner_id),
      ...workspace.orgLoad.filter((row) => row.owner_id === owner_id && row.issue_id === null),
    ]
      .map(spanOf)
      .sort(byLoadRow)
    return { owner_id, state: 'ok', spans }
  })
  return { hidden: staff ? 'counted' : 'own_only', owners }
}
