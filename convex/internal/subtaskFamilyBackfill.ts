/* A one-time check and repair for subtasks linked before a subtask had to
 * stay in its parent task's top-level project (model/issues.ts
 * parentChainCheck). The rule refuses only new links and moves, so older
 * links across top-level projects remain. Every reader accepts them, and
 * such a subtask stays editable and movable within its own top-level
 * project and into its parent's (moveIssueCore).
 *
 * `audit` lists those links and writes nothing. `start` detaches them. The
 * subtask keeps its project and becomes a top-level task, so nothing changes
 * who can see a task. A parent whose last active subtask goes resumes its
 * own status and dates, as when a person removes a subtask.
 *
 * Both walk every task that has a parent, in every organization, through
 * issues by_parent, one page at a time bounded by FAMILY_PAGE. A page reads
 * each parent once and each project once. The index keeps a parent's
 * subtasks together, so a page that reaches FAMILY_PAGE.parentBytes of
 * parents stops before the next parent, and the next page starts at it
 * (`from`). A link is one of these.
 *   - family: both tasks are in the same top-level project. Left alone.
 *   - cross: the parent is in the same organization, in another top-level
 *     project. Listed by `audit` and detached by `start`, also for archived
 *     tasks and tasks in archived projects, because a restore would bring
 *     the link back live.
 *   - dangling: the parent task no longer exists.
 *   - foreign_org: the parent task is in another organization.
 *   - no_project: the project of either task no longer exists. That is the
 *     case while Deleted items moves a project in steps (model/deletedItems.ts),
 *     whose restore checks every parent again (keptParent).
 * The last three are counted and never changed. Deleted items rows are not
 * walked, since their restore drops a parent in another top-level project.
 *
 * `audit` answers one page with the cross links, each with its organization
 * id, the two task keys, the two sub-project keys and whether each task is
 * archived, and with the counts of the others. No title, description or name
 * leaves it. Pass the returned `cursor` back until `done`.
 *
 * `start` is one sequential chain of steps. Each step reads one page and,
 * in the same transaction, removes parent_id from each cross subtask and
 * sends task.updated without an actor, as the nightly archive does
 * (jobs.ts). It writes no inbox message, no activity row and no updated_at,
 * because this is maintenance and not a person's edit. Once a step has
 * spent its budget for those events (FAMILY_PAGE), it stops detaching and
 * the next step reads the same page again. The subtasks it detached have
 * left that page, and the step that finishes the page counts the rest. A
 * dangling, foreign or unresolved link is logged by the subtask's id. The
 * last step logs 'Subtask family backfill done' with the counts and writes
 * one platform_audit_log row, action 'subtask_family_backfill', with the
 * counts only.
 *
 * Running either twice, or while people work, is safe. A step reads and
 * writes in one transaction, and the app refuses every new cross link, so a
 * second `start` detaches nothing and a later `audit` lists nothing.
 *
 * Run both once per deployment, `audit` first, then `start` only when the
 * user has decided to detach what the audit lists. Running either on any
 * hosted deployment (development, staging, production or demo) needs the
 * user's approval first, each time, even though `audit` only reads. Never
 * use `npx convex export` or `npx convex data` instead, because both print
 * customer content. `audit` answers one page per call, so the full audit is
 * this loop, which passes each cursor back until `done`, with jq reading
 * each page:
 *
 *   audit='cursor=null
 *   while :; do
 *     out=$(npx convex run internal/subtaskFamilyBackfill:audit "{\"cursor\": $cursor}")
 *     echo "$out" | jq -c ".cross[]"
 *     echo "$out" | jq -c "{scanned, dangling, foreign_org, no_project}"
 *     [ "$(echo "$out" | jq -r .done)" = true ] && break
 *     cursor=$(echo "$out" | jq -c .cursor)
 *   done'
 *
 * From a Qivo checkout, the private helper names the deployment and refuses
 * to run without its key, for example development:
 *
 *   helpers="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts"
 *   "$helpers/with-deployment" development sh -c "$audit"
 *   "$helpers/with-deployment" development npx convex run internal/subtaskFamilyBackfill:start
 *
 * The other targets are staging and production. The demo backend's stored
 * key cannot run internal functions or read logs, so on the demo the private
 * with-temp-deploy-key helper runs each command with a short-lived key that
 * allows only the listed actions, then deletes it (qivo-internal
 * docs/public-demo-operations.md). The whole audit loop runs under one key.
 * `audit` is an internal query, `start` an internal mutation, and
 * `npx convex logs` needs deployment:logs:view:
 *
 *   "$helpers/with-temp-deploy-key" demo --allow deployment:functions:runInternalQueries \
 *     --purpose subtask-family -- sh -c "$audit"
 *   "$helpers/with-temp-deploy-key" demo --allow deployment:functions:runInternalMutations \
 *     --purpose subtask-family -- npx convex run internal/subtaskFamilyBackfill:start
 *
 * `start` returns once its first step is done. Follow the progress in the
 * deployment's logs, then run the audit again, which should list nothing. */

import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { byId } from '../lib/db'
import { issueKey } from '../lib/taskRefs'
import { audit as auditRow } from '../model/admin'
import { sameTopLevel } from '../model/issues'
import { emitTaskEvent, eventSubscriptions } from '../model/taskEvents'

/** The most tasks (`tasks`) and task bytes (`bytes`) one page reads, about
 * the most bytes of parents it reads for them (`parentBytes`), and the
 * budget of a `start` step for the task.updated events it sends: at most
 * `checks` subscriber checks, and at most the share `room` of each of
 * Convex's limits for one transaction.
 *
 * Older tasks can be near the 1 MiB document limit, and each read may pass
 * its budget by one document, so a page reads about bytes + parentBytes +
 * 2 MiB, under half of the 16 MiB a transaction may read. It reads at most
 * one parent and two projects per task, about 600 of the 4,096 index
 * ranges. A detach reads its subtask once more, and its task.updated checks
 * whether each subscriber of the organization (eventSubscriptions, at most
 * 200 rows) may see the task's project (model/taskEvents.ts).
 *
 * Those checks set a step's cost. Each takes execution time, of which a
 * mutation has 1 second, and the transaction metrics do not report it. On
 * a busy local backend, 61 subscribers and 25 detaches into new projects
 * (1,525 checks) took about that second, and steps of 366 checks passed
 * each time. So before each detach after its first, a step stops when the
 * detach's subscriptions would take it past `checks`. A check also reads a varying number of index ranges and
 * documents, so the step also stops once it has used `room` of any limit
 * the deployment reports (ctx.meta.getTransactionMetrics), as an access
 * removal does (model/projectAccess.ts). Tests lower these. */
export const FAMILY_PAGE = {
  tasks: 200,
  bytes: 2 * 1024 * 1024,
  parentBytes: 2 * 1024 * 1024,
  checks: 400,
  room: 0.5,
}

/* Where a walk stands, as the parent id its range starts at (`from`,
 * absent for the first range) and the page cursor within that range. */
const vPosition = v.object({ from: v.optional(v.string()), cursor: v.optional(v.string()) })
type Position = Infer<typeof vPosition>

/* What a subtask's link to its parent is (header). */
type Verdict =
  | { kind: 'family' | 'dangling' | 'foreign_org' | 'no_project' }
  | {
      kind: 'cross'
      parent: Doc<'issues'>
      childProject: Doc<'projects'>
      parentProject: Doc<'projects'>
    }

type Link = { child: Doc<'issues'> } & Verdict

/* The counts a `start` chain carries from step to step. */
const counts = {
  scanned: v.optional(v.number()),
  detached: v.optional(v.number()),
  dangling: v.optional(v.number()),
  foreign_org: v.optional(v.number()),
  no_project: v.optional(v.number()),
}
type Counts = { [K in keyof typeof counts]-?: number }

const startRef = makeFunctionReference<'mutation', Position & Partial<Counts>, null>(
  'internal/subtaskFamilyBackfill:start',
)

/* One page of the tasks that have a parent, from `at`, each with its
 * verdict, and the position of the next page, or null after the last. */
async function readPage(
  ctx: QueryCtx,
  at: Position,
): Promise<{ links: Link[]; next: Position | null }> {
  const from = at.from
  const range =
    from === undefined
      ? ctx.db.query('issues').withIndex('by_parent', (q) => q.gt('parent_id', undefined))
      : ctx.db.query('issues').withIndex('by_parent', (q) => q.gte('parent_id', from))
  const page = await range.paginate({
    cursor: at.cursor ?? null,
    numItems: Math.max(1, FAMILY_PAGE.tasks),
    maximumBytesRead: FAMILY_PAGE.bytes,
  })
  let next: Position | null = page.isDone ? null : { from, cursor: page.continueCursor }
  const parents = new Map<string, Doc<'issues'> | null>()
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const project = (id: string) => {
    let found = projects.get(id)
    if (found === undefined) {
      found = byId(ctx, 'projects', id)
      projects.set(id, found)
    }
    return found
  }
  let parentBytes = 0
  const links: Link[] = []
  for (const child of page.page) {
    const parentId = child.parent_id
    if (parentId === undefined) continue // outside the range, never returned
    let parent = parents.get(parentId)
    if (parent === undefined) {
      // tasks are in parent order, so every task before this one is done;
      // a page always reads its first parent, so the walk moves on
      if (parents.size > 0 && parentBytes >= FAMILY_PAGE.parentBytes) {
        next = { from: parentId }
        break
      }
      parent = await byId(ctx, 'issues', parentId)
      parents.set(parentId, parent)
      if (parent !== null) parentBytes += getDocumentSize(parent)
    }
    links.push({ child, ...(await verdictOf(child, parent, project)) })
  }
  return { links, next }
}

/* The verdict on `child`'s link to `parent` (null when it no longer exists),
 * reading projects through `project`. */
async function verdictOf(
  child: Doc<'issues'>,
  parent: Doc<'issues'> | null,
  project: (id: string) => Promise<Doc<'projects'> | null>,
): Promise<Verdict> {
  if (parent === null) return { kind: 'dangling' }
  if (parent.org_id !== child.org_id) return { kind: 'foreign_org' }
  const [childProject, parentProject] = await Promise.all([
    project(child.project_id),
    project(parent.project_id),
  ])
  if (childProject === null || parentProject === null) return { kind: 'no_project' }
  if (sameTopLevel(childProject, parentProject)) return { kind: 'family' }
  return { kind: 'cross', parent, childProject, parentProject }
}

/** One page of the subtasks whose parent is in another top-level project,
 * from `cursor` (absent or null to begin). Read-only, and it names tasks and
 * projects only by key (header). `scanned` counts the tasks with a parent
 * the page read, and the other counts the links it left out. */
export const audit = internalQuery({
  args: { cursor: v.optional(v.union(v.null(), vPosition)) },
  handler: async (ctx, a) => {
    const { links, next } = await readPage(ctx, a.cursor ?? {})
    const left = { dangling: 0, foreign_org: 0, no_project: 0 }
    for (const link of links) {
      if (link.kind !== 'family' && link.kind !== 'cross') left[link.kind] += 1
    }
    const cross = links.flatMap((link) =>
      link.kind === 'cross'
        ? [
            {
              org_id: link.child.org_id,
              child: issueKey(link.child.num),
              child_project: link.childProject.key,
              parent: issueKey(link.parent.num),
              parent_project: link.parentProject.key,
              child_archived: link.child.archived_at !== undefined,
              parent_archived: link.parent.archived_at !== undefined,
            },
          ]
        : [],
    )
    return { cross, ...left, scanned: links.length, cursor: next, done: next === null }
  },
})

/* Whether the transaction has used more than FAMILY_PAGE.room of any of
 * Convex's limits for one transaction. */
async function stepIsFull(ctx: MutationCtx): Promise<boolean> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return Object.values(metrics).some(
    ({ used, remaining }) => used > (used + remaining) * FAMILY_PAGE.room,
  )
}

/** One step of the backfill, then the next one scheduled. Empty arguments
 * start a run. Each step detaches the cross links of one page, or of its
 * start when the step spends its budget (FAMILY_PAGE), and carries the
 * running counts for the final log and audit row. */
export const start = internalMutation({
  args: { ...vPosition.fields, ...counts },
  handler: async (ctx, a): Promise<null> => {
    const { links, next } = await readPage(ctx, a)
    const now = new Date().toISOString()
    let detached = 0
    let checks = 0
    let full = false
    for (const link of links) {
      if (link.kind !== 'cross') continue
      const fanOut = (await eventSubscriptions(ctx, link.child.org_id, 'task.updated')).length
      // a step always detaches one link, so the walk moves on
      if (detached > 0 && (checks + fanOut > FAMILY_PAGE.checks || (await stepIsFull(ctx)))) {
        full = true
        break
      }
      await ctx.db.patch(link.child._id, { parent_id: undefined })
      await emitTaskEvent(ctx, {
        name: 'task.updated',
        issue: { ...link.child, parent_id: undefined },
        before: link.child,
        now,
      })
      checks += fanOut
      detached += 1
    }
    const total: Counts = {
      scanned: (a.scanned ?? 0) + (full ? detached : links.length),
      detached: (a.detached ?? 0) + detached,
      dangling: a.dangling ?? 0,
      foreign_org: a.foreign_org ?? 0,
      no_project: a.no_project ?? 0,
    }
    if (full) {
      // the same page again, without the links detached here, which have
      // left its range; the step that finishes it counts the others
      await ctx.scheduler.runAfter(0, startRef, { from: a.from, cursor: a.cursor, ...total })
      return null
    }
    for (const link of links) {
      if (link.kind === 'family' || link.kind === 'cross') continue
      total[link.kind] += 1
      console.warn('Subtask family backfill left a link alone', {
        id: link.child.id,
        reason: link.kind,
      })
    }
    if (next !== null) {
      await ctx.scheduler.runAfter(0, startRef, { ...next, ...total })
      return null
    }
    console.info('Subtask family backfill done', total)
    await auditRow(ctx, { actor_email: 'cli', action: 'subtask_family_backfill', detail: total })
    return null
  },
})
