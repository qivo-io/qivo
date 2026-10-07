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
 * - `rule` sentences come out of the model layer verbatim.
 * Write level for issues/links is has_project_level 'user' — the 0003
 * policies' 'member', renamed by 0013.
 *
 * markRead/markUnread (+ the prune-per-pair statement-trigger successor) and
 * comments.create/update/remove live in phase 5's messages.ts / comments.ts —
 * NOT here. The archive reason-comment is the
 * one comment insert this file makes (the old client posted it gated on the
 * archive landing); it shares the archive's `now` and fires the comment
 * fan-out, exactly what phase 5's comments.create will compose. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { canManageOwnProjectAccess, canSeeProject, hasProjectLevel } from './lib/access'
import { byId, insertUnique } from './lib/db'
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
import { logActivity } from './model/activity'
import { deleteIssueDeep } from './model/cascade'
import {
  archiveIssueCore,
  assertLinkableIssues,
  createIssueCore,
  hasSubtasks,
  moveIssueCore,
  unarchiveIssueCore,
  updateIssueCore,
} from './model/issues'
import { notifyCommentInsert, subscribeToIssue } from './model/messages'
import { newUuid } from './model/orgs'

type MeCtx = QueryCtx & { me: Doc<'profiles'> }

/* System fields stay internal; optional columns come back ABSENT, like the
 * snapshot's rows. */
const pub = ({ _id, _creationTime, ...row }: Doc<'issues'>) => row

/* Resolve an issue uuid inside the caller's org — missing and foreign rows
 * are indistinguishable (0056). */
async function myIssue(ctx: MeCtx, id: string): Promise<Doc<'issues'>> {
  const issue = await byId(ctx, 'issues', id)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
  return issue
}

/* has_project_level(project, 'member') — false for a missing/foreign project
 * too, exactly the empty RLS join. */
async function assertWritable(ctx: MeCtx, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, ctx.me, projectId, 'user'))) {
    throw forbidden('no write access to this project')
  }
}

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
    return await Promise.all(
      out.map(async (issue) => {
        const issueLabels = await ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .collect()
        return {
          ...pub(issue),
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
    return pub(issue)
  },
})

/* ----------------------------------------------------------------- update
 * P.updateIssue / P.setStatus. A key's PRESENCE means "set this field"; null
 * is the wire form of a clear (Convex strips undefined from args). num /
 * org_id / reporter_id / done_at / remaining_set_at / archived_at have no slot: immutable
 * or server-owned. The returned row carries the CLAMPED span and any
 * server-set review time — what actually landed. */
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
    return pub(after)
  },
})

/* ------------------------------------------------------------------- move
 * P.moveIssue: browser-only (the machine surfaces deliberately refuse moves).
 * 'member' on BOTH ends. The target-level check runs AFTER the model's move
 * guards, reproducing SQL's order (BEFORE trigger raised its sentences, THEN
 * the RLS WITH CHECK evaluated the new row) — a throw rolls the whole
 * mutation back, so nothing the core wrote survives. */
export const move = orgMutation({
  args: { id: v.string(), project_id: v.string() },
  handler: async (ctx, { id, project_id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    const after = await moveIssueCore(ctx, { me: ctx.me, issue, project_id, now })
    if (after.project_id !== issue.project_id) await assertWritable(ctx, project_id)
    return pub(after)
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
    const { issue: after, descendants } = await archiveIssueCore(ctx, { me: ctx.me, issue, now })
    const text = (reason ?? '').trim()
    if (wasActive && text !== '') {
      const commentDoc = await ctx.db.insert('comments', {
        id: newUuid(),
        issue_id: issue.id,
        author: ctx.me.id,
        body: text,
        created_at: now,
      })
      const comment = (await ctx.db.get(commentDoc)) as Doc<'comments'>
      await notifyCommentInsert(ctx, { comment, issue: after, actor: ctx.me, now })
    }
    return { issue: pub(after), descendants }
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
    return pub(after)
  },
})

/* ------------------------------------------------------------- deleteDeep
 * P.deleteIssue. model/cascade owns the FK edges (children detached +
 * touched + notified, links/labels/subscriptions/comments/messages/
 * attachment rows AND bytes); activity rows survive — history outlives its
 * subjects. The 'deleted' row matches the old client's: no detail. */
export const deleteDeep = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, id)
    await assertWritable(ctx, issue.project_id)
    await deleteIssueDeep(ctx, { issue, actor: ctx.me, now })
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: ctx.me.id,
      verb: 'deleted',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      project_id: issue.project_id,
      ts: now,
    })
    return null
  },
})

/* ------------------------------------------------------------------ links
 * Canonical storage stays client-side (blocks directed source→target;
 * relates ordered by uuid — old planner.ts:2234-2238): the wire carries the
 * stored enum, never 'blocked_by'. pair_key enforces at-most-one-link-per-
 * pair (the (least, greatest) unique index's successor). Access (0008:12-21):
 * insert needs member level on EITHER endpoint plus sight of the other;
 * delete needs member level on either endpoint. A foreign or missing
 * endpoint reads the trigger's own org sentence — never an existence oracle. */

const pairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

export const addLink = orgMutation({
  args: { id: v.string(), source_id: v.string(), target_id: v.string(), type: vLinkType },
  handler: async (ctx, { id, source_id, target_id, type }) => {
    const now = new Date().toISOString()
    if (source_id === target_id) throw badRequest('a task cannot be linked to itself')
    const { source, target } = await assertLinkableIssues(ctx, source_id, target_id)
    if (source.org_id !== ctx.me.org_id) {
      // a pair in someone else's org answers exactly like a mismatched pair
      throw rule('linked tasks must belong to the same organization')
    }
    const sourceProject = await byId(ctx, 'projects', source.project_id)
    const targetProject = await byId(ctx, 'projects', target.project_id)
    const writeSource = await hasProjectLevel(ctx, ctx.me, source.project_id, 'user')
    const writeTarget = await hasProjectLevel(ctx, ctx.me, target.project_id, 'user')
    const seeSource = sourceProject !== null && (await canSeeProject(ctx, ctx.me, sourceProject))
    const seeTarget = targetProject !== null && (await canSeeProject(ctx, ctx.me, targetProject))
    if (!((writeSource && seeTarget) || (writeTarget && seeSource))) {
      throw forbidden('no write access to these tasks')
    }
    await insertUnique(
      ctx,
      'issue_links',
      'by_pair',
      { pair_key: pairKey(source_id, target_id) },
      {
        id,
        org_id: source.org_id,
        source_id,
        target_id,
        type,
        pair_key: pairKey(source_id, target_id),
        created_at: now,
      },
      badRequest('these tasks are already linked'),
    )
    await logActivity(ctx, {
      org_id: source.org_id,
      actor_id: ctx.me.id,
      verb: 'linked',
      target_type: 'issue',
      target_id: source.id,
      label: source.title,
      detail: `${type === 'blocks' ? '— blocks' : '— relates to'} QN-${target.num}`,
      project_id: source.project_id,
      ts: now,
    })
    return null
  },
})

/* Pair delete; a pair with no row is a no-op (the client already guards the
 * asked-for state). Logs nothing — the old client wrote no activity here. */
export const removeLink = orgMutation({
  args: { a: v.string(), b: v.string() },
  handler: async (ctx, { a, b }) => {
    const source = await byId(ctx, 'issues', a)
    const target = await byId(ctx, 'issues', b)
    if (
      source === null ||
      target === null ||
      source.org_id !== ctx.me.org_id ||
      target.org_id !== ctx.me.org_id
    ) {
      throw notFound('task not found')
    }
    const writeSource = await hasProjectLevel(ctx, ctx.me, source.project_id, 'user')
    const writeTarget = await hasProjectLevel(ctx, ctx.me, target.project_id, 'user')
    if (!(writeSource || writeTarget)) throw forbidden('no write access to these tasks')
    const links = ctx.db
      .query('issue_links')
      .withIndex('by_pair', (q) => q.eq('pair_key', pairKey(a, b)))
    for await (const l of links) await ctx.db.delete(l._id)
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
 * Team leadership or a relaxed sharing policy alone is insufficient. Adds
 * revalidate recipient eligibility; removal also permits stale same-org
 * subscribers. Both requested states are idempotent. */
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
