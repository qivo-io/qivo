/* Prototype-compatible planner facade over Convex. Task handles remain unique
   across organizations; display keys are org-scoped QN numbers. Relationships,
   project access and week-indexed schedules are derived from the raw rows.

   Snapshots always update serverSnap. During optimistic writes, run() holds
   their paint until the last write settles; refusal restores server truth.
   Comments and Team sync have separate subscriptions and update channels.
   Preferences load once and save through their own debounced lifecycle.
   Uploads remain awaited; signed file URLs are minted with one-shot queries. */

import { type FunctionArgs, type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { AVATAR_COLORS } from '../../convex/lib/avatarColors'
import {
  canCreateProjects,
  isProjectCreators,
  projectRightAfterUpdate,
} from '../../convex/lib/projectCreators'
import { creatorGrant, grantsAfterHandover } from '../../convex/lib/projectGrants'
import { resolveReviewHours, reviewStamp } from '../../convex/lib/review'
import { firstSittingDay, nextSyncStamp } from '../../convex/lib/teamSync'
import { NAME_MAX, TEXT_MAX, TEXT_MAX_LABEL } from '../../convex/lib/textLimits'
import { armConvexAuth, authClient, signOut as authSignOut } from '../lib/auth'
import { avatarCacheScope, createAvatarImageCache } from '../lib/avatarImageCache'
import { createAvatarSources } from '../lib/avatarSources'
import { browserBackendUrl, configuredConvexDeploymentUrl } from '../lib/backendUrl'
import { convex } from '../lib/convex'
import {
  clampBarDrag,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  DEFAULT_WEEK_START,
  DEFAULT_WIN,
  endpointWeek,
  fmtDate,
  fmtFull,
  fmtFullWith,
  fmtISO,
  fmtRange,
  isoFromDate,
  isoToDate,
  isoToWeek,
  MONTHS,
  nearestWeek,
  resolveWin,
  sameWin,
  sanitizeWin,
  setDateFormat,
  setWeekConfig,
  shiftWin,
  TIMELINE_START,
  TODAY_ISO,
  TODAY_POS,
  TODAY_WEEK,
  tsToWeek,
  WEEK_ONE_RULES,
  WEEKDAYS,
  weekLabel,
  weekNumberOf,
  weekNumLabel,
  weekStartOf,
  weekToDate,
  weekToISO,
  winLabel,
} from '../lib/dates'
import {
  computeDelayMap,
  DELAY_COLORS,
  DELAY_LABELS,
  DELAY_NEUTRAL,
  type DelayInfo,
} from '../lib/delay'
import type { PurgeRefusal, RestoreRefusal } from '../lib/deletedItems'
import { DEMO_MODE, notifyDemoEnded } from '../lib/demoMode'
import { prime as primeGravatar } from '../lib/gravatar'
import { AVATAR_TYPES, avatarImage, compressImage } from '../lib/images'
import { nameInitials } from '../lib/initials'
import { groupProgress, groupSpan, isIssueDone, isIssueGroup } from '../lib/issueGroups'
import { LABEL_COLORS } from '../lib/labelColors'
import { watchLocalDay } from '../lib/localDay'
import { desktopNotify } from '../lib/notify'
import { matchesAllWords, taskSearchText } from '../lib/search'
import type { ToastTone } from '../lib/toasts'
import { beginUpdateBlock } from '../lib/updateSafety'
import {
  committedByWeek,
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
} from '../lib/workload'
import { createEntityLookup } from './entityLookup'
import { createPreferences } from './preferences'

export type { UIPrefs } from './preferences'

import type { Row } from './rows'
import { createPlannerUpdates } from './updates'
import {
  type ActivityVM,
  type ArchivedIssueVM,
  type ArchivedProjectVM,
  type AttachmentVM,
  byOrder,
  type CommentVM,
  duplicateNameTags,
  type IssueSubscribers,
  type IssueVM,
  isNewer,
  type LabelVM,
  type MessageGroupVM,
  type MessageVM,
  type MilestoneVM,
  type OrgRefVM,
  type OrgVM,
  type ProjectVM,
  shapeActivity,
  shapeArchivedIssue,
  shapeArchivedProject,
  shapeAttachment,
  shapeComment,
  shapeIssue,
  shapeLabel,
  shapeMessage,
  shapeMessageGroup,
  shapeMilestone,
  shapeOrg,
  shapeOrgRef,
  shapeProject,
  shapeTeam,
  shapeUser,
  syncStampOf,
  type TeamVM,
  type UserVM,
} from './viewModels'

export type {
  ActivityVM,
  ArchivedIssueVM,
  ArchivedProjectVM,
  AttachmentVM,
  CommentVM,
  IssueSubscribers,
  IssueVM,
  LabelVM,
  MessageGroupVM,
  MessageVM,
  MilestoneVM,
  OrgRefVM,
  OrgVM,
  ProjectVM,
  TeamVM,
  UserVM,
} from './viewModels'

/* Personal theme and Canvas background, exactly as appearance:get returns them. */
export type AppearancePreferences = FunctionReturnType<typeof api.appearance.get>
/** What archiving or deleting a project takes along, as P.projectRemovalSummary answers. */
export type ProjectRemovalSummary = FunctionReturnType<typeof api.projects.removalSummary>
/** What one restore or Delete now did over every call it took (P.restoreDeletedItems,
    P.purgeDeletedItems): the ids the server restored or deleted for good, the
    ids it refused with their reason, the ids it deferred until a project item
    of the same call is back, and the ids of calls it refused whole, with the
    sentence to show for them. */
export type DeletedItemsOutcome<Reason> = {
  done: string[]
  refused: { id: string; reason: Reason }[]
  deferred: string[]
  failed: string[]
  error: string | null
}

/* The wire shape of the one snapshot — derived from the server function so
   the cache can never drift from what forMe actually emits. Optional columns
   arrive ABSENT (undefined), never null; every == null / truthiness test
   below covers both, and no row field is compared with === null. */
type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>

/* --- raw row cache --------------------------------------------------------
   Multi-org since 0081: a login holds ONE home profile plus a `guest` profile
   in every foreign organization that invited it to a project. The snapshot
   hands back the rows of every org the login has an active seat in, so the
   caches below are BLENDED — `orgOf(...)` answers which organization a row
   belongs to, and the handful of places that need "my identity" ask for it
   per org (profileIn). There is no active-org state and no switcher: the
   home org drives display settings, and foreign projects simply appear
   alongside the home ones. */
const rows = {
  orgs: new Map<string, Row<'organizations'>>(),
  // billing rides the org row, admin-redacted server-side; this slot is the
  // home org's object (the organization_billing table's successor)
  billing: null as Row<'organizations'>['billing'] | null,
  teams: new Map<string, Row<'teams'>>(),
  profiles: new Map<string, Row<'profiles'>>(),
  teamMembers: [] as Row<'team_members'>[],
  projects: new Map<string, Row<'projects'>>(),
  access: [] as Row<'project_access'>[],
  teamAccess: [] as Row<'project_team_access'>[],
  issues: new Map<string, Row<'issues'>>(),
  hiddenSubtaskParents: new Set<string>(),
  // tasks whose parent is outside the working set; the snapshot omits that
  // parent's id
  hiddenParentTasks: new Set<string>(),
  links: new Map<string, Row<'issue_links'>>(),
  milestones: new Map<string, Row<'milestones'>>(),
  activity: new Map<string, Row<'activity_events'>>(),
  labels: new Map<string, Row<'labels'>>(),
  issueLabels: [] as Row<'issue_labels'>[],
  // who follows which task (0114). The snapshot carries own rows only, exactly
  // like user_prefs: a subscription is MY notification preference, not a
  // published fact about the task, so this cache never holds anybody else's
  // row and `subscribed` below is the only thing derived from it.
  issueSubs: [] as Row<'issue_subscriptions'>[],
  attachments: new Map<string, Row<'issue_attachments'>>(),
  // comments for ONE issue — the open modal's (watchComments); other issues'
  // comments are never fetched, so this is not org-wide state like activity
  comments: new Map<string, Row<'comments'>>(),
  // inbox messages (0074) — the snapshot returns only the signed-in user's
  // rows; generation is server-side (notify triggers), clients only mark
  // read/unread, snooze and delete
  messages: new Map<string, Row<'messages'>>(),
  // Reactive organization-wide load by effective owner; hidden projects
  // contribute hours without exposing their identity.
  orgLoad: [] as Snapshot['orgLoad'],
}

// Read notifications outside the snapshot's 500-row display window still
// participate in Inbox cleanup. Loaded rows contribute their optimistic state.
let hiddenReadMessages = 0
// Whether the server's bounded inbox read left unread (read) rows that Mark
// all as read (Remove all read) reaches undelivered (snapshot unreadTruncated,
// readTruncated). Such rows may exist without any loaded row or count showing
// them. Rows left that are all snoozed do not count, because neither action
// touches a snoozed row.
let unexaminedUnread = false
let unexaminedRead = false

/* issue uuid → projected-delay info, rebuilt with every snapshot */
let delayMap = new Map<string, DelayInfo>()

/* plan_org_load grouped by owner (rebuilt with the delay map, which reads
   the same spans), and each owner's hours in the weeks P.weekLoadOf was asked
   about, added up one week at a time on first ask and emptied by every
   rebuild. */
let orgLoadByOwner = new Map<string, LoadSpan[]>()
const committedByOwner = new Map<string, Map<number, number>>()

/* The home organization whose latest-comment facts the Team sync page
   watches (P.watchTeamSync), or null, and the people it asks about (joined
   in the order asked), or '' for none. */
let watchedSyncOrg: string | null = null
let watchedSyncOwners = ''
let syncUnsub: (() => void) | null = null
let syncWatchEpoch = 0

/* The issue whose comments are subscribed (uuid), or null. Set by the issue
   modal via watchComments, which owns the second Convex subscription. */
let watchedComments: string | null = null
let commentsUnsub: (() => void) | null = null
let commentsWatchEpoch = 0
/* The last thread the comments subscription delivered — the rollback anchor
   for optimistic comment rows (rows.comments is outside serverSnap). null =
   nothing delivered yet for the watched issue. */
let commentsSnap: Row<'comments'>[] | null = null

/* Re-adopt the watched thread from its last delivery. Safe to call blind:
   with nothing delivered (or nothing watched) it leaves the cache alone. */
function adoptComments() {
  if (commentsSnap === null) return
  rows.comments = new Map(structuredClone(commentsSnap).map((r) => [r.id, r]))
  PLANNER.commentsLoaded = true
}

/* Desktop notifications (0074): fired once per inbox row id. An id set, not
   a timestamp watermark — created_at is the writer TRANSACTION's start (0109
   tried clock_timestamp() and 0111 put it back, because a comment's message
   has to share its comment's instant), so a slow write can commit a message
   stamped before an already-announced quick one, and a watermark would
   silently swallow it. Empty until the FIRST snapshot lands — sign-in must
   show the unread badge, not replay every stored message as an OS
   notification. adopt() calls this on every delivery, so the null-prime runs
   on the first one. */
let announcedMessages: Map<string, string | undefined> | null = null // id → woke_at announced
// the server time of the previous snapshot; older messages on a task that
// newly enters the working set are history, not news
let lastDeliveryAt: string | null = null
/* A restore reintroduces the task's historical inbox rows. The server marks
   an archived task's messages read in the background, so they usually come
   back read, but a restore that beats that step brings them back unread.
   Either way, keep them from looking like new arrivals when the next
   snapshot admits the restored task (and any ancestors restored with it). */
const pendingRestoreIssueIds = new Set<string>()
/* An archive the server accepted can be mirrored here before the delivery
   that drops it, and another write can refuse in between. Keep its root here,
   with whether its subtasks were kept, so that rollback from the stale server
   snapshot cannot briefly resurrect the archived working set. */
const pendingArchiveIssueIds = new Map<string, { keepSubtasks: boolean }>()
/* Accepted deletes, kept for the same reason as archives: the tasks a task
   delete removed, by root, and the projects a project delete removed. */
const pendingTaskDeletes = new Map<string, Set<string>>()
const pendingProjectDeletes = new Set<string>()

function issueSubtree(rootId: string): Set<string> {
  const subtree = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    rows.issues.forEach((issue) => {
      if (issue.parent_id && subtree.has(issue.parent_id) && !subtree.has(issue.id)) {
        subtree.add(issue.id)
        grew = true
      }
    })
  }
  return subtree
}

function purgeIssueRows(subtree: Set<string>) {
  ;[...rows.attachments.values()].forEach((attachment) => {
    if (subtree.has(attachment.issue_id)) {
      rows.attachments.delete(attachment.id)
      minted.delete(`att:${attachment.id}`)
    }
  })
  ;[...rows.links.values()].forEach((link) => {
    if (subtree.has(link.source_id) || subtree.has(link.target_id)) rows.links.delete(link.id)
  })
  rows.issueLabels = rows.issueLabels.filter((label) => !subtree.has(label.issue_id))
  rows.issueSubs = rows.issueSubs.filter((subscription) => !subtree.has(subscription.issue_id))
  ;[...rows.messages.values()].forEach((message) => {
    if (subtree.has(message.issue_id)) rows.messages.delete(message.id)
  })
  ;[...rows.activity.values()].forEach((event) => {
    if (event.target_type === 'issue' && subtree.has(event.target_id))
      rows.activity.delete(event.id)
  })
  rows.orgLoad = rows.orgLoad.filter(
    (load) => load.issue_id === null || !subtree.has(load.issue_id),
  )
  if (watchedComments !== null && subtree.has(watchedComments)) PLANNER.watchComments(null)
  subtree.forEach((id) => {
    rows.issues.delete(id)
  })
}

/* The local mirror of an accepted archive. With `keepSubtasks` the server
   detached every active direct child first (it keeps its own subtasks) and
   archived the task alone, so only the task leaves the board; otherwise the
   whole visible subtree goes with it. */
function mirrorArchive(rootId: string, keepSubtasks: boolean) {
  if (!keepSubtasks) {
    purgeIssueRows(issueSubtree(rootId))
    return
  }
  const now = new Date().toISOString()
  rows.issues.forEach((issue) => {
    // the detach fires the touch server-side, as a delete's does
    if (issue.parent_id === rootId) {
      issue.parent_id = undefined
      issue.updated_at = now
    }
  })
  purgeIssueRows(new Set([rootId]))
}

/* The local mirror of an accepted project delete. The server hides the
   project and its sub-projects in one transaction and moves their tasks to
   Deleted items in steps, so the next delivery already lacks all of them. */
function mirrorProjectDelete(id: string) {
  if (!dropProjectRows(id)) return
  rebuild()
  emit()
}

/* The rows part of mirrorProjectDelete. Answers whether the project was
   still here. */
function dropProjectRows(id: string): boolean {
  const row = rows.projects.get(id)
  if (!row) return false
  const ids =
    row.type === 'meta'
      ? [id, ...[...rows.projects.values()].filter((x) => x.parent_id === id).map((x) => x.id)]
      : [id]
  ;[...rows.issues.values()].forEach((i) => {
    if (ids.includes(i.project_id)) rows.issues.delete(i.id)
  })
  ;[...rows.milestones.values()].forEach((m) => {
    if (ids.includes(m.project_id)) rows.milestones.delete(m.id)
  })
  ;[...rows.links.values()].forEach((l) => {
    if (!rows.issues.has(l.source_id) || !rows.issues.has(l.target_id)) rows.links.delete(l.id)
  })
  rows.issueLabels = rows.issueLabels.filter((il) => rows.issues.has(il.issue_id))
  rows.issueSubs = rows.issueSubs.filter((s) => rows.issues.has(s.issue_id))
  rows.access = rows.access.filter((a) => !ids.includes(a.project_id))
  rows.teamAccess = rows.teamAccess.filter((a) => !ids.includes(a.project_id))
  ids.forEach((pid) => {
    rows.projects.delete(pid)
  })
  return true
}

/* The rows part of a task delete: the tasks in `gone` leave, and their
   subtasks outside it become top-level tasks, as the server detaches them. */
function dropDeletedTasks(gone: Set<string>) {
  rows.issues.forEach((r) => {
    // the SET NULL cascade fires the touch server-side — mirror both
    if (r.parent_id && gone.has(r.parent_id) && !gone.has(r.id)) {
      r.parent_id = undefined
      r.updated_at = new Date().toISOString()
    }
  })
  // the rows, and everything hung on them: links, labels, attachments,
  // inbox messages, load and the watched comment thread
  purgeIssueRows(gone)
}

/* Applies every accepted archive and delete again after a rollback to a
   server snapshot that predates them. */
function reapplyAcceptedRemovals() {
  pendingArchiveIssueIds.forEach(({ keepSubtasks }, rootId) => {
    mirrorArchive(rootId, keepSubtasks)
  })
  pendingTaskDeletes.forEach((gone) => {
    dropDeletedTasks(gone)
  })
  pendingProjectDeletes.forEach((id) => {
    dropProjectRows(id)
  })
}

function announceNewMessages() {
  if (announcedMessages === null) {
    announcedMessages = new Map([...rows.messages.values()].map((m) => [m.id, m.woke_at]))
    return
  }
  const fresh: Row<'messages'>[] = []
  // a snooze that ended since the last delivery: the server stamps every
  // row of the item with one woke_at, so the item announces once, not per row
  const returned = new Map<string, Row<'messages'>>()
  rows.messages.forEach((m) => {
    const known = announcedMessages!.has(m.id)
    const wokeBefore = announcedMessages!.get(m.id)
    announcedMessages!.set(m.id, m.woke_at)
    if (!known) {
      if (!m.read_at) fresh.push(m) // read elsewhere already — no pop-up
      return
    }
    if (m.woke_at === undefined || m.woke_at === wokeBefore || m.read_at) return
    const cur = returned.get(m.issue_id)
    if (!cur || isNewer(cur.created_at, cur.id, m.created_at, m.id)) returned.set(m.issue_id, m)
  })
  /* Navigate the way Back does. This used to assign location.hash, which
     fires `hashchange` — and nothing in the app has ever listened for
     one (App listens for `popstate`), so clicking a desktop notification
     moved the address bar and left the app where it was. Pushing the
     entry and dispatching the event the router already handles makes the
     click actually open the inbox. */
  const openInbox = () => {
    // the literal rather than router.ts's APP_PREFIX/ORG_NONE: router.ts
    // imports THIS module, so importing it back would close a cycle for
    // the sake of two constants. The inbox is about no one organization,
    // hence the `~` segment.
    history.pushState(null, '', '/app/~/inbox')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const titleOf = (m: Row<'messages'>) => {
    const iss = rows.issues.get(m.issue_id)
    return (iss ? iss.title : m.issue_title) || m.issue_title
  }
  fresh
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .forEach((m) => {
      const actor = m.actor_id && rows.profiles.get(m.actor_id)
      // null actor = an agent-less API write OR a since-deleted user (the FK
      // set-null cascade) — same neutral fallback the feed and comments use
      const who = actor ? actor.name : 'Someone'
      const title = titleOf(m)
      desktopNotify(
        m.id,
        m.kind === 'mention' ? `${who} mentioned you, ${title}` : `${who}, ${title}`,
        m.detail,
        openInbox,
      )
    })
  returned.forEach((m) => {
    desktopNotify(
      `${m.issue_id}:${m.woke_at}`,
      `Back from snooze, ${titleOf(m)}`,
      m.detail,
      openInbox,
    )
  })
}

/* Issue keys are "QN-<num>": a fixed product prefix + the org-scoped number
   (0050). The prefix is deliberately NOT per-org data — an org-chosen key
   would be renameable, re-creating the dead-link problem org numbering
   exists to kill. URLs carry the lowercase form ("qn-482"); parsing is
   case-insensitive everywhere. */
export const ISSUE_PREFIX = 'QN'

/* The sidebar's "All projects" entry is a SCOPE, not a page (deviation #47): the same
   Overview / Board / Roadmap render, scoped to every project this login can
   reach instead of one. It rides in the app's `scope` state as this sentinel,
   so it persists (user_prefs), routes (#/<view>/all) and switches views like
   any project scope. It is deliberately NOT a projects row: `P.project('all')`
   stays undefined, and every consumer goes through `P.scopeInfo`. */
export const ALL_SCOPE = 'all'

/* …and "My view" (deviation #49) is the second such sentinel: the same three
   views over the same set of projects, narrowed to the tasks owned by me (the
   assignee, or the reviewer while the task waits In Review; #314) —
   on ANY seat I hold (0081), not just the home profile. Everything that is
   true of 'all' because it names no project (no lead, no settings page, no
   archive, nowhere to create) is true of this one too, which is what
   `P.isWideScope` asks; `P.isAllScope` / `P.isMineScope` stay for the few
   rules that mean one specific sentinel. */
export const MINE_SCOPE = 'mine'

/* An issue's HANDLE is the string the whole client threads around — component
   props, `openIssue` state, activity/message targets, parent/children/link
   references, the URL's `i/<ref>` segment. It is the display key ("QN-482")
   for the HOME organization and the raw uuid for any foreign one, because
   issue numbers are per-org (0050) and a blended snapshot (0081) can hold
   two "QN-5" at once — a handle that collides opens the wrong task. The
   display key lives on `issue.key` and is what people READ; `issue.id` is
   the handle and is never rendered.
   Home-org behaviour is therefore byte-identical to before 0081 — every
   existing surface, drive and shared link keeps working — and only guest
   content (which no link predating 0081 can name) uses uuid handles. */
let keyToUuid = new Map<string, string>() // handle -> issue uuid
let uuidToKey = new Map<string, string>() // uuid -> handle
let uuidToDisplayKey = new Map<string, string>() // uuid -> "QN-482" (what's rendered)
// org id -> ("QN-482" -> uuid): resolves an org-prefixed URL exactly (0081)
let keyByOrg = new Map<string, Map<string, string>>()
const handleFor = (uuid: string, orgId: string, key: string) =>
  orgId && orgId === HOME_ORG ? key : uuid

// Week indexes are UNBOUNDED offsets from TIMELINE_START (negative and past
// the prototype's 28 alike) — the roadmap's user-chosen window clips them
// visually, so out-of-window dates survive round trips instead of being
// corrupted by a drag-commit of a clamped position. Nothing bounds a week by
// `WEEKS` any more: the last thing that did was `snapToWeek`, the pickers'
// clamped rounding, and it went with the fixed viewport it belonged to. The
// constant stays in dates.ts as the prototype grid's nominal span, which is
// all the date tests still want it for — it is not part of the store's API.

const STATUSES = [
  { id: 'backlog', name: 'Backlog', tone: 'var(--status-backlog)' },
  { id: 'todo', name: 'To Do', tone: 'var(--status-todo)' },
  { id: 'progress', name: 'In Progress', tone: 'var(--status-progress)' },
  { id: 'review', name: 'In Review', tone: 'var(--status-review)' },
  { id: 'done', name: 'Done', tone: 'var(--status-done)' },
]
/* Rank is carried by the glyph — the number of bars — and by a lightness ramp
   down the text scale, not by four competing hues. Only `urgent` spends a hue,
   which is what makes it read as the exception it is meant to be. */
const PRIORITIES: Record<string, { id: string; name: string; rank: number; color: string }> = {
  urgent: { id: 'urgent', name: 'Urgent', rank: 0, color: 'var(--prio-urgent)' },
  high: { id: 'high', name: 'High', rank: 1, color: 'var(--prio-high)' },
  medium: { id: 'medium', name: 'Medium', rank: 2, color: 'var(--prio-medium)' },
  low: { id: 'low', name: 'Low', rank: 3, color: 'var(--prio-low)' },
}
/* Milestones are always the one colour (deviation #29 dropped the per-milestone
   pick); the token moved it off blue, which the accent now owns alone.
   A token, not hex: the roadmap's guide line must now derive its translucency
   with color-mix() rather than by suffixing alpha onto a literal — a var()
   with two hex digits stuck on the end is not a colour at all. */
const MILESTONE_COLOR = 'var(--milestone)'

/* How long a READ inbox message is kept, in days, and the periods the setting
   offers (0110). The number mirrors the old column default: a profile is
   inserted without the value, so the optimistic row has to predict what the
   default fills in, exactly as it does for plannable hours. */
const DEFAULT_MESSAGE_RETENTION_DAYS = 7
const MESSAGE_RETENTION_DAYS = [1, 7, 30, 90]

/* Inbox writes are orgMutations and a bulk act (mark all read) can span
   seats (0081): group the ids by their row's org so each mutation carries
   the org whose seat the rows are addressed to. Resolved BEFORE the caller
   mutates or prunes the rows. */
function messagesByOrg(ids: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  ids.forEach((id) => {
    const r = rows.messages.get(id)
    if (!r) return
    const l = m.get(r.org_id) || []
    l.push(id)
    m.set(r.org_id, l)
  })
  return m
}

/* Mirror the server prune after a read. A task retains its newest message
   plus any unread arrivals that were not part of this action. */
function markLoadedMessagesRead(ids: string[], at: string) {
  ids.forEach((id) => {
    rows.messages.get(id)!.read_at = at
  })
  const issues = new Set(ids.map((id) => rows.messages.get(id)!.issue_id))
  issues.forEach((issue) => {
    const mine = [...rows.messages.values()].filter((row) => row.issue_id === issue)
    const newest = mine.reduce((x, y) => (isNewer(x.created_at, x.id, y.created_at, y.id) ? y : x))
    mine.forEach((row) => {
      if (row.read_at && row.id !== newest.id) rows.messages.delete(row.id)
    })
  })
}

const updates = createPlannerUpdates()
const emit = updates.emit

export type { ToastTone }

/* The two window hooks the app hangs globally: App mounts showToast for the
   non-React layers (this store, imgActions), and the store re-exposes itself
   as window.PLANNER for the verify drives (scripts/verify-*.mjs). A showToast
   call without a tone shows a success. */
declare global {
  interface Window {
    showToast?: ((msg: string, tone?: ToastTone) => void) | null
    PLANNER?: unknown
  }
}

/* Store toasts are refusals and failures unless the caller names a tone. */
function toast(msg: string, tone: ToastTone = 'error') {
  window.showToast?.(msg, tone)
}

/** The save-time refusals for text over TEXT_MAX, the server's cap. The cap
    counts the stored markdown, so formatting, link targets and mentions
    count too. The editor and the store guards below share them. */
export const TEXT_TOO_LONG = {
  description: `Description too long to save. The limit is ${TEXT_MAX_LABEL} characters, including formatting.`,
  comment: `Comment too long to save. The limit is ${TEXT_MAX_LABEL} characters, including formatting.`,
}

/* --- the write path ---------------------------------------------------------
   Fire-and-forget mutations go through run(): the optimistic patch has
   already painted (rebuild + emit) by the time the mutation is dispatched,
   so run() only has to (a) reconcile off a return value, (b) roll a refusal
   back, and (c) gate the paint of concurrent subscription deliveries.

   The gate ("gate the paint, never the data"): a delivery caused by ANOTHER
   client can arrive while our own mutation is in flight; that snapshot does
   not contain our effects, and adopting it would wipe the optimistic patch,
   flicker the pre-write state, then repaint when our write's own delivery
   lands. So both subscription handlers ALWAYS record the delivery (serverSnap
   / commentsSnap) but defer adopt/rebuild/emit while inFlight > 0; the last
   settle flushes the newest held delivery. Convergence is guaranteed —
   Convex redelivers snapshots that include our own completed mutations —
   and rollback stays trivially correct: a failed write's effects never
   existed server-side, so re-adopting the newest serverSnap is the truth. */
let inFlight = 0
let storeEpoch = 0
let demoDisposed = false
let snapDirty = false // a snapshot delivery arrived while a write was in flight
let commentsDirty = false // …same for the watched comments thread

type RoadmapOperation = FunctionArgs<typeof api.roadmap.change>['operations'][number]
type RoadmapVisit = {
  id: string
  count: number
  pending: number
  disabled: boolean
  expiresAt: number
}
let roadmapVisit: RoadmapVisit | null = null
let roadmapDetailOpen = false
let roadmapBatch: RoadmapOperation[] | null = null

// View state is deliberately memory-only. A new visit gets a fresh server
// journal, so a late reply from an earlier visit cannot repopulate history.
function roadmapContext(active: boolean, detailOpen: boolean) {
  roadmapDetailOpen = active && detailOpen
  if (active === !!roadmapVisit) return
  roadmapVisit = active
    ? {
        id: crypto.randomUUID(),
        count: 0,
        pending: 0,
        disabled: false,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }
    : null
  emit()
}

function clearRoadmapHistory(visit: RoadmapVisit) {
  if (roadmapVisit !== visit || visit.disabled) return
  visit.count = 0
  visit.disabled = true
  emit()
}

function expireRoadmapHistory() {
  if (roadmapVisit && !roadmapVisit.disabled && Date.now() >= roadmapVisit.expiresAt) {
    clearRoadmapHistory(roadmapVisit)
    toast('Roadmap undo history expired. Leave Roadmap and return to start a new history.', 'info')
  }
}

function submitRoadmapChanges(operations: RoadmapOperation[]) {
  const visit = roadmapVisit
  if (!visit || !operations.length) return
  visit.pending++
  run(
    write(api.roadmap.change, { session_id: visit.id, operations }).then((result) => {
      // A clamped or rounded no-op emits no snapshot. Re-adopt the saved
      // values anyway so speculative dates, hours and touch time disappear.
      if (result.count <= visit.count) snapDirty = true
      if (roadmapVisit === visit && !visit.disabled)
        visit.count = Math.max(visit.count, result.count)
    }),
    undefined,
    () => {
      visit.pending--
      emit()
    },
  )
  emit()
}

function recordRoadmapChange(operation: RoadmapOperation): boolean {
  expireRoadmapHistory()
  if (!roadmapVisit || roadmapVisit.disabled || roadmapDetailOpen) return false
  if (roadmapBatch) roadmapBatch.push(operation)
  else submitRoadmapChanges([operation])
  return true
}

// Reads (including marking a task's messages read) keep history. Task content
// writes leave planning history behind, including edits made through nested
// comment, attachment, relationship and subscriber controls.
function isTaskContentWrite(name: string) {
  return (
    /^(issues:|comments:)/.test(name) ||
    ['labels:toggle', 'files:attach', 'files:removeAttachment'].includes(name)
  )
}

/* ConvexError.data = { code, message, reason? } (lib/functions.ts) — the one
   place the untyped `data` payload is given that shape, so every refusal
   reader below stays cast-free. A non-ConvexError answers {}: every field
   read stays undefined and the caller lands on its generic fallback. */
type ErrData = { code?: string; message?: string; reason?: string }
const errData = (e: unknown): ErrData => (e instanceof ConvexError ? (e.data as ErrData) || {} : {})
/** Refusals that mean the whole organization is read-only. Their sentences
   name the reason, and for a pending deletion its date, so they show verbatim. */
const readOnly = (d: ErrData) =>
  d.reason === 'billing_required' || d.reason === 'deletion_scheduled'
/** Capitalizes a refusal message and ends it with a period unless it already
    ends in `.`, `!` or `?`. Server messages are often lowercase fragments,
    and a toast joins them with a sentence of its own. */
const asSentence = (m: string) =>
  m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.')

/* --- snapshot health ---------------------------------------------------------
   The live snapshot (snapshot.forMe) can stop loading mid-session, after a
   size limit as an organization grows, a lost sign-in or a faulty deploy.
   The last good snapshot stays on screen and the snapshot notice says so.
   While it is stale, edits to shared data pause. An edit made from stale
   data can overwrite newer work, and run()'s rollback would re-adopt the
   stale snapshot over edits that did save, read marks included. So every
   optimistic mutator of shared data calls refusePausedEdit() before its
   paint, and the refusal never reaches that rollback. write() refuses any
   other shared write before it is sent, the backstop for a mutator that
   does not check first. Personal state (read marks, preferences,
   appearance, following) still saves, and so do the writes that only take
   access away (UNPAUSED_WRITES). Panels that call Convex directly
   (organization deletion and its export record, billing) act on their own
   live queries, not on the snapshot, so they do not pause. Convex reruns a
   failed query when the data it read changes, so a later delivery ends the
   trouble without a reload. */

/** The sentence every paused edit shows. */
export const PAUSED_TEXT = 'Editing is paused until Qivo loads the latest changes.'

/** Why the live snapshot is not current, while it is not. `asOf` is the last
    good delivery's server time, null before any. `detail` is the error text
    for support. `retrying` holds for one RETRY_GAP_MS window after Try again,
    or until a delivery ends the trouble. */
export type SnapshotTrouble = {
  kind: 'failed' | 'signed_out'
  since: number
  asOf: string | null
  retrying: boolean
  detail: string
}
let snapshotTrouble: SnapshotTrouble | null = null
/* A delivery that ends the trouble while run()'s paint gate holds it. The
   trouble ends when that paint lands, not before, so nobody edits the stale
   rows still on screen in the meantime. */
let recoveryHeld = false

/** Ends the trouble once a held recovering delivery has been painted. */
function endHeldRecovery() {
  if (recoveryHeld) snapshotRecovered()
}

/* The writes that go on while the snapshot is stale, each named. They change
   only the signed-in person's own state, read the OAuth consent page's
   request, or only take access away: revoking or deleting a credential, and
   deactivating or removing a seat. An admin must be able to shut out a
   leaked key or a compromised person during an outage, because REST, MCP
   and other people's sessions do not depend on this browser's snapshot. The
   access removals act on one row by id, so stale data cannot make them
   overwrite anyone's work. The server lets the same removals through while
   billing has made an organization read-only (accessRemovalMutation).
   Every other mutation pauses, including ones added later. */
const UNPAUSED_WRITES = new Set([
  'prefs:save',
  'issues:subscribe',
  'issues:unsubscribe',
  'issues:setSubscriber',
  'profiles:setMessageRetention',
  'oauthConnections:getContext',
  'oauthConnections:revoke',
  'tokens:revokeAgentKey',
  'tokens:deleteAgentKey',
  'tokens:revokeMcpToken',
  'tokens:deleteMcpToken',
  'apiAccess:revoke',
  'profiles:deactivate',
  'profiles:remove',
])
const isUnpausedWrite = (name: string) =>
  /^(messages|appearance):/.test(name) || UNPAUSED_WRITES.has(name)

/* One action can reach several mutators. The pause toast shows once for it. */
const PAUSED_TOAST_GAP_MS = 1000
let pausedToastAt = Number.NEGATIVE_INFINITY

/** Toasts the pause, at most once per PAUSED_TOAST_GAP_MS. */
function toastPaused() {
  const now = Date.now()
  if (now - pausedToastAt < PAUSED_TOAST_GAP_MS) return
  pausedToastAt = now
  toast(PAUSED_TEXT)
}

/** Toasts the pause and answers true while shared edits are paused. Every
    optimistic mutator calls it before its paint. Actions that take typed
    text, close a window or announce success call it before they do, so a
    paused save keeps the text in its field and claims nothing. */
function refusePausedEdit(): boolean {
  if (!snapshotTrouble) return false
  toastPaused()
  return true
}

/* 'rule' and read-only sentences are the P0001 successors and keep their
   words, shaped by asSentence. Everything else is deliberately generic. The
   wording says "reverted", never "reloading", because rollback is a repaint,
   not a refetch. A paused write never left the browser, so its sentence is
   the pause itself. */
function toastWriteError(e: unknown) {
  const d = errData(e)
  if (d.code === 'paused') {
    toastPaused()
    return
  }
  if ((readOnly(d) || d.code === 'rule') && d.message) {
    toast(`${asSentence(String(d.message))} Change reverted.`)
    return
  }
  if (d.code === 'forbidden') {
    toast("You don't have permission for that. Change reverted.")
    return
  }
  // not_found, bad_request, conflict, transport — all generic
  toast("Couldn't save. Change reverted.")
}

/* The two awaited restores share one refusal voice: a `rule` (or not_found)
   sentence is quoted, forbidden reads the fixed permission line. */
function restoreErrorText(e: unknown): string {
  const d = errData(e)
  if (d.code === 'paused') return PAUSED_TEXT
  if (readOnly(d) && d.message) return d.message
  if (d.code === 'forbidden') return "You don't have permission for that"
  if (d.message) return `Couldn't restore. ${asSentence(String(d.message))}`
  return "Couldn't restore"
}

/* A Deleted items call the server refused whole, in the restore refusal voice
   above: billing's sentence as it is, the fixed permission line, a rule's own
   sentence after what failed. Anything else (offline, a server fault) asks
   for another try. */
function deletedItemsErrorText(e: unknown, failed: string): string {
  const d = errData(e)
  // read-only for billing or a scheduled deletion says why, in its own words
  if (readOnly(d) && d.message) return d.message
  if (d.code === 'forbidden') return "You don't have permission for that."
  if (d.code === 'rule' && d.message) {
    const m = String(d.message)
    return `${failed}. ${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`
  }
  return `${failed}. Try again.`
}

/** The most ids one deletedItems.restore or purge call takes
    (convex/model/deletedItems.ts RESTORE_MAX, PURGE_MAX). */
const DELETED_ITEMS_BATCH = 25

/* Sends `items` in calls of one organization and at most 25 ids each, one
   call after another, and adds up the answers. A call refused whole fails
   only its own ids. */
async function deletedItemsCalls<Reason>(
  items: { id: string; org_id: string }[],
  send: (
    orgId: string,
    ids: string[],
  ) => Promise<
    { refused: { id: string; reason: Reason }[]; deferred?: string[] } & (
      | { restored: string[] }
      | { purged: string[] }
    )
  >,
  failed: string,
): Promise<DeletedItemsOutcome<Reason>> {
  const outcome: DeletedItemsOutcome<Reason> = {
    done: [],
    refused: [],
    deferred: [],
    failed: [],
    error: null,
  }
  const byOrg = new Map<string, string[]>()
  for (const { id, org_id } of items) {
    const ids = byOrg.get(org_id) ?? []
    if (!ids.includes(id)) ids.push(id)
    byOrg.set(org_id, ids)
  }
  for (const [orgId, ids] of byOrg) {
    for (let at = 0; at < ids.length; at += DELETED_ITEMS_BATCH) {
      const batch = ids.slice(at, at + DELETED_ITEMS_BATCH)
      try {
        const answer = await send(orgId, batch)
        outcome.done.push(...('restored' in answer ? answer.restored : answer.purged))
        outcome.refused.push(...answer.refused)
        outcome.deferred.push(...(answer.deferred ?? []))
      } catch (e) {
        console.error('[qivo] deleted items call failed:', e)
        outcome.failed.push(...batch)
        outcome.error ??= deletedItemsErrorText(e, failed)
      }
    }
  }
  return outcome
}

/* A refused project create names what disappeared, followed by the reason
   when a rule, billing or permission refusal carries one (a forbidden create
   says who can create projects); every other refusal would read
   "Couldn't save", which does not say a project is gone. */
function toastCreateProjectError(e: unknown, label: string) {
  const d = errData(e)
  if (d.code === 'paused') {
    toastPaused()
    return
  }
  const m = d.message ? String(d.message) : ''
  const reason = m && asSentence(m)
  if ((d.code === 'rule' || readOnly(d)) && reason) {
    toast(`Couldn't create ${label}. ${reason}`)
    return
  }
  if (d.code === 'forbidden') {
    toast(
      reason ? `No permission to create ${label}. ${reason}` : `No permission to create ${label}`,
    )
    return
  }
  toast(`Couldn't create ${label}`)
}

/* The avatar mutators return an error SENTENCE (Settings toasts it verbatim).
   A refusal's own message — the set_avatar right, the mime/2 MB rules — is
   the best sentence there is; anything without one gets the fallback. */
function avatarErrorText(e: unknown, fallback: string): string {
  const d = errData(e)
  if (d.message) {
    const m = String(d.message)
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  return fallback
}

/* setOrgSlug's refusal taxonomy: the whole point of the address being a
   field is that a refusal names what to do about it (the old 23505/23514
   constraint-sniffing, now first-class reasons). */
function slugErrorText(e: unknown): string {
  const d = errData(e)
  if (d.code === 'conflict') {
    if (d.reason === 'slug_taken') return 'That address is already taken. Choose another.'
    if (d.reason === 'slug_reserved') return 'That address is reserved. Choose another.'
    // slug_shape — a reserved word is also a perfectly well-shaped slug,
    // so the reason is the answer
    return 'Use lowercase letters, digits and single hyphens; 40 characters maximum.'
  }
  if (d.code === 'forbidden') return "You don't have permission to change the address."
  if (d.message) {
    const m = String(d.message)
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  return "Couldn't change the address"
}

// Every store mutation passes through write(). Awaited writes (invitations,
// credentials, restores, account settings) do not use run()'s optimistic
// paint gate. They still need to finish before a version reload; preserve the
// Convex client's exact generic wire signature. While the live snapshot is
// stale, a shared-data write is refused here with code `paused` before it is
// sent (see snapshot health above).
const write: typeof convex.mutation = (mutation, args, options) => {
  const epoch = storeEpoch
  if (DEMO_MODE && demoDisposed)
    return Promise.reject(new ConvexError({ code: 'forbidden', message: 'Your demo has expired.' }))
  const name = getFunctionName(mutation)
  if (snapshotTrouble && !isUnpausedWrite(name))
    return Promise.reject(new ConvexError({ code: 'paused', message: PAUSED_TEXT }))
  const releaseUpdate = beginUpdateBlock()
  const visit = roadmapVisit
  const clearsHistory = visit && !visit.disabled && isTaskContentWrite(name)
  try {
    return convex
      .mutation(mutation, args, options)
      .then((result) => {
        // Awaited uploads have their own adoption after this promise. Refuse
        // late results here as well as run() so they cannot restore bytes or
        // rows from a demo that the interface already disposed.
        if (DEMO_MODE && epoch !== storeEpoch)
          throw new ConvexError({ code: 'forbidden', message: 'Your demo has expired.' })
        if (clearsHistory) clearRoadmapHistory(visit)
        return result
      })
      .catch((error) => {
        if (DEMO_MODE && epoch === storeEpoch && isDemoLifecycleRefusal(error)) notifyDemoEnded()
        throw error
      })
      .finally(releaseUpdate)
  } catch (error) {
    releaseUpdate()
    throw error
  }
}

// Compression, credential hashing and byte uploads span more than one
// mutation. Keep the entire operation protected, including the gaps.
function withUpdateBlock<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const releaseUpdate = beginUpdateBlock()
    try {
      return await operation(...args)
    } finally {
      releaseUpdate()
    }
  }
}

/** Mints an agent key (qva) or personal MCP token (qvt) in the browser.
    Returns the one-time secret, its SHA-256 hex for the server and a new row
    id. Rejects outside a secure context, where crypto.subtle and randomUUID
    are missing, so callers that promise never to throw must call it inside
    their try. */
async function mintCredential(scheme: 'qva' | 'qvt') {
  const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const secret = `${scheme}_${hex(crypto.getRandomValues(new Uint8Array(24)))}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return { id: crypto.randomUUID(), secret, hash: hex(new Uint8Array(digest)) }
}

function run<T>(
  op: Promise<T>,
  onOk?: (v: T) => void,
  onSettled?: () => void,
  onError = toastWriteError,
): void {
  const epoch = storeEpoch
  const releaseUpdate = beginUpdateBlock()
  inFlight++
  void op
    .then(
      (v) => {
        if (epoch !== storeEpoch) return
        if (onOk) onOk(v)
      },
      (e) => {
        if (epoch !== storeEpoch) return
        console.error('[qivo] write failed:', e)
        onError(e)
        // rollback = re-adopt the newest server truth; a delivery held by the
        // gate IS that truth, so the flags clear here
        snapDirty = false
        commentsDirty = false
        if (serverSnap) adopt(serverSnap)
        /* A successful archive or delete may still be awaiting its reactive
           delivery; preserve that boundary if another write refuses first. */
        reapplyAcceptedRemovals()
        adoptComments()
        rebuild()
        emit()
        endHeldRecovery()
      },
    )
    .finally(() => {
      try {
        if (epoch === storeEpoch) {
          inFlight--
          if (inFlight === 0) flushHeldPaint()
        }
      } finally {
        if (epoch === storeEpoch) onSettled?.()
        releaseUpdate()
      }
    })
}

/* run() a write and resolve whether the server accepted it. A refusal is
   toasted and rolled back as usual before the promise settles. */
function runSaved(op: Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) =>
    run(
      op,
      () => resolve(true),
      undefined,
      (error) => {
        toastWriteError(error)
        resolve(false)
      },
    ),
  )
}

/* The last settle repaints whatever the gate held back. One rebuild+emit
   even when both a snapshot and a comments delivery were held. */
function flushHeldPaint() {
  const snapHeld = snapDirty
  const comHeld = commentsDirty
  snapDirty = false
  commentsDirty = false
  if (!snapHeld && !comHeld) return
  if (snapHeld && serverSnap) adopt(serverSnap)
  if (comHeld) adoptComments()
  if (snapHeld) rebuild()
  else rebuildComments()
  emit(snapHeld ? 'workspace' : 'comments')
  if (snapHeld) endHeldRecovery()
}

/* --- minted file URLs (phase 7) ---------------------------------------------
   Attachment and avatar bytes serve through the token-checked HTTP gateway
   (/files/<uuid>, /avatars/<uuid> on the Convex site origin); the URLs come
   from files.mintUrls, batched, and live ~10 minutes.
   Attachments keep their signed URL; portraits prepare one decoded blob URL
   per `avatar:<profileId>:<storageId>`. Renewing an unchanged portrait checks
   access without dropping its source or downloading its bytes again.

   mintUrls is a QUERY but must be consumed ONE-SHOT (convex.query), never
   subscribed: exp comes from Date.now(), which is not a reactive dependency —
   a subscription would pin a stale exp forever. THIS cache owns refresh
   timing: rebuild() re-primes anything expiring within the skew, a sweep
   covers idle tabs (avatars only — an expired inline <img> recovers through
   its own onError → attachmentUrl retry), and expiry is re-checked here with
   the same skew the server's TTL was designed against. */
const MINT_SKEW = 120_000 // treat as stale this long before expiry
const MINT_SWEEP = 30_000 // access renewal, retry and stale-byte cleanup (avatars)
const AVATAR_MINT_TIMEOUT = 15_000
const minted = new Map<string, { url: string; exp: number }>() // exp: unix SECONDS
const minting = new Map<string, Promise<boolean>>() // key -> its batch, for dedup
const avatarSources = createAvatarSources()
let mintSweep: ReturnType<typeof setInterval> | null = null

function clearAvatarSources() {
  avatarSources.clear()
  avatarSources.setPersistent(null)
  for (const key of minting.keys()) if (key.startsWith('avatar:')) minting.delete(key)
  if (mintSweep) clearInterval(mintSweep)
  mintSweep = null
}

/** The minted URL for a cache key, or null when absent/expiring. Synchronous
    by construction — callable from rebuild() and every render path. */
function mintedUrl(key: string): string | null {
  const hit = minted.get(key)
  return hit && hit.exp * 1000 - Date.now() > MINT_SKEW ? browserBackendUrl(hit.url) : null
}

type MintItem = { kind: 'attachment' | 'avatar'; id: string }

/** Mint URLs for every item that has no fresh one. Resolves true when a
    displayed source changed — the caller's cue to REBUILD (the
    URLs are baked into the snapshot, so a bare emit is not enough). Never
    rejects: an item that cannot be minted leaves its consumer on the
    "unavailable" state, exactly like the old signing path. Items another
    call is already minting are awaited, not re-requested. */
async function primeMint(items: MintItem[]): Promise<boolean> {
  const epoch = storeEpoch
  // group by the org the mint is asked through: an attachment's is its
  // issue's (mintUrls silently skips foreign-org ids); avatars are answered
  // across every org I hold a seat in, so one call through the home seat
  // (or any seat, for a guest-only login) covers the whole blended roster
  const byOrg = new Map<
    string,
    { attachment_ids: string[]; profile_ids: string[]; keys: Map<string, string> }
  >()
  const slot = (org: string) => {
    let s = byOrg.get(org)
    if (!s) {
      s = { attachment_ids: [], profile_ids: [], keys: new Map() }
      byOrg.set(org, s)
    }
    return s
  }
  const wanted: string[] = [] // cache keys this call is about
  const claimed: string[] = [] // …the subset this call will fetch itself
  const waits: Promise<boolean>[] = [] // other calls' in-flight batches
  const avatarTickets = new Map<string, ReturnType<typeof avatarSources.ticket>>()
  for (const it of items) {
    let key: string
    let org: string
    if (it.kind === 'attachment') {
      const rec = rows.attachments.get(it.id)
      const issue = rec ? rows.issues.get(rec.issue_id) : undefined
      if (!rec || !issue) continue
      key = `att:${it.id}`
      org = issue.org_id
    } else {
      const prof = rows.profiles.get(it.id)
      if (!prof?.avatar_storage_id) continue
      key = `avatar:${it.id}:${prof.avatar_storage_id}`
      org = HOME_ORG || myProfiles.keys().next().value || ''
      if (!org) continue
    }
    if (it.kind === 'avatar' ? !avatarSources.needsRefresh(key) : mintedUrl(key)) continue
    wanted.push(key)
    const inflight = minting.get(key)
    if (inflight) {
      waits.push(inflight)
      continue
    }
    const s = slot(org)
    if (it.kind === 'attachment') {
      s.attachment_ids.push(it.id)
      s.keys.set(`a:${it.id}`, key)
    } else {
      s.profile_ids.push(it.id)
      s.keys.set(`p:${it.id}`, key)
      avatarTickets.set(key, avatarSources.ticket(key))
    }
    claimed.push(key)
  }
  if (!wanted.length) return false
  if (claimed.length) {
    const batch = (async () => {
      let changed = false
      await Promise.all(
        [...byOrg.entries()].map(async ([org, s]) => {
          try {
            // ONE-SHOT on purpose — see the header above
            const querying = convex.query(api.files.mintUrls, {
              org_id: org,
              ...(s.attachment_ids.length ? { attachment_ids: s.attachment_ids } : {}),
              ...(s.profile_ids.length ? { profile_ids: s.profile_ids } : {}),
            })
            let deadline: ReturnType<typeof setTimeout> | undefined
            const res = await (s.profile_ids.length
              ? Promise.race([
                  querying,
                  new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                      () => reject(new Error('Profile URL refresh timed out')),
                      AVATAR_MINT_TIMEOUT,
                    )
                  }),
                ]).finally(() => clearTimeout(deadline))
              : querying)
            if (epoch !== storeEpoch) return
            // invisible/missing ids are silently OMITTED from the result (the
            // consumers render their "unavailable" state; no existence oracle)
            Object.entries(res.attachments).forEach(([id, m]) => {
              const key = s.keys.get(`a:${id}`)
              if (key) {
                minted.set(key, m)
                changed = true
              }
            })
            await Promise.all(
              s.profile_ids.map(async (id) => {
                const key = s.keys.get(`p:${id}`)
                const ticket = avatarTickets.get(key)
                const lease = res.avatars[id]
                // A snapshot replacement can overtake either the mint or its
                // byte fetch. Never attach a newer storage version to an old key.
                if (!lease || new URL(lease.url).searchParams.get('v') !== key.split(':').at(-1)) {
                  if (avatarSources.failure(key, true, ticket)) {
                    rebuild()
                    emit()
                  }
                  return
                }
                if (
                  await avatarSources.prepare(
                    key,
                    { ...lease, url: browserBackendUrl(lease.url) },
                    ticket,
                  )
                ) {
                  // One slow portrait must not hold the roster's ready faces.
                  if (epoch === storeEpoch) {
                    rebuild()
                    emit()
                  }
                }
              }),
            )
          } catch (e) {
            const refused = e instanceof ConvexError
            for (const id of s.profile_ids) {
              const key = s.keys.get(`p:${id}`)
              if (avatarSources.failure(key, refused, avatarTickets.get(key))) changed = true
            }
            console.warn('[qivo] url mint failed:', e)
          }
        }),
      )
      return changed
    })()
    claimed.forEach((k) => {
      minting.set(k, batch)
    })
    waits.push(batch)
    void batch.finally(() => {
      claimed.forEach((k) => {
        if (minting.get(k) === batch) minting.delete(k)
      })
    })
  }
  return (await Promise.all(waits)).some(Boolean)
}

/** Re-mint before anything goes stale. A rebuild already primes, but a tab
    nobody touches would otherwise watch its faces disappear at the TTL. */
function startMintSweep() {
  if (mintSweep || typeof setInterval !== 'function') return
  mintSweep = setInterval(() => {
    const expired = avatarSources.expire()
    const need: MintItem[] = []
    rows.profiles.forEach((u) => {
      if (
        u.avatar_storage_id &&
        avatarSources.needsRefresh(`avatar:${u.id}:${u.avatar_storage_id}`)
      ) {
        need.push({ kind: 'avatar', id: u.id })
      }
    })
    if (expired) {
      rebuild()
      emit()
    }
    if (need.length)
      void primeMint(need).then((grew) => {
        if (grew) {
          rebuild()
          emit()
        }
      })
  }, MINT_SWEEP)
}

/* Agent-key rows live outside the snapshot but their mutations are
   orgMutations: remember which organization each listed key's agent belongs
   to, so revoke/delete (which take only the key id) can name the right seat. */
const agentKeyOrg = new Map<string, string>()

const preferences = createPreferences({
  profileId: () => CURRENT_USER,
  read: () => convex.query(api.prefs.get, {}),
  write: (profileId, prefs) => write(api.prefs.save, { profile_id: profileId, prefs }),
  storage: () => localStorage,
  beginUpdate: beginUpdateBlock,
})

/* --- identity ---------------------------------------------------------------
   CURRENT_USER is the HOME profile (the org this person belongs to) — the one
   "me" every existing surface means. `myProfiles` maps org → my profile there,
   so a write into a foreign org is attributed to the guest profile that org
   knows, never to the home one (which it cannot even see). Re-derived from
   every snapshot delivery: forMe carries auth_user_id + myProfileIds
   explicitly, so the client never has to guess which roster rows are its own. */
let CURRENT_USER = '' // profile uuid of the signed-in user, in the HOME org
let HOME_ORG = '' // the org of the non-guest profile ('' for guest-only logins)
let myProfiles = new Map<string, string>() // org id -> my profile id there
const myProfileSet = new Set<string>()

/** The home organization row (null for a guest-only login). */
const homeRow = () => (HOME_ORG ? rows.orgs.get(HOME_ORG) || null : null)

/** My profile in a named organization, or an empty string when I have none. */
const profileIn = (orgId: string | null | undefined) => (orgId && myProfiles.get(orgId)) || ''

/* WHO answers for a permission question in `orgId` — the client twin of the
   server's me-join (0081). With no uid it is MY seat in that organization
   (I may hold several: one home, one per org that shared a project with me);
   with an explicit uid it is that person, but only if they live there.
   Rights are read from the seat inside the row's own organization and never
   travel between a caller's seats — being an admin at home must not make me
   an admin of the organization that invited me as a guest. */
const actorIn = (orgId: string | null | undefined, uid?: string): UserVM | null => {
  const id = uid || profileIn(orgId)
  if (!id) return null
  const u = PLANNER.user(id)
  return u && u.org === orgId ? u : null
}

/* Grants are scoped to the named project. A sub-project adds its own grants
   to its parent's grants; child access never becomes a grant on the parent
   or a sibling. A parent may still appear as a read-only navigation entry. */
const higherLevel = (a: string | null, b: string | null): string | null => {
  const rank = (level: string | null) =>
    level === 'lead' ? 3 : level === 'user' ? 2 : level === 'viewer' ? 1 : 0
  return rank(a) >= rank(b) ? a : b
}
/* The parts of a project its levels are read from, so a draft that does not
   exist yet can be asked too (P.seesNewProject). */
type ProjectGrants = Pick<ProjectVM, 'org' | 'parent' | 'lead' | 'access' | 'teamAccess'>
const grantOnProject = (p: ProjectGrants, user: UserVM): string | null => {
  let level = p.access?.[user.id] || null
  if (user.orgRole === 'admin' || user.orgRole === 'user' || user.orgRole === 'viewer') {
    for (const teamId of user.teams) {
      if (rows.teams.get(teamId)?.org_id === p.org) {
        level = higherLevel(level, p.teamAccess?.[teamId] || null)
      }
    }
  }
  return level
}
const levelOnProject = (
  p: ProjectGrants | null | undefined,
  uid?: string,
  projectById: (id: string) => ProjectVM | undefined = (id) => PLANNER.project(id),
): string | null => {
  if (!p) return null
  const user = actorIn(p.org, uid)
  if (!user?.active) return null
  if (user.orgRole === 'admin') return 'lead'
  const parent = p.parent ? projectById(p.parent) : null
  let level = grantOnProject(p, user)
  if (parent?.org === p.org) {
    const inherited = grantOnProject(parent, user)
    level = higherLevel(level, inherited === 'lead' && p.lead ? 'user' : inherited)
  }
  return user.orgRole === 'viewer' && level ? 'viewer' : level
}
const visibleLevelOnProject = (p: ProjectVM | null | undefined, uid?: string): string | null => {
  const own = levelOnProject(p, uid)
  if (own || !p || p.type !== 'meta') return own
  return PLANNER.projects.some((child) => child.parent === p.id && levelOnProject(child, uid))
    ? 'viewer'
    : null
}

/** The organization a project belongs to (sub-projects via their parent). */
function orgOfProject(pid: string | null | undefined): string {
  const p = pid ? rows.projects.get(pid) : null
  return p ? p.org_id : ''
}

/* --- derived snapshot -------------------------------------------------------- */

const findProject = createEntityLookup<ProjectVM>()
const findUser = createEntityLookup<UserVM>()
const findTeam = createEntityLookup<TeamVM>()

function rebuildComments() {
  PLANNER.comments = [...rows.comments.values()]
    .map(shapeComment)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
}

function rebuild(now = new Date()) {
  const P = PLANNER
  avatarSources.sync(
    [...rows.profiles.values()]
      .filter((profile) => profile.avatar_storage_id)
      .map((profile) => `avatar:${profile.id}:${profile.avatar_storage_id}`),
  )

  // week grid first: the org's week settings re-anchor TIMELINE_START, and
  // every isoToWeek below depends on it (dates.ts exports a live binding;
  // the snapshot property on P must be refreshed by hand). When the anchor
  // actually moves (settings change, or the week rolled over mid-session)
  // every committed index below is re-derived — indexes held in UI state
  // are then in OLD-grid units; gridEpoch lets gesture code detect that
  // and discard instead of committing shifted dates.
  // display config follows the HOME org everywhere: one week grid for the
  // whole blended view (a foreign org's own users still see their settings
  // in their app — the underlying dates are identical either way). A login
  // with only guest seats has no home org to take it from, so it borrows the
  // grid of an org it can see — but never that org's IDENTITY (below): the
  // upper-left well must not claim someone else's company as yours.
  const home = homeRow()
  const displayOrg = home || rows.orgs.values().next().value || null
  setWeekConfig(
    displayOrg ? displayOrg.week_start : null,
    displayOrg ? displayOrg.week_one_rule : null,
    now,
  )
  if (!P.TIMELINE_START || P.TIMELINE_START.getTime() !== TIMELINE_START.getTime()) P.gridEpoch++
  P.TIMELINE_START = TIMELINE_START
  P.TODAY_POS = TODAY_POS // day-precision today marker; moves with the anchor
  P.TODAY_ISO = TODAY_ISO

  // users
  const teamsByProfile = new Map<string, string[]>()
  const leadsByProfile = new Map<string, string[]>()
  rows.teamMembers.forEach((m) => {
    const l = teamsByProfile.get(m.profile_id) || []
    l.push(m.team_id)
    teamsByProfile.set(m.profile_id, l)
    if (m.is_leader) {
      const a = leadsByProfile.get(m.profile_id) || []
      a.push(m.team_id)
      leadsByProfile.set(m.profile_id, a)
    }
  })
  P.users = [...rows.profiles.values()]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((u) =>
      shapeUser(
        u,
        teamsByProfile.get(u.id) || [],
        leadsByProfile.get(u.id) || [],
        avatarSources.url(`avatar:${u.id}:${u.avatar_storage_id}`),
        DEMO_MODE,
      ),
    )

  // org — P.org IS the home org (the one whose settings the app runs on);
  // identity is the HOME org's (empty for a guest-only login), the display
  // settings fall back to a visible org's — see shapeOrg
  P.org = shapeOrg(home, displayOrg, rows.billing)
  P.homeOrg = HOME_ORG
  P.orgs = [...rows.orgs.values()]
    .map(shapeOrgRef)
    .sort((a, b) => (a.id === HOME_ORG ? -1 : b.id === HOME_ORG ? 1 : a.name.localeCompare(b.name)))
  P.myProfileIds = [...myProfileSet]

  // teams
  // name tiebreak: seeded teams share one transaction-stable created_at,
  // and without it the order follows the DB's arbitrary physical row order
  P.teams = [...rows.teams.values()]
    .sort((a, b) =>
      a.created_at < b.created_at
        ? -1
        : a.created_at > b.created_at
          ? 1
          : a.name.localeCompare(b.name),
    )
    .map(shapeTeam)

  // labels (one shared, curated list per ORGANIZATION since 0078 — a task
  // keeps its labels wherever in the org it moves)
  P.labels = [...rows.labels.values()]
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    .map(shapeLabel)
  const labelById: Record<string, LabelVM> = {}
  P.labels.forEach((l) => {
    labelById[l.id] = l
  })
  P.labelById = labelById
  const labelsByIssue = new Map<string, string[]>() // issue uuid -> label ids (name order)
  rows.issueLabels
    .slice()
    .sort((a, b) => {
      const an = (rows.labels.get(a.label_id) || { name: '' }).name.toLowerCase()
      const bn = (rows.labels.get(b.label_id) || { name: '' }).name.toLowerCase()
      return an < bn ? -1 : 1
    })
    .forEach((il) => {
      if (!rows.labels.has(il.label_id)) return
      const l = labelsByIssue.get(il.issue_id) || []
      l.push(il.label_id)
      labelsByIssue.set(il.issue_id, l)
    })

  // projects (+ children / access derived) — see shapeProject
  const accByProject = new Map<string, Record<string, string>>()
  rows.access.forEach((a) => {
    const m = accByProject.get(a.project_id) || {}
    m[a.profile_id] = a.level
    accByProject.set(a.project_id, m)
  })
  const teamAccByProject = new Map<string, Record<string, TeamAccessLevel>>()
  rows.teamAccess.forEach((a) => {
    const m = teamAccByProject.get(a.project_id) || {}
    m[a.team_id] = a.level
    teamAccByProject.set(a.project_id, m)
  })
  const childrenOf = new Map<string, Row<'projects'>[]>()
  rows.projects.forEach((p) => {
    if (p.parent_id) {
      const l = childrenOf.get(p.parent_id) || []
      l.push(p)
      childrenOf.set(p.parent_id, l)
    }
  })
  const allShapes = [...rows.projects.values()]
    .sort(byOrder)
    .map((p) => shapeProject(p, childrenOf, accByProject, teamAccByProject))
  const shapeById = new Map(allShapes.map((s) => [s.id, s]))
  P.projects = allShapes.filter((s) => s.archivedAt == null)
  /* …and the archived ones. Each row answers its page's two questions itself
     because the ordinary route (metaOf → levelOn) resolves through
     P.projects, which by construction no longer holds these. `withParent` is
     the sub-project rule the server's cascade states in timestamps: a sub
     archived along with its project comes back with it, one archived earlier
     on its own does not. Newest archived first: this is a list you scan for
     what you just put in it, or for the oldest thing to delete. A project
     shared with you only through one of its sub-projects is listed as a
     viewer, the server's navigation-only rule (projectLevelsForOrg), so that
     sub-project has a row to sit under. */
  const shapeOf = (id: string) => shapeById.get(id)
  const viaSubProject = (s: ProjectVM) =>
    s.type === 'meta' &&
    (childrenOf.get(s.id) || []).some((c) => levelOnProject(shapeOf(c.id), undefined, shapeOf))
  P.archivedProjects = allShapes
    .filter((s) => s.archivedAt != null)
    .flatMap((s) => {
      const meta = s.type === 'meta' ? s : s.parent ? shapeOf(s.parent) : undefined
      const level = levelOnProject(s, undefined, shapeOf) ?? (viaSubProject(s) ? 'viewer' : null)
      return level ? [shapeArchivedProject(s, meta, level === 'lead')] : []
    })
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0) || a.name.localeCompare(b.name))
  P.projectTags = duplicateNameTags(P.projects, P.archivedProjects)

  // issues — handle mapping first, then shapes with mirrored links + children.
  // Numbers are per ORG (0050), so a blended snapshot (0081) can hold two
  // "QN-5": the HANDLE (see handleFor) keeps the app's references unique
  // while `keyByOrg` resolves an org-prefixed URL to the exact one.
  keyToUuid = new Map()
  uuidToKey = new Map()
  uuidToDisplayKey = new Map()
  keyByOrg = new Map()
  rows.issues.forEach((i) => {
    const key = `${ISSUE_PREFIX}-${i.num}`
    let m = keyByOrg.get(i.org_id)
    if (!m) {
      m = new Map()
      keyByOrg.set(i.org_id, m)
    }
    m.set(key, i.id)
    uuidToDisplayKey.set(i.id, key)
    const handle = handleFor(i.id, i.org_id, key)
    uuidToKey.set(i.id, handle)
    keyToUuid.set(handle, i.id)
  })

  const linkViews = new Map<string, { type: string; id: string }[]>() // uuid -> links
  const REV: Record<string, string> = {
    blocks: 'blocked_by',
    blocked_by: 'blocks',
    relates: 'relates',
  }
  rows.links.forEach((l) => {
    const sKey = uuidToKey.get(l.source_id)
    const tKey = uuidToKey.get(l.target_id)
    if (!sKey || !tKey) return
    const s = linkViews.get(l.source_id) || []
    if (!s.some((x) => x.id === tKey)) s.push({ type: l.type, id: tKey })
    linkViews.set(l.source_id, s)
    const t = linkViews.get(l.target_id) || []
    if (!t.some((x) => x.id === sKey)) t.push({ type: REV[l.type] || 'relates', id: sKey })
    linkViews.set(l.target_id, t)
  })

  const childKeys = new Map<string, string[]>() // parent uuid -> child keys
  rows.issues.forEach((i) => {
    if (i.parent_id) {
      const l = childKeys.get(i.parent_id) || []
      l.push(uuidToKey.get(i.id) as string)
      childKeys.set(i.parent_id, l)
    }
  })

  /* Tasks I follow (0114). The cache holds only my own rows, but "my own"
     is plural — one human is several profile uuids, one per organization
     (myProfileSet), so a task in a guest org is followed under that seat's
     id and `=== CURRENT_USER` would read it back as "not following". */
  const subscribedIssues = new Set<string>()
  rows.issueSubs.forEach((s) => {
    if (myProfileSet.has(s.profile_id)) subscribedIssues.add(s.issue_id)
  })

  const attByIssue = new Map<string, AttachmentVM[]>() // issue uuid -> attachment views
  ;[...rows.attachments.values()]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .forEach((a) => {
      if (a.inline) return // description images live in the markdown, not the attachments list
      const l = attByIssue.get(a.issue_id) || []
      l.push(shapeAttachment(a))
      attByIssue.set(a.issue_id, l)
    })

  const issueCtx = {
    linkViews,
    childKeys,
    labelsByIssue,
    attByIssue,
    subscribedIssues,
    uuidToKey,
    uuidToDisplayKey,
    hiddenSubtaskParents: rows.hiddenSubtaskParents,
    hiddenParentTasks: rows.hiddenParentTasks,
  }
  P.issues = [...rows.issues.values()]
    .sort((a, b) => a.num - b.num)
    .map((i) => shapeIssue(i, issueCtx))
  // keyed by HANDLE, so it is a bijection even across organizations
  const byId: Record<string, IssueVM> = {}
  P.issues.forEach((it) => {
    byId[it.id] = it
  })
  P.issueById = byId
  /* A group's dates are calculated as the span of its visible scheduled
     leaves at any depth (groupSpan). They replace the group's own start/end
     here so every reader gets them. The stored dates stay in the row, dormant
     like its status, and apply again once its last subtask leaves. A group with
     subtasks outside this view is `partial`, which limits its delay verdict. */
  const partialSpans = new Set<string>()
  P.issues.forEach((it) => {
    const span = groupSpan(it, byId)
    if (!span) return
    it.start = span.start
    it.end = span.end
    if (span.partial) partialSpans.add(it.uuid)
  })

  // projected-delay status (0064) — each visible issue's finish week walked
  // against its effective owner's org-wide free capacity (plan_org_load), the
  // same spread/fit math as the roadmap's auto-fit. Capacity is the OWNER's
  // own plannable week (0092), which is also whose load it is walked against:
  // the reviewer while the task waits In Review, else the assignee (#314). An
  // unowned issue never reaches the capacity branch of delayOf.
  const loadByOwner = new Map<string, LoadSpan[]>()
  orgLoadByOwner = loadByOwner
  committedByOwner.clear()
  rows.orgLoad.forEach((r) => {
    const l = loadByOwner.get(r.owner_id) || []
    l.push({
      issueUuid: r.issue_id || null,
      start: isoToWeek(r.start_week),
      end: isoToWeek(r.end_week),
      remaining: r.remaining != null ? Number(r.remaining) : 0,
      remainingSet: r.remaining_set_at != null ? tsToWeek(r.remaining_set_at) : null,
    })
    loadByOwner.set(r.owner_id, l)
  })
  // indexed once: this runs per ISSUE, and P.user is a linear scan
  const capacityByUser = new Map<string, number>()
  P.users.forEach((u) => {
    capacityByUser.set(u.id, plannableHoursOf(u))
  })
  const capacityOf = (person: string | null | undefined) =>
    (person && capacityByUser.get(person)) || DEFAULT_PLANNABLE_HOURS
  delayMap = computeDelayMap(
    P.issues.map((it) => ({
      uuid: it.uuid,
      status: it.status,
      isGroup: PLANNER.isGroup(it),
      isDone: PLANNER.isDone(it),
      partial: partialSpans.has(it.uuid),
      owner: it.owner,
      start: it.start,
      end: it.end,
      dueWeek: it.due ? isoToWeek(it.due) : null,
      duePast: !!it.due && it.due < TODAY_ISO,
      remaining: it.remaining,
      remainingSet: it.remainingSet,
      capacity: capacityOf(it.owner),
    })),
    loadByOwner,
  )

  // milestones / activity
  P.milestones = [...rows.milestones.values()]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map(shapeMilestone)
  P.activity = [...rows.activity.values()]
    .map((event) => shapeActivity(event, uuidToKey))
    .sort((a, b) => a.ts - b.ts)

  // comments — the watched issue's only (oldest first, like activity; the
  // discussion spine reverses for newest-first display). Ties on the insert
  // timestamp order by id so two optimistic rows can't swap on redelivery.
  rebuildComments()

  // inbox messages (0074) — own rows only, newest first (shapeMessage)
  P.messages = [...rows.messages.values()]
    .map((message) => shapeMessage(message, { issues: rows.issues, uuidToKey, uuidToDisplayKey }))
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))

  // …folded into inbox ITEMS, one per task (0109) — see shapeMessageGroup.
  // Every row here is already the signed-in user's, so the task uuid alone
  // identifies the item; `ts` is the newest message's, so news floats it up.
  const groups = new Map<string, MessageVM[]>()
  P.messages.forEach((m) => {
    const g = groups.get(m.issueUuid)
    if (g) g.push(m)
    else groups.set(m.issueUuid, [m])
  })
  P.messageGroups = [...groups.entries()]
    .map(([issueUuid, newestFirst]) => shapeMessageGroup(issueUuid, newestFirst))
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))
  // the badge counts ITEMS, matching what the list shows — a snoozed item is
  // out of sight and out of the count until it returns
  P.unreadMessages = P.messageGroups.reduce((n, g) => n + (g.read || g.snoozed ? 0 : 1), 0)
  P.readMessageCount =
    hiddenReadMessages +
    P.messages.filter((message) => message.read && message.snoozedUntil === null).length
  // Mark all as read and Remove all read also reach rows the snapshot never
  // examined, so they stay available while such rows may exist
  P.canMarkAllRead = P.unreadMessages > 0 || unexaminedUnread
  P.canRemoveRead = P.readMessageCount > 0 || unexaminedRead

  P.CURRENT_USER = CURRENT_USER

  // Gravatar keys on a SHA-256 of the address and crypto.subtle is async,
  // while <Avatar> renders synchronously on every card and row. Hash the
  // roster once here and emit again when the map grows, so the component only
  // ever reads finished hashes; until then people show their initials. Skipped
  // entirely when the organization has the lookup switched off — that setting
  // is about requests this browser makes, so it gates the hashing too.
  if (P.org.gravatarAvatars) {
    void primeGravatar(P.users.map((u) => u.email)).then((grew) => {
      if (grew) emit()
    })
  }
  // Uploaded pictures prepare shared decoded sources after minting access.
  // One difference matters: a Gravatar URL is built at RENDER time from the
  // hash map, so a bare emit() is enough for it, while a prepared portrait is
  // baked into this snapshot — so fresh mints have to land through a REBUILD
  // or the freshly-minted URL sits in the cache unread. The second pass finds
  // nothing left to mint and stops there. Only avatars pre-mint: attachment
  // URLs are minted on demand (attachmentUrl), because only the open issue's
  // inline images ever render eagerly — avatars render by the dozen per board.
  const needAvatars = P.users
    .filter((u) => u.avatarPath && avatarSources.needsRefresh(`avatar:${u.id}:${u.avatarPath}`))
    .map((u) => ({ kind: 'avatar' as const, id: u.id }))
  if (P.users.some((u) => u.avatarPath)) startMintSweep()
  if (needAvatars.length) {
    void primeMint(needAvatars).then((grew) => {
      if (grew) {
        rebuild()
        emit()
      }
    })
  }
}

/* --- email addresses ------------------------------------------------------
   One rule, used by every write: trimmed and lowercased, empty means absent.
   The server checks lowercase + per-org uniqueness; anything else is a
   refusal from the mutation. */
function normalizeEmail(v: unknown): string | null {
  const e = String(v == null ? '' : v)
    .trim()
    .toLowerCase()
  return e || null
}

/** Same shape as the only address check the server has (the invite regex):
    something, an @, something, a dot, something — no whitespace anywhere.
    Deliberately loose; the address is proved by someone signing in with it,
    not by a pattern. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/* --- sub-issue remaining rollup (0066) — the optimistic mirror ------------ */
function clearParentRemaining(parentKey: string | null | undefined) {
  const pUuid = parentKey ? keyToUuid.get(parentKey) : null
  const pRow = pUuid ? rows.issues.get(pUuid) : null
  if (pRow && (pRow.remaining_hours != null || pRow.review_at != null)) {
    pRow.remaining_hours = undefined
    pRow.remaining_set_at = undefined // the server stamp pairs the two (0072)
    pRow.review_at = undefined // a group has no review hand-off of its own
    pRow.updated_at = new Date().toISOString() // the server-side clear fires the touch too
  }
}

/* Every visible task under `it`, once each, at any depth. The seen set keeps
   a corrupt parent cycle from hanging the client. Subtasks outside this view
   are not in the snapshot, so they are never visited. */
function eachDescendant(it: IssueVM, visit: (child: IssueVM) => void) {
  const seen = new Set([it.id])
  const stack = [...it.children]
  while (stack.length) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const child = PLANNER.issueById[id]
    if (!child) continue
    visit(child)
    stack.push(...child.children)
  }
}

/* --- issue field mapping (app patch -> DB patch) ------------------------------ */
// Hard cap on issue titles, mirrored by the server check (0061) and the
// REST/MCP validators. Sliced by codepoint to match the server's char count —
// a plain .slice can split a surrogate pair and the server rejects the half.
export const TITLE_MAX = 80
const clampTitle = (t: unknown) => [...String(t ?? '').trim()].slice(0, TITLE_MAX).join('')

// Same cap, same reason, for a person's name (0116) and every other name the
// server caps (convex/lib/textLimits.ts NAME_MAX).
export { NAME_MAX }

/* The app-side patch: camelCase fields, week INDEXES for dates, null (or ''
   for remaining) meaning clear — what every issue-editing surface hands
   updateIssue/addIssue. Status/priority stay derived from the schema row so
   a widened enum needs no edit here. */
/** Access about to be removed: a person's or a team's grant on one project
    (project settings), a member leaving a team, or a team being deleted
    (Team settings). */
export type AccessRemoval =
  | { kind: 'userGrant'; projectId: string; userId: string }
  | { kind: 'teamGrant'; projectId: string; teamId: string }
  | { kind: 'teamMember'; teamId: string; userId: string }
  | { kind: 'deleteTeam'; teamId: string }

/* The projects as `uid` would have them after `change`, for levelOnProject's
   lookup. A project grant changes that project for everyone; a member leaving
   loses every grant of the team, and a deleted team's grants go for everyone. */
function projectsAfter(change: AccessRemoval) {
  const now = (id: string) => PLANNER.project(id)
  if (change.kind === 'userGrant' || change.kind === 'teamGrant') {
    const p = PLANNER.project(change.projectId)
    const changed =
      p &&
      (change.kind === 'userGrant'
        ? { ...p, access: omitKey(p.access, change.userId) }
        : { ...p, teamAccess: omitKey(p.teamAccess, change.teamId) })
    const after = (id: string) => (id === change.projectId ? changed : now(id))
    return (_uid: string) => after
  }
  const withoutTeam = (id: string) => {
    const p = now(id)
    return p?.teamAccess?.[change.teamId]
      ? { ...p, teamAccess: omitKey(p.teamAccess, change.teamId) }
      : p
  }
  if (change.kind === 'deleteTeam') return (_uid: string) => withoutTeam
  return (uid: string) => (uid === change.userId ? withoutTeam : now)
}
/* A person's level on a project once `change` has applied. */
function levelAfter(change: AccessRemoval) {
  const after = projectsAfter(change)
  return (uid: string, projectId: string) => {
    const projects = after(uid)
    return levelOnProject(projects(projectId), uid, projects)
  }
}
/* The people whose access `change` reduces. */
function peopleLosing(change: AccessRemoval): Set<string> {
  if (change.kind === 'userGrant' || change.kind === 'teamMember') return new Set([change.userId])
  return new Set(PLANNER.users.filter((u) => u.teams.includes(change.teamId)).map((u) => u.id))
}
/* Where Keep as Viewer puts the Viewer grant that keeps `task` in sight: the
   project whose grant is removed, or the project the team shared that showed
   the task (the task's own sub-project first, then its parent). */
function keptOn(change: AccessRemoval, task: IssueVM): string {
  if (change.kind === 'userGrant' || change.kind === 'teamGrant') return change.projectId
  const p = PLANNER.project(task.project)
  return p?.parent && !p.teamAccess?.[change.teamId] ? p.parent : task.project
}
/* The direct grant rows on a project, without the lead (projects.lead_id). */
function grantsOn(projectId: string): Record<string, GrantLevel> {
  const access: Record<string, GrantLevel> = {}
  rows.access.forEach((a) => {
    if (a.project_id === projectId) access[a.profile_id] = a.level
  })
  return access
}
/* Removes a person's or a team's grant on one project, or a member from a
   team, in one server write that settles the tasks it hides by `choice`
   (projects.removeAccess, teams.removeMember), and paints the outcome at
   once; a refusal re-adopts the server's rows. With nobody losing sight of a
   task, the access just goes. Resolves whether the server accepted it. */
function removeAtOnce(
  change: Extract<AccessRemoval, { kind: 'userGrant' | 'teamGrant' | 'teamMember' }>,
  choice: { keep: true } | { to: string | null },
  items: Holder[],
  stays: string,
): Promise<boolean> {
  const orgId =
    change.kind === 'teamMember'
      ? rows.teams.get(change.teamId)?.org_id
      : rows.projects.get(change.projectId)?.org_id
  if (!orgId) return Promise.resolve(false)
  const people = [...new Set(items.map((i) => i.uid))]
  const held =
    'keep' in choice
      ? people.length > 0
        ? ('keep_as_viewer' as const)
        : ('leave' as const)
      : items.length > 0
        ? { reassign_to: choice.to }
        : ('leave' as const)
  const level = levelAfter(change)
  if (typeof held === 'object') {
    for (const i of items) {
      const row = rows.issues.get(i.task.uuid)
      if (row) {
        applyIssuePatchToRow(
          row,
          i.role === 'assignee' ? { assignee: held.reassign_to } : { reviewer: held.reassign_to },
        )
      }
    }
  }
  if (change.kind === 'userGrant') {
    rows.access = rows.access.filter(
      (a) => !(a.project_id === change.projectId && a.profile_id === change.userId),
    )
  } else if (change.kind === 'teamGrant') {
    rows.teamAccess = rows.teamAccess.filter(
      (a) => !(a.project_id === change.projectId && a.team_id === change.teamId),
    )
  } else {
    rows.teamMembers = rows.teamMembers.filter(
      (m) => !(m.team_id === change.teamId && m.profile_id === change.userId),
    )
  }
  if (held === 'keep_as_viewer') {
    // the server's Viewer grants: each project that showed a listed task
    const kept = new Set<string>()
    for (const i of items) {
      const pid = keptOn(change, i.task)
      if (kept.has(`${i.uid}:${pid}`) || level(i.uid, pid)) continue
      kept.add(`${i.uid}:${pid}`)
      rows.access.push({ project_id: pid, profile_id: i.uid, level: 'viewer' })
    }
  }
  rebuild()
  emit()
  const op =
    change.kind === 'teamMember'
      ? write(api.teams.removeMember, {
          org_id: orgId,
          team_id: change.teamId,
          profile_id: change.userId,
          on_held_tasks: held,
        })
      : write(api.projects.removeAccess, {
          org_id: orgId,
          id: change.projectId,
          ...(change.kind === 'userGrant'
            ? { user_id: change.userId }
            : { team_id: change.teamId }),
          on_held_tasks: held,
        })
  return new Promise<boolean>((resolve) =>
    run(
      op,
      () => resolve(true),
      undefined,
      (error) => {
        // only a refused reassignment or Viewer grant (model/projectAccess.ts
        // HELD_TASKS_REFUSED) blames the tasks; a refused removal, a billing
        // pause or a lost connection says so itself
        const settling = errData(error).reason === 'held_tasks'
        if (settling && typeof held === 'object') {
          toast(`${stays}, because not every task could be reassigned.`, 'error')
        } else if (settling && held === 'keep_as_viewer' && change.kind === 'teamMember') {
          toast(`${stays}, because not every Viewer grant could be saved.`, 'error')
        } else toastWriteError(error)
        resolve(false)
      },
    ),
  )
}

/* The individual grants a new project is stored with: the request's own,
   and on a top-level project the one the server gives its creator by
   itself (convex/lib/projectGrants.ts creatorGrant). */
function newProjectGrants(
  p: Pick<NewProjectInput, 'type' | 'access'>,
  creator: string,
  lead: string,
): Record<string, GrantLevel> {
  const grants: Record<string, GrantLevel> = {}
  for (const [uid, level] of Object.entries(p.access || {})) {
    if (level === 'user' || level === 'viewer') grants[uid] = level
  }
  if (p.type === 'meta' && creator) {
    const own = p.access?.[creator]
    const mine = creatorGrant({
      admin: PLANNER.isAdmin(creator),
      creator,
      lead,
      own: own === 'lead' ? undefined : own,
    })
    if (mine) grants[creator] = mine
    else delete grants[creator]
  }
  return grants
}
function omitKey<T>(map: Record<string, T> | undefined, key: string): Record<string, T> {
  const next = { ...(map || {}) }
  delete next[key]
  return next
}
/** A team named in a sentence: "Design team", or "Design team" for a team
    already called that; "team" when it is unknown. */
export function teamNoun(name: string | null | undefined): string {
  if (!name) return 'team'
  return /\bteam$/i.test(name.trim()) ? name : `${name} team`
}
/** "A", "A and B", or "A, B and 2 others", with `others` naming the rest. */
export function andList(
  words: string[],
  others = (n: number) => `${n} other${n === 1 ? '' : 's'}`,
): string {
  if (words.length <= 2) return words.join(' and ')
  if (words.length === 3) return `${words[0]}, ${words[1]} and ${words[2]}`
  return `${words[0]}, ${words[1]} and ${others(words.length - 2)}`
}

/** Someone working on a task, as a parent change or a move checks them. */
export type Holder = { uid: string; task: IssueVM; role: 'assignee' | 'reviewer' }
/** A subtask the Archive or delete window lists for a delete (P.deletePlan). */
export type DeleteRow = { task: IssueVM; depth: number; deletable: boolean }
/** What a removal would do to work: see P.accessRemoval. */
export type RemovalEffect = { people: string[]; items: Holder[]; projects: string[] }
/** A holder who would lose access to `project` (edit access when `edit`). */
export type AccessBlocker = Holder & { project: ProjectVM; edit: boolean }

export type IssuePatch = Partial<{
  title: string
  description: string | null
  status: Row<'issues'>['status']
  priority: Row<'issues'>['priority']
  assignee: string | null
  reviewer: string | null
  parent: string | null
  start: number | null
  end: number | null
  due: string | null
  remaining: number | string | null
  paused: boolean
}>
/* …and the new-issue input — the same fields plus the target project. */
export type NewIssueInput = IssuePatch & { project: string }

/* Wire arg mapper: the app patch's snake_case column form, exactly the
   patch shape issues.update validates (derived below, so a validator change
   is a type error here) — key PRESENT means "set this field", null is the
   wire form of a clear. Never emits a server-owned column (num, org_id,
   updated_at, done_at, remaining_set_at, archived_at have no slot in the
   validator either). */
type IssueWirePatch = FunctionArgs<typeof api.issues.update>['patch']
function mapIssuePatch(patch: IssuePatch): IssueWirePatch {
  const db: IssueWirePatch = {}
  if ('title' in patch) db.title = clampTitle(patch.title)
  if ('description' in patch) db.description = patch.description || '' // required column; drawer commits null to clear
  if ('status' in patch) db.status = patch.status
  if ('priority' in patch) db.priority = patch.priority
  if ('assignee' in patch) db.assignee_id = patch.assignee || null
  if ('reviewer' in patch) db.reviewer_id = patch.reviewer || null
  if ('parent' in patch) db.parent_id = patch.parent ? keyToUuid.get(patch.parent) || null : null
  if ('start' in patch) db.start_week = patch.start != null ? weekToISO(patch.start) : null
  if ('end' in patch) db.end_week = patch.end != null ? weekToISO(patch.end) : null
  if ('due' in patch) db.due_date = patch.due || null
  if ('remaining' in patch)
    db.remaining_hours =
      patch.remaining != null && patch.remaining !== '' ? Number(patch.remaining) : null
  if ('paused' in patch) db.paused = !!patch.paused
  return db
}
/* The remaining time a task in this sub-project gets on entering Review: its
   own review_hours, else its parent project's, else the default. The same
   resolver the server's reviewHoursFor uses, so the paint never flickers. */
function reviewHoursForProject(projectId: string): number {
  const p = rows.projects.get(projectId)
  const parent = p?.parent_id ? rows.projects.get(p.parent_id) : undefined
  return resolveReviewHours(p?.review_hours, parent?.review_hours)
}

/* Optimistic mirror of the server's touch + remaining-stamp rule (0072).
   The wire carries null-to-clear; the STORED row carries absence as
   undefined (the snapshot's own shape, header line 54), so nulls translate
   on the way in. */
function applyIssuePatchToRow(row: Row<'issues'>, patch: IssuePatch) {
  const db = mapIssuePatch(patch)
  const prevStatus = row.status
  const before = { status: row.status, reviewer_id: row.reviewer_id, review_at: row.review_at }
  const oldRem = row.remaining_hours == null ? null : Number(row.remaining_hours)
  const newRem =
    !('remaining' in patch) || db.remaining_hours == null ? null : Number(db.remaining_hours)
  const remChanged = 'remaining' in patch && oldRem !== newRem
  Object.entries(db).forEach(([k, v]) => {
    ;(row as Record<string, unknown>)[k] = v === null ? undefined : v
  })
  // mirror the server's pause rule: a move into Done or Backlog resumes
  if (db.status === 'done' || db.status === 'backlog') row.paused = false
  row.updated_at = new Date().toISOString() // mirror the server's touch
  // mirror doneStampUpdate (0071): a move into Done stamps now, out clears
  if (db.status !== undefined && db.status !== prevStatus)
    row.done_at = db.status === 'done' ? row.updated_at : undefined
  if (remChanged) row.remaining_set_at = newRem != null ? row.updated_at : undefined
  // mirror updateIssueCore's review-time stamp: entering Review sets the
  // project's review time with a fresh stamp unless the same patch states
  // hours (explicit hours win). Groups never get here: updateIssue deletes
  // status from a group's paint patch. The wire patch is never touched.
  if (db.status === 'review' && prevStatus !== 'review' && db.remaining_hours == null) {
    row.remaining_hours = reviewHoursForProject(row.project_id)
    row.remaining_set_at = row.updated_at
  }
  // the server's review hand-off stamp, by the same shared rule
  row.review_at = reviewStamp(before, row, row.updated_at)
}

/* --- app-side inputs ---------------------------------------------------------
   The camelCase shapes the remaining mutators take (issue ones sit with
   mapIssuePatch above). Enum-ish fields derive from the schema rows, so a
   widened column needs no edit here; null (or '') means clear. */
/* grant levels + the 'lead' pseudo-entry the access maps surface */
export type AccessLevel = Row<'project_access'>['level'] | 'lead'
/** A level a grant row stores; the lead is projects.lead_id instead. */
type GrantLevel = Row<'project_access'>['level']
export type TeamAccessLevel = Row<'project_team_access'>['level']
export type NewProjectInput = {
  type: Row<'projects'>['type']
  parent?: string
  key: string
  name: string
  icon?: string | null
  iconColor?: string | null
  lead?: string | null
  description?: string
  /** Individual grants. null names no grant, which for the creator also
      declines the grant the server gives a creator by itself
      (convex/lib/projectGrants.ts creatorGrant). */
  access?: Record<string, AccessLevel | null>
  teamAccess?: Record<string, TeamAccessLevel>
}
/** A project and the project that owns it, for labels such as "Website,
    Design". owner is null for a project shown alone (see P.projectPlace). */
export type ProjectPlace = { project: ProjectVM; owner: ProjectVM | null }
export type ProjectPatch = Partial<{
  name: string
  icon: string | null
  iconColor: string | null
  lead: string | null
  description: string | null
  key: string
  trackDelay: boolean
  reviewHours: number | null // null inherits; the caller passes a rounded value
  access: Record<string, AccessLevel>
  teamAccess: Record<string, TeamAccessLevel>
}>
/* dateFormat / weekOneRule derive from the WIRE validator: the stored column
   is a plain string, the update validator is the narrowed union.
   projectCreators follows the same validator. */
export type OrgPatch = Partial<{
  name: string
  dateFormat: FunctionArgs<typeof api.orgs.update>['patch']['date_format']
  weekStart: number
  weekOneRule: FunctionArgs<typeof api.orgs.update>['patch']['week_one_rule']
  defaultPlannableHours: number | string
  maxAttachmentMb: number | string
  projectCreators: FunctionArgs<typeof api.orgs.update>['patch']['project_creators']
  gravatarAvatars: boolean
}>
export type TeamPatch = Partial<{
  name: string
  icon: string | null
  iconColor: string | null
  staleDays: number | string
  archiveDays: number | string
  trackDelayDefault: boolean
}>
export type NewUserInput = {
  name?: string
  email?: string | null
  kind?: Row<'profiles'>['kind']
  orgRole?: Row<'profiles'>['org_role']
  teams?: string[]
}
export type UserPatch = Partial<{
  name: string
  email: string | null
  orgRole: Row<'profiles'>['org_role']
  active: boolean
  teams: string[]
  plannableHours: number | string
  canCreateProjects: boolean
}>
/** What a new personal token may do and the instant it stops working (UTC
    ISO 8601). Both are fixed when it is created; no expiresAt means never. */
export type McpTokenChoice = {
  access: FunctionArgs<typeof api.tokens.createMcpToken>['access']
  expiresAt?: string
}
/** The credential tables an admin can revoke from on API access. */
export type ApiCredentialTable = FunctionArgs<typeof api.apiAccess.revoke>['table']

/* The toolbar filter row's state — one shape for every view that renders it
   and for P.passesFilters, the one predicate they share. `mine` and
   `assignees` both match the task's effective owner (IssueVM.owner): the
   reviewer while it waits In Review, else the assignee. */
export type IssueFilters = {
  mine: boolean
  assignees: string[]
  priority: string | null
  stale: boolean
  focus: boolean
  search: string
}

/* --- the public store --------------------------------------------------------- */
export const PLANNER = {
  roadmapContext,
  get roadmapUndo() {
    return {
      count: roadmapVisit?.count ?? 0,
      busy: (roadmapVisit?.pending ?? 0) > 0 || inFlight > 0,
      disabled: !roadmapVisit || roadmapVisit.disabled,
    }
  },
  batchRoadmapChanges: (change: () => void) => {
    if (roadmapBatch || !roadmapVisit || roadmapVisit.disabled || roadmapDetailOpen) {
      change()
      return
    }
    roadmapBatch = []
    try {
      change()
    } finally {
      const operations = roadmapBatch
      roadmapBatch = null
      submitRoadmapChanges(operations)
    }
  },
  undoRoadmap: (all = false) => {
    expireRoadmapHistory()
    const visit = roadmapVisit
    if (!visit || visit.disabled || visit.pending || inFlight || !visit.count) return
    if (refusePausedEdit()) return
    visit.pending++
    run(
      write(api.roadmap.undo, { session_id: visit.id, all })
        .then((result) => {
          if (roadmapVisit === visit && !visit.disabled) visit.count = result.count
          toast(all ? 'Roadmap changes reverted' : 'Roadmap change undone', 'success')
        })
        .catch((error) => {
          // A conflicting history remains unavailable until a fresh visit. The
          // server refused the entire undo, preserving all current work.
          if (['conflict', 'forbidden', 'not_found'].includes(errData(error).code))
            clearRoadmapHistory(visit)
          throw error
        }),
      undefined,
      () => {
        visit.pending--
        emit()
      },
      (error) => {
        const { code, message: detail } = errData(error)
        if (code === 'paused') toastPaused()
        else
          toast(
            detail ? `Couldn't undo: ${detail}. No changes reverted.` : "Couldn't undo. Try again.",
          )
      },
    )
    emit()
  },
  /* timeline + formatting (same names as the prototype) */
  TIMELINE_START,
  TODAY_WEEK,
  TODAY_POS,
  TODAY_ISO,
  MONTHS,
  TITLE_MAX,
  NAME_MAX,
  weekToDate,
  fmtDate,
  weekLabel,
  fmtRange,
  isoToDate,
  fmtISO,
  isoFromDate,
  isoToWeek,
  nearestWeek,
  DEFAULT_WIN,
  sanitizeWin,
  resolveWin,
  shiftWin,
  endpointWeek,
  winLabel,
  sameWin,
  clampBarDrag,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  setDateFormat,
  fmtFull,
  fmtFullWith,
  WEEKDAYS,
  WEEK_ONE_RULES,
  weekNumberOf,
  weekNumLabel,
  weekStartOf,
  DELAY_COLORS,
  DELAY_NEUTRAL,
  DELAY_LABELS,
  MILESTONE_COLOR,
  MESSAGE_RETENTION_DAYS,
  DEFAULT_MESSAGE_RETENTION_DAYS,

  /* data (assigned by rebuild(); the seeds carry the view-model types so
     every read and every callback over them infers) */
  gridEpoch: 0, // bumped whenever TIMELINE_START re-anchors (see rebuild)
  users: [] as UserVM[],
  CURRENT_USER: '',
  org: {} as OrgVM, // populated by the first rebuild, before `loaded` flips
  homeOrg: '',
  orgs: [] as OrgRefVM[],
  myProfileIds: [] as string[],
  teams: [] as TeamVM[],
  projects: [] as ProjectVM[],
  // the archived ones (0106) — kept apart from `projects` on purpose, so that
  // everything which asks P.project(id) treats an archived project as gone
  archivedProjects: [] as ArchivedProjectVM[],
  // project id → "#num" for projects sharing a name with another one shown
  // alongside it (duplicateNameTags); absent for every unique name
  projectTags: new Map<string, string>(),
  STATUSES,
  PRIORITIES,
  issues: [] as IssueVM[],
  issueById: {} as Record<string, IssueVM>,
  milestones: [] as MilestoneVM[],
  activity: [] as ActivityVM[],
  labels: [] as LabelVM[],
  labelById: {} as Record<string, LabelVM>,
  comments: [] as CommentVM[],
  commentsLoaded: false, // the watched issue's thread (watchComments)
  // Team sync (watchTeamSync): issue UUID → ms of its latest comment, or
  // null when it has none, for the open, visible tasks the last answer
  // covered; a task with no entry is not known yet
  lastComments: new Map<string, number | null>(),
  messages: [] as MessageVM[],
  messageGroups: [] as MessageGroupVM[],
  unreadMessages: 0, // own inbox (0074), folded per task (0088)
  readMessageCount: 0, // includes read notifications beyond the displayed snapshot
  // whether the Inbox's Mark all as read and Remove all read have rows to act on
  canMarkAllRead: false,
  canRemoveRead: false,
  loaded: false,

  project: (id: string | null | undefined): ProjectVM | undefined =>
    findProject(PLANNER.projects, id),
  /** "#4" when another project shown alongside this one has the same name. */
  projectTag: (id: string | null | undefined): string | null =>
    (id && PLANNER.projectTags.get(id)) || null,
  /** A project's name for plain-text places such as select options, with its
      number when the name is shared ("Test #4"). */
  projectLabel: (p: { id: string; name: string }): string => {
    const tag = PLANNER.projectTag(p.id)
    return tag ? `${p.name} ${tag}` : p.name
  },
  /** projectLabel for a project id; '' when the project is not loaded. */
  projectLabelOf: (id: string | null | undefined): string => {
    const p = PLANNER.project(id)
    return p ? PLANNER.projectLabel(p) : ''
  },
  /** Where something lives: project `id`, after its owning project when
      `withOwner` and the two differ. Render it with <ProjectName {...place} />
      or as text with placeLabel. Null when the project is not loaded. */
  projectPlace: (id: string | null | undefined, withOwner = true): ProjectPlace | null => {
    const project = PLANNER.project(id)
    if (!project) return null
    const owner = withOwner ? PLANNER.metaOf(id) : null
    return { project, owner: owner && owner.id !== project.id ? owner : null }
  },
  /** A place as plain text, such as "Website, Design #2". */
  placeLabel: ({ project, owner }: ProjectPlace): string =>
    owner
      ? `${PLANNER.projectLabel(owner)}, ${PLANNER.projectLabel(project)}`
      : PLANNER.projectLabel(project),
  user: (id: string | null | undefined): UserVM | undefined => findUser(PLANNER.users, id),
  teamById: (id: string | null | undefined): TeamVM | undefined => findTeam(PLANNER.teams, id),
  metaOf: (pid: string | null | undefined): ProjectVM | null => {
    const p = PLANNER.project(pid)
    if (!p) return null
    return p.type === 'meta' ? p : PLANNER.project(p.parent) || null
  },
  /* The id of the top-level project a project belongs to, as the server
     reads it (its parent, or itself), or undefined for one outside this
     view. A subtask stays in its parent's top-level project. */
  topLevelOf: (pid: string | null | undefined): string | undefined => {
    const p = PLANNER.project(pid)
    return p ? p.parent || p.id : undefined
  },
  isAdmin: (uid?: string) => {
    const u = PLANNER.user(uid || CURRENT_USER)
    return !!(u && u.orgRole === 'admin')
  },
  /* org admins lead every team — of THEIR OWN organization (0081). Being an
     admin at home says nothing about a team that shared a project with me,
     so the caller is resolved to the profile they hold in the team's org
     (actorIn); with an explicit uid, that person must live there too. */
  isTeamLeader: (teamId: string, uid?: string) => {
    const t = PLANNER.teams.find((x) => x.id === teamId)
    const u = actorIn(t ? t.org : '', uid)
    if (!u) return false
    // leadership is a WRITE right and never reaches a viewer (0102). The
    // database refuses to record one, so this only mirrors that refusal.
    if (u.orgRole !== 'admin' && u.orgRole !== 'user') return false
    if (u.orgRole === 'admin') return true
    // Agents never lead a team; the server ignores old agent leader rows.
    return !u.isAgent && u.teamLeads.includes(teamId)
  },
  /* Effective rights combine this project's explicit grants with inherited
     parent grants. Organization viewers remain read-only. */
  levelOn: (pid: string, uid?: string) => visibleLevelOnProject(PLANNER.project(pid), uid),
  /* may this user WRITE on this project — the one question every create/edit
     affordance asks. `viewer` and no level at all both answer no. */
  canWrite: (pid: string, uid?: string) => {
    const l = PLANNER.levelOn(pid, uid)
    return l === 'lead' || l === 'user'
  },
  canSee: (pid: string, uid?: string) => PLANNER.levelOn(pid, uid) !== null,
  /* Would this user (me by default) see a top-level project created in the
     home organization with this lead and access? The New project dialog asks
     before saving. The draft goes through the same level rules P.canSee
     applies once addProject has painted the project, so the dialog's warning
     and the outcome agree: org admins, the lead, an individual grant at any
     level or a share with one of the user's teams can see it. */
  seesNewProject: (
    draft: Pick<NewProjectInput, 'lead' | 'access' | 'teamAccess'>,
    uid?: string,
  ): boolean => {
    // addProject makes the creator the lead when none is named, and the
    // server may give the creator a grant by itself
    const creator = profileIn(HOME_ORG)
    const lead = draft.lead || creator || undefined
    const access: Record<string, string> = newProjectGrants(
      { type: 'meta', access: draft.access },
      creator,
      lead || '',
    )
    if (lead) access[lead] = 'lead'
    const teamAccess = draft.teamAccess || {}
    return (
      levelOnProject({ org: HOME_ORG, parent: undefined, lead, access, teamAccess }, uid) !== null
    )
  },
  /* Milestones sit on the meta project (addMilestone folds a sub-project up
     to it), so adding one needs edit access there. A sub-project grant alone
     shows its parent read-only. */
  canAddMilestone: (pid: string, uid?: string) => {
    const meta = PLANNER.metaOf(pid)
    return !!meta && PLANNER.canWrite(meta.id, uid)
  },
  /** Project leads and organization admins control project permissions. */
  canManageOwnProjectAccess: (pid: string, uid?: string): boolean => {
    const p = PLANNER.project(pid)
    const u = p ? actorIn(p.org, uid) : null
    return !!(u?.active && levelOnProject(p, uid) === 'lead')
  },
  canManageProjectUsers: (pid: string, uid?: string): boolean =>
    PLANNER.canManageOwnProjectAccess(pid, uid),
  canManageProjectTeams: (pid: string, uid?: string): boolean =>
    PLANNER.canManageProjectUsers(pid, uid),
  canManageProjectUser: (pid: string, targetId: string, uid?: string): boolean => {
    const m = PLANNER.metaOf(pid)
    const u = m ? actorIn(m.org, uid) : null
    const target = PLANNER.user(targetId)
    return !!(
      m &&
      u &&
      target?.org === m.org &&
      PLANNER.canManageProjectUsers(pid, uid) &&
      (targetId !== u.id || PLANNER.canManageOwnProjectAccess(pid, uid))
    )
  },
  /* Navigation is flat: every project this user can see, in one list (0078
     retired the per-workspace silo and its switcher). Since 0081 the list is
     also BLENDED across organizations — home-org projects first, then each
     foreign org's granted ones, so the sidebar can group them under a header
     with the owning organization's name. */
  visibleProjects: (uid?: string) =>
    PLANNER.projects
      .filter((p) => p.type === 'meta' && PLANNER.canSee(p.id, uid))
      .sort((a, b) => {
        const ah = a.org === PLANNER.homeOrg ? 0 : 1
        const bh = b.org === PLANNER.homeOrg ? 0 : 1
        if (ah !== bh) return ah - bh
        if (a.org !== b.org) {
          const an = PLANNER.orgs.find((o) => o.id === a.org)?.name || ''
          const bn = PLANNER.orgs.find((o) => o.id === b.org)?.name || ''
          return an.localeCompare(bn)
        }
        return 0 // inside one org the projects keep their sort_order
      }),

  ALL_SCOPE,
  MINE_SCOPE,
  isAllScope: (id: string | null | undefined) => id === ALL_SCOPE,
  isMineScope: (id: string | null | undefined) => id === MINE_SCOPE,
  /* Most rules that used to ask `isAllScope` mean THIS: "the scope names no
     projects row". `P.project(id)` is undefined for both sentinels, so there
     is no lead, no settings page, no archive and nowhere to create. The two
     narrower questions stay for the handful of rules that mean one specific
     sentinel (which glyph, which empty-state copy, whether the scope already
     holds a given task). */
  isWideScope: (id: string | null | undefined) => id === ALL_SCOPE || id === MINE_SCOPE,
  /* Shared scope for Overview, Board and Roadmap; null means it disappeared.
     subIds names task-holding sub-projects. Groups are sub-projects within a
     project, top-level projects in wide scopes, or the single selected sub.
     Milestones follow the owning top-level projects.
     wide covers both All projects and My view; mine narrows tasks to me.
     Rollups use the only predicate but ignore transient toolbar filters. */
  scopeInfo: (scopeId: string) => {
    if (scopeId === ALL_SCOPE || scopeId === MINE_SCOPE) {
      const mine = scopeId === MINE_SCOPE
      const metas = PLANNER.visibleProjects()
      const metaIds = new Set(metas.map((m) => m.id))
      const groups = metas.map((m) => ({
        proj: m,
        subIds: (m.children || []).filter((id) => PLANNER.canSee(id)),
      }))
      const subIds = groups.flatMap((g) => g.subIds)
      return {
        wide: true,
        mine,
        only: mine ? PLANNER.isMine : null,
        id: scopeId,
        name: mine ? 'My view' : 'All projects',
        proj: null as ProjectVM | null,
        isMeta: false,
        metas,
        groups,
        subIds,
        subIdSet: new Set(subIds),
        milestones: PLANNER.milestones.filter((x) => metaIds.has(x.project)),
      }
    }
    const p = PLANNER.project(scopeId)
    if (!p) return null
    const isMeta = p.type === 'meta'
    const meta = isMeta ? p : PLANNER.project(p.parent)
    const groups = isMeta
      ? (p.children || [])
          .map((id) => PLANNER.project(id))
          .filter((sp): sp is ProjectVM => !!sp && PLANNER.canSee(sp.id))
          .map((sp) => ({ proj: sp, subIds: [sp.id] }))
      : [{ proj: p, subIds: [p.id] }]
    const subIds = groups.flatMap((g) => g.subIds)
    return {
      wide: false,
      mine: false,
      only: null,
      id: p.id,
      name: p.name,
      proj: p as ProjectVM | null,
      isMeta,
      metas: meta ? [meta] : [],
      groups,
      subIds,
      subIdSet: new Set(subIds),
      milestones: meta ? PLANNER.milestones.filter((x) => x.project === meta.id) : [],
    }
  },
  /* The issues a scope holds — its sub-projects', narrowed by the scope's own
     `only` predicate. The three views each derived this by hand off
     `subIdSet`, which is exactly the line "My view" had to reach. Typed on
     the two fields it reads, so any scopeInfo() result passes. */
  scopedIssues: (info: { subIdSet: Set<string>; only: ((it: IssueVM) => boolean) | null }) =>
    PLANNER.issues.filter((i) => info.subIdSet.has(i.project) && (!info.only || info.only(i))),
  /* completion over an arbitrary set of sub-projects — the scope-shaped
     counterpart of projectProgress (one sub-project) and programProgress (one
     project), which both remain for callers that name a single row. `only`
     narrows it to the scope's own issues (My view counts mine, not everyone's). */
  progressIn: (subIds: string[], only?: ((it: IssueVM) => boolean) | null) => {
    const set = new Set(subIds)
    const list = PLANNER.issues.filter(
      (i) => set.has(i.project) && !PLANNER.isGroup(i) && (!only || only(i)),
    )
    const total = list.length
    const done = list.filter((i) => i.status === 'done').length
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  },
  /* summed remaining hours of the not-done issues in a set of sub-projects —
     own hours only, the same rule as projectRemaining (0066) */
  remainingIn: (subIds: string[], only?: ((it: IssueVM) => boolean) | null) => {
    const set = new Set(subIds)
    const sum = PLANNER.issues
      .filter(
        (i) =>
          set.has(i.project) && !PLANNER.isGroup(i) && i.status !== 'done' && (!only || only(i)),
      )
      .reduce((s, i) => s + (i.remaining || 0), 0)
    return Math.round(sum * 10) / 10
  },
  /* The organization a project (or sub-project) belongs to. */
  orgOf: (projectId: string) => {
    const p = PLANNER.project(projectId)
    return p ? p.org : ''
  },
  /* Rosters (0081). `users` is BLENDED — it carries every profile the
     snapshot hands back, from every organization I hold a seat in — so any
     picker that writes a profile id into a row must narrow to that row's
     organization first: a foreign assignee/lead/grant is rejected by the
     same-org fences, and a foreign @mention would render but never notify. */
  usersIn: (orgId: string) => PLANNER.users.filter((u) => u.org === orgId),
  /* The active candidate roster for a project = its owning organization's
     profiles minus anyone switched off. This broad list deliberately does
     not ask whether they already have project access: project settings uses
     it to grant that access. `usersIn` stays the whole roster because a name
     already on a task must keep rendering after the person is switched off. */
  usersFor: (projectId: string) =>
    PLANNER.usersIn(PLANNER.orgOf(projectId)).filter((u) => u.active),
  /* Profiles with access to a task's project. The assignee roster below
     further narrows this to people and agents who can hold work. */
  issueUsersFor: (projectId: string) =>
    PLANNER.usersIn(PLANNER.orgOf(projectId)).filter(
      (u) => PLANNER.levelOn(projectId, u.id) !== null,
    ),
  /* …and of those, the ones eligible for a project lead field. A viewer may
     be given a read grant, so they stay in `usersFor`, but can never lead.
     Task assignment requires project write access in `issueAssigneesFor`. */
  assigneesFor: (projectId: string) =>
    PLANNER.usersFor(projectId).filter((u) => u.orgRole !== 'viewer'),
  /* Active people and agents need effective Edit or Lead access to hold new
     work. Existing assignments still render through `user`; this list
     governs new choices only, for the reviewer as well as the assignee
     (the server applies the same rule to both). */
  issueAssigneesFor: (projectId: string) =>
    PLANNER.usersFor(projectId).filter(
      (u) =>
        (u.orgRole === 'admin' || u.orgRole === 'user' || u.orgRole === 'guest') &&
        PLANNER.canWrite(projectId, u.id),
    ),
  /* Whoever holds a subtask must also see every task above it: the parent
     carries its context. This checks the tasks above that this view holds;
     one outside it (a hidden parent) is left to the server, which refuses
     with the same rule. */
  /* The first task above `it` (its parent, then up) in a project the person
     cannot see, or null. A task outside this view is left to the server.
     `sees` replaces the current grants, for example with grants as they
     would be after a removal. */
  unseenAbove: (
    x: IssueVM | string,
    uid: string,
    sees = (projectId: string) => PLANNER.canSee(projectId, uid),
  ): IssueVM | null => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    const seen = new Set<string>()
    for (let up = it?.parent ? PLANNER.issueById[it.parent] : null; up; ) {
      if (seen.has(up.id)) break
      seen.add(up.id)
      if (!sees(up.project)) return up
      up = up.parent ? PLANNER.issueById[up.parent] : null
    }
    return null
  },
  seesTasksAbove: (x: IssueVM | string, uid: string): boolean => !PLANNER.unseenAbove(x, uid),
  /* The people who may be picked as this task's assignee or reviewer: Edit
     access on its project, and sight of every task above it. */
  taskAssigneesFor: (it: IssueVM) =>
    PLANNER.issueAssigneesFor(it.project).filter((u) => PLANNER.seesTasksAbove(it, u.id)),
  /* Who works on `it` (when `self`) and on its visible subtasks at any depth:
     each assignee, and each reviewer of a task without subtasks (a group's
     reviewer is dormant). A switched-off person holds no new work, as on the
     server. */
  holdersOf: (it: IssueVM, self: boolean): Holder[] => {
    const out: Holder[] = []
    const add = (task: IssueVM) => {
      for (const role of ['assignee', 'reviewer'] as const) {
        const uid = task[role]
        if (!uid || (role === 'reviewer' && PLANNER.isGroup(task))) continue
        if (PLANNER.user(uid)?.active) out.push({ uid, task, role })
      }
    }
    if (self) add(it)
    eachDescendant(it, add)
    return out
  },
  /* Who would lose sight of a task above their own if `it` got `parentKey`
     as its parent, with the first project they cannot see. */
  parentBlockers: (it: IssueVM, parentKey: string): AccessBlocker[] => {
    const parent = PLANNER.issueById[parentKey]
    if (!parent) return []
    const out: AccessBlocker[] = []
    for (const h of PLANNER.holdersOf(it, true)) {
      const unseen = PLANNER.canSee(parent.project, h.uid)
        ? PLANNER.unseenAbove(parent, h.uid)
        : parent
      const project = unseen && PLANNER.project(unseen.project)
      if (project) out.push({ ...h, project, edit: false })
    }
    return out
  },
  holdersSeeParent: (it: IssueVM, parentKey: string): boolean =>
    PLANNER.parentBlockers(it, parentKey).length === 0,
  /* What moving `it` to `projectId` does to its family, as the server does
     it. A move within the task's top-level project changes nothing else. A
     subtask moving to another one leaves its parent (`leavesParent`) unless
     it lands in the parent's top-level project. A hidden parent counts as
     being in the task's own top-level project, where every new link is. A
     move to another top-level project carries the subtasks outside it
     along. `carried` lists the visible ones, and `carriesSubtasks` also
     counts active ones hidden from this view. Archived subtasks are not in
     the view, so the Move window asks the server too
     (moveCarriesSubtasks). */
  moveFamily: (
    it: IssueVM,
    projectId: string,
  ): { leavesParent: boolean; carriesSubtasks: boolean; carried: IssueVM[] } => {
    const dst = PLANNER.topLevelOf(projectId)
    const crosses = PLANNER.topLevelOf(it.project) !== dst
    const parent = it.parent ? PLANNER.issueById[it.parent] : undefined
    const parentTop = PLANNER.topLevelOf(parent ? parent.project : it.project)
    const leavesParent = crosses && (!!it.parent || it.hasHiddenParent) && parentTop !== dst
    const carried: IssueVM[] = []
    if (crosses) {
      eachDescendant(it, (child) => {
        if (PLANNER.topLevelOf(child.project) !== dst) carried.push(child)
      })
    }
    return {
      leavesParent,
      carriesSubtasks: crosses && (carried.length > 0 || it.hasHiddenSubtasks),
      carried,
    }
  },
  /* Who would lose access if `it` moved to `projectId`. The assignee and
     leaf reviewer of the task and of each subtask it carries need edit
     access there, and the people on its other subtasks need sight of it, the
     same checks the server makes. */
  moveBlockers: (it: IssueVM, projectId: string): AccessBlocker[] => {
    const project = PLANNER.project(projectId)
    if (!project) return []
    // the tasks that move must be held there by their assignee and leaf
    // reviewer, switched off or not; people on the subtasks that stay only
    // need to see the task
    const movers = [it, ...PLANNER.moveFamily(it, projectId).carried]
    const moving = new Set(movers.map((task) => task.id))
    const own: Holder[] = []
    for (const task of movers) {
      if (task.assignee) own.push({ uid: task.assignee, task, role: 'assignee' })
      if (task.reviewer && !PLANNER.isGroup(task))
        own.push({ uid: task.reviewer, task, role: 'reviewer' })
    }
    return [
      ...own
        .map((h) => ({ ...h, project, edit: true }))
        .filter((b) => !PLANNER.canWrite(projectId, b.uid)),
      ...PLANNER.holdersOf(it, false)
        .filter((h) => !moving.has(h.task.id))
        .map((h) => ({ ...h, project, edit: false }))
        .filter((b) => !PLANNER.canSee(projectId, b.uid)),
    ]
  },
  /* What a removal would do to work: the active people who would lose sight
     of open tasks they are assigned to or reviewing, those tasks, and the
     projects where Keep as Viewer would give them Viewer access. Done tasks
     keep their history and are not listed. Computed against the grants as
     they would be, so another grant that still covers someone keeps them off
     the list. */
  accessRemoval: (change: AccessRemoval): RemovalEffect => {
    const level = levelAfter(change)
    const losing = peopleLosing(change)
    const items: Holder[] = []
    for (const task of PLANNER.issues) {
      const tp = PLANNER.project(task.project)
      if (!tp || task.status === 'done') continue
      for (const role of ['assignee', 'reviewer'] as const) {
        const uid = task[role]
        if (!uid || !losing.has(uid) || (role === 'reviewer' && PLANNER.isGroup(task))) continue
        if (!PLANNER.user(uid)?.active) continue
        if (levelOnProject(tp, uid) && !level(uid, tp.id)) items.push({ uid, task, role })
      }
    }
    return {
      people: [...new Set(items.map((i) => i.uid))],
      items,
      projects: [...new Set(items.map((i) => keptOn(change, i.task)))],
    }
  },
  /* Whether I can carry out either choice of the removal window: give every
     listed person Viewer access to each of `projects`, and edit every listed
     task. A team leader without that project authority removes a member
     straight away instead (see startRemoval). */
  canSettleRemoval: (removal: RemovalEffect): boolean =>
    removal.items.every((i) => PLANNER.canWrite(i.task.project)) &&
    removal.projects.every((pid) =>
      removal.people.every((uid) => PLANNER.canManageProjectUser(pid, uid)),
    ),
  /* Start a removal. Returns true when the removal window should ask first:
     someone would lose sight of their tasks and I can settle them. Otherwise
     the removal goes ahead now, and once the server accepts it, a notice says
     who lost sight of how many tasks. */
  startRemoval: (change: AccessRemoval): boolean => {
    const removal = PLANNER.accessRemoval(change)
    const { people, items } = removal
    if (items.length && PLANNER.canSettleRemoval(removal)) return true
    void PLANNER.removeAccess(change, { to: null }, []).then((removed) => {
      if (!removed || !items.length) return
      const who = andList(people.map((id) => PLANNER.user(id)?.name || 'Someone'))
      // one item per role: a task held twice counts once
      const count = new Set(items.map((i) => i.task.id)).size
      toast(
        count === 1
          ? `${who} can no longer see a task they are assigned to or reviewing. A project lead can reassign it.`
          : `${who} can no longer see ${count} tasks they are assigned to or reviewing. A project lead can reassign them.`,
        'info',
      )
    })
    return false
  },
  /* Who can take over every listed task once the access is gone: anyone in
     the organization who can hold work, with Edit access to each task's
     project and sight of every task above, both as the grants would be.
     Edit access to the project whose grant is removed is not needed: a
     person who edits only the affected sub-project can take its tasks. */
  reassignChoices: (change: AccessRemoval, items: Holder[]): UserVM[] => {
    const orgId =
      'projectId' in change
        ? PLANNER.orgOf(change.projectId)
        : PLANNER.teams.find((t) => t.id === change.teamId)?.org
    if (!orgId) return []
    const level = levelAfter(change)
    const people = new Set(items.map((i) => i.uid))
    return PLANNER.usersIn(orgId).filter(
      (u) =>
        u.active &&
        (u.orgRole === 'admin' || u.orgRole === 'user' || u.orgRole === 'guest') &&
        !people.has(u.id) &&
        items.every(
          (i) =>
            ['lead', 'user'].includes(level(u.id, i.task.project) || '') &&
            !PLANNER.unseenAbove(i.task, u.id, (projectId) => !!level(u.id, projectId)),
        ),
    )
  },
  /* Apply the removal with the choice made in the removal window, for the
     `items` the person reviewed there: keep their holders as Viewers (a
     direct Viewer grant each on the listed projects), or hand every item to
     `to` (null clears it). A person's or a team's grant, or a member leaving
     a team, goes in one server write that settles the tasks too
     (projects.removeAccess, teams.removeMember, the rules REST and MCP use),
     so a refusal changes nothing. For a deleted team, the access goes once
     the server has accepted every reassignment and every Viewer grant. If one
     is refused the team stays, so nobody is left holding a task they cannot
     see. Resolves whether the server accepted the removal. */
  removeAccess: async (
    change: AccessRemoval,
    choice: { keep: true } | { to: string | null },
    items: Holder[],
  ): Promise<boolean> => {
    if (refusePausedEdit()) return false
    const team = 'teamId' in change ? PLANNER.teams.find((t) => t.id === change.teamId) : null
    const named = teamNoun(team?.name)
    const person = 'userId' in change ? PLANNER.user(change.userId)?.name || 'This person' : ''
    // who keeps their access when a write is refused
    const stays =
      change.kind === 'userGrant'
        ? `${person} keeps access`
        : change.kind === 'teamGrant'
          ? `The ${named} keeps access`
          : change.kind === 'teamMember'
            ? `${person} stays in the ${named}`
            : `The ${named} stays`
    if (change.kind !== 'deleteTeam') return removeAtOnce(change, choice, items, stays)
    // the server refuses to delete the last team: say so before anything is saved
    if (team && !PLANNER.canDeleteTeam(change.teamId)) {
      toast(`The ${named} can't be deleted, because it is the organization's last team.`, 'error')
      return false
    }
    if ('to' in choice) {
      const to = choice.to
      const saved = await Promise.all(
        items.map((i) =>
          PLANNER.updateIssue(
            i.task.id,
            i.role === 'assignee' ? { assignee: to } : { reviewer: to },
          ),
        ),
      )
      if (saved.includes(false)) {
        toast(`${stays}, because not every task could be reassigned.`, 'error')
        return false
      }
    }
    const people = [...new Set(items.map((i) => i.uid))]
    const keep = 'keep' in choice && people.length > 0
    // a project's grants with a Viewer grant for each listed person who
    // would otherwise not see it
    const level = levelAfter(change)
    const withViewers = (pid: string) => {
      const access = grantsOn(pid)
      for (const uid of people) if (!level(uid, pid)) access[uid] = 'viewer'
      return access
    }
    // the Viewer grants are saved before the team changes
    if (keep) {
      const projects = [...new Set(items.map((i) => keptOn(change, i.task)))]
      const saved = await Promise.all(
        projects.map((pid) => PLANNER.updateProject(pid, { access: withViewers(pid) })),
      )
      if (saved.includes(false)) {
        toast(`${stays}, because not every Viewer grant could be saved.`, 'error')
        return false
      }
    }
    const deleted = await PLANNER.removeTeam(change.teamId)
    if (deleted && team) toast(`Team “${team.name}” deleted`, 'success')
    return deleted
  },
  /* Whether the access a removal takes away is still there: someone else may
     have removed it while the removal window was open. */
  removalPending: (change: AccessRemoval): boolean => {
    switch (change.kind) {
      case 'userGrant':
        return !!grantsOn(change.projectId)[change.userId]
      case 'teamGrant':
        return !!PLANNER.project(change.projectId)?.teamAccess?.[change.teamId]
      case 'teamMember':
        return !!PLANNER.user(change.userId)?.teams.includes(change.teamId)
      case 'deleteTeam':
        return rows.teams.has(change.teamId)
    }
  },
  /* One sentence naming who blocks a change and how to clear it. */
  blockerText: (b: AccessBlocker): string => {
    const person = PLANNER.user(b.uid)
    const who = person?.name || 'Someone'
    const holds = b.role === 'reviewer' ? 'is reviewing' : 'is assigned to'
    const lacks = b.edit ? "can't edit" : 'has no access to'
    const fix = b.role === 'reviewer' ? 'choose another reviewer for' : 'reassign'
    // giving access back does not help a switched-off person
    if (person && !person.active)
      return `${who} is switched off and ${holds} ${b.task.key}. ${fix.charAt(0).toUpperCase()}${fix.slice(1)} ${b.task.key} first.`
    return `${who} ${holds} ${b.task.key} but ${lacks} ${PLANNER.projectLabel(b.project)}. Give them ${b.edit ? 'edit ' : ''}access or ${fix} ${b.task.key} first.`
  },
  /* my own organization's USERS — the roster, team membership, the settings
     page. Guests hold a seat in the org's `profiles` but are not part of it:
     they occupy no seat and belong to no team. */
  homeUsers: () => PLANNER.users.filter((u) => u.org === PLANNER.homeOrg && u.orgRole !== 'guest'),
  /* …the switched-on ones. This is the BILLABLE set and the one every picker
     offers; `homeUsers` still lists everybody, because the Users page has to
     show you the person you switched off in order to switch them back on. */
  homeActiveUsers: () => PLANNER.homeUsers().filter((u) => u.active),
  /* …and of THOSE, the ones who can be handed work or a lead role: the same
     "not a viewer" narrowing as `assigneesFor`, one altitude up, for the
     pickers that run before a project exists (New project's Lead). A viewer
     still counts as a seat on the Billing page — being read-only is not being
     free — which is why this is a separate selector and not a change to
     `homeActiveUsers`. */
  homeAssignees: () => PLANNER.homeActiveUsers().filter((u) => u.orgRole !== 'viewer'),
  /* …and the guests of my organization, listed apart (Settings › Users) */
  homeGuests: () => PLANNER.users.filter((u) => u.org === PLANNER.homeOrg && u.orgRole === 'guest'),
  /* every project of MINE this guest holds a grant on — what the Users
     page shows under a guest's address, since that IS their whole access */
  guestProjects: (profileId: string) =>
    PLANNER.projects
      .filter((p) => !!p.access?.[profileId])
      .map((p) => ({ id: p.id, name: p.name, level: p.access?.[profileId] })),
  /* URL support (0081). An org-prefixed link names the organization by slug;
     these two turn that segment into the handle/project the app threads. */
  orgBySlug: (slug: string) =>
    PLANNER.orgs.find((o) => o.slug === String(slug || '').toLowerCase()) || null,
  /* "QN-5" as read INSIDE `orgId` → the handle for that exact issue (null if
     that organization has no such number, or none is loaded). */
  issueRefIn: (orgId: string, key: string): string | null => {
    const uuid = (keyByOrg.get(orgId) || new Map()).get(String(key || '').toUpperCase())
    return uuid ? uuidToKey.get(uuid) || null : null
  },
  /* Claim a home organization (0081) — the one-time door for a login that has
     only guest seats, or none at all. The mutation creates the org, its first
     team, an admin profile for the caller and its billing, and refuses when a
     home organization already exists; a full re-init then swaps the blend
     over to it (HOME_ORG, the roster, the handle scheme). Resolves false on
     refusal. */
  createOrg: async (name: string): Promise<boolean> => {
    try {
      await write(api.identity.createOrganization, { name: name.trim() })
    } catch (e) {
      const msg = errData(e).message || "couldn't create the organization"
      toast(msg.charAt(0).toUpperCase() + msg.slice(1))
      return false
    }
    await initStore()
    emit()
    return true
  },
  /* Invite someone to ONE project by email (0082). Awaited: the server
     decides known-vs-new guest, and a refusal is toasted with its own
     sentence (capitalized, like createOrg's). The new grant/seat arrives
     with the snapshot delivery — no refetch. */
  inviteToProject: async (metaId: string, email: string, level = 'user'): Promise<boolean> => {
    const org = orgOfProject(metaId)
    if (!org) return false
    try {
      await write(api.projects.inviteGuest, {
        org_id: org,
        project_id: metaId,
        email: email.trim(),
        level,
      })
    } catch (e) {
      const msg = errData(e).message || "couldn't send the invitation"
      toast(msg.charAt(0).toUpperCase() + msg.slice(1))
      return false
    }
    return true
  },
  /* Who may create a top-level project follows the home org's setting, by
     the rule projects.create enforces (convex/lib/projectCreators.ts). It
     gates every New project button; sub-projects need lead access on the
     parent instead. */
  canCreateProject: (uid?: string) => {
    const actor = actorIn(HOME_ORG, uid)
    if (!actor?.active) return false
    return canCreateProjects(
      { org_role: actor.orgRole, can_create_projects: actor.canCreateProjects },
      homeRow()?.project_creators,
    )
  },
  canSeeActivity: (e: ActivityVM, uid?: string) => {
    // no CURRENT_USER default: canSee/isTeamLeader resolve me to the seat I
    // hold in the row's own organization (0081), which a home profile id
    // would override with an identity that doesn't live there
    if (e.projectId) {
      return PLANNER.canSee(e.projectId, uid)
    }
    if (e.team) return PLANNER.isTeamLeader(e.team, uid)
    return true
  },
  fmtAgo: (ts: number) => {
    const m = Math.round((Date.now() - ts) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
  },
  leadOf: (id: string) => {
    const p = PLANNER.projects.find((x) => x.id === id)
    if (!p) return null
    if (p.lead) return p.lead
    if (p.parent) {
      const m = PLANNER.projects.find((x) => x.id === p.parent)
      if (m?.lead) return m.lead
    }
    return null
  },
  statusOf: (id: string) => STATUSES.find((s) => s.id === id),
  /* stale — no activity (updated_at) for the organization's standard
     threshold. Purely
     a display/filter notion (0044): nothing is stored on the issue, and done
     issues never count, since finished work isn't stale, it's finished. A
     group's own row is not touched when its subtasks change, so it counts the
     newest activity among itself and its visible descendants. */
  /* "owned by me" (the assignee, or the reviewer while the task waits In
     Review; #314) — the ONE membership rule, shared by the My tasks filter,
     the "My view" scope (deviation #49) and the router. It spans every
     organization I hold a profile in (0081): one human, several profile uuids. */
  isMine: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return !!it && !!it.owner && myProfileSet.has(it.owner)
  },
  isStale: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it || PLANNER.isDone(it) || !it.updatedAt) return false
    let newest = it.updatedAt
    if (PLANNER.isGroup(it))
      eachDescendant(it, (child) => {
        newest = Math.max(newest, child.updatedAt || 0)
      })
    const days = 120
    return Date.now() - newest > days * 86400000
  },
  /* "Filter issues" is a multi-word AND over every text field the issue
     carries (QN key, title, description, status and priority display names,
     assignee name, label names). Each word may land on a different field
     ("to do cable" = status To Do + "cable" in the title). The text comes
     from taskSearchText, which REST and MCP task search build too. */
  /* Also answers for archived rows: fetchArchived's shapes carry every field
     the haystack reads, which is what "shaped enough like snapshot issues for
     matchesSearch" means. */
  matchesSearch: (x: IssueVM | ArchivedIssueVM | string, query: string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it) return false
    const hay = taskSearchText({
      key: it.key,
      title: it.title,
      description: it.description,
      status: it.status,
      group: PLANNER.isGroup(it),
      priority: it.priority,
      assigneeName: PLANNER.users.find((u) => u.id === it.assignee)?.name,
      labelNames: it.labels.map((lid) => PLANNER.labelById[lid]?.name),
    })
    return matchesAllWords(hay, query)
  },
  /* The toolbar filter row as ONE predicate for every view that renders it.
     Board and Roadmap each kept a private copy before #24 and they drifted
     (the Board searched descriptions, the Roadmap didn't) — new filters go
     here, not in the views. */
  passesFilters: (x: IssueVM | string, filters: IssueFilters): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it) return false
    // 'mine' spans every organization I hold a profile in (0081)
    if (filters.mine && !PLANNER.isMine(it)) return false
    if (filters.assignees.length && !filters.assignees.includes(it.owner)) return false
    if (filters.priority && it.priority !== filters.priority) return false
    if (filters.stale && !PLANNER.isStale(it)) return false
    // Focus — hide the not-yet-started and the finished; a per-user persisted
    // mode (user_prefs), not an ephemeral filter: Clear leaves it alone
    if (filters.focus && !PLANNER.isGroup(it) && (it.status === 'backlog' || it.status === 'done'))
      return false
    if (filters.search && !PLANNER.matchesSearch(it, filters.search)) return false
    return true
  },
  /* projected delay (0064) — computed, never stored. delayOf answers for any
     issue; whether the UI paints it is the project's trackDelay toggle,
     folded into delayColor: null means "nothing to paint — the surface stays
     as it is", which now covers three cases that all look alike, not tracked,
     done/no-signal, and on track. A token string otherwise, and only for the
     two states that carry pressure: yellow behind, red late. */
  delayOf: (x: IssueVM | string): DelayInfo | null => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return (it && delayMap.get(it.uuid)) || null
  },
  tracksDelay: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    const p = it && PLANNER.project(it.project)
    return !!p && p.trackDelay !== false
  },
  /* The remaining time a task in this project gets on entering Review: the
     project's own value, else its parent's, else DEFAULT_REVIEW_HOURS. */
  reviewHoursFor: (projectId: string) => reviewHoursForProject(projectId),
  /* Hours a person is committed to in `week` ORG-WIDE: the snapshot's
     plan_org_load (paused, Done and unscheduled work already left out by the
     server, projects this viewer cannot see included), spread the way the
     delay projection spreads it. The Team sync header shows it because
     capacity is org-wide; the Team strip's figure covers visible tasks only.
     The server recomputes it, so a handover moves it on the next delivery. */
  weekLoadOf: (profileId: string, week: number): number => {
    let byWeek = committedByOwner.get(profileId)
    if (!byWeek) {
      byWeek = new Map()
      committedByOwner.set(profileId, byWeek)
    }
    let hours = byWeek.get(week)
    if (hours === undefined) {
      // only the asked week, however far the owner's plans run
      const load = orgLoadByOwner.get(profileId) || []
      hours = committedByWeek(load, null, { from: week, to: week }).get(week) || 0
      byWeek.set(week, hours)
    }
    return hours
  },
  delayColor: (x: IssueVM | string): string | null => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it || !PLANNER.tracksDelay(it)) return null
    const d = delayMap.get(it.uuid)
    return d ? DELAY_COLORS[d.status] : DELAY_NEUTRAL
  },
  /* Milestones belong to the project whose roadmap shows them (0078). A meta
     project's roadmap also carries the milestones of… only itself: milestones
     are set on the meta, sub-projects inherit the view through it. */
  milestonesIn: (projectId: string) => {
    const m = PLANNER.metaOf(projectId)
    return m ? PLANNER.milestones.filter((x) => x.project === m.id) : []
  },
  /* one curated list for the whole organization (0078). `orgId` picks which:
     the blend (0081) also carries a host org's vocabulary, and a label only
     attaches to tasks of its OWN org (the 0028 trigger). Defaults to home —
     Settings › Labels curates that one. */
  orgLabels: (orgId?: string) => {
    const org = orgId || PLANNER.homeOrg
    return PLANNER.labels.filter((l) => l.org === org)
  },
  /* mirrors the server's can_write_org_labels: org admin, the lead of any
     project, or a user-level grant somewhere in the org. Permission-based,
     not membership-based — picking a label is open to everyone, curating it
     isn't. It governs adding labels; renaming, recoloring and deleting them
     is for org admins (isAdmin), as on the server. */
  canWriteOrgLabels: (orgId?: string, uid?: string) => {
    const org = orgId || PLANNER.homeOrg
    const u = actorIn(org, uid)
    if (!u) return false
    // The vocabulary belongs to the organization, so only staff may curate
    // it, including those who receive project write access through a team.
    if (u.orgRole !== 'admin' && u.orgRole !== 'user') return false
    if (u.orgRole === 'admin') return true
    // the access map already surfaces projects.lead_id as 'lead'; the org
    // fence is intrinsic — a grant elsewhere says nothing about this list
    return PLANNER.projects.some(
      (p) =>
        p.type === 'meta' &&
        p.org === org &&
        ['lead', 'user'].includes(levelOnProject(p, u.id) || ''),
    )
  },
  subscribe: updates.subscribe,
  updates: updates.channels,
  emit,

  /** Why the live snapshot is stale, or null while it is current. Observe
      it through the `health` channel. */
  snapshotTrouble: (): SnapshotTrouble | null => snapshotTrouble,
  /** Whether edits to shared data are paused (the snapshot is stale). */
  editsPaused: () => snapshotTrouble !== null,
  refusePausedEdit,
  retrySnapshot,

  /* Groups retain a dormant workflow status; only their leaf work completes. */
  isGroup: (x: IssueVM | ArchivedIssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return !!it && isIssueGroup(it)
  },
  /* A group's own pause is dormant like its status: only leaf work is held. */
  isPaused: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return !!it?.paused && !PLANNER.isGroup(it)
  },
  isDone: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return !!it && isIssueDone(it, PLANNER.issueById)
  },
  /* progress — computed from descendant leaves, never group statuses */
  progressOf: (x: IssueVM | string) => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return it ? groupProgress(it, PLANNER.issueById) : { pct: 0, done: 0, total: 0, unknown: false }
  },

  /* remaining is own hours for a leaf. For a group it is the sum over the
     unfinished leaves of its visible subtree (a group has no hours of its
     own, 0066, and a Done task has no work left, as in every other remaining
     total). Cycle-safe like progressOf. undefined when no unfinished leaf has
     hours entered. Only the parent/sub-issue tree feeds this, and linked
     issues never count. */
  remainingOf: (x: IssueVM | string): number | undefined => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it) return undefined
    if (!PLANNER.isGroup(it)) return it.remaining
    let sum = 0
    let any = false
    eachDescendant(it, (child) => {
      if (PLANNER.isGroup(child) || child.status === 'done' || child.remaining == null) return
      sum += child.remaining
      any = true
    })
    return any ? Math.round(sum * 10) / 10 : undefined
  },
  projectProgress: (pid: string) => {
    const list = PLANNER.issues.filter((i) => i.project === pid && !PLANNER.isGroup(i))
    const total = list.length
    const done = list.filter((i) => i.status === 'done').length
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  },
  /* summed remaining hours of a sub-project's not-done issues — own hours
     only, so a parent (NULL since 0066) never double-counts its children,
     and a cross-project parent's subtree stays with the projects that
     actually hold the hours */
  projectRemaining: (pid: string) => {
    const sum = PLANNER.issues
      .filter((i) => i.project === pid && !PLANNER.isGroup(i) && i.status !== 'done')
      .reduce((s, i) => s + (i.remaining || 0), 0)
    return Math.round(sum * 10) / 10
  },
  programProgress: (mid: string) => {
    const m = PLANNER.projects.find((p) => p.id === mid)
    const set = new Set((m?.children || []).filter((id) => PLANNER.canSee(id)))
    const list = PLANNER.issues.filter((i) => set.has(i.project) && !PLANNER.isGroup(i))
    const total = list.length
    const done = list.filter((i) => i.status === 'done').length
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  },

  loadUI: preferences.load,
  saveUI: preferences.save,
  saveUINow: preferences.saveNow,

  /* ------------------------------- mutations -------------------------------
     Optimistic patch → rebuild() → emit() → run(write(...)) with
     org_id = THE SUBJECT ROW'S organization (0081: a guest-seat write with
     the home org would be refused — the wrapper picks the caller's seat by
     it). The awaited exceptions carry their own error mapping (§ header). */
  ISSUE_PREFIX,

  /** The server assigns issue numbers from the org counter (0050; never
      reused after deletes) — the snapshot has that counter, so the preview is
      exact unless someone else creates concurrently. The projectId parameter
      is kept for prototype API parity but no longer matters. */
  nextIssueKey: (projectId?: string) => {
    // the counter lives on the TARGET project's organization (0050/0081)
    const o = rows.orgs.get(orgOfProject(projectId) || HOME_ORG)
    return o ? `${ISSUE_PREFIX}-${(o.next_issue_num || 0) + 1}` : ''
  },

  /** Returns the new issue's HANDLE (exact unless someone creates
      concurrently), so callers can reference it right away. The org-wide
      counter (0050) means ANY concurrent create can invalidate the preview;
      `onKeyFixed` fires with the real key when issues.create's returned row
      disagrees, so callers can re-anchor UI state bound to the preview.
      `onRefused` lets an open preview close before rollback can replace its
      number with another task that was created concurrently.
      Returns null for an invalid target (callers take their no-create path). */
  addIssue: (it: NewIssueInput, onKeyFixed?: (key: string) => void, onRefused?: () => void) => {
    const proj = rows.projects.get(it.project)
    // Numbering, org and reporter all follow the TARGET project's organization
    // (0081): creating in a foreign project is attributed to my guest profile
    const orgRow = proj ? rows.orgs.get(proj.org_id) : null
    if (proj?.type !== 'project' || !orgRow || refusePausedEdit()) return null
    const uuid = crypto.randomUUID()
    const now = new Date().toISOString()
    const previewNum = (orgRow.next_issue_num || 0) + 1
    orgRow.next_issue_num = previewNum // optimistic; reconciled in onOk
    const hasRemaining = it.remaining != null && it.remaining !== ''
    // born In Review without stated hours: the server gives it the project's
    // review time (createIssueCore); the paint mirrors it
    const reviewStart = (it.status || 'backlog') === 'review' && !hasRemaining
    const reporterId = profileIn(orgRow.id) || undefined
    const row: Row<'issues'> = {
      id: uuid,
      project_id: it.project,
      num: previewNum,
      org_id: orgRow.id,
      title: clampTitle(it.title),
      description: it.description || '',
      status: it.status || 'backlog',
      priority: it.priority || 'low',
      assignee_id: it.assignee || undefined,
      reviewer_id: it.reviewer || undefined,
      reporter_id: reporterId,
      created_by: profileIn(orgRow.id) || undefined,
      parent_id: it.parent ? keyToUuid.get(it.parent) || undefined : undefined,
      start_week: it.start != null ? weekToISO(it.start) : undefined,
      end_week: it.end != null ? weekToISO(it.end) : undefined,
      due_date: it.due || undefined,
      remaining_hours: hasRemaining
        ? Number(it.remaining)
        : reviewStart
          ? reviewHoursForProject(it.project)
          : undefined,
      remaining_set_at: hasRemaining || reviewStart ? now : undefined, // mirror the 0072 stamp
      paused: !!it.paused,
      done_at: (it.status || 'backlog') === 'done' ? now : undefined, // mirror the 0070 stamp
      // mirror createIssueCore's hand-off stamp: born In Review is handed now
      review_at: reviewStamp(
        null,
        { status: it.status || 'backlog', reviewer_id: it.reviewer || undefined },
        now,
      ),
      created_at: now,
      updated_at: now,
    }
    rows.issues.set(uuid, row)
    // born under a parent: the parent's own hours clear (0066 mirror)
    if (row.parent_id) clearParentRemaining(it.parent)
    rebuild()
    emit()
    run(
      write(api.issues.create, {
        org_id: row.org_id,
        id: uuid,
        project_id: row.project_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignee_id: row.assignee_id ?? null,
        reviewer_id: row.reviewer_id ?? null,
        parent_id: row.parent_id ?? null,
        start_week: row.start_week ?? null,
        end_week: row.end_week ?? null,
        due_date: row.due_date ?? null,
        // from the INPUT, never the painted review time: the server decides it
        remaining_hours: hasRemaining ? Number(it.remaining) : null,
        paused: row.paused,
      }),
      (created) => {
        const o = rows.orgs.get(row.org_id)
        if (o) o.next_issue_num = Math.max(o.next_issue_num || 0, created.num)
        if (created.num !== previewNum) {
          // merge, don't replace: a whole-row overwrite would clobber
          // optimistic patches issued while the create was in flight
          const cur = rows.issues.get(uuid)
          if (cur) cur.num = created.num
          rebuild()
          emit()
          // only a home-org handle can change under a renumber — a foreign
          // issue's handle IS its uuid, which the server never reassigns
          if (onKeyFixed && row.org_id === HOME_ORG) onKeyFixed(`${ISSUE_PREFIX}-${created.num}`)
        }
      },
      undefined,
      (error) => {
        toastWriteError(error)
        onRefused?.()
      },
    )
    return handleFor(uuid, row.org_id, `${ISSUE_PREFIX}-${previewNum}`)
  },

  /* Paints the change at once and sends it. Resolves true when the server
     accepts it or nothing needed sending, false when it is refused here or
     by the server (both toast the reason). Callers that only paint can
     ignore it; removeAccess waits on it before taking a grant away. */
  updateIssue: (id: string, patch: IssuePatch): Promise<boolean> => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!row || !uuid || !patch || !Object.keys(patch).length) return Promise.resolve(false)
    if (refusePausedEdit()) return Promise.resolve(false)
    // text over the server's cap is refused before the paint, so a draft is
    // never lost to a rollback; a task saved before the cap may send its
    // stored text back unchanged, as the server allows
    if ('description' in patch) {
      const text = patch.description ?? ''
      if (text !== row.description && text.length > TEXT_MAX) {
        toast(TEXT_TOO_LONG.description)
        return Promise.resolve(false)
      }
    }
    // whoever holds a subtask must see every task above it: refuse here, with
    // the server's reason, before anything is painted (a hidden parent is
    // left to the server)
    const it = PLANNER.issueById[id]
    const stranded = it && patch.parent ? PLANNER.parentBlockers(it, patch.parent) : []
    if (stranded.length) {
      toast(PLANNER.blockerText(stranded[0]), 'error')
      return Promise.resolve(false)
    }
    for (const holder of [patch.assignee, patch.reviewer]) {
      const unseen = it && holder ? PLANNER.unseenAbove(it, holder) : null
      const project = unseen && PLANNER.project(unseen.project)
      if (it && holder && project) {
        const who = PLANNER.user(holder)?.name || 'This person'
        toast(
          `${who} has no access to ${PLANNER.projectLabel(project)}, where a task above ${it.key} is. Give them access or choose someone else.`,
          'error',
        )
        return Promise.resolve(false)
      }
    }
    // a group's dates are calculated from its subtasks, so drop a stray date
    // patch before the paint and the write (the UI offers none and the server
    // refuses one), and the dormant stored dates stay as they are
    if (('start' in patch || 'end' in patch) && PLANNER.isGroup(id)) {
      patch = { ...patch }
      delete patch.start
      delete patch.end
      if (!Object.keys(patch).length) return Promise.resolve(true)
    }
    // remaining is computed for parents (0066): drop a stray own-hours patch
    // (the UI hides the input; the server would refuse it anyway)
    if ('remaining' in patch) {
      let isParent = false
      rows.issues.forEach((c) => {
        if (c.parent_id === uuid) isParent = true
      })
      if (isParent) {
        patch = { ...patch }
        delete patch.remaining
        if (!Object.keys(patch).length) return Promise.resolve(true)
      }
    }
    // attaching a sub-issue clears the new parent's own hours (0066 mirror)
    if ('parent' in patch && patch.parent) clearParentRemaining(patch.parent)
    const prevDesc = String(row.description || '') // pre-patch, for the GC below
    const paintPatch = { ...patch }
    if (PLANNER.isGroup(id)) delete paintPatch.status
    applyIssuePatchToRow(row, paintPatch)
    // a new visible parent or a detach replaces a hidden one; a refusal
    // re-adopts the server snapshot, which restores the flag
    if ('parent' in patch) rows.hiddenParentTasks.delete(uuid)
    rebuild()
    emit()
    const wire = mapIssuePatch(patch)
    const planningOnly = Object.keys(patch).every((key) =>
      ['start', 'end', 'remaining'].includes(key),
    )
    const saved =
      planningOnly && recordRoadmapChange({ kind: 'task', id: uuid, patch: wire })
        ? Promise.resolve(true)
        : runSaved(write(api.issues.update, { org_id: row.org_id, id: uuid, patch: wire }))
    // inline description images are hidden attachments; when neither the new
    // text nor the text it just replaced references one any more, reap the
    // row + bytes. Keeping the replaced text's refs for one more save gives
    // undo-across-save a window: an att: node resurrected right after the
    // save that dropped it still has its attachment (older resurrections can
    // render "Image unavailable" — with no version history there is nothing
    // left to preview, so nothing else holds a claim). The grace window
    // covers uploads whose reference hasn't been committed anywhere yet:
    // with the explicit Save bar a dirty draft (this user's other tab,
    // another user's editor) can legitimately sit unsaved for hours, and
    // reaping its pasted image would break that draft — and, once saved,
    // the committed text — for good. A day comfortably outlives any live
    // draft, and genuine orphans (crashed tabs) re-qualify on every later
    // description save, so they still get cleaned up. Draft-only uploads
    // are otherwise reaped by the editor's own discard paths, never by this
    // GC. (An unauthorized editor's removeAttachment is refused server-side
    // and rolls back by re-adopting serverSnap, along with the description
    // update itself, so both revert together.)
    // Known limit: references only count within their own issue, so an att:
    // link hand-copied into another issue's description dies with the original.
    if ('description' in patch) {
      const refsOf = (text: string) => [...text.matchAll(/att:([0-9a-f-]{36})/g)].map((m) => m[1])
      const referenced = new Set([...refsOf(String(patch.description || '')), ...refsOf(prevDesc)])
      const graceCutoff = Date.now() - 24 * 60 * 60 * 1000
      ;[...rows.attachments.values()]
        .filter((a) => a.issue_id === uuid && a.inline && !referenced.has(a.id))
        .forEach((a) => {
          if (new Date(a.created_at).getTime() >= graceCutoff) return
          PLANNER.removeAttachment(a.id)
        })
    }
    return saved
  },

  setStatus: (id: string, status: Row<'issues'>['status']) => {
    PLANNER.updateIssue(id, { status })
  },

  /** A person's org-wide owned workload for resource-aware planning
      (api.planning.assigneeLoad, the plan_assignee_load port): the tasks
      they are assigned, except those waiting In Review with another
      reviewer, plus the ones they review while In Review (#314). The server
      resolves the person's own org and fences both ends; each item's
      project is attributed only when the CALLER can see it — hidden ones
      arrive visible:false with a null project so the client folds them into
      "Other projects". Weeks are converted to the client's grid indexes.
      Returns null on transport error only (fence misses are empty arrays). */
  assigneeLoad: async (assigneeUuid: string) => {
    let data: FunctionReturnType<typeof api.planning.assigneeLoad>
    try {
      data = await convex.query(api.planning.assigneeLoad, { assignee_id: assigneeUuid })
    } catch (e) {
      console.error('[qivo] assignee load failed:', e)
      return null
    }
    return data.map((r) => ({
      issueUuid: r.issue_id || null,
      projectId: r.project_id || null,
      projectName: r.project_name || null,
      start: isoToWeek(r.start_week),
      end: isoToWeek(r.end_week),
      remaining: r.remaining != null ? Number(r.remaining) : 0,
      remainingSet: r.remaining_set_at != null ? tsToWeek(r.remaining_set_at) : null,
      visible: !!r.visible,
    }))
  },

  /** Whether the server would carry subtasks along if the task `id` moved
      to `projectId` (api.issues.moveCarriesSubtasks), archived ones
      included. The snapshot holds no archived tasks, so moveFamily cannot
      tell. Null on transport error or for a task outside this view. */
  moveCarriesSubtasks: async (id: string, projectId: string): Promise<boolean | null> => {
    const it = PLANNER.issueById[id]
    if (!it) return null
    try {
      return await convex.query(api.issues.moveCarriesSubtasks, {
        org_id: it.org,
        id: it.uuid,
        project_id: projectId,
      })
    } catch (e) {
      console.error('[qivo] move preview failed:', e)
      return null
    }
  },

  /** Move an issue to another sub-project. Issue numbers are org-scoped and
      immutable, so the key survives the move unchanged — nothing to
      renumber. A move to another top-level project detaches the task from a
      parent that stays behind and carries its subtasks along (moveFamily),
      as the server does. Returns the (unchanged) key, or null for a no-op or
      an invalid target. */
  moveIssue: (id: string, projectId: string) => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    const target = rows.projects.get(projectId)
    const it = PLANNER.issueById[id]
    if (
      !row ||
      !uuid ||
      !it ||
      !target ||
      target.type !== 'project' ||
      row.project_id === projectId ||
      refusePausedEdit()
    )
      return null
    const { leavesParent, carried } = PLANNER.moveFamily(it, projectId)
    const now = new Date().toISOString() // the server's move fires the touch
    for (const task of [it, ...carried]) {
      const moved = rows.issues.get(task.uuid)
      if (!moved) continue
      moved.project_id = projectId
      moved.updated_at = now
    }
    if (leavesParent) {
      row.parent_id = undefined
      rows.hiddenParentTasks.delete(uuid)
    }
    rebuild()
    emit()
    run(
      write(api.issues.move, {
        org_id: row.org_id,
        id: uuid,
        project_id: projectId,
        ...(leavesParent ? { detach_parent: true } : {}),
      }),
    )
    return id
  },

  /* What the Archive or delete window lists for deleting a task: each
     subtask under it, and under every subtask that would be deleted with it,
     with whether I can delete it (Edit access to its project). A subtask I
     cannot delete stays, keeping its own subtasks, so those are not listed.
     `hidden` is true when the task, or a subtask that would be deleted, has
     subtasks in projects I cannot see; how many is not known here. */
  deletePlan: (id: string): { rows: DeleteRow[]; deletable: IssueVM[]; hidden: boolean } => {
    const root = PLANNER.issueById[id]
    const rows: DeleteRow[] = []
    if (!root) return { rows, deletable: [], hidden: false }
    let hidden = root.hasHiddenSubtasks
    const seen = new Set([root.id])
    const walk = (it: IssueVM, depth: number) => {
      for (const key of it.children) {
        const child = PLANNER.issueById[key]
        if (!child || seen.has(key)) continue
        seen.add(key)
        const deletable = PLANNER.canWrite(child.project)
        rows.push({ task: child, depth, deletable })
        if (!deletable) continue
        hidden ||= child.hasHiddenSubtasks
        walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return { rows, deletable: rows.filter((r) => r.deletable).map((r) => r.task), hidden }
  },

  /* Move a task to Deleted items, and with it the `subtasks` (handles) the
     Archive or delete window listed as deletable. Every other subtask under
     a deleted task loses its parent and becomes a top-level task; the server
     checks the subtasks again and refuses the whole delete if they changed.
     Resolves whether the server deleted it (a refusal is toasted). Normally
     the change paints at once and rolls back on refusal; with `wait`, as the
     window asks, nothing changes here until the server accepts, so a refusal
     leaves the task and the window in place. `reason` is shown in Deleted
     items. */
  deleteIssue: (
    id: string,
    subtasks: string[] = [],
    wait = false,
    reason?: string,
  ): Promise<boolean> => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!row || !uuid || refusePausedEdit()) return Promise.resolve(false)
    const subtaskIds = subtasks.flatMap((key) => keyToUuid.get(key) || [])
    const gone = new Set([uuid, ...subtaskIds])
    // local mirror of the delete; the server moves the rows to Deleted items
    // (convex/model/deletedItems.ts) and keeps the attachment bytes there
    const mirror = () => {
      dropDeletedTasks(gone)
      rebuild()
      emit()
    }
    const epoch = storeEpoch
    // kept until a delivery no longer holds them (adopt), so a rollback after
    // another refused write cannot bring them back meanwhile
    const accepted = () => {
      if (epoch === storeEpoch) pendingTaskDeletes.set(uuid, gone)
    }
    const text = (reason || '').trim()
    const sent = write(api.issues.deleteDeep, {
      org_id: row.org_id,
      id: uuid,
      ...(subtaskIds.length ? { subtask_ids: subtaskIds } : {}),
      ...(text ? { reason: text } : {}),
    })
    if (!wait) {
      mirror()
      sent.then(accepted, () => {})
      return runSaved(sent)
    }
    return sent.then(
      () => {
        // the delivery may already hold the result; the mirror finds nothing then
        if (epoch === storeEpoch) {
          accepted()
          mirror()
        }
        return true
      },
      (error) => {
        console.error('[qivo] delete failed:', error)
        if (epoch === storeEpoch) toastWriteError(error)
        return false
      },
    )
  },

  /* ---- archive (0070): the Active/Archived axis, orthogonal to status ----
     Archived issues are invisible to the snapshot, so archiving locally
     means dropping rows from the row cache, exactly what the next delivery
     holds. The Archive or delete window waits for the server, so nothing
     changes here until it accepts and a refusal leaves the task and the
     window in place (toasted). Resolves whether the server archived it.
     `reason` travels as an argument, and the server posts it as a comment in
     the same transaction. With `keepSubtasks` the server detaches the task's
     active direct children first and archives the task alone, so only the
     task leaves the board and its subtasks become top-level tasks;
     otherwise the whole subtree goes with it. */
  archiveIssue: (id: string, reason?: string, keepSubtasks = false): Promise<boolean> => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!row || !uuid || refusePausedEdit()) return Promise.resolve(false)
    const text = (reason || '').trim()
    const epoch = storeEpoch
    return write(api.issues.archive, {
      org_id: row.org_id,
      id: uuid,
      ...(text ? { reason: text } : {}),
      ...(keepSubtasks ? { keep_subtasks: true } : {}),
    }).then(
      () => {
        /* The delivery that drops the task usually lands first. When it has
           not, mirror it, and keep the root so that a rollback from the stale
           snapshot after another refused write applies it again. */
        if (epoch !== storeEpoch || !rows.issues.has(uuid)) return true
        pendingArchiveIssueIds.set(uuid, { keepSubtasks })
        mirrorArchive(uuid, keepSubtasks)
        rebuild()
        emit()
        return true
      },
      (error) => {
        console.error('[qivo] archive failed:', error)
        if (epoch === storeEpoch) toastWriteError(error)
        return false
      },
    )
  },

  /** Restore from the Archive page. Awaited, never optimistic: the row is
      not in the snapshot, and the snapshot pulls the restored rows back in
      reactively — no refetch. Resolves false on refusal (toasted). */
  unarchiveIssue: async (
    issueUuid: string,
    _title?: string,
    projectId?: string,
  ): Promise<boolean> => {
    const org = orgOfProject(projectId) || HOME_ORG
    pendingRestoreIssueIds.add(issueUuid)
    try {
      await write(api.issues.unarchive, { org_id: org, id: issueUuid })
    } catch (e) {
      pendingRestoreIssueIds.delete(issueUuid)
      console.error('[qivo] restore failed:', e)
      toast(restoreErrorText(e))
      return false
    }
    return true
  },

  /** One project's archived issues, on demand — never part of the snapshot.
      A meta project loads itself plus its sub-projects (the app's notion of
      "the project"); rows are shaped enough like snapshot issues for
      matchesSearch to work on them. Newest-archived first (server-ordered).
      Null on transport error. */
  fetchArchived: async (projectId: string): Promise<ArchivedIssueVM[] | null> => {
    // the archive is per project — neither sentinel scope is one, and letting
    // one through would query for the literal string "all" / "mine"
    if (projectId === ALL_SCOPE || projectId === MINE_SCOPE) return null
    const p = PLANNER.project(projectId)
    const ids =
      p && p.type === 'meta'
        ? [p.id, ...(p.children || []).filter((id) => PLANNER.canSee(id))]
        : [projectId]
    let data: FunctionReturnType<typeof api.issues.archivedFor>
    try {
      data = await convex.query(api.issues.archivedFor, { project_ids: ids })
    } catch (e) {
      console.error('[qivo] archived fetch failed:', e)
      return null
    }
    return data.map((row) =>
      shapeArchivedIssue(
        row,
        handleFor(row.id, row.org_id, `${ISSUE_PREFIX}-${row.num}`),
        `${ISSUE_PREFIX}-${row.num}`,
      ),
    )
  },

  addLink: (srcId: string, type: string, dstId: string) => {
    if (srcId === dstId) return
    const a = keyToUuid.get(srcId)
    const b = keyToUuid.get(dstId)
    if (!a || !b) return
    const already = [...rows.links.values()].some(
      (l) => (l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a),
    )
    if (already || refusePausedEdit()) return
    const src = rows.issues.get(a)
    if (!src) return
    // canonical storage stays client-side: blocks is directed source→target,
    // blocked_by flips, relates is ordered by uuid — the wire carries the
    // stored enum, never 'blocked_by' (issues.ts expects it canonicalized)
    let source = a
    let target = b
    let dbType: 'blocks' | 'relates' = 'blocks'
    if (type === 'blocks') {
      source = a
      target = b
      dbType = 'blocks'
    } else if (type === 'blocked_by') {
      source = b
      target = a
      dbType = 'blocks'
    } else {
      dbType = 'relates'
      source = a < b ? a : b
      target = a < b ? b : a
    }
    const row: Row<'issue_links'> = {
      id: crypto.randomUUID(),
      source_id: source,
      target_id: target,
      type: dbType,
      pair_key: source < target ? `${source}:${target}` : `${target}:${source}`,
      created_at: new Date().toISOString(),
    }
    rows.links.set(row.id, row)
    rebuild()
    emit()
    run(
      write(api.issues.addLink, {
        org_id: src.org_id,
        id: row.id,
        source_id: source,
        target_id: target,
        type: dbType,
      }),
    )
  },

  removeLink: (aId: string, bId: string) => {
    const a = keyToUuid.get(aId)
    const b = keyToUuid.get(bId)
    if (!a || !b) return
    const src = rows.issues.get(a) || rows.issues.get(b)
    if (!src || refusePausedEdit()) return
    ;[...rows.links.values()].forEach((l) => {
      if ((l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a))
        rows.links.delete(l.id)
    })
    rebuild()
    emit()
    run(write(api.issues.removeLink, { org_id: src.org_id, a, b }))
  },

  /* --- attachments ---------------------------------------------------------- */
  /** Per-file cap in bytes belongs to the project's organization, including
      when the current user is working on a project shared by another org. */
  projectAttachmentLimit: (projectId: string) => {
    const project = rows.projects.get(projectId)
    const org = project ? rows.orgs.get(project.org_id) : null
    return Math.min(org?.max_attachment_mb ?? 20, 20) * 1024 * 1024
  },

  /** Takes a derived key or the issue uuid, like addAttachment. */
  attachmentLimit: (issueKey: string) => {
    const it = PLANNER.issueById[issueKey] || PLANNER.issues.find((i) => i.uuid === issueKey)
    return PLANNER.projectAttachmentLimit(it?.project ?? '')
  },

  /** Upload + register one file: files.uploadUrl → POST the bytes →
      files.attach. Awaited by the drawer so it can show an uploading row;
      resolves the new attachment id, or null on any failure (toasted).
      `inline` marks description images, which the attachments list hides.

      No optimistic row and no compensating delete: three awaited hops make
      optimism pointless, and the server deletes oversize bytes inside attach
      itself (the returned refusal). bc022c2's pendingIssueInserts gate is
      dead too — mutations from one ConvexClient are ordered on one socket, so
      by the time uploadUrl's handler runs, a just-dispatched issues.create
      has already been accepted or refused server-side. */
  addAttachment: withUpdateBlock(
    async (issueKey: string, input: File, opts?: { inline?: boolean }): Promise<string | null> => {
      // issueKey may be a derived key ("QN-482") or the issue uuid — the
      // New-issue modal and the drawer attach by uuid, which survives the rare
      // INSERT renumbering that reassigns the derived key mid-flight
      const uuid = keyToUuid.get(issueKey) || (rows.issues.has(issueKey) ? issueKey : undefined)
      let row = uuid ? rows.issues.get(uuid) : undefined
      if (!row || !uuid || refusePausedEdit()) return null
      // Shrink BEFORE the cap is applied: a 12 MB screenshot that re-encodes to
      // 600 KB should attach, not bounce. This is the choke point every caller
      // reaches, so the guard lives here rather than in each of the three
      // surfaces; the two that also pre-compress (to show an honest size, or to
      // name the file) hand over WebP, which comes straight back out.
      // Re-encoding is real wall-clock work — re-check the issue after it: the
      // row can be deleted from another tab while we encode.
      const file = await compressImage(input)
      row = rows.issues.get(uuid)
      if (!row) return null
      const limit = PLANNER.attachmentLimit(issueKey)
      if (file.size > limit) {
        toast(
          `"${file.name}" is larger than the ${Math.round(limit / 1048576)} MiB organization limit`,
        )
        return null
      }
      const attId = crypto.randomUUID()
      const inline = !!opts?.inline
      try {
        const url = await write(api.files.uploadUrl, { org_id: row.org_id, issue_id: uuid })
        // the POST's Content-Type is what lands in storage metadata and what
        // the gateway serves back — an empty type would break inline rendering
        const res = await fetch(browserBackendUrl(url), {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!res.ok) throw new Error(`upload failed (${res.status})`)
        const { storageId } = (await res.json()) as { storageId: string }
        const out = await write(api.files.attach, {
          org_id: row.org_id,
          id: attId,
          issue_id: uuid,
          storage_id: storageId as Id<'_storage'>,
          name: file.name,
          ...(file.type ? { mime: file.type } : {}),
          inline,
        })
        if ('refused' in out) {
          // the server's cap verdict (size from storage metadata, never ours) —
          // a RETURNED refusal so its byte-delete commits; belt-and-braces
          // behind the pre-check above
          toast(`Couldn't upload "${file.name}". ${asSentence(out.refused.message)}`)
          return null
        }
        // adopt the returned row; the next snapshot delivery carries it anyway
        rows.attachments.set(attId, out.attachment)
        rebuild()
        emit()
        return attId
      } catch (e) {
        console.error('[qivo] upload failed:', e)
        const msg = errData(e).message || ''
        toast(`Couldn't upload "${file.name}"${msg ? `. ${asSentence(msg)}` : ''}`)
        return null
      }
    },
  ),

  /** Delete an attachment (row + bytes, one server transaction). Optimistic
      like every other run() mutator; any project member may remove any
      attachment on an issue they can write. */
  removeAttachment: (attId: string) => {
    const rec = rows.attachments.get(attId)
    if (!rec || refusePausedEdit()) return
    const issueRow = rows.issues.get(rec.issue_id)
    rows.attachments.delete(attId)
    minted.delete(`att:${attId}`)
    rebuild()
    emit()
    // no visible issue = the server cascade already owns (or took) the row
    if (!issueRow) return
    run(write(api.files.removeAttachment, { org_id: issueRow.org_id, id: attId }))
  },

  /** Resolve an attachment to a fetchable gateway URL — minted fresh through
      files.mintUrls when the cache has nothing younger than the skew.
      download=true appends &download=1 (Content-Disposition: attachment with
      the original file name); the token covers the uuid, not the query flags,
      so a download can reuse a cached token. Resolves null on refusal or a
      missing row — deliberately silent: this sits on render paths (markdown,
      descEditor, imgActions) whose consumers draw "Image unavailable". */
  attachmentUrl: async (attId: string, download = false): Promise<string | null> => {
    const rec = rows.attachments.get(attId)
    if (!rec) return null
    const key = `att:${attId}`
    let url = mintedUrl(key)
    if (!url) {
      await primeMint([{ kind: 'attachment', id: attId }])
      url = mintedUrl(key)
    }
    if (!url) return null
    return download ? `${url}&download=1` : url
  },

  /** Subscribe to one task's thread. Deliveries share run()'s paint gate so
      server echoes cannot erase an optimistic comment before its write settles. */
  watchComments: (issueUuid: string | null) => {
    if (watchedComments === issueUuid) return
    const watchEpoch = ++commentsWatchEpoch
    watchedComments = issueUuid
    if (commentsUnsub) {
      commentsUnsub()
      commentsUnsub = null
    }
    rows.comments = new Map()
    commentsSnap = null // the old thread must not resurrect via a rollback
    commentsDirty = false // …nor may a held delivery flush into the new one
    PLANNER.commentsLoaded = false
    rebuildComments()
    emit('comments')
    if (!issueUuid) return
    // commentsForIssue is org-scoped; the watched issue is in the snapshot,
    // which is where its org comes from. An unknown uuid loads an empty
    // thread rather than spinning forever.
    const row = rows.issues.get(issueUuid)
    if (!row) {
      PLANNER.commentsLoaded = true
      rebuildComments()
      emit('comments')
      return
    }
    commentsUnsub = convex.onUpdate(
      api.snapshot.commentsForIssue,
      { org_id: row.org_id, issue_id: issueUuid },
      (thread) => {
        if (watchedComments !== issueUuid || commentsWatchEpoch !== watchEpoch) return
        // gate the paint, never the data: while our own writes are in flight
        // (an optimistic comment among them) the delivery is recorded and the
        // last settle flushes it — adopting now would eat the optimistic row
        commentsSnap = thread as Row<'comments'>[]
        if (inFlight > 0) {
          commentsDirty = true
          return
        }
        adoptComments()
        rebuildComments()
        emit('comments')
      },
      (err) => {
        if (watchedComments !== issueUuid || commentsWatchEpoch !== watchEpoch) return
        // not_found = the issue vanished / lost visibility mid-watch — the
        // fail-closed answer is an EMPTY loaded thread, never a spinner
        console.error('[qivo] comments subscription failed:', err)
        commentsSnap = []
        if (inFlight > 0) {
          commentsDirty = true
          return
        }
        adoptComments()
        rebuildComments()
        emit('comments')
      },
    )
  },

  /* ---- Team sync (docs/team-sync-brief.md) ----
     The page's one fact the snapshot lacks: when each open task was last
     commented on (api.teamSync.lastComments), for its "untouched" and
     "changed" marks. Subscribed only while the page is open, and only for
     `ownerIds`, the people whose cards it shows or shows next, most needed
     first. An answer cut short by the server's caps covers the first ones.
     The page calls this with the home organization whenever they change,
     and with null on unmount. No owners means no subscription. Every delivery
     replaces the map wholesale. A new organization empties it; new owners
     in the same one keep it until their answer arrives, so stepping through
     the walk does not blank the marks. Nothing here is optimistic, so no
     paint gate is needed. */
  watchTeamSync: (orgId: string | null, ownerIds: readonly string[] = []) => {
    const owners = orgId ? [...new Set(ownerIds)] : []
    const key = owners.join(',')
    if (watchedSyncOrg === orgId && watchedSyncOwners === key) return
    const watchEpoch = ++syncWatchEpoch
    syncUnsub?.()
    syncUnsub = null
    watchedSyncOwners = key
    if (watchedSyncOrg !== orgId) {
      watchedSyncOrg = orgId
      PLANNER.lastComments = new Map()
      emit('teamSync')
    }
    if (!orgId || !owners.length) return
    syncUnsub = convex.onUpdate(
      api.teamSync.lastComments,
      { org_id: orgId, owner_ids: owners },
      (answer) => {
        if (syncWatchEpoch !== watchEpoch) return
        PLANNER.lastComments = new Map(
          answer.rows.map((row) => [row.issue_id, row.at === null ? null : Date.parse(row.at)]),
        )
        emit('teamSync')
      },
      (err) => {
        if (syncWatchEpoch !== watchEpoch) return
        // fail closed to "nothing known", so no card claims untouched
        console.error('[qivo] team sync subscription failed:', err)
        PLANNER.lastComments = new Map()
        emit('teamSync')
      },
    )
  },

  /** Record that a change was just made on `profileId` through the Team
      sync page (its page owner, often not me): the shared sitting rule
      (convex/lib/teamSync.ts nextSyncStamp) painted on the profile row with
      this browser's clock, then the server stamps its own. A person's first
      stamp carries the day their page was reading from (`first_since`), so
      a first sitting that runs past midnight keeps its reading point. Only
      staff run a sync (the server's rule, asked the same positive way here),
      so anyone else sends nothing rather than earn a refusal. Never throws. */
  syncStamp: (profileId: string) => {
    const row = rows.profiles.get(profileId)
    if (!row) return
    const me = actorIn(row.org_id)
    if (!(me?.active && (me.orgRole === 'admin' || me.orgRole === 'user'))) return
    // the stamp follows an edit, which already said that editing is paused
    if (snapshotTrouble) return
    const prev = syncStampOf(row)
    const now = Date.now()
    const first_since =
      prev === null
        ? firstSittingDay(now, rows.orgs.get(row.org_id)?.week_start ?? DEFAULT_WEEK_START)
        : undefined
    const next = nextSyncStamp(prev, new Date(now).toISOString(), first_since)
    row.sync_at = next.at
    row.sync_since = next.since
    rebuild()
    emit()
    run(write(api.teamSync.stamp, { org_id: row.org_id, profile_id: profileId, first_since }))
  },

  /** Post a comment (issue uuid — modal-side, like addAttachment). Returns
      the new comment id, or null when the issue is gone/refused. A body over
      TEXT_MAX after trimming, or any comment while edits are paused, is
      refused here with a toast, before the optimistic row, so the caller
      can keep the draft. */
  addComment: (issueUuid: string, body: string): string | null => {
    const row = rows.issues.get(issueUuid)
    if (!row) return null
    const text = (body || '').trim()
    if (!text) return null
    if (text.length > TEXT_MAX) {
      toast(TEXT_TOO_LONG.comment)
      return null
    }
    if (refusePausedEdit()) return null
    const rec: Row<'comments'> = {
      id: crypto.randomUUID(),
      issue_id: issueUuid,
      author: profileIn(row.org_id),
      body: text,
      created_at: new Date().toISOString(), // ISO-Z, the isNewer format
    }
    if (watchedComments === issueUuid) {
      rows.comments.set(rec.id, rec)
      rebuildComments()
      emit('comments')
    }
    run(
      write(api.comments.create, {
        org_id: row.org_id,
        id: rec.id,
        issue_id: issueUuid,
        body: text,
      }),
    )
    return rec.id
  },

  /** Replaces a comment's body with `body`, trimmed, and stamps the edit.
      A missing comment, a blank body or the same text changes nothing. A
      body over TEXT_MAX is refused here with a toast, before the paint, so
      the editor keeps the draft. */
  updateComment: (id: string, body: string) => {
    const rec = rows.comments.get(id)
    const text = (body || '').trim()
    if (!rec || !text || rec.body === text) return
    if (text.length > TEXT_MAX) {
      toast(TEXT_TOO_LONG.comment)
      return
    }
    if (refusePausedEdit()) return
    const issue = rows.issues.get(rec.issue_id)
    const org = issue ? issue.org_id : HOME_ORG
    rec.body = text
    rec.edited_at = new Date().toISOString()
    // the server stamps the profile I hold in the ISSUE's org (0081) — mirror
    // that optimistically, or a foreign edit would flash my home identity
    rec.edited_by = profileIn(org) || CURRENT_USER
    rebuildComments()
    emit('comments')
    run(write(api.comments.update, { org_id: org, id, body: text }))
  },

  deleteComment: (id: string) => {
    const rec = rows.comments.get(id)
    if (!rec || refusePausedEdit()) return
    const issue = rows.issues.get(rec.issue_id)
    rows.comments.delete(id)
    rebuildComments()
    emit('comments')
    run(write(api.comments.remove, { org_id: issue ? issue.org_id : HOME_ORG, id }))
  },

  /* ---- inbox messages (0074) ----
     Rows are created only by the server; the client's whole write surface is
     read_at (and delete). The inbox acts on an ITEM — every message for one
     task — so these take an id LIST. The singular forms stay for callers
     that hold one message. */
  markMessagesRead: (ids: string[]) => {
    const at = new Date().toISOString()
    const hit = ids.filter((id) => {
      const r = rows.messages.get(id)
      return r && !r.read_at
    })
    if (!hit.length) return
    // an item's messages share one org, but a bulk mark-all spans seats —
    // group per org BEFORE the prune below deletes any of the hit rows
    const byOrg = messagesByOrg(hit)
    markLoadedMessagesRead(hit, at)
    rebuild()
    emit()
    byOrg.forEach((list, org) => {
      run(write(api.messages.markRead, { org_id: org, ids: list }))
    })
  },
  /* Mark every current notification read, including messages hidden by the
     snapshot cap and notifications in other organization seats. The server
     returns a fixed cutoff per seat, so new arrivals stay unread. */
  markAllMessagesRead: async (): Promise<void> => {
    if (!PLANNER.canMarkAllRead) return
    const epoch = storeEpoch
    const orgs = [...myProfiles.keys()]
    const ids = PLANNER.messages
      .filter((message) => !message.read && message.snoozedUntil === null)
      .map((message) => message.id)
    markLoadedMessagesRead(ids, new Date().toISOString())
    unexaminedUnread = false
    rebuild()
    emit()
    const operations = orgs.map(async (org) => {
      let before: number | undefined
      while (epoch === storeEpoch) {
        const operation = write(api.messages.markAllRead, { org_id: org, before })
        run(operation)
        const result = await operation
        if (!result.hasMore) return
        before = result.before
      }
    })
    await Promise.allSettled(operations)
  },
  /* Back to unread — the same column, the other way. Nothing is pruned by
     it: the rows it re-opens are no longer read, which is exactly what the
     server's prune asks. */
  markMessagesUnread: (ids: string[]) => {
    const hit = ids.filter((id) => {
      const r = rows.messages.get(id)
      return r?.read_at
    })
    if (!hit.length) return
    const byOrg = messagesByOrg(hit)
    hit.forEach((id) => {
      rows.messages.get(id)!.read_at = undefined
    })
    rebuild()
    emit()
    byOrg.forEach((list, org) => {
      run(write(api.messages.markUnread, { org_id: org, ids: list }))
    })
  },
  /* Removing an item removes every message in it — the caller passes the
     whole list (P.messageGroups' ids). */
  deleteMessages: (ids: string[]) => {
    const hit = ids.filter((id) => rows.messages.has(id))
    if (!hit.length) return
    const byOrg = messagesByOrg(hit)
    hit.forEach((id) => {
      rows.messages.delete(id)
    })
    rebuild()
    emit()
    byOrg.forEach((list, org) => {
      run(write(api.messages.remove, { org_id: org, ids: list }))
    })
  },
  /* Inbox cleanup spans every seat and the full server inbox, beyond the
     snapshot's display cap. Each bounded batch selects current read rows,
     so unread arrivals and messages reopened on another device survive.
     Completion means all writes settled; run handles refusal/rollback. */
  deleteReadMessages: async (): Promise<void> => {
    if (!PLANNER.canRemoveRead) return
    const epoch = storeEpoch
    const orgs = [...myProfiles.keys()]
    const ids = PLANNER.messages
      .filter((message) => message.read && message.snoozedUntil === null)
      .map((message) => message.id)
    ids.forEach((id) => {
      rows.messages.delete(id)
    })
    hiddenReadMessages = 0
    unexaminedRead = false
    rebuild()
    emit()
    const operations = orgs.map(async (org) => {
      while (epoch === storeEpoch) {
        const operation = write(api.messages.removeRead, { org_id: org })
        run(operation)
        const result = await operation
        if (!result.hasMore) return
      }
    })
    await Promise.allSettled(operations)
  },
  markMessageRead: (id: string) => {
    PLANNER.markMessagesRead([id])
  },
  deleteMessage: (id: string) => {
    PLANNER.deleteMessages([id])
  },
  /* Snooze an item until an ISO instant, or bring it back now (null). Both
     leave it UNREAD — a reminder returns bold. The ids name the item; the
     server stamps every row of the (recipient, task) pair, so the mirror
     walks the loaded rows of the same pairs rather than just the ids. The
     timed return is the server's scheduled wake (messages.wake), never a
     client timer — every device shows it at the same instant. */
  snoozeMessages: (ids: string[], until: string | null) => {
    const hit = ids.filter((id) => rows.messages.has(id))
    if (!hit.length) return
    const byOrg = messagesByOrg(hit)
    const pairs = new Set(
      hit.map((id) => {
        const r = rows.messages.get(id)!
        return `${r.recipient_id}\n${r.issue_id}`
      }),
    )
    rows.messages.forEach((r) => {
      if (!pairs.has(`${r.recipient_id}\n${r.issue_id}`)) return
      if (until === null) {
        if (r.snoozed_until === undefined) return
        r.snoozed_until = undefined
        r.read_at = undefined
      } else {
        r.snoozed_until = until
        r.read_at = undefined
        r.woke_at = undefined
      }
    })
    rebuild()
    emit()
    byOrg.forEach((list, org) => {
      run(write(api.messages.snooze, { org_id: org, ids: list, until }))
    })
  },

  /* How long this person keeps a message they have read (0110); null = for
     ever. Fans out across every seat of this login server-side (auth +
     address arms); the optimistic mirror walks the auth arm, exactly as the
     old echo did — the delivery trues any invited-seat stragglers. */
  setMessageRetention: (days: number | null) => {
    const me = rows.profiles.get(CURRENT_USER)
    if (!me) return
    ;[...rows.profiles.values()]
      .filter((p) => p.auth_user_id && p.auth_user_id === me.auth_user_id)
      .forEach((p) => {
        p.message_retention_days = days == null ? undefined : days
      })
    rebuild()
    emit()
    run(write(api.profiles.setMessageRetention, { days }))
  },

  /* Account appearance stays separate from the navigation prefs blob and the
     planner snapshot. The app provider applies it across every planner view. */
  watchAppearance: (
    receive: (preferences: AppearancePreferences) => void,
    fail: (error: Error) => void,
  ) => convex.onUpdate(api.appearance.get, {}, receive, fail),
  setAppearance: (preferences: Pick<AppearancePreferences, 'mode' | 'image_source'>) => {
    const pending = write(api.appearance.save, preferences)
    run(pending)
    return pending
  },
  removeAppearanceImage: () => {
    const pending = write(api.appearance.removeCustom, {})
    run(pending)
    return pending
  },
  mintAppearanceImageUrl: async () => {
    const image = await convex.query(api.appearance.mintCustomUrl, {})
    return image
      ? {
          ...image,
          url: browserBackendUrl(image.url),
          preview_url: image.preview_url ? browserBackendUrl(image.preview_url) : null,
        }
      : null
  },
  uploadAppearanceImage: (file: File, signal: AbortSignal): Promise<AppearancePreferences> => {
    const pending = (async () => {
      const ticket = await write(api.appearance.createUpload, { name: file.name })
      try {
        if (signal.aborted) throw new DOMException('Upload canceled', 'AbortError')
        const response = await fetch(browserBackendUrl(ticket.upload_url), {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
          signal,
        })
        const result = await response.json()
        if (!response.ok)
          throw new Error(result?.error?.message || 'The image upload failed. Please try again.')
        return result as AppearancePreferences
      } catch (error) {
        await write(api.appearance.cancelUpload, { ticket_id: ticket.ticket_id }).catch(() => {})
        throw error
      }
    })()
    // Leaving account settings cancels an in-flight upload. Still release
    // run()'s paint gate, without reporting intentional cancellation as a
    // failed preference save in the next screen.
    run(
      pending.catch((error) => {
        if (signal.aborted) return null
        throw error
      }),
    )
    return pending
  },

  /* Your own name (0116) — renames EVERY seat this login holds. Awaited,
     never optimistic (refusable, and an optimistic write would be taken back
     in front of the person who made it); the server RETURNS the rule
     sentence rather than throwing it, and the snapshot delivery repaints
     every seat — no manual fan-out echo. Returns an error string, or null
     when it landed. */
  setDisplayName: async (name: string): Promise<string | null> => {
    const me = rows.profiles.get(CURRENT_USER)
    if (!me) return 'You are not signed in'
    // collapse runs of whitespace as well as trimming, exactly as the server
    // does, so what the field echoes back is what would be stored
    const next = String(name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!next) return 'A name cannot be blank'
    if ([...next].length > NAME_MAX) return `A name is at most ${NAME_MAX} characters`
    if (next === me.name) return null
    let sentence: string | null
    try {
      sentence = await write(api.profiles.setDisplayName, { name: next })
    } catch (e) {
      console.error('[qivo] rename failed:', e)
      return errData(e).code === 'paused' ? PAUSED_TEXT : 'That name could not be saved'
    }
    if (sentence) return sentence.charAt(0).toUpperCase() + sentence.slice(1)
    return null
  },

  /* ---- agent keys (Settings → Organization → Users) ----
     An agent's key is its login (0100). Keys live outside the snapshot, so
     the family is fetched on demand and every mutator is AWAITED: the secret
     exists only in createAgentKey's return value, minted in the browser —
     the server keeps a SHA-256 and a display fingerprint, nothing more. */
  listAgentKeys: async () => {
    let keys: FunctionReturnType<typeof api.tokens.listAgentKeys>
    try {
      keys = await convex.query(api.tokens.listAgentKeys, {})
    } catch (e) {
      console.error('[qivo] agent key list failed:', e)
      return null
    }
    // remember each key's org: revoke/delete take only the key id, and the
    // wrapper needs the AGENT's organization to pick the caller's seat
    keys.forEach((k) => {
      const agent = rows.profiles.get(k.agentId)
      if (agent) agentKeyOrg.set(k.id, agent.org_id)
    })
    return keys
  },

  /** Mints an agent's key in the browser and stores only its hash. Returns
      the secret once, or null when it could not be made or the server refused
      it. It never throws, because both callers on the Users page recover
      only from null. */
  createAgentKey: withUpdateBlock(async (agentId: string, name: string) => {
    const agent = rows.profiles.get(agentId)
    const org = agent ? agent.org_id : HOME_ORG
    try {
      const { id, secret, hash } = await mintCredential('qva')
      await write(api.tokens.createAgentKey, {
        org_id: org,
        id,
        agent_id: agentId,
        name,
        key_prefix: `${secret.slice(0, 7)}...${secret.slice(-5)}`,
        key_hash: hash,
      })
      agentKeyOrg.set(id, org)
      return { id, secret }
    } catch (e) {
      console.error('[qivo] agent key create failed:', e)
      return null
    }
  }),

  revokeAgentKey: async (id: string) => {
    try {
      await write(api.tokens.revokeAgentKey, {
        org_id: agentKeyOrg.get(id) || HOME_ORG,
        id,
      })
      return true
    } catch (e) {
      console.error('[qivo] agent key revoke failed:', e)
      return false
    }
  },

  deleteAgentKey: async (id: string) => {
    try {
      await write(api.tokens.deleteAgentKey, {
        org_id: agentKeyOrg.get(id) || HOME_ORG,
        id,
      })
      return true
    } catch (e) {
      console.error('[qivo] agent key delete failed:', e)
      return false
    }
  },

  /* ---- API access (Settings → Organization → API access) ----
     An admin's list of every credential in the home organization with its
     calls in one usage period. Fetched on demand: each API call changes the
     rows, so a subscription would re-render on every call. Null when the
     list could not be loaded. */
  listApiAccess: async (period?: string) => {
    try {
      return await convex.query(api.apiAccess.list, {
        org_id: HOME_ORG,
        ...(period === undefined ? {} : { period }),
      })
    } catch (e) {
      console.error('[qivo] API access list failed:', e)
      return null
    }
  },

  /** Revokes any credential in the home organization as its admin. Resolves
      whether the server accepted it; revoking one that is already revoked
      counts as accepted. */
  revokeApiCredential: async (table: ApiCredentialTable, id: string) => {
    try {
      await write(api.apiAccess.revoke, { org_id: HOME_ORG, table, id })
      return true
    } catch (e) {
      console.error('[qivo] API credential revoke failed:', e)
      return false
    }
  },

  /* ---- OAuth connections (self-service, separately listed from tokens) ---- */
  getOAuthConnectionContext: async (oauthQuery: string) => {
    const operation = write(api.oauthConnections.getContext, { oauth_query: oauthQuery })
    run(operation)
    return await operation
  },
  listOAuthConnections: async () => {
    try {
      return await convex.query(api.oauthConnections.list, {})
    } catch {
      return null
    }
  },
  revokeOAuthConnection: async (id: string) => {
    const operation = write(api.oauthConnections.revoke, { id })
    run(operation)
    try {
      await operation
      return true
    } catch {
      return false
    }
  },

  /* ---- personal MCP tokens (Settings → Your preferences) ----
     Same on-demand pattern. The owner manages their own tokens here
     (authedMutations, no org_id) and nothing narrates; an organization admin
     can also list and revoke them on API access (listApiAccess above). */
  listMcpTokens: async () => {
    try {
      return await convex.query(api.tokens.listMcpTokens, {})
    } catch (e) {
      console.error('[qivo] mcp token list failed:', e)
      return null
    }
  },

  /** Mints a personal token in the browser and stores only its hash. Returns
      the secret once, or null when it could not be made or the server refused
      it. It never throws, because the New token dialog recovers only from
      null. crypto.subtle and randomUUID are missing outside a secure context. */
  createMcpToken: withUpdateBlock(async (name: string, { access, expiresAt }: McpTokenChoice) => {
    try {
      const { id, secret, hash } = await mintCredential('qvt')
      await write(api.tokens.createMcpToken, {
        id,
        profile_id: CURRENT_USER,
        name,
        token_prefix: secret.slice(0, 11),
        token_hash: hash,
        access,
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      })
      return { id, secret }
    } catch (e) {
      console.error('[qivo] mcp token create failed:', e)
      return null
    }
  }),

  revokeMcpToken: async (id: string) => {
    try {
      await write(api.tokens.revokeMcpToken, { id })
      return true
    } catch (e) {
      console.error('[qivo] mcp token revoke failed:', e)
      return false
    }
  },

  deleteMcpToken: async (id: string) => {
    try {
      await write(api.tokens.deleteMcpToken, { id })
      return true
    } catch (e) {
      console.error('[qivo] mcp token delete failed:', e)
      return false
    }
  },

  /** Paints the project at once and returns its uuid. `onSaved` runs once the
      server has stored it. `onRefused` runs after the refusal toast, just
      before the rollback removes the optimistic rows. */
  addProject: (p: NewProjectInput, onSaved?: () => void, onRefused?: () => void) => {
    const parentOrg = p.parent ? orgOfProject(p.parent) : ''
    const orgRow = rows.orgs.get(parentOrg || HOME_ORG)
    if (!orgRow || refusePausedEdit()) return
    const uuid = crypto.randomUUID()
    const siblings = p.parent
      ? [...rows.projects.values()].filter((x) => x.parent_id === p.parent)
      : [...rows.projects.values()].filter((x) => x.type === 'meta')
    // projects.num is a per-org durable number used only in links (0050);
    // preview it like addIssue previews issue numbers, reconcile in onOk
    const previewNum = (orgRow.next_project_num || 0) + 1
    orgRow.next_project_num = previewNum
    const row: Row<'projects'> = {
      id: uuid,
      org_id: orgRow.id,
      type: p.type,
      parent_id: p.parent || undefined,
      key: p.key,
      num: previewNum,
      name: p.name,
      icon: p.type === 'meta' ? p.icon || undefined : undefined,
      icon_color: p.type === 'meta' ? p.iconColor || undefined : undefined,
      lead_id: p.lead || profileIn(orgRow.id),
      description: p.description || '',
      sort_order: siblings.length,
      track_delay: true,
      created_at: new Date().toISOString(),
    }
    rows.projects.set(uuid, row)
    // the grant rows the server stores: the caller's map ('lead' entries are
    // carried by lead_id, null ones name no grant) and the creator's own
    const grants = newProjectGrants(p, profileIn(orgRow.id), row.lead_id || '')
    Object.entries(grants).forEach(([uid, level]) => {
      rows.access.push({ project_id: uuid, profile_id: uid, level })
    })
    const teamAccess = p.teamAccess ?? {}
    Object.entries(teamAccess).forEach(([teamId, level]) => {
      rows.teamAccess.push({ project_id: uuid, team_id: teamId, level })
    })
    rebuild()
    emit()
    // ONE mutation carries row + access map; the follow-up grant upsert died
    run(
      write(api.projects.create, {
        org_id: orgRow.id,
        id: uuid,
        type: p.type,
        parent_id: p.type === 'meta' ? null : p.parent,
        key: p.key,
        name: p.name,
        icon: p.type === 'meta' ? p.icon || undefined : undefined,
        icon_color: p.type === 'meta' ? p.iconColor || undefined : undefined,
        lead_id: row.lead_id,
        description: p.description || '',
        sort_order: row.sort_order,
        track_delay: row.track_delay,
        access: p.access || {},
        team_access: p.teamAccess,
      }),
      (created) => {
        const o = rows.orgs.get(row.org_id)
        if (o) o.next_project_num = Math.max(o.next_project_num || 0, created.num)
        // the server replaces a key held by an archived or hidden project
        const cur = rows.projects.get(uuid)
        if (cur && (cur.num !== created.num || cur.key !== created.key)) {
          cur.num = created.num
          cur.key = created.key
          rebuild()
          emit()
        }
        onSaved?.()
      },
      undefined,
      (error) => {
        toastCreateProjectError(
          error,
          `${p.type === 'meta' ? 'project' : 'sub-project'} “${p.name}”`,
        )
        onRefused?.()
      },
    )
    return uuid
  },

  /* Paints the change at once and sends it. Resolves true when the server
     accepts it or nothing needed sending, false when it is missing here or
     refused by the server (toasted). removeAccess waits on it. */
  updateProject: (id: string, patch: ProjectPatch): Promise<boolean> => {
    const row = rows.projects.get(id)
    if (!row || refusePausedEdit()) return Promise.resolve(false)
    if ('teamAccess' in patch) {
      rows.teamAccess = rows.teamAccess.filter((a) => a.project_id !== id)
      Object.entries(patch.teamAccess || {}).forEach(([teamId, level]) => {
        rows.teamAccess.push({ project_id: id, team_id: teamId, level })
      })
    }
    if ('access' in patch) {
      // diff the access map into project_access rows; 'lead' entries are
      // carried by projects.lead_id, never stored as grant rows. Field patch
      // and grant diff commit in ONE mutation server-side — the old
      // accessGate write-ordering died with the two-statement dance.
      const next: Record<string, Row<'project_access'>['level']> = {}
      Object.entries(patch.access || {}).forEach(([uid, level]) => {
        if (level !== 'lead') next[uid] = level
      })
      rows.access = rows.access.filter((a) => !(a.project_id === id && !(a.profile_id in next)))
      Object.keys(next).forEach((uid) => {
        const ex = rows.access.find((a) => a.project_id === id && a.profile_id === uid)
        if (ex) ex.level = next[uid]
        else rows.access.push({ project_id: id, profile_id: uid, level: next[uid] })
      })
    }
    // a lead handover without an access map: the server keeps the outgoing
    // lead as User and drops the incoming lead's own grant
    if ('lead' in patch && !('access' in patch) && patch.lead && patch.lead !== row.lead_id) {
      const after = grantsAfterHandover(grantsOn(id), row.lead_id, patch.lead)
      rows.access = rows.access.filter((a) => a.project_id !== id)
      Object.entries(after).forEach(([uid, level]) => {
        rows.access.push({ project_id: id, profile_id: uid, level })
      })
    }
    const db: Partial<Row<'projects'>> = {}
    if ('name' in patch) db.name = patch.name
    if ('icon' in patch) db.icon = patch.icon || undefined
    if ('iconColor' in patch) db.icon_color = patch.iconColor || undefined
    if ('lead' in patch) db.lead_id = patch.lead || undefined
    if ('description' in patch) db.description = patch.description || ''
    if ('key' in patch) db.key = patch.key
    if ('trackDelay' in patch) db.track_delay = !!patch.trackDelay
    if ('reviewHours' in patch) db.review_hours = patch.reviewHours ?? undefined
    Object.assign(row, db)
    rebuild()
    emit()
    const wire: FunctionArgs<typeof api.projects.update>['patch'] = {}
    if ('name' in patch) wire.name = patch.name
    if ('icon' in patch) wire.icon = patch.icon || null
    if ('iconColor' in patch) wire.icon_color = patch.iconColor || null
    if ('lead' in patch) wire.lead_id = patch.lead || null
    if ('description' in patch) wire.description = patch.description || ''
    if ('key' in patch) wire.key = patch.key
    if ('trackDelay' in patch) wire.track_delay = !!patch.trackDelay
    if ('reviewHours' in patch) wire.review_hours = patch.reviewHours ?? null
    if ('access' in patch) wire.access = patch.access || {}
    if ('teamAccess' in patch) wire.team_access = patch.teamAccess || {}
    if (!Object.keys(wire).length) return Promise.resolve(true)
    return runSaved(write(api.projects.update, { org_id: row.org_id, id, patch: wire }))
  },

  /* Archive a project (0106). The row stays — that is the difference between
     archiving and deleting — but everything it holds leaves the working
     snapshot on the spot. The server cascade carries the active subs on the
     parent's own stamp; mirrored here on one timestamp so the optimistic
     snapshot and the delivery agree about which of them came along. */
  archiveProject: (id: string) => {
    const row = rows.projects.get(id)
    if (!row || row.archived_at || refusePausedEdit()) return
    const stamp = new Date().toISOString()
    const ids =
      row.type === 'meta'
        ? [
            id,
            ...[...rows.projects.values()]
              .filter((x) => x.parent_id === id && !x.archived_at)
              .map((x) => x.id),
          ]
        : [id]
    const issueIds = [...rows.issues.values()]
      .filter((i) => ids.includes(i.project_id))
      .map((i) => i.id)
    ids.forEach((pid) => {
      const r = rows.projects.get(pid)
      if (r) r.archived_at = stamp
    })
    issueIds.forEach((iid) => {
      // A project archive hides its tasks; it does not archive the tasks.
      // Preserve grouping for parents that remain visible in other projects.
      const parentId = rows.issues.get(iid)?.parent_id
      if (parentId) rows.hiddenSubtaskParents.add(parentId)
      rows.issues.delete(iid)
    })
    // and a child left in another project now has its parent outside this
    // view, as the next delivery says
    for (const r of rows.issues.values()) {
      if (r.parent_id && issueIds.includes(r.parent_id)) {
        r.parent_id = undefined
        rows.hiddenParentTasks.add(r.id)
      }
    }
    ;[...rows.milestones.values()].forEach((m) => {
      if (ids.includes(m.project_id)) rows.milestones.delete(m.id)
    })
    ;[...rows.links.values()].forEach((l) => {
      if (!rows.issues.has(l.source_id) || !rows.issues.has(l.target_id)) rows.links.delete(l.id)
    })
    rows.issueLabels = rows.issueLabels.filter((il) => rows.issues.has(il.issue_id))
    rebuild()
    emit()
    run(write(api.projects.archive, { org_id: row.org_id, id }))
  },

  /** Restore an archived project. Awaited rather than optimistic: its tasks
      are not in this client at all, and the snapshot pulls them back in
      reactively. Resolves false when the write was refused (toasted). */
  unarchiveProject: async (id: string): Promise<boolean> => {
    const row = rows.projects.get(id)
    if (!row) return false
    try {
      await write(api.projects.unarchive, { org_id: row.org_id, id })
    } catch (e) {
      console.error('[qivo] restore failed:', e)
      toast(restoreErrorText(e))
      return false
    }
    return true
  },

  /** What archiving or deleting a project takes along, for its Archive or
      delete window: the sub-projects, archived ones included, and the tasks
      of the whole tree, archived ones included (the server stops counting
      past 5,000 and says so with `more`). Asked only when the window opens,
      because only the project's lead may read it. Null when refused or
      unreachable. */
  projectRemovalSummary: async (id: string): Promise<ProjectRemovalSummary | null> => {
    const row = rows.projects.get(id)
    if (!row) return null
    try {
      return await convex.query(api.projects.removalSummary, { org_id: row.org_id, id })
    } catch (e) {
      console.error('[qivo] removal summary failed:', e)
      return null
    }
  },

  /** Restore Deleted items (Settings, Deleted items). Awaited, never
      optimistic: the work comes back through the snapshot, and the page's
      list drops the items as the server does. Sent per organization, 25 ids
      at a time. `bulk` marks every call as part of a restore of several
      items, so that a call left with one task item sends no Restored notice;
      a single row's Restore leaves it out. Never toasts; the page says what
      happened. */
  restoreDeletedItems: (
    items: { id: string; org_id: string }[],
    { bulk = false }: { bulk?: boolean } = {},
  ): Promise<DeletedItemsOutcome<RestoreRefusal>> =>
    deletedItemsCalls(
      items,
      (orgId, ids) =>
        write(api.deletedItems.restore, { org_id: orgId, ids, ...(bulk ? { bulk } : {}) }),
      "Couldn't restore",
    ),

  /** Delete now, where an organization admin deletes Deleted items for good.
      Awaited like restoreDeletedItems, and never toasts either. */
  purgeDeletedItems: (
    items: { id: string; org_id: string }[],
  ): Promise<DeletedItemsOutcome<PurgeRefusal>> =>
    deletedItemsCalls(
      items,
      (orgId, ids) => write(api.deletedItems.purge, { org_id: orgId, ids }),
      "Couldn't delete it for good",
    ),

  /* Move a project, its sub-projects and every task in them to Deleted
     items. Awaited, as the Archive or delete window asks. Nothing changes
     here until the server accepts, so a refusal (toasted) leaves the project
     and the window in place. `reason` is shown in Deleted items. Resolves
     whether the server deleted it. */
  removeProject: (id: string, reason?: string): Promise<boolean> => {
    const row = rows.projects.get(id)
    if (!row || refusePausedEdit()) return Promise.resolve(false)
    const text = (reason || '').trim()
    const epoch = storeEpoch
    return write(api.projects.deleteDeep, {
      org_id: row.org_id,
      id,
      ...(text ? { reason: text } : {}),
    }).then(
      () => {
        // the delivery may already hold the result; the mirror finds nothing
        // then. Kept for a rollback, as task deletes are.
        if (epoch === storeEpoch) {
          if (rows.projects.has(id)) pendingProjectDeletes.add(id)
          mirrorProjectDelete(id)
        }
        return true
      },
      (error) => {
        console.error('[qivo] project delete failed:', error)
        if (epoch === storeEpoch) toastWriteError(error)
        return false
      },
    )
  },

  /* Organization settings — the old six independent UPDATEs fold into ONE
     patch mutation; the client clamps stay (the field must show what will be
     stored before it is). Narrates nothing, name included. */
  setOrg: (patch: OrgPatch) => {
    const org = homeRow()
    if (!org || refusePausedEdit()) return
    const wire: FunctionArgs<typeof api.orgs.update>['patch'] = {}
    if ('name' in patch) {
      org.name = patch.name
      wire.name = patch.name
    }
    if ('dateFormat' in patch && DATE_FORMATS.includes(patch.dateFormat)) {
      org.date_format = patch.dateFormat
      wire.date_format = patch.dateFormat
    }
    if (
      'weekStart' in patch &&
      Number.isInteger(patch.weekStart) &&
      patch.weekStart >= 0 &&
      patch.weekStart <= 6
    ) {
      org.week_start = patch.weekStart
      wire.week_start = patch.weekStart
    }
    if (
      'weekOneRule' in patch &&
      (WEEK_ONE_RULES as readonly string[]).includes(patch.weekOneRule)
    ) {
      org.week_one_rule = patch.weekOneRule
      wire.week_one_rule = patch.weekOneRule
    }
    if ('defaultPlannableHours' in patch) {
      // whole hours, within the server check [1, 168] — the same clamp the
      // per-person setter uses, since this is the value it starts from
      const h = Math.max(1, Math.min(168, Math.round(Number(patch.defaultPlannableHours) || 0)))
      org.default_plannable_hours = h
      wire.default_plannable_hours = h
    }
    if ('maxAttachmentMb' in patch) {
      const mb = Math.max(1, Math.min(20, Math.round(Number(patch.maxAttachmentMb) || 0)))
      org.max_attachment_mb = mb
      wire.max_attachment_mb = mb
    }
    if ('projectCreators' in patch && isProjectCreators(patch.projectCreators)) {
      org.project_creators = patch.projectCreators
      wire.project_creators = patch.projectCreators
    }
    if ('gravatarAvatars' in patch) {
      // turning it ON has to prime the hashes rebuild() skipped while it was
      // off — rebuild below does exactly that
      const on = !!patch.gravatarAvatars
      org.gravatar_avatars = on
      wire.gravatar_avatars = on
    }
    if (!Object.keys(wire).length) return
    rebuild() // re-anchors the grid when the week settings moved
    emit()
    run(write(api.orgs.update, { org_id: org.id, patch: wire }))
  },

  /** Change the organization's address — the first segment under /app/.
      Returns an error string, or null when it landed. AWAITED, never
      optimistic: the slug is the one organization column whose local value
      IS an address, so an optimistic write would move the address bar to a
      slug the server never accepted. The refusal taxonomy — taken /
      reserved / malformed — survives as sentences via ConvexError
      {code:'conflict', reason}; the FORMAT rule is mirrored here so the
      obvious typo answers without a round trip. */
  setOrgSlug: async (next: string): Promise<string | null> => {
    const org = homeRow()
    if (!org) return 'Only an organization you belong to has an address'
    const slug = String(next || '')
      .trim()
      .toLowerCase()
    if (!slug) return 'An address cannot be empty'
    if (slug === org.slug) return null
    if (slug.length > 40 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      return 'Use lowercase letters, digits and single hyphens; 40 characters maximum.'
    }
    try {
      await write(api.orgs.setSlug, { org_id: org.id, slug })
    } catch (e) {
      console.error('[qivo] slug change failed:', e)
      return slugErrorText(e)
    }
    // patch the live row so the address-bar sync moves NOW rather than a
    // delivery later — the awaited write already proved the value
    const live = rows.orgs.get(org.id)
    if (live) live.slug = slug
    rebuild()
    emit()
    return null
  },

  addTeam: (name: string) => {
    const org = homeRow()
    if (!org || !String(name || '').trim() || refusePausedEdit()) return
    const uuid = crypto.randomUUID()
    rows.teams.set(uuid, {
      id: uuid,
      org_id: org.id,
      name,
      stale_days: 120,
      archive_days: 30,
      track_delay_default: true,
      created_at: new Date().toISOString(),
    })
    rebuild()
    emit()
    run(write(api.teams.create, { org_id: org.id, id: uuid, name }))
    return uuid
  },

  updateTeam: (id: string, patch: TeamPatch) => {
    const row = rows.teams.get(id)
    if (!row || refusePausedEdit()) return
    const wire: FunctionArgs<typeof api.teams.update>['patch'] = {}
    if ('name' in patch) {
      row.name = patch.name
      wire.name = patch.name
    }
    if ('icon' in patch) {
      row.icon = patch.icon || undefined
      wire.icon = patch.icon || null
    }
    if ('iconColor' in patch) {
      row.icon_color = patch.iconColor || undefined
      wire.icon_color = patch.iconColor || null
    }
    if ('staleDays' in patch) {
      // whole days, within the server check [1, 3650]
      const d = Math.max(1, Math.min(3650, Math.round(Number(patch.staleDays) || 0)))
      row.stale_days = d
      wire.stale_days = d
    }
    if ('archiveDays' in patch) {
      const d = Math.max(1, Math.min(3650, Math.round(Number(patch.archiveDays) || 0)))
      row.archive_days = d
      wire.archive_days = d
    }
    if ('trackDelayDefault' in patch) {
      const on = !!patch.trackDelayDefault
      row.track_delay_default = on
      wire.track_delay_default = on
    }
    if (!Object.keys(wire).length) return
    rebuild()
    emit()
    run(write(api.teams.update, { org_id: row.org_id, id, patch: wire }))
  },

  /* --- team membership (managed in Team settings) ------------------------- */
  addTeamMember: (teamId: string, uid: string, _isLeader = false) => {
    const team = rows.teams.get(teamId)
    if (!team || rows.teamMembers.some((m) => m.team_id === teamId && m.profile_id === uid)) return
    if (refusePausedEdit()) return
    // the server always inserts a plain member; leadership is its own verb
    rows.teamMembers.push({ team_id: teamId, profile_id: uid, is_leader: false })
    rebuild()
    emit()
    run(
      write(api.teams.addMember, {
        org_id: team.org_id,
        team_id: teamId,
        profile_id: uid,
      }),
    )
  },

  setTeamLeader: (teamId: string, uid: string, isLeader: boolean) => {
    const team = rows.teams.get(teamId)
    const row = rows.teamMembers.find((m) => m.team_id === teamId && m.profile_id === uid)
    if (!team || !row || row.is_leader === isLeader || refusePausedEdit()) return
    row.is_leader = isLeader
    rebuild()
    emit()
    run(
      write(api.teams.setLeader, {
        org_id: team.org_id,
        team_id: teamId,
        profile_id: uid,
        is_leader: isLeader,
      }),
    )
  },

  /* Resolves whether the server deleted the team; false for a missing team
     or the last team of its organization, which the server refuses. */
  removeTeam: (id: string): Promise<boolean> => {
    if (!PLANNER.canDeleteTeam(id)) return Promise.resolve(false)
    const team = rows.teams.get(id)
    if (!team || refusePausedEdit()) return Promise.resolve(false)
    // Projects are independent of teams. Deleting a team removes only its
    // memberships and permission grants; project rows and their work remain.
    // labels are org-wide since 0078 — deleting a team leaves them alone
    rows.issueLabels = rows.issueLabels.filter((il) => rows.issues.has(il.issue_id))
    rows.issueSubs = rows.issueSubs.filter((s) => rows.issues.has(s.issue_id))
    rows.teamMembers = rows.teamMembers.filter((m) => m.team_id !== id)
    rows.teamAccess = rows.teamAccess.filter((a) => a.team_id !== id)
    rows.teams.delete(id)
    rebuild()
    emit()
    return runSaved(write(api.teams.deleteDeep, { org_id: team.org_id, id }))
  },
  /** Whether a team exists and is not the last one in its organization.
      Other organizations' teams in this client do not count. */
  canDeleteTeam: (id: string): boolean => {
    const team = rows.teams.get(id)
    return !!team && [...rows.teams.values()].filter((t) => t.org_id === team.org_id).length > 1
  },

  addUser: (rec: NewUserInput) => {
    const org = homeRow()
    if (!org || refusePausedEdit()) return
    // A person's address is REQUIRED (0104) — it is what their login is
    // matched against when they claim the seat. An agent's is always null;
    // its login is a key. Refusing here is only so the caller hears WHY.
    const isAgent = rec.kind === 'agent'
    const email = isAgent ? null : normalizeEmail(rec.email)
    if (!isAgent && !PLANNER.emailLooksValid(email)) {
      toast('Enter an email address for sign-in.')
      return
    }
    if (
      email &&
      [...rows.profiles.values()].some((p) => p.org_id === org.id && p.email === email)
    ) {
      toast(`${email} already has a seat in this organization`)
      return
    }
    const uuid = crypto.randomUUID()
    // the SAME rule the server applies on a rename (0116), so a person's
    // initials do not silently change shape the first time they rename
    const name = String(rec.name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const orgRole = rec.orgRole === 'viewer' ? 'viewer' : isAgent ? 'user' : rec.orgRole || 'user'
    const row: Row<'profiles'> = {
      id: uuid,
      org_id: org.id,
      email: email || undefined,
      name,
      initials: nameInitials(name),
      // the shared palette, which holds only colors the server stores
      color: AVATAR_COLORS[rows.profiles.size % AVATAR_COLORS.length],
      org_role: orgRole,
      kind: isAgent ? 'agent' : 'person',
      active: true,
      // the server stamps these from the org default / the retention
      // inheritance; predict the same numbers or the row flips on delivery
      plannable_hours: isAgent
        ? undefined
        : Number(org.default_plannable_hours) || DEFAULT_PLANNABLE_HOURS,
      message_retention_days: DEFAULT_MESSAGE_RETENTION_DAYS,
      // accepted_at ABSENT: the seat IS the invitation (0118's kept column)
      created_at: new Date().toISOString(),
    }
    rows.profiles.set(uuid, row)
    const teams: string[] = rec.teams || []
    teams.forEach((t) => {
      rows.teamMembers.push({ team_id: t, profile_id: uuid, is_leader: false })
    })
    rebuild()
    emit()
    // ONE mutation: profile + memberships land or none do (the two-step
    // insert died with the phase-5 port)
    run(
      write(api.profiles.create, {
        org_id: org.id,
        id: uuid,
        name,
        email: email,
        org_role: orgRole,
        kind: isAgent ? 'agent' : 'person',
        color: row.color,
        teams,
      }),
    )
    return uuid
  },

  /** Applies an admin's edit to one seat. Returns false when a client
      rule refused the whole patch (with a toast), so an inline editor can
      put the stored value back. */
  updateUser: (id: string, patch: UserPatch): boolean => {
    const row = rows.profiles.get(id)
    // deactivation alone only takes access away, so it goes on while paused
    const deactivation = Object.keys(patch).length === 1 && patch.active === false
    if (!row || (!deactivation && refusePausedEdit())) return false
    /* The client-predicted refusals stay audible first (the server states
       the same rules); a refusal here aborts the whole patch, matching the
       server's all-or-nothing mutation. */
    if ('name' in patch) {
      const next = String(patch.name ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!next) {
        toast('A name cannot be blank')
        return false
      }
      if ([...next].length > NAME_MAX) {
        toast(`A name is at most ${NAME_MAX} characters`)
        return false
      }
    }
    if ('email' in patch) {
      const next = normalizeEmail(patch.email)
      const taken =
        next &&
        [...rows.profiles.values()].some(
          (p) => p.id !== id && p.org_id === row.org_id && p.email === next,
        )
      if (row.kind === 'agent') {
        toast('An agent has no email address. Its login is a key.')
        return false
      }
      if (row.auth_user_id) {
        toast('This email cannot be changed after the user has signed in.')
        return false
      }
      if (!PLANNER.emailLooksValid(next)) {
        toast('Enter an email address for sign-in.')
        return false
      }
      if (taken) {
        toast(`${next} already has a seat in this organization`)
        return false
      }
    }
    // teams diff — the membership mirror; the server diffs the same list
    if ('teams' in patch) {
      const next: string[] = patch.teams || []
      const prev = rows.teamMembers.filter((m) => m.profile_id === id).map((m) => m.team_id)
      const del = prev.filter((t) => !next.includes(t))
      rows.teamMembers = rows.teamMembers.filter(
        (m) => !(m.profile_id === id && del.includes(m.team_id)),
      )
      next
        .filter((t) => !prev.includes(t))
        .forEach((t) => {
          rows.teamMembers.push({ team_id: t, profile_id: id, is_leader: false })
        })
    }
    // Capacity has its own write path (0094): the column may also be set by
    // a team's LEADER, so it is its own mutation (orgMutation, not admin).
    // An agent has no plannable week (0103) — skipping rather than clamping
    // matters: Math.min(168, Infinity) is 168, the loudest wrong answer.
    if ('plannableHours' in patch && row.kind !== 'agent') {
      const h = Math.max(1, Math.min(168, Math.round(Number(patch.plannableHours) || 0)))
      row.plannable_hours = h
      run(
        write(api.profiles.setPlannableHours, {
          org_id: row.org_id,
          profile_id: id,
          hours: h,
        }),
      )
    }
    const db: Partial<Row<'profiles'>> = {}
    const wire: FunctionArgs<typeof api.profiles.update>['patch'] = {}
    // computed before the role lands; the role select sends orgRole even when
    // it is unchanged, and only a real change clears the right
    const right = projectRightAfterUpdate(row, {
      org_role: patch.orgRole,
      can_create_projects: 'canCreateProjects' in patch ? !!patch.canCreateProjects : undefined,
    })
    if ('orgRole' in patch) {
      db.org_role = patch.orgRole
      wire.org_role = patch.orgRole
    }
    // Activation contributes to the billable count at monthly renewal.
    if ('active' in patch) {
      db.active = !!patch.active
      wire.active = !!patch.active
    }
    // the server stores the same value (projectRightAfterUpdate)
    if ('canCreateProjects' in patch) wire.can_create_projects = !!patch.canCreateProjects
    if (right !== row.can_create_projects) db.can_create_projects = right
    /* The admin door onto the name pair (deviation #93): writes ONE row —
       an admin's authority stops at their organization; set_display_name's
       every-seat fan-out is the other door, and they are different rules. */
    if ('name' in patch) {
      const next = String(patch.name ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      if (next !== row.name) {
        db.name = next
        db.initials = nameInitials(next)
        wire.name = next
      }
    }
    if ('email' in patch) {
      const next = normalizeEmail(patch.email)
      db.email = next || undefined
      wire.email = next
    }
    if ('teams' in patch) wire.teams = patch.teams || []
    Object.assign(row, db)
    rebuild()
    emit()
    // Deactivation alone has its own door, which an admin can still use while
    // billing has paused editing. Every other change, reactivation included,
    // goes through update.
    const deactivateOnly = wire.active === false && Object.keys(wire).length === 1
    if (deactivateOnly) {
      run(write(api.profiles.deactivate, { org_id: row.org_id, id }))
    } else if (Object.keys(wire).length) {
      run(write(api.profiles.update, { org_id: row.org_id, id, patch: wire }))
    }
    return true
  },

  /** Does this look like an address the app can store? The UI asks before
      offering to write one; the server's own regex is the same shape. */
  emailLooksValid: (v: unknown) => {
    const e = normalizeEmail(v)
    return !!e && EMAIL_RE.test(e)
  },

  /* --- profile picture ------------------------------------------------------
     Who may: that person, or an admin of their organization. The server owns
     that rule; the UI mirrors it in what it offers. Both mutators are
     AWAITED, returning an error sentence or null — no run() rollback path. */

  /** True when this session may change that person's picture. Mirrors the
      server rule so the UI can hide a control that would be refused. */
  canSetAvatar: (profileId: string) => {
    const row = rows.profiles.get(profileId)
    if (!row) return false
    const me = rows.profiles.get(CURRENT_USER)
    if (myProfileSet.has(profileId)) return true
    return !!me && me.org_id === row.org_id && me.org_role === 'admin'
  },

  /** Upload a picture and hang it on the profile: files.avatarUploadUrl →
      POST → files.setAvatar. Returns an error string, or null when it landed.
      The mime and 2 MB pre-checks mirror the server's (the old avatars
      bucket's rules, now enforced in files.setAvatar) so a refusal is caught
      before any bytes move. bc022c2's bytes-first/rows-first ceremony
      collapses server-side: row-swap and old-byte delete commit atomically. */
  setAvatar: withUpdateBlock(async (profileId: string, file: File) => {
    const row = rows.profiles.get(profileId)
    if (!row) return 'That person is no longer in the organization'
    const type = (file.type || '').toLowerCase().split(';')[0].trim()
    if (!(AVATAR_TYPES as readonly string[]).includes(type)) {
      return 'A picture has to be a PNG, JPEG, WebP or GIF'
    }
    // scaled to 256px and re-encoded to WebP before it leaves the browser:
    // an avatar is fetched on nearly every screen, so the bytes matter more
    // here than anywhere else in the app
    const small = await avatarImage(file)
    if (small.size > 2 * 1024 * 1024) return 'A picture has to be at most 2 MB'
    let storageId: string
    try {
      const url = await write(api.files.avatarUploadUrl, { profile_id: profileId })
      const res = await fetch(browserBackendUrl(url), {
        method: 'POST',
        // the POST's Content-Type lands in storage metadata — it is what the
        // server's allowlist checks and what the gateway serves back
        headers: { 'Content-Type': small.type || 'application/octet-stream' },
        body: small,
      })
      if (!res.ok) return "Couldn't upload that picture"
      storageId = ((await res.json()) as { storageId: string }).storageId
      await write(api.files.setAvatar, {
        profile_id: profileId,
        storage_id: storageId as Id<'_storage'>,
      })
    } catch (e) {
      console.error('[qivo] avatar upload failed:', e)
      return avatarErrorText(e, "Couldn't set that picture")
    }
    // optimistic paint for the immediate repaint; the snapshot delivery
    // replaces the row reactively (no hand-carried re-read — adopt() brings
    // the row whole). Rebuild prunes/revokes the replaced portrait source.
    const live = rows.profiles.get(profileId)
    if (!live) return null // removed mid-upload; the server state is already right
    live.avatar_storage_id = storageId as Id<'_storage'>
    rebuild()
    emit()
    return null
  }),

  /** Drop the uploaded picture. The person falls back to Gravatar, then to
      their initials — there is no "no picture at all" state. */
  clearAvatar: async (profileId: string) => {
    const row = rows.profiles.get(profileId)
    if (!row?.avatar_storage_id) return null
    try {
      await write(api.files.clearAvatar, { profile_id: profileId })
    } catch (e) {
      console.error('[qivo] avatar clear failed:', e)
      return avatarErrorText(e, "Couldn't remove that picture")
    }
    const live = rows.profiles.get(profileId)
    if (live) {
      live.avatar_storage_id = undefined
      rebuild()
      emit()
    }
    return null
  },

  /* Removes a person or agent from the organization. The local copy mirrors
     what the server's removal clears in its own transaction (the SET NULL
     fires the touch server-side). rows.issues holds only open tasks. The
     server clears those at once, unless the profile holds hundreds. Then its
     first background steps clear the rest a moment later, and the server's
     copy names the id until they do. Archived tasks, comments, messages and
     the removed profile's subscriptions are cleared later in the background,
     and this client holds only its own subscriptions. The server also owns
     the avatar bytes, so there is no client-side reap. */
  removeUser: (id: string) => {
    if (id === CURRENT_USER) return
    const target = rows.profiles.get(id)
    if (!target) return
    const admins = [...rows.profiles.values()].filter((u) => u.org_role === 'admin')
    // removal only takes access away, so it goes on while edits are paused
    if (target.org_role === 'admin' && admins.length <= 1) return
    ;[...rows.issues.values()].forEach((i) => {
      if (
        i.assignee_id !== id &&
        i.reviewer_id !== id &&
        i.reporter_id !== id &&
        i.created_by !== id
      )
        return
      if (i.assignee_id === id) i.assignee_id = undefined
      if (i.reviewer_id === id) i.reviewer_id = undefined
      if (i.reporter_id === id) i.reporter_id = undefined
      if (i.created_by === id) i.created_by = undefined
      i.updated_at = new Date().toISOString()
    })
    rows.teamMembers = rows.teamMembers.filter((m) => m.profile_id !== id)
    rows.access = rows.access.filter((a) => a.profile_id !== id)
    ;[...rows.projects.values()].forEach((p) => {
      if (p.lead_id === id) p.lead_id = undefined
    })
    ;[...rows.activity.values()].forEach((e) => {
      if (e.actor_id === id) e.actor_id = undefined
    })
    rows.profiles.delete(id)
    rebuild()
    emit()
    run(write(api.profiles.remove, { org_id: target.org_id, id }))
  },

  /* Roles are viewer / user / lead; exactly one lead per project (the
     Lead field). Promoting someone hands the lead over and steps the old
     lead down to user. The current lead cannot be removed without a handover. A pure
     delegate to updateProject — one mutation carries grants and lead. */
  setProjectAccess: (
    metaId: string,
    userId: string,
    role: AccessLevel | null,
  ): Promise<boolean> => {
    const m = PLANNER.projects.find((p) => p.id === metaId)
    if (!m) return Promise.resolve(false)
    // row-level grants only — the 'lead' entry in m.access mirrors lead_id
    const acc = grantsOn(metaId)
    // a handover: the server keeps the outgoing lead as User
    // (convex/lib/projectGrants.ts grantsAfterHandover)
    if (role === 'lead') {
      if (m.lead === userId) return Promise.resolve(true)
      return PLANNER.updateProject(metaId, { lead: userId })
    }
    if (role) acc[userId] = role
    else delete acc[userId]
    // the lead's access is the Lead field: hand it over first
    if (m.lead === userId) return Promise.resolve(false)
    return PLANNER.updateProject(metaId, { access: acc })
  },

  setProjectTeamAccess: (
    metaId: string,
    teamId: string,
    role: TeamAccessLevel | null,
  ): Promise<boolean> => {
    const m = PLANNER.projects.find((p) => p.id === metaId)
    if (!m) return Promise.resolve(false)
    const teamAccess = { ...m.teamAccess }
    if (role) teamAccess[teamId] = role
    else delete teamAccess[teamId]
    return PLANNER.updateProject(metaId, { teamAccess })
  },

  setMilestone: (id: string, week: number) => {
    PLANNER.updateMilestone(id, { week })
  },

  /* Milestones sit on a project's roadmap (0078). The caller passes the meta
     project; a sub-project id is folded up to it. */
  addMilestone: (m: { project: string; name: string; week: number }) => {
    const meta = PLANNER.metaOf(m.project)
    if (!meta || refusePausedEdit()) return null
    const uuid = crypto.randomUUID()
    const week = weekToISO(m.week)
    rows.milestones.set(uuid, {
      id: uuid,
      project_id: meta.id,
      name: m.name,
      week,
      created_at: new Date().toISOString(),
    })
    rebuild()
    emit()
    if (
      !recordRoadmapChange({
        kind: 'milestone_create',
        id: uuid,
        project_id: meta.id,
        name: m.name,
        week,
      })
    )
      run(
        write(api.projects.addMilestone, {
          org_id: meta.org,
          id: uuid,
          project_id: meta.id,
          name: m.name,
          week,
        }),
      )
    return uuid
  },

  updateMilestone: (id: string, patch: { name?: string; week?: number }) => {
    const row = rows.milestones.get(id)
    if (!row) return
    const db: FunctionArgs<typeof api.projects.updateMilestone>['patch'] = {}
    if ('name' in patch) db.name = patch.name
    if (patch.week != null) db.week = weekToISO(patch.week)
    if (!Object.keys(db).length || refusePausedEdit()) return
    Object.assign(row, db)
    rebuild()
    emit()
    // moved/renamed verb logic is server-side now (it diffs against its row)
    if (!recordRoadmapChange({ kind: 'milestone_update', id, patch: db }))
      run(
        write(api.projects.updateMilestone, {
          org_id: orgOfProject(row.project_id),
          id,
          patch: db,
        }),
      )
  },

  removeMilestone: (id: string) => {
    const row = rows.milestones.get(id)
    if (!row || refusePausedEdit()) return
    const org = orgOfProject(row.project_id)
    rows.milestones.delete(id)
    rebuild()
    emit()
    if (!recordRoadmapChange({ kind: 'milestone_remove', id }))
      run(write(api.projects.removeMilestone, { org_id: org, id }))
  },

  /* --- labels: one shared, curated list per organization (0078) ------------ */
  addLabel: (rec: { name?: string; color?: string }) => {
    const name = (rec.name || '').trim().slice(0, 40)
    const org = homeRow()
    if (!name || !org) return null
    // the vocabulary is per ORGANIZATION and the cache is blended (0081):
    // a same-named label in a host org must not be returned as "already there"
    const dup = [...rows.labels.values()].find(
      (l) => l.org_id === org.id && l.name.toLowerCase() === name.toLowerCase(),
    )
    if (dup) return dup.id
    if (refusePausedEdit()) return null
    // the shared palette picks the color unless rec.color overrides it
    const color = rec.color || LABEL_COLORS[rows.labels.size % LABEL_COLORS.length].color
    const uuid = crypto.randomUUID()
    rows.labels.set(uuid, {
      id: uuid,
      org_id: org.id,
      name,
      name_lower: name.toLowerCase(),
      color,
      created_at: new Date().toISOString(),
    })
    rebuild()
    emit()
    run(write(api.labels.create, { org_id: org.id, id: uuid, name, color }))
    return uuid
  },

  /** Renames or recolors a label. Returns false when nothing was written,
      either refused with a toast or already stored, so an inline editor
      can put the stored name back. */
  updateLabel: (id: string, patch: { name?: string; color?: string }): boolean => {
    const row = rows.labels.get(id)
    if (!row || refusePausedEdit()) return false
    const wire: FunctionArgs<typeof api.labels.update>['patch'] = {}
    if ('name' in patch) {
      const name = (patch.name || '').trim().slice(0, 40)
      if (!name) return false
      // names are unique per organization, as in addLabel and on the server;
      // a guest's cache also holds the host organization's labels
      const dup = [...rows.labels.values()].find(
        (l) =>
          l.id !== id && l.org_id === row.org_id && l.name.toLowerCase() === name.toLowerCase(),
      )
      if (dup) {
        toast('A label with that name already exists')
        return false
      }
      if (name !== row.name) {
        row.name = name
        row.name_lower = name.toLowerCase()
        wire.name = name
      }
    }
    if ('color' in patch) {
      row.color = patch.color
      wire.color = patch.color
    }
    if (!Object.keys(wire).length) return false
    rebuild()
    emit()
    run(write(api.labels.update, { org_id: row.org_id, id, patch: wire }))
    return true
  },

  removeLabel: (id: string) => {
    const row = rows.labels.get(id)
    if (!row || refusePausedEdit()) return
    // the attach rows go with the label server-side — mirror the sweep
    rows.issueLabels = rows.issueLabels.filter((il) => il.label_id !== id)
    rows.labels.delete(id)
    rebuild()
    emit()
    run(write(api.labels.remove, { org_id: row.org_id, id }))
  },

  toggleIssueLabel: (issueId: string, labelId: string) => {
    const uuid = keyToUuid.get(issueId)
    const issue = uuid ? rows.issues.get(uuid) : null
    if (!uuid || !issue || !rows.labels.get(labelId) || refusePausedEdit()) return
    // the server toggles on ITS state, so a replay nets out either way
    const attached = rows.issueLabels.some((il) => il.issue_id === uuid && il.label_id === labelId)
    if (attached)
      rows.issueLabels = rows.issueLabels.filter(
        (il) => !(il.issue_id === uuid && il.label_id === labelId),
      )
    else rows.issueLabels.push({ issue_id: uuid, label_id: labelId })
    rebuild()
    emit()
    run(
      write(api.labels.toggle, {
        org_id: issue.org_id,
        issue_id: uuid,
        label_id: labelId,
      }),
    )
  },

  /* Each open subscriber popover owns its reactive roster; the shared
     snapshot continues to own the current user's eye indicator. */
  watchIssueSubscribers: (
    issueId: string,
    onChange: (value: IssueSubscribers) => void,
    onError: () => void,
  ): (() => void) => {
    const issue = PLANNER.issueById[issueId]
    if (!issue) {
      onError()
      return () => undefined
    }
    return convex.onUpdate(
      api.issues.subscribers,
      { org_id: issue.org, issue_id: issue.uuid },
      onChange,
      onError,
    )
  },

  setIssueSubscriber: (
    issueId: string,
    profileId: string,
    subscribed: boolean,
    onSettled: () => void,
    onSuccess?: () => void,
  ) => {
    const issue = PLANNER.issueById[issueId]
    if (!issue) {
      onSettled()
      return
    }
    run(
      write(api.issues.setSubscriber, {
        org_id: issue.org,
        issue_id: issue.uuid,
        profile_id: profileId,
        subscribed,
      }).finally(onSettled),
      onSuccess,
    )
  },

  /* Follow / stop following a task (0114). The server also subscribes users
     when they are assigned, mentioned or comment. */
  setIssueSubscribed: (issueId: string, on: boolean) => {
    const uuid = keyToUuid.get(issueId)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!uuid || !row) return
    // `me` is resolved per ORG: one human is several profiles (0081), and
    // following a task in a guest org must write that seat's id
    const me = profileIn(row.org_id)
    if (!me) return
    const has = rows.issueSubs.some((s) => s.issue_id === uuid && s.profile_id === me)
    if (has === on) return // already in the asked-for state
    if (on)
      rows.issueSubs.push({ issue_id: uuid, profile_id: me, created_at: new Date().toISOString() })
    else
      rows.issueSubs = rows.issueSubs.filter((s) => !(s.issue_id === uuid && s.profile_id === me))
    rebuild()
    emit()
    run(
      write(on ? api.issues.subscribe : api.issues.unsubscribe, {
        org_id: row.org_id,
        issue_id: uuid,
      }),
    )
  },

  signOut: () => {
    clearAvatarSources()
    if (DEMO_MODE) {
      notifyDemoEnded('lost')
      return
    }
    void authSignOut().then(
      () => location.reload(),
      () => location.reload(),
    )
  },
}

/* --- loading --------------------------------------------------------------
   One subscription to snapshot.forMe carries the whole workspace. Its first
   result settles initStore; every later one is adopted (behind run()'s paint
   gate). Its error callback fires when the query itself fails, not for
   network drops, which only delay results until Convex reconnects and
   resubscribes. A failure after the first result is snapshot trouble (see
   snapshot health). The last snapshot stays on screen and shared edits pause
   until a later result succeeds and reaches the screen. */

/* The last snapshot the server delivered — run()'s rollback anchor
   (rollback = re-adopt serverSnap + rebuild + emit; no refetch, no reload). */
let serverSnap: Snapshot | null = null
let snapUnsub: (() => void) | null = null
let cancelDemoBoot: (() => void) | null = null
let stopDayWatch: (() => void) | null = null
/* Try again resubscribes at most once per window; `retrying` lasts it. */
const RETRY_GAP_MS = 5000
let retryTimer: ReturnType<typeof setTimeout> | null = null

function isDemoLifecycleRefusal(error: unknown) {
  const data = errData(error)
  return (
    ['demo_expired', 'demo_missing', 'demo_unavailable', 'demo_not_ready'].includes(
      data.reason || '',
    ) ||
    (data.code === 'forbidden' &&
      /demo.*(expired|missing|unavailable)|active demo/i.test(data.message || ''))
  )
}

/** Forgets any snapshot trouble without notifying (boot and disposal). */
function resetSnapshotTrouble() {
  snapshotTrouble = null
  recoveryHeld = false
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

/** Records a failed snapshot query after the first delivery. A lost sign-in
    (the server's `forbidden('not signed in')`) is `signed_out`; anything
    else is `failed`. Keeps when the trouble began and a running retry. */
function snapshotFailed(err: unknown) {
  const d = errData(err)
  const text = err instanceof Error ? err.message : String(err)
  snapshotTrouble = {
    kind: d.code === 'forbidden' && d.message === 'not signed in' ? 'signed_out' : 'failed',
    since: snapshotTrouble?.since ?? Date.now(),
    asOf: lastDeliveryAt,
    retrying: snapshotTrouble?.retrying ?? false,
    // Convex appends where the call came from; support needs the rest
    detail: text.replace(/\s*Called by client\s*$/, '').trim(),
  }
  // a held delivery from before this failure no longer ends the trouble
  recoveryHeld = false
  emit('health')
}

/** Ends snapshot trouble when a delivery succeeds, and says so. */
function snapshotRecovered() {
  if (!snapshotTrouble) return
  resetSnapshotTrouble()
  toast('Qivo is up to date again.', 'success')
  emit('health')
}

/** Subscribes to the live snapshot. With `first`, the subscription's first
    result settles it (boot); without, every result updates the store (a
    retry's fresh subscription). A boot that fails before its first result
    ignores everything after. initStore drops that subscription, and a later
    error must not report trouble behind the load-failed screen, where the
    pause would refuse the next boot's seat claim. */
function subscribeSnapshot(
  stillCurrent: () => boolean,
  first?: { resolve: (snap: Snapshot | null) => void; reject: (err: unknown) => void },
) {
  let settled = !first
  let bootFailed = false
  return convex.onUpdate(
    api.snapshot.forMe,
    {},
    (snap) => {
      if (!stillCurrent() || bootFailed) return
      serverSnap = snap
      if (!settled) {
        settled = true
        first?.resolve(snap)
        return
      }
      // a later delivery of null = every seat vanished mid-session; keep the
      // last paint rather than tearing the app down under the user. A held
      // recovering delivery is gone with it, so it ends no trouble.
      if (snap === null) {
        recoveryHeld = false
        if (DEMO_MODE) notifyDemoEnded()
        return
      }
      // Gate the paint, never the data. While our own writes are in flight
      // the optimistic patches own the screen. serverSnap is recorded above,
      // and run()'s last settle flushes the newest held delivery. Snapshot
      // trouble ends with that paint (endHeldRecovery).
      if (inFlight > 0) {
        snapDirty = true
        if (snapshotTrouble) recoveryHeld = true
        return
      }
      adopt(snap)
      rebuild()
      emit()
      snapshotRecovered()
    },
    (err) => {
      if (!stillCurrent() || bootFailed) return
      const demoEnded = DEMO_MODE && isDemoLifecycleRefusal(err)
      if (demoEnded) notifyDemoEnded()
      if (!settled) {
        settled = true
        bootFailed = true
        first?.reject(err)
        return
      }
      // The query failed mid-session. Convex keeps the subscription and
      // reruns the query when the data it read changes, and a later result
      // ends the trouble. The demo's own ending is handled above.
      console.error('[qivo] snapshot query failed:', err)
      if (!demoEnded) snapshotFailed(err)
    },
  )
}

/** Try again. A fresh subscription runs the failed query again (Convex never
    caches a failed run). Does nothing unless the snapshot failed, and at most
    once per RETRY_GAP_MS; it cannot cure a limit the data itself exceeds. */
function retrySnapshot() {
  const trouble = snapshotTrouble
  if (trouble?.kind !== 'failed' || trouble.retrying) return
  snapshotTrouble = { ...trouble, retrying: true }
  emit('health')
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!snapshotTrouble?.retrying) return
    snapshotTrouble = { ...snapshotTrouble, retrying: false }
    emit('health')
  }, RETRY_GAP_MS)
  const epoch = storeEpoch
  snapUnsub?.()
  snapUnsub = subscribeSnapshot(() => epoch === storeEpoch && !demoDisposed)
}

/** Destroy demo memory before rendering the expired/session-loss screen.
 * Epoch guards prevent late write and file responses repopulating the cache. */
export function disposeDemoStore() {
  if (!DEMO_MODE) return
  storeEpoch++
  demoDisposed = true
  stopDayWatch?.()
  stopDayWatch = null
  cancelDemoBoot?.()
  cancelDemoBoot = null
  snapUnsub?.()
  snapUnsub = null
  resetSnapshotTrouble()
  commentsUnsub?.()
  commentsUnsub = null
  watchedComments = null
  commentsSnap = null
  syncUnsub?.()
  syncUnsub = null
  watchedSyncOrg = null
  watchedSyncOwners = ''
  PLANNER.lastComments = new Map()
  pendingRestoreIssueIds.clear()
  serverSnap = null
  preferences.dispose(myProfileSet)
  clearAvatarSources()
  minted.clear()
  minting.clear()
  // Settings hold only appearance mode here, never image bytes or credentials.
  try {
    localStorage.removeItem('qivo-appearance-mode')
  } catch {
    /* storage unavailable */
  }
  for (const value of Object.values(rows)) {
    if (value instanceof Map || value instanceof Set) value.clear()
    else if (Array.isArray(value)) value.length = 0
  }
  rows.billing = null
  hiddenReadMessages = 0
  unexaminedUnread = false
  unexaminedRead = false
  HOME_ORG = ''
  CURRENT_USER = ''
  myProfiles.clear()
  myProfileSet.clear()
  keyToUuid.clear()
  uuidToKey.clear()
  uuidToDisplayKey.clear()
  keyByOrg.clear()
  delayMap.clear()
  agentKeyOrg.clear()
  announcedMessages = null
  lastDeliveryAt = null
  pendingArchiveIssueIds.clear()
  pendingTaskDeletes.clear()
  pendingProjectDeletes.clear()
  roadmapVisit = null
  roadmapBatch = null
  roadmapDetailOpen = false
  inFlight = 0
  snapDirty = false
  commentsDirty = false
  PLANNER.loaded = false
  PLANNER.commentsLoaded = false
  rebuild()
  emit()
}

/* Replace the raw row cache per section from one snapshot delivery. adopt is
   always followed by rebuild(): rebuild is deliberately impure (setWeekConfig
   re-anchors dates.ts's live bindings, the Gravatar prime fires from inside
   it), so nothing may patch P.* directly off a snapshot. */
function adopt(source: Snapshot) {
  // Optimistic edits mutate these rows. Keep the server's snapshot separate
  // so a refused write can restore it even without a newer delivery.
  const snap = structuredClone(source)
  for (const rootId of pendingArchiveIssueIds.keys()) {
    if (!snap.issues.some((issue) => issue.id === rootId)) pendingArchiveIssueIds.delete(rootId)
  }
  // a delete is done once the server's snapshot holds none of what it removed
  const snapIssues = new Set(snap.issues.map((issue) => issue.id))
  pendingTaskDeletes.forEach((gone, rootId) => {
    if (![...gone].some((id) => snapIssues.has(id))) pendingTaskDeletes.delete(rootId)
  })
  for (const id of pendingProjectDeletes) {
    if (!snap.projects.some((project) => project.id === id)) pendingProjectDeletes.delete(id)
  }
  const priorIssueIds = new Set(rows.issues.keys())
  const newlyVisibleIssueIds = new Set(
    snap.issues.filter((issue) => !priorIssueIds.has(issue.id)).map((issue) => issue.id),
  )
  const restoreDelivery = [...pendingRestoreIssueIds].some((id) => newlyVisibleIssueIds.has(id))
  if (restoreDelivery) {
    /* A child restore can also surface archived ancestors. Suppress every
       task that entered with that delivery so historical messages that are
       still unread do not trigger desktop notifications. New messages on
       already-visible tasks remain eligible for notification. */
    const restoredIds = new Set(newlyVisibleIssueIds)
    if (announcedMessages !== null) {
      for (const message of snap.messages) {
        if (restoredIds.has(message.issue_id)) announcedMessages.set(message.id, message.woke_at)
      }
    }
    for (const id of pendingRestoreIssueIds) {
      if (newlyVisibleIssueIds.has(id)) pendingRestoreIssueIds.delete(id)
    }
  }
  /* A task also enters the working set when access returns or it moves back
     into view, and its stored messages come with it. Those created before the
     previous delivery raise no desktop notification; newer ones still do. */
  if (announcedMessages !== null && lastDeliveryAt !== null) {
    for (const message of snap.messages) {
      if (
        newlyVisibleIssueIds.has(message.issue_id) &&
        message.created_at <= lastDeliveryAt &&
        !announcedMessages.has(message.id)
      )
        announcedMessages.set(message.id, message.woke_at)
    }
  }
  lastDeliveryAt = snap.delivered_at
  /* identity first — the snapshot says which roster rows are mine
     (myProfileIds), so the blend can be re-keyed on every delivery. The
     HOME pick mirrors the old boot: first non-guest seat, else the first
     seat (guest-only logins have no home org, only a display fallback). */
  const profById = new Map<string, Row<'profiles'>>(snap.profiles.map((p) => [p.id, p]))
  myProfiles = new Map()
  myProfileSet.clear()
  const mine: Row<'profiles'>[] = []
  snap.myProfileIds.forEach((pid) => {
    const p = profById.get(pid)
    if (!p) return
    myProfiles.set(p.org_id, pid)
    myProfileSet.add(pid)
    mine.push(p)
  })
  const home = mine.find((p) => p.org_role !== 'guest') || mine[0] || null
  HOME_ORG = home && home.org_role !== 'guest' ? home.org_id : ''
  CURRENT_USER = home ? home.id : ''

  rows.orgs = new Map(snap.orgs.map((r) => [r.id, r]))
  // the organization_billing successor: the home org's admin-only object
  const homeOrgRow = HOME_ORG ? rows.orgs.get(HOME_ORG) : null
  rows.billing = homeOrgRow?.billing || null
  rows.teams = new Map(snap.teams.map((r) => [r.id, r]))
  rows.profiles = profById
  rows.teamMembers = snap.teamMembers
  rows.projects = new Map(snap.projects.map((r) => [r.id, r]))
  rows.access = snap.access
  rows.teamAccess = snap.teamAccess || []
  rows.issues = new Map(snap.issues.map((r) => [r.id, r]))
  rows.hiddenSubtaskParents = new Set(
    snap.issues.filter((r) => r.has_hidden_subtasks).map((r) => r.id),
  )
  rows.hiddenParentTasks = new Set(snap.issues.filter((r) => r.has_hidden_parent).map((r) => r.id))
  rows.links = new Map(snap.links.map((r) => [r.id, r]))
  rows.milestones = new Map(snap.milestones.map((r) => [r.id, r]))
  rows.activity = new Map(snap.activity.map((r) => [r.id, r]))
  rows.labels = new Map(snap.labels.map((r) => [r.id, r]))
  rows.issueLabels = snap.issueLabels
  rows.issueSubs = snap.issueSubs
  rows.attachments = new Map(snap.attachments.map((r) => [r.id, r]))
  rows.orgLoad = snap.orgLoad
  rows.messages = new Map(snap.messages.map((r) => [r.id, r]))
  // the server's predicate: read rows minus snoozed ones (removeRead's scope)
  const loadedReadCount = snap.messages.filter(
    (message) => message.read_at !== undefined && message.snoozed_until === undefined,
  ).length
  hiddenReadMessages = Math.max(0, (snap.readMessageCount ?? loadedReadCount) - loadedReadCount)
  unexaminedUnread = snap.unreadTruncated === true
  unexaminedRead = snap.readTruncated === true
  // ALWAYS after the messages section lands: the null-primed first call is
  // what keeps sign-in from replaying the stored inbox as OS notifications
  announceNewMessages()
  // Preferences load once at boot; comments own their separate subscription.
}

/** Load the blended snapshot for the signed-in user. Returns the HOME profile
    (or the first guest seat for a guest-only login), null when the login holds
    no profile at all — the "create your organization" screen — and THROWS when
    the load itself failed. The difference matters: "you have no seat" and
    "the network blinked" look identical in a null, and answering the second
    with a create-an-organization form invites an existing customer to make a
    duplicate tenant.

    Boot order: session → claimMySeats → subscribe. The
    claim runs BEFORE the subscription so a fresh invitee's seat is live in
    the very first snapshot instead of painting an empty workspace. createOrg
    re-runs the whole thing (unsubscribe → resubscribe), which is what swaps
    the blend over to the new home org. */
export async function initStore(
  onAuthenticated?: (accountId: string) => void,
  knownSession?: Awaited<ReturnType<typeof authClient.getSession>>,
): Promise<{ profileId: string; homeOrg: string } | null> {
  stopDayWatch?.()
  stopDayWatch = null
  clearAvatarSources()
  demoDisposed = false
  const epoch = storeEpoch
  const stillCurrent = () => epoch === storeEpoch && !demoDisposed
  // AuthGate already had to establish this session before it could render
  // the workspace. Reuse that result on the first boot; retries and callers
  // such as DemoGate omit it and perform their own session read.
  const session = knownSession ?? (await authClient.getSession())
  if (session.error) throw new Error(session.error.message || 'could not reach the sign-in service')
  if (!session.data?.session) return null
  // a session exists but the Convex socket may still be anonymous (the
  // import-time token fetch ran before sign-in) — re-arm and wait for the
  // socket to authenticate, or the very next mutation is refused
  const authed = await armConvexAuth()
  if (!authed) throw new Error('could not authenticate with the data service')
  // Account appearance needs authentication, but no planner snapshot. Let it
  // load while seat claiming, workspace data and navigation preferences follow.
  onAuthenticated?.(session.data.user.id)
  avatarSources.setPersistent(
    DEMO_MODE
      ? null
      : createAvatarImageCache(
          avatarCacheScope(configuredConvexDeploymentUrl(), session.data.user.id),
        ),
  )
  // invitations that arrived after this login existed are claimed here, so a
  // guest seat is live on the very first snapshot (0081); a failure THROWS
  // (loadFailed), never masquerades as noProfile
  if (!DEMO_MODE) await write(api.identity.claimMySeats, {})
  if (!stillCurrent()) return null
  // Both reads use the post-claim seat set. Preferences resolve the home
  // profile on the server, so they do not wait for the snapshot's roster.
  const bootPreferences = preferences.beginBoot()
  if (snapUnsub) {
    snapUnsub()
    snapUnsub = null
  }
  // A new subscription starts from a clean state; its first result settles
  // the boot, so it never reports recovery from an earlier one's trouble.
  if (snapshotTrouble) {
    resetSnapshotTrouble()
    emit('health')
  }
  let bootSub: (() => void) | null = null
  const first = await new Promise<Snapshot | null>((resolve, reject) => {
    if (DEMO_MODE) cancelDemoBoot = () => resolve(null)
    snapUnsub = bootSub = subscribeSnapshot(stillCurrent, { resolve, reject })
  }).catch((err: unknown) => {
    // a failed boot keeps no subscription (see subscribeSnapshot)
    if (snapUnsub === bootSub) {
      snapUnsub?.()
      snapUnsub = null
    }
    throw err
  })
  if (epoch === storeEpoch) cancelDemoBoot = null
  if (!stillCurrent()) return null
  if (first === null) {
    // signed in, no seat anywhere — AuthGate's noProfile screen; the next
    // initStore (after createOrg) subscribes afresh
    if (snapUnsub) {
      snapUnsub()
      snapUnsub = null
    }
    return null
  }
  adopt(first)
  avatarSources.sync(
    [...first.profiles]
      .filter((profile) => profile.avatar_storage_id)
      .map((profile) => `avatar:${profile.id}:${profile.avatar_storage_id}`),
  )
  if (!stillCurrent()) return null
  /* Avatar restoration is a warm cache and may finish after the first paint.
     Navigation preferences stay awaited: App reads them while constructing
     its initial route, so letting that query race the first render could
     overwrite the user's saved view with the local warm copy. */
  const restoreAvatars = avatarSources.restore().catch((error) => {
    console.warn('[qivo] avatar cache load failed:', error)
  })
  const savedPrefs = await bootPreferences
  if (!stillCurrent()) return null
  preferences.adopt(savedPrefs)
  rebuild()
  PLANNER.loaded = true
  // The store outlives view switches. Stop its clock on disposal or reinitialization.
  if (typeof document !== 'undefined' && typeof window.addEventListener === 'function') {
    stopDayWatch = watchLocalDay((now) => {
      if (!stillCurrent() || isoFromDate(now) === PLANNER.TODAY_ISO) return
      rebuild(now)
      emit()
    })
  }
  emit()
  void restoreAvatars.then(() => {
    if (!stillCurrent()) return
    rebuild()
    emit()
  })
  return { profileId: CURRENT_USER, homeOrg: HOME_ORG }
}

export const P = PLANNER

/* The scope description P.scopeInfo answers with (null aside) — the shape
   App threads to every view. Derived after the store so the type can name
   the method's own return. */
export type ScopeInfo = NonNullable<ReturnType<typeof PLANNER.scopeInfo>>

// the design prototype exposed the store as window.PLANNER; keep that hook —
// verify drives (scripts/verify-*.mjs) reach mutations through it directly
window.PLANNER = PLANNER
