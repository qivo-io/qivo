/* The issue domain's public surface (phase 4): the archived-list read plus
 * the browser client's issue writes — thin wrappers over model/issues,
 * model/messages and model/cascade. Pattern:
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
import { canManageOwnProjectAccess, canSeeProject, hasProjectLevel } from './lib/access'
import { byId } from './lib/db'
import { vIssuePriority, vIssueStatus, vLinkType } from './lib/enums'
import { authedQuery, forbidden, notFound, orgMutation, orgQuery, rule } from './lib/functions'
import { postArchiveReason } from './model/comments'
import {
  archiveIssueCore,
  assertCanEdit,
  createIssueCore,
  deleteIssueCore,
  hasSubtasks,
  moveIssueCore,
  unarchiveIssueCore,
  updateIssueCore,
} from './model/issues'
import { addLinkCore, removeLinkCore } from './model/links'
import { subscribeToIssue } from './model/messages'

type MeCtx = QueryCtx & { me: Doc<'profiles'> }

/* System fields stay internal; optional columns come back ABSENT, like the
 * snapshot's rows. */
const pub = ({ _id, _creationTime, ...row }: Doc<'issues'>) => row

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
 * Issue reads that live OUTSIDE the snapshot: the Archive page's per-project
 * archived list (P.fetchArchived).
 *
 * issues_select stayed can_see_project(project_id) (0003:165) for archived
 * rows too — fetchAll excluded them by filter, not by policy — so the fence
 * here is visibility alone, narrowed to archived_at set. An unknown or
 * invisible project id contributes nothing rather than erroring: RLS filtered
 * silently, and the id must not become an existence oracle. authedQuery
 * rather than orgQuery because the ids may span organizations (a foreign
 * meta's archive page); each project is fenced through the caller's seat in
 * ITS OWN org. */

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
      const projectIssues = await ctx.db
        .query('issues')
        .withIndex('by_project', (q) => q.eq('project_id', pid))
        .collect()
      for (const i of projectIssues) {
        if (i.archived_at !== undefined) out.push(i)
      }
    }
    // fetchArchived's order (planner.ts): archived_at desc, num desc
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
          is_group: await hasSubtasks(ctx, issue.id, true),
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
  },
  handler: async (ctx, { id, patch }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const after = await updateIssueCore(ctx, { me: ctx.me, issue, patch, now })
    return await pubFor(ctx, ctx.me, after)
  },
})

/* ------------------------------------------------------------------- move
 * P.moveIssue. REST and MCP move through the same moveIssueCore.
 * 'member' on BOTH ends, checked before moveIssueCore's guards as create
 * checks its project. A destination the caller cannot write answers 'no
 * write access to this project' whether it is missing, hidden, read-only or
 * in another organization, so no guard describes it. */
export const move = orgMutation({
  args: { id: v.string(), project_id: v.string() },
  handler: async (ctx, { id, project_id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    if (project_id !== issue.project_id) await assertWritable(ctx, project_id)
    const after = await moveIssueCore(ctx, { me: ctx.me, issue, project_id, now })
    return await pubFor(ctx, ctx.me, after)
  },
})

/* ---------------------------------------------------------------- archive
 * P.archiveIssue. One transaction: the subtree stamp, the fan-out, and the
 * optional early-archive reason posted as a normal comment — author pinned
 * to the actor, sharing the archive's `now` (0111: the 'New comment' and
 * 'Archived' messages land at the same instant; the prune tie-break falls to
 * id). Archiving an already-archived row is a no-op and posts no reason. */
export const archive = orgMutation({
  args: { id: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { id, reason }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const wasActive = issue.archived_at === undefined
    const after = await archiveIssueCore(ctx, { me: ctx.me, issue, now })
    if (wasActive) await postArchiveReason(ctx, { issue: after, author: ctx.me, reason, now })
    return { issue: await pubFor(ctx, ctx.me, after) }
  },
})

/* -------------------------------------------------------------- unarchive
 * P.unarchiveIssue — awaited by the client ("Couldn't restore — " + the
 * sentence); the snapshot pulls the restored rows back in reactively. */
export const unarchive = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const after = await unarchiveIssueCore(ctx, { me: ctx.me, issue, now })
    return await pubFor(ctx, ctx.me, after)
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.deleteIssue, one model/issues deleteIssueCore per task. model/cascade
 * owns the FK edges (children detached + touched + notified, links/labels/
 * subscriptions/comments/messages/attachment rows AND bytes). Activity rows
 * survive, because history outlives its subjects. The 'deleted' row matches
 * the old client's, with no detail.
 *
 * `subtask_ids` names the subtasks the caller chose to delete with it, as
 * the delete window listed them. Each must still be an active task under one
 * being deleted here, in an active project the caller can edit; otherwise
 * nothing is deleted (SUBTASKS_CHANGED), so the outcome is the one the
 * window showed.
 * They go deepest first, so every subtask left behind (archived, in a
 * project the caller cannot edit or see, or not chosen) is detached from the
 * task above it and becomes a top-level task, keeping its own subtasks. */
export const SUBTASKS_CHANGED =
  'the subtasks changed while the window was open; check them and delete again'
export const deleteDeep = orgMutation({
  args: { id: v.string(), subtask_ids: v.optional(v.array(v.string())) },
  handler: async (ctx, { id, subtask_ids }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const chosen = new Set(subtask_ids ?? [])
    const doomed: Doc<'issues'>[] = []
    for (let i = -1; i < doomed.length && chosen.size; i++) {
      const above = i < 0 ? issue : doomed[i]
      const kids = await ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', above.id))
        .collect()
      for (const kid of kids) {
        if (!chosen.has(kid.id) || kid.archived_at !== undefined) continue
        // an archived project keeps its tasks and grants, but they are put away
        if ((await byId(ctx, 'projects', kid.project_id))?.archived_at !== undefined) continue
        if (!(await hasProjectLevel(ctx, ctx.me, kid.project_id, 'user'))) continue
        chosen.delete(kid.id)
        doomed.push(kid)
      }
    }
    if (chosen.size) throw rule(SUBTASKS_CHANGED)
    for (const gone of [...doomed.reverse(), issue]) {
      await deleteIssueCore(ctx, { me: ctx.me, issue: gone, now })
    }
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
  args: { a: v.string(), b: v.string() },
  handler: async (ctx, { a, b }) => {
    await removeLinkCore(ctx, {
      me: ctx.me,
      a: await byId(ctx, 'issues', a),
      b: await byId(ctx, 'issues', b),
    })
    return null
  },
})

/* ---------------------------------------------------------- subscriptions
 * P.setIssueSubscribed keeps the own-row insert/delete surface. No activity
 * or notify is generated when changing notification preferences. The insert
 * fence is canSeeProject, stated here as an explicit refusal (the RLS
 * insert's error toast), then subscribeToIssue applies its own silent fence
 * idempotently. */
export const subscribe = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, issue_id)
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project === null || !(await canSeeProject(ctx, ctx.me, project))) {
      throw forbidden('no access to this task')
    }
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: ctx.me,
      org_id: issue.org_id,
      project,
      now,
    })
    return null
  },
})

export const unsubscribe = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const row = await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_profile', (q) => q.eq('issue_id', issue_id).eq('profile_id', ctx.me.id))
      .unique()
    if (row !== null) await ctx.db.delete(row._id)
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
 * so a manager can remove them. Add candidates require CURRENT access and
 * an active seat; a subscription itself never grants project access. */
export const subscribers = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue, project } = await subscriptionTarget(ctx, issue_id)
    const canManage = await canManageOwnProjectAccess(ctx, ctx.me, project)
    const rows = await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
      .collect()
    const subscribed = new Set(rows.map((row) => row.profile_id))
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', issue.org_id))
      .collect()
    const subscribers: string[] = []
    const candidates: string[] = []
    for (const profile of profiles) {
      if (subscribed.has(profile.id)) subscribers.push(profile.id)
      else if (canManage && profile.active && (await canSeeProject(ctx, profile, project))) {
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
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        profile,
        org_id: issue.org_id,
        project,
        now: new Date().toISOString(),
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
