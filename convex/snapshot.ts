/* Reactive active working set across the caller's organizations. Archives and
 * comments load on demand; rows omit Convex system fields and internal
 * counters.
 *
 * forMe reads every seat in one transaction, so the sum must stay within
 * Convex's limits of 4,096 index ranges, 32,000 documents and 16 MiB. Besides
 * one range for the caller's seats, each seat reads 12 ranges plus:
 * - one per active project of the organization, its active tasks
 *   (lib/liveTasks.ts liveTasksOf), so the tasks of archived projects are
 *   never read, or one for all of them past LIVE_PROJECT_READS active
 *   projects;
 * - one per team (its members), and two per team the seat belongs to
 *   (lib/access.ts projectLevelsForOrg);
 * - up to three per visible project, archived ones included (grants, team
 *   grants, and the milestones of an active one);
 * - the relation rows (lib/snapshotRelations.ts). A view whose tables stay in
 *   bulk takes six ranges; a restricted or dense one is read task by task, up
 *   to 4 ranges per visible task, never more than 3 ranges above the rule
 *   this replaced and only while those reads fit the ranges the transaction
 *   has left, a dense table past that read in full;
 * - five per visible task restored so recently that its relation rows still
 *   carry archive marks (model/archiveMarks.ts), its own relation reads and
 *   follow. Background steps clear the marks moments after the restore;
 * - one per task an activity row is about, or names by number, that is not
 *   among the live tasks. The snapshot reads the organization's newest 500
 *   rows (CAP) and keeps the task rows, so that is at most 500 for an
 *   admin, who reads the task each row is about, and at most 1,000 for a
 *   member, who reads up to two numbered tasks a row names.
 * A seat whose relation tables stay in bulk therefore reads at most about
 * 1,020 ranges plus one per active project (at most 1,000) and three per
 * team and per visible project, and a person's seats add up. Teams and projects are few
 * beside tasks. A view read task by task adds up to 4 ranges per task, as
 * the rule this replaced did, until the ranges left run short and a dense
 * table is read in full. Documents read follow the live tasks (past LIVE_PROJECT_READS
 * active projects, every active task, archived projects' included, as one
 * range holds them all) and the unmarked relation
 * rows of the active tasks (model/archiveMarks.ts marks the rows of archived
 * tasks, and a project archive marks none), the organization's people,
 * projects, teams and labels, at most 500 activity rows, and at most 3,002
 * messages per seat (lib/inbox.ts). A read that uses half of any of these
 * limits is logged (the end of forMe), so a growing organization shows in
 * the deployment logs before its members' app stops loading. */
import { v } from 'convex/values'
import type { Doc, TableNames } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { canSeeProject } from './lib/access'
import {
  memberSeesActivity,
  taskActivity,
  withoutLegacySubtaskCount,
} from './lib/activityVisibility'
import { byId } from './lib/db'
import { authedQuery, notFound, orgQuery } from './lib/functions'
import { INBOX_LIMIT, loadInbox } from './lib/inbox'
import { liveTasksOf } from './lib/liveTasks'
import { snapshotRelations } from './lib/snapshotRelations'
import { orgProjectView } from './lib/visibility'
import {
  aboutShownTasks,
  inWorkingSet,
  linkShown,
  parentLink,
  workingSetOf,
} from './lib/workingSet'
import { COMMENT_PAGE_MAX, commentAnchor, newestComments, threadPage } from './model/comments'
import { shownLabelColor } from './model/labels'
import { countersOf, type OrgCounters } from './model/orgs'
import { shownAvatarColor } from './model/people'
import { type OrgLoadRow, orgLoadRows } from './planning'

type AppRow<T extends TableNames> = Omit<Doc<T>, '_id' | '_creationTime'>

function rowOf<D extends { _id: unknown; _creationTime: number }>(
  doc: D,
): Omit<D, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...row } = doc
  return row
}

/* A team or project as the app receives it, without the legacy icon and
 * its color. Nothing writes or shows them now, and a value stored before
 * they were dropped has no length limit. */
type IconFree<T extends 'teams' | 'projects'> = Omit<AppRow<T>, 'icon' | 'icon_color'>

function iconFree<
  D extends { _id: unknown; _creationTime: number; icon?: string; icon_color?: string },
>(doc: D) {
  const { icon: _icon, icon_color: _iconColor, ...row } = rowOf(doc)
  return row
}

/* A relation row as the app receives it, without the organization id and
 * the archive mark, which only serve the snapshot's index reads. */
type RelationRow<T extends TableNames> = Omit<AppRow<T>, 'org_id' | 'task_archived'>

function relationRow<
  D extends { _id: unknown; _creationTime: number; org_id?: string; task_archived?: true },
>(doc: D) {
  const { org_id: _orgId, task_archived: _mark, ...row } = rowOf(doc)
  return row
}

/* An attachment as the app receives it. Its project only serves storage
 * totals (model/billing.ts storagePage). */
function attachmentRow(doc: Doc<'issue_attachments'>) {
  const { project_id: _project, ...row } = relationRow(doc)
  return row
}

// Billing is admin-only; application counters and settings are shared. The
// counters come from org_counters (model/orgs.ts countersOf), never from the
// legacy fields an older organization row may still hold.
//
// gravatar_avatars is always false. Qivo no longer reads the retired setting,
// but app builds from earlier releases still open in a browser read it from
// the viewer's home organization and treat a missing value as on. This stops
// their Gravatar requests. Such a build signed in with only guest seats has
// no home organization and treats it as on regardless, until the tab
// reloads. Remove it once no earlier release can still be open or be rolled
// back to.
type OrgRow = Omit<
  AppRow<'organizations'>,
  'billing' | 'activity_count' | 'next_issue_num' | 'next_project_num' | 'gravatar_avatars'
> &
  OrgCounters & { billing?: Doc<'organizations'>['billing']; gravatar_avatars: boolean }

const orgRowFor = (doc: Doc<'organizations'>, counters: OrgCounters, isAdmin: boolean): OrgRow => {
  const {
    _id,
    _creationTime,
    billing,
    activity_count: _activityCount,
    next_issue_num: _issueNum,
    next_project_num: _projectNum,
    gravatar_avatars: _gravatar,
    ...rest
  } = doc
  const row = { ...rest, ...counters, gravatar_avatars: false }
  return isAdmin && billing !== undefined ? { ...row, billing } : row
}

/* Newest first by created_at, the id breaking a tie, the total order the
 * prune uses. */
const newestFirst = (a: Doc<'messages'>, b: Doc<'messages'>): number => {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
}

/* Most recently read first, then newestFirst. */
const recentlyReadFirst = (a: Doc<'messages'>, b: Doc<'messages'>): number => {
  const ra = a.read_at ?? ''
  const rb = b.read_at ?? ''
  if (ra !== rb) return ra < rb ? 1 : -1
  return newestFirst(a, b)
}

const CAP = 500

export const forMe = authedQuery({
  args: {},
  handler: async (ctx) => {
    /* Signed in but seatless = boot's noProfile signal. The null-vs-throw
     * distinction is load-bearing: a transport failure must throw, never
     * masquerade as "no profile". */
    if (ctx.myProfiles.size === 0) return null

    const orgs: OrgRow[] = []
    const teams: IconFree<'teams'>[] = []
    const teamMembers: AppRow<'team_members'>[] = []
    const profiles: AppRow<'profiles'>[] = []
    const projects: IconFree<'projects'>[] = []
    const access: AppRow<'project_access'>[] = []
    const teamAccess: AppRow<'project_team_access'>[] = []
    const issues: (Omit<AppRow<'issues'>, 'relations_marked'> & {
      has_hidden_subtasks: boolean
      has_hidden_parent: boolean
    })[] = []
    const links: RelationRow<'issue_links'>[] = []
    const labels: AppRow<'labels'>[] = []
    const issueLabels: RelationRow<'issue_labels'>[] = []
    const issueSubs: RelationRow<'issue_subscriptions'>[] = []
    const attachments: ReturnType<typeof attachmentRow>[] = []
    const milestones: AppRow<'milestones'>[] = []
    const orgLoad: OrgLoadRow[] = []
    const activityDocs: Doc<'activity_events'>[] = []
    const unreadDocs: Doc<'messages'>[] = []
    const readDocs: Doc<'messages'>[] = []
    // whether some seat's bounded inbox read left unread (read) rows
    // unexamined that Mark all as read (Remove all read) reaches
    let unreadTruncated = false
    let readTruncated = false
    const seenLinkIds = new Set<string>()
    /* Live tasks and project rows fill these caches below. Only an admin's
     * activity row about a task outside the live set needs a lookup; never
     * walk the whole archive just to exclude it. Cache promises too so
     * concurrent references to the same task share one read. */
    const archivedProjects = new Map<string, Promise<boolean>>()
    const archivedIssues = new Map<string, Promise<boolean>>()
    const isArchivedProject = (projectId: string): Promise<boolean> => {
      let result = archivedProjects.get(projectId)
      if (result === undefined) {
        result = byId(ctx, 'projects', projectId).then(
          (project) => project?.archived_at !== undefined,
        )
        archivedProjects.set(projectId, result)
      }
      return result
    }
    const isArchivedIssue = (issueId: string): Promise<boolean> => {
      let result = archivedIssues.get(issueId)
      if (result === undefined) {
        result = byId(ctx, 'issues', issueId).then(async (issue) => {
          if (issue === null) return false
          return issue.archived_at !== undefined || (await isArchivedProject(issue.project_id))
        })
        archivedIssues.set(issueId, result)
      }
      return result
    }

    for (const me of ctx.myProfiles.values()) {
      const orgId = me.org_id
      const org = await byId(ctx, 'organizations', orgId)
      if (org === null) continue // a seat in a vanished org contributes nothing
      const isAdmin = me.org_role === 'admin'

      orgs.push(orgRowFor(org, await countersOf(ctx, org), isAdmin))

      // All org members see teams and their membership.
      const orgTeams = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      for (const team of orgTeams) {
        teams.push(iconFree(team))
        const members = await ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .collect()
        for (const m of members) teamMembers.push(rowOf(m))
      }

      // Include inactive, agent and unclaimed profiles in the org roster.
      // Clients paint the avatar color as a CSS background, so an older
      // non-hex value goes out as gray.
      const orgProfiles = await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      const orgProfileIds = new Set<string>()
      for (const p of orgProfiles) {
        profiles.push({ ...rowOf(p), color: shownAvatarColor(p.color) })
        orgProfileIds.add(p.id)
      }

      // Archived project metadata remains available for navigation. Every
      // seat reads the active tasks of every active project, its own or not,
      // because a parent's group state and the anonymized load rows depend
      // on tasks the member cannot see.
      const view = await orgProjectView(ctx, me)
      const liveOrgIssues = await liveTasksOf(ctx, view.projects)
      for (const p of view.projects) {
        archivedProjects.set(p.id, Promise.resolve(p.archived_at !== undefined))
      }
      const visibleProjects = view.projects.filter((p) => view.visible(p.id))
      for (const issue of liveOrgIssues) archivedIssues.set(issue.id, Promise.resolve(false))
      /* The working set is the active tasks of visible, active projects
       * (lib/workingSet.ts). Every task id this query sends (task rows,
       * parent ids, links, own subscriptions, inbox messages and activity
       * targets) belongs to it. A task related to work outside it learns
       * only that such work exists (has_hidden_subtasks, has_hidden_parent).
       * Visible children remain client-derived so optimistic
       * detaching/deleting the last one immediately restores normal status.
       * Archived issues are deliberately absent from the working set; their
       * detail rows are fetched only by the archive/read paths that
       * explicitly ask for one. A subtask in an archived project makes no
       * task here a group (lib/liveTasks.ts countsAsSubtask), so the live
       * tasks are all has_hidden_subtasks needs. */
      const workingSet = workingSetOf(liveOrgIssues, view)
      const fenceIssues = workingSet.tasks
      for (const issue of fenceIssues) {
        // relations_marked only steers the relation reads below
        const { parent_id: _parentId, relations_marked: _marks, ...row } = rowOf(issue)
        issues.push({
          ...row,
          ...parentLink(issue, workingSet.shown),
          has_hidden_subtasks: workingSet.hasHiddenSubtasks(issue.id),
        })
      }
      for (const p of visibleProjects) {
        projects.push(iconFree(p))

        // Every grant on a visible project, including other members' grants.
        const [grants, teamGrants] = await Promise.all([
          ctx.db
            .query('project_access')
            .withIndex('by_project', (q) => q.eq('project_id', p.id))
            .collect(),
          ctx.db
            .query('project_team_access')
            .withIndex('by_project', (q) => q.eq('project_id', p.id))
            .collect(),
        ])
        for (const g of grants) access.push(rowOf(g))
        for (const g of teamGrants) teamAccess.push(rowOf(g))

        if (p.archived_at === undefined) {
          // Milestones belong to the active working set.
          const ms = await ctx.db
            .query('milestones')
            .withIndex('by_project', (q) => q.eq('project_id', p.id))
            .collect()
          for (const m of ms) milestones.push(rowOf(m))
        }
      }

      const relatedRows = await snapshotRelations(ctx, {
        orgId,
        tasks: fenceIssues,
        active: liveOrgIssues.length,
      })
      for (const issue of fenceIssues) {
        const [asSource, asTarget, ils, atts] = await relatedRows(issue.id)
        // Both ends must be in this working set. The other end may be
        // archived, deleted or in a project this member cannot access, and
        // its id must not leave this query.
        for (const link of [...asSource, ...asTarget]) {
          if (seenLinkIds.has(link.id)) continue
          if (!linkShown(link, workingSet.shown)) continue
          seenLinkIds.add(link.id)
          links.push(relationRow(link))
        }
        // issueLabels of active tasks only. Archived tasks are read outside
        // this snapshot (P.fetchArchivedPage, issues.archivedPage), so it
        // needs no archived rows here.
        for (const il of ils) issueLabels.push(relationRow(il))
        // attachments — active tasks only. This is the expensive storage row
        // that previously made every archive part of the initial boot.
        for (const a of atts) attachments.push(attachmentRow(a))
      }

      // Guests also see the host org's label vocabulary. Clients paint the
      // color as a CSS background, so an older non-hex value goes out as gray.
      const orgLabels = await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      for (const l of orgLabels) labels.push({ ...rowOf(l), color: shownLabelColor(l.color) })

      // Only the caller's subscriptions, across all seats, and only for tasks
      // in this working set. A subscription outlives access so a manager can
      // still remove it, but its task id must not leave this query. Follows
      // of archived tasks are marked in the background (model/archiveMarks.ts)
      // and skipped by index; an unmarked one is filtered here. They stay
      // stored, still bring news and return with a restore. A visible task
      // restored before its marks were cleared (relations_marked) has its
      // follow read by its own index, and every follow goes out in creation
      // order, the order of the caller's index.
      const mySubs = await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_profile_task_archived', (q) =>
          q.eq('profile_id', me.id).eq('task_archived', undefined),
        )
        .collect()
      for (const issue of fenceIssues) {
        if (issue.relations_marked !== true) continue
        const follow = await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_profile', (q) => q.eq('issue_id', issue.id).eq('profile_id', me.id))
          .unique()
        if (follow?.task_archived === true) mySubs.push(follow)
      }
      mySubs.sort((x, y) => x._creationTime - y._creationTime)
      for (const s of aboutShownTasks(mySubs, workingSet.shown)) issueSubs.push(relationRow(s))

      // Activity, for Team Sync: the task rows among the organization's
      // newest CAP rows. Org admins receive every one except those about
      // archived tasks or tasks in archived projects; other members receive
      // only the rows memberSeesActivity allows. Rows about anything but a
      // task reach no client. The task window reads one task's history in
      // commentThread instead. Walked ts-desc; the blend below keeps at most
      // CAP rows, so stop early.
      const orgActivity = await ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .order('desc')
        .take(CAP)
      // Task numbers resolve to projects from the live set, else one cached
      // indexed read (archived or deleted tasks, and tasks in archived
      // projects).
      const taskProjects = new Map<number, Promise<string | undefined>>(
        liveOrgIssues.map((i) => [i.num, Promise.resolve(i.project_id)]),
      )
      const taskProject = (num: number): Promise<string | undefined> => {
        let result = taskProjects.get(num)
        if (result === undefined) {
          result = ctx.db
            .query('issues')
            .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', num))
            .first()
            .then((issue) => issue?.project_id)
          taskProjects.set(num, result)
        }
        return result
      }
      let kept = 0
      for (const ev of orgActivity) {
        // admins skip the rule below, so this keeps non-task rows from them too
        if (ev.target_type !== 'issue') continue
        if (
          !isAdmin &&
          !(await memberSeesActivity(ev, { view, inWorkingSet: workingSet.shown, taskProject }))
        )
          continue
        if (await isArchivedIssue(ev.target_id)) continue
        activityDocs.push(isAdmin ? ev : withoutLegacySubtaskCount(ev))
        if (++kept >= CAP) break
      }

      // The caller's inbox, limited to tasks in this working set and read
      // within lib/inbox.ts's bounds, so a backlog nobody clears cannot stop
      // the app from loading; the blended cap applies below. The machine
      // inbox reads with the same INBOX_LIMIT, so the rows this seat
      // delivers are among the ones the API lists for it. Rows about an
      // archived task, a task in an archived project or a task the caller
      // can no longer access stay stored and return if the task or access
      // does, unless they were removed meanwhile. An archive marks the rows
      // about its tasks read in the background (model/messages.ts), so the
      // retention sweep and removeRead delete them like any read row, and
      // the ones left come back read once that has run.
      const inbox = await loadInbox(ctx, me.id, workingSet.shown, INBOX_LIMIT, INBOX_LIMIT)
      unreadDocs.push(...inbox.unread)
      readDocs.push(...inbox.read)
      unreadTruncated ||= inbox.unreadTruncated
      readTruncated ||= inbox.readTruncated

      // Hidden workload remains anonymized by orgLoadRows.
      orgLoad.push(...orgLoadRows(me, view, orgProfileIds, liveOrgIssues))
    }

    // One newest-first cap across all organizations.
    activityDocs.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1))
    const activity = activityDocs.slice(0, CAP).map(rowOf)

    // One cap across all organizations, unread rows first, newest first,
    // then read rows, most recently read first, as the list shows them.
    unreadDocs.sort(newestFirst)
    readDocs.sort(recentlyReadFirst)
    // Cleanup must remain available when unread rows fill the client cap and
    // hide every read notification. Count the read rows each seat's bounded
    // read kept (at most INBOX_LIMIT per seat), before the cut, minus snoozed
    // rows, which messages.removeRead leaves alone. The client only asks
    // whether it is above zero. removeRead also deletes read rows about tasks
    // the caller is not shown, archived ones included; they are not counted
    // because the caller cannot see them.
    const readMessageCount = readDocs.reduce(
      (count, message) => count + (message.snoozed_until === undefined ? 1 : 0),
      0,
    )
    const messages = [...unreadDocs, ...readDocs].slice(0, CAP).map(rowOf)
    // When several seats keep unread rows, the cut can drop some that Mark
    // all as read reaches while every unread row delivered is snoozed. Read
    // rows it drops are in readMessageCount already.
    if (unreadDocs.slice(CAP).some((message) => message.snoozed_until === undefined)) {
      unreadTruncated = true
    }

    // Logs a read that used half of any per-transaction read limit, so an
    // organization approaching Convex's limits shows in the deployment logs
    // before its members' app stops loading. Organization ids and counts
    // only, never names or content.
    const metrics = await ctx.meta.getTransactionMetrics()
    const reads = [metrics.bytesRead, metrics.documentsRead, metrics.databaseQueries]
    if (reads.some((m) => m.used >= m.remaining)) {
      console.warn('Snapshot read near Convex limits', {
        org_ids: orgs.map((o) => o.id),
        seats: ctx.myProfiles.size,
        tasks: issues.length,
        bytes_read: metrics.bytesRead.used,
        documents_read: metrics.documentsRead.used,
        index_ranges: metrics.databaseQueries.used,
      })
    }

    return {
      auth_user_id: ctx.authUserId,
      myProfileIds: [...ctx.myProfiles.values()].map((p) => p.id),
      orgs,
      teams,
      teamMembers,
      profiles,
      projects,
      access,
      teamAccess,
      issues,
      links,
      labels,
      issueLabels,
      issueSubs,
      attachments,
      milestones,
      activity,
      messages,
      readMessageCount,
      // A seat's bounded read can stop before it reaches every row, also when
      // rows about tasks the caller is not shown fill its examination budget.
      // Unread (read) rows may then exist that neither `messages` nor the
      // count includes. While the flag is true, the client keeps Mark all as
      // read (Remove all read) available, because it reaches every row that
      // is not snoozed. Both skip snoozed rows, so the flag stays false when
      // the rows left are all snoozed, unless more than INBOX_LIMIT are
      // (lib/inbox.ts loadInbox `peek`).
      unreadTruncated,
      readTruncated,
      orgLoad,
      // the server time of this delivery, so the client can tell messages
      // created before it from newer ones without trusting its own clock
      delivered_at: new Date().toISOString(),
    }
  },
})

/* The task `issueId` when the caller can see it. Unknown, foreign and
 * invisible task IDs all refuse with the same not-found sentence. Comments
 * remain available on visible archived tasks. */
async function threadTask(
  ctx: QueryCtx & { me: Doc<'profiles'> },
  issueId: string,
): Promise<{ issue: Doc<'issues'>; project: Doc<'projects'> }> {
  const issue = await byId(ctx, 'issues', issueId)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null || !(await canSeeProject(ctx, ctx.me, project))) {
    throw notFound('task not found')
  }
  return { issue, project }
}

/* The task window's live thread. It holds the thread's newest
 * COMMENT_PAGE_MAX comments, and fewer when they are long, oldest first in
 * thread order, and says whether the thread holds earlier ones
 * (model/comments.ts threadPage). The window reads further back with
 * commentsBefore. `events` holds the task's history the caller receives
 * (lib/activityVisibility.ts taskActivity), oldest first, and is empty for
 * an archived task or a task in an archived project, which the app does not
 * show. */
export const commentThread = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue, project } = await threadTask(ctx, issue_id)
    // comments first: the page counts only its own bytes (model/comments.ts
    // newestComments), so taskActivity's room check must see what it spent
    const page = await threadPage(ctx, issue.id)
    // the app shows history only for a task in the working set (lib/workingSet.ts);
    // threadTask already refused a project the caller cannot see
    const events = inWorkingSet(issue, project, true) ? await taskActivity(ctx, ctx.me, issue) : []
    return { comments: page.comments.map(rowOf), earlier: page.earlier, events: events.map(rowOf) }
  },
})

/* The page "Show earlier comments" loads. It holds the newest
 * COMMENT_PAGE_MAX comments the thread holds before the comment `before`, in
 * commentThread's shape without events. The app reads it once rather than subscribing. A
 * `before` that is not a comment on this task, deleted ones included,
 * refuses with BEFORE_NOT_A_COMMENT as a bad_request. */
export const commentsBefore = orgQuery({
  args: { issue_id: v.string(), before: v.string() },
  handler: async (ctx, { issue_id, before }) => {
    const { issue } = await threadTask(ctx, issue_id)
    const anchor = await commentAnchor(ctx, issue.id, before)
    const page = await threadPage(ctx, issue.id, anchor)
    return { comments: page.comments.map(rowOf), earlier: page.earlier }
  },
})

/* The thread as browser tabs loaded before commentThread subscribe to it,
 * the newest COMMENT_PAGE_MAX comments sorted by created_at with ties by
 * id. Remove it in the release after commentThread ships. */
export const commentsForIssue = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue } = await threadTask(ctx, issue_id)
    const thread = await newestComments(ctx, issue.id, { limit: COMMENT_PAGE_MAX })
    // created_at asc, id tiebreak — the order spine.ts depends on
    thread.sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )
    return thread.map(rowOf)
  },
})
