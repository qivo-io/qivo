/* A stand-in for the removal window's two server reads,
   accessRemovals.preview and accessRemovals.reassignChoices
   (convex/model/removalPreview.ts), that answers from a workspace the app
   holds, for the browser benchmark's server (scripts/perf/server.mjs) and
   its screenshots of states a seeded backend cannot reach inside the
   design size.

   It does not apply the server's rules. It takes as lost holdings the open
   tasks in the projects the change reaches (a grant's project and, for a
   top-level one, its sub-projects; a team's shared projects and their
   sub-projects) that one of the people losing access is assigned to or
   reviews, without asking whether another grant still shows the task, and
   lists every active admin, user and guest of the organization but those
   people as the people who could take them, without asking whether they
   could. Asked with a chosen person (`reassign_to`), the preview answers
   reassign.holder_eligible by that same rule, false while Reassign is
   refused, as the server does. The caller may make every choice, unless
   `force` says otherwise.
   The picker answers LIST_BATCH people a batch in name order, with the
   search's every word anywhere in the name, ignoring case and accents, and
   a cursor that is the position as text. It imports nothing the benchmark's
   worker cannot load. */

import { LIMITS, LIST_BATCH } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { RemovalChange } from '../../convex/model/removalPreview'
import type { Whole } from './guard/liveDouble.setup'
import type { RemovalPreview } from './planner'

/** The states the stand-in answers whatever the workspace says, as the
    perf page's `removal` parameter names them:
    - `many`, forty more tasks than it lists, so the window says "and 40
      more tasks", and Reassign refused as past LIMITS.reassign.max, where
      the server lists fewer tasks than it counts;
    - `over`, Reassign refused with LIMITS.reassign's sentence;
    - `capped`, both choices refused with LIMITS.removalHolders' sentence;
    - `too_large` and `refused`, those answers;
    - `leave_only`, an admin's removal while the organization is read-only;
    - `unsettled`, a caller who may make neither choice, for the notice;
    - `keep-only`, a caller who may keep the people as Viewers but not
      reassign the tasks, as an organization admin who manages a project
      without Edit on its tasks, Reassign refused with NO_WRITE_ACCESS;
    - `slow`, both reads answer after two seconds (the perf server waits);
    - for the picker `choices-stopped` (each batch stops after half a
      batch), `choices-not-ready` and `choices-error` (every batch fails). */
export type ForcedRemoval = ReadonlySet<string>

/* The sentences the server answers with, which the worker cannot import
   from its model code (convex/model/projectAccess.ts REMOVAL_FULL,
   convex/lib/access.ts NO_USER_MANAGEMENT, convex/model/issues.ts
   NO_WRITE_ACCESS, convex/lib/billingAccess.ts BILLING_READ_ONLY). */
const REMOVAL_FULL =
  "a removal can check only as many people and tasks as fit in one request, so remove fewer people at once, such as some of a team's members, or reassign some of the tasks first"
const NO_USER_MANAGEMENT = 'no permission to manage users on this project'
const NO_WRITE_ACCESS = 'no write access to this project'
const READ_ONLY =
  'This organization is read-only. An organization admin can subscribe or update payment details in Billing.'

/* The organization `change` names a project or team of. */
function orgOf(snapshot: Whole, change: RemovalChange): string | undefined {
  return 'project_id' in change
    ? snapshot.projects.find((p) => p.id === change.project_id)?.org_id
    : snapshot.teams.find((t) => t.id === change.team_id)?.org_id
}

/* The people `change` takes access from. */
function losing(snapshot: Whole, change: RemovalChange): Set<string> {
  if ('user_id' in change) return new Set([change.user_id])
  return new Set(
    snapshot.teamMembers.filter((m) => m.team_id === change.team_id).map((m) => m.profile_id),
  )
}

/* Whether `profile` could take the tasks in the stand-in's rule: an active
   admin, user or guest of organization `org` who is not one of `people`,
   those who lose sight of a task. The picker lists them, and a chosen
   person's holder_eligible answers it. */
const canTake = (
  profile: Whole['profiles'][number],
  org: string | undefined,
  people: ReadonlySet<string>,
) =>
  profile.org_id === org &&
  profile.active &&
  ['admin', 'user', 'guest'].includes(profile.org_role) &&
  !people.has(profile.id)

/* The projects `change` reaches, with the project Keep as Viewer would
   grant Viewer on for each. */
function reached(snapshot: Whole, change: RemovalChange): Map<string, string> {
  const out = new Map<string, string>()
  const add = (id: string) => {
    out.set(id, id)
    for (const sub of snapshot.projects)
      if (sub.parent_id === id && !out.has(sub.id)) out.set(sub.id, id)
  }
  if ('project_id' in change) add(change.project_id)
  else
    for (const share of snapshot.teamAccess)
      if (share.team_id === change.team_id) add(share.project_id)
  return out
}

/** accessRemovals.preview's answer for `change`, from the workspace, as the
    module header says, with reassign.holder_eligible for `reassignTo` when
    it is given. */
export function removalPreviewStandIn(
  snapshot: Whole,
  change: RemovalChange,
  force: ForcedRemoval,
  reassignTo?: string,
): RemovalPreview {
  if (force.has('too_large')) return { state: 'too_large', message: REMOVAL_FULL }
  if (force.has('refused')) return { state: 'refused', message: NO_USER_MANAGEMENT }
  const org = orgOf(snapshot, change)
  if (org === undefined) return { state: 'unavailable' }
  const people = losing(snapshot, change)
  const where = reached(snapshot, change)
  const lost = snapshot.issues
    .filter((t) => t.status !== 'done' && where.has(t.project_id))
    .flatMap((t) =>
      (['assignee', 'reviewer'] as const).flatMap((role) => {
        const holder = role === 'assignee' ? t.assignee_id : t.reviewer_id
        return holder !== undefined && people.has(holder) ? [{ t, role, holder }] : []
      }),
    )
    .sort((a, b) => a.t.num - b.t.num || a.role.localeCompare(b.role))
  const tasks = new Set(lost.map((h) => h.t.id))
  const listed: typeof lost = []
  const seen = new Set<string>()
  for (const h of lost) {
    if (!seen.has(h.t.id) && seen.size === LIMITS.reassign.max) break
    seen.add(h.t.id)
    listed.push(h)
  }
  const holders = [...new Set(lost.map((h) => h.holder))]
    .flatMap((id) => snapshot.profiles.find((p) => p.id === id) ?? [])
    .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)))
  const targets = [...new Set(lost.map((h) => where.get(h.t.project_id) as string))]
  const extra = force.has('many') ? 40 : 0
  const count = tasks.size + extra
  const tooMany = count > LIMITS.reassign.max || force.has('over') || force.has('many')
  const capped = force.has('capped')
  const leaveOnly = force.has('leave_only')
  const unsettled = force.has('unsettled')
  const keepOnly = force.has('keep-only')
  const keepRefusal = leaveOnly
    ? READ_ONLY
    : capped
      ? LIMITS.removalHolders.refusal
      : unsettled
        ? NO_USER_MANAGEMENT
        : null
  const reassignRefusal = leaveOnly
    ? READ_ONLY
    : capped
      ? LIMITS.removalHolders.refusal
      : tooMany
        ? LIMITS.reassign.refusal
        : unsettled || keepOnly
          ? NO_WRITE_ACCESS
          : null
  const taker = snapshot.profiles.find((p) => p.id === reassignTo)
  return {
    state: 'ok',
    pending: true,
    leave_only: leaveOnly,
    people: holders.map((p) => ({ id: p.id, name: p.name, kind: p.kind, org_role: p.org_role })),
    tasks: count,
    items: listed.map((h) => ({
      task_id: h.t.id,
      num: h.t.num,
      title: h.t.title,
      project_id: h.t.project_id,
      holder_id: h.holder,
      role: h.role,
    })),
    items_total: lost.length + extra,
    hidden: 0,
    projects: snapshot.projects
      .filter((p) => targets.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, key: p.key, parent_id: p.parent_id ?? null })),
    keep: {
      targets,
      changers: [],
      allowed: keepRefusal === null,
      refusal: keepRefusal,
      offered: true,
      permitted: !unsettled,
    },
    reassign: {
      allowed: reassignRefusal === null,
      refusal: reassignRefusal,
      permitted: !unsettled && !keepOnly,
      ...(reassignTo === undefined
        ? {}
        : {
            holder_eligible:
              reassignRefusal === null &&
              taker !== undefined &&
              canTake(taker, org, new Set(holders.map((p) => p.id))),
          }),
    },
  }
}

/** accessRemovals.reassignChoices' answer for `args`, from the workspace,
    as the module header says. */
export function reassignChoicesStandIn(
  snapshot: Whole,
  args: { change: RemovalChange; search?: string; after?: string },
  force: ForcedRemoval,
) {
  if (force.has('choices-error')) throw new Error('the picker fails, as removal=choices-error asks')
  if (force.has('choices-not-ready')) return { state: 'not_ready' as const }
  const preview = removalPreviewStandIn(snapshot, args.change, force)
  if (preview.state !== 'ok') return preview
  if (preview.reassign.refusal !== null)
    return { state: 'refused' as const, message: preview.reassign.refusal }
  const org = orgOf(snapshot, args.change)
  const people = new Set(preview.people.map((p) => p.id))
  const matches = allWordsMatcher(nameKey(args.search ?? ''))
  const all = snapshot.profiles
    .filter((p) => canTake(p, org, people) && matches(nameKey(p.name)))
    .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)) || a.id.localeCompare(b.id))
  const from = Number(args.after ?? 0)
  const size = force.has('choices-stopped') ? Math.ceil(LIST_BATCH / 2) : LIST_BATCH
  const rows = all.slice(from, from + size)
  const to = from + size
  return {
    state: 'ready' as const,
    rows: rows.map((p) => ({
      id: p.id,
      name: p.name,
      org_role: p.org_role,
      kind: p.kind,
      active: p.active,
      pending: false,
    })),
    next: to < all.length ? String(to) : null,
    stopped: force.has('choices-stopped') && to < all.length,
  }
}
