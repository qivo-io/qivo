/** Pure snapshot-to-view transformations. Store identity and caches arrive as arguments. */
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import type { ArchivedPageRow } from '../../convex/lib/archivedTasks'
import { messageLine } from '../../convex/lib/inbox'
import { LIMITS } from '../../convex/lib/limits'
import { reviewerOwns, taskOwnerId } from '../../convex/lib/review'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import type { NavByIdRow } from '../../convex/model/projectNavReads'
import type { PersonRow } from '../../convex/model/projectSettings'
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_WEEK_ONE_RULE,
  DEFAULT_WEEK_START,
  isoToWeek,
  tsToWeek,
} from '../lib/dates'
import { sampleAvatarUrl } from '../lib/demoAvatars'
import type { InboxPageRow } from '../lib/inboxPage'
import { nameInitials } from '../lib/initials'
import { DEFAULT_PLANNABLE_HOURS } from '../lib/workload'
import type { Row } from './rows'

type TeamAccessLevel = Row<'project_team_access'>['level']

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
  // Set while an uploaded picture's bytes are still loading, too.
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
  // the per-user project-creation right; it only counts for a standard
  // user, person or agent, while the org's setting is 'selected'
  canCreateProjects: u.can_create_projects === true,
  // days a READ inbox message is kept before the sweep takes it (0110);
  // null is "Never", and has to survive as null — 0 would be a period
  messageRetentionDays: u.message_retention_days == null ? null : Number(u.message_retention_days),
  // org (0081): the signed-in person holds a seat in each org they can
  // see, so each seat carries its own. `pending` = an invited seat nobody has claimed
  // — which an agent never is: it has no login to wait for, so the
  // bare auth_user_id test would brand every agent "invited" for ever
  org: u.org_id,
  pending: !demoMode && u.kind !== 'agent' && !u.auth_user_id,
})
export type UserVM = ReturnType<typeof shapeUser>

/** A person as every place that shows another person names and paints
    them (store/planner.ts P.person): `ok` with their name, initials, color
    and picture (null for none, or while it loads), or not named yet
    (`loading`), after a read that failed (`failed`), or, only from the
    server's answer that leaves them out, not a person of the organization
    (`gone`). `nameOnly` marks a person the store knows by name alone,
    from a picker's answer, painted with their initials on a neutral fill
    until their face arrives. `reading` is true while the read that brings
    a name-only person's face, with their picture and hours, has neither
    answered nor failed, and false for everyone else. `plannableHours` is
    the stored weekly hours, null for none (which plans the organization's
    default) and for an agent, or undefined while the store knows only the
    person's name. */
export type PersonView =
  | {
      state: 'ok'
      id: string
      org: string
      name: string
      initials: string
      color: string
      picture: string | null
      /** the uploaded picture's storage id, its version, or null for none */
      avatar: string | null
      /** whether the picture is the demo's sample portrait */
      sample: boolean
      kind: Row<'profiles'>['kind']
      orgRole: Row<'profiles'>['org_role']
      active: boolean
      pending: boolean
      nameOnly: boolean
      reading: boolean
      plannableHours: number | null | undefined
    }
  | { state: 'loading' | 'failed' | 'gone'; id: string }

/** A person as a Settings page showed them (Settings › Users' row, or a
    team page's member row), for P.updateUser, which decides its refusals
    from it, leaves a field unsent that equals what the page showed, sends
    the rest to `orgId` with these values as their `expected`, and paints
    only where the workspace holds the person. The page shows the store's
    profile while the store holds it, so this session's own saves show at
    once, else the server's answer. `email` and `canCreateProjects` are
    the Users page's alone; a write of either needs them. */
export type PersonShown = {
  orgId: string
  name: string
  isAgent: boolean
  pending: boolean
  orgRole: Row<'profiles'>['org_role']
  active: boolean
  /** null for none, which plans the organization's default, and for an
      agent */
  plannableHours: number | null
  email?: string | null
  canCreateProjects?: boolean
}

/** The workspace's person `u` as a page that shows the store's profile
    shows them (PersonShown). */
export const personShownOf = (u: UserVM): PersonShown => ({
  orgId: u.org,
  name: u.name,
  isAgent: u.isAgent,
  pending: u.pending,
  orgRole: u.orgRole,
  active: u.active,
  plannableHours: u.plannableHours,
  email: u.email ?? null,
  canCreateProjects: u.canCreateProjects,
})

/** A person the view names is `ok`. */
export type PersonOk = Extract<PersonView, { state: 'ok' }>

/** The workspace's person `u` as a person view. */
export const personOfUser = (u: UserVM): PersonOk => ({
  state: 'ok',
  id: u.id,
  org: u.org,
  name: u.name,
  initials: u.initials,
  color: u.color,
  picture: u.avatarPath ? u.avatarUrl : null,
  avatar: u.sampleAvatar ? null : (u.avatarPath ?? null),
  sample: u.sampleAvatar,
  kind: u.kind,
  orgRole: u.orgRole,
  active: u.active,
  pending: u.pending,
  nameOnly: false,
  reading: false,
  plannableHours: u.plannableHours,
})

/** A people.byIds row of organization `org` as a person view, its picture
    `pictureUrl` (the picture source's URL, null while it loads) for an
    upload, or the demo's sample portrait. */
export const personOfFace = (
  org: string,
  face: PersonFaceRow,
  pictureUrl: string | null,
): PersonOk => ({
  state: 'ok',
  id: face.id,
  org,
  name: face.name,
  initials: face.initials,
  color: face.color,
  picture: face.avatar ? pictureUrl : sampleAvatarUrl(face.sample_avatar ?? undefined),
  avatar: face.avatar,
  sample: !face.avatar && !!face.sample_avatar,
  kind: face.kind,
  orgRole: face.org_role,
  active: face.active,
  pending: face.pending,
  nameOnly: false,
  reading: false,
  plannableHours: face.kind === 'agent' ? null : face.plannable_hours,
})

/** A picker's person row of organization `org` as a person view, known by
    name only: the name's initials on a neutral fill, no picture and unknown
    hours, until their face arrives. `reading` is whether the read that
    brings the face is still on its way. */
export const personOfName = (org: string, row: PersonRow, reading: boolean): PersonOk => ({
  state: 'ok',
  id: row.id,
  org,
  name: row.name,
  initials: nameInitials(row.name),
  color: '',
  picture: null,
  avatar: null,
  sample: false,
  kind: row.kind,
  orgRole: row.org_role,
  active: row.active,
  pending: row.pending,
  nameOnly: true,
  reading,
  plannableHours: undefined,
})

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
  maxAttachmentMb: home?.max_attachment_mb ?? LIMITS.attachmentSize.max,
  // who may create top-level projects besides org admins; missing is 'users'
  projectCreators: home?.project_creators ?? 'users',
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
/** Projects by their sort order, then creation time and id. */
export const byOrder = (a: Row<'projects'>, b: Row<'projects'>) =>
  a.sort_order - b.sort_order ||
  (a.created_at < b.created_at
    ? -1
    : a.created_at > b.created_at
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0)
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

/** What the store knows of a project a view names, from the workspace's
    projects part where it holds the project, else from the project cache
    (store/projectCache.ts): what both give, so a reader of anything else
    (the key, the lead, the grants, the sub-projects, the review time) reads
    the part's whole project through P.heldProject. */
export type ProjectFacts = Pick<
  ProjectVM,
  'id' | 'org' | 'name' | 'num' | 'parent' | 'type' | 'trackDelay'
>

/** A projectNav.byIds row as the facts the store answers for it. */
export const shapeCachedProject = (row: NavByIdRow): ProjectFacts => ({
  id: row.id,
  org: row.org_id,
  name: row.name,
  num: row.num,
  parent: row.parent_id ?? undefined,
  type: row.parent_id === null ? 'meta' : 'project',
  trackDelay: row.track_delay,
})

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

/* Projects shown together under one name get their number as a tag
   ("Test #1", "Test #4"), the number their address already uses. Names
   compare with runs of whitespace collapsed (as HTML renders them) and
   case-insensitively, independent of the browser's locale, among projects of one organization with the same parent. Each list
   is compared on its own: active and archived projects never share a list. */
export type TaggableProject = Pick<ProjectVM, 'id' | 'org' | 'parent' | 'name' | 'num'>
export function duplicateNameTags(...lists: readonly TaggableProject[][]): Map<string, string> {
  const tags = new Map<string, string>()
  for (const list of lists) {
    const groups = new Map<string, TaggableProject[]>()
    for (const p of list) {
      const key = `${p.org}\u0000${p.parent ?? ''}\u0000${p.name.trim().replace(/\s+/g, ' ').toLowerCase()}`
      const group = groups.get(key)
      if (group) group.push(p)
      else groups.set(key, [p])
    }
    for (const group of groups.values()) {
      if (group.length > 1) for (const p of group) tags.set(p.id, `#${p.num}`)
    }
  }
  return tags
}

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

/** A lookup by key, such as a Map. */
type Lookup<T> = { get(key: string): T | undefined }
/** A membership test, such as a Set. */
type Members = { has(key: string): boolean }

/* the derivations shapeIssue folds in (store/taskIndex.ts): mirrored links,
   child keys, label attachments, the attachment views, my subscriptions */
type IssueShapeCtx = {
  uuidToKey: Lookup<string>
  uuidToDisplayKey: Lookup<string>
  hiddenSubtaskParents: Members
  hiddenParentTasks: Members
  linkViews: Lookup<{ type: string; id: string }[]>
  childKeys: Lookup<string[]>
  labelsByIssue: Lookup<string[]>
  attByIssue: Lookup<AttachmentVM[]>
  /** every attachment row of a task, description images included, by uuid */
  attachmentCounts: Lookup<number>
  subscribedIssues: Members
}
export const shapeIssue = (i: Row<'issues'>, ctx: IssueShapeCtx) => {
  const { uuidToKey, uuidToDisplayKey, hiddenSubtaskParents } = ctx
  const children = ctx.childKeys.get(i.id) || []
  const isGroup = !!children.length || hiddenSubtaskParents.has(i.id)
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
    children,
    hasHiddenSubtasks: hiddenSubtaskParents.has(i.id),
    // the parent is outside this view; `parent` is null, as for no parent
    hasHiddenParent: ctx.hiddenParentTasks.has(i.id),
    isGroup,
    links: ctx.linkViews.get(i.id) || [],
    // the stored plan, in week indexes. rebuild() replaces a group's pair
    // with the calculated span of its subtasks (groupSpan); its own stored
    // dates stay dormant in the row until its last subtask leaves
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
    // spread/projection anchor everywhere remaining is divided over weeks;
    // a move to another sub-project keeps it (model/issues.ts movedStamps)
    remainingSet: i.remaining_set_at != null ? tsToWeek(i.remaining_set_at) : null,
    // when it was last handed to review (server-owned review_at, ms): entering
    // In Review or a new reviewer there; kept into Done, else cleared, and
    // restarted by a move to another sub-project (model/issues.ts movedStamps)
    reviewAt: i.review_at ? new Date(i.review_at).getTime() : null,
    // when the status was last set in the task's current project (server-owned
    // status_at, ms). Creation sets it; null for a task created before Qivo
    // recorded it and not changed since, and after a move to another
    // sub-project
    statusAt: i.status_at ? new Date(i.status_at).getTime() : null,
    // when it reached Done (server-derived, 0071; null while not Done), or
    // was moved to another sub-project while Done, and when it was created,
    // both ms
    doneAt: i.done_at ? new Date(i.done_at).getTime() : null,
    createdAt: new Date(i.created_at).getTime(),
    paused: i.paused,
    labels: ctx.labelsByIssue.get(i.id) || [],
    attachments: ctx.attByIssue.get(i.id) || [],
    // what the per-task cap counts (src/lib/taskCaps.ts attachmentBlock)
    attachmentCount: ctx.attachmentCounts.get(i.id) ?? 0,
    // am I following this task? (0114) — read off the snapshot rather than
    // fetched per open, so the two task windows the inbox can have on ONE
    // task (the pane and its pop-out) can never disagree about the eye
    subscribed: ctx.subscribedIssues.has(i.id),
    updatedAt: new Date(i.updated_at).getTime(), // drives the stale check
  }
}
export type IssueVM = ReturnType<typeof shapeIssue>

/** A task's followers as the follower popover reads them
    (convex/issues.ts subscribers): whether the caller may add and remove
    other people's follows, the followers as rows in name order, and
    whether the task has more than the answer holds. */
export type IssueSubscribers = FunctionReturnType<typeof api.issues.subscribers>

export const shapeMilestone = (m: Row<'milestones'>) => ({
  id: m.id,
  name: m.name,
  week: isoToWeek(m.week),
  project: m.project_id,
})
export type MilestoneVM = ReturnType<typeof shapeMilestone>

export const shapeActivity = (e: Row<'activity_events'>, uuidToKey: Lookup<string>) => ({
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

/** The key of the Inbox row, and of its mark, of task `task` in
    organization `org`. Two organizations can hold one task id
    (convex/model/inboxPage.ts), so a row is never named by its task alone. */
export const inboxMarkKey = (org: string, task: string) => `${org}:${task}`

/** What the person's own write says of one Inbox row until the list shows
    the server's answer to it (store/planner.ts P.inboxMarks): read or
    unread (`read`), removed, or snoozed until a time or woken
    (`snoozedUntil`, null), for the row whose cutoff was `through` at the
    press. `settled` says the server accepted the write. */
export type InboxMark = {
  through: number
  read?: boolean
  removed?: true
  snoozedUntil?: string | null
  settled: boolean
}

/* One row of the Inbox list, as panels/Inbox.tsx shows it: its key (the
   organization and task, inboxMarkKey), the task's uuid, number and live
   title, its project and the project above it, its second line
   (convex/lib/inbox.ts messageLine, which the server and the stand-in
   write the same), the newest message's kind and the item's kinds, its
   list time in ms, its counts, whether it is read, its snooze's end in ms
   or null, and the cutoff the item actions take (`through`). */
export const shapeInboxRow = (row: InboxPageRow) => ({
  key: inboxMarkKey(row.org_id, row.issue_id),
  org: row.org_id,
  uuid: row.issue_id,
  num: row.num,
  title: row.title,
  project: { id: row.project.id, name: row.project.name },
  parent: row.parent === null ? null : { id: row.parent.id, name: row.parent.name },
  line: messageLine(row.latest, row.latest.actor_name),
  kind: row.latest.kind,
  kinds: row.kinds,
  ts: Date.parse(row.sort_at),
  unreadCount: row.unread_count,
  count: row.count,
  dropped: row.dropped,
  read: row.unread_count === 0,
  snoozedUntil: row.snoozed_until === null ? null : Date.parse(row.snoozed_until),
  through: row.through,
})
export type InboxRowVM = ReturnType<typeof shapeInboxRow>

/**
 * Inbox row `row` as `mark` says while the person's write waits for the
 * page to answer it, or null for a row it hides. A mark counts only while
 * the row's cutoff is the mark's, so news that arrived after the press
 * shows as the server keeps it. A read mark turns the row read, and hides
 * it under Unread only (`unreadOnly`); an unread mark, a snooze and its
 * end turn it unread, as the server leaves every message of the item
 * unread; a snooze hides it without Show snoozed (`showSnoozed`); a
 * removed mark hides it.
 */
export function markedRow(
  row: InboxRowVM,
  mark: InboxMark | undefined,
  shown: { unreadOnly: boolean; showSnoozed: boolean },
): InboxRowVM | null {
  if (mark === undefined || mark.through !== row.through) return row
  if (mark.removed) return null
  let next = row
  if (mark.read === true) next = { ...next, read: true, unreadCount: 0 }
  if (mark.read === false || mark.snoozedUntil !== undefined)
    next = { ...next, read: false, unreadCount: Math.max(next.count, 1) }
  if (mark.snoozedUntil !== undefined)
    next = {
      ...next,
      snoozedUntil: mark.snoozedUntil === null ? null : Date.parse(mark.snoozedUntil),
    }
  if (shown.unreadOnly && next.read) return null
  if (!shown.showSnoozed && next.snoozedUntil !== null) return null
  return next
}

/* one archived task outside the snapshot, as the Archived tasks page lists
   it (shapeArchivedListRow), so it carries the same handle/key split live
   ones get in rebuild(). The server searches the archive, so a row carries
   no description, labels or links, and it names no parent. It takes the
   page's row (ArchivedPageRow). */
export const shapeArchivedIssue = (r: ArchivedPageRow, id: string, key: string) => ({
  id,
  key,
  uuid: r.id,
  num: r.num,
  org: r.org_id,
  title: r.title,
  project: r.project_id,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_id,
  reviewer: r.reviewer_id,
  owner: taskOwnerId(r, r.is_group), // the same ownership rule as shapeIssue
  isGroup: r.is_group,
  paused: r.paused,
  remaining: r.remaining_hours != null ? Number(r.remaining_hours) : undefined,
  due: r.due_date,
  archivedAt: new Date(r.archived_at).getTime(),
  doneAt: r.done_at ? new Date(r.done_at).getTime() : null,
  updatedAt: new Date(r.updated_at).getTime(),
})
export type ArchivedIssueVM = ReturnType<typeof shapeArchivedIssue>

/* one row of the Archived tasks page (P.fetchArchivedPage): the archived
   task with where it lives, its owner's name and whether this person may
   restore it, as the server answers them, so the page reads none of the
   planner's projects, people or levels. `place` is "Luma Sensor ›
   Firmware" for a sub-project and the name alone otherwise. */
export const shapeArchivedListRow = (
  r: FunctionReturnType<typeof api.issues.archivedPage>['rows'][number],
  id: string,
  key: string,
) => ({
  ...shapeArchivedIssue(r, id, key),
  place:
    r.place.parent_name === null
      ? r.place.project_name
      : `${r.place.parent_name} › ${r.place.project_name}`,
  ownerName: r.owner_name,
  canRestore: r.can_restore,
})
export type ArchivedListRowVM = ReturnType<typeof shapeArchivedListRow>
