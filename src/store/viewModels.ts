/** Pure snapshot-to-view transformations. Store identity and caches arrive as arguments. */
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { reviewerOwns, taskOwnerId } from '../../convex/lib/review'
import type { SyncStamp } from '../../convex/lib/teamSync'
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_WEEK_ONE_RULE,
  DEFAULT_WEEK_START,
  isoToWeek,
  tsToWeek,
} from '../lib/dates'
import { sampleAvatarUrl } from '../lib/demoAvatars'
import { DEFAULT_PLANNABLE_HOURS } from '../lib/workload'
import type { Row } from './rows'

type TeamAccessLevel = Row<'project_team_access'>['level']

/** Match server ordering, including ties, before converting timestamps to milliseconds. */
export const isNewer = (aStamp: string, aId: string, bStamp: string, bId: string) =>
  bStamp > aStamp || (bStamp === aStamp && bId > aId)

/* A person's Team sync stamp as the shared rule reads it (convex/lib/teamSync.ts):
   null until a change has been made on them through the sync page. */
export const syncStampOf = (u: Row<'profiles'>): SyncStamp | null =>
  u.sync_at === undefined ? null : { at: u.sync_at, since: u.sync_since }

export const shapeUser = (
  u: Row<'profiles'>,
  teams: string[],
  teamLeads: string[],
  avatarUrl: string | null,
  demoMode: boolean,
) => ({
  id: u.id,
  name: u.name,
  color: u.color,
  initials: u.initials,
  // An uploaded picture suppresses Gravatar even while its bytes are loading.
  avatarPath: u.avatar_storage_id || (u.sample_avatar ? `sample:${u.sample_avatar}` : null),
  avatarUrl: u.avatar_storage_id ? avatarUrl : sampleAvatarUrl(u.sample_avatar),
  sampleAvatar: !!u.sample_avatar && !u.avatar_storage_id,
  // Team memberships receive each team's explicit project grants.
  orgRole: u.org_role,
  teams,
  teamLeads,
  email: u.email,
  // A null agent capacity means unbounded; a missing person uses the fallback.
  plannableHours: u.plannable_hours == null ? null : Number(u.plannable_hours),
  // an agent is a user that is not a person (0100): no email, no login,
  // authenticating with a qva_ key instead. `active` is the switch that
  // takes a seat and every right away without deleting anything (0099).
  kind: u.kind,
  isAgent: u.kind === 'agent',
  active: u.active,
  // days a READ inbox message is kept before the sweep takes it (0110);
  // null is "Never", and has to survive as null — 0 would be a period
  messageRetentionDays: u.message_retention_days == null ? null : Number(u.message_retention_days),
  // org (0081): the roster is blended across every org I can see, so each
  // person carries theirs. `pending` = an invited seat nobody has claimed
  // — which an agent never is: it has no login to wait for, so the
  // bare auth_user_id test would brand every agent "invited" for ever
  org: u.org_id,
  pending: !demoMode && u.kind !== 'agent' && !u.auth_user_id,
  // the latest change made on this person through Team sync (P.syncStamp);
  // "Done since", "untouched" and "changed" read from it through syncSince
  sync: syncStampOf(u),
})
export type UserVM = ReturnType<typeof shapeUser>

/* P.org IS the home org (the one whose settings the app runs on) — identity
   from the HOME row (empty for a guest-only login), display settings from a
   visible org as a fallback so shared work still draws on its owners' grid. */
export const shapeOrg = (
  home: Row<'organizations'> | null,
  displayOrg: Row<'organizations'> | null,
  billing: Row<'organizations'>['billing'] | null,
) => ({
  id: home ? home.id : '',
  name: home ? home.name : '',
  slug: home ? home.slug : '',
  plan: billing ? billing.plan : 'Team',
  // Missing billing is unconfigured, never a zero-user roster limit.
  seats: billing ? billing.seats : null,
  renewalWeek: billing?.renewal_date ? isoToWeek(billing.renewal_date) : 0,
  // the renewal is a real calendar date — round-tripping it through the
  // week grid would floor it to the week start under non-Monday grids
  renewalDate: billing ? billing.renewal_date : null,
  dateFormat: displayOrg?.date_format ? displayOrg.date_format : DEFAULT_DATE_FORMAT,
  weekStart: displayOrg ? displayOrg.week_start : DEFAULT_WEEK_START,
  weekOneRule: displayOrg ? displayOrg.week_one_rule : DEFAULT_WEEK_ONE_RULE,
  // the plannable week a NEW user starts on (0092). Unlike the display
  // settings above this one is the HOME org's without a fallback: it governs
  // people added to my organization, and a guest-only login adds none.
  defaultPlannableHours: home ? Number(home.default_plannable_hours) : DEFAULT_PLANNABLE_HOURS,
  maxAttachmentMb: home?.max_attachment_mb ?? 20,
  onlyTeamLeadsManageProjectUsers: home?.only_team_leads_manage_project_users !== false,
  // may the browser ask gravatar.com for a picture (0096)? The HOME org's
  // answer governs every avatar the app draws, including people from
  // organizations that shared a project with me — it is a statement about
  // requests THIS browser makes, not about whose profile is being drawn.
  gravatarAvatars: home ? home.gravatar_avatars !== false : true,
})
export type OrgVM = ReturnType<typeof shapeOrg>

/* every organization I hold a profile in, so foreign projects can be grouped
   under their owner's name */
export const shapeOrgRef = (o: Row<'organizations'>) => ({ id: o.id, name: o.name, slug: o.slug })
export type OrgRefVM = ReturnType<typeof shapeOrgRef>

export const shapeTeam = (t: Row<'teams'>) => ({
  id: t.id,
  name: t.name,
  org: t.org_id,
  icon: t.icon || null,
  iconColor: t.icon_color || null,
  staleDays: t.stale_days,
  archiveDays: t.archive_days,
  trackDelayDefault: t.track_delay_default !== false,
})
export type TeamVM = ReturnType<typeof shapeTeam>

export const shapeLabel = (l: Row<'labels'>) => ({
  id: l.id,
  name: l.name,
  color: l.color,
  org: l.org_id,
})
export type LabelVM = ReturnType<typeof shapeLabel>

/* projects — children / access are derived. The lead is projects.lead_id —
   grant rows never store 'lead' — but access surfaces them as one map. */
const withLead = (acc: Record<string, string> | undefined, lead: string | null | undefined) => {
  const m = Object.assign({}, acc || {})
  if (lead) m[lead] = 'lead'
  return m
}
export const byOrder = (a: Row<'projects'>, b: Row<'projects'>) =>
  a.sort_order - b.sort_order || (a.created_at < b.created_at ? -1 : 1)
/** Active and archived projects stay in separate lists, including their children. */
export const shapeProject = (
  p: Row<'projects'>,
  childrenOf: Map<string, Row<'projects'>[]>,
  accByProject: Map<string, Record<string, string>>,
  teamAccByProject: Map<string, Record<string, TeamAccessLevel>>,
) => ({
  id: p.id,
  key: p.key,
  num: p.num,
  name: p.name,
  type: p.type,
  org: p.org_id, // 0081: the sidebar groups foreign projects by org
  parent: p.parent_id || undefined,
  trackDelay: p.track_delay !== false,
  // the row's OWN review time; undefined inherits (P.reviewHoursFor resolves)
  reviewHours: p.review_hours,
  icon: p.icon || null,
  iconColor: p.icon_color || null,
  lead: p.lead_id || undefined,
  description: p.description || undefined,
  archivedAt: p.archived_at ? new Date(p.archived_at).getTime() : null,
  children:
    p.type === 'meta'
      ? (childrenOf.get(p.id) || [])
          .filter((c) => !!c.archived_at === !!p.archived_at)
          .sort(byOrder)
          .map((c) => c.id)
      : undefined,
  access: withLead(accByProject.get(p.id), p.lead_id),
  teamAccess: teamAccByProject.get(p.id) || {},
})
export type ProjectVM = ReturnType<typeof shapeProject>

/* the archived ones, for the single surface that names them (Settings ›
   Projects › Archived projects) — each row answers on its own the two
   questions that page asks: may I see it, may I act on it. */
export const shapeArchivedProject = (
  s: ProjectVM,
  meta: ProjectVM | undefined,
  manage: boolean,
) => ({
  ...s,
  parentName: s.type === 'meta' ? null : meta ? meta.name : null,
  parentArchived: !!(meta && meta.id !== s.id && meta.archivedAt != null),
  withParent: !!(meta && meta.id !== s.id && meta.archivedAt === s.archivedAt),
  manage,
})
export type ArchivedProjectVM = ReturnType<typeof shapeArchivedProject>

export const shapeAttachment = (a: Row<'issue_attachments'>) => ({
  id: a.id,
  name: a.name,
  size: Number(a.size_bytes),
  mime: a.mime || null,
  // `path` carries the Convex storage id now (opaque either way to every
  // consumer — attachmentUrl is the only resolver)
  path: a.storage_id,
  by: a.uploaded_by,
  ts: a.created_at,
})
export type AttachmentVM = ReturnType<typeof shapeAttachment>

/* the per-rebuild derivations shapeIssue folds in: mirrored links, child
   keys, label attachments, the attachment views, my subscriptions */
type IssueShapeCtx = {
  uuidToKey: Map<string, string>
  uuidToDisplayKey: Map<string, string>
  hiddenSubtaskParents: Set<string>
  linkViews: Map<string, { type: string; id: string }[]>
  childKeys: Map<string, string[]>
  labelsByIssue: Map<string, string[]>
  attByIssue: Map<string, AttachmentVM[]>
  subscribedIssues: Set<string>
}
export const shapeIssue = (i: Row<'issues'>, ctx: IssueShapeCtx) => {
  const { uuidToKey, uuidToDisplayKey, hiddenSubtaskParents } = ctx
  const isGroup = !!ctx.childKeys.get(i.id)?.length || hiddenSubtaskParents.has(i.id)
  return {
    id: uuidToKey.get(i.id) as string, // the handle the app threads (key at home, uuid abroad)
    key: uuidToDisplayKey.get(i.id) as string, // what surfaces RENDER — always "QN-n"
    uuid: i.id,
    org: i.org_id, // which organization it belongs to (0081)
    title: i.title,
    description: i.description || '',
    project: i.project_id,
    status: i.status,
    priority: i.priority,
    // every ownership surface (lanes, portraits, My view, filters, load and
    // delay) reads `owner`: the reviewer while the task waits In Review, else
    // the assignee. `assignee` and `reviewer` are the literal fields, for
    // their own pickers (#314). `ownerField` names which one `owner` is.
    assignee: i.assignee_id,
    reviewer: i.reviewer_id,
    owner: taskOwnerId(i, isGroup),
    ownerField: reviewerOwns(i, isGroup) ? ('reviewer' as const) : ('assignee' as const),
    reporter: i.reporter_id,
    parent: i.parent_id ? uuidToKey.get(i.parent_id) || null : null,
    children: ctx.childKeys.get(i.id) || [],
    hasHiddenSubtasks: hiddenSubtaskParents.has(i.id),
    isGroup,
    links: ctx.linkViews.get(i.id) || [],
    start: i.start_week != null ? isoToWeek(i.start_week) : null,
    end:
      i.end_week != null
        ? Math.max(
            i.start_week != null ? isoToWeek(i.start_week) : isoToWeek(i.end_week),
            isoToWeek(i.end_week),
          )
        : null,
    due: i.due_date,
    remaining: i.remaining_hours != null ? Number(i.remaining_hours) : undefined,
    // week the remaining hours were measured (server-stamped, 0072) — the
    // spread/projection anchor everywhere remaining is divided over weeks
    remainingSet: i.remaining_set_at != null ? tsToWeek(i.remaining_set_at) : null,
    // when it was last handed to review (server-owned review_at, ms): entering
    // In Review or a new reviewer there; kept into Done, else cleared
    reviewAt: i.review_at ? new Date(i.review_at).getTime() : null,
    // when it reached Done (server-derived, 0071; null while not Done) and
    // when it was created, both ms
    doneAt: i.done_at ? new Date(i.done_at).getTime() : null,
    createdAt: new Date(i.created_at).getTime(),
    paused: i.paused,
    labels: ctx.labelsByIssue.get(i.id) || [],
    attachments: ctx.attByIssue.get(i.id) || [],
    // am I following this task? (0114) — read off the snapshot rather than
    // fetched per open, so the two task windows the inbox can have on ONE
    // task (the pane and its pop-out) can never disagree about the eye
    subscribed: ctx.subscribedIssues.has(i.id),
    updatedAt: new Date(i.updated_at).getTime(), // drives the stale check
  }
}
export type IssueVM = ReturnType<typeof shapeIssue>

export type IssueSubscribers = {
  canManage: boolean
  subscribers: string[]
  candidates: string[]
}

export const shapeMilestone = (m: Row<'milestones'>) => ({
  id: m.id,
  name: m.name,
  week: isoToWeek(m.week),
  project: m.project_id,
})
export type MilestoneVM = ReturnType<typeof shapeMilestone>

export const shapeActivity = (e: Row<'activity_events'>, uuidToKey: Map<string, string>) => ({
  id: e.id,
  ts: new Date(e.ts).getTime(),
  actor: e.actor_id,
  verb: e.verb,
  targetType: e.target_type,
  // issue targets are stored as uuids (0026; the convention predates
  // 0050's immutable keys and stays — uuids also survive deletion
  // gracefully); derive the current key here. Rows holding a non-uuid
  // target pass through unchanged.
  targetId: e.target_type === 'issue' ? uuidToKey.get(e.target_id) || e.target_id : e.target_id,
  label: e.label,
  detail: e.detail || undefined,
  projectId: e.project_id || undefined,
  team: e.team_id || undefined,
})
export type ActivityVM = ReturnType<typeof shapeActivity>

export const shapeComment = (c: Row<'comments'>) => ({
  id: c.id,
  issue: c.issue_id,
  author: c.author,
  body: c.body,
  ts: new Date(c.created_at).getTime(),
  editedTs: c.edited_at ? new Date(c.edited_at).getTime() : null,
  editedBy: c.edited_by || null,
})
export type CommentVM = ReturnType<typeof shapeComment>

/* inbox messages (0074) — own rows only. The issue title prefers the live
   row (renames follow) and falls back to the creation-time snapshot for a
   task that disappeared from the working set for another access reason. */
export const shapeMessage = (
  m: Row<'messages'>,
  ctx: {
    issues: Map<string, Row<'issues'>>
    uuidToKey: Map<string, string>
    uuidToDisplayKey: Map<string, string>
  },
) => {
  const { uuidToKey, uuidToDisplayKey } = ctx
  const iss = ctx.issues.get(m.issue_id)
  return {
    id: m.id,
    kind: m.kind,
    actor: m.actor_id,
    detail: m.detail,
    issueUuid: m.issue_id, // …which IS the inbox item this belongs to (0109)
    issueKey: uuidToKey.get(m.issue_id) || null, // handle; null = archived/unloaded
    issueLabel: uuidToDisplayKey.get(m.issue_id) || null, // the readable "QN-n"
    issueTitle: iss?.title || m.issue_title,
    ts: new Date(m.created_at).getTime(),
    createdAt: m.created_at, // the raw stamp — see isNewer on why ts won't do
    read: !!m.read_at,
    // the server's stamps, as instants; snoozed = the item is hidden until
    // the scheduled wake clears it (never a client clock comparison — the
    // return is one server event, so every device shows it at once)
    snoozedUntil: m.snoozed_until ? new Date(m.snoozed_until).getTime() : null,
    wokeAt: m.woke_at ? new Date(m.woke_at).getTime() : null,
  }
}
export type MessageVM = ReturnType<typeof shapeMessage>

/* inbox ITEMS (0109) — the unit the inbox actually lists: one per TASK (the
   (recipient, task) pair itself, so a task cannot occupy two rows even in
   principle). The item wears its NEWEST message; `count` is what is IN the
   item, `unreadCount` what has happened since you last looked; `kinds` is
   the union, so the kind filter still finds a mention behind a change. */
export const shapeMessageGroup = (issueUuid: string, newestFirst: MessageVM[]) => {
  const items = [...newestFirst].reverse() // oldest → newest, as they happened
  // asked of the whole item rather than taken off the end: the list sort is
  // by millisecond, and the server settles a sub-millisecond tie the other
  // way round (see isNewer)
  const latest = items.reduce((a, b) => (isNewer(a.createdAt, a.id, b.createdAt, b.id) ? b : a))
  const unread = items.reduce((n, m) => n + (m.read ? 0 : 1), 0)
  // the server stamps every row of the item alike; the newest row is the
  // authority, and an arrival (which carries no stamp) is what wakes it
  const snoozedUntil = latest.snoozedUntil
  const wokeAt = items.reduce((t, m) => Math.max(t, m.wokeAt ?? 0), 0) || null
  return {
    ...latest,
    id: issueUuid, // the item's identity IS its task
    ids: items.map((m) => m.id),
    items,
    count: items.length,
    unreadCount: unread,
    read: unread === 0,
    kinds: [...new Set(items.map((m) => m.kind))],
    snoozed: snoozedUntil !== null,
    snoozedUntil,
    wokeAt,
    // a returned item floats like news: its age and list position are the
    // wake's, until the next arrival's own instant outranks it
    ts: Math.max(latest.ts, wokeAt ?? 0),
  }
}
export type MessageGroupVM = ReturnType<typeof shapeMessageGroup>

/* one project's archived issues (fetchArchived) — outside the snapshot, so
   they carry the same handle/key split live ones get in rebuild(), and are
   shaped enough like snapshot issues for matchesSearch to work on them.
   The on-demand read includes label ids so Archive search keeps matching the
   same vocabulary as the board without putting archived assignments in the
   boot snapshot. */
export const shapeArchivedIssue = (
  r: FunctionReturnType<typeof api.issues.archivedFor>[number],
  id: string,
  key: string,
) => ({
  id,
  key,
  uuid: r.id,
  num: r.num,
  org: r.org_id,
  title: r.title,
  description: r.description || '',
  project: r.project_id,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_id,
  reviewer: r.reviewer_id,
  owner: taskOwnerId(r, r.is_group), // the same ownership rule as shapeIssue
  parent: null,
  children: [] as string[],
  isGroup: r.is_group,
  links: [] as { type: string; id: string }[],
  labels: r.label_ids,
  paused: r.paused,
  remaining: r.remaining_hours != null ? Number(r.remaining_hours) : undefined,
  due: r.due_date,
  archivedAt: new Date(r.archived_at).getTime(),
  doneAt: r.done_at ? new Date(r.done_at).getTime() : null,
  updatedAt: new Date(r.updated_at).getTime(),
})
export type ArchivedIssueVM = ReturnType<typeof shapeArchivedIssue>
