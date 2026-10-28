/* The issue domain's public surface (phase 4): the archived-list reads and
 * the Move window's question, plus the browser client's issue writes — thin
 * wrappers over model/issues, model/messages and model/cascade. Pattern:
 * orgMutation wrapper → resolve by uuid → access check → compose model
 * functions with ONE `now` → return what the optimistic client reconciles
 * against.
 *
 * Refusal posture (0056 no-existence-oracle):
 * - a missing OR foreign-org issue uuid reads `not_found` 'task not found'
 *   (the machine surface's sentence) — never a role/permission reveal;
 * - insufficient project level on a resolvable target reads `forbidden`
 *   (the RLS 0-row successor — the client shows its fixed permission toast);
 * - a task or project the caller only REFERENCES (a parent, a link's other
 *   end, a move's destination) answers exactly like a missing one when the
 *   caller cannot see it, so no answer describes it. One accepted exception
 *   is restore: it is refused when it would change a parent the caller
 *   cannot edit, so its outcome can tell whether such a parent is archived
 *   or holds its own hours or review hand-off. It also tells a caller who
 *   cannot see the parent that one exists: REST reads its parent_id as null
 *   and MCP sends no parent. Refusing every restore under such a parent
 *   would stop people restoring their own task. A second is assignment: a
 *   subtask's new assignee or reviewer must see every task above it, so a
 *   refusal under a parent the caller cannot see tells whether that person
 *   can see it;
 * - `rule` sentences come out of the model layer verbatim.
 * Write level for issues/links is has_project_level 'user' — the 0003
 * policies' 'member', renamed by 0013.
 *
 * markRead/markUnread (+ the prune-per-pair statement-trigger successor) and
 * comments.create/update/remove live in phase 5's messages.ts / comments.ts —
 * NOT here. The archive reason-comment is the
 * one comment this file posts (the old client posted it gated on the
 * archive landing); it shares the archive's `now` and goes through
 * model/comments.ts postArchiveReason, as the machine archive does.
 *
 * Each write checks Edit here first with the app's own sentence; the model
 * cores repeat that check as defense in depth (model/issues.ts
 * assertCanEdit). */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  canManageOwnProjectAccess,
  canSeeProject,
  hasProjectLevel,
  keepsInbox,
  projectLevelsForProfiles,
} from './lib/access'
import {
  ARCHIVED_PAGE_ROWS,
  type ArchivedPageRow,
  archiveCursorText,
  archivedPageCore,
  archivedTaskCore,
  parseArchiveCursor,
} from './lib/archivedTasks'
import { byId } from './lib/db'
import { vIssuePriority, vIssueStatus, vLinkType } from './lib/enums'
import {
  authedQuery,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
  rule,
} from './lib/functions'
import { limitedText } from './lib/limitRules'
import { LIMITS } from './lib/limits'
import { assertArchiveReasonRoom, postArchiveReason } from './model/comments'
import { cleanReason, moveTasksToTrash } from './model/deletedItems'
import {
  archiveIssueCore,
  assertCanEdit,
  assertTaskExpected,
  createIssueCore,
  hasSubtasks,
  moveIssueCore,
  subtasksWouldMove,
  unarchiveIssueCore,
  updateIssueCore,
  vTaskExpected,
} from './model/issues'
import { addLinkCore, removeLinkCore, storedLink, vTaskLinkKind } from './model/links'
import { followTask, subscribeToIssue, unfollowTask } from './model/messages'

type MeCtx = QueryCtx & { me: Doc<'profiles'> }

/* System fields stay internal; optional columns come back ABSENT, like the
 * workspace's rows. relations_marked (the archive steps' bookkeeping) and
 * window_key (where the app's windows place the task) stay internal too. */
const pub = ({
  _id,
  _creationTime,
  relations_marked: _marks,
  window_key: _window,
  ...row
}: Doc<'issues'>) => row

/* A returned row names its parent only when the caller can see the parent's
 * project, so no hidden task id leaves a read or a write's result (the
 * snapshot's has_hidden_parent rule). `seen` caches project visibility for
 * list reads. */
async function pubFor(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
  seen = new Map<string, Promise<boolean>>(),
): Promise<ReturnType<typeof pub>> {
  const { parent_id, ...row } = pub(issue)
  if (parent_id === undefined) return row
  const parent = await byId(ctx, 'issues', parent_id)
  if (parent === null || parent.org_id !== me.org_id) return row
  let visible = seen.get(parent.project_id)
  if (visible === undefined) {
    visible = byId(ctx, 'projects', parent.project_id).then(
      async (project) => project !== null && (await canSeeProject(ctx, me, project)),
    )
    seen.set(parent.project_id, visible)
  }
  return (await visible) ? { ...row, parent_id } : row
}

/* Resolve an issue uuid inside the caller's org — missing and foreign rows
 * are indistinguishable (0056). */
async function myIssue(ctx: MeCtx, id: string): Promise<Doc<'issues'>> {
  const issue = await byId(ctx, 'issues', id)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
  return issue
}

/* has_project_level(project, 'member') — false for a missing/foreign project
 * too, exactly the empty RLS join. The model cores' own write gate, run
 * here first with the same sentence. */
const assertWritable = (ctx: MeCtx, projectId: string): Promise<void> =>
  assertCanEdit(ctx, ctx.me, projectId)

/* --------------------------------------------------------------- archived
 * Issue reads that live OUTSIDE the snapshot: the Archived tasks page's
 * paged list (P.fetchArchivedPage), the task window's look-up of its own
 * task (P.fetchArchivedTask) and, deprecated, the whole-archive read that
 * browser tabs and desktop clients from before it still call.
 *
 * issues_select stayed can_see_project(project_id) (0003:165) for archived
 * rows too — fetchAll excluded them by filter, not by policy — so the fence
 * here is visibility alone, narrowed to archived_at set. An unknown or
 * invisible project id contributes nothing rather than erroring: RLS filtered
 * silently, and the id must not become an existence oracle. authedQuery
 * rather than orgQuery because the ids may span organizations (a foreign
 * meta's archived tasks); each project is fenced through the caller's seat in
 * ITS OWN org. */

/** One page of a project family's archived tasks for the app's Archived
 * tasks page, most recently archived first, then newest created first. A
 * top-level project includes its visible sub-projects that share its
 * archived state, as the app's project tree does (lib/archivedTasks.ts
 * archiveFamily). With `search`, rows are only the matches, and a page may
 * stop early under the read budget; pass `next_cursor` back until it is
 * null. `scanned` counts the family's archived tasks the page looked at. An
 * unknown or invisible project answers an empty last page. */
export const archivedPage = authedQuery({
  args: {
    project_id: v.string(),
    cursor: v.optional(v.string()),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ rows: ArchivedPageRow[]; next_cursor: string | null; scanned: number }> => {
    const limit = a.limit ?? ARCHIVED_PAGE_ROWS
    if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVED_PAGE_ROWS) {
      throw badRequest(`limit must be a whole number from 1 to ${ARCHIVED_PAGE_ROWS}`)
    }
    const search = limitedText(LIMITS.search, a.search ?? '')
    const cursor = a.cursor === undefined ? null : await parseArchiveCursor(a.cursor, a.project_id)
    if (a.cursor !== undefined && cursor === null) {
      throw badRequest('cursor must be the next_cursor of an earlier page')
    }
    const empty = { rows: [], next_cursor: null, scanned: 0 }
    const project = await byId(ctx, 'projects', a.project_id)
    if (project === null) return empty
    const me = ctx.myProfiles.get(project.org_id)
    if (me === undefined || !(await canSeeProject(ctx, me, project))) return empty
    const page = await archivedPageCore(ctx, me, project, { cursor, search, limit })
    return {
      rows: page.rows,
      next_cursor: page.next === null ? null : await archiveCursorText(page.next, project.id),
      scanned: page.scanned,
    }
  },
})

/** The archived task `id` as archivedPage shows it to the caller, or null
 * when archivedPage lists it for none of the caller's projects: the task is
 * active, deleted, unknown or in a project the caller cannot see, which all
 * answer alike (lib/archivedTasks.ts archivedTaskCore). The task window asks
 * it once its task has left the board, to say whether it was archived. */
export const archivedTask = authedQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<ArchivedPageRow | null> =>
    await archivedTaskCore(ctx, ctx.myProfiles, id),
})

/** Deprecated: the Archived tasks page reads archivedPage. Kept for one
 * release, with the same answer, for browser tabs and desktop clients from
 * before it; remove it with its manifest line once no served build calls
 * it. It reads every archived task of the named projects at once, which
 * passes a transaction's limits for a large archive. */
export const archivedFor = authedQuery({
  args: { project_ids: v.array(v.string()) },
  handler: async (ctx, { project_ids }) => {
    const out: Doc<'issues'>[] = []
    const seen = new Set<string>()
    for (const pid of project_ids) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const project = await byId(ctx, 'projects', pid)
      if (project === null) continue
      const me = ctx.myProfiles.get(project.org_id)
      if (me === undefined) continue
      if (!(await canSeeProject(ctx, me, project))) continue
      // only archived rows, never the project's active tasks
      const projectIssues = await ctx.db
        .query('issues')
        .withIndex('by_project_archived', (q) =>
          q.eq('project_id', pid).gt('archived_at', undefined),
        )
        .collect()
      out.push(...projectIssues)
    }
    // the old client's order: archived_at desc, num desc
    out.sort((a, b) =>
      a.archived_at === b.archived_at
        ? b.num - a.num
        : (a.archived_at as string) < (b.archived_at as string)
          ? 1
          : -1,
    )
    // per organization: each row is fenced through the caller's seat there
    const seenByOrg = new Map<string, Map<string, Promise<boolean>>>()
    return await Promise.all(
      out.map(async (issue) => {
        const me = ctx.myProfiles.get(issue.org_id) as Doc<'profiles'>
        let seen = seenByOrg.get(issue.org_id)
        if (seen === undefined) {
          seen = new Map()
          seenByOrg.set(issue.org_id, seen)
        }
        const issueLabels = await ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .collect()
        return {
          ...(await pubFor(ctx, me, issue, seen)),
          is_group: await hasSubtasks(ctx, issue),
          label_ids: issueLabels.map((label) => label.label_id),
        }
      }),
    )
  },
})

/* ----------------------------------------------------------------- create
 * P.addIssue. The client sends its generated uuid and reconciles its
 * optimistic key preview off the returned num (onKeyFixed). A task created
 * in Review without hours gets the project review time from the server. */
export const create = orgMutation({
  args: {
    id: v.string(),
    project_id: v.string(),
    title: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    status: v.optional(v.union(vIssueStatus, v.null())),
    priority: v.optional(v.union(vIssuePriority, v.null())),
    assignee_id: v.optional(v.union(v.string(), v.null())),
    reviewer_id: v.optional(v.union(v.string(), v.null())),
    parent_id: v.optional(v.union(v.string(), v.null())),
    start_week: v.optional(v.union(v.string(), v.null())),
    end_week: v.optional(v.union(v.string(), v.null())),
    due_date: v.optional(v.union(v.string(), v.null())),
    remaining_hours: v.optional(v.union(v.number(), v.null())),
    paused: v.optional(v.union(v.boolean(), v.null())),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    await assertWritable(ctx, args.project_id)
    const issue = await createIssueCore(ctx, { me: ctx.me, args, now })
    return await pubFor(ctx, ctx.me, issue)
  },
})

/* ----------------------------------------------------------------- update
 * P.updateIssue / P.setStatus. A key's PRESENCE means "set this field"; null
 * is the wire form of a clear (Convex strips undefined from args). num /
 * org_id / reporter_id / done_at / remaining_set_at / archived_at have no slot: immutable
 * or server-owned. The returned row is what actually landed, any
 * server-set review time included. A date key on a task with subtasks is
 * refused. */
export const update = orgMutation({
  args: {
    id: v.string(),
    patch: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.union(v.string(), v.null())),
      status: v.optional(vIssueStatus),
      priority: v.optional(vIssuePriority),
      assignee_id: v.optional(v.union(v.string(), v.null())),
      reviewer_id: v.optional(v.union(v.string(), v.null())),
      parent_id: v.optional(v.union(v.string(), v.null())),
      start_week: v.optional(v.union(v.string(), v.null())),
      end_week: v.optional(v.union(v.string(), v.null())),
      due_date: v.optional(v.union(v.string(), v.null())),
      remaining_hours: v.optional(v.union(v.number(), v.null())),
      paused: v.optional(v.boolean()),
    }),
    expected: v.optional(vTaskExpected),
  },
  handler: async (ctx, { id, patch, expected }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    // the parent pair goes with parent_id
    const next = 'parent_id' in patch ? { ...patch, has_hidden_parent: null } : patch
    await assertTaskExpected(ctx, { me: ctx.me, issue, view: 'app', expected, next })
    const after = await updateIssueCore(ctx, { me: ctx.me, issue, patch, now })
    return await pubFor(ctx, ctx.me, after)
  },
})

/* ----------------------------------------------------------- create parent
 * P.createParent, the Parent picker's Create new parent task: a new
 * top-level task `parent_id` titled `title` in task `id`'s sub-project, and
 * task `id` attached under it, in one transaction. A refused attach, such as
 * for a task with archived subtasks the app cannot see, rolls the new task
 * back too. Both writes run their usual cores and checks. Answers the task
 * with the new parent's number (`parent_num`), which the app shows until a
 * delivery holds the parent. */
export const createParent = orgMutation({
  args: {
    id: v.string(),
    parent_id: v.string(),
    title: v.string(),
    expected: v.optional(vTaskExpected),
  },
  handler: async (ctx, { id, parent_id, title, expected }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    await assertTaskExpected(ctx, {
      me: ctx.me,
      issue,
      view: 'app',
      expected,
      next: { parent_id, has_hidden_parent: null },
    })
    const parent = await createIssueCore(ctx, {
      me: ctx.me,
      args: { id: parent_id, project_id: issue.project_id, title },
      now,
    })
    const child = (await byId(ctx, 'issues', issue.id)) as Doc<'issues'>
    const after = await updateIssueCore(ctx, {
      me: ctx.me,
      issue: child,
      patch: { parent_id },
      now,
    })
    return { ...(await pubFor(ctx, ctx.me, after)), parent_num: parent.num }
  },
})

/* ---------------------------------------------------- create linked task
 * P.createLinked, the Link picker's Create new linked task: a new task
 * `new_id` titled `title` in task `id`'s sub-project, and the link `link_id`
 * of `kind` as seen from task `id` between the two, in one transaction. A
 * refused link, such as to a task whose LIMITS.links.max links include
 * tasks the app cannot see, rolls the new task back too, so no unlinked
 * task is left. Both writes run their usual cores and checks. Answers the
 * new task. */
export const createLinked = orgMutation({
  args: {
    id: v.string(),
    new_id: v.string(),
    link_id: v.string(),
    title: v.string(),
    kind: vTaskLinkKind,
  },
  handler: async (ctx, { id, new_id, link_id, title, kind }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const created = await createIssueCore(ctx, {
      me: ctx.me,
      args: { id: new_id, project_id: issue.project_id, title },
      now,
    })
    await addLinkCore(ctx, {
      me: ctx.me,
      id: link_id,
      ...storedLink(issue.id, kind, created.id),
      now,
    })
    return await pubFor(ctx, ctx.me, created)
  },
})

/* ------------------------------------------------------------------- move
 * P.moveIssue. REST and MCP move through the same moveIssueCore.
 * 'member' on BOTH ends, checked before moveIssueCore's guards as create
 * checks its project. A destination the caller cannot write answers 'no
 * write access to this project' whether it is missing, hidden, read-only or
 * in another organization, so no guard describes it. `detach_parent` also
 * clears the task's parent, which a subtask moving to another top-level
 * project needs (the Move window says so); a move to another top-level
 * project carries the task's subtasks along. */
export const move = orgMutation({
  args: {
    id: v.string(),
    project_id: v.string(),
    detach_parent: v.optional(v.boolean()),
    expected: v.optional(vTaskExpected),
  },
  handler: async (ctx, { id, project_id, detach_parent, expected }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    if (project_id !== issue.project_id) await assertWritable(ctx, project_id)
    const detach = detach_parent === true ? { parent_id: null, has_hidden_parent: null } : {}
    await assertTaskExpected(ctx, {
      me: ctx.me,
      issue,
      view: 'app',
      expected,
      next: { project_id, ...detach },
    })
    const after = await moveIssueCore(ctx, {
      me: ctx.me,
      issue,
      project_id,
      now,
      detachParent: detach_parent,
    })
    return await pubFor(ctx, ctx.me, after)
  },
})

/* P.moveCarriesSubtasks asks, for the Move window, whether moving the task
 * to `project_id` would carry subtasks along. Archived subtasks are not in
 * the app's snapshot, so the dialog cannot tell on its own. It answers false
 * unless the caller could make the move (Edit on both ends, as move
 * checks), so it says nothing about a task or project the caller cannot
 * write. */
export const moveCarriesSubtasks = orgQuery({
  args: { id: v.string(), project_id: v.string() },
  handler: async (ctx, { id, project_id }) => {
    const issue = await myIssue(ctx, id)
    if (!(await hasProjectLevel(ctx, ctx.me, issue.project_id, 'user'))) return false
    if (!(await hasProjectLevel(ctx, ctx.me, project_id, 'user'))) return false
    const target = await byId(ctx, 'projects', project_id)
    if (target === null || target.org_id !== issue.org_id) return false
    return await subtasksWouldMove(ctx, issue, target)
  },
})

/* ---------------------------------------------------------------- archive
 * P.archiveIssue. One transaction: the subtree stamp, the fan-out, and the
 * optional early-archive reason posted as a normal comment — author pinned
 * to the actor, sharing the archive's `now` (0111: the 'New comment' and
 * 'Archived' messages land at the same instant; the prune tie-break falls to
 * id). Archiving an already-archived row is a no-op and posts no reason;
 * `archived` says whether this call archived the task, so the app can keep
 * a reason that was not posted. A reason the comment cap or the posting
 * rate refuses refuses the archive, before it writes anything
 * (model/comments.ts assertArchiveReasonRoom).
 * `keep_subtasks` is the archive window's choice to keep the subtasks: each
 * active direct child is detached first, exactly as a delete detaches it,
 * and becomes a top-level task; the task is archived alone and its archived
 * children stay attached (model/issues.ts archiveIssueCore). REST and MCP
 * always archive the subtree. */
export const archive = orgMutation({
  args: {
    id: v.string(),
    reason: v.optional(v.string()),
    keep_subtasks: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, reason, keep_subtasks }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const wasActive = issue.archived_at === undefined
    if (wasActive) await assertArchiveReasonRoom(ctx, { issue, author: ctx.me, reason, now })
    const after = await archiveIssueCore(ctx, {
      me: ctx.me,
      issue,
      now,
      keepSubtasks: keep_subtasks === true,
    })
    if (wasActive) await postArchiveReason(ctx, { issue: after, author: ctx.me, reason, now })
    return { issue: await pubFor(ctx, ctx.me, after), archived: wasActive }
  },
})

/* -------------------------------------------------------------- unarchive
 * P.unarchiveIssue awaits it. A refusal toasts "Couldn't restore." and then
 * the refusal sentence. The snapshot pulls the restored rows back in
 * reactively. `left_parent` says the task came back as a top-level task
 * beside a parent that is there (model/issues.ts unarchiveIssueCore), so the
 * app can tell the person why: 'full' when the parent already had
 * LIMITS.subtasks.max active subtasks, 'deleted' when the parent's delete
 * after the task was archived still had to detach it, though the parent came
 * back from Deleted items since. A parent that is gone (in Deleted items) was
 * left as its delete leaves every subtask, so it answers false. */
export const unarchive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const { after, left } = await unarchiveIssueCore(ctx, { me: ctx.me, issue, now })
    const parentId = issue.parent_id
    const shown =
      left !== undefined && parentId !== undefined && (await byId(ctx, 'issues', parentId)) !== null
    const left_parent: 'full' | 'deleted' | false = !shown
      ? false
      : left === LIMITS.subtasks.refusal
        ? 'full'
        : 'deleted'
    return { issue: await pubFor(ctx, ctx.me, after), left_parent }
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.deleteIssue: the task and the chosen subtasks move to Deleted items as
 * one item (model/deletedItems.ts moveTasksToTrash), where a person can
 * restore them. Their messages are deleted, children left behind are
 * detached and touched, their followers told moments later, and each task
 * writes the 'deleted' activity row the old client wrote, with no detail.
 * `reason` is shown in Deleted items, trimmed and refused past
 * LIMITS.deleteReason (model/deletedItems.ts cleanReason).
 *
 * `subtask_ids` names the subtasks the caller chose to delete with it, as
 * the delete window listed them. Each must still be an active task under one
 * being deleted here, in an active project the caller can edit; otherwise
 * nothing is deleted (SUBTASKS_CHANGED), so the outcome is the one the
 * window showed.
 * Every subtask left behind (archived, in a project the caller cannot edit
 * or see, or not chosen) is detached and becomes a top-level task. A chosen
 * subtask keeps its parent in Deleted items. A subtask has no subtasks of
 * its own, so the choice reads one range of at most LIMITS.subtasks.max active
 * subtasks. */
export const SUBTASKS_CHANGED =
  'the subtasks changed while the window was open; check them and delete again'
export const deleteDeep = orgMutation({
  args: {
    id: v.string(),
    subtask_ids: v.optional(v.array(v.string())),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { id, subtask_ids, reason }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const why = cleanReason(reason)
    const chosen = new Set(subtask_ids ?? [])
    const doomed: Doc<'issues'>[] = []
    // the root's active children, read once here and handed on
    let children: Doc<'issues'>[] | undefined
    if (chosen.size) {
      children = await ctx.db
        .query('issues')
        .withIndex('by_parent_archived', (q) =>
          q.eq('parent_id', issue.id).eq('archived_at', undefined),
        )
        .take(LIMITS.subtasks.max)
      // whether the caller may delete a subtask in each project, read once
      // per project rather than once per subtask
      const usable = new Map<string, boolean>()
      for (const kid of children) {
        if (!chosen.has(kid.id)) continue
        let ok = usable.get(kid.project_id)
        if (ok === undefined) {
          // an archived project keeps its tasks and grants, but they are put away
          ok =
            (await byId(ctx, 'projects', kid.project_id))?.archived_at === undefined &&
            (await hasProjectLevel(ctx, ctx.me, kid.project_id, 'user'))
          usable.set(kid.project_id, ok)
        }
        if (!ok) continue
        chosen.delete(kid.id)
        doomed.push(kid)
      }
    }
    if (chosen.size) throw rule(SUBTASKS_CHANGED)
    await moveTasksToTrash(ctx, {
      actor: ctx.me,
      root: issue,
      children,
      subtasks: doomed,
      now,
      reason: why,
    })
    return null
  },
})

/* ------------------------------------------------------------------ links
 * Canonical storage stays client-side (blocks directed source→target;
 * relates ordered by uuid, see old planner.ts:2234-2238). The wire carries
 * the stored enum, never 'blocked_by'. pair_key enforces at-most-one-link-per-
 * pair (the (least, greatest) unique index's successor). Both run the shared
 * cores in model/links.ts, which REST and MCP run too: sight of both ends
 * plus member level on EITHER endpoint (model/issues linkAccess, 0008:12-21).
 * A foreign, missing or hidden endpoint answers like a missing task (addLink
 * reads the trigger's own org sentence, removeLink 'task not found'), so
 * neither is an existence oracle. Sending the same link again is a no-op. */

export const addLink = orgMutation({
  args: { id: v.string(), source_id: v.string(), target_id: v.string(), type: vLinkType },
  handler: async (ctx, { id, source_id, target_id, type }) => {
    const now = new Date().toISOString()
    await addLinkCore(ctx, { me: ctx.me, id, source_id, target_id, type, now })
    return null
  },
})

/* Pair delete; a pair with no row is a no-op (the client already guards the
 * asked-for state). Logs nothing, since the old client wrote no activity here.
 * Either end being missing, foreign or hidden reads 'task not found', so no
 * answer tells whether a task the caller cannot see exists. */
export const removeLink = orgMutation({
  args: { a: v.string(), b: v.string(), expected: v.optional(v.object({ kind: vTaskLinkKind })) },
  handler: async (ctx, { a, b, expected }) => {
    await removeLinkCore(ctx, {
      me: ctx.me,
      a: await byId(ctx, 'issues', a),
      b: await byId(ctx, 'issues', b),
      expected,
    })
    return null
  },
})

/* ---------------------------------------------------------- subscriptions
 * P.setIssueSubscribed keeps the own-row insert/delete surface. No activity
 * or notify is generated when changing notification preferences. The insert
 * fence is canSeeProject, stated as an explicit refusal (the RLS insert's
 * error toast), then subscribeToIssue applies its own silent fence
 * idempotently. Both are model/messages.ts followTask and unfollowTask,
 * which the machine surfaces run too. */
export const subscribe = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, issue_id)
    await followTask(ctx, { me: ctx.me, issue, now })
    return null
  },
})

export const unsubscribe = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    await unfollowTask(ctx, { me: ctx.me, issueId: issue_id })
    return null
  },
})

/* The subscriber popover must not reveal whether an inaccessible task
 * exists. Recheck visibility on writes too: an open popover can outlive a
 * project move or an access revocation. */
async function subscriptionTarget(ctx: MeCtx, issueId: string) {
  const issue = await myIssue(ctx, issueId)
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null || !(await canSeeProject(ctx, ctx.me, project))) {
    throw notFound('task not found')
  }
  return { issue, project }
}

/* Organization roster ids only; profile display data already lives in the
 * snapshot. Existing subscriptions remain visible after access/deactivation
 * so a manager can remove them. Add candidates require CURRENT access, an
 * active seat and an inbox (lib/access.ts keepsInbox, which leaves out
 * Viewer agents); a subscription itself never grants project access. Their
 * levels on the task's sub-project are read for everyone at once
 * (projectLevelsForProfiles), in a few index ranges, because one check per
 * person passed Convex's 4,096 in an organization of some thousands. */
export const subscribers = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue, project } = await subscriptionTarget(ctx, issue_id)
    const canManage = await canManageOwnProjectAccess(ctx, ctx.me, project)
    const rows = await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id))
      .collect()
    const subscribed = new Set(rows.map((row) => row.profile_id))
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', issue.org_id))
      .collect()
    const subscribers: string[] = []
    const candidates: string[] = []
    const levelOf = canManage ? await projectLevelsForProfiles(ctx, project) : undefined
    for (const profile of profiles) {
      if (subscribed.has(profile.id)) subscribers.push(profile.id)
      else if (
        levelOf !== undefined &&
        profile.active &&
        keepsInbox(profile) &&
        levelOf(profile) !== null
      ) {
        candidates.push(profile.id)
      }
    }
    return { canManage, subscribers, candidates }
  },
})

/* Project leads and organization admins may manage other profiles.
 * Team leadership alone is insufficient. Adds revalidate recipient
 * eligibility; removal also permits stale same-org subscribers. Both
 * requested states are idempotent. */
export const setSubscriber = orgMutation({
  args: { issue_id: v.string(), profile_id: v.string(), subscribed: v.boolean() },
  handler: async (ctx, { issue_id, profile_id, subscribed }) => {
    const { issue, project } = await subscriptionTarget(ctx, issue_id)
    if (profile_id !== ctx.me.id && !(await canManageOwnProjectAccess(ctx, ctx.me, project))) {
      throw forbidden('only project leads and organization admins can manage other subscribers')
    }
    const profile = await byId(ctx, 'profiles', profile_id)
    if (profile === null || profile.org_id !== issue.org_id) {
      throw notFound('subscriber not found')
    }
    if (subscribed) {
      if (!profile.active || !(await canSeeProject(ctx, profile, project))) {
        throw rule('subscriber must be an active user who can see this task')
      }
      if (!keepsInbox(profile)) throw rule('a Viewer agent has no inbox and cannot follow tasks')
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        task_key: issue.window_key,
        profile,
        org_id: issue.org_id,
        project,
        now: new Date().toISOString(),
        cap: 'refuse',
      })
    } else {
      const row = await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_profile', (q) =>
          q.eq('issue_id', issue.id).eq('profile_id', profile.id),
        )
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
    }
    return null
  },
})
