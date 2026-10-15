// Reactive active working set across the caller's organizations. Archives and
// comments load on demand; rows omit Convex system fields and internal counters.
import { v } from 'convex/values'
import type { Doc, TableNames } from './_generated/dataModel'
import { canSeeProject } from './lib/access'
import { memberSeesActivity, withoutLegacySubtaskCount } from './lib/activityVisibility'
import { byId } from './lib/db'
import { authedQuery, notFound, orgQuery } from './lib/functions'
import { loadInbox } from './lib/inbox'
import { snapshotRelations } from './lib/snapshotRelations'
import { orgProjectView } from './lib/visibility'
import { aboutShownTasks, linkShown, parentLink, workingSetOf } from './lib/workingSet'
import { shownLabelColor } from './model/labels'
import { shownAvatarColor } from './model/people'
import { type OrgLoadRow, orgLoadRows } from './planning'

type AppRow<T extends TableNames> = Omit<Doc<T>, '_id' | '_creationTime'>

function rowOf<D extends { _id: unknown; _creationTime: number }>(
  doc: D,
): Omit<D, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...row } = doc
  return row
}

function relationRow<D extends { _id: unknown; _creationTime: number; org_id?: string }>(doc: D) {
  const { org_id: _orgId, ...row } = rowOf(doc)
  return row
}

// Billing is admin-only; application counters and settings are shared.
type OrgRow = Omit<AppRow<'organizations'>, 'billing' | 'activity_count'> & {
  billing?: Doc<'organizations'>['billing']
}

const orgRowFor = (doc: Doc<'organizations'>, isAdmin: boolean): OrgRow => {
  const { _id, _creationTime, billing, activity_count: _activityCount, ...rest } = doc
  return isAdmin && billing !== undefined ? { ...rest, billing } : rest
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
    const teams: AppRow<'teams'>[] = []
    const teamMembers: AppRow<'team_members'>[] = []
    const profiles: AppRow<'profiles'>[] = []
    const projects: AppRow<'projects'>[] = []
    const access: AppRow<'project_access'>[] = []
    const teamAccess: AppRow<'project_team_access'>[] = []
    const issues: (AppRow<'issues'> & {
      has_hidden_subtasks: boolean
      has_hidden_parent: boolean
    })[] = []
    const links: Omit<AppRow<'issue_links'>, 'org_id'>[] = []
    const labels: AppRow<'labels'>[] = []
    const issueLabels: Omit<AppRow<'issue_labels'>, 'org_id'>[] = []
    const issueSubs: AppRow<'issue_subscriptions'>[] = []
    const attachments: Omit<AppRow<'issue_attachments'>, 'org_id'>[] = []
    const milestones: AppRow<'milestones'>[] = []
    const orgLoad: OrgLoadRow[] = []
    const activityDocs: Doc<'activity_events'>[] = []
    const unreadDocs: Doc<'messages'>[] = []
    const readDocs: Doc<'messages'>[] = []
    // Cleanup must remain available when unread rows fill the client cap and
    // hide every read notification. Count the read rows each seat's bounded
    // read kept (at most CAP per seat), listed or not, minus snoozed rows,
    // which messages.removeRead leaves alone. The client only asks whether
    // it is above zero. removeRead also deletes read rows about tasks the
    // caller can no longer access; they are not counted because the caller
    // cannot see them.
    let readMessageCount = 0
    const seenLinkIds = new Set<string>()
    /* Active tasks and project rows fill these caches below. Only an admin's
     * activity row about a task outside the active set needs a lookup; never
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

      orgs.push(orgRowFor(org, isAdmin))

      // All org members see teams and their membership.
      const orgTeams = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      /* per-team "me leads it" — is_team_leader amortized over the membership
       * rows already in hand; memberSeesActivity restates canLeadTeams */
      const leaderOf = new Map<string, boolean>()
      for (const team of orgTeams) {
        teams.push(rowOf(team))
        const members = await ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .collect()
        for (const m of members) teamMembers.push(rowOf(m))
        leaderOf.set(
          team.id,
          members.some((m) => m.profile_id === me.id && m.is_leader),
        )
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

      // Archived project metadata remains available for navigation.
      const [view, activeOrgIssues] = await Promise.all([
        orgProjectView(ctx, me),
        ctx.db
          .query('issues')
          .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', undefined))
          .collect(),
      ])
      for (const p of view.projects) {
        archivedProjects.set(p.id, Promise.resolve(p.archived_at !== undefined))
      }
      const visibleProjects = view.projects.filter((p) => view.visible(p.id))
      for (const issue of activeOrgIssues) {
        archivedIssues.set(
          issue.id,
          Promise.resolve(view.byUuid.get(issue.project_id)?.archived_at !== undefined),
        )
      }
      /* The working set is the active tasks of visible, active projects
       * (lib/workingSet.ts). Every task id this query sends (task rows,
       * parent ids, links, own subscriptions, inbox messages and activity
       * targets) belongs to it. A task related to work outside it learns
       * only that such work exists (has_hidden_subtasks, has_hidden_parent).
       * Visible children remain client-derived so optimistic
       * detaching/deleting the last one immediately restores normal status.
       * Archived issues are deliberately absent from the working set; their
       * detail rows are fetched only by the archive/read paths that
       * explicitly ask for one. */
      const workingSet = workingSetOf(activeOrgIssues, view)
      const fenceIssues = workingSet.tasks
      for (const issue of fenceIssues) {
        const { parent_id: _parentId, ...row } = rowOf(issue)
        issues.push({
          ...row,
          ...parentLink(issue, workingSet.shown),
          has_hidden_subtasks: workingSet.hasHiddenSubtasks(issue.id),
        })
      }
      for (const p of visibleProjects) {
        projects.push(rowOf(p))

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

      const relatedRows = await snapshotRelations(ctx, org, fenceIssues.length)
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
        // issueLabels — active tasks only; fetchArchived does not depend on
        // this snapshot and therefore does not need the archived rows here.
        for (const il of ils) issueLabels.push(relationRow(il))
        // attachments — active tasks only. This is the expensive storage row
        // that previously made every archive part of the initial boot.
        for (const a of atts) attachments.push(relationRow(a))
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
      // still remove it, but its task id must not leave this query.
      const mySubs = await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
        .collect()
      for (const s of aboutShownTasks(mySubs, workingSet.shown)) issueSubs.push(rowOf(s))

      // Activity: org admins receive every row except those about archived
      // tasks or tasks in archived projects; other members receive only the
      // rows memberSeesActivity allows. Walked ts-desc; the global cap makes
      // >CAP kept rows here unreachable, so stop early.
      const orgActivity = ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .order('desc')
      // Task numbers resolve to projects from the active set, else one cached
      // indexed read (archived or deleted tasks).
      const taskProjects = new Map<number, Promise<string | undefined>>(
        activeOrgIssues.map((i) => [i.num, Promise.resolve(i.project_id)]),
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
      for await (const ev of orgActivity) {
        if (
          !isAdmin &&
          !(await memberSeesActivity(ev, {
            me,
            view,
            inWorkingSet: workingSet.shown,
            leaderOf,
            taskProject,
          }))
        )
          continue
        if (ev.target_type === 'issue' && (await isArchivedIssue(ev.target_id))) continue
        activityDocs.push(isAdmin ? ev : withoutLegacySubtaskCount(ev))
        if (++kept >= CAP) break
      }

      // The caller's inbox, limited to tasks in this working set and read
      // within lib/inbox.ts's bounds, so a backlog nobody clears cannot stop
      // the app from loading; the blended cap applies below. Rows about a
      // task the caller can no longer access stay stored and return if
      // access does.
      const inbox = await loadInbox(ctx, me.id, workingSet.shown, CAP)
      unreadDocs.push(...inbox.unread)
      // The list puts every unread row first, so read rows wait while some
      // of this seat's unread rows went unexamined (rows about hidden tasks
      // used the bound); the machine inbox follows the same rule.
      if (!inbox.unreadTruncated) readDocs.push(...inbox.read)
      for (const row of inbox.read) if (row.snoozed_until === undefined) readMessageCount += 1

      // Hidden workload remains anonymized by orgLoadRows.
      orgLoad.push(...orgLoadRows(me, view, orgProfileIds, activeOrgIssues))
    }

    // One newest-first cap across all organizations.
    activityDocs.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1))
    const activity = activityDocs.slice(0, CAP).map(rowOf)

    // One cap across all organizations, unread rows first, newest first,
    // then read rows, most recently read first, as the list shows them.
    unreadDocs.sort(newestFirst)
    readDocs.sort(recentlyReadFirst)
    const messages = [...unreadDocs, ...readDocs].slice(0, CAP).map(rowOf)

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
      orgLoad,
      // the server time of this delivery, so the client can tell messages
      // created before it from newer ones without trusting its own clock
      delivered_at: new Date().toISOString(),
    }
  },
})

// Comments remain available on visible archived tasks. Unknown, foreign and
// invisible task IDs all return the same not-found refusal.
export const commentsForIssue = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const issue = await byId(ctx, 'issues', issue_id)
    if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project === null || !(await canSeeProject(ctx, ctx.me, project))) {
      throw notFound('task not found')
    }
    const thread = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
      .collect()
    // created_at asc, id tiebreak — the order spine.ts depends on
    thread.sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )
    return thread.map(rowOf)
  },
})
