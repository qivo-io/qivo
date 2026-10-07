// Reactive active working set across the caller's organizations. Archives and
// comments load on demand; rows omit Convex system fields and internal counters.
import { v } from 'convex/values'
import type { Doc, TableNames } from './_generated/dataModel'
import { canSeeProject } from './lib/access'
import { byId } from './lib/db'
import { authedQuery, notFound, orgQuery } from './lib/functions'
import { snapshotRelations } from './lib/snapshotRelations'
import { orgProjectView } from './lib/visibility'
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

// Unread first, then read_at ascending and created_at descending.
const messageOrder = (a: Doc<'messages'>, b: Doc<'messages'>): number => {
  if ((a.read_at === undefined) !== (b.read_at === undefined)) {
    return a.read_at === undefined ? -1 : 1
  }
  if (a.read_at !== undefined && b.read_at !== undefined && a.read_at !== b.read_at) {
    return a.read_at < b.read_at ? -1 : 1
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return 0
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
    const issues: (AppRow<'issues'> & { has_hidden_subtasks: boolean })[] = []
    const links: Omit<AppRow<'issue_links'>, 'org_id'>[] = []
    const labels: AppRow<'labels'>[] = []
    const issueLabels: Omit<AppRow<'issue_labels'>, 'org_id'>[] = []
    const issueSubs: AppRow<'issue_subscriptions'>[] = []
    const attachments: Omit<AppRow<'issue_attachments'>, 'org_id'>[] = []
    const milestones: AppRow<'milestones'>[] = []
    const orgLoad: OrgLoadRow[] = []
    const activityDocs: Doc<'activity_events'>[] = []
    const messageDocs: Doc<'messages'>[] = []
    const seenLinkIds = new Set<string>()
    /* Active tasks and project rows fill these caches below. Only a legacy
     * inbox/activity/link reference outside the active set needs a lookup;
     * never walk the whole archive just to exclude it. Cache promises too so
     * concurrent references to the same task share one read. Missing tasks
     * retain the existing historical-message/activity fallback. */
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
       * rows already in hand; the viewer fence is restated at the use site */
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
      const orgProfiles = await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      const orgProfileIds = new Set<string>()
      for (const p of orgProfiles) {
        profiles.push(rowOf(p))
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
      // Preserve grouping when a child is absent from this working set.
      // Only existence is disclosed; no hidden task or project ids leave
      // this query. Visible children remain client-derived so optimistic
      // detaching/deleting the last one immediately restores normal status.
      const hiddenSubtaskParents = new Set<string>()
      const fenceIssues: Doc<'issues'>[] = []
      for (const child of activeOrgIssues) {
        const childProject = view.byUuid.get(child.project_id)
        const projectArchived = childProject?.archived_at !== undefined
        archivedIssues.set(child.id, Promise.resolve(projectArchived))
        if (view.visible(child.project_id) && !projectArchived) {
          fenceIssues.push(child)
        }
        if (child.parent_id === undefined) continue
        if (!view.visible(child.project_id) || projectArchived) {
          hiddenSubtaskParents.add(child.parent_id)
        }
      }
      /* Active issues of every visible, active project.  Archived issues are
       * deliberately absent from the working set; their detail rows are
       * fetched only by the archive/read paths that explicitly ask for one. */
      for (const issue of fenceIssues) {
        issues.push({ ...rowOf(issue), has_hidden_subtasks: hiddenSubtaskParents.has(issue.id) })
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
        const candidates = [
          ...new Map([...asSource, ...asTarget].map((link) => [link.id, link])).values(),
        ].filter((link) => !seenLinkIds.has(link.id))
        const archivedEndpoints = await Promise.all(
          candidates.map(async (link) => ({
            link,
            archived:
              (await isArchivedIssue(link.source_id)) || (await isArchivedIssue(link.target_id)),
          })),
        )
        for (const { link, archived } of archivedEndpoints) {
          if (seenLinkIds.has(link.id)) continue
          if (archived) continue
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

      // Guests also see the host org's label vocabulary.
      const orgLabels = await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
      for (const l of orgLabels) labels.push(rowOf(l))

      // Only the caller's subscriptions, across all seats.
      const mySubs = await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
        .collect()
      const subStatuses = await Promise.all(
        mySubs.map(async (s) => ({ row: s, archived: await isArchivedIssue(s.issue_id) })),
      )
      for (const { row, archived } of subStatuses) if (!archived) issueSubs.push(rowOf(row))

      // Activity: project row ⇒ visible project;
      // team row ⇒ org admin or team leader (never a viewer); org-wide row ⇒
      // any member. Walked ts-desc; the global cap makes >CAP kept rows here
      // unreachable, so stop early.
      const orgActivity = ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .order('desc')
      let kept = 0
      for await (const ev of orgActivity) {
        if (ev.project_id !== undefined) {
          if (!view.visible(ev.project_id)) continue
        } else if (ev.team_id !== undefined) {
          const leads = me.org_role !== 'viewer' && leaderOf.get(ev.team_id) === true
          if (!isAdmin && !leads) continue
        }
        if (ev.target_type === 'issue' && (await isArchivedIssue(ev.target_id))) continue
        activityDocs.push(ev)
        if (++kept >= CAP) break
      }

      // The caller's inbox; apply the blended cap below.
      const inbox = await ctx.db
        .query('messages')
        .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
        .collect()
      const messageStatuses = await Promise.all(
        inbox.map(async (message) => ({
          row: message,
          archived: await isArchivedIssue(message.issue_id),
        })),
      )
      messageDocs.push(...messageStatuses.filter(({ archived }) => !archived).map(({ row }) => row))

      // Hidden workload remains anonymized by orgLoadRows.
      orgLoad.push(...orgLoadRows(me, view, orgProfileIds, activeOrgIssues))
    }

    // One newest-first cap across all organizations.
    activityDocs.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1))
    const activity = activityDocs.slice(0, CAP).map(rowOf)

    messageDocs.sort(messageOrder)
    // Cleanup must remain available when unread rows fill the client cap and
    // hide every read notification. Count the full inbox across all seats —
    // minus snoozed rows, which messages.removeRead leaves alone.
    const readMessageCount = messageDocs.reduce(
      (count, message) =>
        count + (message.read_at !== undefined && message.snoozed_until === undefined ? 1 : 0),
      0,
    )
    const messages = messageDocs.slice(0, CAP).map(rowOf)

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
