/* Prototype-compatible planner facade over Convex. Task handles remain unique
   across organizations; display keys are org-scoped QN numbers. Relationships,
   project access and week-indexed schedules are derived from the raw rows.

   The workspace arrives in live parts (store/liveParts.ts), and every
   complete transition of them is staged in the base
   (store/workspaceBase.ts), which keeps each unchanged row's object, and
   sets hasSnapshot. A later answer with no seat left keeps the last rows. Every write paints its own
   optimistic layer (store/layers.ts) over the server's rows, copying only
   the rows it reaches (store/rowMap.ts), and a refusal takes away only that
   layer (see the write path below). A repaint reshapes only the view models
   a change reaches (store/taskIndex.ts).
   The open task's thread rides along with the parts; Team sync has its own
   subscriptions and update channel.
   Preferences load once and save through their own debounced lifecycle.
   Uploads remain awaited; signed file URLs are minted with one-shot queries. */

import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { AVATAR_COLORS } from '../../convex/lib/avatarColors'
import { ORG_DELETING, type OrgCreate } from '../../convex/lib/billingAccess'
import type { BoardAnswer } from '../../convex/lib/board'
import { asciiEmail, cleanEmail, emailRefusal as storedEmailRefusal } from '../../convex/lib/email'
import { descriptionForm, FIELD_CHANGED, printOf, trimmedForm } from '../../convex/lib/fieldPrints'
import type { FieldChange } from '../../convex/lib/functions'
import { imageRefs, shownImages } from '../../convex/lib/imageRefs'
import {
  COMMENTS_COUNTING,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEMO_FILE_BYTES,
  grouped,
  LABEL_NOT_IN_TASK_ORG,
  LIMITS,
  LIST_BATCH,
  type Limit,
  MIB,
  MILESTONE_READ_PROJECTS,
  outsideWhole,
  overText,
  SLUG_SHAPE,
  trimMarkdown,
  WEEK_START_REFUSALS,
} from '../../convex/lib/limits'
import { tooManyMentions } from '../../convex/lib/mentions'
import { roundTenths } from '../../convex/lib/numbers'
import type { ListAnswer } from '../../convex/lib/overview'
import {
  canCreateProjects,
  isProjectCreators,
  projectRightAfterUpdate,
} from '../../convex/lib/projectCreators'
import { creatorGrant, grantsAfterHandover } from '../../convex/lib/projectGrants'
import { resolveReviewHours, reviewStamp, taskOwnerId } from '../../convex/lib/review'
import type { DependencyAnswer, DependencyRow, RoadmapAnswer } from '../../convex/lib/roadmap'
import { firstSittingDay, nextSyncStamp, SYNC_OWNERS_MAX } from '../../convex/lib/teamSync'
import type { AgendaAnswer } from '../../convex/lib/teamSyncAgenda'
import type { PersonRow } from '../../convex/model/projectSettings'
import { armConvexAuth, authClient, signOut as authSignOut } from '../lib/auth'
import { NO_QUERY, SignOutFailed } from '../lib/authSession'
import { avatarCacheScope, createAvatarImageCache } from '../lib/avatarImageCache'
import { createAvatarSources } from '../lib/avatarSources'
import { browserBackendUrl, configuredConvexDeploymentUrl } from '../lib/backendUrl'
import { LANE_POOL, type LaneStop, runLanes } from '../lib/batchRunner'
import { convex, live } from '../lib/convex'
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
  DELAY_COLORS,
  DELAY_LABELS,
  DELAY_NEUTRAL,
  DELAY_UNKNOWN,
  type DelayInfo,
} from '../lib/delay'
import {
  blockedText,
  DEFERRED_MOST,
  type DeletedAction,
  type DeletedItemsOutcome,
  type DeletedLane,
  type DeletedRow,
  type DeletedStop,
  type DeletedTarget,
  deletedBusy,
  endText,
  faultText,
  itemsNoun,
  type PurgeRefusal,
  pauseText,
  planOf,
  type RestoreRefusal,
  refusalText,
  stopText,
  targetName,
} from '../lib/deletedItems'
import { attachmentTooLarge, DEMO_MODE, notifyDemoEnded } from '../lib/demoMode'
import { DemoSessionEnded } from '../lib/demoSession'
import { sentence as asSentence, cleanName, limitSentence } from '../lib/fieldLimits'
import { frameBatch } from '../lib/frameBatch'
import { AVATAR_TYPES, avatarImage, compressImage } from '../lib/images'
import { nameInitials } from '../lib/initials'
import { createInlineImages } from '../lib/inlineImages'
import { groupProgress, groupSpan, isIssueDone, isIssueGroup } from '../lib/issueGroups'
import { labelColorFor } from '../lib/labelColors'
import { hasUnsaved, holdUnsaved, leaveDeliberately } from '../lib/leaveGuard'
import { watchLive } from '../lib/liveView'
import { loadFailureText } from '../lib/loadFailure'
import { watchLocalDay } from '../lib/localDay'
import { createMintQueue, type MintOutcome } from '../lib/mintQueue'
import { pauseSentence } from '../lib/noticeText'
import { desktopNotify } from '../lib/notify'
import { reloadPage } from '../lib/pageHistory'
import { matchesAllWords, taskSearchText } from '../lib/search'
import { type OfflineWindow, type SavePause, syncStatus } from '../lib/syncStatus'
import { attachmentBlock, labelBlock, linkBlock } from '../lib/taskCaps'
import { isTaskRef, type RefParts, refParts, taskRef } from '../lib/taskReference'
import { byCreation, byNumber, linkViews, type SectionState, shownIds } from '../lib/taskSections'
import { type SyncVerdict, syncMeetingOf, weekHoursOf } from '../lib/teamSync'
import {
  type HeldKind,
  joinNewer,
  newerAnchor,
  type ReleaseMove,
  releaseThread,
  THREAD_KEEP,
} from '../lib/threadBudget'
import type { ToastTone } from '../lib/toasts'
import { type UnconfirmedChange, unconfirmedNote, unconfirmedText } from '../lib/unconfirmedNote'
import { beginUpdateBlock } from '../lib/updateSafety'
import { watchVisibility } from '../lib/viewVisibility'
import { committedByWeek, DEFAULT_PLANNABLE_HOURS, plannableHoursOf } from '../lib/workload'
import { createEntityLookup } from './entityLookup'
import {
  type Refusal as FieldRefusal,
  noticeText,
  refusalLine,
  refusalWriter,
  type Writer,
} from './fieldNotice'
import { createLayers, type Layer, type Over, type Paint, paints, type View } from './layers'
import {
  type AddressedTask,
  createLiveParts,
  type LiveParts,
  type PartsReport,
  SIDE_NAMES,
  type SideName,
  type SideNews,
  TASKS,
} from './liveParts'
import {
  createMilestoneRows,
  type MilestoneAsk,
  type MilestonePosition,
  type MilestoneProject,
  type MilestoneRow,
  type MilestonesShown,
  type MilestoneTake,
} from './milestoneRows'
import {
  baseOfKey,
  createOverviewReads,
  type HealthTable,
  type ListKind,
  type OverviewQuery,
  type OverviewView,
  splitAt,
} from './overviewLists'
import { createOwnerLoadCache, type OwnerLoad, type OwnerNeed } from './ownerLoadCache'
import { createPreferences } from './preferences'
import { createProfileCache, type NamedPerson } from './profileCache'
import { createWorkspaceRows, RowMap, rowCopies } from './rowMap'
import { keep, keepItems, sameData } from './stable'
import {
  answerFamily,
  creatingAnswer,
  shapeShortTask,
  shapeTaskDetail,
  type TaskDetailVM,
} from './taskDetail'
import { createTaskIndex, type TaskChanges, type TaskSources } from './taskIndex'

export type { UIPrefs } from './preferences'

import type {
  RelationCandidate,
  RelationCandidates,
  RelationKind,
} from '../../convex/lib/relationPicker'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { Seatless, Workspace } from '../../convex/lib/workspaceJoin'
import {
  BULK_SEATS,
  type BulkAction,
  type BulkStop,
  bulkBusy,
  bulkDoneText,
  bulkName,
  bulkStopText,
  bulkUncheckedText,
  type InboxBulk,
} from './inboxBulk'
import type { Row } from './rows'
import { createPlannerUpdates, type StoreVersion } from './updates'
import {
  delayIssueOfRow,
  delayIssueOfTask,
  issueNeedsLoad,
  judgeDelay,
  needsLoad,
  type OwnerItem,
  type OwnerItemsCtx,
  ownerItemsOf,
  type ViewDelayCtx,
  viewDelay,
  viewLoadOf,
} from './viewDelay'
import {
  type ActivityVM,
  type ArchivedIssueVM,
  type ArchivedListRowVM,
  type ArchivedProjectVM,
  type AttachmentVM,
  byOrder,
  type CommentVM,
  duplicateNameTags,
  type InboxMark,
  type IssueSubscribers,
  type IssueVM,
  inboxMarkKey,
  isNewer,
  type LabelVM,
  type MessageGroupVM,
  type MessageVM,
  type MilestoneVM,
  type OrgRefVM,
  type OrgVM,
  type PersonOk,
  type PersonShown,
  type PersonView,
  type ProjectVM,
  personOfFace,
  personOfName,
  personOfUser,
  shapeActivity,
  shapeArchivedListRow,
  shapeArchivedProject,
  shapeAttachment,
  shapeComment,
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
import { createViewRows, type ViewSlot } from './viewRows'
import { createWorkspaceBase, deepFreeze } from './workspaceBase'

export type { NamedPerson } from './profileCache'
export type { TaskDetailState, TaskDetailVM } from './taskDetail'
export type {
  ActivityVM,
  ArchivedIssueVM,
  ArchivedListRowVM,
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
  PersonOk,
  PersonShown,
  PersonView,
  ProjectVM,
  TeamVM,
  UserVM,
} from './viewModels'
export { personShownOf } from './viewModels'

/* Personal theme and Canvas background, exactly as appearance:get returns them. */
export type AppearancePreferences = FunctionReturnType<typeof api.appearance.get>
/** What archiving or deleting a project takes along, as P.projectRemovalSummary answers. */
export type ProjectRemovalSummary = FunctionReturnType<typeof api.projects.removalSummary>
export type { DeletedItemsOutcome } from '../lib/deletedItems'

/* The workspace as the parts join into it (convex/lib/workspaceJoin.ts),
   derived from the server functions so the cache can never drift from what
   they emit. Optional columns arrive ABSENT (undefined), never null; every
   == null / truthiness test below covers both, and no row field is compared
   with === null. */
type Snapshot = Workspace

/* --- raw row cache --------------------------------------------------------
   Multi-org since 0081: a login holds ONE home profile plus a `guest` profile
   in every foreign organization that invited it to a project. The snapshot
   hands back the rows of every org the login has an active seat in, so the
   caches below are BLENDED — `orgOf(...)` answers which organization a row
   belongs to, and the handful of places that need "my identity" ask for it
   per org (profileIn). There is no active-org state and no switcher: the
   home org drives display settings, and foreign projects simply appear
   alongside the home ones. */
/* The server's rows of the last delivery painted, each unchanged row kept
   as one frozen object (store/workspaceBase.ts), and the rows on screen:
   those with every live layer painted over them (store/rowMap.ts). */
const base = createWorkspaceBase()
const workspaceRows = createWorkspaceRows(base)
const rows = {
  orgs: workspaceRows.orgs,
  // billing rides the org row, admin-redacted server-side; this is the home
  // org's object (the organization_billing table's successor)
  get billing(): Row<'organizations'>['billing'] | null {
    return (HOME_ORG ? workspaceRows.orgs.peek(HOME_ORG)?.billing : undefined) || null
  },
  teams: workspaceRows.teams,
  profiles: workspaceRows.profiles,
  get teamMembers() {
    return workspaceRows.list('teamMembers')
  },
  set teamMembers(value) {
    workspaceRows.setList('teamMembers', value)
  },
  projects: workspaceRows.projects,
  get access() {
    return workspaceRows.list('access')
  },
  set access(value) {
    workspaceRows.setList('access', value)
  },
  get teamAccess() {
    return workspaceRows.list('teamAccess')
  },
  set teamAccess(value) {
    workspaceRows.setList('teamAccess', value)
  },
  issues: workspaceRows.issues,
  get hiddenSubtaskParents() {
    return workspaceRows.flags('hiddenSubtaskParents')
  },
  // tasks whose parent is outside the working set; the snapshot omits that
  // parent's id
  get hiddenParentTasks() {
    return workspaceRows.flags('hiddenParentTasks')
  },
  links: workspaceRows.links,
  labels: workspaceRows.labels,
  get issueLabels() {
    return workspaceRows.list('issueLabels')
  },
  set issueLabels(value) {
    workspaceRows.setList('issueLabels', value)
  },
  // who follows which task (0114). The snapshot carries own rows only, exactly
  // like user_prefs: a subscription is MY notification preference, not a
  // published fact about the task, so this cache never holds anybody else's
  // row and `subscribed` below is the only thing derived from it.
  get issueSubs() {
    return workspaceRows.list('issueSubs')
  },
  set issueSubs(value) {
    workspaceRows.setList('issueSubs', value)
  },
  attachments: workspaceRows.attachments,
  // comments for ONE issue — the open modal's (watchComments); other issues'
  // comments are never fetched, so this is not org-wide state
  comments: new Map<string, Row<'comments'>>(),
  // the watched issue's history while a window shows All (P.showHistory),
  // from its own side query (threadHistory)
  threadEvents: [] as Row<'activity_events'>[],
  // inbox messages (0074) — the snapshot returns only the signed-in user's
  // rows; generation is server-side (notify triggers), clients only mark
  // read/unread, snooze and delete
  messages: workspaceRows.messages,
  // Reactive organization-wide load by effective owner; hidden projects
  // contribute hours without exposing their identity.
  get orgLoad() {
    return workspaceRows.list('orgLoad')
  },
  set orgLoad(value) {
    workspaceRows.setList('orgLoad', value)
  },
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
// Whether the snapshot left out any message the Inbox would list, snoozed
// ones included (snapshot messagesCut).
let messagesCut = false

/* Each owner's hours in the weeks P.weekLoadOf was asked about, added up
   one week at a time on first ask from the owner's organization-wide load
   (tasks.loads), and forgotten when that load changes. */
const committedByOwner = new Map<string, Map<number, number>>()

/* The task view models, handles, delays and load, kept up to date a task
   at a time (store/taskIndex.ts). */
const tasks = createTaskIndex((owner) => committedByOwner.delete(owner))
const delayMap = tasks.delays

/* The home organization whose latest-comment facts the Team sync page
   watches (P.watchTeamSync), or null, and the people it asks about (joined
   in the order asked), or '' for none. */
let watchedSyncOrg: string | null = null
let watchedSyncOwners = ''
/* Whether the page asked to pause the watch while it or the tab is hidden:
   no part subscribes, and the marks stay as they were. */
let syncPaused = false
let syncWatchEpoch = 0
/* One latest-comment subscription for some of the watched people, and its
   last answer (null until it arrives). */
type SyncPart = {
  owners: string[]
  unsub: () => void
  rows: { issue_id: string; at: string | null }[] | null
  complete: boolean
}
let syncParts: SyncPart[] = []
/* The marks known before the watched people last changed, shown until every
   part has answered, so stepping through the walk does not blank them. */
let syncFallback = new Map<string, number | null>()
const stopSyncParts = () => {
  for (const part of syncParts) part.unsub()
  syncParts = []
}

/* The issue whose comments are subscribed (uuid), or null. Set by the issue
   modal via watchComments, which owns the thread's side query of the live
   parts (store/liveParts.ts). */
let watchedComments: string | null = null
/* The organization of the watched task as its window named it, or as the
   workspace held it when it was watched, or null. A task the workspace
   does not hold takes its thread, history and task answer through it
   (watchedOrgOf), also after a re-init of the parts. */
let watchedOrg: string | null = null
/* The watched task as the workspace last held it, its uuid, organization,
   number, title and project, so a window goes on naming it once it left
   the workspace before its own read answered (P.unheldTask) and a change
   of the home organization moves its handle (withUnheldMoves). Forgotten
   when another task is watched. */
let watchedHeld: {
  uuid: string
  org: string
  num: number
  title: string
  project: string
} | null = null
/* The task and organization of the thread the parts watch, or null. */
let threadWatched: { task: string; org: string } | null = null

export type { InboxMark } from './viewModels'
/** The unread summary across the login's seats, as convex/inbox.ts
    summary answers it. */
export type InboxSummaryAnswer = FunctionReturnType<typeof api.inbox.summary>
/** The open task's inbox item, as convex/inbox.ts item answers it. */
export type InboxItemAnswer = FunctionReturnType<typeof api.inbox.item>
/** An inbox item's fields, from an answer that holds one. */
export type InboxItemFields = NonNullable<Extract<InboxItemAnswer, { state: 'ok' }>['item']>

/** The unread summary as the store holds it (P.inboxSummary), `loading`
    until its first answer and while it runs again, `failed` after a
    failure, which drops the answer, else `ok` with the answer and whether
    it is current, the running registry's latest on the socket's newest
    connection. A held answer that is not current stays shown. */
export type InboxSummaryVM =
  | { state: 'loading' | 'failed'; answer: null; current: false }
  | { state: 'ok'; answer: InboxSummaryAnswer; current: boolean }

/** The open task's inbox item as the store holds it (P.inboxItem), for the
    task and organization whose thread the store watches: `loading` until
    its first answer and while it runs again, `building` while the seat's
    items are not complete, `failed` after a failure or a refusal, which
    the store runs once more a visit by itself (itemNews), else `ok` with
    the item, null for no item. `current` as for the summary
    (InboxSummaryVM). */
export type InboxItemVM = {
  task: string
  org: string
  state: 'loading' | 'ok' | 'building' | 'failed'
  item: InboxItemFields | null
  current: boolean
}

/* Whether the latest answer of the unread summary (P.inboxSummary) and of
   the open task's inbox item (P.inboxItem) came from the running registry,
   and the connection each arrived on. A failure and a re-init of the parts
   (stopParts) clear the flag, and a reconnect moves latestConnection past
   the connection (staleInboxReads), as detailFresh does for the task
   side. */
let summaryFresh = false
let summaryConnection = 0
let itemFresh = false
let itemConnection = 0
/* Whether the store ran the open task's failed inbox item once more this
   visit (itemNews), which it does once. Forgotten when the thread changes
   or stops. */
let itemRerun = false
/* A hold on the open task's read on open that holds nothing, which each
   visit starts with (itemHold). */
const freeHold = () => ({
  waiting: new Set<number>(),
  accepted: 0,
  readThrough: 0,
  keptBack: false,
})
/* This client's hold on the open task's read on open this visit
   (P.readOnOpen), from its Mark as unread or a snooze or its end on the
   task (holdUnreadOf), its unread choices, each by the number holdWrites
   gave it as it went out. `waiting` holds the numbers of those whose
   write still waits, `accepted` the newest the server accepted, and
   `readThrough` the newest that went out before a row's Mark as read the
   server accepted (P.readItem), which supersedes every unread choice up
   to it, accepted, waiting or failed. A later choice that waits or was
   accepted holds (heldBack), and while one does, no read on open goes
   out. A write the server refused or that failed only stops waiting, so
   the hold is as it would be without that write. `keptBack` says whether
   the hold turned away a read on open the window asked for, which runs
   again once nothing holds. Each visit gets a new hold, so a write of an
   earlier visit changes nothing. Forgotten when the thread changes or
   stops. */
let itemHold = freeHold()
/* The number of the newest write that took a hold on the watched task's
   read on open (holdWatched), in the order they went out, so a row's
   accepted Mark as read supersedes exactly the unread choices that went
   out before it (P.readItem). */
let holdWrites = 0

/* Whether hold `hold` holds off the read on open, as an unread choice
   that went out after the last accepted row read does while it waits and
   once the server accepted it. */
function heldBack(hold: ReturnType<typeof freeHold>): boolean {
  if (hold.accepted > hold.readThrough) return true
  for (const n of hold.waiting) if (n > hold.readThrough) return true
  return false
}

/* The marks of the person's Inbox writes by `${org}:${task}`
   (inboxMarkKey), which P.inboxMarks shows. A write sets its mark as it
   goes out, replacing any before, and settles only its own. A refusal or a
   failure ends it at once, and an acceptance keeps it until an Inbox shows
   an answer that is current after the settle (P.endInboxMarks), since a
   list that waits for a fresh answer, as after a hidden tab, a kept Inbox
   shown again or a reconnect, still shows one from before the write. So
   they are bounded by the session's writes. */
const inboxMarks = new Map<string, InboxMark>()

/* How many answers of the open task's inbox item arrived, so the read on
   open can tell an answer that came after its read went out
   (P.readOnOpen). */
let itemAnswers = 0
/* The window's last read on open (P.readOnOpen), with its task,
   organization and `through`, how many item answers had arrived when it
   went out, whether the server confirmed it (never after a refusal), and
   whether it was the one more read the rule allows at the same `through`.
   Forgotten when the thread changes or stops. */
let itemRead: {
  task: string
  org: string
  through: number
  sent: number
  confirmed: boolean
  again: boolean
} | null = null
let commentsWatchEpoch = 0
/* The last thread the comments subscription delivered, the anchor the
   thread's rows are built from (buildThreadRows), as the base
   (store/workspaceBase.ts) is for the rest. null = nothing delivered yet for the watched issue. It is the
   thread's live window, its newest comments, oldest first in thread order. */
let commentsSnap: Row<'comments'>[] | null = null
/* The windows that show the watched task's history under All
   (P.showHistory). The history has its own side query, which runs only
   while one of them does, so a task open under Comments reads no history. */
const historyOwners = new Set<object>()
/* The task and organization of the history the parts watch, or null. */
let historyWatched: { task: string; org: string } | null = null
/* Moves on whenever the history starts over (resetHistory, restartHistory),
   so an earlier page asked for before that is dropped when it answers. */
let historyEpoch = 0
/* The last page the history's subscription delivered (threadHistory), its
   newest rows, oldest first in insertion order, the task window's changes
   under All. null until the first delivery since the history started over
   (resetHistory), which it does when the last window leaves All and when
   another task opens. A re-init of the parts (stopParts) keeps it until the
   new subscription delivers. */
let historySnap: Row<'activity_events'>[] | null = null
/* The watched task's history older than that page, oldest first: the run
   above the gap while one is open (historyGap), else every loaded row older
   than the page. They are earlier pages (P.loadEarlierHistory), pages Show
   newer activity read back, and rows that left the page as newer ones
   arrived while no gap was open. Server truth like historySnap, but not
   live: only the live page runs again when what the person may see
   changes. A row loaded earlier that the person stops receiving, after a
   grant ends or a task it names moves or goes, stays on screen until the
   history loads again (Comments and back to All, or the task opened again)
   or the store lets it go past its budget (keepThread). Those rows came
   while the person could see them, so nothing new shows. The store does
   not re-read the loaded pages, since no change it hears of covers every
   input of the server's rule (lib/activityVisibility.ts
   memberSeesActivity): a task a row names can move or go where the person
   never sees it. A live page
   that does not begin with a loaded row, as after more changes between two
   deliveries than a page holds, starts the history over from that page
   (receiveHistory), and Show earlier activity loads the rest again: joining
   the rows loaded before across that gap would need the server's word on
   every interval it joins. */
let olderEvents: Row<'activity_events'>[] = []
/* Whether the watched task's first history row is loaded, so nothing is
   earlier, and how the last load of an earlier page of history went. */
let historyStart = false
let historyLoad: 'idle' | 'loading' | 'failed' = 'idle'
/* The row the next earlier page of history is read before: the `next` of
   the last page loaded, or of the live page the history started from (null
   when the history start is loaded). A page can skip rows the person does
   not receive, so this can be a row the thread does not show. */
let historyNext: string | null = null
/* The watched thread's comments older than the live window, oldest first in
   thread order: the run above the gap while one is open (commentsGap), else
   every loaded comment older than the live window. They are earlier pages
   (P.loadEarlierComments), pages Show newer comments read back, and
   comments that left the window as newer ones arrived while no gap was
   open. Server truth like commentsSnap, but not live. The store patches it
   for the person's own edits and deletes; other people's changes to these
   comments show when they load again. With the history, the newer run and
   the live window, each release brings what is held back to about
   THREAD_KEEP.rows rows, and a loaded comment stays until a release lets
   it go (keepThread) or the task opens again. */
let olderComments: Row<'comments'>[] = []
/* The person's comment edits and deletes in the watched thread that the
   server accepted (null for a delete), until a live window holds the
   comment. A comment that slides out of the window moves into olderComments
   from the window delivered before, which can predate the edit, so the edit
   applies again there (receiveThread). */
const acceptedCommentChanges = new Map<string, Partial<Row<'comments'>> | null>()
/* Whether the watched thread's first comment is loaded, so nothing is
   earlier, and how the last load of an earlier page went. */
let threadStart = false
let earlierLoad: 'idle' | 'loading' | 'failed' = 'idle'
/* The released span of the watched thread's comments (lib/threadBudget.ts):
   the ids the store let go between the run above it (olderComments) and the
   run below it (newerComments), oldest first in thread order, or null with
   no gap. The runs are arrays of their own, so a delete or a dropped
   comment before the gap cannot shift where it is. Show newer comments
   reads the span back (P.loadNewerComments), anchored at these ids, which
   the server answered for this task. The gap can hold no id once every one
   of them proved deleted; it closes only when a page proves the runs meet.
   With no gap, newerComments is empty. */
let commentsGap: string[] | null = null
/* The comments kept below the gap and above the live window, oldest first
   in thread order: comments that slid out of the live window while a gap
   was open, and the rows below a gap that a release left. Server truth
   like olderComments, patched the same way. */
let newerComments: Row<'comments'>[] = []
/* How the last Show newer comments read went, and the number of the read
   that counts, which a later read and a changed gap move on, so an answer
   that comes after them is dropped. */
let newerLoad: 'idle' | 'loading' | 'failed' = 'idle'
let newerAsk = 0
/* The same for the history: the released change ids between olderEvents
   and newerEvents, the changes kept below that gap, and the last Show newer
   activity read. */
let historyGap: string[] | null = null
let newerEvents: Row<'activity_events'>[] = []
let historyNewerLoad: 'idle' | 'loading' | 'failed' = 'idle'
let historyNewerAsk = 0
/* The comment each window has open in its editor (P.holdComment), by the
   window's own object. A release passes over such a comment rather than
   unmount its editor with the draft: it leaves its run, and the store holds
   its row in pinnedComments, which the window shows at its time, until a
   page or the live window holds it again or no editor holds it. */
const commentHolds = new Map<object, string>()
const pinnedComments = new Map<string, Row<'comments'>>()
/* The comments and changes a release passed over at an instant that only
   the other kind's live rows hold (lib/threadBudget.ts KindAfter apart),
   by id, oldest first. Their ids went into the gap, or above the oldest
   kept row, like every row a release takes, so a page reads them back,
   but the store keeps their rows, counted in the budget, so no instant is
   split. They sit among rows the store let go, so the window shows none
   of them (P.threadApart). Each goes once a run or the live rows hold it
   again or no held row of the other kind shares its instant (syncApart),
   and they go with their runs when the thread or the history starts
   over. */
const apartComments = new Map<string, Row<'comments'>>()
const apartEvents = new Map<string, Row<'activity_events'>>()
/* The first comment or change on screen in each window, by the window's own
   object, null while the window shows the thread's newest end
   (P.threadPlace). Every release keeps the rows on screen around each of
   them (placesKept), and a comment or change that arrives past the budget
   releases on the side farther from the topmost of them (arrivalMoves).
   Dropped when its window unmounts and when another task is watched. */
const threadPlaces = new Map<object, string | null>()
/* The rows the last press of Show earlier or Show newer keeps through every
   release until the next press: the rows the window measures to keep the
   reader's place, each kind's oldest row for Show earlier and each kind's
   last row above the gap for Show newer, and the pages the press loaded,
   of both kinds under All, where one press reads both. A press made while
   another still loads adds its own rows (startPress). */
let pressKeep = new Set<string>()
/* The windows that show the watched task's Subtasks, Linked tasks and
   Attachments (P.showSections): a floating window or pop-out, and on a
   phone its Details tab. Each list has a side query of the live parts
   (convex/taskWindow.ts task, links and attachments, the SectionSide
   names), which runs only while one of them does, so the desktop Inbox
   pane, which shows no details, reads none of them. The task side also
   runs while a window shows the watched task from its answer, because the
   workspace does not hold it (sidesWanted), and the writes on that task
   paint its answer (detailRows) and end with its next current delivery
   (taskDelivered). */
const sectionOwners = new Set<object>()
/* The task and organization each section side query watches, or null
   while it does not run (syncSections). */
const sectionsWatched: Record<SectionSide, { task: string; org: string } | null> = {
  task: null,
  links: null,
  attachments: null,
}
/* What the sections' side queries last delivered for task `issue`, the
   anchors their lists and the task's detail are built from
   (rebuildSections, the task's answer painted with the layers' detail
   parts first, paintedAnswer) as the base is for the workspace rows: null before a
   side's first delivery, CREATING for a task whose create is on its way,
   which has none of them yet. At most one task's three answers, so at most
   TASK_WINDOW.rows short rows a list and TASK_WINDOW.attachments
   attachment rows (convex/lib/taskWindow.ts). A side's answer goes when
   no window wants that side any more (syncSections), and all go when
   another task opens (resetSections). A re-init of the parts (stopParts)
   keeps them until the new subscriptions deliver, so no section or task
   shown from its answer flashes back to loading. */
let sectionAnswers: SectionAnswers = { issue: null, task: null, links: null, attachments: null }
/* Whether each side query of the sections failed, as historyFailure says
   for the history: 'failed' until a later delivery or Retry
   (P.retrySection), 'retrying' from Retry until the server answers. A
   failure keeps the answer delivered before it. */
const sectionFailure: Record<SectionSide, CommentsFailure> = {
  task: 'none',
  links: 'none',
  attachments: 'none',
}
/* The watched task's own answer (sectionAnswers.task) with the detail part
   of every live layer painted over it (store/layers.ts View detail), as
   the window, its Subtasks and the caps read it (paintedAnswer): `from` is
   the anchor it was painted from, `task` the painted copy, or the anchor
   itself while no layer paints it, null while the watched task has no ok
   answer. At most one task's answer, so at most TASK_WINDOW.rows subtask
   rows a repaint copies while a write on it waits. */
let detailRows: { from: TaskOk | null; task: TaskOk | null } = { from: null, task: null }
/* The painted answer P.detail was built from last (rebuildSections), the
   one the window draws. A delivery can bring a newer anchor that the
   window draws only at the next repaint, which waits a moment while a
   painted write waits (owe), and a write meanwhile sends what the person
   saw (answerTaskOf). */
let drawnAnswer: TaskOk | null = null

/* The sections' side queries (store/liveParts.ts SIDE_NAMES). */
const SECTION_SIDES = ['task', 'links', 'attachments'] as const satisfies readonly SideName[]
type SectionSide = (typeof SECTION_SIDES)[number]
/* What a section's side query answers. */
type TaskAnswer = FunctionReturnType<typeof api.taskWindow.task>
type LinksAnswer = FunctionReturnType<typeof api.taskWindow.links>
type AttachmentsAnswer = FunctionReturnType<typeof api.taskWindow.attachments>
type TaskOk = Extract<TaskAnswer, { state: 'ok' }>
type LinksOk = Extract<LinksAnswer, { state: 'ok' }>
type AttachmentsOk = Extract<AttachmentsAnswer, { state: 'ok' }>
/* A task in a section's answer (convex/lib/taskWindow.ts ShortRow). */
type ShortRow = TaskOk['subtasks']['rows'][number]
/* What a section holds of a task whose create is on its way: a complete,
   empty list, as watchComments gives such a task an empty thread. */
const CREATING = 'creating'
type SectionAnswers = {
  issue: string | null
  task: TaskAnswer | typeof CREATING | null
  links: LinksAnswer | typeof CREATING | null
  attachments: AttachmentsAnswer | typeof CREATING | null
}

/** The task window's sections, by the names the window gives them. */
export type SectionName = 'subtasks' | 'links' | 'attachments'
/* The side query behind each section. */
const SECTION_SIDE: Record<SectionName, SectionSide> = {
  subtasks: 'task',
  links: 'links',
  attachments: 'attachments',
}

/** A task in Subtasks or Linked tasks: the workspace's view of it while
    the workspace holds it, painted, so the person's own edits to it show at
    once, else the section answer's short row. */
export type RelatedTaskVM = {
  uuid: string
  /** what opening it passes on: its handle in the workspace, or for a task
      the workspace does not hold, the handle it will get (taskIndex.ts
      setHandle's rule) */
  handle: string
  /** its organization and number, which a reference to a task the
      workspace does not hold names (lib/taskReference.ts) */
  org: string
  num: number
  title: string
  project: string
  status: string
  owner: string | undefined
  /** whether it has active subtasks; a short row's own leaves are not in
      the answer */
  isGroup: boolean
  done: boolean
  /** whether the workspace holds it; a removal of one it does not hold
      sends from this row (P.setSubtaskParent, P.unlinkTasks) */
  held: boolean
  /** the person's level on its project: the workspace's for a task it
      holds, else the answer's, which a removal's control reads together
      with the workspace's, so a stale source only takes it away */
  level: ShortRow['level'] | null
  remaining: number | undefined
}
/** A task a Subtasks change edits, as the window showed it, for
    P.setSubtaskParent: a Subtasks picker's row
    (convex/lib/relationPicker.ts RelationCandidate) or a row of the
    window's Subtasks list. `row` is the short row the window's list
    shows once it is a subtask, which a pick needs; `parent` and
    `hiddenParent` are its parent as the person saw it, the write's
    expected values. */
export type SubtaskEnd = {
  uuid: string
  row?: RelationCandidate
  parent: string | null
  hiddenParent: boolean
}

/** A row of Linked tasks: the other task, the relation as seen from the
    open task (blocks, blocked_by or relates), and whether the workspace
    holds the link row itself (`linkHeld`). Removing a link sends the kind
    the row shows as the one expected, whether the workspace or only the
    links answer holds it. */
export type LinkedTaskVM = RelatedTaskVM & { type: string; linkHeld: boolean }

/** One of the watched task's sections: where its list stands
    (lib/taskSections.ts SectionState), its rows (none while loading or
    unavailable; those delivered before a failure), whether the list is
    whole, whether an answer arrived for the task, and where the list
    comes from. Until its answer arrives, a section of a workspace that
    holds every task (P.tasksHeld()) lists what the workspace holds, as the window
    did before the sections had their own reads (`source` 'workspace'), so
    a task opened offline or before its answers still shows its lists. */
export type SectionVM<R> = {
  state: SectionState
  rows: R[]
  complete: boolean
  delivered: boolean
  source: 'answer' | 'workspace'
}

/** A file in Attachments, and whether the workspace holds its row, which
    removing it needs. */
export type SectionAttachmentVM = AttachmentVM & { held: boolean }

/** The watched task's Subtasks, Linked tasks and Attachments (P.sections),
    for the task `task`, whose windows alone show them. `hidden` says the
    task has subtasks the person cannot see. An attachment row of a
    description image (`inline`) is no row of the section, and `count`
    counts what the per-task cap counts: every attachment row but those a
    description save took out, images included. */
export type TaskSectionsVM = {
  task: string
  subtasks: SectionVM<RelatedTaskVM> & { hidden: boolean }
  links: SectionVM<LinkedTaskVM>
  attachments: SectionVM<SectionAttachmentVM> & { count: number }
}

/** What the task window shows above the oldest loaded comment
    (P.commentsEarlier), and where the store let comments go between its
    two runs (P.commentsNewer). */
export type CommentsEarlier = 'none' | 'more' | 'loading' | 'failed'

/** One kind's gap as the task window places it (lib/spine.ts spineGap):
    the latest time of a row kept above it and the earliest of a row kept
    below it, in ms, and the ids kept above it, by which the window splits
    the rows when a seeded thread's times run against its order. */
export type ThreadGapSide = { end: number; below: number; above: ReadonlySet<string> }
/** The watched thread's gaps (P.threadGap): the comments' and, while the
    history is held, the changes', each null without one. */
export type ThreadGap = { comments: ThreadGapSide | null; history: ThreadGapSide | null }

/** Whether the watched thread's subscription failed (P.commentsFailure),
    or its history's (P.historyFailure): 'failed' until a later delivery or
    Retry, 'retrying' from Retry until the server answers the new
    subscription, else 'none'. */
export type CommentsFailure = 'none' | 'failed' | 'retrying'

/* Builds the watched thread's rows from its last deliveries and the rows
   loaded before them: the comments, empty while none are delivered (or
   nothing is watched), with the comments held apart for an editor
   (pinnedComments) or at another kind's live instant (apartComments), and
   the history, empty while it is not delivered, with its changes held
   apart (apartEvents) between its runs, where thread order puts them
   among the changes of their instant. The thread's layers paint over them
   (repaint). */
function buildThreadRows() {
  syncPinned()
  syncApart()
  rows.threadEvents =
    historySnap === null
      ? []
      : structuredClone([
          ...new Map(
            [...olderEvents, ...apartEvents.values(), ...newerEvents, ...historySnap].map((r) => [
              r.id,
              r,
            ]),
          ).values(),
        ])
  PLANNER.historyLoaded = historySnap !== null
  if (commentsSnap === null) {
    rows.comments = new Map()
    return
  }
  rows.comments = new Map(
    structuredClone([
      ...olderComments,
      ...apartComments.values(),
      ...newerComments,
      ...commentsSnap,
    ]).map((r) => [r.id, r]),
  )
  for (const [id, row] of pinnedComments)
    if (!rows.comments.has(id)) rows.comments.set(id, structuredClone(row))
  PLANNER.commentsLoaded = true
}

/* Lets go of the comments held apart for an editor (pinnedComments) that a
   run or the live window holds again, or that no editor holds any more. */
function syncPinned() {
  if (pinnedComments.size === 0) return
  const editing = new Set(commentHolds.values())
  const held = new Set(
    [...olderComments, ...newerComments, ...(commentsSnap ?? [])].map((r) => r.id),
  )
  for (const id of pinnedComments.keys())
    if (held.has(id) || !editing.has(id)) pinnedComments.delete(id)
}

/* Lets go of the rows held apart at another kind's live instant
   (apartComments, apartEvents) that a run or the live rows hold again, or
   whose instant no held row of the other kind shares any more, so the
   rest of their instant has gone too. The changes go once the history is
   not held. */
function syncApart() {
  if (historySnap === null) apartEvents.clear()
  if (apartComments.size === 0 && apartEvents.size === 0) return
  const comments = [...olderComments, ...newerComments, ...(commentsSnap ?? [])]
  const events = historySnap === null ? [] : [...olderEvents, ...newerEvents, ...historySnap]
  const commentIds = new Set(comments.map((r) => r.id))
  const eventIds = new Set(events.map((r) => r.id))
  const commentAt = new Set(comments.map((r) => Date.parse(r.created_at)))
  const eventAt = new Set(events.map((r) => Date.parse(r.ts)))
  for (const [id, row] of apartComments)
    if (commentIds.has(id) || !eventAt.has(Date.parse(row.created_at))) apartComments.delete(id)
  for (const [id, row] of apartEvents)
    if (eventIds.has(id) || !commentAt.has(Date.parse(row.ts))) apartEvents.delete(id)
}

/* Closes the watched thread's comment gap and drops the run below it,
   which the caller has placed or let go, and drops any Show newer read on
   its way. */
function dropCommentsGap() {
  commentsGap = null
  newerComments = []
  newerAsk++
  newerLoad = 'idle'
}

/* The same for the history's gap (dropCommentsGap). */
function dropHistoryGap() {
  historyGap = null
  newerEvents = []
  historyNewerAsk++
  historyNewerLoad = 'idle'
}

/* Holds apart (pinnedComments) the comments among `gone`, rows the store
   lets go, that a window has open in its editor, so no editor unmounts
   with its draft. */
function pinEditing(gone: readonly Row<'comments'>[]) {
  if (commentHolds.size === 0) return
  const editing = new Set(commentHolds.values())
  for (const row of gone) if (editing.has(row.id)) pinnedComments.set(row.id, row)
}

/* Joins the comments' gap to the thread's start once deletes emptied the
   run above it, as a release from the top does. The run below becomes the
   only one, and Show earlier comments reads the released comments back
   before it. Without this, Show earlier would read before the live window
   and add released comments above a gap that still lists them. */
function joinEmptyRun() {
  if (commentsGap === null || olderComments.length > 0) return
  olderComments = newerComments
  threadStart = false
  dropCommentsGap()
}

/* Records a delivery of the watched thread's live window, oldest first in
   thread order, and whether the thread holds earlier comments. Comments that
   left the window at its old end join the run just above it, the newer run
   while a gap is open, else olderComments, so what a reader loaded stays
   while new comments arrive, until a release lets it go (keepThread). A
   window with nothing earlier starts the thread, so nothing loaded before
   it exists any more. Returns the comments that just left the window,
   oldest first, since a delivery alone cannot tell one deleted from the old
   end from one that slid out (checkSlidOut). A window that reaches back
   into what was loaded, as after a delete inside it, keeps the rows before
   its first comment: in the newer run that run up to it, in the gap the
   ids before it with no newer run (a window that starts at the gap's first
   id meets the run above, so the gap closes), and in the run above that
   run up to it with no gap. When the window no longer meets what was
   loaded, because more comments arrived between two deliveries than it
   holds, the thread starts over from the window, with no gap and no
   comment held apart at a change's instant (apartComments), and a comment
   open in an editor among the comments it lets go, the previous window's
   included, is held apart (pinEditing). A comment held apart for an
   editor stays through every one of these. */
function receiveThread(page: { comments: Row<'comments'>[]; earlier: boolean }): Row<'comments'>[] {
  const prev = commentsSnap
  const first = page.comments[0]
  let slid: Row<'comments'>[] = []
  if (first === undefined || !page.earlier) {
    olderComments = []
    apartComments.clear()
    dropCommentsGap()
  } else if (prev !== null) {
    const at = prev.findIndex((r) => r.id === first.id)
    if (at > 0) {
      const known = new Set([...olderComments, ...newerComments].map((r) => r.id))
      slid = prev.slice(0, at)
      const moved = slid
        .filter((r) => !known.has(r.id) && acceptedCommentChanges.get(r.id) !== null)
        .map((r) => {
          const change = acceptedCommentChanges.get(r.id)
          return change ? { ...r, ...change } : r
        })
      if (commentsGap === null) olderComments = [...olderComments, ...moved]
      else newerComments = [...newerComments, ...moved]
    } else if (at === -1) {
      // the window reached down into what was loaded before it, or past it
      const inNewer = newerComments.findIndex((r) => r.id === first.id)
      const inGap = commentsGap?.indexOf(first.id) ?? -1
      const kept = olderComments.findIndex((r) => r.id === first.id)
      if (inNewer !== -1) newerComments = newerComments.slice(0, inNewer)
      else if (commentsGap !== null && inGap > 0) {
        const before = commentsGap.slice(0, inGap)
        dropCommentsGap()
        commentsGap = before
      } else if (inGap === 0) dropCommentsGap()
      else {
        // Starting over lets go of loaded comments that still exist, the
        // previous live window's included, so the one open in an editor is
        // held apart, with my accepted edit on it. One the new window holds
        // goes back to it (syncPinned).
        if (kept === -1)
          pinEditing([
            ...olderComments,
            ...newerComments,
            ...prev.flatMap((r) => {
              const change = acceptedCommentChanges.get(r.id)
              return change === null ? [] : [change ? { ...r, ...change } : r]
            }),
          ])
        dropCommentsGap()
        olderComments = kept === -1 ? [] : olderComments.slice(0, kept)
        if (kept === -1) {
          threadStart = false
          apartComments.clear()
        }
      }
    }
  }
  // the first page decides, also after the empty thread a new task shows
  // while its create is on its way (subscribeWaitingThread)
  if (prev === null) threadStart = !page.earlier
  else if (!page.earlier) threadStart = true
  // a fresh window holds the comments in it as the server has them now
  for (const comment of page.comments) acceptedCommentChanges.delete(comment.id)
  commentsSnap = page.comments
  return slid
}

/* Records a delivery of the watched task's live history page. The page
   is the server's word on every row from its first on, so a loaded row in
   that stretch that the page does not hold is gone. The first page since
   the history started over starts it, and so do a page with nothing
   earlier, which holds the whole history, and an empty page with rows
   before it, which leaves nothing loaded a place beside it. A page whose
   first row the last one held slid forward as new rows arrived: the rows
   before that one left at its old end and move to olderEvents, so the
   history a reader loaded stays. A page whose first row is in olderEvents
   reaches back into what was loaded, and the loaded rows from that one on
   give way to it. Neither moves historyNext, which stays older than every
   row they hold. While a gap is open (historyGap) the rows that left the
   page join the run below it, and a page that reaches back into that run,
   into the gap or above it keeps what is before its first row as
   receiveThread does for the comments. Any other page begins with no
   loaded row, because more rows arrived between two deliveries than it
   holds or the person can now see a row they could not, and starts the
   history over from it. */
function receiveHistory(page: {
  events: Row<'activity_events'>[]
  earlier: boolean
  next: string | null
}) {
  const prev = historySnap ?? []
  const head = page.events[0]
  const at = head ? prev.findIndex((r) => r.id === head.id) : -1
  const back = head ? olderEvents.findIndex((r) => r.id === head.id) : -1
  const inNewer = head ? newerEvents.findIndex((r) => r.id === head.id) : -1
  const inGap = head && historyGap ? historyGap.indexOf(head.id) : -1
  if (historySnap === null || !page.earlier || head === undefined) restartHistory(page)
  else if (at !== -1) {
    const known = new Set([...olderEvents, ...newerEvents].map((r) => r.id))
    const moved = prev.slice(0, at).filter((r) => !known.has(r.id))
    if (historyGap === null) olderEvents = [...olderEvents, ...moved]
    else newerEvents = [...newerEvents, ...moved]
  } else if (inNewer !== -1) newerEvents = newerEvents.slice(0, inNewer)
  else if (historyGap !== null && inGap > 0) {
    const before = historyGap.slice(0, inGap)
    dropHistoryGap()
    historyGap = before
  } else if (inGap === 0) dropHistoryGap()
  else if (back !== -1) {
    dropHistoryGap()
    olderEvents = olderEvents.slice(0, back)
  } else restartHistory(page)
  historySnap = page.events
}

/* Starts the watched task's history over from a live page that says
   whether it has rows before it and where they start: nothing loaded
   before the page, no earlier page loading, and one asked for before this
   dropped when it answers, so Show earlier activity reads on from the
   page. The caller sets the page itself. */
function restartHistory(page: { earlier: boolean; next: string | null }) {
  historyEpoch++
  olderEvents = []
  apartEvents.clear()
  dropHistoryGap()
  historyStart = !page.earlier
  historyNext = page.next
  historyLoad = 'idle'
}

/* Drops the watched task's history and starts it over, empty until its
   subscription delivers again. The caller stops the subscription when no
   window shows All any more, and repaints. */
function resetHistory() {
  historyEpoch++
  historySnap = null
  olderEvents = []
  apartEvents.clear()
  dropHistoryGap()
  historyNext = null
  historyStart = false
  historyLoad = 'idle'
  PLANNER.historyFailure = 'none'
}

/* Drops the comments in `slid` that were deleted rather than pushed out of
   the watched thread's window, which now starts at the comment `firstId`.
   It asks for the page before that comment once (snapshot.commentsBefore).
   Comments only ever join a thread at its end, so every comment between the
   oldest slid-out one and the window that still exists is on that page,
   unless the page stops short of it (long comments). A slid-out comment the
   page reaches but does not hold was deleted. When the page starts the
   thread and everything on it is loaded, the whole thread is. `current`
   says whether the same subscription still watches the thread when the
   answer comes. A failed read changes nothing, and the comments stay until
   the task opens again. */
async function checkSlidOut(
  orgId: string,
  issueUuid: string,
  firstId: string,
  slid: Row<'comments'>[],
  current: () => boolean,
) {
  let page: FunctionReturnType<typeof api.snapshot.commentsBefore>
  try {
    page = await convex.query(api.snapshot.commentsBefore, {
      org_id: orgId,
      issue_id: issueUuid,
      before: firstId,
    })
  } catch (e) {
    console.error('[qivo] could not check comments that left the live window:', e)
    return
  }
  if (!current()) return
  const held = new Set(page.comments.map((r) => r.id))
  // A page that starts the thread reaches all of them. Otherwise its oldest
  // comment, when it is one of them, is as far back as it reaches, and any
  // other oldest comment is older than all of them.
  const reach =
    page.earlier && page.comments[0] ? slid.findIndex((r) => r.id === page.comments[0].id) : 0
  const gone = slid.slice(Math.max(reach, 0)).filter((r) => !held.has(r.id))
  const drop = new Set(gone.map((r) => r.id))
  // wherever they went, the run above the live window or the one below a gap
  olderComments = olderComments.filter((r) => !drop.has(r.id))
  newerComments = newerComments.filter((r) => !drop.has(r.id))
  joinEmptyRun()
  // A page that starts the thread before an unmoved window, all of it
  // loaded, means nothing earlier is left to load.
  const loaded = new Set(olderComments.map((r) => r.id))
  const start =
    commentsGap === null &&
    !threadStart &&
    !page.earlier &&
    commentsSnap?.[0]?.id === firstId &&
    page.comments.every((r) => loaded.has(r.id))
  if (start) threadStart = true
  if (!gone.length && !start) return
  // the anchors changed, and the thread's layers paint again over them
  repaint({ thread: true })
}

/* Drops the comment `id` from the watched thread's server truth, for a
   comment the server says no longer exists: from its run, the live window,
   the gap's ids and the comments held apart. A gap whose run above it
   empties joins the thread's start (joinEmptyRun). The caller repaints. */
function dropComment(id: string) {
  olderComments = olderComments.filter((r) => r.id !== id)
  newerComments = newerComments.filter((r) => r.id !== id)
  if (commentsGap?.includes(id)) commentsGap = commentsGap.filter((gone) => gone !== id)
  pinnedComments.delete(id)
  apartComments.delete(id)
  if (commentsSnap) commentsSnap = commentsSnap.filter((r) => r.id !== id)
  joinEmptyRun()
}

/* A comment as the release walks it (lib/threadBudget.ts HeldRow), with
   its row. */
type HeldComment = { id: string; ts: number; row: Row<'comments'> }
/* A change as the release walks it. */
type HeldChange = { id: string; ts: number; row: Row<'activity_events'> }
const heldComment = (row: Row<'comments'>): HeldComment => ({
  id: row.id,
  ts: Date.parse(row.created_at),
  row,
})
const heldChange = (row: Row<'activity_events'>): HeldChange => ({
  id: row.id,
  ts: Date.parse(row.ts),
  row,
})

/* What the store holds of the watched thread, as the release walks it: the
   comments, and the history while it is held. */
function heldThread(): { comments: HeldKind<HeldComment>; history: HeldKind<HeldChange> | null } {
  return {
    comments: {
      older: olderComments.map(heldComment),
      gap: commentsGap,
      newer: newerComments.map(heldComment),
      live: (commentsSnap ?? []).map(heldComment),
    },
    history:
      historySnap === null
        ? null
        : {
            older: olderEvents.map(heldChange),
            gap: historyGap,
            newer: newerEvents.map(heldChange),
            live: historySnap.map(heldChange),
          },
  }
}

/* Starts the rows a press of Show earlier (`earlier`) or Show newer keeps
   (pressKeep): the rows the window measures to keep the reader's place,
   each kind's oldest row for Show earlier and each kind's last row above
   the gap for Show newer. A load that starts while another is on its way
   adds its rows to what that one keeps. Under All one press reads both
   kinds one after the other, and a Show newer press made while Show
   earlier still loads keeps the row above it, so the earlier page's
   release cannot take the row its read joins under. */
function startPress(direction: 'earlier' | 'newer') {
  const loading = [earlierLoad, historyLoad, newerLoad, historyNewerLoad].includes('loading')
  if (!loading) pressKeep = new Set()
  const ids =
    direction === 'earlier'
      ? [
          (olderComments[0] ?? newerComments[0] ?? commentsSnap?.[0])?.id,
          historySnap === null
            ? undefined
            : (olderEvents[0] ?? newerEvents[0] ?? historySnap[0])?.id,
        ]
      : [olderComments.at(-1)?.id, olderEvents.at(-1)?.id]
  for (const id of ids) if (id !== undefined) pressKeep.add(id)
}

/* The rows on screen around each place a window reported (threadPlaces),
   the reported row and the 50 rows after it in time order, both kinds
   counted, which every release keeps (keepThread). A comment held apart for its
   editor (pinnedComments) shows at its time outside every run, so a place
   on it keeps the 50 held rows from its time on, the ones under it on
   screen. Also answers the topmost place, by the held row it starts at,
   and the kind whose run above the gap holds that row, for an arrival's
   side (arrivalMoves). */
function placesKept(held: ReturnType<typeof heldThread>): {
  keep: Set<string>
  top: { kind: HeldKind | null; at: number; ts: number } | null
} {
  const keep = new Set<string>()
  const kinds: HeldKind[] = held.history ? [held.comments, held.history] : [held.comments]
  const merged = kinds
    .flatMap((k) => [...k.older, ...k.newer, ...k.live])
    .sort((a, b) => a.ts - b.ts)
  let top: { kind: HeldKind | null; at: number; ts: number } | null = null
  for (const first of threadPlaces.values()) {
    if (first === null) continue
    let i = merged.findIndex((r) => r.id === first)
    let after = 51
    const apart = i === -1 ? pinnedComments.get(first) : undefined
    if (apart) {
      const ts = Date.parse(apart.created_at)
      i = merged.findIndex((r) => r.ts >= ts)
      after = 50
    }
    if (i === -1) continue
    for (const r of merged.slice(i, i + after)) keep.add(r.id)
    const { id, ts } = merged[i]
    if (top !== null && top.ts <= ts) continue
    const kind = kinds.find((k) => k.older.some((r) => r.id === id)) ?? null
    top = { kind, at: kind ? kind.older.findIndex((r) => r.id === id) : -1, ts }
  }
  return { keep, top }
}

/* Which sides a release after an arrival, or after an editor closed, takes
   (keepThread), in order, from the topmost place a window reported
   (placesKept). With no place reported, or the topmost one at or below a
   gap or in the live rows, the oldest side goes. A reader above a gap
   keeps the rows around them, so the newer run goes from the gap down,
   then the end of the run they read in that is farther from them, then its
   other end. With no gap, the farther end and then the other. The live
   rows never go, so they do not count toward the distance to the newest
   end. */
function arrivalMoves(
  held: ReturnType<typeof heldThread>,
  top: ReturnType<typeof placesKept>['top'],
): ReleaseMove[] {
  if (top === null || top.kind === null) return ['top']
  const kinds: HeldKind[] = held.history ? [held.comments, held.history] : [held.comments]
  const gaps = kinds.filter((k) => k.gap !== null)
  // a row of a kind without a gap counts as above the other kind's gap
  // when it is no later than that gap's last row above
  const gapEnd = Math.min(
    ...gaps.map((k) => k.older.reduce((max, r) => Math.max(max, r.ts), Number.NEGATIVE_INFINITY)),
  )
  if (gaps.length && top.kind.gap === null && top.ts > gapEnd) return ['top']
  const toTop = top.at
  const toEnd = top.kind.older.length - 1 - top.at
  const sides: ReleaseMove[] = toTop > toEnd ? ['top', 'up'] : ['up', 'top']
  return gaps.length ? ['down', ...sides] : sides
}

/* Lets go of the watched thread's rows past THREAD_KEEP.rows
   (lib/threadBudget.ts releaseThread), on the side `why` names: after an
   earlier page (`earlier`) the newer side, after a newer page the oldest
   side, after an arrival (a delivery of the live window or page, the
   history's first included) or an editor closing the sides arrivalMoves
   picks. It never takes the live window or page, the rows the last press
   keeps (pressKeep) after that press's page, or the rows on screen around
   any window's reported place (placesKept), it never splits an instant,
   and it passes over a comment open in an editor, which it holds apart
   (pinnedComments), and a row at an instant only the other kind's live
   rows hold, which it holds apart within the budget (apartComments,
   apartEvents). Released comments leave acceptedCommentChanges, since
   a read brings them back with the server's text, edits included. A
   release from the top unloads that kind's start, and the history then
   reads on before its oldest kept row (historyNext). The caller repaints.
   Answers whether rows went. */
function keepThread(why: 'earlier' | 'newer' | 'arrival'): boolean {
  if (commentsSnap === null) return false
  syncApart()
  const held = heldThread()
  // the rows held apart from earlier releases count, outside the runs
  const apart = apartComments.size + apartEvents.size
  const count =
    apart +
    olderComments.length +
    newerComments.length +
    commentsSnap.length +
    (historySnap === null ? 0 : olderEvents.length + newerEvents.length + historySnap.length)
  if (count <= THREAD_KEEP.rows) return false
  const places = placesKept(held)
  const moves: ReleaseMove[] =
    why === 'arrival'
      ? arrivalMoves(held, places.top)
      : why === 'earlier'
        ? ['down', 'up']
        : ['top']
  const after = releaseThread({
    comments: held.comments,
    history: held.history,
    keep: why === 'arrival' ? places.keep : new Set([...pressKeep, ...places.keep]),
    pinned: new Set(commentHolds.values()),
    moves,
    budget: THREAD_KEEP.rows - apart,
  })
  if (!after) return false
  const c = after.comments
  olderComments = c.older.map((h) => h.row)
  newerComments = c.newer.map((h) => h.row)
  commentsGap = c.gap
  if (c.fromTop) threadStart = false
  for (const h of c.released) acceptedCommentChanges.delete(h.id)
  pinEditing(c.released.map((h) => h.row))
  for (const h of c.apart) apartComments.set(h.id, h.row)
  const e = after.history
  if (e && historySnap !== null) {
    olderEvents = e.older.map((h) => h.row)
    newerEvents = e.newer.map((h) => h.row)
    for (const h of e.apart) apartEvents.set(h.id, h.row)
    historyGap = e.gap
    if (e.fromTop) {
      historyStart = false
      historyNext = (olderEvents[0] ?? newerEvents[0] ?? historySnap[0])?.id ?? null
    }
  }
  return true
}

/* Closes both gaps with the rows above them, for the history starting or
   stopping (P.showHistory): the window opens the other filter at its
   newest end, so the runs below the gaps are what it reads, and Show
   earlier reads on from them. A comment open in an editor among the rows
   that go is held apart. */
function dropAboveGap() {
  if (commentsGap !== null) {
    pinEditing(olderComments)
    olderComments = newerComments
    threadStart = false
    dropCommentsGap()
  }
  if (historyGap !== null && historySnap !== null) {
    olderEvents = newerEvents
    historyStart = false
    dropHistoryGap()
    historyNext = (olderEvents[0] ?? historySnap[0])?.id ?? null
  }
}

/* The server's row of task `uuid` in the last snapshot delivery. A task the
   rows show without one is a create still on its way, painted by its layer,
   which the server does not know yet. */
const serverTask = (uuid: string) => base.stagedTask(uuid)

/* The workspace's row of the watched task while it holds the task in the
   watched organization (watchedOrg), else undefined. Another
   organization's task of the same id, which the workspace may hold
   instead, is not the watched task, and the window shows the watched one
   from its own read (P.taskDetail). */
function watchedRow(): Row<'issues'> | undefined {
  const t = watchedComments
  const row = t ? rows.issues.get(t) : undefined
  return row && (!watchedOrg || row.org_id === watchedOrg) ? row : undefined
}

/* Whether the workspace holds task `uuid` in organization `org`. It holds
   one task by an id, and two organizations can hold one task id, so a
   held task of another organization is another task, which no write or
   paint of this one reaches. It reads the row without copying it, so a
   paint that only asks copies no row (store/rowMap.ts peek). */
const holdsIn = (uuid: string, org: string): boolean => rows.issues.peek(uuid)?.org_id === org

/* Whether the workspace holds another organization's task than `org`'s
   by id `uuid`, read as holdsIn reads it. */
function heldElsewhere(uuid: string, org: string): boolean {
  const row = rows.issues.peek(uuid)
  return !!row && row.org_id !== org
}

/* The views' copies of task `uuid` of organization `org` that a paint may
   change (store/viewRows.ts edit), without another organization's task of
   the same id that a view holds. */
const viewCopiesIn = (uuid: string, org: string) =>
  viewRows.edit(uuid).filter((copy) => copy.org_id === org)

/* The organization of the watched task, the one kept for it (watchedOrg),
   else its row's while the workspace holds it, or undefined. */
function watchedOrgOf(): string | undefined {
  if (!watchedComments) return undefined
  return watchedOrg ?? watchedRow()?.org_id
}

/* The organization of task `uuid` for a comment write or read. It is the
   watched task's kept one (watchedOrg) when it is the watched task, so a
   comment never goes to another organization's task of the same id that
   the workspace holds, else its row's while the workspace holds it, else
   the row an open view's answer brings, as a Team sync card's mention
   names its task, or undefined. The server checks the comment either
   way. */
function orgOfTask(uuid: string): string | undefined {
  if (uuid === watchedComments && watchedOrg) return watchedOrg
  const row = rows.issues.get(uuid)
  if (row) return row.org_id
  return viewRows.peek(uuid)?.org_id
}

/* The tasks this store created that the server took, by uuid, with their
   organization. Until a delivery holds such a task, as while every task
   loads, when no delivery holds any (askTasks), its window reads its
   thread and its lists from the server all the same, so its Move and
   Archive or delete wait only for its own answer (P.familyOf). */
const tookCreates = new Map<string, string>()

/** What a create of the person's own keeps while it is on its way
    (P.addIssue, P.createParent, P.createLinked), by the new task's uuid:
    its organization, its row as the create sends it, by the server's
    rules, numbered with the preview until the create answers, moved past
    a number another task took meanwhile (renumberPending), the create's
    answer once it came (`created`), the person's
    level on its project, the short rows of its parent (a subtask) and of
    its one subtask (a new parent), and whether the server took it. A
    window on the task the workspace does not hold shows it from the
    creating answer built from it (creatingAnswerOf) and reads nothing
    about it from the server until the server took it, since the task
    does not exist there before. The entry goes when the server refuses
    the create (refusedCreates), and once the server took it, at once when
    no window shows the creating answer, else with that window's first own
    answer, which a failed read is not (receiveSection), or when another
    task is watched. */
type PendingCreate = {
  org: string
  row: Row<'issues'>
  created: Created
  level: ShortRow['level']
  parent: ShortRow | null
  child: ShortRow | null
  taken: boolean
  /** the creating answer last built, kept while `created` holds the same
      row and number: issues.createParent answers a number alone */
  answer: { from: Created['row']; num: Created['num']; answer: TaskOk } | null
}

/** A create's answer, captured for its paints (store/layers.ts rule 2):
    the server's number, and the row it stored where its answer is the
    row (issues.create, issues.createLinked), merged over the row the
    create sent, since an answer may name fewer fields. */
type Created = { num: number | null; row: Partial<Row<'issues'>> | null }

const pendingCreates = new Map<string, PendingCreate>()

/* The creates of the person's own the server refused, by uuid. A window
   on one shows it as gone without asking the server (watchedGone), and the
   writes sent behind it say nothing more than the create's own refusal
   did (refusedBehind). Cleared with the store. */
const refusedCreates = new Set<string>()

/* The creating answers the section answers held, so the store tells one
   from an answer the server sent (creatingShown). */
const creatingAnswers = new WeakSet<object>()

/* The references of the person's new tasks that moved since the store last
   told P.watchHandles' listeners, by uuid, from the one a caller holds to
   the one it opens by now (movePendingRef, tellPendingMoves). */
const pendingMoves = new Map<string, { from: string; to: string }>()

/** Records that the reference of the person's new task `uuid` moved from
    `from` to `to`, joined to a move not told yet, so a caller holding the
    first follows to the last. */
function movePendingRef(uuid: string, from: string, to: string) {
  if (from === to) return
  const was = pendingMoves.get(uuid)
  pendingMoves.set(uuid, { from: was?.from ?? from, to })
}

/** Tells P.watchHandles' listeners the moves of the person's new tasks'
    references not told yet (movePendingRef), once the screen shows them. */
function tellPendingMoves() {
  if (pendingMoves.size === 0) return
  const moved = new Map([...pendingMoves.values()].map(({ from, to }) => [from, to]))
  pendingMoves.clear()
  moveHandles(moved)
}

/** Moves the number of each create of the person's own on its way past a
    number another task holds, as another person's create that a view's
    answer brings before this create answers. The new number is the next
    one that no task the views' answers or the workspace hold in its
    organization has, nor a create of the person's own sent before it,
    and is past the organization's counter as the server last sent it, as
    newTaskPaint numbers a new task in a store that asked. The creates go in the order
    sent, as the server numbers them. The number is the sent row's
    (`row.num`), which the create's paints, its creating answer and the
    reference a caller holds all read, so no two of the views' models
    share a handle (store/viewRows.ts) and a card opened or dropped acts on
    its own task; a caller holding the reference follows it
    (movePendingRef). A create the server answered keeps the server's
    number, and one the server took or the workspace holds stays as it
    is. One that a view's answer already holds takes the number that
    answer gives it, the server's, before any other number is looked
    for, as when another create took the preview and both reach the views
    in one answer before this create answers. Runs as a view takes an
    answer and as a create is sent, before the views repaint. */
function renumberPending() {
  const numbered = new Map<string, Map<number, string>>()
  const sent = new Set<string>()
  let moved = false
  for (const [uuid, pending] of pendingCreates) {
    const { row, created } = pending
    const org = row.org_id
    const held = (num: number) => {
      if (sent.has(`${org}:${num}`)) return true
      let views = numbered.get(org)
      if (!views) {
        views = viewRows.numbered(org)
        numbered.set(org, views)
      }
      const other = views.get(num) ?? keyByOrg.get(org)?.get(`${ISSUE_PREFIX}-${num}`)
      return other !== undefined && other !== uuid
    }
    if (created.num === null && !pending.taken && !holdsIn(uuid, org)) {
      const answered = viewRows.numberOf(uuid)
      let num = answered ?? row.num
      if (answered === undefined && held(row.num)) {
        const counter = base.map('orgs').get(org)?.next_issue_num || 0
        num = Math.max(row.num + 1, counter + 1)
        while (held(num)) num++
      }
      if (num !== row.num) {
        movePendingRef(uuid, taskRef({ org, num: row.num, uuid }), taskRef({ org, num, uuid }))
        row.num = num
        // a window on it shows the new number from its creating answer
        pending.answer = null
        moved = true
      }
    }
    sent.add(`${org}:${created.num ?? row.num}`)
  }
  // the organization's counter, the views' rows, the creating answer and
  // a parent's Subtasks list in the window show the new number
  if (moved) {
    owe('workspace')
    owe('view')
    owe('sections')
  }
}

/** The row of pending create `pending` as the window shows it: the row it
    sent with what the create's answer gave over it (answeredRow), and the
    server's number once it answered. */
const pendingRow = (pending: PendingCreate): Row<'issues'> =>
  answeredRow(pending.row, pending.created)

/** New task `row` as the create sent it, with the stored row the create
    answered over it, `created`, and the server's number once it answered.
    The task's identity, its text, which the answer leaves out, and its
    parent, which the answer names only where the person sees it, stay
    the sent row's. */
function answeredRow(row: Row<'issues'>, created: Created): Row<'issues'> {
  return {
    ...row,
    ...created.row,
    id: row.id,
    org_id: row.org_id,
    num: created.num ?? row.num,
    description: row.description,
    parent_id: row.parent_id,
  }
}

/** The creating answer of task `uuid` (store/taskDetail.ts creatingAnswer),
    while it is a create of the person's own the server has not taken or
    whose window has not read it yet, and the workspace does not hold it;
    else null. The same object while the create's answer is the same, its
    row and its number, so the window's painted answer is built again only
    when it changes. */
function creatingAnswerOf(uuid: string): TaskOk | null {
  const pending = pendingCreates.get(uuid)
  if (!pending || holdsIn(uuid, pending.org)) return null
  const { row, num } = pending.created
  if (pending.answer?.from === row && pending.answer.num === num) return pending.answer.answer
  const answer = anchor(
    creatingAnswer({
      row: pendingRow(pending),
      level: pending.level,
      me: profileIn(pending.org) || undefined,
      parent: pending.parent,
      child: pending.child,
    }),
  )
  creatingAnswers.add(answer)
  pending.answer = { from: row, num, answer }
  return answer
}

/** Whether the watched task's own answer in the sections is a creating
    answer (creatingAnswerOf), not one the server sent. */
function creatingShown(): boolean {
  const t = watchedComments
  const answer = t && sectionAnswers.issue === t ? sectionAnswers.task : null
  return !!answer && answer !== CREATING && creatingAnswers.has(answer)
}

/** Whether task `uuid` is a create of the person's own the server has not
    taken yet, which the workspace does not hold: its card's owner list
    waits, since the server cannot read a task it does not hold yet. */
function createOnItsWay(uuid: string): boolean {
  const pending = pendingCreates.get(uuid)
  return !!pending && !pending.taken && !holdsIn(uuid, pending.org)
}

/* Notes that the server took the create of task `uuid` in organization
   `org` (tookCreates), from P.addIssue, P.createParent or P.createLinked,
   and has a window watching it read its thread and lists once the write's
   answer has painted (owe), since the create's own paints changed with its
   answer (keep). A window that shows the task from its creating answer
   shows the answer's number and stamps until its own read answers; with
   none, the pending create goes. */
function tookCreate(uuid: string, org: string) {
  tookCreates.set(uuid, org)
  const pending = pendingCreates.get(uuid)
  if (pending) pending.taken = true
  const shows = watchedComments === uuid && creatingShown()
  if (pending && !shows) pendingCreates.delete(uuid)
  if (shows) {
    const answer = creatingAnswerOf(uuid)
    if (answer) sectionAnswers = { ...sectionAnswers, task: answer }
  }
  if (watchedComments === uuid) {
    owe('thread')
    owe('sections')
  }
}

/* Whether the watched task is one whose create is on its way: a create of
   the person's own the server has not taken yet (pendingCreates), or one
   the rows show, the last snapshot delivery does not hold and the server
   has not taken yet (tookCreates), or the store knows no organization for
   it. Such a task gets an empty, complete thread, history and lists until
   a delivery holds it or the server takes the create
   (subscribeWaitingThread). */
function watchedCreating(): boolean {
  const t = watchedComments
  if (!t) return false
  const pending = pendingCreates.get(t)
  if (pending && !pending.taken) return true
  return !serverTask(t) && !tookCreates.has(t) && (rows.issues.has(t) || !watchedOrg)
}

/* Subscribes to the watched thread once the snapshot holds its task or the
   server took its create (tookCreates), for a task watched while its
   create was on its way (watchComments), and with
   the kept organization (watchedOrg) for a task the workspace does not
   hold. Asking earlier for a task whose create is on its way would refuse
   with not_found, which the server logs as an error, and so would asking
   for a task its answer says is gone (watchedGone). Runs after each
   snapshot delivery and after a boot, so a re-init of the parts brings the
   thread back, and again once the rows show a delivery (syncThread), as a
   delivery that leaves the task out runs this before its rows do. */
function subscribeWaitingThread() {
  const t = watchedComments
  if (!t || threadWatched || watchedGone()) return
  const server = serverTask(t)
  const row = server && (!watchedOrg || server.org_id === watchedOrg) ? server : undefined
  const took = tookCreates.get(t)
  if (row) subscribeThread(t, row.org_id)
  else if (took) subscribeThread(t, took)
  // a create of the person's own on its way reads nothing before the
  // server took it
  else if (watchedOrg && !watchedRow() && !pendingCreates.has(t)) subscribeThread(t, watchedOrg)
}

/* Subscribes to the watched thread `issueUuid` in organization `orgId`, as
   the thread side query of the live parts, replacing any earlier one, to
   its history too while a window shows All (startHistory), and to its
   section sides while a window wants them (syncSections). Its answers
   come with the transitions that bring them (threadNews), so one that also
   changes the workspace repaints once. A delivery is the thread's new
   anchor, and the comment writes still waiting paint over it again (owe),
   so a server echo cannot erase an optimistic comment before its write
   answers. A fresh subscription always runs the query again, so an answer
   is never one held from an earlier subscription. */
function subscribeThread(issueUuid: string, orgId: string) {
  if (!parts) return
  threadWatched = { task: issueUuid, org: orgId }
  parts.watchSide('thread', api.snapshot.threadComments, { org_id: orgId, issue_id: issueUuid })
  subscribeItem(issueUuid, orgId)
  if (historyOwners.size > 0) startHistory()
  syncSections()
}

/* Stops the thread's side query, and the inbox item's beside it. */
function stopThread() {
  parts?.stopSide('thread')
  threadWatched = null
  stopItem()
}

/* Watches the inbox item of task `issueUuid` in organization `orgId`
   (convex/inbox.ts item) beside its thread, so one item read runs per
   store, for the task whose thread it watches, and its first answer comes
   with the thread's (itemNews). The answer held for the same task and
   organization stays, as not current until the new subscription answers,
   as after a re-init of the parts; another task's goes, with the window's
   last read on open, its rerun and its hold. A subscription that already
   watches these arguments goes on, unless its answer failed. */
function subscribeItem(issueUuid: string, orgId: string) {
  if (!parts) return
  const held = PLANNER.inboxItem
  const same = held?.task === issueUuid && held.org === orgId
  if (!same) {
    PLANNER.inboxItem = {
      task: issueUuid,
      org: orgId,
      state: 'loading',
      item: null,
      current: false,
    }
    itemRead = null
    itemFresh = false
    itemRerun = false
    itemHold = freeHold()
  }
  const args = parts.sideArgs('item')
  const watching = args?.org_id === orgId && args.issue_id === issueUuid
  if (watching && held?.state !== 'failed') return
  itemFresh = false
  parts.watchSide('item', api.inbox.item, { org_id: orgId, issue_id: issueUuid })
}

/* Stops the inbox item's side query, and forgets its answer, the
   window's last read on open, its rerun and its hold. */
function stopItem() {
  parts?.stopSide('item')
  PLANNER.inboxItem = null
  itemRead = null
  itemFresh = false
  itemRerun = false
  itemHold = freeHold()
}

/* Holds off the read on open of the watched task while a write about the
   loaded messages `ids` waits, when they name one of its messages, as an
   id-list Mark as unread or snooze does (holdWatched). Only the store's
   tests send those since the Inbox acts on items (holdUnreadOfItem); it
   goes with them. */
function holdUnreadOf(ids: readonly string[]): SendOptions<unknown> {
  const watched = threadWatched
  if (!watched) return {}
  const ofTask = ids.some((id) => {
    const row = rows.messages.get(id)
    return row?.issue_id === watched.task && row.org_id === watched.org
  })
  return ofTask ? holdWatched(watched.task) : {}
}

/* Holds off the read on open of the watched task while a write about its
   inbox item waits, when `org` and `task` name it, as the person's own
   Mark as unread, snooze or its end does (holdWatched). Another
   organization's task of the same id holds nothing. */
function holdUnreadOfItem(org: string, task: string): SendOptions<unknown> {
  const watched = threadWatched
  return watched?.task === task && watched.org === org ? holdWatched(task) : {}
}

/* Holds off the read on open of the watched task `task` while one write
   waits (itemHold), and answers the handlers send() runs for that write.
   The hold stays for the rest of the visit once the server accepts the
   write, until a row's Mark as read of the task that went out after it
   is accepted (P.readItem). A refusal or a failure takes away only this
   write's part, so an unread choice the server accepted and no accepted
   read superseded, before or since, still holds. Once nothing holds, a
   read on open the hold turned away runs again, so an update that
   arrived while the write waited is read as it would have been without
   it. A write of an earlier visit changes nothing. Call it just before
   the write goes out. */
function holdWatched(task: string): SendOptions<unknown> {
  const n = ++holdWrites
  const hold = itemHold
  hold.waiting.add(n)
  return {
    onOk: () => {
      if (hold === itemHold) hold.accepted = Math.max(hold.accepted, n)
    },
    onSettled: () => {
      if (hold !== itemHold) return
      hold.waiting.delete(n)
      // refused or failed, or an accepted read superseded it, so the read
      // the window asked for meanwhile goes out, unless another unread
      // choice still holds
      if (heldBack(hold) || !hold.keptBack) return
      hold.keptBack = false
      PLANNER.readOnOpen(task)
    },
  }
}

/* Sets the mark of the item of task `task` in organization `org` for a
   write that goes out now, replacing any before, and answers it, so the
   write settles only its own (settleInboxMark). */
function setInboxMark(org: string, task: string, mark: Omit<InboxMark, 'settled'>): InboxMark {
  const [set] = setInboxMarks([{ org, task, mark }])
  return set.mark
}

/* One mark of a write, with the item it marks. */
type MarkOf = { org: string; task: string; mark: InboxMark }

/* setInboxMark for several items at once, with one repaint. */
function setInboxMarks(
  marks: readonly { org: string; task: string; mark: Omit<InboxMark, 'settled'> }[],
): MarkOf[] {
  const set = marks.map(({ org, task, mark }) => {
    const one: InboxMark = { ...mark, settled: false }
    inboxMarks.set(inboxMarkKey(org, task), one)
    return { org, task, mark: one }
  })
  if (set.length) showInboxMarks()
  return set
}

/* Settles `mark` of the item of task `task` in organization `org` once its
   write was answered. An accepted one stays until an Inbox shows a current
   answer (P.endInboxMarks), a refused or failed one ends at once. A mark a
   later write replaced is not touched. */
function settleInboxMark(org: string, task: string, mark: InboxMark, accepted: boolean) {
  settleInboxMarks([{ org, task, mark }], accepted)
}

/* settleInboxMark for several marks at once, with one repaint. */
function settleInboxMarks(marks: readonly MarkOf[], accepted: boolean) {
  let changed = false
  for (const { org, task, mark } of marks) {
    const key = inboxMarkKey(org, task)
    if (inboxMarks.get(key) !== mark) continue
    if (accepted) inboxMarks.set(key, { ...mark, settled: true })
    else inboxMarks.delete(key)
    changed = true
  }
  if (changed) showInboxMarks()
}

/* Publishes the marks to the Inbox (P.inboxMarks). */
function showInboxMarks() {
  PLANNER.inboxMarks = new Map(inboxMarks)
  emit('inbox')
}

/* The send() handlers that settle `mark` of the item of task `task` in
   organization `org`, with `then`'s, which run after. */
function settlingMark(
  org: string,
  task: string,
  mark: InboxMark,
  then: SendOptions<unknown> = {},
): SendOptions<unknown> {
  let accepted = false
  return {
    onOk: (result) => {
      accepted = true
      then.onOk?.(result)
    },
    onSettled: () => {
      settleInboxMark(org, task, mark, accepted)
      then.onSettled?.()
    },
  }
}

/* Asks for the watched task's history, for a window that shows All. It
   subscribes as the history side query of the live parts beside the
   thread's (subscribeHistory), unless that already runs. A task the server
   does not hold, such as one whose create is on its way, gets an empty
   history, as watchComments gives it an empty thread; its history
   subscribes once its thread does. Answers whether the rows changed. */
function startHistory(): boolean {
  if (!watchedComments) return false
  if (threadWatched) {
    if (historyWatched?.task !== threadWatched.task || historyWatched.org !== threadWatched.org)
      subscribeHistory(threadWatched.task, threadWatched.org)
    return false
  }
  if (historySnap !== null || !watchedCreating()) return false
  historySnap = []
  historyStart = true
  return true
}

/* Subscribes to the history of task `issueUuid` in organization `orgId`,
   replacing any earlier subscription. Its answers come with the transitions
   that bring them (historyNews). */
function subscribeHistory(issueUuid: string, orgId: string) {
  if (!parts) return
  historyWatched = { task: issueUuid, org: orgId }
  parts.watchSide('history', api.snapshot.threadHistory, { org_id: orgId, issue_id: issueUuid })
}

/* Stops the history's side query. */
function stopHistory() {
  parts?.stopSide('history')
  historyWatched = null
}

/* The thread's news in one transition. A failed query keeps the comments
   delivered before it and shows as P.commentsFailure. Convex reruns it when
   the data it read changes, and the next delivery ends the failure.
   not_found (the task is gone or hidden) loads the thread empty instead, so
   it fails closed. forbidden (the sign-in or every seat in this
   organization is gone) is a failure like the rest. The snapshot notice
   says access ended, and the comments on screen stay, like the rest of the
   last snapshot. A task that leaves the snapshot keeps its thread while its
   window shows it from its own read (P.taskDetail), archived or not, and
   the window drops it when it closes. */
function threadNews(news: SideNews) {
  const watched = threadWatched
  if (!watched || watchedComments !== watched.task) return
  const issueUuid = watched.task
  const current = () => threadWatched === watched && watchedComments === issueUuid
  if ('error' in news) {
    const err = news.error
    console.error('[qivo] comments subscription failed:', err)
    const code = errData(err).code
    PLANNER.commentsFailure = code === 'not_found' ? 'none' : 'failed'
    if (code !== 'not_found') {
      // nothing to build from. What is on screen stays, with the failure
      // under it, and comment writes accepted meanwhile stay saved.
      threadCurrent = false
      emit('comments')
      return
    }
    // and the released ids and the comment held apart for an editor go too
    commentsSnap = []
    olderComments = []
    dropCommentsGap()
    pinnedComments.clear()
    apartComments.clear()
    threadStart = true
    threadDelivered(issueUuid)
    return
  }
  PLANNER.commentsFailure = 'none'
  const page = anchor(news.value as FunctionReturnType<typeof api.snapshot.threadComments>)
  const slid = receiveThread(page)
  // past the budget, an arrival lets rows go away from where the windows read
  keepThread('arrival')
  if (slid.length && page.comments[0])
    void checkSlidOut(watched.org, issueUuid, page.comments[0].id, slid, current)
  threadDelivered(issueUuid)
}

/* Records a live good delivery of task `issueUuid`'s thread, whose anchors
   are already in place: it holds every comment write accepted before it,
   so their saved parts go, and the thread paints again (owe). */
function threadDelivered(issueUuid: string) {
  threadDeliveries++
  threadCurrent = true
  layers.dropSaved('thread', issueUuid)
  owe('thread')
}

/* The history's news in one transition, like the thread's (threadNews): a
   failed query keeps the rows delivered before it and shows as
   P.historyFailure until the next delivery, and not_found loads the history
   empty. A delivery is the history's new anchor and paints the thread
   again, but it is no thread delivery (threadDelivered): it holds no
   comment write, so the saved parts of accepted ones stay and paint over
   it until the thread's own delivery holds them. */
function historyNews(news: SideNews) {
  const watched = historyWatched
  if (!watched || watchedComments !== watched.task) return
  if ('error' in news) {
    const err = news.error
    console.error('[qivo] history subscription failed:', err)
    if (errData(err).code !== 'not_found') {
      PLANNER.historyFailure = 'failed'
      emit('comments')
      return
    }
    // the task is gone or hidden: a whole history that holds nothing
    restartHistory({ earlier: false, next: null })
    historySnap = []
  } else {
    receiveHistory(anchor(news.value as FunctionReturnType<typeof api.snapshot.threadHistory>))
    keepThread('arrival')
  }
  PLANNER.historyFailure = 'none'
  owe('thread')
}

/* Which section sides some window wants for the watched task: links and
   attachments while a window shows the sections, and the task side also
   while the workspace does not hold the watched task and its organization
   is known, since the window then shows the task from that answer. */
function sidesWanted(): Record<SectionSide, boolean> {
  const t = watchedComments
  const shown = !!t && sectionOwners.size > 0
  const detail = !!t && !watchedRow() && watchedOrgOf() !== undefined
  return { task: shown || detail, links: shown, attachments: shown }
}

/* Makes the watched thread run while its task may show, after a repaint:
   it subscribes the thread of a task the rows no longer hold, as after a
   re-init of the parts whose first delivery leaves the task out
   (subscribeWaitingThread), and stops the thread and the history of a task
   the workspace does not hold once its answer says it is unavailable, as
   for a deleted task, whose thread the server refuses. The answer goes on,
   so a task that comes back subscribes them again. */
function syncThread() {
  if (!watchedComments) return
  if (!watchedGone()) subscribeWaitingThread()
  else if (threadWatched) {
    stopThread()
    stopHistory()
  }
}

/* Whether the watched task is one the workspace does not hold and its
   answer says is unavailable, as a deleted task, whose thread and history
   the server refuses. No delivery asks for them again until it comes back
   (subscribeWaitingThread, retryComments). */
function watchedGone(): boolean {
  const t = watchedComments
  if (!t || watchedRow()) return false
  if (refusedCreates.has(t)) return true
  const answer = sectionAnswers.issue === t ? sectionAnswers.task : null
  return answer !== null && answer !== CREATING && answer.state === 'unavailable'
}

/* Makes each section side run exactly while it is wanted (sidesWanted), in
   the watched task's organization: a side that starts subscribes afresh
   (watchSection), so the window decides from an answer read after the
   change, and one that runs already goes on, so the Subtasks section and a
   task shown from its answer read one task answer. A side no window wants
   stops and drops its answer, while a re-init of the parts (stopParts)
   keeps the answers until the new subscriptions deliver. A task whose
   create is on its way gets complete, empty lists (CREATING) until a
   delivery holds it or the server took its create (tookCreates), also when
   a window shows its sections again. The person's own new task the
   workspace does not hold shows from its creating answer
   (creatingAnswerOf) until the server took its create, which then stays
   the task side's anchor until the side's first delivery, and a create
   the server refused shows as unavailable, with no side subscribed
   (refusedCreates). It runs
   as the sections build (rebuildSections), after the thread (syncThread),
   so whether the workspace holds the task is the rows' word in the same
   repaint. Answers whether an answer changed. */
function syncSections(): boolean {
  syncThread()
  syncRefRead()
  const t = watchedComments
  const wanted = sidesWanted()
  const org = t && !watchedCreating() && !refusedCreates.has(t) ? watchedOrgOf() : undefined
  const watched = t && org ? { task: t, org } : null
  let changed = false
  for (const side of SECTION_SIDES) {
    const target = wanted[side] ? watched : null
    const now = sectionsWatched[side]
    if (target) {
      if (!parts || (now?.task === target.task && now.org === target.org)) continue
      if (sectionAnswers.issue !== target.task) {
        resetSections(target.task)
        changed = true
      }
      sectionsWatched[side] = target
      if (watchSection(side)) changed = true
      continue
    }
    if (now) {
      parts?.stopSide(side)
      sectionsWatched[side] = null
    }
    if (!wanted[side] && (sectionAnswers[side] !== null || sectionFailure[side] !== 'none')) {
      // nothing holds a write's paint of the task's own answer once it
      // goes, as when the workspace comes to hold the task
      if (side === 'task' && sectionAnswers.issue !== null)
        layers.dropSaved('detail', sectionAnswers.issue)
      sectionAnswers = { ...sectionAnswers, [side]: null }
      sectionFailure[side] = 'none'
      changed = true
    }
  }
  // every answer dropped when the sections hid, so they show again empty
  const unanswered = SECTION_SIDES.every((side) => sectionAnswers[side] === null)
  const creating = t && wanted.task && !watched ? creatingAnswerOf(t) : null
  if (t && creating) {
    // the person's own new task, from what its create sent, with complete,
    // empty lists while a window shows them
    const was = sectionAnswers.issue === t ? sectionAnswers : null
    const links = wanted.links ? (was?.links ?? CREATING) : null
    const attachments = wanted.attachments ? (was?.attachments ?? CREATING) : null
    if (was?.task !== creating || was.links !== links || was.attachments !== attachments) {
      if (!was) resetSections(t)
      // no delivery of the task's own read holds a write on it yet
      if (was?.task !== creating) detailFresh = false
      sectionAnswers = { issue: t, task: creating, links, attachments }
      changed = true
    }
  } else if (t && refusedCreates.has(t) && !watchedRow()) {
    // a create the server refused: the task never existed, and no read
    // asks for it
    const answer = sectionAnswers.issue === t ? sectionAnswers.task : null
    if (answer === null || answer === CREATING || answer.state !== 'unavailable') {
      sectionAnswers = { issue: t, task: { state: 'unavailable' }, links: null, attachments: null }
      changed = true
    }
  } else if (
    t &&
    wanted.links &&
    !watched &&
    (sectionAnswers.issue !== t || unanswered) &&
    watchedCreating()
  ) {
    sectionAnswers = { issue: t, task: CREATING, links: CREATING, attachments: CREATING }
    changed = true
  }
  return changed
}

/* Subscribes section side `side` afresh for the task and organization it
   watches (sectionsWatched), so its answer is never one held from an
   earlier subscription. The reference read of the same task by its uuid
   in the same organization (refRead) holds the one subscription Convex
   keeps for both, so the task side takes it over, and its current answer
   is the task side's first delivery (receiveSection). Answers whether it
   took one. */
function watchSection(side: SectionSide): boolean {
  const watched = sectionsWatched[side]
  if (!parts || !watched) return false
  const { task, org } = watched
  if (side !== 'task') {
    parts.watchSide(side, api.taskWindow[side], { org_id: org, issue_id: task })
    return false
  }
  // a fresh subscription has delivered nothing that holds a write yet
  detailFresh = false
  const news = parts.watchSide(side, api.taskWindow.task, { org_id: org, ref: task })
  if (refRead?.args?.org_id === org && refRead.args.ref === task) refRead.args = null
  if (!news) return false
  receiveSection(side, news)
  return true
}

/* Stops every section side query. */
function stopSections() {
  for (const side of SECTION_SIDES) {
    parts?.stopSide(side)
    sectionsWatched[side] = null
  }
}

/* Drops every section answer and failure, so the sections of task `issue`,
   or of none, load afresh. The caller stops the subscriptions when another
   task opens, and repaints. */
function resetSections(issue: string | null = null) {
  sectionAnswers = { issue, task: null, links: null, attachments: null }
  for (const side of SECTION_SIDES) sectionFailure[side] = 'none'
}

/* Retry for section side `side`, which failed: a fresh subscription of its
   side query, with 'retrying' until the server answers. */
function retrySide(side: SectionSide) {
  if (!sectionsWatched[side] || sectionFailure[side] !== 'failed') return
  sectionFailure[side] = 'retrying'
  repaint({ sections: true })
  if (watchSection(side)) owe('sections')
}

/* The news of section side `side` in one transition, as the history's
   (historyNews): a failed query keeps the answer delivered before it and
   shows as the section's 'failed' state until the next delivery. The
   taskWindow queries answer a task the caller may not list with a state
   (unavailable, archived) rather than an error, so an error is a failure,
   but for the task side's orgQuery refusal of a caller without a seat in
   the organization, or of one whose organization is being deleted
   (seatRefused), which reads as unavailable. That makes a window that
   shows the task from its answer let it go as for a deleted task, with
   the drafts typed for it, and it is no delivery of the task
   (taskDelivered). Every other error, a lost sign-in included, stays a
   failure. A delivery is the section's new anchor. It paints with the
   rest of its transition and, while a painted write waits, when that
   write answers (owe), as the thread's does. */
function sectionNews(side: SectionSide) {
  return (news: SideNews) => {
    if (receiveSection(side, news)) owe('sections')
  }
}

/* Takes section side `side`'s news `news` (sectionNews) without painting
   it, and the task side's also into a reference read that hears it
   (refFromTaskSide). Answers whether it was the watched task's. */
function receiveSection(side: SectionSide, news: SideNews): boolean {
  const watched = sectionsWatched[side]
  if (!watched || watchedComments !== watched.task || sectionAnswers.issue !== watched.task)
    return false
  if ('error' in news && side === 'task' && seatRefused(news.error)) {
    sectionFailure[side] = 'none'
    sectionAnswers = { ...sectionAnswers, task: { state: 'unavailable' } }
    detailFresh = false
  } else if ('error' in news) {
    console.error(`[qivo] ${side} subscription of the task window failed:`, news.error)
    sectionFailure[side] = 'failed'
    // a failure holds no write, and the answer before it stays, a
    // creating answer too: the window goes on showing the person's new
    // task with what they type in it, its saves wait until a read
    // answers (P.refuseStaleEdit) and its controls that read the server
    // go on waiting (TaskDetailVM saving), while the writes sent behind
    // the create go on as sent
    if (side === 'task') detailFresh = false
  } else {
    sectionFailure[side] = 'none'
    sectionAnswers = { ...sectionAnswers, [side]: anchor(news.value) }
    if (side === 'task') taskDelivered(watched.task)
  }
  // the window's own read answered the person's new task: its creating
  // answer is gone, and with it the pending create, which a failed read
  // keeps
  if (side === 'task' && !creatingShown()) {
    const pending = pendingCreates.get(watched.task)
    if (pending?.taken) pendingCreates.delete(watched.task)
  }
  if (side === 'task') refFromTaskSide(watched, news)
  // Move and Archive or delete of a task the workspace holds read its
  // family from this answer until every task is held (P.familyOf), also
  // where its lists show the same as before, as for the person's new task
  if (side === 'task' && rows.issues.has(watched.task) && !tasksAll) familyNews = true
  return true
}

/* Records a live good delivery of task `task`'s own answer, the anchor
   the window shows the task from while the workspace does not hold it. It
   arrived on the newest connection (latestConnection), so it holds every
   write on the task accepted before it, and their saved detail parts go,
   as threadDelivered does for the thread. The sections paint again with
   it (owe). */
function taskDelivered(task: string) {
  detailDeliveries++
  detailFresh = true
  detailConnection = latestConnection
  layers.dropSaved('detail', task)
}

/* The watched task's own answer when it says ok, the anchor its painted
   answer is built from, else null. */
function okAnswer(): TaskOk | null {
  const t = watchedComments
  const answer = t && sectionAnswers.issue === t ? sectionAnswers.task : null
  return answer && answer !== CREATING && answer.state === 'ok' && answer.task.id === t
    ? answer
    : null
}

/* Builds the watched task's painted answer again: a copy of its anchor
   with every live layer's detail part of the task painted over it, in the
   order a repaint applies them (layers.ordered), or the anchor itself,
   which nothing changes, while no live layer paints the task's answer. */
function paintDetail() {
  const from = okAnswer()
  const own = from
    ? layers.ordered().flatMap((layer) => {
        const part = layer.view.detail
        return part && part.task === watchedComments ? [part] : []
      })
    : []
  detailRows = { from, task: from && own.length ? structuredClone(from) : from }
  for (const part of own) guarded(part.paint)
}

/* The watched task's own answer as the window shows it, painted
   (detailRows): built again when its anchor changed since it was painted,
   so it always shows the anchor the sections hold. Null while the task has
   no ok answer. */
function paintedAnswer(): TaskOk | null {
  if (detailRows.from !== okAnswer()) paintDetail()
  return detailRows.task
}

/* ---- A task a window names by a reference (lib/taskReference.ts) ----
   A window over a task the workspace does not hold names it by a
   reference, which it registers (P.watchTaskRef), one at a time, as one
   task is watched. A reference with a uuid and an organization names the
   task already, so the window watches it at once (P.watchComments) and
   reads it through the task side. One that lacks either, as an address
   does, is read here first, through the `reference` side of the live
   parts (taskWindow.task), until an answer names its uuid and
   organization. A number is read only in the organization the reference
   names. A uuid without one is read in the organization the address named
   it under, then in the home organization, then in the login's other
   seats, one at a time, the next only after `unavailable`, so it is
   unavailable only once every seat said so (refSeats). The window watches
   the task by uuid once the read names it, and until its own read
   answers, the reference read's answer serves P.detail (taskDetailNow),
   without going into the section answers, so no write takes it
   (answerTaskOf) and no delivery counts it (taskDelivered). The
   reference read stops once the task side has answered, and a task side
   with the same arguments takes its subscription over
   (liveParts.ts watchSide). A reference read that needs the arguments the
   task side reads with already, as a uuid's walk can reach the seat of
   the task a window shows, starts no watch of its own, which would share
   that one subscription and take it from the task side: it hears the
   task side's news instead (runRefRead, refFromTaskSide). The store moves
   the reference to the task's handle in the repaint in which the workspace
   first holds the task (refMoves, P.watchHandles). */

/** Where the read of a reference stands. `task` is what the reference
    and its answers name of the task, its uuid and organization once known
    and its number, title, project and owner once an answer named them. A
    reference that names its uuid and organization is `resolved` at once,
    and the window's own read says the rest (P.taskDetail). */
export type TaskRefVM = {
  ref: string
  state: 'loading' | 'resolved' | 'unavailable' | 'failed' | 'retrying'
  task: {
    uuid: string
    org: string
    num: number | null
    title: string | null
    project: string | null
    owner: string | null
  } | null
}

/* An archived task's answer. */
type TaskArchived = Extract<TaskAnswer, { state: 'archived' }>

/* The registered reference and its read. `tried` holds the organizations
   a uuid without one answered unavailable in, `args` the arguments of the
   read now (null while none runs, also while the task side reads them for
   it), `answer` its last ok or archived answer, kept through a failure,
   `rechecking` whether a uuid every seat said unavailable for is read in
   the seats again after an access change (syncRefRead), and `moved` the
   handle the reference moved to once the workspace held its task. */
type RefRead = {
  ref: string
  parts: RefParts
  tried: Set<string>
  args: { org_id: string; ref: string } | null
  answer: TaskOk | TaskArchived | null
  state: TaskRefVM['state']
  task: TaskRefVM['task']
  rechecking: boolean
  moved: string | null
}
let refRead: RefRead | null = null
/* The reference side's last news and the arguments it answered, also
   before a window registers the reference, as for the boot's read of its
   address (store/liveParts.ts `address`), which the window then takes
   over. */
let refLast: { args: string; news: SideNews } | null = null
/* Whether a rebuild since the last syncRefRead changed who can open what:
   the projects, the seats' profiles, or a grant to a person or a team. */
let refAccessMoved = false

/* The key a reference read's arguments compare by. */
const refKey = (args: { org_id?: unknown; ref?: unknown }) =>
  JSON.stringify({ org_id: args.org_id, ref: args.ref })

/* The organizations a uuid without one is read in, in order: the one its
   address names it under, the home organization, then the login's other
   seats by id. Only seats the root part lists, which loadMemberships reads
   whole on the server, so the last `unavailable` is every seat's. */
function refSeats(parts: RefParts): string[] {
  const seats = [...myProfiles.keys()].sort()
  const order = [parts.from, HOME_ORG, ...seats]
  return [...new Set(order.filter((org): org is string => !!org && myProfiles.has(org)))]
}

/* The read reference `read` needs next. That is its number in its
   organization, or its uuid in the next seat it was not read in yet when
   it names no organization. Null when it names both its uuid and
   organization, which the window reads itself, or when no seat is left. */
function nextRefArgs(read: RefRead): RefRead['args'] {
  const { parts } = read
  if (parts.uuid && parts.org) return null
  if (parts.num !== undefined)
    return parts.org ? { org_id: parts.org, ref: `${ISSUE_PREFIX}-${parts.num}` } : null
  if (!parts.uuid) return null
  // a uuid found in one organization is read there only
  if (read.task) return { org_id: read.task.org, ref: parts.uuid }
  const seat = refSeats(parts).find((org) => !read.tried.has(org))
  return seat ? { org_id: seat, ref: parts.uuid } : null
}

/* Whether error `e` is orgQuery's refusal of a caller without a seat in
   the organization, or of one whose organization is being deleted
   (convex/lib/functions.ts loadMember), the two exact texts seatGoneText
   matches. A window reads that as unavailable. Every other error, a lost
   sign-in included, is a failure. */
function seatRefused(e: unknown): boolean {
  const d = errData(e)
  return (
    d.code === 'forbidden' && (d.message === 'no profile in this organization' || orgDeleting(d))
  )
}

/* Whether the task side reads with arguments `args`, so a reference read
   with them would share its one Convex subscription (liveParts.ts
   watchSide). */
function taskSideReads(args: { org_id: string; ref: string }): boolean {
  const watched = sectionsWatched.task
  return !!watched && watched.org === args.org_id && watched.task === args.ref
}

/* Makes the reference read run with the arguments `read` needs now, or
   stop when it needs none. A read that runs already with those arguments,
   as the boot's of its address, goes on, and its last answer counts. When
   the task side reads with them, the reference read starts no watch, so
   the task side keeps its subscription: the task side's answer counts,
   and until there is one its next news does (refFromTaskSide). */
function runRefRead(read: RefRead) {
  const args = nextRefArgs(read)
  read.args = args
  const running = parts?.sideArgs('reference')
  if (!args) {
    if (running) parts?.stopSide('reference')
    return
  }
  if (taskSideReads(args)) {
    if (running) parts?.stopSide('reference')
    read.args = null
    const answer = sectionAnswers.issue === args.ref ? sectionAnswers.task : null
    if (answer && answer !== CREATING) takeRefNews(read, { value: answer }, args)
    return
  }
  const key = refKey(args)
  if (running && refKey(running) === key) {
    if (refLast?.args === key) takeRefNews(read, refLast.news, args)
    return
  }
  // a walk that starts over after an access change shows no loading frame
  if (!read.task && read.state !== 'retrying' && !read.rechecking) read.state = 'loading'
  // a fresh subscription has said nothing yet
  refLast = null
  parts?.watchSide('reference', api.taskWindow.task, args)
}

/* Takes the news `news` of the read of `read` with arguments `args` into
   `read`. A failure keeps what the answer before it said. */
function takeRefNews(read: RefRead, news: SideNews, args: { org_id: string; ref: string }) {
  if ('error' in news && !seatRefused(news.error)) {
    console.error('[qivo] the read of a task by its reference failed:', news.error)
    read.state = 'failed'
    read.rechecking = false
    return
  }
  const answer = 'error' in news ? null : (news.value as TaskAnswer)
  if (answer && answer.state !== 'unavailable') {
    read.answer = answer
    read.state = 'resolved'
    read.rechecking = false
    const group = answer.state === 'ok' ? !!answer.task.has_subtasks : answer.task.is_group
    const row = answer.task
    read.task = {
      uuid: row.id,
      org: row.org_id,
      num: row.num,
      title: row.title,
      project: row.project_id,
      owner: taskOwnerId(row, group) ?? null,
    }
    return
  }
  // unavailable, or no seat there: a uuid without an organization is read
  // in the next seat, until none is left, when no read runs (syncRefRead
  // walks on to a seat that joins later, and starts over after an access
  // change). A walk that starts over keeps saying unavailable meanwhile.
  read.answer = null
  read.state = 'unavailable'
  if (!read.task && !read.parts.org) {
    read.tried.add(args.org_id)
    if (!nextRefArgs(read)) read.rechecking = false
    else if (!read.rechecking) read.state = 'loading'
    runRefRead(read)
  }
}

/* Whether `read` is a uuid without an organization that no seat has
   named yet, so it walks the seats (refSeats). */
const refWalks = (read: RefRead) => !read.task && !!read.parts.uuid && !read.parts.org

/* Whether `read` walks the seats (refWalks) and every seat it was read in
   said unavailable for, which no read follows once the walk ends
   (takeRefNews). */
const refWalkEnded = (read: RefRead) => read.state === 'unavailable' && refWalks(read)

/* The reference side's news in one transition. */
function referenceNews(news: SideNews) {
  const args = parts?.sideArgs('reference')
  if (!args) return
  refLast = { args: refKey(args), news }
  const read = refRead
  if (!read?.args || refKey(read.args) !== refLast.args) return
  takeRefNews(read, news, read.args)
  owe('sections')
}

/* Passes the task side's news `news` for the task and organization it
   watches (`watched`) to the registered reference read, when that read
   needs those arguments, runs no read of its own and has no answer yet
   (runRefRead). The task side's delivery repaints the sections. */
function refFromTaskSide(watched: { task: string; org: string }, news: SideNews) {
  const read = refRead
  if (!read || read.args || read.state === 'resolved' || read.state === 'unavailable') return
  const args = nextRefArgs(read)
  if (!args || args.org_id !== watched.org || args.ref !== watched.task) return
  takeRefNews(read, news, args)
}

/* Keeps the reference read in step as the sections build. It runs again
   on a fresh registry (stopParts), a uuid walks on to a seat that joined
   since it said unavailable, and reads every seat it said unavailable in
   again after a rebuild that changed who can open what (refAccessMoved),
   as when a project is shared with one of the seats, since no read
   follows those seats. That holds also while the walk reads a later
   seat, whose read goes on, and the walk comes back to the earlier seats
   before it can end. A read that waits on the task side (runRefRead)
   reads on its own once the task side no longer reads its arguments, as
   when the window lets the task go before the task side answered. The
   read stops once the window's own read of the task has answered. */
function syncRefRead() {
  const read = refRead
  const accessMoved = refAccessMoved
  refAccessMoved = false
  if (!read || !parts) return
  const t = read.task?.uuid
  if (t && watchedComments === t && sectionAnswers.issue === t && sectionAnswers.task !== null) {
    if (read.args && parts.sideArgs('reference')) parts.stopSide('reference')
    read.args = null
    return
  }
  if (accessMoved && refWalks(read) && read.tried.size > 0) {
    // a walk that said unavailable goes on saying so while it reads again
    if (read.state === 'unavailable') read.rechecking = true
    read.tried.clear()
  }
  if (!read.args && !read.task && read.state !== 'resolved' && read.state !== 'unavailable') {
    const next = nextRefArgs(read)
    if (next && !taskSideReads(next)) runRefRead(read)
  }
  if (refWalkEnded(read)) {
    // a seat's read that runs goes on
    if (read.args ? !parts.sideArgs('reference') : nextRefArgs(read)) runRefRead(read)
    return
  }
  if (read.args && !parts.sideArgs('reference')) runRefRead(read)
}

/* The handle of the registered reference's task once the workspace holds
   it in the reference's organization, else undefined, so a reference to
   another organization's task of the same id as a held one never moves
   to the held task's handle (heldHandle). */
function refHandle(read: RefRead): string | undefined {
  const uuid = read.task?.uuid ?? read.parts.uuid
  if (uuid) return heldHandle(uuid, read.task?.org ?? read.parts.org)
  if (read.parts.org && read.parts.num !== undefined)
    return PLANNER.issueRefIn(read.parts.org, `${ISSUE_PREFIX}-${read.parts.num}`) ?? undefined
  return undefined
}

/* `moved`, the handles a rebuild moved, with the registered reference
   moved to its task's handle in the rebuild in which the workspace first
   holds the task, once. */
function refMoves(moved: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const read = refRead
  if (!read || read.moved) return moved
  const handle = refHandle(read)
  if (!handle) return moved
  read.moved = handle
  return new Map(moved).set(read.ref, handle)
}

/* The registered reference's state for the window (P.reference). */
function refStateNow(): TaskRefVM | null {
  const read = refRead
  return read && { ref: read.ref, state: read.state, task: read.task }
}

/* The unread summary's news in one transition, which arrived on socket
   connection `connection`. An answer is the summary as the badge and the
   bulk actions read it (P.inboxSummary), current while it is the running
   registry's latest on the newest connection. A failure drops the answer,
   so the badge shows no number, and Convex runs the query again when data
   it read changes and after a reconnect; opening the Inbox runs it again
   too (P.retryInboxSummary). It emits the Inbox's section when what the
   badge or the bulk actions show changed. */
function summaryNews(news: SideNews, connection: number) {
  const before = summaryView()
  if ('error' in news) {
    console.error('[qivo] unread summary subscription failed:', news.error)
    summaryFresh = false
    PLANNER.inboxSummary = { state: 'failed', answer: null, current: false }
  } else {
    summaryFresh = true
    summaryConnection = connection
    PLANNER.inboxSummary = {
      state: 'ok',
      answer: anchor(news.value as InboxSummaryAnswer),
      current: connection === latestConnection,
    }
  }
  const flags = deriveInboxFlags()
  if (flags || summaryView() !== before) emit('inbox')
}

/* The summary's state, whether it is current, and the count with its
   bounds, which the badge reads, as one string to compare. */
function summaryView(): string {
  const s = PLANNER.inboxSummary
  if (s.state !== 'ok') return s.state
  const a = s.answer
  return `ok:${s.current}:${a.unread_count}:${a.unread_more}:${a.complete}`
}

/** Sets P.canMarkAllRead and P.canRemoveRead from the unread summary
    (P.inboxSummary) and the store's seats. Both are true while the summary
    has no answer, since each action asks the server what it reaches first
    (messages.bulkReach). With an answer, each is true when a seat's flag
    is, flags that count messages about tasks the person can no longer see
    and about archived tasks too, as both actions reach them, or when the
    answer is not complete and leaves out a seat the store holds. A held
    answer that is not current still counts. Answers whether either
    changed. */
function deriveInboxFlags(): boolean {
  const summary = PLANNER.inboxSummary
  let mark = true
  let remove = true
  if (summary.state === 'ok') {
    const lines = summary.answer.seats
    const left =
      !summary.answer.complete &&
      [...myProfiles.keys()].some((org) => !lines.some((line) => line.org_id === org))
    mark = left || lines.some((line) => line.can_mark_all_read)
    remove = left || lines.some((line) => line.can_remove_read)
  }
  const changed = mark !== PLANNER.canMarkAllRead || remove !== PLANNER.canRemoveRead
  PLANNER.canMarkAllRead = mark
  PLANNER.canRemoveRead = remove
  return changed
}

/* The open task's inbox item's news in one transition, which arrived on
   socket connection `connection` (P.inboxItem). `building` says the seat's
   items are not complete yet, an answer's item is null for no item, a task
   the seat is not shown or a check a bound stopped, and an error, such as
   the refusal of a seat that is gone from the task's organization, is
   `failed`. None of those draws a New divider or sends a read, and the
   window's start stays pending through them. The first failure of a visit
   runs the item once more from a fresh subscription, which loads again,
   since Convex runs a failed query again only when data it read changes
   and after a reconnect. A second one stays failed, logged, and leaves the
   task unread, counted by the badge. A seat whose items are building needs
   no rerun, as the answer changes once they are ready. A news of a task
   the store no longer watches is dropped. It emits the task window's
   section. */
function itemNews(news: SideNews, connection: number) {
  const watched = threadWatched
  const held = PLANNER.inboxItem
  if (!watched || held?.task !== watched.task || held.org !== watched.org) return
  itemAnswers++
  const shown = { task: watched.task, org: watched.org }
  if ('error' in news) {
    itemFresh = false
    if (!itemRerun && parts?.rerunSide('item')) {
      itemRerun = true
      console.error('[qivo] inbox item subscription failed, running it once more:', news.error)
      PLANNER.inboxItem = { ...shown, state: 'loading', item: null, current: false }
    } else {
      console.error('[qivo] inbox item subscription failed:', news.error)
      PLANNER.inboxItem = { ...shown, state: 'failed', item: null, current: false }
    }
  } else {
    const answer = news.value as InboxItemAnswer
    itemFresh = true
    itemConnection = connection
    const current = connection === latestConnection
    PLANNER.inboxItem =
      answer.state === 'building'
        ? { ...shown, state: 'building', item: null, current }
        : { ...shown, state: 'ok', item: answer.item && anchor(answer.item), current }
  }
  emit('comments')
}

/* Marks the held summary and item answers not current once the socket's
   newest connection passed the one they arrived on, or the registry that
   brought them stopped (stopParts), and emits each section whose answer
   changed: after a reconnect every result arrives again, and the badge
   shows the held count as refreshing until it does. The registry learns
   of a new connection only with the new socket's first transition, so
   during an outage the held count passes as current until then. */
function staleInboxReads() {
  const summary = PLANNER.inboxSummary
  const summaryNow = summaryFresh && summaryConnection === latestConnection
  if (summary.state === 'ok' && summary.current !== summaryNow) {
    PLANNER.inboxSummary = { ...summary, current: summaryNow }
    emit('inbox')
  }
  const item = PLANNER.inboxItem
  const itemNow = itemFresh && itemConnection === latestConnection
  if (item && item.state !== 'loading' && item.state !== 'failed' && item.current !== itemNow) {
    PLANNER.inboxItem = { ...item, current: itemNow }
    emit('comments')
  }
}

/* What each side query's news goes to, with the socket connection the
   transition that brought it arrived on. */
const SIDE_NEWS: Record<SideName, (news: SideNews, connection: number) => void> = {
  thread: threadNews,
  history: historyNews,
  task: sectionNews('task'),
  links: sectionNews('links'),
  attachments: sectionNews('attachments'),
  reference: referenceNews,
  summary: summaryNews,
  item: itemNews,
}

/* The state of section side `side`, whose answer is `answer`. */
function sectionState(
  side: SectionSide,
  answer: { state: string } | typeof CREATING | null,
): SectionState {
  const failure = sectionFailure[side]
  if (failure !== 'none') return failure
  if (answer === null) return 'loading'
  return answer === CREATING || answer.state === 'ok' ? 'ready' : 'unavailable'
}

/* Task `uuid` as a row of a section, from the workspace's view of it when
   the workspace holds it, else from `short`, the answer's row, or null
   with neither. During a held transition a held task's row can be older
   than its short row in a fresh answer, but so is every view of it, the
   Board and the Roadmap included, until the waiting write answers, so the
   window agrees with the rest of the screen, and that moment ends with the
   answer. */
function relatedTask(uuid: string, short: ShortRow | undefined): RelatedTaskVM | null {
  const handle = uuidToKey.get(uuid)
  const it = handle === undefined ? undefined : PLANNER.issueById[handle]
  if (it)
    return {
      uuid,
      handle: it.id,
      org: it.org,
      num: rows.issues.get(uuid)?.num ?? short?.num ?? 0,
      title: it.title,
      project: it.project,
      status: it.status,
      owner: it.owner,
      isGroup: PLANNER.isGroup(it),
      done: PLANNER.isDone(it),
      held: true,
      level: levelOf(PLANNER.levelOn(it.project)),
      remaining: it.remaining,
    }
  if (!short) return null
  return {
    uuid,
    // the handle it gets once the workspace holds it (taskIndex.ts setHandle)
    handle: short.org_id === HOME_ORG ? `${ISSUE_PREFIX}-${short.num}` : uuid,
    org: short.org_id,
    num: short.num,
    title: short.title,
    project: short.project_id,
    status: short.status,
    owner: taskOwnerId(short, short.has_subtasks),
    isGroup: short.has_subtasks,
    // a short group's leaves are not in the answer
    done: !short.has_subtasks && short.status === 'done',
    held: false,
    level: short.level,
    remaining: short.remaining_hours != null ? Number(short.remaining_hours) : undefined,
  }
}

/** Level `level` as a short row names it (convex/lib/taskWindow.ts
    ShortRow), or null for none or any other text. */
function levelOf(level: string | null | undefined): ShortRow['level'] | null {
  return level === 'lead' || level === 'user' || level === 'viewer' || level === 'admin'
    ? level
    : null
}

/* Whether two rows hold the same fields, as a paint's copy of an untouched
   row does, whose objects and lists are copies (rowMap.ts copyRow). */
const sameRow = (a: object, b: object) => {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const key of keys) {
    const [p, q] = [x[key], y[key]]
    if (Object.is(p, q)) continue
    if (!p || !q || typeof p !== 'object' || JSON.stringify(p) !== JSON.stringify(q)) return false
  }
  return true
}

/* The uuids of the tasks a live layer changed from the applied rows
   (P.ownPaintedTasks). A paint's overlay also holds copies of rows it only
   read, which match their applied row and are left out. A task a layer
   created, removed or moved to another parent also names its old and new
   parent, whose own rows stay as they were but which may become a group or
   stop being one. */
function paintedTaskIds(): Set<string> {
  const out = new Set<string>()
  const applied = base.map('issues')
  for (const [uuid, own] of rows.issues.overlay) {
    const was = applied.get(uuid)
    const now = typeof own === 'symbol' ? undefined : own
    if (now ? was && sameRow(now, was) : was === undefined) continue
    out.add(uuid)
    if (was?.parent_id === now?.parent_id) continue
    if (was?.parent_id) out.add(was.parent_id)
    if (now?.parent_id) out.add(now.parent_id)
  }
  const labels = workspaceRows.peekList('issueLabels')
  const appliedLabels = base.list('issueLabels')
  if (labels !== appliedLabels) {
    const key = (row: { issue_id: string; label_id: string }) => `${row.issue_id}:${row.label_id}`
    const shown = new Set(labels.map(key))
    const server = new Set(appliedLabels.map(key))
    for (const row of labels) if (!server.has(key(row))) out.add(row.issue_id)
    for (const row of appliedLabels) if (!shown.has(key(row))) out.add(row.issue_id)
  }
  return out
}

/* The watched task `t`'s Subtasks from the task answer and, where they
   differ from the applied rows, the painted ones (lib/taskSections.ts
   shows): the answer's subtasks and the painted subtasks of `t` are the
   candidates, each asked whether its applied and its painted row name `t`
   as parent. */
function subtaskSection(t: string, answer: SectionAnswers['task']) {
  const state = sectionState('task', answer)
  const list: { rows: readonly ShortRow[]; complete: boolean; hidden: boolean } | null =
    answer === CREATING
      ? { rows: [], complete: true, hidden: false }
      : answer?.state === 'ok'
        ? {
            rows: answer.subtasks.rows,
            complete: answer.subtasks.complete,
            hidden: answer.task.has_hidden_subtasks,
          }
        : null
  if (!list)
    return {
      state,
      rows: [],
      complete: false,
      delivered: answer !== null,
      source: 'answer' as const,
      hidden: false,
    }
  const fromAnswer = new Map(list.rows.map((row) => [row.id, row]))
  const applied = base.map('issues')
  const ids = shownIds([...fromAnswer.keys(), ...(tasks.relationsOf(t).children ?? [])], (x) => ({
    base: applied.get(x)?.parent_id === t,
    painted: rows.issues.get(x)?.parent_id === t,
    answer: fromAnswer.has(x),
  }))
  const shown = ids
    .map((x) => ({
      id: x,
      num: rows.issues.get(x)?.num ?? fromAnswer.get(x)?.num ?? 0,
      row: relatedTask(x, fromAnswer.get(x)),
    }))
    .sort(byNumber)
    .flatMap(({ row }) => (row ? [row] : []))
  return {
    state,
    rows: shown,
    complete: list.complete,
    delivered: true,
    source: 'answer' as const,
    hidden: list.hidden,
  }
}

/* The watched task `t`'s Linked tasks from the links answer and, where
   they differ from the applied rows, the painted ones, link by link as
   subtaskSection does, then one row for each other task by the
   workspace's rule (lib/taskSections.ts linkViews). A link a write adds
   joins two tasks the workspace holds (P.addLink), so every painted link
   has a row for its other task. */
function linkSection(t: string, answer: SectionAnswers['links']) {
  const state = sectionState('links', answer)
  const list: Pick<LinksOk, 'links' | 'tasks' | 'complete'> | null =
    answer === CREATING
      ? { links: [], tasks: [], complete: true }
      : answer?.state === 'ok'
        ? answer
        : null
  if (!list)
    return {
      state,
      rows: [],
      complete: false,
      delivered: answer !== null,
      source: 'answer' as const,
    }
  const fromAnswer = new Map(list.links.map((link) => [link.id, link]))
  const ends = new Map(list.tasks.map((row) => [row.id, row]))
  const applied = base.map('links')
  const touches = (link: { source_id: string; target_id: string } | undefined) =>
    !!link && (link.source_id === t || link.target_id === t)
  const ids = shownIds([...fromAnswer.keys(), ...(tasks.relationsOf(t).links ?? [])], (id) => ({
    base: touches(applied.get(id)),
    painted: touches(rows.links.get(id)),
    answer: fromAnswer.has(id),
  }))
  const links = ids.flatMap((id) => {
    const painted = rows.links.get(id)
    const link = touches(painted) ? painted : fromAnswer.get(id)
    return link ? [link] : []
  })
  const shown = linkViews(t, links, (other) => uuidToKey.has(other) || ends.has(other)).flatMap(
    (view) => {
      const row = relatedTask(view.other, ends.get(view.other))
      return row ? [{ ...row, type: view.type, linkHeld: touches(rows.links.get(view.link)) }] : []
    },
  )
  return { state, rows: shown, complete: list.complete, delivered: true, source: 'answer' as const }
}

/* The watched task `t`'s Attachments from the attachments answer and,
   where they differ from the applied rows, the painted ones, row by row as
   subtaskSection does, oldest first. */
function attachmentSection(t: string, answer: SectionAnswers['attachments']) {
  const state = sectionState('attachments', answer)
  const list: Pick<AttachmentsOk, 'rows' | 'complete'> | null =
    answer === CREATING ? { rows: [], complete: true } : answer?.state === 'ok' ? answer : null
  if (!list)
    return {
      state,
      rows: [],
      complete: false,
      delivered: answer !== null,
      source: 'answer' as const,
      count: 0,
    }
  const fromAnswer = new Map(list.rows.map((row) => [row.id, row]))
  const applied = base.map('attachments')
  const ids = shownIds(
    [...fromAnswer.keys(), ...(tasks.relationsOf(t).attachments ?? [])],
    (id) => ({
      base: applied.get(id)?.issue_id === t,
      painted: rows.attachments.get(id)?.issue_id === t,
      answer: fromAnswer.has(id),
    }),
  )
  const all = ids
    .flatMap((id) => {
      const painted = rows.attachments.get(id)
      const row = painted?.issue_id === t ? painted : fromAnswer.get(id)
      return row ? [row] : []
    })
    .sort(byCreation)
  return {
    state,
    rows: all
      .filter((row) => !row.inline)
      .map((row) => ({ ...shapeAttachment(row), held: rows.attachments.has(row.id) })),
    complete: list.complete,
    delivered: true,
    source: 'answer' as const,
    count: all.filter((row) => row.dropped_at === undefined).length,
  }
}

/* Task `it`'s sections as the workspace holds them, for a workspace that
   holds every task (P.tasksHeld()) before their answers arrive: its
   painted subtasks, links and files, as whole lists, with the states
   `states` gives each (a failed read stays failed beside the rows). An
   answer that agrees shows the same rows, so it takes over unseen. */
function workspaceSections(
  it: IssueVM,
  states: Record<SectionSide, SectionState> = {
    task: 'ready',
    links: 'ready',
    attachments: 'ready',
  },
): TaskSectionsVM {
  const whole = { complete: true, delivered: false, source: 'workspace' as const }
  const related = (handle: string) => {
    const uuid = PLANNER.issueById[handle]?.uuid
    return uuid ? relatedTask(uuid, undefined) : null
  }
  return {
    task: it.uuid,
    subtasks: {
      ...whole,
      state: states.task,
      rows: it.children.flatMap((handle) => related(handle) ?? []),
      hidden: it.hasHiddenSubtasks,
    },
    links: {
      ...whole,
      state: states.links,
      rows: it.links.flatMap((view) => {
        const row = related(view.id)
        return row ? [{ ...row, type: view.type, linkHeld: true }] : []
      }),
    },
    attachments: {
      ...whole,
      state: states.attachments,
      rows: it.attachments.map((att) => ({ ...att, held: true })),
      count: it.attachmentCount,
    },
  }
}

/* The watched task's sections now, or null while no window shows them.
   A section without an answer yet lists what a workspace that holds every
   task holds (workspaceSections), and says it loads otherwise, since a
   task the workspace holds before it holds every task, the person's new
   task in a store that asked, has lists that only its answers bring. A
   held task of another organization with the watched task's id is another
   task, so its lists never stand in (watchedRow). */
function sectionsNow(): TaskSectionsVM | null {
  const t = watchedComments
  if (!t || sectionOwners.size === 0) return null
  const answers =
    sectionAnswers.issue === t
      ? sectionAnswers
      : { issue: t, task: null, links: null, attachments: null }
  // the workspace's lists, built only while one section has no answer and
  // the workspace holds the watched task in its own organization
  const waits = answers.task === null || answers.links === null || answers.attachments === null
  const handle = waits && tasksAll && watchedRow() ? uuidToKey.get(t) : undefined
  const held = handle === undefined ? undefined : PLANNER.issueById[handle]
  const fallback =
    held &&
    workspaceSections(held, {
      task: sectionFailure.task === 'none' ? 'ready' : sectionFailure.task,
      links: sectionFailure.links === 'none' ? 'ready' : sectionFailure.links,
      attachments: sectionFailure.attachments === 'none' ? 'ready' : sectionFailure.attachments,
    })
  return {
    task: t,
    // the Subtasks of the answer the window shows, painted (paintedAnswer)
    subtasks:
      fallback && answers.task === null
        ? fallback.subtasks
        : subtaskSection(t, shownAnswer(answers.task)),
    links: fallback && answers.links === null ? fallback.links : linkSection(t, answers.links),
    attachments:
      fallback && answers.attachments === null
        ? fallback.attachments
        : attachmentSection(t, answers.attachments),
  }
}

/* The watched task's answer `answer` as the window shows it: for an ok
   answer the painted one (paintedAnswer), with the person's own writes on
   their way, else the answer itself. */
function shownAnswer(answer: SectionAnswers['task']): SectionAnswers['task'] {
  return answer && answer !== CREATING && answer.state === 'ok'
    ? (paintedAnswer() ?? answer)
    : answer
}

/* The watched task as the window shows it from its own read
   (store/taskDetail.ts), with the person's own writes on it painted
   (paintedAnswer), or null unless the workspace does not hold it and its
   organization is known. Until the task side's first answer, the
   reference read's answer of the same task serves it (refRead), with that
   read's state, and stays out of the section answers, so no write takes
   it (answerTaskOf). */
function taskDetailNow(): TaskDetailVM | null {
  const t = watchedComments
  const org = watchedOrgOf()
  if (!t || !org || watchedRow()) return null
  const answers = sectionAnswers.issue === t ? sectionAnswers : null
  const answer = answers ? shownAnswer(answers.task) : undefined
  const links = answers?.links
  const files = answers?.attachments
  const byRef =
    !answer && refRead?.answer?.task.id === t && refRead.answer.task.org_id === org ? refRead : null
  // the task side's failure, else the reference read's, while it serves
  const refFailure = byRef?.state === 'failed' || byRef?.state === 'retrying' ? byRef.state : 'none'
  const sideFailure = answers ? sectionFailure.task : 'none'
  return shapeTaskDetail({
    task: t,
    org,
    answer: byRef ? byRef.answer : answer === CREATING ? null : (answer ?? null),
    saving: !byRef && creatingShown(),
    failure: byRef && sideFailure === 'none' ? refFailure : sideFailure,
    links: links && links !== CREATING && links.state === 'ok' ? links : null,
    attachments: files && files !== CREATING && files.state === 'ok' ? files : null,
    handleNow: PLANNER.handleNow,
    labelName: (id) => rows.labels.get(id)?.name,
    related: (row) => relatedTask(row.id, row),
  })
}

/* The task detail of each creating answer that no window watched yet
   (creatingDetailOf), by that answer. */
const creatingDetails = new WeakMap<TaskOk, TaskDetailVM>()

/** The person's own new task `uuid` as a window shows it before it watches
    the task (P.taskDetail), from its creating answer (creatingAnswerOf)
    shaped as taskDetailNow shapes it once watched, saving, and the same
    object while that answer holds. The window's first render comes before
    its effect watches the task (P.watchComments), so it shows the task
    rather than a loading line. Null for a task that is no create of the person's
    own on its way, or that the server refused. */
function creatingDetailOf(uuid: string): TaskDetailVM | null {
  if (refusedCreates.has(uuid)) return null
  const answer = creatingAnswerOf(uuid)
  if (!answer) return null
  let detail = creatingDetails.get(answer)
  if (!detail) {
    detail = shapeTaskDetail({
      task: uuid,
      org: answer.task.org_id,
      answer,
      saving: true,
      failure: 'none',
      links: null,
      attachments: null,
      handleNow: PLANNER.handleNow,
      labelName: (id) => rows.labels.get(id)?.name,
      related: (row) => relatedTask(row.id, row),
    })
    creatingDetails.set(answer, detail)
  }
  return detail
}

/* Builds P.sections and P.detail again from the section answers and the
   rows on screen, keeping each old object while it holds the same data,
   after making the section sides run as the windows want them
   (syncSections). Answers whether either changed. */
function rebuildSections(): boolean {
  const t = watchedComments
  const row = watchedRow()
  const handle = t ? uuidToKey.get(t) : undefined
  const it = handle === undefined ? undefined : PLANNER.issueById[handle]
  if (t && row && it)
    watchedHeld = { uuid: t, org: it.org, num: row.num, title: it.title, project: it.project }
  syncSections()
  const before = PLANNER.sections
  const detailBefore = PLANNER.detail
  const refBefore = PLANNER.reference
  PLANNER.sections = keep(before, sectionsNow())
  PLANNER.detail = keep(detailBefore, taskDetailNow())
  PLANNER.reference = keep(refBefore, refStateNow())
  drawnAnswer = PLANNER.detail ? paintedAnswer() : null
  syncWindowLoad()
  return (
    PLANNER.sections !== before ||
    PLANNER.detail !== detailBefore ||
    PLANNER.reference !== refBefore
  )
}

/* Task `it`'s subtasks, links and attachment count as the cap checks
   before a write count them (lib/relationCandidates.ts subtaskBlock,
   lib/taskCaps.ts linkBlock and attachmentBlock): the workspace's, or the
   task's complete section lists while a window shows them and they hold
   more. So a workspace that holds only part of a list, as during a staged
   load, disables more and never allows more. The server checks again. */
function capInputs(it: IssueVM) {
  const sections = PLANNER.sections?.task === it.uuid ? PLANNER.sections : null
  const whole = <R>(section: SectionVM<R> | undefined) => (section?.complete ? section.rows : [])
  const children = whole(sections?.subtasks).map((row) => row.handle)
  const links = whole(sections?.links)
  const attachments = sections?.attachments.complete ? sections.attachments.count : 0
  return {
    children: children.length > it.children.length ? children : it.children,
    links: links.length > it.links.length ? links : it.links,
    attachments: Math.max(attachments, it.attachmentCount),
  }
}

/* The attachment row `attId` that only the watched task's attachments
   answer holds, with the organization the sections watch, for minting a
   file the workspace does not hold (P.attachmentUrl, primeMint), or null.
   The lookup ends with the answers, when the sections stop or another task
   opens. */
function sectionAttachment(attId: string): { row: Row<'issue_attachments'>; org: string } | null {
  const answer = sectionAnswers.attachments
  const watched = sectionsWatched.attachments
  if (!watched || sectionAnswers.issue !== watched.task || answer === null) return null
  if (answer === CREATING || answer.state !== 'ok') return null
  const row = answer.rows.find((r) => r.id === attId)
  return row ? { row, org: watched.org } : null
}

/* The organization through which to mint attachment `attId` that the
   description of the task the window shows from its answer names
   (P.taskDetail, convex/lib/imageRefs.ts imageRefs), as on a phone's
   Activity tab, where no attachments answer runs, and for an archived
   task, whose attachments answer is unavailable, or null. files.mintUrls
   mints only a file of a task in that organization whose project the
   person can see, the gateway checks the same again, so the text can name
   no file the person could not open anyway. The lookup ends with the
   detail. Its mints go through the mint queue, and the description's
   images load through the inline image loader (attachmentLease). */
function detailAttachment(attId: string): { org: string } | null {
  const detail = PLANNER.detail
  const text = detail?.view?.description
  return text && imageRefs(text).has(attId.toLowerCase()) && detail ? { org: detail.org } : null
}

/* Desktop notifications (0074): fired once per inbox row id. An id set, not
   a timestamp watermark — created_at is the writer TRANSACTION's start (0109
   tried clock_timestamp() and 0111 put it back, because a comment's message
   has to share its comment's instant), so a slow write can commit a message
   stamped before an already-announced quick one, and a watermark would
   silently swallow it. Empty until the FIRST snapshot lands — sign-in must
   show the unread badge, not replay every stored message as an OS
   notification. noteDelivery() calls this once per delivery, so the
   null-prime runs on the first one. */
let announcedMessages: Map<string, string | undefined> | null = null // id → woke_at announced
// the server time of the previous snapshot; older messages on a task that
// newly enters the working set are history, not news
let lastDeliveryAt: string | null = null
/* A restore reintroduces the task's historical inbox rows. The server marks
   an archived task's messages read in the background, so they usually come
   back read, but a restore that beats that step brings them back unread.
   Either way, keep them from looking like new arrivals when the next
   snapshot admits the restored task (and any ancestors restored with it).
   Each restore maps to whether the server accepted it (unarchiveIssue).
   Before every task is held, a task only shows that it came back when it
   brings a message, and one with no message for the restorer never does,
   so a restore also ends with the delivery that holds it, whether or not
   its task's messages came. Convex hands that delivery to the listeners
   before the write resolves, so a restore accepted after such a delivery
   ends at once, and one accepted before any ends with the next one the
   store takes (tookInbox). A restore left waiting would swallow the
   task's next real notification. */
const pendingRestores = new Map<string, boolean>()
/* The live deliveries the store took the Inbox from: every complete one
   and, while every task loads, every partial one, which holds every part
   but the tasks (tookInbox). */
let inboxDeliveries = 0
/* Whether the newest workspace report was such a delivery, as
   snapshotCurrent is for a complete one. */
let inboxCurrent = false

/** Counts a live delivery the store took the Inbox from, after its arrival
    bookkeeping (noteDelivery), and ends each restore the server accepted
    before it, which it holds. */
function tookInbox() {
  inboxDeliveries++
  inboxCurrent = true
  for (const [id, accepted] of pendingRestores) if (accepted) pendingRestores.delete(id)
}
/* Draft-only uploads a discarded draft let go of while edits were paused
   (removeAttachment's deferWhilePaused), with the task each belongs to
   and, for a task the workspace does not hold, its organization. The
   pause would refuse their delete, so it waits for the snapshot to
   recover (reapPausedUploads). A reload forgets them, and a later
   description save drops them a day after their upload, as it does a
   closed tab's leftovers (convex/model/descriptionImages.ts). */
const reapAfterPause = new Map<string, { task: string; org?: string }>()

/* Deletes the uploads reapAfterPause holds once edits resume, except one a
   description took meanwhile, which the server's description saves settle
   from then on. An upload of a task the workspace does not hold goes while
   the window's own answer shows that task, unless its saved text names
   it, and once the window shows another task or none, in the organization
   kept with it, since only this session's draft ever held it and that
   draft let go of it. While the window shows the task from an answer that
   is not current, it stays for the server to drop. */
function reapPausedUploads() {
  // one pause can end while the other still holds
  if (snapshotTrouble || savePause()) return
  const ids = [...reapAfterPause]
  reapAfterPause.clear()
  for (const [id, { task, org }] of ids) {
    const rec = rows.attachments.get(id)
    if (!rec) {
      if (rows.issues.has(task)) continue
      if (task !== watchedComments) {
        if (org) void PLANNER.removeAttachment(id, { task, org })
        continue
      }
      const shown = paintedAnswer()
      if (shown && !String(shown.task.description ?? '').includes(id))
        void PLANNER.removeAttachment(id, { task, org })
      continue
    }
    const issue = rows.issues.get(rec.issue_id)
    if (!issue || (typeof issue.description === 'string' && issue.description.includes(id)))
      continue
    void PLANNER.removeAttachment(id)
  }
}

function issueSubtree(rootId: string): Set<string> {
  const subtree = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const issue of rows.issues.peekValues()) {
      if (issue.parent_id && subtree.has(issue.parent_id) && !subtree.has(issue.id)) {
        subtree.add(issue.id)
        grew = true
      }
    }
  }
  return subtree
}

/* Takes the tasks in `subtree` and every row hung on them off the rows. It
   walks whole sections without copying them (store/rowMap.ts keysWhere,
   keepList), so a pending archive or delete copies no row. */
function purgeIssueRows(subtree: Set<string>) {
  for (const id of rows.attachments.keysWhere((a) => subtree.has(a.issue_id))) {
    rows.attachments.delete(id)
    minted.delete(`att:${id}`)
    inlineImages.drop(id)
  }
  for (const id of rows.links.keysWhere(
    (link) => subtree.has(link.source_id) || subtree.has(link.target_id),
  ))
    rows.links.delete(id)
  workspaceRows.keepList('issueLabels', (label) => !subtree.has(label.issue_id))
  workspaceRows.keepList('issueSubs', (subscription) => !subtree.has(subscription.issue_id))
  for (const id of rows.messages.keysWhere((message) => subtree.has(message.issue_id)))
    rows.messages.delete(id)
  subtree.forEach((id) => {
    rows.issues.delete(id)
  })
}

/* The paint of an accepted archive of task `rootId` of organization `org`
   at `at`. With `keepSubtasks` the server detached every active direct
   child first (it keeps its own subtasks) and archived the task alone, so
   only the task leaves the board; otherwise the whole visible subtree goes
   with it. It skips while the workspace does not hold the task in that
   organization (holdsIn). */
function archivePaint(rootId: string, keepSubtasks: boolean, at: string, org: string): Paint {
  return () => {
    if (!holdsIn(rootId, org)) return
    if (!keepSubtasks) {
      purgeIssueRows(issueSubtree(rootId))
      return
    }
    // the detach fires the touch server-side, as a delete's does
    for (const issue of rows.issues.where((i) => i.parent_id === rootId)) {
      issue.parent_id = undefined
      issue.updated_at = at
    }
    purgeIssueRows(new Set([rootId]))
  }
}

/* The paint of an accepted project delete. The server hides the project and
   its sub-projects in one transaction and moves their tasks to Deleted
   items in steps, so the next delivery already lacks all of them. */
function dropProjectRows(id: string) {
  const row = rows.projects.get(id)
  if (!row) return
  const ids =
    row.type === 'meta' ? [id, ...rows.projects.keysWhere((x) => x.parent_id === id)] : [id]
  for (const key of rows.issues.keysWhere((i) => ids.includes(i.project_id)))
    rows.issues.delete(key)
  for (const key of rows.links.keysWhere(
    (l) => !rows.issues.has(l.source_id) || !rows.issues.has(l.target_id),
  ))
    rows.links.delete(key)
  workspaceRows.keepList('issueLabels', (il) => rows.issues.has(il.issue_id))
  workspaceRows.keepList('issueSubs', (s) => rows.issues.has(s.issue_id))
  workspaceRows.keepList('access', (a) => !ids.includes(a.project_id))
  workspaceRows.keepList('teamAccess', (a) => !ids.includes(a.project_id))
  ids.forEach((pid) => {
    rows.projects.delete(pid)
  })
}

/* The paint of a task delete in organization `org` at `at`: the tasks in
   `deleted` leave, and their subtasks outside it become top-level tasks, as
   the server detaches them. A held task of another organization with an
   id in `deleted` is another task, which stays with its subtasks
   (heldElsewhere). */
function dropDeletedTasks(deleted: ReadonlySet<string>, at: string, org: string) {
  const gone = new Set([...deleted].filter((uuid) => !heldElsewhere(uuid, org)))
  // the SET NULL cascade fires the touch server-side — mirror both
  for (const r of rows.issues.where(
    (i) => !!i.parent_id && gone.has(i.parent_id) && !gone.has(i.id),
  )) {
    r.parent_id = undefined
    r.updated_at = at
  }
  // the rows, and everything hung on them: links, labels, attachments and
  // inbox messages. Their load leaves with the rows. The task's window releases the watched thread
  // once the task leaves the rows (IssueDetail).
  purgeIssueRows(gone)
}

/* What a click on a desktop notification runs: App's own way into the inbox,
   so the click asks before it closes a window with unsent text, as the Inbox
   button does, and the address follows only once the move goes ahead. A
   refused click adds no history entry. Null while no App is mounted. */
let inboxOpener: (() => void) | null = null

/** Sets what a click on a desktop notification runs (App's openInbox), or
    null to drop it. */
function setInboxOpener(open: (() => void) | null) {
  inboxOpener = open
}

/* Raises a desktop notification for each message of delivery `snap` that is
   new since the last one, and for each item back from a snooze. It reads
   the delivery, not the painted rows, so the person's own pending changes,
   such as a snooze the server then refuses, never raise one. */
function announceNewMessages(snap: Snapshot) {
  if (announcedMessages === null) {
    announcedMessages = new Map(snap.messages.map((m) => [m.id, m.woke_at]))
    return
  }
  const fresh: Row<'messages'>[] = []
  // a snooze that ended since the last delivery: the server stamps every
  // row of the item with one woke_at, so the item announces once, not per row
  const returned = new Map<string, Row<'messages'>>()
  const profiles = new Map(snap.profiles.map((profile) => [profile.id, profile]))
  snap.messages.forEach((m) => {
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
  // a click on the notification opens the inbox (setInboxOpener)
  const openInbox = () => inboxOpener?.()
  const titleOf = (m: Row<'messages'>) => {
    // this delivery's row, which base.stage just kept
    const iss = base.stagedTask(m.issue_id)
    return (iss ? iss.title : m.issue_title) || m.issue_title
  }
  fresh
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .forEach((m) => {
      const actor = m.actor_id && profiles.get(m.actor_id)
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

/* "My view" (deviation #49) is a SCOPE, not a project row: the same three
   views over the projects this login reaches, narrowed to the tasks owned by
   me (the assignee, or the reviewer while the task waits In Review; #314),
   on ANY seat I hold (0081), not just the home profile. It rides in the
   app's `scope` state as this sentinel, routes as <view>/mine and switches
   views like any project scope. It names no project, so it has no lead, no
   settings page, no archive and nowhere to create, which is what
   `P.isWideScope` asks; `P.project('mine')` stays undefined, and every
   consumer goes through `P.scopeInfo`. It is the only such sentinel: the
   views have no scope over all projects, which the All projects directory
   (components/ProjectDirectory.tsx) and main Search serve instead. */
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
// kept by the task index (store/taskIndex.ts), a task at a time
const keyToUuid = tasks.keyToUuid // handle -> issue uuid
const uuidToKey = tasks.uuidToKey // uuid -> handle
const uuidToDisplayKey = tasks.uuidToDisplayKey // uuid -> "QN-482" (what's rendered)
// org id -> ("QN-482" -> uuid): resolves an org-prefixed URL exactly (0081)
const keyByOrg = tasks.keyByOrg
/* The handle of task `uuid` of organization `orgId`, display key `key`,
   while `home` is the home organization. */
const handleUnder = (home: string, uuid: string, orgId: string, key: string) =>
  orgId && orgId === home ? key : uuid
const handleFor = (uuid: string, orgId: string, key: string) =>
  handleUnder(HOME_ORG, uuid, orgId, key)
/* The handle of task `uuid` while the workspace holds it in organization
   `org`, by the task index's own maps, or with no organization named, by
   its id alone, else undefined. Two organizations can hold one task id,
   and the workspace holds one task by an id, so the handle of another
   organization's task of the same id never stands for this one. */
function heldHandle(uuid: string, org: string | null | undefined): string | undefined {
  const handle = uuidToKey.get(uuid)
  if (handle === undefined || !org) return handle
  const key = uuidToDisplayKey.get(uuid)
  return key !== undefined && keyByOrg.get(org)?.get(key) === uuid ? handle : undefined
}

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

/* The periods, in days, the read message retention setting offers (0110).
   A profile is inserted without a retention, so the optimistic row predicts
   the server's DEFAULT_MESSAGE_RETENTION_DAYS, as it does for plannable
   hours. */
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

/* Sends messages.readItem for the item `target` names (P.readItem), with a
   read mark on its Inbox row (setInboxMark), and runs `confirmed` once the
   server accepted it and its paint settled, so `confirmed` may send
   another write. Answers false when the pause refuses it, with no mark. */
function sendItemRead(
  target: { org: string; task: string; through: number; latestAt: string },
  quiet: boolean,
  confirmed?: () => void,
): boolean {
  if (refusePausedWrite(api.messages.readItem, quiet)) return false
  const at = new Date().toISOString()
  const latest = Date.parse(target.latestAt)
  const ids: string[] = []
  for (const row of rows.messages.peekValues())
    if (
      row.issue_id === target.task &&
      row.org_id === target.org &&
      !row.read_at &&
      row.snoozed_until === undefined &&
      Date.parse(row.created_at) <= latest
    )
      ids.push(row.id)
  let accepted = false
  const mark = setInboxMark(target.org, target.task, { through: target.through, read: true })
  void send(
    api.messages.readItem,
    { org_id: target.org, issue_id: target.task, through: target.through },
    ids.length ? { workspace: () => markLoadedMessagesRead(ids, at, true) } : 'none',
    {
      // the read that opening a task sends is not a change the person made
      about: { background: quiet },
      ...settlingMark(target.org, target.task, mark, {
        onOk: () => {
          accepted = true
        },
        onSettled: () => {
          if (accepted) confirmed?.()
        },
      }),
    },
  )
  return true
}

/* Mirror the server prune after a read. A task retains its newest message
   plus any unread arrivals that were not part of this action. Skips rows
   that are gone or already read, so it can paint again, and with
   `skipSnoozed` the snoozed rows a bulk action leaves alone. */
function markLoadedMessagesRead(ids: string[], at: string, skipSnoozed = false) {
  const hit = ids.filter((id) => {
    const row = rows.messages.get(id)
    return row && !row.read_at && !(skipSnoozed && row.snoozed_until !== undefined)
  })
  hit.forEach((id) => {
    rows.messages.get(id)!.read_at = at
  })
  const issues = new Set(hit.map((id) => rows.messages.get(id)!.issue_id))
  // one pass over the loaded rows, however many tasks the read reaches,
  // which only reads them (store/rowMap.ts peekValues)
  const byIssue = new Map<string, Row<'messages'>[]>()
  for (const row of rows.messages.peekValues()) {
    if (!issues.has(row.issue_id)) continue
    const mine = byIssue.get(row.issue_id)
    if (mine) mine.push(row)
    else byIssue.set(row.issue_id, [row])
  }
  byIssue.forEach((mine) => {
    const newest = mine.reduce((x, y) => (isNewer(x.created_at, x.id, y.created_at, y.id) ? y : x))
    mine.forEach((row) => {
      if (row.read_at && row.id !== newest.id) rows.messages.delete(row.id)
    })
  })
}

const updates = createPlannerUpdates()
/* Publishes `section` (updates.ts). In tests it first checks that the rows
   on screen are exactly what the layers paint (checkLayers). Inside
   together() the comments' and the Inbox's emits wait for its end
   (heldRepaint), where a workspace emit shows them too. */
const emit = (section?: Parameters<typeof updates.emit>[0]) => {
  if (heldRepaint && (section === 'comments' || section === 'inbox')) {
    heldRepaint[section] = true
    return
  }
  if (STRICT_LAYERS) checkLayers()
  if (!section || section === 'workspace') {
    lastShown = shownWorkspace()
    // what shows now is where the next comparison starts (sameShown)
    workspaceRows.checkpoint()
    // a workspace emit changes every section, the held ones too
    if (heldRepaint) heldRepaint.comments = heldRepaint.inbox = false
    if (heldSections) heldSections.comments = heldSections.inbox = false
  } else if (heldSections && (section === 'comments' || section === 'inbox'))
    heldSections[section] = false
  updates.emit(section)
}

/** What a workspace emit shows besides the workspace rows, which keep their
    own record (store/rowMap.ts rowsChanged): the watched thread's rows,
    every value rebuild() derives, Roadmap's undo history and whether a
    write waits, which its undo reads too (P.roadmapUndo). The layers'
    paints show in the rows. */
function shownWorkspace() {
  const P = PLANNER
  return {
    thread: [rows.comments, rows.threadEvents],
    derived: [
      P.gridEpoch,
      P.TIMELINE_START.getTime(),
      P.TODAY_POS,
      P.TODAY_ISO,
      P.users,
      P.org,
      P.homeOrg,
      P.orgCreate,
      P.orgs,
      P.myProfileIds,
      P.teams,
      P.labels,
      P.projects,
      P.archivedProjects,
      P.projectTags,
      // the list P.issues shows, read past its test-build guard
      tasks.issues(),
      P.comments,
      P.threadEvents,
      P.commentsEarlier,
      P.historyEarlier,
      P.commentsNewer,
      P.historyNewer,
      P.threadGap,
      P.pinnedComments,
      P.threadApart,
      P.sections,
      P.detail,
      P.reference,
      P.messages,
      P.messageGroups,
      P.unreadMessages,
      P.readMessageCount,
      P.inboxCut,
      P.inboxCutReach.markAllRead,
      P.inboxCutReach.removeRead,
      P.CURRENT_USER,
      P.contextVersion,
      stillLoading,
      tasksAll,
      asked,
      taskTrouble,
      // Roadmap's undo (P.roadmapUndo), which a task edit's answer ends
      roadmapVisit?.count ?? 0,
      !roadmapVisit || roadmapVisit.disabled,
    ],
    waiting: layers.waiting(),
  }
}
/* What the last workspace emit showed, or null before the first. */
let lastShown: ReturnType<typeof shownWorkspace> | null = null

/** Whether what shows now is what `a` showed: the same derived values
    (which rebuild keeps identical while their data is, stable.ts), rows
    holding the same data and the same answer to whether a write waits. The
    workspace rows compare only the keys changed since `a` (rowsChanged).
    The inbox's rows are left out, because a painted read and the server's
    read differ only in its time, which no view shows; its view models count
    instead. */
function sameShown(a: ReturnType<typeof shownWorkspace>) {
  const b = shownWorkspace()
  return (
    a.waiting === b.waiting &&
    a.derived.every((value, i) => value === b.derived[i]) &&
    sameData(a.thread, b.thread) &&
    !workspaceRows.rowsChanged('messages')
  )
}

/** Emits when whether a write waits changed since the last workspace emit,
    while a Roadmap visit records. Its Undo reads that (P.roadmapUndo busy),
    and no other view does. A write that paints nothing, such as a
    preference save, is sent and answered without a repaint, so without
    this the button would keep the state it had before. */
function showWaiting() {
  if (!roadmapVisit || roadmapVisit.disabled || !lastShown) return
  if (lastShown.waiting === layers.waiting()) return
  // inside together(), with the repaint at its end
  if (heldRepaint) heldRepaint.emit = true
  else emit()
}

export type { ToastTone }

/* The two window hooks the app hangs globally: App mounts showToast for the
   non-React layers (this store, imgActions), with dismissToast to take a
   keyed one away, and the store re-exposes itself
   as window.PLANNER for the verify drives (scripts/verify-*.mjs). A showToast
   call without a tone shows a success. A sticky toast stays until the person
   closes it, which calls its `onDismiss`, and one shown again with the same
   `key` replaces its text. */
declare global {
  interface Window {
    showToast?:
      | ((
          msg: string,
          tone?: ToastTone,
          opts?: { sticky?: boolean; key?: string; onDismiss?: () => void },
        ) => void)
      | null
    /** Takes away the toast shown with `key`, if one shows. */
    dismissToast?: ((key: string) => void) | null
    PLANNER?: unknown
  }
}

/* Store toasts are refusals and failures unless the caller names a tone. */
function toast(msg: string, tone: ToastTone = 'error') {
  window.showToast?.(msg, tone)
}

/** Toasts `limit`'s sentence and answers true when `value`, trimmed, is over
    it: the store's check before anything is painted, behind the field's
    own (components/LimitedField.tsx). */
function refuseOver(limit: Limit, value: string): boolean {
  if (!overText(limit, value.trim())) return false
  toast(limitSentence(limit))
  return true
}

/** Toasts `limit`'s sentence and answers true when `n` is not a whole
    number within it. */
function refuseOutside(limit: Limit, n: number): boolean {
  if (!outsideWhole(limit, n)) return false
  toast(limitSentence(limit))
  return true
}

/** The sentence the server would refuse a description or comment `text`
    with, trimmed as the server trims it: over `limit` (LIMITS.description or
    LIMITS.comment), or mentioning more people than LIMITS.mentions allows
    (lib/mentions.ts). Null when it may be sent. The editor and the store
    guards below share it, so a refused draft is kept. */
export function textRefusal(limit: Limit, text: string): string | null {
  if (overText(limit, trimMarkdown(text))) return limitSentence(limit)
  if (tooManyMentions(text)) return limitSentence(LIMITS.mentions)
  return null
}

/** Toasts textRefusal's sentence and answers true when the server would
    refuse `text`: the store's check before anything is painted. */
function refuseText(limit: Limit, text: string): boolean {
  const refusal = textRefusal(limit, text)
  if (refusal) toast(refusal)
  return refusal !== null
}

/* --- the write path ---------------------------------------------------------
   Every store write goes through send() or sendAwaited(), each with its own
   optimistic layer (store/layers.ts). The rows on screen are always built
   the same way: the server's rows of the last snapshot delivery painted
   (the base, store/workspaceBase.ts, which a repaint brings up to the
   newest delivery, rowMap.ts beginRepaint) and the watched thread (commentsSnap, olderComments, historySnap, olderEvents), then every live
   layer painted over them in order (repaint). So:

   - A refused write takes away only its own layer, and every other change
     stays on screen.
   - A delivery cannot erase a change still waiting for its answer, because
     the change paints again over the new rows, which hold it already or not.
   - An accepted write keeps its layer until a live delivery is known to
     hold it. Convex runs a delivery's listeners before the write that
     delivery holds resolves (lib/convexOrdering.test.ts), so a write
     accepted while the snapshot is current, with a delivery since it was
     sent, drops its layer at once. During snapshot trouble no delivery holds
     it, so it stays saved until the trouble ends, and so do comment writes
     while the thread fails.

   A delivery that arrives while a painted write waits is painted at the
   first of two moments (owe): when the last painted write answers, which
   covers the echo Convex sends for that write in the same task, or a 0 ms
   timer. So other people's changes show within one task, and an echo costs
   one repaint. Paints follow the rules in store/layers.ts. */
const layers = createLayers()
/* Whether the newest snapshot result was a live good delivery. Convex hands
   a delivery that holds a write to the listeners before the write resolves,
   so a write accepted while this holds, with a delivery since it was sent,
   is already in the newest delivery. */
let snapshotCurrent = false
/* Live good deliveries counted since the store started, of the snapshot, of
   the watched thread, of the views' reads (viewReads), of the watched
   task's own answer (taskDelivered) and of the milestone reads'
   answers (P.watchMilestones). A layer remembers them when it is sent. */
let snapshotDeliveries = 0
let threadDeliveries = 0
let viewDeliveries = 0
let detailDeliveries = 0
let milestoneDeliveries = 0
/** The delivery counters now, which a layer keeps when it is sent. */
const deliveryCounters = () => ({
  snapshot: snapshotDeliveries,
  thread: threadDeliveries,
  view: viewDeliveries,
  detail: detailDeliveries,
  milestones: milestoneDeliveries,
})
/* Whether the newest thread result was a live good delivery of the watched
   task, as snapshotCurrent is for the snapshot. */
let threadCurrent = false
/* Whether the newest result of the watched task's own answer was a good
   delivery of its subscription, and the connection it arrived on. A
   failure, a fresh subscription (watchSection) and a re-init of the parts
   (stopParts) clear it, and a reconnect moves latestConnection past it
   (detailCurrent). */
let detailFresh = false
let detailConnection = 0
/** Whether the newest result of the watched task's own answer was a live
    good delivery on the socket's newest connection, so a write accepted
    while this holds, with a delivery since it was sent, is in it. */
const detailCurrent = () => detailFresh && detailConnection === latestConnection
/* The parts whose anchor changed while a painted write waited, and the
   timer that paints them at the latest (owe). The sections merge the rows
   on screen with their answers (rebuildSections), and the watched task's
   own answer is painted with the layers' detail parts when they repaint
   (paintDetail); their answers wait with the rest, so one transition
   still renders once. */
const owed = { workspace: false, thread: false, sections: false, view: false }
let payTimer: ReturnType<typeof setTimeout> | null = null
let storeEpoch = 0
let demoDisposed = false

/* Tests check every emit against the layers (checkLayers) and freeze the
   anchors, so a paint or answer that writes into the server's rows throws. */
const STRICT_LAYERS = import.meta.env.MODE === 'test'

/** A delivered value as the store keeps it as an anchor: frozen copy in
    tests, the value itself otherwise. */
const anchor = <T>(value: T): T => (STRICT_LAYERS ? deepFreeze(structuredClone(value)) : value)

/** Rebuilds the rows of `parts` from their anchors and every live layer
    (paintRows), and shows them. A workspace repaint also tells new tasks'
    callers their final handle and ends trouble a recovering delivery held,
    and every repaint tells the callers of the person's new tasks on their
    way the reference a moved number gave them (renumberPending). */
function repaint(parts: {
  workspace?: boolean
  thread?: boolean
  sections?: boolean
  view?: boolean
}) {
  if (heldRepaint) {
    heldRepaint.workspace ||= !!parts.workspace
    heldRepaint.thread ||= !!parts.thread
    heldRepaint.sections ||= !!parts.sections
    heldRepaint.view ||= !!parts.view
    return
  }
  const workspace = !!parts.workspace
  const thread = !!parts.thread
  const sections = !!parts.sections
  const view = !!parts.view
  if (workspace) owed.workspace = false
  if (thread) owed.thread = false
  if (sections) owed.sections = false
  if (view) owed.view = false
  if (!owed.workspace && !owed.thread && !owed.sections && !owed.view && payTimer) {
    clearTimeout(payTimer)
    payTimer = null
  }
  paintRows(workspace, thread, view, sections)
  if (workspace) {
    if (loadEnds) {
      loadEnds = false
      stillLoading = null
    }
    // the rows painted now hold every task once the delivery did
    tasksAll = tasksNext
    rebuild()
    // which tasks the views' rows stand in for follows the workspace
    const models = reshapeViews()
    moveHandles(lastMoves)
    // a delivery that brings nothing new to the screen, such as a batch's
    // echo of rows a bulk inbox action painted already, renders nothing;
    // rebuild built the sections again too, which the comparison covers
    if (!lastShown || !sameShown(lastShown)) {
      emit()
      windowLoadNews = false
      // the emit showed the window's borrowed group facts too
      windowSpanMoved()
    } else {
      if (thread) emit('comments')
      if (models || view || viewReadsChanged) emit('views')
    }
    // either emit showed the views
    viewReadsChanged = false
    // after the emit: it may send (reapPausedUploads)
    endHeldRecovery()
  } else {
    if (thread || sections) {
      if (thread) rebuildComments()
      // an answer that changes no section, such as the task answer's rerun
      // after a description save, renders nothing
      const shown = sections && rebuildSections()
      if (thread || shown) emit('comments')
    }
    // only a repaint of the views shows what a read changed; a thread's or
    // the sections' leaves it for the views' paint still owed
    if (view) {
      if (reshapeViews() || viewReadsChanged) emit('views')
      viewReadsChanged = false
    }
  }
  // what the window's delay reads besides its task shows with the
  // comments, an owner load or a group's facts from a view's row
  if (windowSpanMoved()) windowLoadNews = true
  if (windowLoadNews || familyNews) {
    windowLoadNews = false
    familyNews = false
    emit('comments')
  }
  // a new task's reference follows the number the screen shows now
  tellPendingMoves()
}

/* The parts asked to repaint while together() runs its step, whether
   something outside the rows changed that a workspace emit shows (emit),
   and whether the comments' or the Inbox's section asked to emit, as the
   unread summary's and the inbox item's news do. */
let heldRepaint: {
  workspace: boolean
  thread: boolean
  sections: boolean
  view: boolean
  emit: boolean
  comments: boolean
  inbox: boolean
} | null = null
/* The section emits together() still owes while its repaint runs, each
   dropped once the repaint emitted it or the workspace (emit). */
let heldSections: { comments: boolean; inbox: boolean } | null = null

/** Runs `step`, which settles several layers, and repaints what they asked
    for once at its end. React renders after each emit, so one repaint per
    layer would render the screen once for each. The comments' and the
    Inbox's emits wait too, since a workspace emit at the end shows them,
    and each one it did not show goes out after it. */
function together(step: () => void) {
  if (heldRepaint) return step()
  heldRepaint = {
    workspace: false,
    thread: false,
    sections: false,
    view: false,
    emit: false,
    comments: false,
    inbox: false,
  }
  try {
    step()
  } finally {
    const parts = heldRepaint
    heldRepaint = null
    heldSections = { comments: parts.comments, inbox: parts.inbox }
    try {
      // a repaint shows the emit's change too, as one render
      if (parts.workspace || parts.thread || parts.sections || parts.view)
        repaint({
          workspace: parts.workspace || parts.emit,
          thread: parts.thread,
          sections: parts.sections,
          view: parts.view,
        })
      else if (parts.emit) emit()
    } finally {
      const left = heldSections
      heldSections = null
      if (left.comments) emit('comments')
      if (left.inbox) emit('inbox')
    }
  }
}

/** Builds the rows of the parts named from their anchors and paints every
    live layer over them, in order (layers.ordered), without showing them.
    The workspace rows start again from the server's, with the staged
    delivery applied (store/rowMap.ts beginRepaint), the views' rows from
    their reads' answers (store/viewRows.ts), the milestone reads' rows,
    which repaint with the views', from their answers
    (store/milestoneRows.ts), and with `detail` the watched task's own
    answer from its anchor (paintDetail). */
function paintRows(workspace: boolean, thread: boolean, view = false, detail = false) {
  if (detail) paintDetail()
  const painting = workspace && hasSnapshot
  if (painting) {
    workspaceRows.beginRepaint()
    adoptIdentity()
    countInbox()
  }
  if (thread) buildThreadRows()
  if (view) {
    viewRows.beginPaint()
    milestoneRows.beginPaint()
  }
  workspaceRows.paint(() => {
    for (const layer of layers.ordered()) {
      // one paint that throws cannot keep every later delivery off the screen
      if (painting && layer.view.workspace) guarded(layer.view.workspace)
      const part = layer.view.thread
      if (thread && part && part.task === watchedComments) guarded(part.paint)
      if (view && layer.view.view) guarded(layer.view.view)
      if (view && layer.view.milestones) guarded(layer.view.milestones)
    }
  })
}

/* Faults the layer machinery caught (reportFault), kept in tests so the
   guard tests can show none happened. */
const faults: unknown[] = []

/** Logs `fault`, a defect the store caught so it cannot stop other work,
    and in tests keeps it for __layerProbe.faults(). */
function reportFault(fault: unknown) {
  console.error('[qivo] store fault:', fault)
  if (STRICT_LAYERS) faults.push(fault)
}

/** Runs `step`, reporting a throw (reportFault) instead of passing it on. */
function guarded(step: () => void) {
  try {
    step()
  } catch (fault) {
    reportFault(fault)
  }
}

/** Records that the anchor of `part` changed. It paints now when no painted
    write waits, else when the last one answers or a 0 ms timer fires. */
function owe(part: keyof typeof owed) {
  owed[part] = true
  if (!layers.paintedPending()) pay()
  else payTimer ??= setTimeout(pay, 0)
}

/** Paints the owed parts once. */
function pay() {
  if (payTimer) clearTimeout(payTimer)
  payTimer = null
  if (owed.workspace || owed.thread || owed.sections || owed.view) repaint({ ...owed })
}

/* ---- The task rows the open views' answers bring ----
   A view registers each read it shows here from an effect, with the
   arguments on screen, or none while its page or the tab is hidden: the
   Board its answer (P.watchBoard), the Overview its summary, its delays,
   its lists' batches and its health table (P.watchOverview and
   P.watchOverviewTable, store/overviewLists.ts), and Team sync its agenda
   (P.watchSync). Each read names its query and the rows its answer brings
   (ViewQuery); the health table's brings none. The store
   subscribes, takes each result in the transition that brings it and keeps
   a read's rows (store/viewRows.ts) while it stops, until the view asks for
   other arguments or its page leaves (P.releaseView, P.releaseOverview,
   P.releaseSync).
   A stopped read's rows never stand in for a live read's, as a kept
   Overview's when it hides behind the Board of its scope: the live reads'
   copies of a task lead in lookups, writes and delays, their deliveries
   bring the stopped copies up to date, and they alone decide whether a
   write is held (viewPartHeld). The rows' paint waits with the
   workspace's while a painted write waits (owe), so one transition still
   renders once. */

/* Whether view `slot`'s read is subscribed: its rows lead, and a stopped
   read's copies follow them (store/viewRows.ts). */
const viewLive = (slot: ViewSlot) => (viewReads.get(slot)?.live ?? null) !== null

const viewRows = createViewRows(isoToWeek, viewLive)

/** An answer whose rows a read keeps as they were (ViewQuery `rows`). */
const KEEP_ROWS = Symbol('keep the rows')

/** What a view read subscribes, and the rows its answer brings: `rows`
    answers the rows of a value for the arguments `key` (JSON), null for a
    value that brings none (the read's rows go) or KEEP_ROWS for one whose
    rows stay as they were, as a fixed Overview batch that split keeps its
    last rows until its halves answer. A read without `rows`, such as the
    Overview's summary, holds no rows, and its deliveries hold no write.
    A milestone read's `milestones` answers the ask its arguments `key`
    make and the milestones a value brings (store/milestoneRows.ts), which
    hold the milestone writes the read's deliveries hold
    (milestoneNeeds). `keepsOnError` keeps the rows of a read that fails
    as KEEP_ROWS does, so its view can show its last answer under the
    failure, as Team sync keeps a meeting's cards with their unsent text. */
type ViewQuery = {
  ref: FunctionReference<'query'>
  rows?: (value: unknown, key: string) => readonly ViewRow[] | null | typeof KEEP_ROWS
  milestones?: (value: unknown, key: string) => { ask: MilestoneAsk; take: MilestoneTake }
  keepsOnError?: boolean
  /** the rows of a value whose cards a view draws, by uuid, where it
      draws fewer than it brings: only their owners register with the
      owner-load cache for delays (reshapeViews), and the person's new
      tasks inserted into its rows (takesNew). Without it every row's
      owner does. */
  judged?: (value: unknown) => ReadonlySet<string> | null
  /** whether the person's own new tasks go into the read's rows until
      their create answers, or until a read behind a reconnect delivers
      again (newTaskParts, newTaskViewPaint), as for a view whose join shows
      the person's own changed tasks where its answer does not
      (P.ownOnScreen): the Board's and the Roadmap's */
  takesNew?: true
}

/** The Board's read: an ok answer brings its rows and its parents. */
const BOARD_QUERY: ViewQuery = {
  ref: api.tasks.board,
  takesNew: true,
  rows: (value) => {
    const answer = value as BoardAnswer
    return answer.state === 'ok' ? [...answer.rows, ...answer.parents] : null
  },
}

/** An Overview list batch's read: an ok answer brings its rows, without
    the At-risk marker, which the Overview keeps with the batch
    (store/overviewLists.ts). A batch with a fixed end that gives way to two
    halves, as it split or its reads stopped (splitAt), keeps its rows
    until the batches that replace it answer. */
const listQuery = (ref: FunctionReference<'query'>): ViewQuery => ({
  ref,
  rows: (value, key) => {
    const answer = value as ListAnswer
    if (answer.state !== 'ok') return null
    const { cursor = null, end = null } = JSON.parse(key) as { cursor?: string; end?: string }
    if (splitAt(cursor, end, answer) !== null) return KEEP_ROWS
    return answer.rows.map(({ at_risk: _risk, ...row }) => row)
  },
})

/** The Roadmap's read (tasks.roadmap): an ok answer brings its rows, the
    shown parents above them and the shown subtasks of its group rows, so
    a group's bar, stale fade and due mark read its family from the answer
    (views/roadmap/useRoadmapView.ts). Only its rows draw bars, so only
    their owners register for delays. */
const ROADMAP_QUERY: ViewQuery = {
  ref: api.tasks.roadmap,
  takesNew: true,
  rows: (value) => {
    const answer = value as RoadmapAnswer
    return answer.state === 'ok' ? [...answer.rows, ...answer.parents, ...answer.subtasks] : null
  },
  judged: (value) => {
    const answer = value as RoadmapAnswer
    return answer.state === 'ok' ? new Set(answer.rows.map((row) => row.id)) : null
  },
}

/** The Roadmap's dependency read (tasks.roadmapDependencies). It brings
    no rows, as the Overview's summary brings none: its slim rows are
    never drawn, and a write of a task only it holds paints nothing
    (P.moveDependencyTask). */
const DEPENDENCIES_QUERY: ViewQuery = { ref: api.tasks.roadmapDependencies }

/** The view slots of the Roadmap's two reads (P.watchRoadmap,
    P.watchRoadmapDependencies), and the owner-load cache's view key of
    its planning panel (P.watchPlanLoad). Team utilization's people
    register under the Roadmap's own slot (P.watchRoadmapTeam). */
export const ROADMAP_SLOT = 'roadmap'
export const ROADMAP_DEPS_SLOT = 'roadmap:deps'
const PLAN_LOADS = 'roadmap:plan'
/** The two slots of the Roadmap's milestone reads, the shown range and a
    new window's on its way, which it alternates
    (views/roadmap/useRoadmapMilestones.ts) and P.releaseRoadmap forgets. */
export const ROADMAP_MILESTONE_SLOTS = ['milestones:roadmap:a', 'milestones:roadmap:b'] as const
/** The slots of the Overview's milestone reads: two for each section, the
    answer shown and a Load more's or a new base's on its way, which the
    section alternates (views/useMilestoneSection.ts), and the one-row read
    of the next milestone while Upcoming moved on
    (views/useScopeMilestones.ts). P.releaseOverview forgets
    them. */
export const OVERVIEW_MILESTONE_SLOTS = {
  upcoming: ['milestones:overview:upcoming:a', 'milestones:overview:upcoming:b'],
  past: ['milestones:overview:past:a', 'milestones:overview:past:b'],
  next: 'milestones:overview:next',
} as const
/** The slots of the phone Roadmap agenda's milestone reads, two for each
    section as the Overview's (views/useScopeMilestones.ts), which
    P.releaseRoadmap forgets. */
export const AGENDA_MILESTONE_SLOTS = {
  upcoming: ['milestones:agenda:upcoming:a', 'milestones:agenda:upcoming:b'],
  past: ['milestones:agenda:past:a', 'milestones:agenda:past:b'],
} as const

/** The Overview's reads by query. The health table's rows are projects
    with figures, not tasks, so its answer brings no rows and holds no
    write. */
const OVERVIEW_QUERIES: Record<OverviewQuery, ViewQuery> = {
  summary: { ref: api.overview.summary },
  risk: { ref: api.overview.risk },
  attention: listQuery(api.overview.attention),
  paused: listQuery(api.overview.paused),
  health: { ref: api.overview.health },
}

/** Team sync's view slot (P.watchSync), its agenda's read and rows. */
const SYNC_SLOT: ViewSlot = 'sync'

/** The owner-load cache's view key of the people an organization Viewer's
    Team sync shows (P.watchSyncPeople). */
const SYNC_PEOPLE = 'sync:people'

/** Team sync's read (convex/teamSync.ts agenda). An ok answer brings its
    rows, without the blockers and verdicts the page reads from the answer
    itself, as an Overview batch's leave out At risk, its asks, its Done
    tasks and their shown parents. A meeting that stops fitting
    (over_ceiling, over_budget) and a read that fails keep the rows it last
    held, so the page shows that meeting with its cards' unsent text as no
    longer updating; unavailable takes them away at once, as access to the
    scope may have gone. */
const SYNC_QUERY: ViewQuery = {
  ref: api.teamSync.agenda,
  keepsOnError: true,
  rows: (value) => {
    const answer = value as AgendaAnswer
    if (answer.state === 'ok')
      return [
        ...answer.rows.map(({ blocked_by: _blocked, delay: _delay, ...row }) => row),
        ...answer.asks,
        ...answer.done,
        ...answer.parents,
      ]
    return answer.state === 'unavailable' ? null : KEEP_ROWS
  },
}

/** One view's read. */
type ViewRead = {
  /** what it subscribes and the rows its answer brings */
  query: ViewQuery
  /** the arguments' key the view asks for, null while it reads nothing */
  want: string | null
  /** which mounted view asked last: a leaving page's late cleanup must not
      stop the read of the page that took its place (P.watchBoard) */
  owner: number
  /** what the view's Try again counted when it last asked */
  attempt: number
  /** the key of the live subscription, and the way to stop it */
  live: string | null
  stop: (() => void) | null
  /** the last result, for the arguments `key`: a value or an error */
  held: { key: string; value?: unknown; error?: unknown } | null
  /** whether `held` came from the live subscription on the connection the
      socket holds now (latestConnection) */
  current: boolean
  connection: number
  /** whether the read held a value before, so a wait is a refresh */
  answered: boolean
  /** whether the view shows its cards' delays, which only then read the
      owner-load cache (the desktop Board does, the phone's list does not) */
  delays: boolean
  /** the view delivery count (viewDeliveries) at its last live delivery
      that took rows, 0 for none, which holds the writes sent before it */
  delivered: number
  /** whether its newest result kept the rows of an earlier one (KEEP_ROWS),
      so its rows may lack a write that result held: it holds none until a
      delivery takes rows again */
  behind: boolean
  /** the last result whose rows it took, for the arguments `key`, which a
      view that keeps its rows past a refusal or a failure shows under it
      (Team sync's stale meeting), and `until`, when it stopped being the
      live subscription's current result, the earliest of when its
      subscription stopped, when a reconnect left it to arrive again and
      when a refusal or a failure that kept its rows took its place, null
      while it is current; null once its rows went */
  fitted: { key: string; value: unknown; until: number | null } | null
  /** the rows whose owners register for delays (ViewQuery `judged`), null
      for every row */
  judged: ReadonlySet<string> | null
}
const viewReads = new Map<ViewSlot, ViewRead>()
/* The socket's newest connection count a view read's handler saw: after a
   reconnect Convex sends every result again, and none counts as current
   until it arrived again (store/liveParts.ts). */
let latestConnection = 0
/* Whether a view read changed what its view shows outside its rows, such
   as a failure, so the next view repaint renders it. */
let viewReadsChanged = false
/* The tasks each `view` paint changes (viewPaint). */
const viewPaintTasks = new WeakMap<Paint, ReadonlySet<string>>()
/* The views each `view` paint changes, where it changes only some views'
   rows, as a new task's insert (newTaskViewPaint): only those views' reads
   hold it (viewPartHeld). */
const viewPaintSlots = new WeakMap<Paint, ReadonlySet<ViewSlot>>()

/** A layer's `view` part, `paint`, which changes the views' rows of tasks
    `uuids` (store/layers.ts View), so a delivery of a read whose rows hold
    none of them does not hold it (viewPartHeld). */
function viewPaint(uuids: readonly string[], paint: Paint): Paint {
  viewPaintTasks.set(paint, new Set(uuids))
  return paint
}

/** Whether `read`'s rows hold the writes sent when the view deliveries
    counted `seen`: it is live, its newest result is a delivery on the
    socket's current connection since the send, and that delivery took its
    rows. */
const readHolds = (read: ViewRead, seen: number) =>
  read.live !== null &&
  read.current &&
  read.connection === latestConnection &&
  read.delivered > seen &&
  !read.behind

/** Whether the views' rows hold saved view part `paint` of a write sent
    when the view deliveries counted `seen`: each read whose rows hold a
    copy of a task it changes holds the write (readHolds). Convex delivers
    what a write changed before the write resolves
    (lib/convexOrdering.test.ts), so a write accepted then is in those
    deliveries (settleAccepted). A read stopped with its rows kept, as a
    hidden tab's or a kept page's, holds nothing until it reads again,
    except where a live read holds each of its copies of the tasks: those
    copies follow the live read's deliveries (store/viewRows.ts take), so
    the live read decides. A read whose rows hold none of the tasks, or
    that brings no rows, such as the Overview's summary, holds nothing
    either way. A part no read holds rows for paints nothing, so nothing is
    left to hold. A part that paints only some views (viewPaintSlots) is
    held by those views' reads alone. */
function viewPartHeld(paint: Paint, seen: number): boolean {
  const tasks = viewPaintTasks.get(paint)
  const only = viewPaintSlots.get(paint)
  for (const [slot, read] of viewReads) {
    if (only && !only.has(slot)) continue
    const rows = viewRows.rowsOf(slot)
    if (!rows || !read.query.rows) continue
    const copies = tasks ? [...tasks].filter((uuid) => rows.has(uuid)) : null
    if (copies?.length === 0) continue
    if (read.live === null && copies?.every((uuid) => viewRows.liveHolds(uuid))) continue
    if (!readHolds(read, seen)) return false
  }
  return true
}

/** Drops every saved view part the views' rows hold now (viewPartHeld). */
const dropHeldViewParts = () =>
  layers.dropSavedIf(
    'view',
    (layer) => !!layer.view.view && viewPartHeld(layer.view.view, layer.seen.view),
  )

/* Whether the Overview's lists take the reads' news in once the transition
   that brought it is over (settleOverview). */
let overviewSettling = false

/** Has the Overview's lists take their reads' news in once every view read
    of the transition that brought it took its result: the store hears each
    read's result on its own (syncViewRead), and a batch that took its
    answer before a neighbour's answer told that the neighbour splits would
    show a row that moved between them twice (store/overviewLists.ts). */
function settleOverview() {
  if (overviewSettling) return
  overviewSettling = true
  const epoch = storeEpoch
  queueMicrotask(() => {
    overviewSettling = false
    if (epoch === storeEpoch) overviewStep(() => overview.settle())
  })
}

/** Marks view read `read`'s last result whose rows it took as no longer
    the current one from now (ViewRead fitted `until`), keeping an earlier
    mark, so a view that shows it later says when it stopped updating. */
function fittedStops(read: ViewRead) {
  if (read.fitted && read.fitted.until === null) read.fitted = { ...read.fitted, until: Date.now() }
}

/** Takes view `slot`'s result of its live subscription `token`: its rows
    become the view's anchor, a delivery that brings rows holds the writes
    it changed (dropHeldViewParts), the Overview's lists take it in once the
    transition is over (settleOverview), and the views repaint when the
    waiting writes allow. */
function takeViewResult(slot: ViewSlot, read: ViewRead, key: string, token: string) {
  let next: NonNullable<ViewRead['held']>
  try {
    const value = live.read(token)
    if (value === undefined) return
    next = { key, value: anchor(value) }
  } catch (error) {
    next = { key, error }
  }
  together(() => {
    read.held = next
    read.current = true
    read.connection = latestConnection
    if (next.value !== undefined) read.answered = true
    const take = read.query.rows
    const rows =
      take && next.value !== undefined
        ? take(next.value, key)
        : next.error !== undefined && read.query.keepsOnError
          ? KEEP_ROWS
          : null
    if (take && rows === KEEP_ROWS) {
      read.behind = true
      // a refusal or a failure that keeps the rows ends their result's run
      fittedStops(read)
    } else if (take && rows !== KEEP_ROWS) {
      if (rows) viewRows.take(slot, rows)
      else viewRows.release(slot)
      // another person's task may hold a new task's preview number now
      if (rows) renumberPending()
      read.fitted = rows ? { key, value: next.value, until: null } : null
      read.judged = rows ? (read.query.judged?.(next.value) ?? null) : null
      read.delivered = ++viewDeliveries
      read.behind = false
      dropHeldViewParts()
    }
    // a milestone read's answer is its anchor; a failure keeps the last
    // one, which the view shows under its note (P.milestoneRead)
    const milestones = read.query.milestones
    if (milestones && next.value !== undefined) {
      const { ask, take: answer } = milestones(next.value, key)
      milestoneRows.take(slot, key, ask, answer)
      read.delivered = ++milestoneDeliveries
      dropHeldMilestoneParts()
    }
    viewReadsChanged = true
    if (overview.owns(slot)) settleOverview()
    owe('view')
  })
}

/** Brings view `slot`'s subscription in line with what it asks for. */
function syncViewRead(slot: ViewSlot) {
  const read = viewReads.get(slot)
  if (!read) return
  if (read.live !== null && read.live !== read.want) {
    read.stop?.()
    read.stop = null
    read.live = null
    read.current = false
    fittedStops(read)
  }
  if (read.want === null || read.live !== null) return
  const key = read.want
  const watch = live.watch(read.query.ref, JSON.parse(key) as Record<string, Value>)
  read.live = key
  read.current = false
  const stopTransitions = live.onTransition(
    (transition) => {
      latestConnection = Math.max(latestConnection, transition.connection)
      // a reconnect leaves the read's result to arrive again, so from now
      // it is not current (viewRead)
      if (read.live === key && read.current && read.connection < latestConnection) fittedStops(read)
      if (read.live === key && transition.tokens.has(watch.token))
        takeViewResult(slot, read, key, watch.token)
    },
    { view: true },
  )
  read.stop = () => {
    stopTransitions()
    watch.stop()
  }
  if (watch.joined) takeViewResult(slot, read, key, watch.token)
}

/** Forgets view `slot`'s rows, its owners' loads and what its read held,
    and repaints the views when it held any, such as a failure Try again
    leaves on a read that kept no answer (watchView), so the view shows its
    wait at once. A milestone read's Retry keeps its last answer
    (`keepMilestones`), as the view keeps the person's draft over it
    (P.milestoneRead). */
function releaseViewRows(slot: ViewSlot, keepMilestones = false) {
  const read = viewReads.get(slot)
  const held = !!read?.held
  if (read) {
    read.held = null
    read.behind = false
    read.fitted = null
    read.judged = null
  }
  slotDelayOwners.delete(slot)
  ownerLoads.release(slot)
  const rows = viewRows.holds(slot)
  if (rows) {
    viewRows.release(slot)
    // a write whose tasks only these rows held has none left to hold
    dropHeldViewParts()
  }
  const milestones = !keepMilestones && milestoneRows.holds(slot)
  if (milestones) releaseMilestoneRows(slot)
  if (!rows && !held && !milestones) return
  viewReadsChanged = true
  owe('view')
}

/**
 * Registers view `slot`'s read of `query` for the arguments `key`, JSON in
 * a fixed key order, or none with null, as the view's effect runs: the
 * rules of P.watchBoard, which every view read follows. Another query or
 * other arguments, or a new `attempt`, drop what the read held. Other
 * arguments the held answer may stand in for (`hold`) keep that answer and
 * its rows, never as current, until the answer for `key` replaces them: a
 * text filter that only narrows the Board's (views/board/useBoardView.ts
 * narrowsText), and the same Team sync meeting on a new day or week grid
 * (P.watchSync). The view decides when it holds; the store keeps one rule.
 * A new `attempt` on a read that keeps its rows past a failure
 * (ViewQuery keepsOnError) and still holds the last answer whose rows it
 * took (ViewRead fitted) asks afresh without dropping anything. The held
 * result, that answer, its rows and whether it is behind stay, not
 * current, until the attempt's result replaces them as any result does.
 * So Team sync's Try again keeps a stale meeting's cards with their
 * unsent text. A new attempt on any other read drops what it held, so the
 * view shows its wait at once, except that a milestone read's Retry keeps
 * its last answer (releaseViewRows `keepMilestones`).
 */
function watchView(
  slot: ViewSlot,
  query: ViewQuery,
  key: string | null,
  attempt = 0,
  owner = 0,
  delays = true,
  hold = false,
) {
  let read = viewReads.get(slot)
  if (read && key === null && read.owner !== owner) return
  if (!read) {
    read = {
      query,
      want: null,
      owner,
      attempt,
      live: null,
      stop: null,
      held: null,
      current: false,
      connection: 0,
      answered: false,
      delays,
      delivered: 0,
      behind: false,
      fitted: null,
      judged: null,
    }
    viewReads.set(slot, read)
  }
  if (key !== null) read.delays = delays
  if (key !== null && read.owner !== owner) {
    // another mounted view takes the read over, with its own Try again
    read.owner = owner
    read.attempt = attempt
  }
  const retry = attempt !== read.attempt
  read.attempt = attempt
  const other =
    key !== null && (read.query !== query || (read.held !== null && read.held.key !== key && !hold))
  if (key !== null && (retry || other)) {
    // a new attempt keeps the answer a read that keeps its rows still shows
    const keeps = !other && !!read.query.keepsOnError && read.fitted !== null
    read.stop?.()
    read.stop = null
    read.live = null
    read.current = false
    read.query = query
    if (keeps) {
      fittedStops(read)
      // the view shows the kept answer as waiting for the attempt's
      viewReadsChanged = true
      owe('view')
    } else releaseViewRows(slot, retry && !other && !!query.milestones)
  }
  if (read.want === key && !retry && !other) return
  const wasLive = read.live !== null
  read.want = key
  syncViewRead(slot)
  // a view whose read stops keeps its owners' loads without reading them
  ownerLoads.setLive(slot, key !== null)
  // which view's copies of a task lead follows which reads are live
  // (store/viewRows.ts), so the views repaint where another view holds rows
  if (wasLive !== (read.live !== null) && viewRows.holds(slot) && viewRows.shared()) {
    viewReadsChanged = true
    owe('view')
  }
  // a read that stops lends the window's delay no group's facts
  // (windowSpanRow), which the repaint shows
  else if (wasLive && read.live === null && windowSpanShown !== null) owe('view')
}

/** What view `slot`'s read holds: the arguments' key its result answers
    (null for none), its value or error, whether it is the live
    subscription's on the current connection, whether the read held a
    value before, so a wait is a refresh, and the last result whose rows it
    took (ViewRead fitted). */
function viewRead(slot: ViewSlot) {
  const read = viewReads.get(slot)
  const held = read?.held ?? null
  return {
    key: held?.key ?? null,
    ...(held && 'value' in held ? { value: held.value } : {}),
    ...(held && 'error' in held ? { error: held.error } : {}),
    current:
      !!read && read.current && read.live === held?.key && read.connection === latestConnection,
    answered: !!read?.answered,
    fitted: read?.fitted ?? null,
  }
}

/** Forgets view `slot`'s read and rows: its page left. */
function releaseView(slot: ViewSlot) {
  const read = viewReads.get(slot)
  if (!read) return
  read.want = null
  syncViewRead(slot)
  releaseViewRows(slot)
  viewReads.delete(slot)
}

/* The Overview's reads, over the view reads (store/overviewLists.ts). */
const overview = createOverviewReads({
  watch: (slot, query, key, attempt) =>
    watchView(slot, OVERVIEW_QUERIES[query], key, attempt, 0, false),
  read: viewRead,
  release: releaseView,
})

/** Runs `step`, an action on the Overview's reads, and shows what it
    changed in one repaint of the views. */
function overviewStep(step: () => void) {
  together(() => {
    step()
    viewReadsChanged = true
    owe('view')
  })
}

/* ---- The milestone reads ----
   A view registers each milestone read it shows here from an effect, by
   slot, with the arguments on screen, or none while its page or the tab is
   hidden (P.watchMilestones): the Milestones window opened on a milestone
   its `get` ('milestone:open'), the `get` of an editor whose milestone no
   section shows ('milestone:kept') and its Upcoming and Past sections,
   one live read each and a Load more's on its way
   ('milestones:window:upcoming:<n>', 'milestones:window:past:<n>',
   views/useMilestoneSection.ts), Team sync's opening its next
   milestone and the milestones of this week and next
   ('milestones:sync-next', 'milestones:sync-ahead'), the Roadmap's
   flags for the weeks on screen, the shown range and a new window's on
   its way under two fixed slots it alternates
   (ROADMAP_MILESTONE_SLOTS, views/roadmap/useRoadmapMilestones.ts), the
   Overview's Upcoming and Past, each on two fixed slots it alternates, and
   its next milestone's one-row read while Upcoming moved on
   (OVERVIEW_MILESTONE_SLOTS, views/useScopeMilestones.ts), and
   the phone Roadmap agenda's Upcoming and Past on slots of their own
   (AGENDA_MILESTONE_SLOTS, views/useScopeMilestones.ts, which the
   Roadmap holds). A kept
   page's reads only stop while it hides, and P.releaseOverview and
   P.releaseRoadmap forget them once App no longer keeps the page. My
   view's sections read with `mine` and name no projects; the server
   lists the projects in its answer, which the paints read. Each
   is a view read
   (watchView), with its owner, attempt, key, connection and the answer it
   keeps while it stops, and its answer's milestones are the read's anchor
   in milestoneRows. They are the store's only milestones, since the
   workspace's projects part sends none, so every milestone the app shows,
   edits or names comes from them. Every
   live layer's `milestones` part paints every copy of a milestone it
   changes there, and a delivery of each read that holds a copy holds the
   write, so a person's rename shows in every read at once and stays until
   the reads show it. Once the server accepted it, a part paints only the
   reads that have not delivered it yet (milestoneNeeds), so a read that
   holds it shows its own deliveries while a hidden page's stopped read
   keeps it. The answers repaint with the views and never join the
   workspace's context (P.contextVersion). */

/** The most projects one milestone read names, the store's copy of
    convex/lib/limits.ts MILESTONE_READ_PROJECTS, which tests lower. A read
    of more top-level projects asks nothing (P.watchMilestones). */
export const MILESTONE_READS = { projects: MILESTONE_READ_PROJECTS }

/** The reasons of the milestone reads' refusals that the view shows in the
    server's words: a read whose projects need more reads than one request
    allows (convex/model/milestones.ts MILESTONE_READ_TOO_LARGE), and an
    access check a bound of the person's own reads stopped
    (convex/lib/access.ts ACCESS_UNCHECKED). */
const MILESTONE_REFUSALS = new Set(['milestone_read_too_large', 'access_unchecked'])

/** The reason of the refusal of a `mine` read whose person's work lies in
    more top-level projects than one read names (convex/model/milestones.ts
    MILESTONE_TOO_MANY), which P.milestoneRead answers as too_many, as for
    a view that names more. */
const MILESTONE_TOO_MANY = 'milestone_too_many'

/* The slots whose last ask named more top-level projects than
   MILESTONE_READS.projects, which read nothing. */
const milestonesTooMany = new Set<ViewSlot>()

/** What a milestone paint changes, for whether a read's delivery holds it
    (milestoneNeeds): the milestones it edits or hides, the top-level
    projects whose milestones it hides, and the rows it puts in place, a
    create's or an edit's row as the write leaves it. */
type MilestoneMarks = {
  ids?: readonly string[]
  projects?: readonly string[]
  rows?: readonly MilestoneRow[]
}
const milestonePaintMarks = new WeakMap<Paint, MilestoneMarks>()

/** A layer's `milestones` part, `paint`, which changes what `marks` names
    (milestoneNeeds). */
function milestonePaint(marks: MilestoneMarks, paint: Paint): Paint {
  milestonePaintMarks.set(paint, marks)
  return paint
}

/* The milestone reads' rows: a sub-project stands for its top-level
   project, as the server folds the projects a read names. Only the reads'
   own answers tell which rows a read is known to lack
   (store/milestoneRows.ts coversRow). */
const milestoneRows = createMilestoneRows({
  topOf: (id) => rows.projects.get(id)?.parent_id ?? id,
  live: viewLive,
})

/** Whether read `slot`'s answer holds what `marks` changes: a copy of one
    of its milestones or a milestone of one of its projects, or a row the
    read would answer (store/milestoneRows.ts covers). */
function milestoneMarked(slot: ViewSlot, marks: MilestoneMarks): boolean {
  if (marks.ids?.some((id) => milestoneRows.anchorHas(slot, id))) return true
  if (marks.projects && milestoneRows.anchorHasProject(slot, new Set(marks.projects))) return true
  return marks.rows?.some((row) => milestoneRows.covers(slot, row)) ?? false
}

/** Whether stopped read `slot`'s copies of what `marks` changes follow a
    live read's deliveries (store/milestoneRows.ts take): its answer holds
    a copy of at least one of the milestones, a live read's answer holds
    each one it holds, and the write adds no milestone to it and takes no
    project's milestones out of it, which no delivery of another read
    brings it. */
function followsLive(slot: ViewSlot, marks: MilestoneMarks): boolean {
  const copies = marks.ids?.filter((id) => milestoneRows.anchorHas(slot, id)) ?? []
  if (!copies.length || !copies.every((id) => milestoneRows.liveHolds(id))) return false
  if (marks.projects && milestoneRows.anchorHasProject(slot, new Set(marks.projects))) return false
  return !marks.rows?.some(
    (row) => !milestoneRows.anchorHas(slot, row.id) && milestoneRows.covers(slot, row),
  )
}

/* The milestone reads each saved milestone part still paints, by part.
   From the server's acceptance on, these are only the reads whose answers
   held what its write changed and have not delivered it since, and the
   reads an earlier saved part on the same milestones still paints
   (milestoneNeeds). A read leaves its part's reads once it delivers the
   write, or its answer goes, and none ever joins them, so a read whose
   answer came after the write shows that answer as the server sent it. */
const milestoneScopes = new WeakMap<Paint, Set<ViewSlot>>()

/** A saved milestone part as milestoneNeeds weighs a later one against
    it: what it changes, and the reads it still paints. */
type SavedMilestones = { marks: MilestoneMarks | undefined; scope: ReadonlySet<ViewSlot> }

/** Whether two milestone paints change one milestone, or one changes a
    milestone of a project whose milestones the other takes out. */
function sameMilestones(a: MilestoneMarks, b: MilestoneMarks): boolean {
  const ids = (m: MilestoneMarks) => [...(m.ids ?? []), ...(m.rows ?? []).map((row) => row.id)]
  const theirs = new Set(ids(b))
  if (ids(a).some((id) => theirs.has(id))) return true
  const hides = (m: MilestoneMarks, other: MilestoneMarks) =>
    !!m.projects?.length &&
    (other.projects?.some((id) => m.projects?.includes(id)) ||
      other.rows?.some((row) => m.projects?.includes(row.project_id)))
  return !!(hides(a, b) || hides(b, a))
}

/** The saved milestone parts, in the order they paint, with the reads each
    one still paints. */
const savedMilestoneParts = (): SavedMilestones[] =>
  layers.ordered().flatMap((layer) => {
    const part = layer.view.milestones
    const scope = part && milestoneScopes.get(part)
    return layer.state === 'saved' && part && scope
      ? [{ marks: milestonePaintMarks.get(part), scope }]
      : []
  })

/** The milestone reads that still need saved milestone part `paint` of a
    write sent when their deliveries counted `seen`, of those `scope` names
    when the part has one: each read whose answer holds what the write
    changes (milestoneMarked) and whose newest result is not yet a live
    delivery on the socket's current connection since the send
    (readHolds), as viewPartHeld decides for the views' rows. A read
    stopped with such an answer kept, as a hidden page's, needs it until it
    reads again, except where its copies follow a live read's deliveries
    (followsLive): it then needs it only while one of the live reads does.
    A read that holds nothing of the write, as one whose answer came later
    or one released, needs none: Convex delivers what a write changed
    before the write resolves (lib/convexOrdering.test.ts). Every read that
    a part saved before it (`earlier`) on the same milestones still paints
    needs it too, so the later change shows over the earlier one there, as
    a move out of a hidden range after a move into it. */
function milestoneNeeds(
  paint: Paint,
  seen: number,
  earlier: readonly SavedMilestones[],
  scope?: ReadonlySet<ViewSlot>,
): Set<ViewSlot> {
  const marks = milestonePaintMarks.get(paint)
  const needs = new Set<ViewSlot>()
  const following: ViewSlot[] = []
  for (const [slot, read] of viewReads) {
    if (scope && !scope.has(slot)) continue
    if (!read.query.milestones || !milestoneRows.holds(slot)) continue
    if (marks && !milestoneMarked(slot, marks)) continue
    if (read.live === null && marks && followsLive(slot, marks)) following.push(slot)
    else if (!readHolds(read, seen)) needs.add(slot)
  }
  if ([...needs].some(viewLive)) for (const slot of following) needs.add(slot)
  for (const part of earlier)
    if (!marks || !part.marks || sameMilestones(marks, part.marks))
      for (const slot of part.scope)
        if (milestoneRows.holds(slot) && (!scope || scope.has(slot))) needs.add(slot)
  return needs
}

/** Saved milestone part `paint`, run on the reads `scope` names alone
    (store/milestoneRows.ts within), which dropHeldMilestoneParts
    narrows. */
function scopedMilestonePaint(paint: Paint, scope: Set<ViewSlot>): Paint {
  const scoped = () => milestoneRows.within(scope, paint)
  const marks = milestonePaintMarks.get(paint)
  if (marks) milestonePaintMarks.set(scoped, marks)
  milestoneScopes.set(scoped, scope)
  return scoped
}

/** Drops every saved milestone part that no milestone read needs any more
    (milestoneNeeds), and takes the reads that no longer need one out of
    the reads it paints, so they show their own answers from the next
    repaint on. Answers whether it dropped any. */
function dropHeldMilestoneParts(): boolean {
  const held = new Set<Layer>()
  const earlier: SavedMilestones[] = []
  for (const layer of layers.ordered()) {
    const part = layer.view.milestones
    if (layer.state !== 'saved' || !part) continue
    const scope = milestoneScopes.get(part)
    const needs = milestoneNeeds(part, layer.seen.milestones, earlier, scope)
    if (scope) for (const slot of scope) if (!needs.has(slot)) scope.delete(slot)
    if (needs.size === 0) held.add(layer)
    else earlier.push({ marks: milestonePaintMarks.get(part), scope: needs })
  }
  return held.size > 0 && layers.dropSavedIf('milestones', (layer) => held.has(layer))
}

/** Forgets milestone read `slot`'s answer, and the saved paints only it
    held. The caller repaints the views. */
function releaseMilestoneRows(slot: ViewSlot) {
  milestoneRows.release(slot)
  shapedMilestones.delete(slot)
  dropHeldMilestoneParts()
}

/** Whether `ask` names more top-level projects than one read names
    (MILESTONE_READS.projects), so the store asks nothing. */
const milestoneAskTooMany = (ask: MilestoneAsk) =>
  ask.kind !== 'get' && new Set(ask.projects).size > MILESTONE_READS.projects

/** The arguments of `ask` as its query takes them, as JSON in a fixed key
    order, with its projects once each and sorted, `mine` after them on a
    `mine` section ask (its projects empty), and its empty fields left out,
    so equal asks share one subscription and a `mine` ask and a named one
    never share an answer. */
function milestoneKey(ask: MilestoneAsk): string {
  const after = (at: MilestonePosition | undefined) =>
    at === undefined ? {} : { after: { week: at.week, key: at.key, id: at.id } }
  if (ask.kind === 'get') return JSON.stringify({ id: ask.id })
  const projects = [...new Set(ask.projects)].sort()
  if (ask.kind === 'between')
    return JSON.stringify({ projects, from: ask.from, to: ask.to, ...after(ask.after) })
  const search = ask.search?.trim() ? { search: ask.search } : {}
  return JSON.stringify({
    projects,
    ...(ask.mine ? { mine: true } : {}),
    from: ask.from,
    side: ask.side,
    ...search,
    ...after(ask.after),
    limit: ask.limit,
  })
}

/* The milestone queries' answers, as convex/milestones.ts gives them. */
type MilestoneBatchAnswer = {
  rows: MilestoneRow[]
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
  projects?: string[]
}
type MilestoneGetAnswer = {
  row: MilestoneRow
  project: MilestoneProject
  can_write: boolean
} | null

/** The milestone reads by kind: each answer brings its milestones as the
    read's anchor, and holds no task rows. */
const MILESTONE_QUERIES: Record<MilestoneAsk['kind'], ViewQuery> = {
  get: {
    ref: api.milestones.get,
    milestones: (value, key) => {
      const got = value as MilestoneGetAnswer
      const { id } = JSON.parse(key) as { id: string }
      return {
        ask: { kind: 'get', id },
        take: got
          ? {
              rows: [got.row],
              next: null,
              stopped: null,
              project: got.project,
              canWrite: got.can_write,
            }
          : { rows: [], next: null, stopped: null, project: null, canWrite: false },
      }
    },
  },
  section: {
    ref: api.milestones.section,
    milestones: (value, key) => {
      const batch = value as MilestoneBatchAnswer
      const args = JSON.parse(key) as Omit<Extract<MilestoneAsk, { kind: 'section' }>, 'kind'>
      return {
        ask: { kind: 'section', ...args },
        take: {
          rows: batch.rows,
          next: batch.next,
          stopped: batch.stopped,
          ...(batch.past === undefined ? {} : { past: batch.past }),
          // a `mine` answer's projects, which its paints read
          ...(args.mine && batch.projects ? { projects: batch.projects } : {}),
        },
      }
    },
  },
  between: {
    ref: api.milestones.between,
    milestones: (value, key) => {
      const batch = value as MilestoneBatchAnswer
      const args = JSON.parse(key) as Omit<Extract<MilestoneAsk, { kind: 'between' }>, 'kind'>
      return {
        ask: { kind: 'between', ...args },
        take: { rows: batch.rows, next: batch.next, stopped: batch.stopped },
      }
    },
  },
}

/** What a milestone read shows, painted: its milestones as view models in
    the server's order, each one's stored name and day (an editor sends
    what it showed as the write's expected values), `next`, `stopped` and
    `past` as the answer gave them, a `past` a person's create of a past
    milestone made true, and for a `get` the project that stores its
    milestone and whether the person may change it. A `get` whose
    milestone a person's own delete took away, or the server answered null
    for, shows no milestone. */
export type MilestoneAnswer = {
  rows: readonly MilestoneVM[]
  stored: ReadonlyMap<string, { name: string; week: string }>
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
  project?: MilestoneProject | null
  canWrite?: boolean
}

/** What milestone read `slot` holds (P.milestoneRead):
    - `loading`, nothing for the arguments asked;
    - `too_many`, more top-level projects than one read names
      (MILESTONE_READS.projects), so nothing was asked, or a `mine` read the
      server refused for as many (MILESTONE_TOO_MANY), with no rows kept;
    - `refused`, a refusal the view shows in the server's words
      (MILESTONE_REFUSALS), with the answer kept from before, if any;
    - `failed`, any other error, which the view's Retry asks again, with
      the answer kept from before, if any;
    - `ok`, the answer, `current` when it is the live subscription's on
      the socket's current connection, else kept and refreshing. */
export type MilestoneRead =
  | { state: 'loading' }
  | { state: 'too_many' }
  | { state: 'refused'; reason: string; sentence: string; kept: MilestoneAnswer | null }
  | { state: 'failed'; kept: MilestoneAnswer | null }
  | { state: 'ok'; current: boolean; answer: MilestoneAnswer }

/* Each slot's answer as last shaped, so a read that shows the same rows
   keeps its objects (keepItems). */
const shapedMilestones = new Map<
  ViewSlot,
  { from: MilestonesShown; grid: number; answer: MilestoneAnswer }
>()

/** Milestone read `slot`'s answer as it shows, painted, or null: its rows
    and the rest of the answer they were painted from, never a newer
    anchor's `next`, `stopped` or project before a repaint paints it. */
function milestoneAnswer(slot: ViewSlot): MilestoneAnswer | null {
  const shown = milestoneRows.shownOf(slot)
  if (!shown) return null
  const { take } = shown
  const was = shapedMilestones.get(slot)
  if (
    was &&
    was.from.rows === shown.rows &&
    was.from.past === shown.past &&
    was.from.take === take &&
    was.grid === PLANNER.gridEpoch
  )
    return was.answer
  const answer: MilestoneAnswer = {
    rows: keepItems(was?.answer.rows ?? [], shown.rows.map(shapeMilestone)),
    stored: new Map(shown.rows.map((row) => [row.id, { name: row.name, week: row.week }])),
    next: take.next,
    stopped: take.stopped,
    ...(shown.past === undefined ? {} : { past: shown.past }),
    ...(take.project === undefined ? {} : { project: take.project, canWrite: !!take.canWrite }),
  }
  shapedMilestones.set(slot, { from: shown, grid: PLANNER.gridEpoch, answer })
  return answer
}

/** Milestone `id` as a milestone read shows it, a live read's first, or
    undefined while no read shows it. The writes take their row from here,
    since the reads hold the only milestones the store keeps. */
const milestoneOnScreen = (id: string): MilestoneRow | undefined => milestoneRows.row(id)

/** The organization of milestone `row`: the one a `get` answer named for
    it, else its project's in the store (orgOfProject, from the projects
    part until t3/limits-projects-part removes it), else none (''). */
const milestoneOrg = (row: MilestoneRow): string =>
  milestoneRows.orgOf(row.id) ?? orgOfProject(row.project_id)

/** The `milestones` part of an archive or delete of project `id`, which
    takes the milestones of a top-level project out of every milestone read.
    Milestones sit on top-level projects, so a sub-project's takes none. */
const hideProjectMilestones = (id: string): Paint =>
  milestonePaint({ projects: [id] }, () => milestoneRows.hideProjects(new Set([id])))

/* Whether view `slot`'s rows may stand in for the owner-load cache's spans
   of their tasks in a delay and in a person's work, which needs its read
   live and its newest result to have taken its rows, not kept them past a
   refusal or a failure (ViewRead `behind`) as Team sync's stale meeting
   does. A row of a task that a write of the person's own still waits on
   stands in from any view that holds it, live or stopped
   (viewWritesWaiting), as viewDelayCtx says. */
const viewLends = (slot: ViewSlot) => viewLive(slot) && !viewReads.get(slot)?.behind

/* Every view, for the rows a waiting write lends (viewDelayCtx). */
const anyView = () => true

/* No task, while no write waits (viewWritesWaiting). */
const NO_TASKS: ReadonlySet<string> = new Set()

/** The tasks, by uuid, that a write of the person's own paints in the
    views and the server has not answered yet, open or pending, as each such
    layer's `view` part names them (viewPaint). */
function viewWritesWaiting(): ReadonlySet<string> {
  if (!layers.paintedPending('view')) return NO_TASKS
  const out = new Set<string>()
  for (const layer of layers.ordered()) {
    if (layer.state === 'saved' || !layer.view.view) continue
    for (const uuid of viewPaintTasks.get(layer.view.view) ?? []) out.add(uuid)
  }
  return out
}

/** Whether view part `paint`, while its write waited, lent the delay
    context a row that no view lends otherwise (viewDelayCtx), a row of a
    task it changes that the workspace does not hold and that only views
    that do not lend hold, such as a kept Board's behind the Roadmap. */
function lentWhileWaiting(paint: Paint): boolean {
  for (const uuid of viewPaintTasks.get(paint) ?? [])
    if (
      !uuidToKey.has(uuid) &&
      !viewRows.liveHolds(uuid, viewLends) &&
      viewRows.liveHolds(uuid, anyView)
    )
      return true
  return false
}

/** What judging a task only a view holds reads from the store
    (store/viewDelay.ts), and with it what reconciling a person's work for
    Team utilization and the planning panel reads (ownerItemsCtx). The rows
    that stand in for the cache's spans of their tasks are those of the
    live reads whose newest result took its rows (viewLends). A stopped
    read's rows, as a kept Team sync's or Overview's behind the Board or a
    kept Board's behind the Roadmap, and the rows a live read kept past a
    refusal or a failure, as Team sync's stale meeting keeps, hear no
    change made since, so the cache's spans of those tasks, which stay live
    while some view reads their owner, are the newer. So a task such a read
    still holds counts at its hours now, and not at all once it is Done.

    A row of a task that a write of the person's own still waits on
    (viewWritesWaiting) is the exception. The write shows in every view's
    row of the task and maybe not yet in the cache's spans, so the row
    stands in from any view that holds it, after the lending views' rows,
    and its pending hours, dates, pause or owner count at once. Once the
    server answers, Convex has brought the cache's live spans up to date
    (lib/convexOrdering.test.ts), and such a view's row stands in no more
    (settleAccepted), though its paint stays until the view reads again.
    Which copies lead in lookups and which reads hold a write stay with the
    live reads (viewLive, viewPartHeld). */
const viewDelayCtx: ViewDelayCtx = {
  load: (org, owner) => ownerLoads.loadOf(org, owner),
  held: (uuid) => uuidToKey.has(uuid),
  inView: (uuid) =>
    viewRows.liveHolds(uuid, viewLends) ||
    (viewWritesWaiting().has(uuid) && viewRows.liveHolds(uuid, anyView)),
  heldSpans: (owner) => tasks.shownSpans(owner),
  *viewRows() {
    const views = viewRows.views()
    for (const [slot, held] of views) {
      if (!viewLends(slot)) continue
      for (const row of held.values()) if (!uuidToKey.has(row.id)) yield row
    }
    // then the other views' rows of the tasks a write waits on, so a
    // lending view's copy of such a task comes first
    const waiting = viewWritesWaiting()
    if (waiting.size === 0) return
    for (const [slot, held] of views) {
      if (viewLends(slot)) continue
      for (const uuid of waiting) {
        const row = held.get(uuid)
        if (row && !uuidToKey.has(uuid)) yield row
      }
    }
  },
  capacity: (id) => {
    const person = PLANNER.user(id)
    return (person && plannableHoursOf(person)) || DEFAULT_PLANNABLE_HOURS
  },
  projectLive: (id) => !!PLANNER.project(id),
  // the people part's organization, else the profile cache's, '' for a
  // person the server's answer leaves out, undefined while it cannot tell
  orgOf: (id) => {
    const held = rows.profiles.get(id)?.org_id
    if (held) return held
    const known = profileCache.look(id)
    if (known.state === 'face' || known.state === 'name') return known.org
    return known.state === 'gone' ? '' : undefined
  },
}

/* What reconciling a person's work for Team utilization and the planning
   panel reads from the store (store/viewDelay.ts ownerItemsOf). It reads
   the delay context's rows, so only a live, current view's rows replace
   the cache's spans (viewLends), and any view's row of a task a write of
   the person's own waits on. Its `filed` holds while the rows and those
   writes hold still, until the next reshape, or until an answered write
   ends a stopped view's row's stand-in (settleAccepted). */
const ownerItemsCtx: OwnerItemsCtx = {
  held: viewDelayCtx.held,
  inView: viewDelayCtx.inView,
  viewRows: viewDelayCtx.viewRows,
  projectLive: viewDelayCtx.projectLive,
  orgOf: viewDelayCtx.orgOf,
  heldItems: (owner) => tasks.shownItems(owner),
}

/* The delay of each task only a view holds, by uuid, as the last reshape
   judged it. */
let viewDelays = new Map<string, DelayInfo | typeof DELAY_UNKNOWN | null>()

/* Whether reshapeViews runs: the owner-load cache's changes it hears then
   are its own registration's, which the judging after it reads anyway. */
let reshaping = false

/** The row of group `uuid` that the window's delay takes the group's
    facts from (windowDelayIssue), or undefined. The group is one the
    window shows from its answer whose dates the answer cannot give, as
    when a subtask has subtasks of its own, and the row is its row in a
    view whose read is current, the live subscription's own answer on the
    newest connection, which carries the server's span. A stopped view's
    kept rows hear no change to the task, so they never lend it. */
function windowSpanRow(uuid: string): ViewRow | undefined {
  const detail = PLANNER.taskDetail(uuid)
  if (!detail || detail.datesKnown) return undefined
  for (const [slot, read] of viewReads) {
    if (read.behind || !viewRead(slot).current) continue
    const row = viewRows.rowsOf(slot)?.get(uuid)
    if (row?.has_subtasks && row.span) return row
  }
  return undefined
}

/* The group facts the window's delay last took from a view's row
   (windowSpanRow) when the comments showed, as JSON, or null for none. */
let windowSpanShown: string | null = null

/** Whether the group facts the window's delay takes from a view's row
    (windowSpanRow) changed since the comments last showed, and records
    them. The window listens to the comments, and a view's answer repaints
    only the views. */
function windowSpanMoved(): boolean {
  const row = watchedComments ? windowSpanRow(watchedComments) : undefined
  const shown = row ? JSON.stringify([row.span, row.group_done]) : null
  if (shown === windowSpanShown) return false
  windowSpanShown = shown
  return true
}

/** Task `it` as the window's delay verdict reads it (P.windowDelay), with
    a group's facts: from P.taskDetail for a task the window shows from its
    own read, else from the workspace's tasks, by the rules the task index
    judges with (store/taskIndex.ts judge). A group shown from its answer
    whose dates the answer cannot give takes its Done and span from a
    current view's row of it (windowSpanRow), as that view's card does, so
    the window over the card shows its verdict. Everything else, its due
    date included, stays the window's own. Without such a row its dates
    stay unknown. */
function windowDelayIssue(it: IssueVM) {
  const detail = PLANNER.taskDetail(it.uuid)
  const group = isIssueGroup(it)
  const row = detail && group ? windowSpanRow(it.uuid) : undefined
  if (row) {
    const { isDone, partial, start, end } = delayIssueOfRow(row, viewDelayCtx.capacity)
    const own = delayIssueOfTask(
      it,
      { isGroup: true, isDone: !!isDone, partial: !!partial },
      viewDelayCtx.capacity,
    )
    return {
      issue: { ...own, start, end },
      facts: { datesKnown: true, loading: false },
    }
  }
  const span = !detail && group ? groupSpan(it, PLANNER.issueById) : null
  const issue = delayIssueOfTask(
    it,
    {
      isGroup: group,
      isDone: detail ? detail.done : isIssueDone(it, PLANNER.issueById),
      partial: detail ? detail.partial : !!span?.partial,
    },
    viewDelayCtx.capacity,
  )
  const facts = {
    datesKnown: detail ? detail.datesKnown : true,
    // a held group's subtasks may be still to come until every task is
    loading: !detail && !tasksAll,
  }
  return { issue, facts }
}

/* The owner-load cache's view key of the task window. */
const WINDOW_LOADS = 'window'
/* The owner the window's delay registered with the owner-load cache, as
   `org\0owner`, or null. */
let windowLoad: string | null = null
/* Whether an owner load the window reads changed since the comments last
   showed (the cache's `changed` repaints only the views). */
let windowLoadNews = false
/* Whether the task answer that a held task's family comes from before every
   task is held changed since the comments last showed (receiveSection). */
let familyNews = false
/* Whether syncWindowLoad registers now, so the cache's news is its own. */
let windowLoadSyncing = false

/** Registers the watched task's owner with the owner-load cache under the
    window's own key (WINDOW_LOADS, one owner, one card) while a window
    shows the task's details, the task's project shows delays, the
    workspace cannot judge the task (a task the window shows from its own
    read, the person's new task from its creating answer among them, or a
    held one, such as the person's new task in a store that asked, before
    every task is held) and its verdict reads the
    owner's load (issueNeedsLoad), and releases it otherwise. The desktop
    Inbox pane shows no details and registers nothing. A guest's or
    Viewer's calls are counted per view key, so the window's one owner
    never meets the cap. The cache follows the hidden-tab gate. */
function syncWindowLoad() {
  const t = watchedComments
  const handle = t ? uuidToKey.get(t) : undefined
  const held = handle === undefined ? undefined : PLANNER.issueById[handle]
  const detail = t ? PLANNER.taskDetail(t) : null
  const shown = held ?? (detail?.answered === 'ok' ? (detail.view ?? undefined) : undefined)
  const judged = !!shown && (!held || !tasksAll)
  const need =
    judged && sectionOwners.size > 0 && shown && PLANNER.tracksDelay(shown)
      ? windowDelayIssue(shown).issue
      : null
  const key = need?.owner && issueNeedsLoad(need) ? `${shown?.org}\u0000${need.owner}` : null
  if (key === windowLoad) return
  windowLoad = key
  windowLoadSyncing = true
  try {
    if (key && shown && need?.owner)
      ownerLoads.register(WINDOW_LOADS, [{ org: shown.org, owner: need.owner, cards: 1 }])
    else ownerLoads.release(WINDOW_LOADS)
  } finally {
    windowLoadSyncing = false
  }
  windowLoadNews = true
}

/* The owners each view slot's cards need for their delays, as the last
   reshape found them (reshapeViews), and the owners a view registers
   besides, under the same slot: Team utilization's people under the
   Roadmap's (P.watchRoadmapTeam). One slot is one view key of the
   owner-load cache, so a guest's or Viewer's calls for both stay under one
   GUEST_CALLS cap. */
const slotDelayOwners = new Map<ViewSlot, OwnerNeed[]>()
const slotExtraOwners = new Map<ViewSlot, OwnerNeed[]>()

/** Registers view `slot`'s owners with the owner-load cache, its cards'
    and the others it named, each owner once with its counts added, live
    while `live`. */
function registerViewOwners(slot: ViewSlot, live: boolean) {
  const merged = new Map<string, OwnerNeed>()
  for (const need of [...(slotDelayOwners.get(slot) ?? []), ...(slotExtraOwners.get(slot) ?? [])]) {
    const key = `${need.org}\u0000${need.owner}`
    const was = merged.get(key)
    merged.set(key, was ? { ...was, cards: was.cards + need.cards } : { ...need })
  }
  if (merged.size === 0) ownerLoads.release(slot)
  else ownerLoads.register(slot, [...merged.values()], live)
}

/** Registers with the owner-load cache the owners whose loads the cards of
    the views that show delays need, with the other owners a view named
    (slotExtraOwners), judges those cards' delays and shapes the models of
    the tasks only the views hold. Answers whether any model changed. */
function reshapeViews(): boolean {
  reshaping = true
  // the rows may have changed since the views' work was filed
  ownerItemsCtx.filed = undefined
  try {
    const views = viewRows.views()
    // first what each view needs, so the judging below reads the cap and any
    // answer the registration took
    for (const [slot, rows] of views) {
      const read = viewReads.get(slot)
      if (!read?.delays) {
        ownerLoads.release(slot)
        continue
      }
      const needs = new Map<string, { org: string; owner: string; cards: number }>()
      for (const row of rows.values()) {
        if (uuidToKey.has(row.id)) continue
        // a row the view draws no card for needs no verdict; the person's
        // new task, which its answer does not hold yet, draws one
        if (read.judged && !read.judged.has(row.id) && viewRows.answered(slot, row.id)) continue
        // a card whose verdict reads its owner's load registers the owner,
        // where its project shows delays
        const owner = taskOwnerId(row, row.has_subtasks)
        if (
          !owner ||
          PLANNER.project(row.project_id)?.trackDelay === false ||
          !needsLoad(row, viewDelayCtx.capacity)
        )
          continue
        const key = `${row.org_id}:${owner}`
        const need = needs.get(key) ?? { org: row.org_id, owner, cards: 0 }
        need.cards++
        needs.set(key, need)
      }
      // a view whose read stops keeps its owners' loads, without reading them
      slotDelayOwners.set(slot, [...needs.values()])
      registerViewOwners(slot, read.want !== null)
    }
    for (const slot of viewReads.keys()) if (!views.has(slot)) ownerLoads.release(slot)
    // each owner's load is built once for every card that reads it
    viewDelayCtx.memo = new Map()
    viewDelayCtx.filed = undefined
    const delays = new Map<string, DelayInfo | typeof DELAY_UNKNOWN | null>()
    for (const [slot, rows] of views) {
      if (!viewReads.get(slot)?.delays) continue
      for (const row of rows.values())
        if (!uuidToKey.has(row.id) && !delays.has(row.id))
          delays.set(row.id, viewDelay(row, viewDelayCtx))
    }
    viewDelays = delays
    viewDelayCtx.memo = undefined
    viewDelayCtx.filed = undefined
    const changed = viewRows.reshape((uuid) => uuidToKey.has(uuid), {
      handleNow: PLANNER.handleNow,
      // a card of a create on its way renders again once the server took
      // it, as its owner list waits until then (P.createOnItsWay)
      extra: (uuid) =>
        JSON.stringify(delays.get(uuid) ?? null) + (createOnItsWay(uuid) ? ' creating' : ''),
      grid: PLANNER.gridEpoch,
      // a handle two models share names the person's new task on its way
      wins: (uuid) => {
        const pending = pendingCreates.get(uuid)
        return !!pending && !holdsIn(uuid, pending.org)
      },
    })
    if (changed) boardLookup = null
    return changed
  } finally {
    reshaping = false
  }
}

/* The tasks a Board looks up by handle (P.boardTasksById): the workspace's
   own map while no view holds a task it lacks, else both, built once per
   change of either. */
let boardLookup: { base: Record<string, IssueVM>; map: Record<string, IssueVM> } | null = null

/* Which person the store's owner-load cache asks as, by organization: a
   staff seat reads up to CALL_OWNERS owners a call, a guest or Viewer one. */
const ownerLoads = createOwnerLoadCache({
  // read at each call, so a module that never asks for a load needs no
  // live transport
  live: {
    watch: (ref, args) => live.watch(ref, args),
    read: (token) => live.read(token),
    onTransition: (fn, options) => live.onTransition(fn, options),
  },
  staffIn: (org) => {
    const me = rows.profiles.get(myProfiles.get(org) ?? '')
    return me?.org_role === 'admin' || me?.org_role === 'user'
  },
  changed: () => {
    // the window's chip reads the cache too, and shows with the comments
    if (windowLoad) windowLoadNews = true
    if (reshaping) return
    viewReadsChanged = true
    // the window's registration runs inside a repaint, after which the
    // views judge their cards again, as a card of the same owner a cap
    // left unread is read now
    if (windowLoadSyncing) {
      owed.view = true
      payTimer ??= setTimeout(pay, 0)
      return
    }
    owe('view')
  },
  watchVisibility,
})

/** Paints `view` over the rows on screen, the moment its write is sent, and
    shows the change. A thread part shows only while its task is watched,
    and a detail part only while its task is watched, over the painted
    answer as it shows, or with every layer from its anchor when that
    changed since. */
function showPaint(view: View) {
  const thread = view.thread && view.thread.task === watchedComments ? view.thread : null
  const detail = view.detail && view.detail.task === watchedComments ? view.detail : null
  workspaceRows.paint(() => {
    view.workspace?.()
    thread?.paint()
    view.view?.()
    view.milestones?.()
  })
  // over the painted answer as it shows, or with every layer again when its
  // anchor changed or it is the anchor itself, which no paint may change
  if (detail) {
    if (detailRows.from !== okAnswer() || detailRows.task === detailRows.from) paintDetail()
    else if (detailRows.task) detail.paint()
  }
  if (view.workspace) {
    rebuild()
    reshapeViews()
    emit()
  } else {
    if (thread || detail) {
      if (thread) rebuildComments()
      if (detail) rebuildSections()
      emit('comments')
    }
    if (view.view || view.milestones) {
      reshapeViews()
      emit('views')
    }
  }
}

/* Who hears that tasks' handles moved (P.watchHandles). */
const handleWatchers = new Set<(moved: ReadonlyMap<string, string>) => void>()

/* The handles the last rebuild moved, old to new (store/taskIndex.ts). */
let lastMoves: ReadonlyMap<string, string> = new Map()

/** Tells P.watchHandles' listeners, once per repaint, every task whose
    handle the repaint moved, as one map from the old handle to the new. A
    new task's preview number moves when another person's create takes it
    while the write waits, and again when the server's answer fixes it. A
    change of the home organization moves the handles of the old and the
    new home organization's tasks, held or not (withUnheldMoves).
    Taken together, two creates that both move cannot make a caller follow
    the wrong one. */
function moveHandles(moved: ReadonlyMap<string, string>) {
  if (moved.size) for (const watcher of handleWatchers) watcher(moved)
}

/** What a write is about when its args do not say (describeWrite): the
    task it concerns, or that the person did not make the change, such as the
    read that opening a task sends, which the notice does not count and the
    crash note leaves out. */
type WriteAbout = {
  task?: string
  background?: boolean
  /** a write whose task, or other end, comes from a server answer rather
      than the workspace: the task the window shows from its own answer
      (answerTaskOf), a task a relation picker offered or a row of the
      window's Subtasks or Linked tasks that the workspace does not hold,
      or a task only a view's answer holds (updateViewTask), so the guard
      against task writes before every task is asked lets it through
      (guardTaskWrite) */
  answer?: true
}

/** How send() and sendAwaited() treat a write's answer. */
type SendOptions<R> = {
  /** The view the accepted write keeps, from its result: undefined keeps the
      sent one, null keeps nothing, for a write the server made no change
      with. A view it returns is painted at once while no delivery holds it. */
  keep?: (result: R) => View | null | undefined
  /** Runs on acceptance after keep. It may change captured data or the
      comment anchors, never rows. */
  onOk?: (result: R) => void
  /** Runs on a refusal or a pause while the paint is still on screen.
      send() toasts by default (toastWriteError); sendAwaited() does not. */
  onError?: (error: unknown) => void
  /** Runs last, after either answer or a pause. */
  onSettled?: () => void
  /** A pause refuses the write without onError, for a write the person did
      not ask for. */
  quietPause?: boolean
  about?: WriteAbout
  /** The values the write paints over (Over), which go out as its
      `expected` (expectedOf). */
  over?: Over
  /** How the notice of a field_changed refusal reads (store/fieldNotice.ts):
      a delete, a Roadmap batch of this many changes, or a settings field's
      kept draft, which saves again only after Keep mine. */
  notice?: { deletes?: boolean; batch?: number; keepMine?: boolean }
  /** Runs on a field_changed refusal once the paint has gone, for an
      editor that keeps the person's draft, with the value of the write's
      first `over` field now on screen and who wrote the value the server
      keeps (refusalWriter). It answers false when the editor has moved on
      and keeps nothing, and true when it keeps the draft, which the notice
      that shows after it then says. */
  keepDraft?: (shown: unknown, by: Writer) => boolean
  /** Runs when the sent write fails for any other reason, after its toast,
      for an editor that then keeps the draft unsaved against the text it
      began from: a refusal from the server, such as a description whose
      image it refuses, or an error, such as a server fault. */
  keepUnsaved?: () => void
}

/** What a write shows: a view, an open layer it was collected in (a Roadmap
    batch), or nothing until it is accepted. */
type Target = View | Layer | 'none'

/** Sends write `m` with its own layer for `target` and resolves whether the
    server accepted it. Never rejects. A paused write paints nothing and
    sends nothing, and a refusal takes away only this write's paint. */
function send<M extends FunctionReference<'mutation'>>(
  m: M,
  args: FunctionArgs<M>,
  target: Target,
  options: SendOptions<FunctionReturnType<M>> = {},
): Promise<boolean> {
  return start(
    m,
    args,
    target,
    options,
    false,
    () => true,
    () => false,
  )
}

/** send(), resolving with the server's answer and rejecting with its
    refusal (or the pause), without a toast unless `onError` makes one. */
function sendAwaited<M extends FunctionReference<'mutation'>>(
  m: M,
  args: FunctionArgs<M>,
  target: Target,
  options: SendOptions<FunctionReturnType<M>> = {},
): Promise<FunctionReturnType<M>> {
  return start(
    m,
    args,
    target,
    options,
    true,
    (result) => result,
    (error) => {
      throw error
    },
  )
}

/* The task writes beside api.issues.*: they need a task the workspace
   holds as much (guardTaskWrite). */
const TASK_WRITES = new Set([
  getFunctionName(api.labels.toggle),
  getFunctionName(api.files.attach),
  getFunctionName(api.files.removeAttachment),
  getFunctionName(api.roadmap.change),
  getFunctionName(api.roadmap.undo),
])
/* A create of a task of its own (P.addIssue) needs no task the workspace
   holds: in a store that never asked for every task it paints the views'
   rows and the new task's window, never the workspace's task rows
   (newTaskParts). P.createParent and P.createLinked write on an existing
   task too, so they take the rule of every other task write. */
const CREATE = getFunctionName(api.issues.create)
/* A restore paints nothing in the workspace and needs no task. */
const RESTORE = getFunctionName(api.issues.unarchive)

/* The Roadmap's writes. An undo restores what the server's journal holds
   and paints nothing, so it needs no task the workspace holds; a change
   needs one only for a task operation. */
const ROADMAP_UNDO = getFunctionName(api.roadmap.undo)
const ROADMAP_CHANGE = getFunctionName(api.roadmap.change)

/** Test builds only (STRICT_LAYERS): a task write that goes out before the
    store asked for every task is a fault, unless a server answer names
    its task (WriteAbout.answer) or it is a restore. So a write from a held
    task's path, which only a store that holds every task can take, never
    goes out while tasks are not asked. A create of a task of its own
    passes by its name (CREATE), and so does the Roadmap's undo, and a
    Roadmap change with no task operation, such as a milestone's, passes
    too. */
function guardTaskWrite(name: string, about: WriteAbout | undefined, args?: unknown) {
  if (asked) return
  if (!name.startsWith('issues:') && !TASK_WRITES.has(name)) return
  if (about?.answer || name === CREATE || name === RESTORE || name === ROADMAP_UNDO) return
  const operations = (args as { operations?: { kind: string }[] } | undefined)?.operations
  if (name === ROADMAP_CHANGE && !(operations ?? []).some((op) => op.kind === 'task')) return
  reportFault(
    new Error(
      `${name} went out before the store asked for every task: mark a write whose task comes from a server answer (WriteAbout.answer)`,
    ),
  )
}

/* send() and sendAwaited(): the pause first, then the layer and its paint,
   then dispatch, and one handler per answer (settleAccepted, settleRefused)
   that ends in `answer` or `refusal`, so a write costs its caller one step
   after the server's answer. */
function start<M extends FunctionReference<'mutation'>, T>(
  m: M,
  args: FunctionArgs<M>,
  target: Target,
  o: SendOptions<FunctionReturnType<M>>,
  awaited: boolean,
  answer: (result: FunctionReturnType<M>) => T,
  refusal: (error: unknown) => T,
): Promise<T> {
  const name = getFunctionName(m)
  if (STRICT_LAYERS) guardTaskWrite(name, o.about, args)
  const batch = target !== 'none' && 'id' in target ? target : null
  const paused =
    DEMO_MODE && demoDisposed
      ? new ConvexError({ code: 'forbidden', message: 'Your demo has expired.' })
      : isPausedWrite(name)
        ? new ConvexError({ code: 'paused', message: pausedText(name) })
        : null
  if (paused) {
    // a paused write creates no layer; a batch that painted already goes
    if (batch) {
      const had = batch.view
      layers.remove(batch)
      if (paints(had))
        repaint({
          workspace: !!had.workspace,
          thread: !!had.thread,
          view: !!had.view || !!had.milestones,
          sections: !!had.detail,
        })
    }
    const quiet = o.quietPause && errData(paused).code === 'paused'
    if (!quiet) (o.onError ?? (awaited ? undefined : (e) => toastWriteError(e, !!batch)))?.(paused)
    o.onSettled?.()
    return new Promise<T>((resolve) => resolve(refusal(paused)))
  }
  const view: View = target === 'none' || 'id' in target ? {} : target
  const layer = batch ?? layers.open(name, view, o.over)
  // read before the paint, which may drop a hidden parent
  const sentArgs = o.over ? ({ ...args, expected: expectedOf(o.over) } as FunctionArgs<M>) : args
  layers.send(layer, deliveryCounters())
  if (!batch) {
    try {
      showPaint(layer.view)
    } catch (fault) {
      // a paint that throws is a defect: the write goes nowhere, and says so
      reportFault(fault)
      settleRefused(layer)
      ;(o.onError ?? (awaited ? undefined : (e) => toastWriteError(e, false)))?.(fault)
      o.onSettled?.()
      return new Promise<T>((resolve) => resolve(refusal(fault)))
    }
  }
  const epoch = storeEpoch
  const releaseUpdate = beginUpdateBlock()
  // an accepted task content write ends the Roadmap's undo history
  const visit = roadmapVisit
  const clearsHistory = !!visit && !visit.disabled && isTaskContentWrite(name)
  let sent: Promise<FunctionReturnType<M>>
  try {
    sent = dispatch(m, sentArgs, o.about)
  } catch (error) {
    sent = Promise.reject(error)
  }
  showWaiting()
  return sent.then(
    (result) => {
      releaseUpdate()
      if (epoch === storeEpoch) {
        // a callback that throws still leaves the layer settled
        let next: View | null | undefined
        guarded(() => {
          next = o.keep?.(result)
          o.onOk?.(result)
        })
        // the history's end and the settle show in one render
        guarded(() =>
          together(() => {
            if (clearsHistory) clearRoadmapHistory(visit)
            settleAccepted(layer, next)
          }),
        )
        guarded(() => o.onSettled?.())
        guarded(showWaiting)
      } else if (clearsHistory) clearRoadmapHistory(visit)
      return answer(result)
    },
    (error) => {
      releaseUpdate()
      if (epoch === storeEpoch) {
        console.error('[qivo] write failed:', error)
        const painted = paints(layer.view)
        // a write sent behind a create the server refused says nothing
        // more than the create's own refusal (refusedBehind)
        const quiet = refusedBehind(o.about, args)
        const onError = quiet
          ? undefined
          : (o.onError ?? (awaited ? undefined : (e) => toastWriteError(e, painted)))
        if (error instanceof ConvexError && errData(error).reason === FIELD_CHANGED) {
          // the paint goes first, so a kept draft rebases on the text the
          // server keeps and the notice says whether the draft stayed
          guarded(() => settleRefused(layer))
          let kept = false
          const by = refusalWriter(errData(error).changes ?? [], fieldLookup)
          if (o.keepDraft) guarded(() => (kept = o.keepDraft?.(shownOf(o.over), by) !== false))
          fieldRefusals.set(error, { layer, kept, ...o.notice })
          guarded(() => onError?.(error))
        } else {
          guarded(() => onError?.(error))
          guarded(() => settleRefused(layer))
          guarded(() => countAfterRefusal(error))
          // a refused or failed draft stays, unsaved, rather than reading as
          // saved and giving way to the stored text once its editor blurs
          if (o.keepUnsaved) guarded(() => o.keepUnsaved?.())
        }
        guarded(() => o.onSettled?.())
        guarded(showWaiting)
      }
      return refusal(error)
    },
  )
}

/** After a comment, or an archive with a reason, refused while the server
    counts the task's comments (convex/lib/limits.ts COMMENTS_COUNTING),
    asks it to start that count (comments.countThread), which the refusal
    could not keep, so a later try can pass. The person's draft stays with
    its own toast; a count that does not start is only logged. */
function countAfterRefusal(error: unknown) {
  const d = errData(error)
  if (d.reason !== COMMENTS_COUNTING || d.task_id === undefined) return
  // also a task the window shows from its answer (orgOfTask)
  const org = orgOfTask(d.task_id)
  if (!org) return
  void send(api.comments.countThread, { org_id: org, issue_id: d.task_id }, 'none', {
    about: { background: true },
    quietPause: true,
    onError: (e) => console.error("[qivo] a task's comment count did not start:", e),
  })
}

/** Keeps the parts of accepted `layer` that no live delivery is known to
    hold yet, with `next` from its keep. A dropped part paints the delivery
    that holds it (owe); a part keep changed paints at once. */
function settleAccepted(layer: Layer, next: View | null | undefined) {
  const sent = layer.view
  const view = next === null ? {} : (next ?? sent)
  const held = snapshotCurrent && snapshotDeliveries > layer.seen.snapshot
  const workspace = view.workspace && !held ? view.workspace : undefined
  const thread =
    view.thread &&
    !(threadCurrent && watchedComments === view.thread.task && threadDeliveries > layer.seen.thread)
      ? view.thread
      : undefined
  // every read whose rows hold a task the write changed, live and current
  // with a delivery since the send, holds it, as the snapshot does
  // (viewPartHeld); with no such rows left, as after the view closed, it
  // paints nothing and no delivery would ever end it
  const viewPart = view.view && !viewPartHeld(view.view, layer.seen.view) ? view.view : undefined
  // the watched task's own answer holds its part as the thread holds its
  // own (detailPartHeld)
  const detail =
    view.detail && !detailPartHeld(view.detail.task, layer.seen.detail) ? view.detail : undefined
  // every milestone read whose answer holds what the write changed holds
  // it, as the views' reads do, and the part paints only the reads that
  // have not (milestoneNeeds)
  const needs =
    view.milestones && milestoneNeeds(view.milestones, layer.seen.milestones, savedMilestoneParts())
  const milestones =
    view.milestones && needs?.size ? scopedMilestonePaint(view.milestones, needs) : undefined
  layers.save(layer, { workspace, thread, view: viewPart, detail, milestones })
  // while it waited, the write had a stopped or behind view's row of its
  // task stand in for the owner-load cache (viewDelayCtx); answered, it
  // does no more, so the work filed from the rows goes and the views judge
  // their delays again
  if (sent.view && lentWhileWaiting(sent.view)) {
    ownerItemsCtx.filed = undefined
    viewReadsChanged = true
    owed.view = true
  }
  if (sent.workspace && !workspace) owed.workspace = true
  if (sent.thread && !thread && sent.thread.task === watchedComments) owed.thread = true
  if (sent.view && !viewPart) {
    owed.view = true
    // the views show again without its unsure mark, though no row changed
    if (unsentText.has(sent.view)) viewReadsChanged = true
  }
  if (sent.detail && !detail && sent.detail.task === watchedComments) owed.sections = true
  // the milestone reads repaint with the views, the reads the part no
  // longer paints from their own answers
  if (sent.milestones) {
    owed.view = true
    viewReadsChanged = true
  }
  // a view keep gave paints now, unless a delivery holds it already
  const now = {
    workspace: !!next && !!workspace,
    thread: !!next && !!thread && thread.task === watchedComments,
    view: !!next && (!!viewPart || !!milestones),
    sections: !!next && !!detail && detail.task === watchedComments,
  }
  if (now.workspace || now.thread || now.view || now.sections) repaint(now)
  if (!owed.workspace && !owed.thread && !owed.view && !owed.sections) return
  if (!layers.paintedPending()) pay()
  else payTimer ??= setTimeout(pay, 0)
}

/** Whether the watched task's own answer holds the saved detail part of a
    write on task `task` sent when its deliveries counted `seen`: a live
    good delivery since the send on the newest connection (detailCurrent),
    as threadCurrent decides for the thread. A part whose task's answer the
    store no longer holds, as after its window closed or the workspace came
    to hold the task, paints nothing, and no delivery would ever end it. */
function detailPartHeld(task: string, seen: number): boolean {
  const answer = sectionAnswers.issue === task ? sectionAnswers.task : null
  if (watchedComments !== task || answer === null || answer === CREATING) return true
  return detailCurrent() && detailDeliveries > seen
}

/** Takes refused `layer` away and paints the rows without it, with
    anything owed. */
function settleRefused(layer: Layer) {
  const had = layer.view
  layers.remove(layer)
  // the views show again without its unsure mark, though no row changed
  if (had.view && unsentText.has(had.view)) viewReadsChanged = true
  // a milestone read shows its answer again, which the views' repaint shows
  if (had.milestones) viewReadsChanged = true
  if (paints(had)) {
    repaint({
      workspace: !!had.workspace || owed.workspace,
      thread: (!!had.thread && had.thread.task === watchedComments) || owed.thread,
      view: !!had.view || !!had.milestones || owed.view,
      sections: (!!had.detail && had.detail.task === watchedComments) || owed.sections,
    })
  } else if (
    (owed.workspace || owed.thread || owed.view || owed.sections) &&
    !layers.paintedPending()
  )
    pay()
}

/* Test builds only (STRICT_LAYERS): before every emit, the rows on screen,
   the watched task's painted answer among them, must be exactly the
   anchors with every live layer painted over them, and
   painting every layer once more with the clock an hour ahead must change
   nothing but server stamps, and write no time it read from the clock (the
   paint rules in store/layers.ts). Skipped while a part is owed, while a
   delivery waits to be painted (its apply cannot be put back) or before the
   first load. Leaves the rows as they were. */
let checkingLayers = false
/* Whether the test-only checks (checkLayers, checkTasks) are off, while a
   test measures what a step costs as it would outside tests. */
let unchecked = false
function checkLayers() {
  if (
    unchecked ||
    checkingLayers ||
    owed.workspace ||
    owed.thread ||
    owed.view ||
    owed.sections ||
    !PLANNER.loaded ||
    !hasSnapshot ||
    base.staging()
  )
    return
  checkingLayers = true
  const saved = workspaceRows.save()
  const savedViews = viewRows.save()
  const savedMilestones = milestoneRows.save()
  const thread = { comments: rows.comments, threadEvents: rows.threadEvents }
  const detail = detailRows
  const counters = { hiddenReadMessages, unexaminedUnread, unexaminedRead, messagesCut }
  try {
    const shown = canonicalRows()
    paintRows(true, true, true, true)
    const outside = firstDifference(shown, canonicalRows())
    if (outside) throw new Error(`rows changed outside a layer: ${outside}`)
    const built = canonicalRows(true)
    const ahead = withClockAhead(() =>
      workspaceRows.paint(() => {
        for (const layer of layers.ordered()) {
          layer.view.workspace?.()
          const part = layer.view.thread
          if (part && part.task === watchedComments) part.paint()
          layer.view.view?.()
          layer.view.milestones?.()
          const own = layer.view.detail
          if (own && own.task === watchedComments && detailRows.task) own.paint()
        }
      }),
    )
    // the shifted clock answers one instant, so a time read from it shows as that
    const marks = [new Date(ahead).toISOString(), String(ahead)]
    const read = Object.entries(canonicalRows()).find(([, json]) =>
      marks.some((mark) => json.includes(mark)),
    )
    if (read) throw new Error(`a paint read the clock: ${read[0]}`)
    const changed = firstDifference(built, canonicalRows(true))
    if (changed) throw new Error(`a paint is not safe to run again: ${changed}`)
  } finally {
    workspaceRows.restore(saved)
    viewRows.restore(savedViews)
    milestoneRows.restore(savedMilestones)
    detailRows = detail
    Object.assign(rows, thread)
    ;({ hiddenReadMessages, unexaminedUnread, unexaminedRead, messagesCut } = counters)
    checkingLayers = false
  }
}

/* The row fields the server stamps with its own clock. The paint stamps
   them with the browser's, and one painted again over its own result, or
   over the paints after it, may leave one at another time it captured.
   Whether one is set still counts. */
const SERVER_STAMPS = new Set([
  'created_at',
  'updated_at',
  'status_at',
  'done_at',
  'review_at',
  'remaining_set_at',
  'edited_at',
  'read_at',
  'archived_at',
  'sync_at',
])
/* Snapshot fields that only feed a set of tasks (the base's flags,
   store/workspaceBase.ts, and subtaskParentsNow), where false means the
   same as absent. */
const SET_FLAGS = new Set(['has_subtasks', 'has_hidden_subtasks', 'has_hidden_parent'])

/** Every row section and inbox counter in one canonical form: map entries,
    set members and array items sorted, object keys sorted and undefined
    fields left out, each section as JSON. With `noStamps` a server stamp
    shows only that it is set. */
function canonicalRows(noStamps = false): Record<string, string> {
  const norm = (value: unknown): unknown => {
    if (value instanceof Map || value instanceof RowMap)
      return [...value.entries()].map(([key, item]) => [String(key), norm(item)]).sort()
    if (value instanceof Set) return [...value].map(String).sort()
    if (Array.isArray(value)) return value.map((item) => JSON.stringify(norm(item))).sort()
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, item]) => item !== undefined && !(SET_FLAGS.has(key) && item === false))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, item]) => [key, noStamps && SERVER_STAMPS.has(key) ? 'stamp' : norm(item)]),
      )
    return value
  }
  const out: Record<string, string> = {}
  for (const [section, value] of Object.entries(rows)) out[section] = JSON.stringify(norm(value))
  out.counters = JSON.stringify([hiddenReadMessages, unexaminedUnread, unexaminedRead, messagesCut])
  for (const [slot, value] of viewRows.views()) out[`view:${slot}`] = JSON.stringify(norm(value))
  // each milestone read's rows in their order, which a paint keeps
  for (const [slot, value] of milestoneRows.views())
    out[`milestones:${slot}`] = JSON.stringify([value.rows.map((row) => norm(row)), value.past])
  // the watched task's own answer, painted, as the window reads it
  const detail = paintedAnswer()
  if (detail) out.detail = JSON.stringify(norm(detail))
  return out
}

/** The first section that differs between two canonical forms, with where,
    or null. */
function firstDifference(a: Record<string, string>, b: Record<string, string>): string | null {
  for (const section of Object.keys(a)) {
    const x = a[section]
    const y = b[section]
    if (x === y) continue
    let at = 0
    while (at < x.length && x[at] === y[at]) at++
    return `${section} at …${x.slice(Math.max(0, at - 60), at + 60)}… versus …${y.slice(Math.max(0, at - 60), at + 60)}…`
  }
  return null
}

/** Runs `paint` with Date and Date.now an hour ahead, and answers that
    time. */
function withClockAhead(paint: () => void): number {
  const RealDate = Date
  const ahead = RealDate.now() + 3_600_000
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) =>
      args.length ? Reflect.construct(target, args) : new target(ahead),
    get: (target, prop, receiver) =>
      prop === 'now' ? () => ahead : Reflect.get(target, prop, receiver),
  })
  try {
    paint()
  } finally {
    globalThis.Date = RealDate
  }
  return ahead
}

/* In tests, the writes sent with the mark of a write from a server answer
   (WriteAbout.answer), by name, in order, for __layerProbe. */
const answerMarked: string[] = []

/** Test builds only: breaks the layer rules on purpose, so a test sees
    checkLayers catch it (layerGuard.test.ts). */
export const __layerProbe = STRICT_LAYERS
  ? {
      /** The writes sent since the last call with the mark of a write
          from a server answer (WriteAbout.answer), by name, in order. */
      answerMarks: () => answerMarked.splice(0),
      /** The rows in canonical form, without server stamps when `noStamps`,
          and how many layers are live. */
      rows: (noStamps = false) => canonicalRows(noStamps),
      layerCount: () => layers.ordered().length,
      /** The parts each live layer paints, in order. */
      layerParts: () =>
        layers
          .ordered()
          .map((layer) =>
            (Object.keys(layer.view) as (keyof View)[]).filter((part) => !!layer.view[part]),
          ),
      /** How many rows the paints have copied so far (store/rowMap.ts). */
      rowCopies,
      /** The spans of owner `owner`'s tasks the workspace holds, as the
          views' delays take them (store/viewDelay.ts heldSpans). */
      shownSpans: (owner: string) => tasks.shownSpans(owner),
      /** Owner `owner` of organization `org`'s work as Team utilization and
          the planning panel spread it from cache answer `load`, reconciled
          with the rows this person holds (store/viewDelay.ts ownerItemsOf,
          P.ownerItems), for the parity of a cache the test feeds itself. */
      ownerItems: (org: string, owner: string, load: Extract<OwnerLoad, { state: 'ok' }>) => {
        ownerItemsCtx.filed = undefined
        return ownerItemsOf(org, owner, load, ownerItemsCtx)
      },
      /** Turns the test-only checks, which rebuild and walk every row,
          off or back on, so a test can count what a step costs. */
      uncheck(off: boolean) {
        unchecked = off
      },
      /** The faults the store caught and reported, and forgets them. */
      faults: () => faults.splice(0),
      /** Runs the guard against task writes before the ask
          (guardTaskWrite) on write `name` with mark `about` and arguments
          `args`, as start() does, and answers the faults it reported. */
      guardWrite(name: string, about?: WriteAbout, args?: unknown) {
        const before = faults.length
        guardTaskWrite(name, about, args)
        return faults.splice(before)
      },
      /** The reasons P.askTasks was called with since the last call, in
          order. */
      asks: () => askReasons.splice(0),
      /** Changes a task's title outside any layer and emits. The title
          changes in a painted copy, since the server's rows are frozen
          (writeServerRow). */
      writeOutside() {
        const id = rows.issues.keys().next().value
        let issue: Row<'issues'> | undefined
        // a pass that changes nothing, which leaves a copy to change
        workspaceRows.paint(() => {
          issue = id === undefined ? undefined : rows.issues.get(id)
        })
        if (issue) issue.title = `${issue.title}!`
        emit()
      },
      /** Writes into one of the server's rows outside any paint, which
          throws. */
      writeServerRow() {
        const issue = rows.issues.values().next().value
        if (issue) issue.title = `${issue.title}!`
      },
      /** Changes a task's view model behind the task index and rebuilds,
          which the full-rebuild check (checkTasks) refuses. */
      corruptTask() {
        const task = tasks.issues()[0]
        if (task) task.title = `${task.title}!`
        rebuild()
      },
      /** Paints task rows `issues` into the workspace's rows with no write
          and no ask, the state of a store that holds some tasks before it
          holds every task, which the app never reaches while not asked,
          since a create paints no task row of the workspace there
          (newTaskParts). The layer stays until the store resets. */
      plantTasks(issues: readonly Row<'issues'>[]) {
        const paints = issues.map((row) => newTaskPaint(row, { num: null }))
        const layer = layers.open('probe', {
          workspace: () => {
            for (const paint of paints) paint()
          },
        })
        layers.send(layer, deliveryCounters())
        showPaint(layer.view)
      },
      /** Paints a layer that reads the clock, which emits. */
      paintClock() {
        const layer = layers.open('probe', {
          workspace: () => {
            const issue = rows.issues.values().next().value
            if (issue) issue.updated_at = new Date().toISOString()
          },
        })
        layers.send(layer, deliveryCounters())
        showPaint(layer.view)
      },
    }
  : null

/** Starts a layer that covers several writes, such as the rows a bulk inbox
    action reaches before its batches name them, and paints it. A paint
    that throws takes its layer away again and passes the throw on. */
function openUmbrella(name: string, view: View): Layer {
  const layer = layers.open(name, view)
  layers.send(layer, deliveryCounters())
  try {
    showPaint(view)
  } catch (fault) {
    settleRefused(layer)
    throw fault
  }
  return layer
}

/** Ends umbrella `layer`: with `save` as an accepted write, which stays
    until a live delivery holds it (settleAccepted), otherwise its paint goes
    now. */
function endUmbrella(layer: Layer, save: boolean) {
  if (!layers.has(layer)) return
  if (save) settleAccepted(layer, undefined)
  else settleRefused(layer)
}

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
/* The operations batchRoadmapChanges collects, the answers waiting for their
   one submission, and the one layer their paints go into. */
let roadmapBatch: {
  operations: RoadmapOperation[]
  saved: ((ok: boolean) => void)[]
  layer: Layer
} | null = null

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
  // inside together(), with the repaint at its end
  if (heldRepaint) heldRepaint.emit = true
  else emit()
}

function expireRoadmapHistory() {
  if (roadmapVisit && !roadmapVisit.disabled && Date.now() >= roadmapVisit.expiresAt) {
    clearRoadmapHistory(roadmapVisit)
    toast('Roadmap undo history expired. Leave Roadmap and return to start a new history.', 'info')
  }
}

/* Sends operations to the visit's journal with `target`'s paint. Resolves
   whether the server accepted them; a refusal is toasted and takes the
   paint away. A clamped or rounded no-op emits no snapshot, so its paint
   goes at once (keep), even during trouble: the server changed nothing, so
   the values last delivered are right. */
function submitRoadmapChanges(
  operations: RoadmapOperation[],
  target: View | Layer,
  keepDraft?: SendOptions<unknown>['keepDraft'],
): Promise<boolean> {
  const visit = roadmapVisit
  if (!visit || !operations.length) {
    // a batch whose visit ended before its write went out paints no more
    if ('id' in target) settleRefused(target)
    return Promise.resolve(!operations.length)
  }
  visit.pending++
  const answer = send(api.roadmap.change, { session_id: visit.id, operations }, target, {
    ...roadmapAbout(operations),
    notice: { batch: operations.length },
    keepDraft,
    keep: (result) => (result.count <= visit.count ? null : undefined),
    onOk: (result) => {
      if (roadmapVisit === visit && !visit.disabled)
        visit.count = Math.max(visit.count, result.count)
    },
    onSettled: () => {
      visit.pending--
      emit()
    },
  })
  emit()
  return answer
}

/* What a Roadmap write is about for the guard against task writes before
   every task is asked (guardTaskWrite): a task operation whose task the
   workspace does not hold comes from a server answer, a Roadmap row or the
   dependency answer, and marks the write, naming the task when it is the
   only one. */
function roadmapAbout(operations: readonly RoadmapOperation[]): { about?: WriteAbout } {
  const unheld = operations.filter((op) => op.kind === 'task' && !rows.issues.has(op.id))
  if (unheld.length === 0) return {}
  const only = operations.length === 1 ? unheld[0] : undefined
  return { about: { ...(only ? { task: only.id } : {}), answer: true } }
}

/* Records an operation in the open Roadmap visit's journal with `view`, its
   paint, in the open batch when there is one. `over` holds the values on
   screen it changes, read now, after the paints of the batch's earlier
   operations, and goes with the operation as its `expected`. `keepDraft`
   is an editor's, for an operation sent on its own (SendOptions). Returns
   null when no visit records it, so the caller sends it directly, or else
   the server's answer.

   A batch folds each operation's `workspace`, `view` and `milestones`
   paints into its one layer (foldPaints), the `view` ones registered with
   the tasks they change (viewPaint), so an Auto-move over tasks only the
   Roadmap's answer holds stays painted until a delivery holds it, and one
   refusal takes the whole batch away. A `detail` paint never folds: a
   batch never runs while a task window is open (batchRoadmapChanges). */
function recordRoadmapChange(
  change: RoadmapOperation,
  view: View,
  over?: Over,
  keepDraft?: SendOptions<unknown>['keepDraft'],
): Promise<boolean> | null {
  expireRoadmapHistory()
  if (!roadmapVisit || roadmapVisit.disabled || roadmapDetailOpen) return null
  const operation = over ? ({ ...change, expected: expectedOf(over) } as RoadmapOperation) : change
  const batch = roadmapBatch
  if (!batch) return submitRoadmapChanges([operation], view, keepDraft)
  batch.operations.push(operation)
  const had = batch.layer.view
  let viewPart = had.view || view.view ? foldPaints(had.view, view.view) : undefined
  if (had.view && view.view) {
    // the tasks the folded paint changes: every part's, or none known when
    // a part named none, which every read with rows then holds
    const known = [had.view, view.view].map((part) => viewPaintTasks.get(part))
    if (known.every((tasks) => tasks !== undefined))
      viewPart = viewPaint(
        known.flatMap((tasks) => [...(tasks ?? [])]),
        viewPart,
      )
  }
  batch.layer.view = {
    ...(had.workspace || view.workspace
      ? { workspace: foldPaints(had.workspace, view.workspace) }
      : {}),
    ...(viewPart ? { view: viewPart } : {}),
    ...(had.milestones || view.milestones
      ? { milestones: foldPaints(had.milestones, view.milestones) }
      : {}),
  }
  // only the parts the layer holds show, so none stays without its layer
  showPaint({
    ...(view.workspace ? { workspace: view.workspace } : {}),
    ...(view.view ? { view: view.view } : {}),
    ...(view.milestones ? { milestones: view.milestones } : {}),
  })
  return new Promise((resolve) => batch.saved.push(resolve))
}

/** One paint that runs `before` and then `after`, for a Roadmap batch's
    layer, which holds the paints of all its operations. A milestone part
    carries what both change (milestoneNeeds). */
function foldPaints(before: Paint | undefined, after: Paint | undefined): Paint {
  if (!before || !after) return (before ?? after) as Paint
  const paint = () => {
    before()
    after()
  }
  const a = milestonePaintMarks.get(before)
  const b = milestonePaintMarks.get(after)
  if (a || b)
    milestonePaintMarks.set(paint, {
      ids: [...(a?.ids ?? []), ...(b?.ids ?? [])],
      projects: [...(a?.projects ?? []), ...(b?.projects ?? [])],
      rows: [...(a?.rows ?? []), ...(b?.rows ?? [])],
    })
  return paint
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
type ErrData = {
  code?: string
  message?: string
  reason?: string
  changes?: FieldChange[]
  task_id?: string
}
const errData = (e: unknown): ErrData => (e instanceof ConvexError ? (e.data as ErrData) || {} : {})
/** Refusals that mean the whole organization is read-only. Their sentences
   name the reason, and for a pending deletion its date, so they show verbatim. */
const readOnly = (d: ErrData) =>
  d.reason === 'billing_required' || d.reason === 'deletion_scheduled'
/** Refusals of a new first day of the week, which Organization settings
   shows beside the setting (setOrg). */
const weekStartRefusal = (d: ErrData) =>
  d.reason === WEEK_START_REFUSALS.conflicts || d.reason === WEEK_START_REFUSALS.unchecked
/* asSentence (lib/fieldLimits.ts sentence) shows a refusal message
   capitalized and ending with a period. Server messages are often lowercase
   fragments, and a toast joins them with a sentence of its own. A limit's
   refusal reads as the registry writes it (convex/lib/limits.ts), the same
   words REST and MCP answer. */

/* --- snapshot health ---------------------------------------------------------
   The live workspace (store/liveParts.ts) can stop loading mid-session, after
   a part refuses a size it cannot load, a lost sign-in or a faulty deploy.
   It can also come back with no seat when the person loses every seat: an admin
   removed or deactivated them, or their organization's deletion began.
   The last good snapshot stays on screen and the snapshot notice says so.
   While it is stale, edits to shared data pause, because an edit made from
   stale data can overwrite newer work. Every optimistic mutator of shared
   data calls refusePausedEdit() before its paint, and send() refuses any
   other shared write before it paints or is sent, the backstop for a
   mutator that does not check first. Personal state (read marks,
   preferences, appearance, following, favorite projects) still saves,
   and so do the writes
   that only take access away (UNPAUSED_WRITES). Each keeps its layer once
   accepted, until a good delivery holds it, so another write's refusal
   cannot take it off the stale snapshot. Without a seat most of those need
   one too, so only the login's appearance and connected apps still save,
   and signed out nothing saves. Those mutators check the pause before
   their paint as well (refusePausedWrite). Panels that
   call Convex directly (organization deletion and its export record,
   billing) act on their own live queries, not on the snapshot, so they do
   not pause. Convex reruns a failed query when the data it read changes, so
   a later delivery ends the trouble without a reload, a seat made active
   again included.

   While Qivo cannot save at all (lib/syncStatus: offline, or a write that
   takes too long), every write pauses the same way, personal ones included,
   because nothing is saved locally and a change queued until the connection
   returns could overwrite what others changed meanwhile. The writes sent
   before the pause began still go out once the connection is back. The
   snapshot notice says which pause holds, trouble first. */

/** The sentence every paused edit shows. */
export const PAUSED_TEXT = 'Editing is paused until Qivo loads the latest changes.'
/** The sentence a paused edit shows after every seat is gone. */
export const NO_ACCESS_TEXT = 'You no longer have access to this workspace.'
/** The sentence a paused edit shows when the server refused it because the
    organization's deletion has begun, the person's last seat. */
export const ORG_DELETING_TEXT = 'This organization is being deleted.'
/** The sentence a paused edit shows after the sign-in ended. */
export const SIGNED_OUT_TEXT = 'You’re signed out. Reload Qivo to sign in again.'
/** The sentence a paused edit shows while the connection is down, the
    pause notice's own words (lib/noticeText.ts). */
export const OFFLINE_TEXT = pauseSentence('offline')
/** The sentence a paused edit shows while a write takes too long. */
export const SLOW_TEXT = pauseSentence('slow')

/** Why the live snapshot is not current, while it is not. `no_access` means
    a delivery found no seat left, with ORG_DELETING_TEXT as its `reason`
    when the seats went because their organization is being deleted. `asOf`
    is the last good delivery's server time, null before any. `detail` is
    the error text for support, empty for `no_access`. `retrying` holds for
    one RETRY_GAP_MS window after Try again, or until a delivery ends the
    trouble. */
export type SnapshotTrouble = {
  kind: 'failed' | 'signed_out' | 'no_access'
  since: number
  asOf: string | null
  retrying: boolean
  detail: string
  /** the server's sentence when a part refused to load (a 'rule' error),
      such as a part too large to load or one that did not arrive in time,
      which retrying alone may not end, or why the seats went */
  reason?: string
}
let snapshotTrouble: SnapshotTrouble | null = null
/* The crash note's report from this start (P.unconfirmedReport). */
let unconfirmedReport: string | null = null
/* When a sign-out last said what it would lose. A second press within
   SIGN_OUT_CONFIRM_MS goes ahead. */
const SIGN_OUT_CONFIRM_MS = 5_000
let signOutWarnedAt = Number.NEGATIVE_INFINITY
/* Whether a sign-out request is under way (PLANNER.signOut). */
let signingOut = false
/* A delivery that ends the trouble but waits to be painted (owe). The
   trouble ends when that paint lands, not before, so nobody edits the stale
   rows still on screen in the meantime. */
let recoveryHeld = false

/** Ends the trouble once a held recovering delivery has been painted. */
function endHeldRecovery() {
  if (recoveryHeld) snapshotRecovered()
}

/* The writes that go on while the snapshot is stale, each named. They change
   only the signed-in person's own state, such as a followed task or a
   favorite project, read the OAuth consent page's request, or only take
   access away: revoking or deleting a credential, and deactivating or
   removing a seat. The server checks a star by the seat's own access, and
   the All projects directory shows it from the navigation reads, not from
   the snapshot. An admin must be able to shut out a
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
  'projectNav:setFavorite',
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
/* Whether `name` still goes out during `trouble`. Signed out, nothing goes
   out, since the server refuses every write without a sign-in. Without a
   seat only the login's own settings go out: its appearance and deleting a
   connected app, which need no seat. The rest act on seats the person can no
   longer use, and the server refuses them, so they pause. */
const isUnpausedWrite = (name: string, trouble: SnapshotTrouble) =>
  trouble.kind === 'signed_out'
    ? false
    : trouble.kind === 'no_access'
      ? name.startsWith('appearance:') || name === 'oauthConnections:revoke'
      : /^(messages|appearance):/.test(name) || UNPAUSED_WRITES.has(name)

/** Why Qivo cannot save now, or null (lib/syncStatus). */
const savePause = (): SavePause | null => syncStatus.pause()

/** Whether send() refuses `name` now: every write while Qivo cannot save,
    and during snapshot trouble every write that does not go on. */
const isPausedWrite = (name: string) =>
  savePause() !== null || (snapshotTrouble !== null && !isUnpausedWrite(name, snapshotTrouble))

/** The sentence a paused edit shows, or the write `name` when given. Trouble
    that pauses it says why first, as the notice does, then the connection. */
function pausedText(name?: string) {
  const trouble =
    snapshotTrouble && (name === undefined || !isUnpausedWrite(name, snapshotTrouble))
      ? snapshotTrouble
      : null
  const pause = savePause()
  if (!trouble && pause) return pause.kind === 'slow' ? SLOW_TEXT : OFFLINE_TEXT
  return trouble?.kind === 'no_access'
    ? (trouble.reason ?? NO_ACCESS_TEXT)
    : trouble?.kind === 'signed_out'
      ? SIGNED_OUT_TEXT
      : PAUSED_TEXT
}

/* One action can reach several mutators. The pause toast shows once for it. */
const PAUSED_TOAST_GAP_MS = 1000
let pausedToastAt = Number.NEGATIVE_INFINITY

/** Toasts the pause, or `text` in its place, at most once per
    PAUSED_TOAST_GAP_MS. */
function toastPaused(text = pausedText()) {
  const now = Date.now()
  if (now - pausedToastAt < PAUSED_TOAST_GAP_MS) return
  pausedToastAt = now
  toast(text)
}

/** Toasts the pause and answers true while shared edits are paused. Every
    optimistic mutator calls it before its paint. Actions that take typed
    text, close a window or announce success call it before they do, so a
    paused save keeps the text in its field and claims nothing. */
function refusePausedEdit(): boolean {
  if (!snapshotTrouble && !savePause()) return false
  toastPaused()
  return true
}

/** Toasts the pause and answers true when send() would refuse `mutation`
    now. A mutator whose write goes on while the snapshot is stale calls it
    before its paint, because offline, signed out or without a seat most of
    those writes pause too, and a caller that announces success must not
    announce a paused one. `quiet` skips the toast, for a write the person
    did not ask for, such as reading the messages of a task they open. */
function refusePausedWrite(mutation: FunctionReference<'mutation'>, quiet = false): boolean {
  const name = getFunctionName(mutation)
  if (!isPausedWrite(name)) return false
  if (!quiet) toastPaused(pausedText(name))
  return true
}

/* The organization each refused write named (write), so a refusal for a
   lost seat can tell whether the person still has a seat elsewhere. */
const refusedOrgs = new WeakMap<object, string>()

/* The times the socket was down while each refused write waited (dispatch),
   so a field_changed notice can say "while you were offline". */
const offlineWaits = new WeakMap<object, OfflineWindow[]>()

/** Whether a refusal says the organization is being deleted
    (convex/lib/billingAccess.ts ORG_DELETING), to a member and to someone
    whose seat the deletion has already deleted. */
const orgDeleting = (d: ErrData) => d.code === 'forbidden' && d.message === ORG_DELETING

/** The sentence when a refusal says the person has no seat in the
    organization any more, or that it is being deleted
    (convex/lib/functions.ts loadMember), and they hold no seat in another
    one, otherwise null. It can arrive before or after the snapshot delivery
    that reports the lost seat. Someone who keeps another organization keeps
    working there, so for them, and when the refused organization is not
    known, it stays a refusal of that one write. */
function seatGoneText(e: unknown): string | null {
  const d = errData(e)
  const deleting = orgDeleting(d)
  if (!deleting && (d.code !== 'forbidden' || d.message !== 'no profile in this organization'))
    return null
  const org = typeof e === 'object' && e !== null ? refusedOrgs.get(e) : undefined
  if (![...myProfiles.keys()].every((seat) => seat === org)) return null
  return deleting ? ORG_DELETING_TEXT : NO_ACCESS_TEXT
}

/** Whether the server refused a write because the sign-in ended
    (convex/lib/functions.ts). */
function notSignedIn(e: unknown): boolean {
  const d = errData(e)
  return d.code === 'forbidden' && d.message === 'not signed in'
}

/** Whether a refusal reads as the pause: a paused write never left the
    browser, and a write that was in flight when the last seat or the
    sign-in went is refused as forbidden, so it reads like the writes paused
    after it. */
function refusedAsPaused(e: unknown): boolean {
  const d = errData(e)
  return (
    d.code === 'paused' ||
    seatGoneText(e) !== null ||
    notSignedIn(e) ||
    (d.code === 'forbidden' && snapshotTrouble?.kind === 'no_access')
  )
}

/** The sentence of a refusal that reads as the pause (refusedAsPaused). A
    lost seat or sign-in says so even before the snapshot reports it, and a
    write that send() paused keeps the sentence it was paused with. */
function refusalPauseText(e: unknown) {
  const seat = seatGoneText(e)
  if (seat !== null) return seat
  if (notSignedIn(e)) return SIGNED_OUT_TEXT
  const d = errData(e)
  return d.code === 'paused' && d.message ? String(d.message) : pausedText()
}

/* 'rule' and read-only sentences are the P0001 successors and keep their
   words, shaped by asSentence. Everything else is deliberately generic. The
   wording says "reverted", never "reloading", because taking a refused
   write's paint away is a repaint, not a refetch. A paused write's sentence is the pause itself
   (refusedAsPaused). */
function toastWriteError(e: unknown, reverted = true) {
  const d = errData(e)
  if (refusedAsPaused(e)) {
    toastPaused(refusalPauseText(e))
    return
  }
  if (d.reason === FIELD_CHANGED) {
    noticeFieldChanged(e)
    return
  }
  // a write that painted nothing has nothing to revert
  toast(`${refusalSentence(e)}${reverted ? ' Change reverted.' : ''}`)
}

/** The sentence of refusal `e` that toastWriteError shows, without what it
    says about the paint: the pause's, a rule's or read-only sentence in its
    own words, or a generic one. */
function refusalSentence(e: unknown): string {
  const d = errData(e)
  if (refusedAsPaused(e)) return refusalPauseText(e)
  // the organization's deletion, to someone who keeps another one, says so
  if ((readOnly(d) || d.code === 'rule' || orgDeleting(d)) && d.message)
    return asSentence(String(d.message))
  if (d.code === 'forbidden') return "You don't have permission for that."
  // not_found, bad_request, conflict, transport — all generic
  return "Couldn't save."
}

/** Reads older comment `id` of the watched thread again from the server
    (snapshot.commentsBefore, the page before the comment after it in thread
    order) and shows what is stored now: a comment older than the live
    window gets no delivery. The comment after the last one above a gap is
    the gap's first released id, not the first row below it, whose page can
    miss the comment. A released id the server calls no comment now was
    deleted, so it leaves the gap and the read asks before the next one. A
    comment held apart for an editor that no run, gap or live window lists
    any more went with a release from the top, the history's start or stop
    or a start-over, so it is older than every comment they list, and the
    read walks back from the oldest of them (refreshPinnedComment). A
    comment gone meanwhile leaves the thread. */
async function refreshOlderComment(id: string) {
  const issueUuid = watchedComments
  const watchEpoch = commentsWatchEpoch
  const org = watchedOrgOf()
  const order = [
    ...olderComments.map((r) => r.id),
    ...(commentsGap ?? []),
    ...newerComments.map((r) => r.id),
    ...(commentsSnap ?? []).map((r) => r.id),
  ]
  const at = order.indexOf(id)
  if (!issueUuid || !org) return
  const current = () => watchedComments === issueUuid && commentsWatchEpoch === watchEpoch
  if (at === -1) {
    if (pinnedComments.has(id)) await refreshPinnedComment(id, order, issueUuid, org, current)
    return
  }
  for (let next = at + 1; next < order.length; next++) {
    const after = order[next]
    let page: FunctionReturnType<typeof api.snapshot.commentsBefore>
    try {
      page = await convex.query(api.snapshot.commentsBefore, {
        org_id: org,
        issue_id: issueUuid,
        before: after,
      })
    } catch (e) {
      if (!current()) return
      if (errData(e).code === 'bad_request' && commentsGap?.includes(after)) {
        commentsGap = commentsGap.filter((gone) => gone !== after)
        continue
      }
      console.error('[qivo] an older comment failed to load again:', e)
      return
    }
    if (!current()) return
    const fresh = page.comments.find((r) => r.id === id)
    patchHeldComment(id, fresh ? anchor([fresh])[0] : null, true)
    repaint({ thread: true })
    return
  }
}

/** Reads comment `id` again, held apart for an editor and older than
    every comment in `order` (refreshOlderComment). It reads the pages
    before the oldest comment `order` lists, walking back until a page
    holds it, which patches it, or starts the thread without it, which
    drops it as deleted. An anchor the server calls no comment now gives
    way to the next one in `order`. `current` says whether the same thread
    is still watched. */
async function refreshPinnedComment(
  id: string,
  order: readonly string[],
  issueUuid: string,
  org: string,
  current: () => boolean,
) {
  let next = 0
  let before: string | undefined = order[0]
  // a thread holds at most the comment cap, 20 pages of 50, so this ends
  for (let reads = 0; before !== undefined && reads < 100; reads++) {
    let page: FunctionReturnType<typeof api.snapshot.commentsBefore>
    try {
      page = await convex.query(api.snapshot.commentsBefore, {
        org_id: org,
        issue_id: issueUuid,
        before,
      })
    } catch (e) {
      if (!current()) return
      if (errData(e).code === 'bad_request' && before === order[next]) {
        before = order[++next]
        continue
      }
      console.error('[qivo] a comment held for its editor failed to load again:', e)
      return
    }
    if (!current()) return
    const fresh = page.comments.find((r) => r.id === id)
    if (fresh || !page.earlier) {
      patchHeldComment(id, fresh ? anchor([fresh])[0] : null, true)
      repaint({ thread: true })
      return
    }
    before = page.comments[0]?.id
  }
}

/** Whether comment `id` of the watched thread is held outside the live
    window, in a run or apart, where no delivery reaches it. */
function heldBeforeWindow(id: string): boolean {
  return (
    olderComments.some((r) => r.id === id) ||
    newerComments.some((r) => r.id === id) ||
    pinnedComments.has(id) ||
    apartComments.has(id)
  )
}

/** Patches comment `id` wherever the watched thread holds it outside the
    live window with `edit`, or drops it for null. With `whole`, `edit` is
    the whole row, as a fresh read brings it. A gap whose run above it
    empties joins the thread's start (joinEmptyRun). */
function patchHeldComment(id: string, edit: Partial<Row<'comments'>> | null, whole = false) {
  const patch = (list: Row<'comments'>[]) =>
    edit === null
      ? list.filter((r) => r.id !== id)
      : list.map((r) => (r.id === id ? (whole ? (edit as Row<'comments'>) : { ...r, ...edit }) : r))
  olderComments = patch(olderComments)
  newerComments = patch(newerComments)
  for (const held of [pinnedComments, apartComments]) {
    const row = held.get(id)
    if (row && edit === null) held.delete(id)
    else if (row && edit) held.set(id, whole ? (edit as Row<'comments'>) : { ...row, ...edit })
  }
  joinEmptyRun()
}

/* --- refusals over a field someone else changed ----------------------------
   The server refuses an edit whose `expected` no longer matches what it
   stores (convex/model/expected.ts, reason field_changed). The person must
   learn of every such refusal, so its notice stays until they close it.
   Every refusal joins the notice while it is open, so one notice holds them
   all however many there are, and a refusal of an edit built on one of the
   person's own refused edits joins that edit's line ("Your 2 changes were
   discarded"). */

/** What send() knew about a field_changed refusal, for its notice. */
type FieldRefusalContext = {
  layer: Layer
  kept: boolean
  deletes?: boolean
  batch?: number
  keepMine?: boolean
}
const fieldRefusals = new WeakMap<object, FieldRefusalContext>()

/** How far a change may lie outside a time offline and still count as made
    while the person was offline, for clocks that differ. */
const OFFLINE_SLACK_MS = 5_000
/** How many refused layers the store remembers for chained refusals. */
const REFUSED_LAYERS_KEPT = 200

type FieldNoticeLine = { refusal: FieldRefusal; box: FieldNoticeBox }
type FieldNoticeBox = { key: string; lines: FieldNoticeLine[] }
let fieldNoticeBox: FieldNoticeBox | null = null
let fieldNoticeSeq = 0
// layer id of a refused edit to its notice line
const refusedLines = new Map<number, FieldNoticeLine>()

/* Person `id`'s name as the store knows it now, from the people part or
   the profile cache (P.person), or undefined while it does not, for a
   sentence that names them with its own words in the name's place. */
const knownName = (id: string | null | undefined): string | undefined => {
  const person = PLANNER.person(id)
  return person?.state === 'ok' ? person.name : undefined
}

/* How a notice names the record a change is about, from the rows on
   screen, and who wrote it. */
const fieldLookup = {
  record(change: FieldChange, seenName?: string): string {
    const task = (id: string | undefined) => (id && uuidToKey.get(id)) || 'a task'
    const named = (name: string | undefined, fallback: string) => seenName ?? name ?? fallback
    switch (change.record) {
      case 'task':
        return task(change.id)
      case 'comment': {
        const comment = rows.comments.get(change.id)
        return comment ? `this comment on ${task(comment.issue_id)}` : 'this comment'
      }
      case 'milestone': {
        const name = seenName ?? milestoneOnScreen(change.id)?.name
        return name ? `milestone “${name}”` : 'a milestone'
      }
      case 'project':
        return named(rows.projects.get(change.id)?.name, 'a project')
      case 'grant': {
        const who = knownName(change.of) ?? rows.teams.get(change.of ?? '')?.name
        const where = rows.projects.get(change.id)?.name
        return who && where ? `${who}'s access to ${where}` : 'an access level'
      }
      case 'team':
        return named(rows.teams.get(change.id)?.name, 'a team')
      case 'label': {
        const name = seenName ?? rows.labels.get(change.id)?.name
        return name ? `label “${name}”` : 'a label'
      }
      case 'profile':
        return named(knownName(change.id), 'a person')
      case 'organization':
        return 'the organization'
      case 'link':
        return `the link between ${task(change.id)} and ${task(change.of)}`
    }
  },
  writer(profileId: string): Writer {
    if ([...myProfiles.values()].includes(profileId)) return 'you'
    const name = knownName(profileId)
    return name ? { name } : null
  },
}

/* Whether refused write `e` waited through a lost connection while one of
   `changes` was made. */
function changedWhileOffline(e: unknown, changes: readonly FieldChange[]): boolean {
  const windows = (typeof e === 'object' && e !== null && offlineWaits.get(e)) || []
  return changes.some((change) => {
    const at = change.at ? Date.parse(change.at) : Number.NaN
    return windows.some(
      (w) => at >= w.from - OFFLINE_SLACK_MS && (w.to === null || at <= w.to + OFFLINE_SLACK_MS),
    )
  })
}

/** Shows the notice of a field_changed refusal `e`, joining a recent
    notice, or the line of the person's own refused edit this one built on. */
function noticeFieldChanged(e: unknown) {
  const changes = errData(e).changes ?? []
  const context = e instanceof ConvexError ? fieldRefusals.get(e) : undefined
  const layer = context?.layer
  // an edit made on top of one of mine the server refused fails with it
  const seenFrom = layer?.seenFrom
  // a line of the same kind only, so it keeps saying what became of each
  // change: a kept draft, a delete or a discarded change
  const chained = seenFrom
    ? changes
        .map((change) => refusedLines.get(seenFrom.get(change.field) ?? -1))
        .find(
          (line) =>
            line !== undefined &&
            !!line.refusal.kept === !!context?.kept &&
            !!line.refusal.keepMine === !!context?.keepMine &&
            !!line.refusal.deletes === !!context?.deletes,
        )
    : undefined
  if (chained) {
    chained.refusal.count++
    if (layer) rememberRefused(layer.id, chained)
    showFieldNotice(chained.box)
    return
  }
  const box = fieldNoticeBox ?? { key: `field-changed-${++fieldNoticeSeq}`, lines: [] }
  fieldNoticeBox = box
  // the name the person saw, since the screen may still show their own new one
  const over = layer?.over
  const seenName =
    over && over.id === changes[0]?.id && typeof over.fields.name === 'string'
      ? over.fields.name
      : undefined
  const line: FieldNoticeLine = {
    refusal: {
      changes,
      count: 1,
      seenName,
      kept: context?.kept,
      keepMine: context?.keepMine,
      deletes: context?.deletes,
      batch: context?.batch,
      offline: changedWhileOffline(e, changes),
    },
    box,
  }
  box.lines.push(line)
  if (layer) rememberRefused(layer.id, line)
  showFieldNotice(box)
}

/** The sentence for field_changed refusal `e` of a settings field that keeps
    the person's text until they choose Keep mine, shown beside the field
    rather than as a notice. */
function keptFieldText(e: unknown): string {
  return refusalLine(
    { changes: errData(e).changes ?? [], count: 1, kept: true, keepMine: true },
    fieldLookup,
  )
}

/** Runs `save.keepDraft` for a write the store awaited without a paint
    (setDisplayName, setOrgSlug) when the server refused it with
    field_changed, with the value now on screen and who wrote the one the
    server keeps, as send() does for a painted write. */
function keepAwaitedDraft(e: unknown, save: FieldSave, shown: unknown) {
  if (errData(e).reason !== FIELD_CHANGED || !save.keepDraft) return
  const by = refusalWriter(errData(e).changes ?? [], fieldLookup)
  guarded(() => save.keepDraft?.(shown, by))
}

function rememberRefused(layerId: number, line: FieldNoticeLine) {
  refusedLines.set(layerId, line)
  if (refusedLines.size > REFUSED_LAYERS_KEPT) {
    const oldest = refusedLines.keys().next().value
    if (oldest !== undefined) refusedLines.delete(oldest)
  }
}

function showFieldNotice(box: FieldNoticeBox) {
  const text = noticeText(box.lines.map((line) => refusalLine(line.refusal, fieldLookup)))
  // a closed notice takes no more lines; a later refusal opens a new one
  const onDismiss = () => {
    if (fieldNoticeBox === box) fieldNoticeBox = null
  }
  window.showToast?.(text, 'error', { sticky: true, key: box.key, onDismiss })
}

/* The two awaited restores share one refusal voice: a `rule` (or not_found)
   sentence is quoted, forbidden reads the fixed permission line. */
function restoreErrorText(e: unknown): string {
  const d = errData(e)
  if (refusedAsPaused(e)) return refusalPauseText(e)
  if (readOnly(d) && d.message) return d.message
  if (orgDeleting(d)) return ORG_DELETING_TEXT
  if (d.code === 'forbidden') return "You don't have permission for that"
  if (d.message) return `Couldn't restore. ${asSentence(String(d.message))}`
  return "Couldn't restore"
}

/* A Deleted items call the server refused whole, in the restore refusal voice
   above: the pause sentence while edits pause, billing's sentence as it is,
   the fixed permission line, a rule's own sentence after what failed.
   Anything else (offline, a server fault) asks for another try. */
function deletedItemsErrorText(e: unknown, failed: string): string {
  const { text, alone } = deletedReasonText(e)
  return alone ? text : `${failed}. ${text}`
}

/** Why the server refused a Deleted items call whole, as a sentence of its
    own: the pause, billing's read-only sentence, the organization's
    deletion and the permission line stand `alone`; a rule's sentence and
    "Try again." follow what failed. */
function deletedReasonText(e: unknown): { text: string; alone: boolean } {
  const d = errData(e)
  if (refusedAsPaused(e)) return { text: refusalPauseText(e), alone: true }
  // read-only for billing or a scheduled deletion says why, in its own words
  if (readOnly(d) && d.message) return { text: String(d.message), alone: true }
  if (orgDeleting(d)) return { text: ORG_DELETING_TEXT, alone: true }
  if (d.code === 'forbidden') return { text: "You don't have permission for that.", alone: true }
  if (d.code === 'rule' && d.message) {
    const m = String(d.message)
    return {
      text: `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`,
      alone: false,
    }
  }
  return { text: 'Try again.', alone: false }
}

/** What one restore or Delete now call answered, in the words both share. */
type DeletedAnswer<Reason> = {
  done: string[]
  refused: { id: string; reason: Reason }[]
  deferred: string[]
  stepping: string[]
}

/** How the store sends one kind of Deleted items call. */
type DeletedCalls<Reason> = {
  kind: 'restore' | 'purge'
  limit: Limit
  ref: FunctionReference<'mutation'>
  call: (orgId: string, ids: string[]) => Promise<DeletedAnswer<Reason>>
  /** the start of a call's refusal sentence, "Couldn't restore" */
  failed: string
}

/** What a restore or Delete now refuses while another one runs. */
export const DELETED_BUSY_TEXT =
  'Qivo is still restoring or deleting other items. Try again once it finishes.'

/* The deferred items the store watches until it can send them again
   (watchDeferred), each with the way to stop its watch. */
const deferredWatches = new Map<string, () => void>()

/* What waits for edits to resume, such as a deferred item's second send
   that the pause refused or stopped (watchDeferred). Each runs once, when
   neither the save pause nor snapshot trouble holds any more. */
const afterPause = new Set<() => void>()

/* How many times edits have resumed (resumeAfterPause), so a write can
   tell whether a pause ended between its send and its answer. */
let pauseEnds = 0

/** Runs what waits for edits to resume, once both pauses have ended. */
function resumeAfterPause() {
  // one pause can end while the other still holds
  if (snapshotTrouble || savePause()) return
  pauseEnds += 1
  const waiting = [...afterPause]
  afterPause.clear()
  for (const run of waiting) run()
}

/** Runs `run` once edits resume after a write the pause refused, whose
    send began when pauseEnds was `since`. A pause that ended before the
    refusal came back has already run what waited for it, so `run` goes at
    once when edits have resumed since and no pause holds now; otherwise it
    waits for the next resumeAfterPause. */
function afterPauseSince(since: number, run: () => void) {
  if (pauseEnds !== since && !snapshotTrouble && !savePause()) run()
  else afterPause.add(run)
}

/** Sets P.deletedAction and shows it on the page. */
function setDeletedAction(next: DeletedAction | null) {
  PLANNER.deletedAction = next
  emit('deleted')
}

/** Shows the deferred items the store watches (P.deletedWaiting). */
function showDeletedWaiting() {
  PLANNER.deletedWaiting = new Set(deferredWatches.keys())
  emit('deleted')
}

/** Stops every deferred item's watch, as the store's end does. */
function stopDeferredWatches() {
  // a stop takes its own entry out, which a Map's walk allows
  for (const stop of deferredWatches.values()) stop()
  deferredWatches.clear()
  afterPause.clear()
  PLANNER.deletedWaiting = new Set()
}

/** Sends one restore call of `ids` in organization `orgId`
    (deletedItems.restore), marked `bulk` as part of a restore of several
    items, and answers it in the words both kinds of call share. */
async function restoreCall(
  orgId: string,
  ids: string[],
  bulk: boolean,
): Promise<DeletedAnswer<RestoreRefusal>> {
  const answer = await sendAwaited(
    api.deletedItems.restore,
    { org_id: orgId, ids, ...(bulk ? { bulk } : {}) },
    'none',
  )
  // a server answer names every list; a missing one is empty
  return {
    done: answer.restored,
    refused: answer.refused,
    deferred: answer.deferred ?? [],
    stepping: answer.stepping ?? [],
  }
}

/** Sends one Delete now call of `ids` in organization `orgId`
    (deletedItems.purge), answered as restoreCall answers. */
async function purgeCall(orgId: string, ids: string[]): Promise<DeletedAnswer<PurgeRefusal>> {
  const answer = await sendAwaited(api.deletedItems.purge, { org_id: orgId, ids }, 'none')
  return { done: answer.purged, refused: answer.refused, deferred: [], stepping: [] }
}

/* Sends restore calls (restoreCall). */
const RESTORE_CALLS = (bulk: boolean): DeletedCalls<RestoreRefusal> => ({
  kind: 'restore',
  limit: LIMITS.restoreBatch,
  ref: api.deletedItems.restore,
  call: (orgId, ids) => restoreCall(orgId, ids, bulk),
  failed: "Couldn't restore",
})

/* Sends Delete now calls (purgeCall). */
const PURGE_CALLS: DeletedCalls<PurgeRefusal> = {
  kind: 'purge',
  limit: LIMITS.purgeBatch,
  ref: api.deletedItems.purge,
  call: purgeCall,
  failed: "Couldn't delete it for good",
}

/* Runs a restore or Delete now of `items` on the shared runner
   (lib/batchRunner.ts runLanes) by planOf's plan: one lane an organization,
   its calls of at most the call's limit of ids one after another, a long
   action on the app's shared lanes. 25 ids a call is the server's own cap
   (LIMITS.restoreBatch, LIMITS.purgeBatch): a restore call spends one
   budget shared by its items, a quarter of a step's
   (convex/model/deletedItems.ts CALL), and leaves the rest of a large item
   to its steps, so more ids make a call no longer than its budget; the
   timing of 5 November 2026 restored the widest item family whole in 1.9
   to 3.0 s on a local backend. Its progress is P.deletedAction, which the
   page shows however often it is left and opened again; `resend`, the
   second send of a deferred item, keeps out of it.

   It sends nothing and answers the ids as failed while another action runs
   (unless `resend`) or the pause refuses the write, which the page words.
   A refusal stops its organization's lane and leaves its later ids unsent;
   the pause stops every lane before its next call; a store epoch change
   ends it quietly; a fault ends it, marks the ids of the calls in flight
   unknown and says so. Each deferred id, at most DEFERRED_MOST an action,
   is watched until it can be sent again (watchDeferred); the rest count as
   unsent. An action of one round never toasts from here, as the page words
   its outcome. A long one ends with a toast wherever the person is, each
   organization a refusal stopped with a sticky toast, and the pause with
   one that counts what every organization did, finished, refused or
   paused, while a refused organization's refusals and unsent calls stay in
   its own toast; a later run that finishes in an organization takes its
   stop toast away. */
async function runDeletedItems<Reason>(
  items: readonly DeletedTarget[],
  calls: DeletedCalls<Reason>,
  o: { bulk?: boolean; resend?: boolean } = {},
): Promise<DeletedItemsOutcome<Reason>> {
  const outcome: DeletedItemsOutcome<Reason> = {
    done: [],
    stepping: [],
    refused: [],
    deferred: [],
    failed: [],
    unsent: [],
    unknown: [],
    error: null,
    paused: false,
  }
  const ids = [...new Set(items.map((item) => item.id))]
  if (ids.length === 0) return outcome
  if (!o.resend && deletedBusy(PLANNER.deletedAction))
    return { ...outcome, failed: ids, error: DELETED_BUSY_TEXT }
  // the page says the pause in its own toast
  if (refusePausedWrite(calls.ref, true))
    return { ...outcome, failed: ids, error: pausedText(getFunctionName(calls.ref)), paused: true }
  const { kind } = calls
  const plan = planOf(items, calls.limit.max)
  const epoch = storeEpoch
  const live = () => epoch === storeEpoch
  const known = new Map(items.map((item) => [item.id, item]))
  const orgName = (org: string) =>
    items.find((item) => item.org_id === org && item.org_name)?.org_name ??
    rows.orgs.get(org)?.name ??
    'an organization'
  type LaneState = {
    next: number
    flying: readonly string[] | null
    error: unknown
    done: number
    stepping: number
    deferred: string[]
    refused: number
  }
  const lanes = new Map<string, LaneState>(
    plan.lanes.map((lane) => [
      lane.org_id,
      { next: 0, flying: null, error: undefined, done: 0, stepping: 0, deferred: [], refused: 0 },
    ]),
  )
  const laneOf = (lane: DeletedLane) => lanes.get(lane.org_id) as LaneState
  const pending = new Set(ids)
  const stops: DeletedStop[] = []
  let lanesDone = 0
  let action: DeletedAction | null = o.resend
    ? null
    : {
        kind,
        state: 'running',
        long: plan.long,
        noun: itemsNoun(items, plan.total),
        total: plan.total,
        done: 0,
        refused: 0,
        lanes: plan.lanes.length,
        lanesDone: 0,
        pending: ids,
        stops: [],
      }
  const show = (patch: Partial<DeletedAction>) => {
    if (action === null) return
    action = { ...action, ...patch, pending: [...pending] }
    setDeletedAction(action)
  }
  if (action) setDeletedAction(action)
  const refusedCount = () => outcome.refused.length + outcome.failed.length
  let ran: { finished: DeletedLane[]; stops: LaneStop<DeletedLane>[] } | null
  try {
    ran = await runLanes<DeletedLane, DeletedAnswer<Reason>>({
      lanes: plan.lanes,
      // a long action shares the app's lanes with every other large action
      pool: plan.long ? LANE_POOL : undefined,
      live,
      send: async (lane) => {
        const at = laneOf(lane)
        const batch = lane.calls[at.next]
        at.next += 1
        at.flying = batch
        try {
          return await calls.call(lane.org_id, [...batch])
        } catch (error) {
          console.error('[qivo] deleted items call failed:', error)
          at.error = error
          throw error
        }
      },
      more: (lane) => laneOf(lane).next < lane.calls.length,
      pauseOf: (error) => (refusedAsPaused(error) ? refusalPauseText(error) : null),
      reasonOf: (error) => deletedReasonText(error).text,
      onAnswer: (lane, answer) => {
        const at = laneOf(lane)
        for (const id of at.flying ?? []) pending.delete(id)
        at.flying = null
        at.done += answer.done.length
        at.stepping += answer.stepping.length
        at.deferred.push(...answer.deferred)
        at.refused += answer.refused.length
        outcome.done.push(...answer.done)
        outcome.refused.push(...answer.refused)
        outcome.deferred.push(...answer.deferred)
        outcome.stepping.push(...answer.stepping)
        if (at.next >= lane.calls.length) lanesDone += 1
        show({ done: outcome.done.length, refused: refusedCount(), lanesDone })
      },
      onStop: ({ lane, reason, paused }) => {
        if (paused) outcome.paused = true
        const at = laneOf(lane)
        if (at.flying !== null) {
          // the call the refusal answered, refused whole
          outcome.failed.push(...at.flying)
          at.refused += at.flying.length
          for (const id of at.flying) pending.delete(id)
          at.flying = null
        }
        const left = lane.calls.slice(at.next).flat()
        outcome.unsent.push(...left)
        for (const id of left) pending.delete(id)
        outcome.error ??=
          at.error === undefined ? reason : deletedItemsErrorText(at.error, calls.failed)
        stops.push({
          org_id: lane.org_id,
          org_name: orgName(lane.org_id),
          total: lane.calls.flat().length,
          done: at.done,
          refused: at.refused,
          unsent: left.length,
          reason,
          paused,
        })
        show({ refused: refusedCount(), stops: [...stops] })
      },
    })
  } catch (fault) {
    if (!live()) return outcome
    reportFault(fault)
    for (const lane of plan.lanes) {
      const at = laneOf(lane)
      if (at.flying !== null) outcome.unknown.push(...at.flying)
      outcome.unsent.push(...lane.calls.slice(at.next).flat())
    }
    pending.clear()
    show({ state: 'stopped' })
    toast(faultText(kind))
    return outcome
  }
  if (ran === null) return outcome
  // the deferred past what one action watches are left unsent
  const overflow = outcome.deferred.splice(DEFERRED_MOST)
  outcome.unsent.push(...overflow)
  if (!o.resend) {
    const deferred = new Set(outcome.deferred)
    for (const id of outcome.deferred)
      watchDeferred(known.get(id) ?? { id, org_id: '' }, o.bulk === true, deferred)
  }
  show({ state: stops.length > 0 ? 'stopped' : 'finished' })
  if (!plan.long || o.resend) return outcome
  const keyOf = (org: string) => `deleted-${kind}:${org}`
  // an organization that finished now leaves no stop toast of an earlier run
  for (const lane of ran.finished) dropStopToast(keyOf(lane.org_id))
  if (stops.every((stop) => !stop.paused)) dropStopToast(keyOf('pause'))
  const nounOf = (org: string) => (n: number) =>
    itemsNoun(
      items.filter((item) => item.org_id === org),
      n,
    )
  for (const stop of stops)
    if (!stop.paused) showStopToast(keyOf(stop.org_id), stopText(kind, stop, nounOf(stop.org_id)))
  const pauses = stops.filter((stop) => stop.paused)
  if (pauses.length > 0) {
    // the pause's toast is the action's end, so it counts what every
    // organization did, the finished and the refused ones too; a refused
    // one's refusals and unsent calls stay in its own toast
    const refusedIn = new Set(stops.filter((stop) => !stop.paused).map((stop) => stop.org_id))
    const watched = new Set(outcome.deferred)
    const tallies = plan.lanes.map((lane) => {
      const at = laneOf(lane)
      const following = at.deferred.filter((id) => watched.has(id)).length
      // a refused organization has no paused stop, so it adds none here
      const unsent = pauses.find((stop) => stop.org_id === lane.org_id)?.unsent ?? 0
      return {
        org_name: orgName(lane.org_id),
        done: at.done,
        stepping: at.stepping,
        following,
        refused: refusedIn.has(lane.org_id) ? 0 : at.refused,
        // the deferred past what one action watches were not sent
        unsent: unsent + at.deferred.length - following,
      }
    })
    showStopToast(
      keyOf('pause'),
      pauseText(kind, tallies, (n) => itemsNoun(items, n), pauses[0].reason),
    )
  }
  if (stops.length > 0) return outcome
  const { text, tone } = endText({
    kind,
    asked: items,
    done: outcome.done.length,
    stepping: outcome.stepping.length,
    refused: refusedCount(),
    following: outcome.deferred.map((id) => known.get(id)),
    unsent: outcome.unsent.map((id) => known.get(id)),
  })
  if (tone === 'success') toast(text, 'success')
  else window.showToast?.(text, 'error', { sticky: true })
  return outcome
}

/* Watches deferred item `item` (deletedItems.item, through watchLive and
   not the visibility gate, as a pending save goes on in a hidden tab)
   until it can be sent again, and sends it in a call of its own, marked
   bulk when its first call was. The watch goes on after the page is left
   and ends quietly when the item leaves Deleted items, when it is sent
   and restored, and when the store's epoch changes. It ends with
   "Couldn't restore <name>. <reason>" when the second send is refused,
   when the item's row says another reason than its deleted project once
   that project is back, and when the project item it waits for went back
   to ready or stuck after its restore failed; `siblings`, the action's
   other deferred items, are watched for themselves, so one that waits for
   another waits without judging it. A re-send skips the busy rule, so a
   new action may run beside the watches, and honors the pause. When the
   pause refuses it or stops its call, the watch goes on and judges the
   last row it took again once edits resume (afterPauseSince), at once when
   they resumed before the refusal came back, or on the row's next answer,
   whichever comes first. */
function watchDeferred(item: DeletedTarget, bulk: boolean, siblings: ReadonlySet<string>) {
  if (deferredWatches.has(item.id)) return
  const epoch = storeEpoch
  let name = targetName(item)
  let ended = false
  let sending = false
  // the row the watch took last, which the end of a pause judges again
  let last: DeletedRow | null = null
  let holder: { id: string; stop: () => void } | null = null
  const stops: (() => void)[] = []
  const end = (reason?: string) => {
    if (ended) return
    ended = true
    afterPause.delete(again)
    for (const stop of stops) stop()
    holder?.stop()
    if (deferredWatches.get(item.id) === stopAll) {
      deferredWatches.delete(item.id)
      if (epoch === storeEpoch) showDeletedWaiting()
    }
    if (reason !== undefined && epoch === storeEpoch)
      toast(`Couldn't restore ${name}. ${reason}`, 'error')
  }
  const stopAll = () => end()
  /** Judges the last row again, once edits resume after a paused send. */
  const again = () => {
    if (!ended && !sending && last !== null) judge(last)
  }
  const resend = (row: DeletedRow) => {
    sending = true
    // a pause can end before this send's answer comes back
    const since = pauseEnds
    void runDeletedItems([row], RESTORE_CALLS(bulk), { bulk, resend: true }).then((outcome) => {
      sending = false
      if (ended || epoch !== storeEpoch) return
      const refused = outcome.refused.find((r) => r.id === row.id)
      if (refused) return end(refusalText(refused.reason))
      // the pause is no refusal of the item, which waits for edits to resume
      if (outcome.paused) return afterPauseSince(since, again)
      if (outcome.failed.includes(row.id) || outcome.unknown.includes(row.id))
        return end(outcome.error === null ? 'Try again.' : reasonAfter(outcome.error))
      end()
    })
  }
  const watchHolder = (id: string) => {
    if (holder?.id === id || siblings.has(id)) return
    holder?.stop()
    holder = {
      id,
      stop: watchLive<DeletedRow | null>(api.deletedItems.item, { id }, (result) => {
        if (ended || !('value' in result)) return
        const state = result.value?.state
        // its project item's restore failed, so the item stays behind it
        if (state === 'ready' || state === 'stuck') end("Its project couldn't be restored.")
      }),
    }
  }
  /** Sends the item again, waits or ends, as its row says now. */
  function judge(row: DeletedRow) {
    name = targetName(row)
    if (row.state === 'stuck') return end(refusalText('stuck'))
    if (row.state !== 'ready') return
    if (row.can_restore) return resend(row)
    const blocked = row.blocked
    if (blocked?.reason === 'project_deleted' || blocked?.reason === 'parent_deleted') {
      if (blocked.item_id !== undefined) watchHolder(blocked.item_id)
      return
    }
    end((blocked ? blockedText(blocked) : null) ?? refusalText(blocked?.reason ?? 'no_access'))
  }
  deferredWatches.set(item.id, stopAll)
  showDeletedWaiting()
  const stopRow = watchLive<DeletedRow | null>(api.deletedItems.item, { id: item.id }, (result) => {
    if (ended) return
    if (epoch !== storeEpoch) return end()
    // a failed read keeps watching; the next answer decides
    if (!('value' in result) || sending) return
    const row = result.value
    // the item left Deleted items
    if (row === null) return end()
    last = row
    judge(row)
  })
  // a watch that joined an answer can end before it hands back its stop
  if (ended) stopRow()
  else stops.push(stopRow)
}

/** A whole refusal's sentence without the "Couldn't restore." before it,
    for a sentence that names the item first. */
const reasonAfter = (error: string) => error.replace(/^Couldn't restore\. /, '')

/* A refused project create names what disappeared, followed by the reason
   when a rule, billing or permission refusal carries one (a forbidden create
   says who can create projects); every other refusal would read
   "Couldn't save", which does not say a project is gone. */
function toastCreateProjectError(e: unknown, label: string) {
  const d = errData(e)
  if (refusedAsPaused(e)) {
    toastPaused(refusalPauseText(e))
    return
  }
  const m = d.message ? String(d.message) : ''
  const reason = m && asSentence(m)
  if ((d.code === 'rule' || readOnly(d) || orgDeleting(d)) && reason) {
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

/* The sentence an upload URL's receiver refused a POST with, its
   `{"error": "…"}` (convex/machine/uploads.ts and the demo's receiver in
   convex/http.ts), or null when the answer holds none. The size the upload
   declared, the most an older ticket takes, a slow body, a used or expired
   URL and the demo's storage each explain themselves there. */
async function receiverRefusal(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' && body.error.trim() ? body.error : null
  } catch {
    return null
  }
}

/** What an upload says when its POST ended without the receiver's answer:
    the connection dropped, or the hosting front end answered instead, as
    when a large file on a slow connection ran out of the time the receiver
    reads it for (convex/machine/uploads.ts uploadReadMs). Sending it again
    on the same connection fails the same way. */
const UPLOAD_NOT_FINISHED =
  'The upload did not finish. Check your connection and try again, or send a smaller file.'

/* The private demo's reservation in upload URL `url`, a /demo-uploads/ URL
   (convex/files.ts demoUploadUrl), else null. An attachment's or picture's
   upload whose POST got no answer cancels it (cancelDemoReservation), so
   its declared bytes stop counting in the demo's 5 MiB at once. */
function demoReservation(url: string): string | null {
  try {
    const match = /^\/demo-uploads\/([^/]+)$/.exec(new URL(url).pathname)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

/* The upload ticket in upload URL `url`, an /attachment-uploads/ URL
   (convex/lib/fileTokens.ts attachmentUploadUrl), else null. A ticket's id
   is a lowercase UUID, the form of a new row's id. The app's attach takes
   it as the attachment's id, as a REST or MCP confirm does, so a confirm
   sent again, which finds an attachment by the id of the ticket it names
   (convex/model/attachments.ts completeUpload), finds only the one that
   ticket made. */
function uploadTicket(url: string): string | null {
  try {
    const match =
      /^\/attachment-uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
        new URL(url).pathname,
      )
    return match ? match[1] : null
  } catch {
    return null
  }
}

/* Cancels the private demo's reservation in upload URL `url`
   (files.cancelDemoUpload), for an upload whose POST got no answer, and
   does nothing for any other URL. It does not wait for the answer, since a
   write sent on a dropped connection waits until the connection returns
   (lib/syncStatus.ts) and the failed upload says so at once. The cancel
   goes out then. One that fails is logged, and its reservation lapses at
   its expiry. */
function cancelDemoReservation(url: string) {
  const reservation = demoReservation(url)
  if (reservation === null) return
  void sendAwaited(api.files.cancelDemoUpload, { id: reservation }, 'none').catch((e) =>
    console.error('[qivo] the demo upload was not cancelled:', e),
  )
}

/* How a POST of a file to an upload URL ended: the stored file, the
   receiver's refusal, or no answer from the receiver at all. */
type Posted = { storageId: string } | { refused: string } | { unanswered: true }

/* POSTs `file` to upload URL `url`. The POST's Content-Type is what lands
   in storage metadata and what the gateway serves back, so an empty type
   would break inline rendering. */
async function postUpload(url: string, file: Blob): Promise<Posted> {
  let res: Response
  try {
    res = await fetch(browserBackendUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  } catch (e) {
    console.error('[qivo] upload did not finish:', e)
    return { unanswered: true }
  }
  if (res.ok) {
    try {
      return { storageId: ((await res.json()) as { storageId: string }).storageId }
    } catch (e) {
      // the connection dropped after the answer's headers arrived
      console.error('[qivo] upload answer did not finish:', e)
      return { unanswered: true }
    }
  }
  console.error('[qivo] upload failed:', res.status)
  const why = await receiverRefusal(res)
  return why === null ? { unanswered: true } : { refused: why }
}

/* The avatar mutators return an error SENTENCE (Settings toasts it verbatim).
   A refusal's own message — the set_avatar right, the type and size rules — is
   the best sentence there is; anything without one gets the fallback. */
function avatarErrorText(e: unknown, fallback: string): string {
  const d = errData(e)
  if (d.reason === FIELD_CHANGED)
    return refusalLine({ changes: d.changes ?? [], count: 1 }, fieldLookup)
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
  if (d.reason === FIELD_CHANGED) return keptFieldText(e)
  if (d.code === 'conflict') {
    if (d.reason === 'slug_taken') return 'That address is already taken. Choose another.'
    if (d.reason === 'slug_reserved') return 'That address is reserved. Choose another.'
    // slug_shape — a reserved word is also a perfectly well-shaped slug,
    // so the reason is the answer
    return 'Use lowercase letters, digits and single hyphens; 40 characters maximum.'
  }
  if (orgDeleting(d)) return ORG_DELETING_TEXT
  if (d.code === 'forbidden') return "You don't have permission to change the address."
  if (d.message) {
    const m = String(d.message)
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  return "Couldn't change the address"
}

/* Writes the person did not make as a change: view preferences, the seat
   claim at boot, the Team sync stamp an edit leaves, the OAuth consent
   page's read, the upload addresses an upload asks for before its real
   write and the comment count a refused comment starts. The notice does not
   count them, and the crash note leaves them out. */
const BACKGROUND_WRITES = new Set([
  'prefs:save',
  'identity:claimMySeats',
  'teamSync:stamp',
  'oauthConnections:getContext',
  'files:uploadUrl',
  'files:avatarUploadUrl',
  'appearance:createUpload',
  'appearance:cancelUpload',
  'comments:countThread',
])

/* What the crash note says a task write changed, by mutation, or by field
   for an edit. */
const TASK_CHANGE: Record<string, string> = {
  'issues:create': 'new task',
  'issues:createParent': 'new parent task',
  'issues:createLinked': 'new linked task',
  'issues:move': 'move',
  'issues:archive': 'archive',
  'issues:unarchive': 'restore',
  'issues:deleteDeep': 'delete',
  'issues:addLink': 'link',
  'issues:removeLink': 'link',
  'issues:subscribe': 'follow',
  'issues:unsubscribe': 'follow',
  'issues:setSubscriber': 'follower',
  'comments:create': 'comment',
  'comments:update': 'comment edit',
  'comments:remove': 'comment removal',
  'files:attach': 'attachment',
  'files:removeAttachment': 'attachment removal',
  'labels:toggle': 'label',
}
const TASK_FIELD: Record<string, string> = {
  assignee_id: 'assignee',
  reviewer_id: 'reviewer',
  parent_id: 'parent',
  start_week: 'schedule',
  end_week: 'schedule',
  due_date: 'due date',
  remaining_hours: 'remaining time',
  paused: 'pause',
}
/* …and what any other write changed, by its module. */
const OTHER_CHANGE: Record<string, string> = {
  issues: 'a task change',
  comments: 'a comment change',
  projects: 'a project change',
  teams: 'a team change',
  labels: 'a label change',
  profiles: 'a change to people',
  orgs: 'an organization setting',
  identity: 'an organization change',
  tokens: 'a key or token change',
  apiAccess: 'a key or token change',
  oauthConnections: 'a connected app change',
  files: 'a picture change',
  appearance: 'an appearance change',
  messages: 'an inbox change',
  deletedItems: 'a Deleted items change',
  roadmap: 'a Roadmap change',
  projectNav: 'a favorite change',
}

/** What the crash note says about write `name` with `args`: the key of the
    task it changes, when the store knows it, and what kind of change it is.
    `taskId` names the task when the args do not, such as for a removal
    whose paint already took the row away. A new task has no key yet: the
    one on screen is a preview the server can change. The note never holds
    the text or any other content of the change. */
function describeWrite(name: string, args: unknown, taskId = ''): UnconfirmedChange {
  if (name === 'issues:create') return { task: null, what: 'a new task' }
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const issueId =
    taskId ||
    text(a.issue_id) ||
    text(a.source_id) ||
    (name === 'issues:removeLink' ? text(a.a) : '') ||
    (name.startsWith('issues:') ? text(a.id) : '') ||
    (name.startsWith('comments:') ? (rows.comments.get(text(a.id))?.issue_id ?? '') : '')
  // a task the window shows from its answer has its key there, also
  // while the workspace holds another organization's task of its id
  const org = text(a.org_id)
  const detail = PLANNER.detail
  const held = org && heldElsewhere(issueId, org) ? undefined : uuidToDisplayKey.get(issueId)
  const shown = detail?.task === issueId && (!org || detail.org === org) ? detail.view : null
  const task = held ?? shown?.key
  const fields =
    name === 'issues:update' && a.patch && typeof a.patch === 'object'
      ? [...new Set(Object.keys(a.patch).map((key) => TASK_FIELD[key] ?? key))]
      : []
  const what = fields.length ? fields.join(', ') : TASK_CHANGE[name]
  if (task && what) return { task, what }
  return { task: null, what: OTHER_CHANGE[name.split(':')[0]] ?? 'a change' }
}

/** The crash note's scope for a write: the organization it names, else the
    home organization, with the person's profile there. Null without one. */
function noteScope(args: unknown): string | null {
  const named =
    args && typeof args === 'object' && 'org_id' in args && typeof args.org_id === 'string'
      ? args.org_id
      : ''
  const org = named || HOME_ORG || [...myProfiles.keys()][0] || ''
  const profile = myProfiles.get(org)
  return org && profile ? `${org}:${profile}` : null
}

/** Every crash-note scope the signed-in person has now. */
const noteScopes = () => [...myProfiles].map(([org, profile]) => `${org}:${profile}`)

/* The inbox writes (messages.*) sent and not answered yet, which a bulk
   Inbox action waits for before it asks messages.bulkReach (askReach), so
   its plan sees them. */
const inboxWrites = new Set<Promise<unknown>>()

/* Sends one write to Convex, for send() and sendAwaited() only. They check
   the pause first; the check here is the backstop. A sent write counts as
   waiting (lib/syncStatus), and a change the person made is noted for the
   crash note (lib/unconfirmedNote), until the server answers. An inbox
   write is also in inboxWrites until then. A refusal notes a read-only
   organization, the organization it named and the times the socket was
   down while the write waited. */
function dispatch<M extends FunctionReference<'mutation'>>(
  mutation: M,
  args: FunctionArgs<M>,
  about: WriteAbout = {},
): Promise<FunctionReturnType<M>> {
  const epoch = storeEpoch
  if (DEMO_MODE && demoDisposed)
    return Promise.reject(new ConvexError({ code: 'forbidden', message: 'Your demo has expired.' }))
  const name = getFunctionName(mutation)
  if (isPausedWrite(name))
    return Promise.reject(new ConvexError({ code: 'paused', message: pausedText(name) }))
  if (STRICT_LAYERS && about.answer) answerMarked.push(name)
  const releaseUpdate = beginUpdateBlock()
  const change =
    about.background || BACKGROUND_WRITES.has(name) ? null : describeWrite(name, args, about.task)
  const scope = change && noteScope(args)
  const settleWaiting = syncStatus.track(change !== null)
  const clearNote = change && scope ? unconfirmedNote.add(scope, change) : null
  const answered = () => {
    settleWaiting()
    clearNote?.()
  }
  try {
    const sent: Promise<FunctionReturnType<M>> = convex.mutation(mutation, args)
    // beside the chain below, so the callers' timing stays as it was
    sent.then(answered, answered)
    if (name.startsWith('messages:')) {
      inboxWrites.add(sent)
      const settled = () => inboxWrites.delete(sent)
      sent.then(settled, settled)
    }
    return sent
      .then((result) => {
        // Awaited uploads have their own adoption after this promise. Refuse
        // late results here so they cannot restore bytes or rows from a demo
        // that the interface already disposed.
        if (DEMO_MODE && epoch !== storeEpoch)
          throw new ConvexError({ code: 'forbidden', message: 'Your demo has expired.' })
        return result
      })
      .catch((error) => {
        if (DEMO_MODE && epoch === storeEpoch && isDemoLifecycleRefusal(error))
          notifyDemoEnded(error)
        const orgId = args && 'org_id' in args ? args.org_id : undefined
        if (typeof error === 'object' && error !== null) {
          offlineWaits.set(error, settleWaiting())
          if (typeof orgId === 'string') refusedOrgs.set(error, orgId)
        }
        throw error
      })
      .finally(releaseUpdate)
  } catch (error) {
    answered()
    releaseUpdate()
    throw error
  }
}

// Compression, credential hashing and byte uploads span more than one
// mutation. Keep the entire operation protected, including the gaps, from a
// version reload and from a close without warning.
function withUpdateBlock<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const releaseUpdate = beginUpdateBlock()
    const releaseUnsaved = holdUnsaved()
    try {
      return await operation(...args)
    } finally {
      releaseUnsaved()
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

/* --- minted file URLs (phase 7) ---------------------------------------------
   Attachment and avatar bytes serve through the token-checked HTTP gateway
   (/files/<uuid>, /avatars/<uuid> on the Convex site origin); the URLs come
   from files.mintUrls and live ~10 minutes.
   Attachments keep their signed URL; portraits prepare one decoded blob URL
   per `avatar:<profileId>:<storageId>`, the version from the people part's
   profile or the profile cache's face (pictureKey). Renewing an unchanged
   portrait checks access without dropping its source or downloading its
   bytes again. The store mints, renews and downloads only the caller's own
   pictures and those of the people its open pages, pickers and views name
   (wantPictures), in that order; a picture's mint still waiting in the
   queue when no view names it any more is dropped before its call goes,
   and a held picture nobody names keeps its bytes within the budget and
   shows again on one renewal (lib/avatarSources.ts).

   Every mint of the store goes through one queue (lib/mintQueue.ts): at
   most 100 ids a call, two calls at once, attachments and pictures never
   in one call and attachment calls first. The inline images of
   descriptions and comments load through one loader (lib/inlineImages.ts)
   near view, four at a time, behind P.attachmentUrl's row gate. Pictures
   download six at a time within a byte budget (lib/avatarSources.ts
   AVATAR_SOURCES) and repaint the store once a frame. While the page is
   hidden no mint call starts, nothing renews or downloads and no held
   picture is released.

   mintUrls is a QUERY but must be consumed ONE-SHOT (convex.query), never
   subscribed: exp comes from Date.now(), which is not a reactive dependency —
   a subscription would pin a stale exp forever. THIS cache owns refresh
   timing: rebuild() re-primes the named pictures expiring within the skew,
   a sweep covers idle tabs (avatars only; an inline image renews when it
   shows again), and expiry is re-checked here with the same skew the
   server's TTL was designed against. */
const MINT_SKEW = 120_000 // treat as stale this long before expiry
const MINT_SWEEP = 30_000 // access renewal, retry and stale-byte cleanup (avatars)
/** The attachment leases minted keeps, oldest first out. */
const MINTED_MAX = 1_000
const minted = new Map<string, { url: string; exp: number }>() // exp: unix SECONDS
/* Keys primeMint asked the queue for and has not handled the answer of.
   The queue forgets a key when its call answers, and primeMint takes the
   answer in a later microtask, so a rebuild in between would ask again. */
const mintingKeys = new Set<string>()
const mintQueue = createMintQueue(
  (org, ids) => convex.query(api.files.mintUrls, { org_id: org, ...ids }),
  {
    refused: (error) => error instanceof ConvexError,
    // a picture no open view names any more, and that is not one of the
    // caller's own, leaves the queue before its call goes (wantPictures)
    wanted: (request) => request.kind !== 'avatar' || namedPictureKeys.has(request.key),
  },
)
// a picture that waited for room and started by itself repaints as any does
const avatarSources = createAvatarSources({ changed: () => showPortraits() })

/* The people the open views name that the workspace's people part does not
   hold, read by id and kept within PROFILE_CACHE.most (store/profileCache.ts).
   An answer repaints once a frame, as a picture does, and a change of the
   named people moves the wanted pictures (wantPictures). No right reads it:
   P.user and the rights helpers stay on the people part. */
const profileCache = createProfileCache({
  // read at each call, so a module that never names a person needs no live
  // transport
  live: {
    watch: (ref, args) => live.watch(ref, args),
    read: (token) => live.read(token),
    onTransition: (fn, options) => live.onTransition(fn, options),
  },
  held: (org, id) => rows.profiles.get(id)?.org_id === org,
  changed: () => showPortraits(),
  namedChanged: () => wantPictures(),
  watchVisibility,
})

/* The person views P.person answers, by id, shaped in rebuild beside
   P.users from the people part and the cache, each keeping its identity
   while it is unchanged. */
let personViews: ReadonlyMap<string, PersonOk> = new Map()
/* The views of people the store cannot name yet, kept by state and id so
   each keeps its identity. */
const personStates = new Map<string, PersonView>()
const inlineImages = createInlineImages({
  held: (id) => attachmentHeld(id),
  mint: (id, fresh) => attachmentLease(id, fresh),
  forget: (id) => minted.delete(`att:${id}`),
})
let mintSweep: ReturnType<typeof setInterval> | null = null
let fileVisibility: (() => void) | null = null
/* Whether the page is hidden, which holds the pictures and the inline
   images (watchFileVisibility). */
let filesHidden = false
/* One repaint a frame for the pictures that became ready or failed. */
const portraitFrame = frameBatch(() => {
  if (stillLoading !== null) return
  rebuild()
  emit()
})

/* Clears every file URL and byte the store holds: the mint queue, the
   minted attachment leases, the inline images and the pictures, with the
   people the profile cache read, for sign-out, a demo's end and
   reinitialization. */
function clearAvatarSources() {
  mintQueue.clear()
  mintingKeys.clear()
  minted.clear()
  inlineImages.clear()
  profileCache.clear()
  personViews = new Map()
  personStates.clear()
  namedPictures = []
  namedPictureKeys = new Set()
  avatarSources.clear()
  avatarSources.setPersistent(null)
  portraitFrame.cancel()
  if (mintSweep) clearInterval(mintSweep)
  mintSweep = null
}

/** The minted URL for a cache key, or null when absent/expiring. Synchronous
    by construction — callable from rebuild() and every render path. */
function mintedUrl(key: string): string | null {
  const hit = minted.get(key)
  return hit && hit.exp * 1000 - Date.now() > MINT_SKEW ? browserBackendUrl(hit.url) : null
}

/* Keeps attachment lease `lease` of `key`, dropping the expired ones and
   then the oldest past MINTED_MAX. */
function rememberMinted(key: string, lease: { url: string; exp: number }) {
  minted.delete(key)
  minted.set(key, lease)
  if (minted.size <= MINTED_MAX) return
  const now = Date.now() / 1000
  for (const [k, m] of minted) if (m.exp <= now) minted.delete(k)
  for (const k of minted.keys()) {
    if (minted.size <= MINTED_MAX) break
    minted.delete(k)
  }
}

/* The organization to mint attachment `attId` through: its task's, or for
   a file the workspace does not hold, the one the watched task's
   attachments answer or the window's detail names it through, else
   undefined. */
function attachmentOrg(attId: string): string | undefined {
  const rec = rows.attachments.get(attId)
  return rec
    ? rows.issues.get(rec.issue_id)?.org_id
    : (sectionAttachment(attId)?.org ?? detailAttachment(attId)?.org)
}

/* P.attachmentUrl's row gate: whether the store holds attachment `attId`,
   or the watched task's attachments answer or the window's detail names
   it. Every show of an inline image passes it first. */
function attachmentHeld(attId: string): boolean {
  return rows.attachments.has(attId) || !!sectionAttachment(attId) || !!detailAttachment(attId)
}

/* The inline image loader's lease for attachment `attId`, behind the row
   gate: a fresh minted one, or one through the queue (`fresh` skips the
   minted one, after a gateway refusal). Its URL is the browser's. */
async function attachmentLease(attId: string, fresh: boolean): Promise<MintOutcome> {
  watchFileVisibility()
  const org = attachmentHeld(attId) ? attachmentOrg(attId) : undefined
  if (!org) return { state: 'missing' }
  const key = `att:${attId}`
  const hit = fresh ? null : minted.get(key)
  if (hit && hit.exp * 1000 - Date.now() > MINT_SKEW)
    return { state: 'lease', lease: { url: browserBackendUrl(hit.url), exp: hit.exp } }
  if (fresh) minted.delete(key)
  const epoch = storeEpoch
  const outcome = await mintQueue.request({ kind: 'attachment', id: attId, org, key })
  if (epoch !== storeEpoch) return { state: 'failed' }
  if (outcome.state !== 'lease') return outcome
  rememberMinted(key, outcome.lease)
  return { state: 'lease', lease: { ...outcome.lease, url: browserBackendUrl(outcome.lease.url) } }
}

/* The row gate as one check for many ids, for the inline images' sweep
   after a rebuild: the attachments answer's rows and the detail's images
   read once. */
function attachmentGate(): (attId: string) => boolean {
  let listed: Set<string> | null = null
  let named: Set<string> | null = null
  return (attId) => {
    if (rows.attachments.has(attId)) return true
    if (listed === null) {
      const answer = sectionAnswers.attachments
      const watched = sectionsWatched.attachments
      listed = new Set(
        watched &&
          sectionAnswers.issue === watched.task &&
          answer !== null &&
          answer !== CREATING &&
          answer.state === 'ok'
          ? answer.rows.map((r) => r.id)
          : [],
      )
    }
    if (listed.has(attId)) return true
    if (named === null) {
      const text = PLANNER.detail?.view?.description
      named = text ? imageRefs(text) : new Set()
    }
    return named.has(attId.toLowerCase())
  }
}

type MintItem = { kind: 'attachment' | 'avatar'; id: string }

/** Mint URLs for every item that has no fresh one, through the mint queue.
    Resolves true when a displayed source changed — the caller's cue to
    REBUILD (the URLs are baked into the snapshot, so a bare emit is not
    enough). Never rejects: an item that cannot be minted leaves its
    consumer on the "unavailable" state, exactly like the old signing path.
    Items already waiting or on their way share their answer. */
async function primeMint(items: MintItem[]): Promise<boolean> {
  const epoch = storeEpoch
  const work: Promise<boolean>[] = []
  for (const it of items) {
    if (it.kind === 'attachment') {
      // an attachment's organization is its task's (mintUrls omits
      // foreign-org ids)
      const org = attachmentOrg(it.id)
      const key = `att:${it.id}`
      if (!org || mintedUrl(key)) continue
      mintingKeys.add(key)
      work.push(
        mintQueue.request({ kind: 'attachment', id: it.id, org, key }).then((outcome) => {
          mintingKeys.delete(key)
          if (epoch !== storeEpoch || outcome.state !== 'lease') return false
          rememberMinted(key, outcome.lease)
          return true
        }),
      )
      continue
    }
    // avatars are answered across every org I hold a seat in, so they go
    // through the home seat (or any seat, for a guest-only login)
    const key = pictureKey(it.id)
    if (!key) continue
    const org = HOME_ORG || myProfiles.keys().next().value || ''
    if (!org || mintingKeys.has(key) || !avatarSources.needsRefresh(key)) continue
    const ticket = avatarSources.ticket(key)
    mintingKeys.add(key)
    work.push(
      mintQueue.request({ kind: 'avatar', id: it.id, org, key }).then(async (outcome) => {
        // prepare marks the key pending before its first await, so no
        // rebuild can ask for it again in between
        mintingKeys.delete(key)
        // no view names it any more, which is no failure, and a view that
        // names it again mints it at once
        if (epoch !== storeEpoch || outcome.state === 'dropped') return false
        if (outcome.state === 'refused' || outcome.state === 'failed') {
          if (outcome.state === 'failed') console.warn('[qivo] url mint failed:', key)
          return avatarSources.failure(key, outcome.state === 'refused', ticket)
        }
        const lease = outcome.state === 'lease' ? outcome.lease : null
        // invisible/missing ids are silently OMITTED from the answer (the
        // portrait shows initials; no existence oracle). A snapshot
        // replacement can overtake either the mint or its byte fetch:
        // never attach a newer storage version to an old key.
        if (!lease || new URL(lease.url).searchParams.get('v') !== key.split(':').at(-1)) {
          if (avatarSources.failure(key, true, ticket)) showPortraits()
          return false
        }
        // One slow portrait must not hold the roster's ready faces.
        if (
          (await avatarSources.prepare(
            key,
            { ...lease, url: browserBackendUrl(lease.url) },
            ticket,
          )) &&
          epoch === storeEpoch
        )
          showPortraits()
        return false
      }),
    )
  }
  if (!work.length) return false
  return (await Promise.all(work)).some(Boolean)
}

/** Shows the portraits that became ready or failed, once a frame however
    many there are. While the task windows an ask subscribed are on their
    way, they wait for the next paint, which rebuilds from them: each one
    would repaint the whole workspace while the parts still to come need
    the page (store/liveParts.ts). */
function showPortraits() {
  portraitFrame.schedule()
}

/* The key of person `id`'s uploaded picture, `avatar:<profile id>:<storage
   id>`, from the people part's profile or the cache's face, or null for a
   person without one or not known. */
function pictureKey(id: string): string | null {
  const version =
    rows.profiles.get(id)?.avatar_storage_id ??
    (() => {
      const known = profileCache.look(id)
      return known.state === 'face' ? known.face.avatar : null
    })()
  return version ? `avatar:${id}:${version}` : null
}

/* The picture keys the store mints, renews and downloads, in order: the
   caller's own seats first, then the people the open views name
   (profileCache named), and the same keys as a set, which the mint queue
   asks before each call so a picture no view names any more is not
   minted. */
let namedPictures: { id: string; key: string }[] = []
let namedPictureKeys: ReadonlySet<string> = new Set()

/* Follows the people the open views name with the wanted pictures: hands
   their keys to the picture source in order and mints the due ones. The
   caller's own seats always count as named, since the app shows the
   caller's portrait on pages that name nobody, such as Settings › Account
   after an upload, the comment composer and the phone's header. */
function wantPictures() {
  const next: { id: string; key: string }[] = []
  const seen = new Set<string>()
  for (const id of [...myProfileSet, ...profileCache.named().map((person) => person.id)]) {
    if (seen.has(id)) continue
    seen.add(id)
    const key = pictureKey(id)
    if (key) next.push({ id, key })
  }
  const same =
    next.length === namedPictures.length && next.every((p, i) => p.key === namedPictures[i]?.key)
  namedPictures = next
  if (!same) {
    namedPictureKeys = new Set(next.map((p) => p.key))
    avatarSources.named(next.map((p) => p.key))
  }
  if (next.length > 0) startMintSweep()
  const need = picturesDue()
  if (need.length)
    void primeMint(need).then((grew) => {
      if (grew) showPortraits()
    })
}

/* The named pictures that need a mint now, in the named order. */
function picturesDue(): MintItem[] {
  if (filesHidden) return []
  const need: MintItem[] = []
  for (const { id, key } of namedPictures)
    if (avatarSources.needsRefresh(key)) need.push({ kind: 'avatar', id })
  return need
}

/* One sweep: releases pictures past their grace and mints the due ones. */
function sweepPictures() {
  if (filesHidden) return
  if (avatarSources.expire()) showPortraits()
  const need = picturesDue()
  if (need.length)
    void primeMint(need).then((grew) => {
      if (grew) showPortraits()
    })
}

/** Holds the mint queue, the pictures and the inline images while the
    page is hidden (lib/viewVisibility.ts, by visibility and not focus): no
    mint call starts, the sweep and the rebuild's prime skip, no picture is
    released, and no inline image starts a mint or a download. The calls
    and downloads on their way finish. On return the waiting mints go, the
    due pictures mint once, renewing the held ones without downloading
    them again, and the near images ask again. Started with the first
    picture or inline image, it lasts as long as the page. */
function watchFileVisibility() {
  if (fileVisibility) return
  fileVisibility = watchVisibility(({ visible }) => {
    const resumed = filesHidden && visible
    filesHidden = !visible
    mintQueue.pause(!visible)
    avatarSources.pause(!visible)
    inlineImages.pause(!visible)
    if (resumed) sweepPictures()
  })
}

/** Re-mint before anything goes stale. A rebuild already primes, but a tab
    nobody touches would otherwise watch its faces disappear at the TTL. */
function startMintSweep() {
  watchFileVisibility()
  if (mintSweep || typeof setInterval !== 'function') return
  mintSweep = setInterval(sweepPictures, MINT_SWEEP)
}

/* Agent-key rows live outside the snapshot but their mutations are
   orgMutations: remember which organization each listed key's agent belongs
   to, so revoke/delete (which take only the key id) can name the right seat. */
const agentKeyOrg = new Map<string, string>()

const preferences = createPreferences({
  profileId: () => CURRENT_USER,
  read: () => convex.query(api.prefs.get, {}),
  write: (profileId, prefs) =>
    sendAwaited(api.prefs.save, { profile_id: profileId, prefs }, 'none'),
  storage: () => localStorage,
  beginUpdate: beginUpdateBlock,
})

/* --- identity ---------------------------------------------------------------
   CURRENT_USER is the HOME profile (the org this person belongs to) — the one
   "me" every existing surface means. `myProfiles` maps org → my profile there,
   so a write into a foreign org is attributed to the guest profile that org
   knows, never to the home one (which it cannot even see). Re-derived from
   every snapshot delivery: the root part carries auth_user_id + myProfileIds
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
/* Each person's teams as a set, so a project's few team shares are checked
   against them instead of walking hundreds of teams for every project. */
const teamSets = new WeakMap<UserVM, Set<string>>()
const teamSetOf = (user: UserVM): Set<string> => {
  let teams = teamSets.get(user)
  if (teams === undefined) {
    teams = new Set(user.teams)
    teamSets.set(user, teams)
  }
  return teams
}
const grantOnProject = (p: ProjectGrants, user: UserVM): string | null => {
  let level = p.access?.[user.id] || null
  if (user.orgRole === 'admin' || user.orgRole === 'user' || user.orgRole === 'viewer') {
    const teams = teamSetOf(user)
    for (const [teamId, teamLevel] of Object.entries(p.teamAccess ?? {})) {
      if (teams.has(teamId) && rows.teams.get(teamId)?.org_id === p.org) {
        level = higherLevel(level, teamLevel || null)
      }
    }
  }
  return level
}
/* The level of `uid` (me by default) on `p` by ordinary access, the rule of
   convex/lib/access.ts levelUnder: the lead role, the person's own grant and
   their teams' shares on the project and its parent. An organization admin
   is judged by their own rows like anyone; only the management rule
   (P.canManageOwnProjectAccess) knows the role. */
const levelOnProject = (
  p: ProjectGrants | null | undefined,
  uid?: string,
  projectById: (id: string) => ProjectVM | undefined = (id) => PLANNER.project(id),
): string | null => {
  if (!p) return null
  const user = actorIn(p.org, uid)
  if (!user?.active) return null
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
  PLANNER.comments = keepItems(
    PLANNER.comments,
    [...rows.comments.values()]
      .map(shapeComment)
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)),
  )
  // oldest first
  PLANNER.threadEvents = keepItems(
    PLANNER.threadEvents,
    rows.threadEvents.map((e) => shapeActivity(e, uuidToKey)).sort((a, b) => a.ts - b.ts),
  )
  PLANNER.commentsEarlier =
    !PLANNER.commentsLoaded || threadStart ? 'none' : earlierLoad === 'idle' ? 'more' : earlierLoad
  PLANNER.historyEarlier =
    !PLANNER.historyLoaded || historyStart ? 'none' : historyLoad === 'idle' ? 'more' : historyLoad
  PLANNER.commentsNewer =
    !PLANNER.commentsLoaded || commentsGap === null
      ? 'none'
      : newerLoad === 'idle'
        ? 'more'
        : newerLoad
  PLANNER.historyNewer =
    !PLANNER.historyLoaded || historyGap === null
      ? 'none'
      : historyNewerLoad === 'idle'
        ? 'more'
        : historyNewerLoad
  PLANNER.threadGap = threadGapOf(PLANNER.threadGap)
  PLANNER.pinnedComments = keep(
    PLANNER.pinnedComments,
    [...pinnedComments.keys()].filter((id) => rows.comments.has(id)),
  )
  PLANNER.threadApart = keep(PLANNER.threadApart, [...apartComments.keys(), ...apartEvents.keys()])
}

/* Each kind's gap as the window places it (P.threadGap): the latest time
   kept above it, the earliest kept below it and the ids kept above, from
   the anchors, or null with no gap in either kind. `prev` comes back while
   nothing changed, so a repaint that leaves the gap alone shows the same
   value (shownWorkspace). */
function threadGapOf(prev: ThreadGap | null): ThreadGap | null {
  const side = (
    gap: string[] | null,
    above: { id: string; at: string }[],
    below: { at: string }[],
    was: ThreadGapSide | null | undefined,
  ): ThreadGapSide | null => {
    if (gap === null) return null
    const end = above.reduce((max, r) => Math.max(max, Date.parse(r.at)), Number.NEGATIVE_INFINITY)
    const first = below.reduce(
      (min, r) => Math.min(min, Date.parse(r.at)),
      Number.POSITIVE_INFINITY,
    )
    if (
      was &&
      was.end === end &&
      was.below === first &&
      was.above.size === above.length &&
      above.every((r) => was.above.has(r.id))
    )
      return was
    return { end, below: first, above: new Set(above.map((r) => r.id)) }
  }
  const atOf = (r: Row<'comments'>) => ({ id: r.id, at: r.created_at })
  const atOfChange = (r: Row<'activity_events'>) => ({ id: r.id, at: r.ts })
  const comments = side(
    commentsSnap === null ? null : commentsGap,
    olderComments.map(atOf),
    [...newerComments, ...(commentsSnap ?? [])].map(atOf),
    prev?.comments,
  )
  const history = side(
    historySnap === null ? null : historyGap,
    olderEvents.map(atOfChange),
    [...newerEvents, ...(historySnap ?? [])].map(atOfChange),
    prev?.history,
  )
  if (comments === null && history === null) return null
  if (prev && prev.comments === comments && prev.history === history) return prev
  return { comments, history }
}

/** Rebuilds every view model from the rows. The tasks reshape only where
    the rows changed since the last rebuild (store/taskIndex.ts update),
    and from scratch (full) with `full`, a new day, a moved week grid,
    another identity or a change too wide for one update. */
function rebuild(now = new Date(), full = false) {
  const P = PLANNER
  const gridBefore = P.TIMELINE_START?.getTime()
  const todayBefore = P.TODAY_ISO
  // the people the workspace holds now are read by id no more, and those
  // it stopped holding are
  profileCache.sync()
  syncPictureKeys()

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
  P.users = keepItems(
    P.users,
    [...rows.profiles.values()]
      // people created together, as a seeded workspace's are, by name
      .sort(
        (a, b) =>
          byStamp(a.created_at, '', b.created_at, '') ||
          a.name.localeCompare(b.name) ||
          byStamp('', a.id, '', b.id),
      )
      .map((u) =>
        shapeUser(
          u,
          teamsByProfile.get(u.id) || [],
          leadsByProfile.get(u.id) || [],
          avatarSources.url(`avatar:${u.id}:${u.avatar_storage_id}`),
          DEMO_MODE,
        ),
      ),
  )
  personViews = shapePersonViews(personViews)

  // org — P.org IS the home org (the one whose settings the app runs on);
  // identity is the HOME org's (empty for a guest-only login), the display
  // settings fall back to a visible org's — see shapeOrg
  P.org = keep(P.org, shapeOrg(home, displayOrg, rows.billing))
  P.homeOrg = HOME_ORG
  // an answer without it, from an older backend, keeps the create entry
  P.orgCreate = base.scalars()?.create ?? 'now'
  P.orgs = keepItems(
    P.orgs,
    [...rows.orgs.values()]
      .map(shapeOrgRef)
      .sort((a, b) =>
        a.id === HOME_ORG
          ? -1
          : b.id === HOME_ORG
            ? 1
            : a.name.localeCompare(b.name) || byStamp('', a.id, '', b.id),
      ),
  )
  P.myProfileIds = keep(P.myProfileIds, [...myProfileSet])

  // teams
  // name tiebreak: seeded teams share one transaction-stable created_at,
  // and without it the order follows the DB's arbitrary physical row order
  P.teams = keepItems(
    P.teams,
    [...rows.teams.values()]
      .sort(
        (a, b) =>
          byStamp(a.created_at, '', b.created_at, '') ||
          a.name.localeCompare(b.name) ||
          byStamp('', a.id, '', b.id),
      )
      .map(shapeTeam),
  )

  // labels (one shared, curated list per ORGANIZATION since 0078 — a task
  // keeps its labels wherever in the org it moves)
  const labelsBefore = P.labels
  P.labels = keepItems(
    P.labels,
    [...rows.labels.values()]
      .sort((a, b) => byStamp(a.name.toLowerCase(), a.id, b.name.toLowerCase(), b.id))
      .map(shapeLabel),
  )
  if (P.labels !== labelsBefore) {
    const labelById: Record<string, LabelVM> = {}
    P.labels.forEach((l) => {
      labelById[l.id] = l
    })
    P.labelById = labelById
  }
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
  P.projects = keepItems(
    P.projects,
    allShapes.filter((s) => s.archivedAt == null),
  )
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
  P.archivedProjects = keepItems(
    P.archivedProjects,
    allShapes
      .filter((s) => s.archivedAt != null)
      .flatMap((s) => {
        const meta = s.type === 'meta' ? s : s.parent ? shapeOf(s.parent) : undefined
        const level = levelOnProject(s, undefined, shapeOf) ?? (viaSubProject(s) ? 'viewer' : null)
        return level ? [shapeArchivedProject(s, meta, level === 'lead')] : []
      })
      .sort(
        (a, b) =>
          (b.archivedAt || 0) - (a.archivedAt || 0) ||
          a.name.localeCompare(b.name) ||
          byStamp('', a.id, '', b.id),
      ),
  )
  P.projectTags = keep(P.projectTags, duplicateNameTags(P.projects, P.archivedProjects))

  // tasks — their handles, view models, delays and load, reshaped only where
  // a change reaches them (store/taskIndex.ts). Numbers are per ORG (0050),
  // so a blended snapshot (0081) can hold two "QN-5": the HANDLE keeps the
  // app's references unique while `keyByOrg` resolves an org-prefixed URL
  // to the exact one. Projected delays (0064) walk each visible task's
  // finish week against its effective owner's org-wide free capacity
  // (plan_org_load): the reviewer while the task waits In Review, else the
  // assignee (#314), with the owner's own plannable week (0092).
  const sources = taskSources()
  const dirty = workspaceRows.takeDirty()
  const identity = `${HOME_ORG}\u0000${[...myProfileSet].join()}`
  const whole =
    full ||
    identity !== lastIdentity ||
    gridBefore !== TIMELINE_START.getTime() ||
    todayBefore !== TODAY_ISO
  lastIdentity = identity
  const changes = taskChangesOf(dirty)
  // who can open what, which a uuid every seat said unavailable for is
  // read again after (syncRefRead)
  refAccessMoved ||=
    whole ||
    dirty.keys.has('projects') ||
    dirty.keys.has('profiles') ||
    dirty.lists.has('access') ||
    dirty.lists.has('teamAccess') ||
    dirty.lists.has('teamMembers')
  // the tasks taken for groups with subtasks to come, and for subtasks of
  // parents to come, change while loading
  if (
    sources.hiddenSubtaskParents !== lastSubtaskParents ||
    sources.hiddenParentTasks !== lastHiddenParents
  )
    changes.flags = true
  lastSubtaskParents = sources.hiddenSubtaskParents
  lastHiddenParents = sources.hiddenParentTasks
  const moved = whole ? null : tasks.update(sources, changes)
  if (moved) lastMoves = moved
  else {
    lastMoves = tasks.full(sources)
    committedByOwner.clear()
  }
  if (HOME_ORG !== lastHome) lastMoves = withUnheldMoves(lastMoves, lastHome)
  lastHome = HOME_ORG
  lastMoves = refMoves(lastMoves)
  // the delays held back until every task is held (delayOf) show now: the
  // tasks that show one paint again
  if (rebuiltLoading && tasksAll) {
    const shown = [...tasks.delays].filter(([, d]) => DELAY_COLORS[d.status] !== null)
    tasks.renew(shown.map(([uuid]) => uuid))
  }
  rebuiltLoading = !tasksAll
  P.issues = tasks.issues()
  P.issueById = tasks.issueById()
  if (STRICT_LAYERS && !unchecked) checkTasks(sources)

  // comments — the watched issue's only (oldest first, like its history; the
  // discussion spine reverses for newest-first display). Ties on the insert
  // timestamp order by id so two optimistic rows can't swap on redelivery.
  rebuildComments()
  // the watched task's sections, which merge the rows on screen with their
  // answers, after the tasks they read
  rebuildSections()

  // inbox messages (0074) — own rows only, newest first (shapeMessage)
  P.messages = keepItems(
    P.messages,
    [...rows.messages.values()]
      .map((message) => shapeMessage(message, { issues: rows.issues, uuidToKey, uuidToDisplayKey }))
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1)),
  )

  // …folded into inbox ITEMS, one per task (0109) — see shapeMessageGroup.
  // Every row here is already the signed-in user's, so the task uuid alone
  // identifies the item; `ts` is the newest message's, so news floats it up.
  const groups = new Map<string, MessageVM[]>()
  P.messages.forEach((m) => {
    const g = groups.get(m.issueUuid)
    if (g) g.push(m)
    else groups.set(m.issueUuid, [m])
  })
  P.messageGroups = keepItems(
    P.messageGroups,
    [...groups.entries()]
      .map(([issueUuid, newestFirst]) => shapeMessageGroup(issueUuid, newestFirst))
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1)),
  )
  // the loaded groups that are unread and not snoozed (P.unreadMessages),
  // which no view reads, since the badge counts from the unread summary
  P.unreadMessages = P.messageGroups.reduce((n, g) => n + (g.read || g.snoozed ? 0 : 1), 0)
  P.readMessageCount =
    hiddenReadMessages +
    P.messages.filter((message) => message.read && message.snoozedUntil === null).length
  // Mark all as read and Remove all read follow the unread summary, whose
  // rule reads the seats this repaint may have changed
  deriveInboxFlags()
  // the inbox part delivers at most 500 messages, so these say when older
  // ones exist that it did not send, snoozed ones included, and whether
  // Mark all as read and Remove all read reach them (they skip snoozed
  // rows); no view reads them, as the Inbox lists inbox.page
  P.inboxCutReach = {
    markAllRead: unexaminedUnread,
    removeRead: hiddenReadMessages > 0 || unexaminedRead,
  }
  P.inboxCut = messagesCut || P.inboxCutReach.markAllRead || P.inboxCutReach.removeRead

  P.CURRENT_USER = CURRENT_USER
  const context = [
    P.org,
    P.orgs,
    P.myProfileIds,
    P.teams,
    P.labels,
    P.projects,
    P.archivedProjects,
    P.projectTags,
    P.CURRENT_USER,
    P.homeOrg,
    P.gridEpoch,
    P.TODAY_ISO,
    P.TODAY_POS,
    // the people the cache names and paints beside the people part, and
    // its states: a person read by id whose answer left them out or whose
    // read failed changes no view of personViews unless a picker named
    // them, but every memoized row that drew them loading draws them again
    personViews,
    profileCache.version(),
  ]
  // a Team sync stamp (UserVM.sync) gives P.users a new identity, but no row
  // that compares contextVersion reads it; Team sync compares its own since
  const people =
    P.users === lastContextUsers ||
    sameData(withoutStamps(lastContextUsers), withoutStamps(P.users))
  if (!people || context.some((part, i) => part !== lastContext[i]))
    P.contextVersion = Object.freeze({ revision: P.contextVersion.revision + 1 })
  lastContext = context
  lastContextUsers = P.users

  // the views' delays read the day, and their models' week indexes the
  // grid (reshapeViews): a rebuild for a new day or a moved grid judges and
  // shapes them again, which the next emit shows
  const newDay = gridBefore !== TIMELINE_START.getTime() || todayBefore !== TODAY_ISO
  if (newDay && viewRows.any() && reshapeViews()) viewReadsChanged = true

  // Uploaded pictures prepare shared decoded sources after minting access.
  // A prepared portrait is baked into this snapshot, so fresh mints have to
  // land through a REBUILD or the freshly-minted URL sits in the cache
  // unread. The second pass finds nothing left to mint and stops there. Only
  // avatars pre-mint: attachment URLs are minted on demand (attachmentUrl),
  // because only the open issue's inline images ever render eagerly, while
  // avatars render by the dozen per board. Only the caller's own pictures
  // and those the open views name prime, in that order, and while the page
  // is hidden the pictures hold and nothing primes.
  wantPictures()
  // the inline images out of reach whose files the rows no longer hold
  // drop their bytes, and near ones a clear left waiting ask again
  inlineImages.retain(attachmentGate())
}

/* Whether `person` is someone whose name has not loaded: on its way or
   after a failed read, which a text filter cannot tell from a match. */
export const nameUnknown = (person: PersonView | null) =>
  person !== null && (person.state === 'loading' || person.state === 'failed')

/* What the last rebuild's contextVersion was taken from. */
let lastContext: unknown[] = []
let lastContextUsers: UserVM[] = []

/* Hands the picture source the keys the store knows, every profile of the
   people part and every face of the cache with a picture, and the profiles
   it knows with none, by which the persistent cache prunes. */
function syncPictureKeys() {
  const keys: string[] = []
  const without: string[] = []
  for (const profile of rows.profiles.values()) {
    if (profile.avatar_storage_id) keys.push(`avatar:${profile.id}:${profile.avatar_storage_id}`)
    else without.push(profile.id)
  }
  for (const { face } of profileCache.faces()) {
    if (rows.profiles.has(face.id)) continue
    if (face.avatar) keys.push(`avatar:${face.id}:${face.avatar}`)
    else without.push(face.id)
  }
  avatarSources.sync(keys, without)
}

/* The person views of the people part's people (from P.users) and of the
   cache's faces and names, each keeping its identity from `prev` while it
   is unchanged, so the views P.person answers stay the same objects. */
function shapePersonViews(prev: ReadonlyMap<string, PersonOk>): ReadonlyMap<string, PersonOk> {
  const next = new Map<string, PersonOk>()
  const put = (view: PersonOk) => {
    const was = prev.get(view.id)
    next.set(view.id, was ? keep(was, view) : view)
  }
  for (const u of PLANNER.users) put(personOfUser(u))
  for (const { org, face } of profileCache.faces())
    if (!next.has(face.id))
      put(
        personOfFace(
          org,
          face,
          face.avatar ? avatarSources.url(`avatar:${face.id}:${face.avatar}`) : null,
        ),
      )
  for (const { org, name, reading } of profileCache.names())
    if (!next.has(name.id)) put(personOfName(org, name, reading))
  if (next.size === prev.size && [...next].every(([id, view]) => prev.get(id) === view)) return prev
  return next
}

/** `users` without their Team sync stamps, for contextVersion. */
const withoutStamps = (users: readonly UserVM[]) => users.map(({ sync: _sync, ...user }) => user)

/** -1, 0 or 1 as `a` sorts before, with or after `b`: by stamp, then id. */
const byStamp = (a: string, aId: string, b: string, bId: string) =>
  a < b ? -1 : a > b ? 1 : aId < bId ? -1 : aId > bId ? 1 : 0

/* The home organization and the signed-in person's profiles the tasks were
   last shaped for; another shapes them all again. */
let lastIdentity = ''
/* The home organization the handles were last given under. */
let lastHome = ''

/** `moved`, the handles the task index moved, with the one a change of the
    home organization from `homeBefore` moved for the task a window shows
    from its own read (P.taskDetail), which the index does not hold. The
    index reports only its own tasks (store/taskIndex.ts full), and a
    window on that task must go on following it by its uuid and
    organization (P.watchHandles), never take the task of the new home
    organization that now has its old handle. A reference names its
    organization by id (lib/taskReference.ts), so none moves. */
function withUnheldMoves(moved: ReadonlyMap<string, string>, homeBefore: string) {
  const shown = unheldWatched()
  if (!shown || uuidToKey.has(shown.uuid)) return moved
  const key = `${ISSUE_PREFIX}-${shown.num}`
  const from = handleUnder(homeBefore, shown.uuid, shown.org, key)
  const to = handleUnder(HOME_ORG, shown.uuid, shown.org, key)
  return from === to || moved.has(from) ? moved : new Map(moved).set(from, to)
}

/* The watched task the workspace does not hold, by its uuid, organization
   and number: from the window's own read (P.detail), else as the
   workspace last held it (watchedHeld), or null. */
function unheldWatched(): { uuid: string; org: string; num: number } | null {
  const t = watchedComments
  if (!t || watchedRow()) return null
  const detail = PLANNER.detail
  if (detail?.task === t && detail.num != null) return { uuid: t, org: detail.org, num: detail.num }
  return watchedHeld?.uuid === t ? watchedHeld : null
}

/** The rows and facts the task index shapes the tasks from. */
function taskSources(): TaskSources {
  return {
    issues: rows.issues,
    links: rows.links,
    attachments: rows.attachments,
    labels: rows.labels,
    issueLabels: rows.issueLabels,
    issueSubs: rows.issueSubs,
    orgLoad: rows.orgLoad,
    projects: rows.projects,
    profiles: rows.profiles,
    hiddenSubtaskParents: subtaskParentsNow(),
    hiddenParentTasks: hiddenParentsNow(),
    homeOrg: HOME_ORG,
    mine: myProfileSet,
    // indexed once: P.user is a linear scan
    capacity: new Map(PLANNER.users.map((u) => [u.id, plannableHoursOf(u)])),
    defaultCapacity: DEFAULT_PLANNABLE_HOURS,
  }
}

/* Whether the last rebuild was before the workspace held every task. */
let rebuiltLoading = false
/* The Sets the last rebuild took for hiddenSubtaskParents and
   hiddenParentTasks. */
let lastSubtaskParents: ReadonlySet<string> = new Set()
let lastHiddenParents: ReadonlySet<string> = new Set()

/** The tasks with subtasks this person is not shown. Until the workspace
    holds every task (tasksAll), they include every held task the server
    says has subtasks (has_subtasks), as theirs may be still to come, such
    as the subtasks of a new task's parent the workspace does not hold: a
    parent never shows as a leaf, nor a group as done or with known
    progress, before every task arrived. A Set is kept while it holds the
    same tasks. */
function subtaskParentsNow(): ReadonlySet<string> {
  const hidden = rows.hiddenSubtaskParents
  if (tasksAll) return hidden
  const next = new Set(hidden)
  for (const [uuid, row] of rows.issues) if (row.has_subtasks) next.add(uuid)
  return sameData(next, lastSubtaskParents) ? lastSubtaskParents : next
}

/** The tasks whose parent this person is not shown. Until the workspace
    holds every task, they include every held subtask whose parent is still
    to come (parentLoading), such as the person's new subtask of a task
    only a window's answer brings: such a task never reads as one without a
    parent, nor is offered as a parent. A Set is kept while it holds the
    same tasks. */
function hiddenParentsNow(): ReadonlySet<string> {
  const hidden = rows.hiddenParentTasks
  if (tasksAll) return hidden
  const next = new Set(hidden)
  for (const [uuid, row] of rows.issues)
    if (row.parent_id && !rows.issues.has(row.parent_id)) next.add(uuid)
  return sameData(next, lastHiddenParents) ? lastHiddenParents : next
}

/** What the rows say changed since the last rebuild, as the task index
    reads it. */
function taskChangesOf(dirty: ReturnType<typeof workspaceRows.takeDirty>): TaskChanges {
  const keys = (name: 'issues' | 'links' | 'attachments' | 'projects' | 'profiles') =>
    dirty.keys.get(name) ?? new Set()
  return {
    issues: keys('issues'),
    links: keys('links'),
    attachments: keys('attachments'),
    projects: keys('projects'),
    profiles: keys('profiles'),
    labels: dirty.keys.has('labels'),
    issueLabels: dirty.lists.has('issueLabels'),
    issueSubs: dirty.lists.has('issueSubs'),
    orgLoad: dirty.lists.has('orgLoad'),
    flags: dirty.flags,
  }
}

/** Test builds only (STRICT_LAYERS): the tasks a rebuild kept up to date
    must hold exactly what a full build from the same rows gives, so a
    change the update missed fails the test that made it. */
function checkTasks(sources: TaskSources) {
  const fresh = createTaskIndex()
  fresh.full(sources)
  const parts = [
    ['issues', tasks.issues(), fresh.issues()],
    ['issueById', tasks.issueById(), fresh.issueById()],
    ['delays', tasks.delays, fresh.delays],
    ['load', tasks.loads(), fresh.loads()],
    ['handles', tasks.uuidToKey, fresh.uuidToKey],
    ['keys', tasks.keyToUuid, fresh.keyToUuid],
    ['display keys', tasks.uuidToDisplayKey, fresh.uuidToDisplayKey],
    ['keys by organization', tasks.keyByOrg, fresh.keyByOrg],
  ] as const
  for (const [name, kept, built] of parts) {
    if (sameData(kept, built)) continue
    // the first entry that differs, for the test's message
    const entries = (value: unknown): [string, unknown][] =>
      value instanceof Map ? [...value] : Object.entries(value as object)
    const other = new Map(entries(built))
    const first = entries(kept).find(([key, item]) => !sameData(item, other.get(key)))
    const field =
      first?.[1] && typeof first[1] === 'object'
        ? Object.keys(first[1]).find(
            (key) =>
              !sameData(
                (first[1] as Record<string, unknown>)[key],
                (other.get(first[0]) as Record<string, unknown> | undefined)?.[key],
              ),
          )
        : undefined
    throw new Error(
      `the tasks' ${name} differ from a full rebuild${first ? ` at ${first[0]}${field ? `.${field}` : ''}: ${JSON.stringify(first[1])?.slice(0, 300)} versus ${JSON.stringify(other.get(first[0]))?.slice(0, 300)}` : ''}`,
    )
  }
}

/* --- email addresses ------------------------------------------------------
   One rule, the server's (convex/lib/email.ts cleanEmail): an address the
   mail sender can send to and a password login can use, trimmed,
   lowercased, with a Unicode domain written as punycode, at most
   LIMITS.email.max characters. Every write stores that form; null is an
   empty or unusable address. */
const normalizeEmail = (v: unknown): string | null => cleanEmail(String(v ?? ''))

/** Why `v`, which normalizeEmail refused, cannot be a person's address: the
    server's sentence when its stored form is too long or cannot get a
    password login. */
const emailRefusal = (v: unknown): string => {
  const why = storedEmailRefusal(String(v ?? ''))
  return why === null ? 'Enter an email address for sign-in.' : asSentence(why)
}

/* --- sub-issue remaining rollup (0066) — the optimistic mirror ------------
   A task that gains a subtask of organization `org` loses its own hours,
   at `at`. A parent is of its subtask's organization, so a held task of
   another organization with the parent's id keeps its hours. */
function clearParentHours(parentUuid: string | null | undefined, at: string, org: string) {
  const pRow = parentUuid ? rows.issues.get(parentUuid) : null
  if (pRow?.org_id === org && (pRow.remaining_hours != null || pRow.review_at != null)) {
    pRow.remaining_hours = undefined
    pRow.remaining_set_at = undefined // the server stamp pairs the two (0072)
    pRow.review_at = undefined // a group has no review hand-off of its own
    pRow.updated_at = at // the server-side clear fires the touch too
  }
}

/* Every visible task under `it`, once each, at any depth. The seen set keeps
   a corrupt parent cycle from hanging the client. Subtasks outside this view
   are not in the snapshot, so they are never visited. */
function eachDescendant(
  it: IssueVM,
  visit: (child: IssueVM) => void,
  byId: Readonly<Record<string, IssueVM>> = PLANNER.issueById,
) {
  const seen = new Set([it.id])
  const stack = [...it.children]
  while (stack.length) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const child = byId[id]
    if (!child) continue
    visit(child)
    stack.push(...child.children)
  }
}

/* --- issue field mapping (app patch -> DB patch) ------------------------------ */
// A title as the server stores it, trimmed. One over LIMITS.title is refused
// before it gets here (refuseOver), never cut.
const cleanTitle = (t: unknown) => String(t ?? '').trim()

/* The app-side patch: camelCase fields, week INDEXES for dates, null (or ''
   for remaining) meaning clear — what every issue-editing surface hands
   updateIssue/addIssue. Status/priority stay derived from the schema row so
   a widened enum needs no edit here. */
/** Access about to be removed: a person's or a team's grant on one project
    (project settings), a member leaving a team, or a team being deleted
    (Team settings). A grant's `orgId` is the project's organization as the
    page that pressed showed it (projectSettings.get), which the removal's
    reads and write take before the workspace's, so a project the workspace
    does not hold previews, reassigns and removes; without it the
    organization comes from the workspace (removalOrg). `topLevel` is
    whether the page showed a top-level project, which the window's Keep
    text reads where the preview does not name the project (P.keepText).
    Build a grant's change with grantRemoval, so a press and its `checking`
    name it alike. */
export type AccessRemoval = (
  | { kind: 'userGrant'; projectId: string; userId: string; orgId?: string; topLevel?: boolean }
  | { kind: 'teamGrant'; projectId: string; teamId: string; orgId?: string; topLevel?: boolean }
  | { kind: 'teamMember'; teamId: string; userId: string; orgId?: string }
  | { kind: 'deleteTeam'; teamId: string; orgId?: string }
) & {
  /** the person's or team's name as the page showed it, which the removal
      window and the store's sentences name them by; a press and its check
      are told apart without it (removalKey, useAccessRemoval) */
  label?: string
}

/** The removal of a person's (`user`) or a team's grant `id` on project
    `projectId` of organization `orgId`, top-level or not as `topLevel`
    says, named `label` as the page showed them (a press names it; a check
    of whether one is on its way needs none), with its keys always in the
    same order, as useAccessRemoval tells a press apart by the change's
    JSON without its label. */
export function grantRemoval(
  kind: 'team' | 'user',
  projectId: string,
  id: string,
  orgId: string,
  topLevel: boolean,
  label?: string,
): Extract<AccessRemoval, { kind: 'userGrant' | 'teamGrant' }> {
  const named = label === undefined ? {} : { label }
  return kind === 'team'
    ? { kind: 'teamGrant', projectId, teamId: id, orgId, topLevel, ...named }
    : { kind: 'userGrant', projectId, userId: id, orgId, topLevel, ...named }
}

/** The removal of member `userId` from team `teamId`, or with no member the
    team's deletion, of organization `orgId` as the page showed it, named
    `label`, the member's or the team's name as the page showed it, with
    its keys always in the same order (grantRemoval). The removal goes to
    `orgId` whether or not the store holds the team. */
export function teamRemoval(
  teamId: string,
  userId: string | null,
  orgId: string,
  label: string,
): Extract<AccessRemoval, { kind: 'teamMember' | 'deleteTeam' }> {
  return userId === null
    ? { kind: 'deleteTeam', teamId, orgId, label }
    : { kind: 'teamMember', teamId, userId, orgId, label }
}

/** The server's preview of a removal (accessRemovals.preview,
    convex/model/removalPreview.ts): unavailable, refused or too large to
    check, each with the server's sentence, or `ok` with who loses sight of
    which open tasks and whether the caller may keep them as Viewers or
    reassign them. */
export type RemovalPreview = FunctionReturnType<typeof api.accessRemovals.preview>
/** A preview the removal window shows (P.startRemoval). */
export type RemovalAnswer = Extract<RemovalPreview, { state: 'ok' }>
/** One answer of the Reassign picker's read (accessRemovals.reassignChoices). */
export type ReassignChoices = FunctionReturnType<typeof api.accessRemovals.reassignChoices>
/** A person the Reassign picker lists. */
export type ReassignChoice = Extract<ReassignChoices, { state: 'ready' }>['rows'][number]
/** A project's settings as the server reads them (projectSettings.get). */
export type ProjectSettingsAnswer = FunctionReturnType<typeof api.projectSettings.get>

/** How P.resolveProject names a project: its id, or its organization and
    its number there, as a project address names it. */
export type ProjectAsk = string | { org_id: string; num: number }

/** What projectNav.resolve answers (P.resolveProject). */
export type ProjectResolved = FunctionReturnType<typeof api.projectNav.resolve>
/** One page of Settings › Users as the server reads it (people.settingsPage). */
export type PeoplePageAnswer = FunctionReturnType<typeof api.people.settingsPage>
/** One person as Settings › Users shows them (people.get). */
export type PersonSettingsAnswer = FunctionReturnType<typeof api.people.get>
/** A person row of Settings › Users (people.settingsPage and people.get). */
export type SettingsPersonRow = Extract<PersonSettingsAnswer, { state: 'ok' }>['person']
/** The keys of some agents of one organization (tokens.agentKeys). */
export type AgentKeysAnswer = FunctionReturnType<typeof api.tokens.agentKeys>
/** One agent's keys (tokens.agentKeys). */
export type AgentKeysRow = AgentKeysAnswer['agents'][number]
/** One batch of my personal tokens on MCP access (tokens.personalTokens). */
export type PersonalTokenBatch = FunctionReturnType<typeof api.tokens.personalTokens>
/** One batch of my connected apps on MCP access (connectedApps.list). */
export type ConnectedAppBatch = FunctionReturnType<typeof api.connectedApps.list>
/** Organization › General's creators line (orgs.projectCreators). */
export type ProjectCreatorsAnswer = FunctionReturnType<typeof api.orgs.projectCreators>
/** One answer of an Add team or user picker (projectSettings.candidates). */
export type AccessChoices = FunctionReturnType<typeof api.projectSettings.candidates>
/** One answer of a lead picker (projectSettings.leadCandidates). */
export type LeadChoices = FunctionReturnType<typeof api.projectSettings.leadCandidates>
/** One answer of the New sub-project dialog's Project list
    (projectSettings.projects with sub_project_parents). */
export type SubProjectParents = FunctionReturnType<typeof api.projectSettings.projects>
/** One batch of Settings › Archived projects (projectSettings.archived). */
export type ArchivedProjectEntries = FunctionReturnType<typeof api.projectSettings.archived>
/** The invite form's lookup of an address (projectSettings.inviteTarget). */
export type InviteLookup = FunctionReturnType<typeof api.projectSettings.inviteTarget>
/** One answer of Settings › Teams (teams.settingsPage). */
export type TeamListAnswer = FunctionReturnType<typeof api.teams.settingsPage>
/** A team's Settings page as the server reads it (teams.get). */
export type TeamSettingsAnswer = FunctionReturnType<typeof api.teams.get>
/** One answer of a team's member list (teams.members). */
export type TeamMembersAnswer = FunctionReturnType<typeof api.teams.members>
/** One answer of a team's Add member picker (teams.addable). */
export type TeamChoices = FunctionReturnType<typeof api.teams.addable>
/** One batch of the task label picker as the server answers it
    (labels.picker): its rows, `next`, `stopped`, `exact` and, in a first
    batch, `can_create`. */
export type LabelPickerBatch = FunctionReturnType<typeof api.labels.picker>
/** A label the task label picker or labels.byIds answers. */
export type LabelChoice = LabelPickerBatch['rows'][number]
/** One answer of the task label picker's read (P.labelChoices): a batch,
    or a refusal with the server's sentence. */
export type LabelChoices =
  | ({ state: 'ready' } & LabelPickerBatch)
  | { state: 'refused'; message: string }
/** One answer of the editor's mention popup's read (P.mentionChoices,
    pickers.mentions), or a refusal with the server's sentence. */
export type MentionChoices =
  | FunctionReturnType<typeof api.pickers.mentions>
  | { state: 'refused'; message: string }
/** A person the mention popup offers. */
export type MentionChoice = Extract<MentionChoices, { state: 'ready' }>['rows'][number]
/** One answer of a task's owner or recipient picker (P.ownerChoices and
    P.recipientChoices, pickers.taskOwners and syncRecipients), or a
    refusal with the server's sentence. */
export type OwnerChoices =
  | FunctionReturnType<typeof api.pickers.taskOwners>
  | { state: 'refused'; message: string }
/** A person an owner or recipient picker offers, a person row with no
    face (convex/model/projectSettings.ts PersonRow). */
export type OwnerChoice = Extract<OwnerChoices, { state: 'ready' }>['rows'][number]
/** One answer of a check of people by id (P.ownerChecks, pickers.canOwn),
    or a refusal with the server's sentence. */
export type OwnerChecks =
  | FunctionReturnType<typeof api.pickers.canOwn>
  | { state: 'refused'; message: string }
/** One person P.ownerChecks answered. */
export type OwnerCheck = Extract<OwnerChecks, { state: 'ready' }>['rows'][number]

/* One read of a picker by `read`: its answer, a `bad_request` or `rule`
   refusal as `refused` with the server's sentence, and any other failure
   null, logged as `what`'s. */
async function pickerRead<A>(
  what: string,
  read: () => Promise<A>,
): Promise<A | { state: 'refused'; message: string } | null> {
  try {
    return await read()
  } catch (e) {
    const { code, message } = errData(e)
    if (code === 'bad_request' || code === 'rule')
      return { state: 'refused', message: asSentence(message || 'Qivo refused this search.') }
    console.error(`[qivo] ${what} read failed:`, e)
    return null
  }
}

/* `change` as the server names a removal (convex/model/removalPreview.ts
   vRemovalChange). */
function removalChange(
  change: AccessRemoval,
): FunctionArgs<typeof api.accessRemovals.preview>['change'] {
  switch (change.kind) {
    case 'userGrant':
      return { kind: 'user_grant', project_id: change.projectId, user_id: change.userId }
    case 'teamGrant':
      return { kind: 'team_grant', project_id: change.projectId, team_id: change.teamId }
    case 'teamMember':
      return { kind: 'team_member', team_id: change.teamId, user_id: change.userId }
    case 'deleteTeam':
      return { kind: 'delete_team', team_id: change.teamId }
  }
}

/* `answer` when the window can act on it, else null: a state it knows,
   and for `ok` the fields the window decides by, which a backend older
   than the removal window's server reads lacks (keep.offered,
   keep.permitted, reassign.permitted, and reassign.holder_eligible when
   `checked` asked for it). Reading such an answer as "the caller cannot
   settle" would remove at once and strand the tasks, so it removes
   nothing. */
function readablePreview(answer: RemovalPreview, checked: boolean): RemovalPreview | null {
  switch (answer.state) {
    case 'unavailable':
      return answer
    case 'refused':
    case 'too_large':
      return typeof answer.message === 'string' ? answer : null
    case 'ok': {
      const flags = [answer.keep?.offered, answer.keep?.permitted, answer.reassign?.permitted]
      if (checked) flags.push(answer.reassign?.holder_eligible)
      return flags.every((flag) => typeof flag === 'boolean') ? answer : null
    }
    default:
      return null
  }
}

/* Whether the removal window asks. It asks when Keep as Viewer is offered
   and the caller may keep the people, as an organization admin who manages
   a project without Edit on its tasks may; the window then shows Reassign
   disabled with the preview's refusal sentence where the caller may not
   reassign. Where Keep as Viewer is no choice (a removed Viewer grant), it
   asks when the caller may reassign every lost task. Otherwise the removal
   goes at once with a notice (design-spec row 330). The rule is one-sided:
   a caller who may reassign but not keep, such as a team leader with Edit
   who cannot manage the project's users, still gets the notice. The
   `permitted` fields answer the caller's authority whatever size or
   read-only sentence the `refusal` fields name first. */
const settlesRemoval = (answer: RemovalAnswer): boolean =>
  answer.keep.offered ? answer.keep.permitted : answer.reassign.permitted

/** What the press or the removal window says when a removal could not be
    checked on the server: the read failed, or the backend is older than the
    window's reads. Nothing was removed. */
export const REMOVAL_UNCHECKED =
  "Couldn't check which tasks this removal affects. Nothing was removed."

/** The title of a removal control while its press waits for the server's
    preview (panels/useAccessRemoval.tsx). */
export const REMOVAL_CHECKING = 'Checking which tasks this affects…'

/* The direct grant rows on a project, without the lead (projects.lead_id). */
function grantsOn(projectId: string): Record<string, GrantLevel> {
  const access: Record<string, GrantLevel> = {}
  rows.access.forEach((a) => {
    if (a.project_id === projectId) access[a.profile_id] = a.level
  })
  return access
}
/* The organization whose project or team a removal changes: the one the
   page showed for a grant that names it (AccessRemoval orgId), else the
   workspace's. */
const removalOrg = (change: AccessRemoval) =>
  change.orgId ??
  ('projectId' in change
    ? rows.projects.get(change.projectId)?.org_id
    : rows.teams.get(change.teamId)?.org_id)

/* The removals whose write is on its way, by removalKey, for
   P.removingAccess. */
const removing = new Set<string>()

/* The name of the team `change` is about as the page showed it, else the
   store's team, else undefined (teamNoun then says "team"). */
const removalTeamName = (change: AccessRemoval): string | undefined =>
  'teamId' in change
    ? change.kind === 'teamGrant' || change.kind === 'deleteTeam'
      ? (change.label ?? rows.teams.get(change.teamId)?.name)
      : rows.teams.get(change.teamId)?.name
    : undefined

/* The name of the person `change` is about as the page showed it, else as
   the store knows them (P.person), else `fallback`. */
const removalPersonName = (change: AccessRemoval, fallback: string): string =>
  'userId' in change ? (change.label ?? knownName(change.userId) ?? fallback) : ''

/* `change` as one key whatever organization and name it carries, for
   `removing`, so a rename during a check keeps the press. */
const removalKey = (change: AccessRemoval): string =>
  JSON.stringify([
    change.kind,
    'projectId' in change ? change.projectId : '',
    'teamId' in change ? change.teamId : '',
    'userId' in change ? change.userId : '',
  ])
/* Removes a person's or a team's grant on one project, a member from a team,
   or a whole team, in one server write that settles the tasks it hides by
   `held` (projects.removeAccess, teams.removeMember, teams.deleteDeep), and
   paints the outcome at once; a refusal takes the paint away again. The
   server works out at commit which tasks leave their holders' sight
   (convex/model/projectAccess.ts findLost), so `shown`, the preview the
   window showed, only paints: the reassigned holdings the workspace holds
   with the same holder, and for a person's or a team's grant kept as
   Viewers a Viewer grant on its project for each of its people without a
   grant there. A team change paints no Viewer grant; the delivery brings
   them. While the write is on its way, P.removingAccess answers true for
   it, so a page that lists the access from the server's answer, which the
   paint does not reach, hides the row and shows it again on a refusal.
   Resolves whether the server accepted it. */
function removeAtOnce(
  change: AccessRemoval,
  held: 'leave' | 'keep_as_viewer' | { reassign_to: string | null },
  shown: RemovalAnswer | undefined,
  stays: string,
): Promise<boolean> {
  const orgId = removalOrg(change)
  if (!orgId) return Promise.resolve(false)
  const key = removalKey(change)
  removing.add(key)
  const sent = sendRemoval(change, held, shown, stays, orgId)
  emit()
  // a write's results reach the lists before its answer (lib/liveQueries.ts),
  // so an accepted removal's row has left them by now
  return sent.then((removed) => {
    removing.delete(key)
    emit()
    return removed
  })
}

/* removeAtOnce's paint and write, for organization `orgId`. */
function sendRemoval(
  change: AccessRemoval,
  held: 'leave' | 'keep_as_viewer' | { reassign_to: string | null },
  shown: RemovalAnswer | undefined,
  stays: string,
  orgId: string,
): Promise<boolean> {
  // everything the paint needs, worked out now from the answer
  const at = new Date().toISOString()
  const patches =
    typeof held === 'object' && shown
      ? shown.items.map((i) => ({
          uuid: i.task_id,
          uid: i.holder_id,
          field: i.role === 'assignee' ? ('assignee_id' as const) : ('reviewer_id' as const),
          db: mapIssuePatch(
            i.role === 'assignee' ? { assignee: held.reassign_to } : { reviewer: held.reassign_to },
          ),
        }))
      : []
  // the server's Viewer grants on the project whose grant goes
  const grants: Row<'project_access'>[] =
    held === 'keep_as_viewer' && shown && 'projectId' in change
      ? shown.people.map((p) => ({
          project_id: change.projectId,
          profile_id: p.id,
          level: 'viewer' as const,
        }))
      : []
  const view: View = {
    workspace: () => {
      // the server settles only the tasks the person still holds at commit
      for (const { uuid, uid, field, db } of patches)
        if (rows.issues.get(uuid)?.[field] === uid) patchIssueRow(uuid, db, at)
      if (change.kind === 'userGrant') {
        workspaceRows.keepList(
          'access',
          (a) => !(a.project_id === change.projectId && a.profile_id === change.userId),
        )
      } else if (change.kind === 'teamGrant') {
        workspaceRows.keepList(
          'teamAccess',
          (a) => !(a.project_id === change.projectId && a.team_id === change.teamId),
        )
      } else if (change.kind === 'teamMember') {
        workspaceRows.keepList(
          'teamMembers',
          (m) => !(m.team_id === change.teamId && m.profile_id === change.userId),
        )
      } else {
        // the team's memberships and grants go with it; projects and work stay
        workspaceRows.keepList('teamMembers', (m) => m.team_id !== change.teamId)
        workspaceRows.keepList('teamAccess', (a) => a.team_id !== change.teamId)
        rows.teams.delete(change.teamId)
      }
      for (const grant of grants) {
        const has = workspaceRows
          .peekList('access')
          .some((a) => a.project_id === grant.project_id && a.profile_id === grant.profile_id)
        const there = rows.projects.has(grant.project_id) && rows.profiles.has(grant.profile_id)
        if (!has && there) rows.access.push({ ...grant })
      }
    },
  }
  const onError = (error: unknown) => {
    // Only a refused reassignment or Viewer grant (model/projectAccess.ts
    // HELD_TASKS_REFUSED) blames the tasks; a refused removal, a billing
    // pause or a lost connection says so itself
    const settling = errData(error).reason === 'held_tasks'
    if (settling && typeof held === 'object') {
      toast(`${stays}, because not every task could be reassigned.`, 'error')
    } else if (
      settling &&
      held === 'keep_as_viewer' &&
      (change.kind === 'teamMember' || change.kind === 'deleteTeam')
    ) {
      toast(`${stays}, because not every Viewer grant could be saved.`, 'error')
    } else toastWriteError(error)
  }
  if (change.kind === 'deleteTeam') {
    // the name the page showed is the delete's expected value, else the
    // store's team's; with neither nothing is sent
    const name = change.label ?? rows.teams.get(change.teamId)?.name
    if (name === undefined) return Promise.resolve(false)
    return send(
      api.teams.deleteDeep,
      { org_id: orgId, id: change.teamId, on_held_tasks: held },
      view,
      {
        onError,
        over: overOf('teams', { id: change.teamId }, ['name'], { name }),
        notice: { deletes: true },
      },
    )
  }
  return change.kind === 'teamMember'
    ? send(
        api.teams.removeMember,
        {
          org_id: orgId,
          team_id: change.teamId,
          profile_id: change.userId,
          on_held_tasks: held,
        },
        view,
        { onError },
      )
    : send(
        api.projects.removeAccess,
        {
          org_id: orgId,
          id: change.projectId,
          ...(change.kind === 'userGrant'
            ? { user_id: change.userId }
            : { team_id: change.teamId }),
          on_held_tasks: held,
        },
        view,
        { onError },
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
      creator,
      lead,
      own: own === 'lead' ? undefined : own,
    })
    if (mine) grants[creator] = mine
    else delete grants[creator]
  }
  return grants
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
/** andList for `words.length + more` things of which `words` names the
    first and `more` counts the rest, as the server names a few projects and
    counts the others: "A, B and 3 other projects" for three names and two
    more. */
export function andMore(words: string[], more: number, others: (n: number) => string): string {
  if (more === 0) return andList(words, others)
  if (words.length >= 2) return `${words[0]}, ${words[1]} and ${others(words.length - 2 + more)}`
  return words.length === 1 ? `${words[0]} and ${others(more)}` : others(more)
}

/** Someone working on a task, as a parent change or a move checks them. */
export type Holder = { uid: string; task: IssueVM; role: 'assignee' | 'reviewer' }
/** A subtask the Archive or delete window lists for a delete (P.deletePlan). */
export type DeleteRow = { task: IssueVM; depth: number; deletable: boolean }
/** A holder who would lose access to `project` (edit access when `edit`). */
export type AccessBlocker = Holder & { project: ProjectVM; edit: boolean }
/** What Move and Archive or delete take along with a task (P.familyOf):
    `root` is the task as they read it, whose `children` are the family's,
    `byId` holds it, its parent when known and every subtask under it by
    handle, and `done` says whether it is Done, a group's by its whole
    list. */
export type TaskFamily = {
  root: IssueVM
  byId: Readonly<Record<string, IssueVM>>
  done: boolean
}

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
   updated_at, done_at, remaining_set_at, review_at, status_at, archived_at
   have no slot in the validator either). */
type IssueWirePatch = FunctionArgs<typeof api.issues.update>['patch']
/* `patch` as the wire patch, or null when its `parent` names a task that
   parentUuidOf cannot resolve, which the caller refuses with
   PARENT_UNKNOWN rather than sending a detach. `parentRow` is the row a
   picker showed for a parent the workspace may not hold. */
function mapIssuePatch(patch: IssuePatch, parentRow?: { id: string }): IssueWirePatch | null {
  const db: IssueWirePatch = {}
  if ('title' in patch) db.title = cleanTitle(patch.title)
  // required column; drawer commits null to clear. Painted as the server
  // stores it, so the editor sees the text it saved
  if ('description' in patch) db.description = trimMarkdown(patch.description || '')
  if ('status' in patch) db.status = patch.status
  if ('priority' in patch) db.priority = patch.priority
  if ('assignee' in patch) db.assignee_id = patch.assignee || null
  if ('reviewer' in patch) db.reviewer_id = patch.reviewer || null
  if ('parent' in patch) {
    const parent = patch.parent ? parentUuidOf(patch.parent, parentRow) : null
    if (parent === undefined) return null
    db.parent_id = parent
  }
  if ('start' in patch) db.start_week = patch.start != null ? weekToISO(patch.start) : null
  if ('end' in patch) db.end_week = patch.end != null ? weekToISO(patch.end) : null
  if ('due' in patch) db.due_date = patch.due || null
  if ('remaining' in patch)
    db.remaining_hours =
      patch.remaining != null && patch.remaining !== ''
        ? roundTenths(Number(patch.remaining))
        : null
  if ('paused' in patch) db.paused = !!patch.paused
  return db
}
/* What a write says when the parent it names is a task Qivo cannot find
   here, a handle the workspace does not hold that no picker row named
   either. It sends nothing, rather than a detach or a top-level task. */
const PARENT_UNKNOWN = "Couldn't set the parent task, because Qivo cannot find it here."

/** The uuid of the task `parent` names, a handle or a uuid. That is a
    task the workspace holds by either, `row`, the task a relation picker
    showed, by its uuid, or the task the window shows from a current answer
    (answerTaskOf). Undefined for anything else, which the write refuses
    (PARENT_UNKNOWN). */
function parentUuidOf(parent: string, row?: { id: string }): string | undefined {
  const held = keyToUuid.get(parent)
  if (held) return held
  if (rows.issues.has(parent) || row?.id === parent) return parent
  return answerTaskOf(parent)?.uuid
}

/** New task `row`, whose number is `num`, as the short row the window's
    answer lists it by (convex/lib/taskWindow.ts ShortRow), with the
    person's `level` on its project. */
function newShortRow(
  row: Row<'issues'>,
  num: number,
  has_subtasks: boolean,
  level: ShortRow['level'],
) {
  const { description: _text, parent_id: _parent, ...fields } = row
  return { ...fields, num, has_subtasks, level } satisfies ShortRow
}

/** Paints the window's own answer of task `parent` (detailRows) as the
    server answers it once task `kid` is its subtask, or with `kid` null
    once task `gone` is not: the list in number order, the group fact, and
    the hours a task loses when it gains a subtask (clearParentHours).
    Skips while another task's answer is painted. */
function subtaskListPaint(parent: string, kid: ShortRow | null, gone: string, at: string) {
  const shown = detailRows.task
  if (!shown || shown.task.id !== parent) return
  const rest = shown.subtasks.rows.filter((row) => row.id !== gone)
  if (kid) rest.push({ ...kid })
  rest.sort(byNumber)
  shown.subtasks = { ...shown.subtasks, rows: rest }
  shown.task.has_subtasks =
    rest.length > 0 || !shown.subtasks.complete || shown.task.has_hidden_subtasks
  const task = shown.task
  if (kid && (task.remaining_hours != null || task.review_at != null)) {
    task.remaining_hours = undefined
    task.remaining_set_at = undefined
    task.review_at = undefined
    task.updated_at = at
  }
}

/* The remaining time a task in this sub-project gets on entering Review: its
   own review_hours, else its parent project's, else the default. The same
   resolver the server's reviewHoursFor uses, so the paint never flickers. */
function reviewHoursForProject(projectId: string): number {
  const p = rows.projects.get(projectId)
  const parent = p?.parent_id ? rows.projects.get(p.parent_id) : undefined
  return resolveReviewHours(p?.review_hours, parent?.review_hours)
}

/* The fields updateViewTask writes: the Board's drop and owner picker
   (status, assignee and reviewer), Team sync's Remaining box and Pause
   (remaining and paused), and the Roadmap's drag, Cancel and Auto-move
   (start and end). */
const VIEW_WRITES = new Set([
  'status',
  'assignee',
  'reviewer',
  'remaining',
  'paused',
  'start',
  'end',
])

/** P.updateIssue on a task only an open view's answer brings
    (store/viewRows.ts), which the Board's drop and owner picker, Team
    sync's cards and the Roadmap's bars send: its status, assignee and
    reviewer, Team sync's Remaining and Pause, and the Roadmap's dates,
    with the roster check the workspace's tasks get. A Remaining patch on a
    group drops, as the held path drops one on a parent, since a group has
    no hours of its own. The write paints the views' rows of the task, the
    task window's own answer of it (`detail`), which shows once a window
    opens on the task while the write waits, and the workspace's, which
    skips until the workspace holds the task, so it shows whichever source
    the screen takes the task from (store/layers.ts View). Its `expected`
    values are the view's row on screen. A write of dates alone joins the
    Roadmap's history, in its open batch, as a held task's does
    (recordRoadmapChange), and goes out as an ordinary write where no visit
    records it. A group's dates come from its subtasks, so a date patch for
    one drops, as the held path drops it. Resolves false for any other
    field. A handle two view rows share names the person's new task on its
    way (store/viewRows.ts byHandle), never another person's task. A write
    on the task a window shows from a current answer goes through
    updateAnswerTask instead (P.updateIssue). */
function updateViewTask(id: string, patch: IssuePatch): Promise<boolean> {
  const it = viewRows.byHandle(id)
  const row = it && viewRows.peek(it.uuid)
  if (!it || !row) return Promise.resolve(false)
  if (Object.keys(patch).some((key) => !VIEW_WRITES.has(key))) return Promise.resolve(false)
  // a group has no hours of its own (0066): drop a stray Remaining
  if ('remaining' in patch && it.isGroup) {
    patch = { ...patch }
    delete patch.remaining
    if (!Object.keys(patch).length) return Promise.resolve(true)
  }
  if (('start' in patch || 'end' in patch) && (it.isGroup || row.has_subtasks)) {
    patch = { ...patch }
    delete patch.start
    delete patch.end
    if (!Object.keys(patch).length) return Promise.resolve(true)
  }
  if (refusePausedEdit()) return Promise.resolve(false)
  for (const holder of [patch.assignee, patch.reviewer]) {
    const unseen = holder ? PLANNER.unseenAbove(it, holder) : null
    const project = unseen && PLANNER.project(unseen.project)
    if (holder && project) {
      const who = knownName(holder) || 'This person'
      toast(
        `${who} has no access to ${PLANNER.projectLabel(project)}, where a task above ${it.key} is. Give them access or choose someone else.`,
        'error',
      )
      return Promise.resolve(false)
    }
  }
  const wire = mapIssuePatch(patch)
  if (!wire) return Promise.resolve(false)
  const shown: Record<string, unknown> = { ...row }
  for (const key of Object.keys(wire) as (keyof typeof wire)[])
    if ((wire[key] ?? null) === (shown[key] ?? null)) delete wire[key]
  if (!Object.keys(wire).length) return Promise.resolve(true)
  const paintDb = { ...wire }
  // a group's status is dormant (updateIssue)
  if (it.isGroup) delete paintDb.status
  const at = new Date().toISOString()
  const uuid = it.uuid
  const view: View = {
    view: viewPaint([uuid], () => {
      for (const copy of viewRows.edit(uuid)) stampTaskPatch(copy, paintDb, at)
    }),
    // the window's own answer of the task, while a window shows it
    detail: {
      task: uuid,
      paint: () => {
        const shown = detailRows.task
        if (shown?.task.id === uuid) stampTaskPatch(shown.task, paintDb, at)
      },
    },
    // skips until the workspace holds the task, then paints it there too
    workspace: () => patchIssueRow(uuid, paintDb, at),
  }
  const over = overOf('issues', row, Object.keys(wire))
  const planningOnly = Object.keys(wire).every((key) => ['start_week', 'end_week'].includes(key))
  return (
    (planningOnly && recordRoadmapChange({ kind: 'task', id: uuid, patch: wire }, view, over)) ||
    send(api.issues.update, { org_id: row.org_id, id: uuid, patch: wire }, view, {
      over,
      // the task comes from a view's answer, not the workspace
      about: { task: uuid, answer: true },
    })
  )
}

/** Moves task `row`, which only the Roadmap's dependency answer holds, to
    the weeks `start` to `end`, for Auto-move: the same task operation a
    shown task's move sends, in the open batch, with the row's stored dates
    as its `expected` values, or an ordinary write where no visit records
    it. It paints nothing, since no screen shows the task, and the
    dependency read's next answer, which Convex delivers before the write
    resolves, holds it. A group's dates come from its subtasks, so it
    writes none. */
function moveDependencyTask(row: DependencyRow, start: number, end: number): Promise<boolean> {
  if (row.has_subtasks) return Promise.resolve(true)
  if (refusePausedEdit()) return Promise.resolve(false)
  const wire: IssueWirePatch = {}
  const startWeek = weekToISO(start)
  const endWeek = weekToISO(end)
  if (startWeek !== (row.start_week ?? null)) wire.start_week = startWeek
  if (endWeek !== (row.end_week ?? null)) wire.end_week = endWeek
  if (!Object.keys(wire).length) return Promise.resolve(true)
  const over = overOf('issues', row, Object.keys(wire))
  return (
    recordRoadmapChange({ kind: 'task', id: row.id, patch: wire }, {}, over) ||
    send(
      api.issues.update,
      { org_id: row.org_id, id: row.id, patch: wire },
      {},
      { over, about: { task: row.id, answer: true } },
    )
  )
}

/** What P.updateIssue takes besides the patch: what an editor showed when
    the person began, by wire field, and what a kept draft does after a
    refusal (SendOptions keepDraft and keepUnsaved). */
type UpdateOptions = {
  seen?: Partial<Row<'issues'>>
  /** with a `parent_id` in `seen`, whether the row the person saw had a
      parent they cannot see, in place of the workspace's, so the write's
      expected parent pair is the one they saw (P.setSubtaskParent) */
  hiddenParent?: boolean
  keepDraft?: (shown: unknown) => boolean
  keepUnsaved?: () => void
  /** for a `parent` the workspace may not hold, the row the Parent picker
      showed for it (convex/lib/relationPicker.ts RelationCandidate). It
      names the parent by its uuid, and the window paints its Parent row
      from it at once. */
  parentRow?: RelationCandidate
}

/** Puts label `labelId` on task `uuid` of organization `org` in the
    workspace's rows, or takes it off with `on` false, as a label toggle
    paints them. Skips while the workspace does not hold the task in that
    organization (holdsIn), so a write from the window's own answer paints
    the workspace once it holds the task. A label the
    workspace does not hold paints too: the task's labels list every id
    (store/taskIndex.ts), and the window names one it does not hold from
    labels.byIds. */
function labelRowsPaint(uuid: string, labelId: string, on: boolean, org: string): Paint {
  return () => {
    if (!holdsIn(uuid, org)) return
    const has = workspaceRows
      .peekList('issueLabels')
      .some((il) => il.issue_id === uuid && il.label_id === labelId)
    if (has === on) return
    if (on) rows.issueLabels.push({ issue_id: uuid, label_id: labelId })
    else
      workspaceRows.keepList(
        'issueLabels',
        (il) => !(il.issue_id === uuid && il.label_id === labelId),
      )
  }
}

/** Makes profile `me` follow task `uuid` of organization `org` in the
    workspace's rows, or stop following it with `on` false, as of `at`.
    Skips while the workspace does not hold the task in that organization,
    as labelRowsPaint does. */
function followRowsPaint(uuid: string, me: string, on: boolean, at: string, org: string): Paint {
  return () => {
    if (!holdsIn(uuid, org)) return
    const has = workspaceRows
      .peekList('issueSubs')
      .some((s) => s.issue_id === uuid && s.profile_id === me)
    if (has === on) return
    if (on) rows.issueSubs.push({ issue_id: uuid, profile_id: me, created_at: at })
    else workspaceRows.keepList('issueSubs', (s) => !(s.issue_id === uuid && s.profile_id === me))
  }
}

/** Where a file of task `issueKey`, a handle or a uuid, goes, for
    P.addAttachment: the task, its organization and project, how many
    attachment rows the per-task cap counts, and whether the window's own
    answer, not the workspace, holds it. */
type UploadTarget = { uuid: string; org: string; project: string; count: number; answer: boolean }

/** The workspace's task for an upload: its cap counts the larger of the
    workspace's rows and the whole section list (capInputs), and an image a
    description save took out no longer counts. With `org`, only while the
    workspace holds the task in that organization. Without one, none while
    the window watches another organization's task of the same id, which
    the workspace does not hold. */
function heldUploadTarget(issueKey: string, org?: string): UploadTarget | null {
  const uuid = keyToUuid.get(issueKey) || (rows.issues.has(issueKey) ? issueKey : undefined)
  const row = uuid ? rows.issues.get(uuid) : undefined
  if (!row || !uuid) return null
  if (org !== undefined && row.org_id !== org) return null
  if (org === undefined && uuid === watchedComments && watchedOrg && row.org_id !== watchedOrg)
    return null
  const held = PLANNER.issueById[uuidToKey.get(uuid) ?? '']
  const count = Math.max(
    [...rows.attachments.values()].filter((a) => a.issue_id === uuid && a.dropped_at === undefined)
      .length,
    held ? capInputs(held).attachments : 0,
  )
  return { uuid, org: row.org_id, project: row.project_id, count, answer: false }
}

/** The task the window shows from its own answer for an upload, of
    organization `org` when named (answerTaskOf): its cap counts the larger
    of the window's view and its whole attachments answer (capInputs), with
    no walk of the workspace. */
function answerUploadTarget(issueKey: string, org?: string): UploadTarget | null {
  const shown = answerTaskOf(issueKey, org)
  return shown
    ? {
        uuid: shown.uuid,
        org: shown.org,
        project: shown.model.project,
        count: capInputs(shown.model).attachments,
        answer: true,
      }
    : null
}

/* The task a file for `issueKey`, a handle or a uuid, goes to now, for
   P.addAttachment, of organization `org` when named, as two organizations
   can hold one task id. It is the workspace's task, else the one the
   window shows from a current answer. */
const uploadTarget = (issueKey: string, org?: string) =>
  heldUploadTarget(issueKey, org) ?? answerUploadTarget(issueKey, org)

/* Says why task `id` takes no file now, for an upload of file `name`.
   Either the window shows it from an answer that is not current
   (P.refuseStaleEdit), or neither the workspace nor the window shows it
   any more, as for a file still queued when the window moved on. A file
   of a create the server refused says nothing, since the create's own
   refusal said what happened (refusedCreates). */
function refuseUpload(id: string, name: string) {
  if (refusedCreates.has(id)) return
  if (PLANNER.refuseStaleEdit(id)) return
  toast(
    `Couldn't upload "${name}". The upload stopped because the window no longer shows its task.`,
  )
}

/** P.removeAttachment for attachment `attId`, which the workspace does not
    hold: a file only the watched task's attachments answer holds, of a task
    the window shows from its own answer or of a held task whose file has
    not arrived yet, or an upload of task `opts.task` that no list holds. It
    sends files.removeAttachment without a paint to the organization of the
    answer that lists the file, else to `opts.org` when the uploader names
    it, as two organizations can hold one task id and the store may no
    longer watch the uploaded one, else to the watched or held task's
    organization (orgOfTask). The attachments answer drops the row when the
    write commits, before the write resolves (lib/convexOrdering.test.ts),
    so the row shows busy until then, and a refusal toasts and leaves it. */
function removeUnheldAttachment(
  attId: string,
  opts: { deferWhilePaused?: boolean; task?: string; org?: string },
): Promise<boolean> {
  const listed = sectionAttachment(attId)
  const task = listed?.row.issue_id ?? opts.task
  const org = listed?.org ?? opts.org ?? (task ? orgOfTask(task) : undefined)
  if (!task || !org) return Promise.resolve(false)
  if (opts.deferWhilePaused && (snapshotTrouble || savePause())) {
    reapAfterPause.set(attId, { task, org })
    return Promise.resolve(false)
  }
  if (refusePausedEdit()) return Promise.resolve(false)
  return send(api.files.removeAttachment, { org_id: org, id: attId }, 'none', {
    about: { task, ...(holdsIn(task, org) ? {} : { answer: true }) },
  })
}

/** P.archiveIssue's write of task `uuid` in organization `org`, which
    waits for the server: nothing changes until it accepts, and a refusal
    leaves the task and the window in place (toasted). */
function sendArchive(
  org: string,
  uuid: string,
  reason: string | undefined,
  keepSubtasks: boolean,
  about?: WriteAbout,
): Promise<boolean | 'already'> {
  if (refusePausedEdit()) return Promise.resolve(false)
  const text = (reason || '').trim()
  const epoch = storeEpoch
  const at = new Date().toISOString()
  return sendAwaited(
    api.issues.archive,
    {
      org_id: org,
      id: uuid,
      ...(text ? { reason: text } : {}),
      ...(keepSubtasks ? { keep_subtasks: true } : {}),
    },
    'none',
    // The delivery that drops the task usually lands first, and then
    // nothing paints. When it has not, an archive this call made paints
    // until one does. An 'already' answer changed nothing, and the earlier
    // archive may have kept or taken the subtasks, so nothing paints and
    // the board shows the task until a delivery holds that archive. A task
    // the workspace does not hold in its organization paints nothing
    // (archivePaint skips): its window's answer turns archived first.
    {
      keep: (out) =>
        out?.archived === false ? null : { workspace: archivePaint(uuid, keepSubtasks, at, org) },
      ...(about ? { about } : {}),
    },
  ).then(
    // an answer without `archived`, as one from before it, archived the task
    (out) => (out?.archived === false ? 'already' : true),
    (error) => {
      // it painted nothing, so a refusal has nothing to revert
      if (epoch === storeEpoch) toastWriteError(error, false)
      return false
    },
  )
}

/** Paints task row `task` moved to sub-project `projectId` at `at`, with
    the server's stamps: the move clears the status stamp and restarts a
    review hand-off or Done time at the move, keeping the remaining-hours
    measurement (model/issues.ts movedStamps). Skips a row already there. */
function paintMoved(
  task: Pick<Row<'issues'>, 'project_id' | 'updated_at' | 'status_at' | 'review_at' | 'done_at'>,
  projectId: string,
  at: string,
) {
  if (task.project_id === projectId) return
  task.project_id = projectId
  task.updated_at = at
  task.status_at = undefined
  if (task.review_at != null) task.review_at = at
  if (task.done_at != null) task.done_at = at
}

/** A move's paint of the workspace's rows: the tasks `family` (the task
    first, then the subtasks it carries) of organization `org` in
    sub-project `projectId` at `at`, and the task without its parent when
    it `leavesParent`. Each row the workspace does not hold in that
    organization skips (holdsIn). */
function moveRowsPaint(
  family: readonly string[],
  projectId: string,
  leavesParent: boolean,
  at: string,
  org: string,
): Paint {
  return () => {
    for (const taskId of family) {
      const moved = rows.issues.get(taskId)
      if (moved?.org_id === org) paintMoved(moved, projectId, at)
    }
    const uuid = family[0]
    const moved = uuid === undefined ? undefined : rows.issues.get(uuid)
    if (leavesParent && moved?.org_id === org && uuid !== undefined) {
      moved.parent_id = undefined
      rows.hiddenParentTasks.delete(uuid)
    }
  }
}

/** P.moveIssue on the watched task the window shows from its own answer
    (answerTaskOf), with what it takes along from the answer's whole
    subtask list (P.familyOf), and no move while that is unknown. Its
    expected values are the painted answer's project and, with a detach,
    its parent pair. It paints the answer (the task, the subtasks it
    carries, the parent it leaves), every view copy of those tasks, and
    the workspace's rows (moveRowsPaint), and answers the task's handle, or
    null for a no-op or an invalid target. */
function moveAnswerTask(a: AnswerTask, projectId: string): string | null {
  const target = rows.projects.get(projectId)
  const row = a.answer.task
  if (target?.type !== 'project' || row.project_id === projectId) return null
  const family = PLANNER.familyOf(a.model)
  if (!family || refusePausedEdit()) return null
  const { leavesParent, carried } = PLANNER.moveFamily(a.model, projectId, family)
  const uuid = a.uuid
  const moving = [uuid, ...carried.map((task) => task.uuid)]
  const at = new Date().toISOString()
  const view: View = {
    detail: {
      task: uuid,
      paint: () => {
        const shown = detailRows.task
        if (!shown || shown.task.id !== uuid) return
        paintMoved(shown.task, projectId, at)
        for (const kid of shown.subtasks.rows)
          if (moving.includes(kid.id)) paintMoved(kid, projectId, at)
        if (leavesParent) {
          shown.task.parent_id = undefined
          shown.task.has_hidden_parent = false
          shown.parent = null
        }
      },
    },
    view: viewPaint(moving, () => {
      for (const taskId of moving)
        for (const copy of viewCopiesIn(taskId, a.org)) {
          paintMoved(copy, projectId, at)
          if (leavesParent && taskId === uuid) {
            copy.parent_id = undefined
            copy.has_hidden_parent = false
          }
        }
    }),
    workspace: moveRowsPaint(moving, projectId, leavesParent, at, a.org),
  }
  void send(
    api.issues.move,
    {
      org_id: a.org,
      id: uuid,
      project_id: projectId,
      ...(leavesParent ? { detach_parent: true } : {}),
    },
    view,
    {
      over: {
        ...overOf('issues', row, leavesParent ? ['project_id', 'parent_id'] : ['project_id']),
        hiddenParent: row.has_hidden_parent,
      },
      about: { task: uuid, answer: true },
    },
  )
  return a.model.id
}

/** The uuids of the subtasks `keys` (handles) a delete takes along, each
    found by `uuidOf`, or null when one of them is not found. The server
    detaches every subtask a delete is not given (issues.deleteDeep), so a
    delete that cannot name a subtask the person chose sends nothing,
    rather than delete the task and detach that subtask. */
function chosenSubtaskIds(
  keys: readonly string[],
  uuidOf: (key: string) => string | undefined,
): string[] | null {
  const ids: string[] = []
  for (const key of keys) {
    const uuid = uuidOf(key)
    if (!uuid) return null
    ids.push(uuid)
  }
  return ids
}

/** P.deleteIssue on the watched task the window shows from its own answer
    (answerTaskOf), with the subtasks `subtasks` (handles) the Archive or
    delete window listed as deletable, their uuids from the answer's whole
    subtask list (P.familyOf), and no delete while that is unknown or no
    longer holds one of them. It waits for the server, as the window asks:
    nothing paints before it accepts, and the workspace's paint then skips,
    since the window's answer says the task is gone first. */
function deleteAnswerTask(a: AnswerTask, subtasks: string[], reason?: string): Promise<boolean> {
  const family = PLANNER.familyOf(a.model)
  if (!family || refusePausedEdit()) return Promise.resolve(false)
  const root = family.root
  const subtaskIds = chosenSubtaskIds(subtasks, (key) => {
    const kid = family.byId[key]
    return kid && kid.parent === root.id ? kid.uuid : undefined
  })
  if (!subtaskIds) return Promise.resolve(false)
  const gone = new Set([a.uuid, ...subtaskIds])
  const at = new Date().toISOString()
  const view: View = { workspace: () => dropDeletedTasks(gone, at, a.org) }
  const text = (reason || '').trim()
  const epoch = storeEpoch
  return sendAwaited(
    api.issues.deleteDeep,
    {
      org_id: a.org,
      id: a.uuid,
      ...(subtaskIds.length ? { subtask_ids: subtaskIds } : {}),
      ...(text ? { reason: text } : {}),
    },
    'none',
    { keep: () => view, about: { task: a.uuid, answer: true } },
  ).then(
    () => true,
    (error) => {
      if (epoch === storeEpoch) toastWriteError(error, false)
      return false
    },
  )
}

/** The watched task as a write from its window's own answer reads it: its
    uuid and organization, its painted answer as the window draws it
    (drawnAnswer), whose row the write sends as its expected values, and
    the window's view model of it (P.detail), built from that answer. */
type AnswerTask = { uuid: string; org: string; answer: TaskOk; model: IssueVM }

/** The watched task, when handle or uuid `id` names it, the workspace does
    not hold it and the window shows it from a current answer of the task
    side (P.taskDetail state ok, neither failed nor running again), in its
    known organization; else null, and a write on it answers false without
    sending. The answer must be the task side's own, so a window that shows
    the task from the read of its reference (refRead, which taskDetailNow
    serves until the task side answers) edits nothing until the task side
    answered. The creating answer of the person's own new task
    (creatingAnswerOf) serves too, before the task side runs. A write from
    it goes out at once, behind the create on the same connection, and the
    server runs it after the create: "When mutations are called from the
    React or Rust clients, they are executed one at a time in a single,
    ordered queue" (Convex's documentation, Mutations), the order an upload
    after a just-sent create relies on (P.addAttachment) and the field check
    states (convex/model/expected.ts). It is the answer the window
    draws, not a newer delivery the window has yet to draw, so the write
    never sends another member's change as what the person saw. The
    workspace may hold another organization's task of the same id
    instead (watchedRow), which is another task. Then the window's handle
    names the watched task, a reference (P.handleNow), and the uuid alone
    names neither for certain, so a write by it fails closed. With `org`,
    it is the watched task of that organization only, which its uuid then
    names, as an upload names its task (uploadTarget). */
function answerTaskOf(id: string, org?: string): AnswerTask | null {
  const t = watchedComments
  const detail = PLANNER.detail
  if (!t || !detail || detail.task !== t || watchedRow()) return null
  if (detail.state !== 'ok' || !detail.view) return null
  if (sectionsWatched.task?.task !== t && !creatingShown()) return null
  if (org !== undefined && org !== detail.org) return null
  const byUuid = id === t && (org !== undefined || !rows.issues.has(t))
  if (!byUuid && id !== detail.view.id) return null
  const answer = drawnAnswer
  if (!answer || answer.task.id !== t || answer.task.org_id !== detail.org) return null
  return { uuid: t, org: detail.org, answer, model: detail.view }
}

/* What a save says while the window's own answer of its task is not current
   (P.refuseStaleEdit), which the window's hint says as WAITS_FOR_CHECK. */
const STALE_SAVE_TEXT =
  "Couldn't save yet. Saving is available once Qivo can check this task for changes."

/* The writes from the window's own answer that change text a view's row
   does not send, the description or the labels, by their view part and
   the task they change (P.ownUnsentEdits), so the Board cannot tell from
   its row whether the task still matches a text filter until its answer
   holds the write. A description change ends with the views' deliveries
   that hold it, and a label toggle, which changes no view's row, once the
   server accepts it. */
const unsentText = new WeakMap<Paint, string>()

/* Labels whose toggle the server refused as not of the task's
   organization (convex/lib/limits.ts LABEL_NOT_IN_TASK_ORG). The app
   toggles only labels of the task's organization, and the server answers
   a label that no longer exists as it answers another organization's, so
   such a label was deleted since it was listed, as in a label picker's
   batch, which it reads only once. The picker drops them (P.labelGone). */
const goneLabels = new Set<string>()

/** What a toggle's refusal of a label deleted since it was listed says. */
const LABEL_GONE_TEXT = 'This label no longer exists.'

/** What the label toggles do on a refusal of label `labelId`. One that says
    the label is not of the task's organization keeps it in goneLabels and
    says it no longer exists, and any other is toasted as every refusal is.
    A refusal that follows a create (`created`) the server refused too says
    nothing, as the create's own toast says it all. */
function labelToggleRefused(labelId: string, created?: Promise<boolean>) {
  return (e: unknown) => {
    const d = errData(e)
    const gone = d.code === 'rule' && d.message === LABEL_NOT_IN_TASK_ORG
    if (gone) goneLabels.add(labelId)
    const say = () => (gone ? toast(`${LABEL_GONE_TEXT} Change reverted.`) : toastWriteError(e))
    if (!created) say()
    else
      void created.then((saved) => {
        if (saved) say()
      })
  }
}

/** P.toggleIssueLabel on the watched task the window shows from its own
    answer (answerTaskOf): whether the label goes on, and the cap, come
    from the painted answer's labels. It paints the answer and the
    workspace (labelRowsPaint), and marks the views' copies of the task,
    whose rows send no labels, as unsure under a text filter until the
    server accepts it (unsentText). `created` is as on the held path. The
    workspace need not hold the label: the server checks that it is one of
    the task's organization, and a refusal takes the paint back. */
function toggleAnswerLabel(a: AnswerTask, labelId: string, created?: Promise<boolean>) {
  if (refusePausedEdit()) return
  const uuid = a.uuid
  const on = !a.answer.labels.some((row) => row.label_id === labelId)
  const full = on && labelBlock(a.answer.labels)
  if (full) {
    toast(full)
    return
  }
  // A view's row sends no labels, so the marker changes no view's row and
  // no view's delivery holds it. It goes once the server accepts the
  // write, by when Convex has delivered every view's answer the write
  // changed (viewPartHeld), as one a label filter now matches differently.
  const marker = viewPaint([], () => undefined)
  unsentText.set(marker, uuid)
  const view: View = {
    detail: {
      task: uuid,
      paint: () => {
        const shown = detailRows.task
        if (!shown || shown.task.id !== uuid) return
        const has = shown.labels.some((row) => row.label_id === labelId)
        if (has === on) return
        shown.labels = on
          ? [...shown.labels, { issue_id: uuid, label_id: labelId }]
          : shown.labels.filter((row) => row.label_id !== labelId)
      },
    },
    view: marker,
    workspace: labelRowsPaint(uuid, labelId, on, a.org),
  }
  void send(api.labels.toggle, { org_id: a.org, issue_id: uuid, label_id: labelId, on }, view, {
    about: { task: uuid, answer: true },
    onError: labelToggleRefused(labelId, created),
  })
}

/** P.setIssueSubscribed on the watched task the window shows from its
    own answer (answerTaskOf): its follow is the answer's, which the write
    paints with the person's profile in the task's organization, as the
    workspace's rows once they hold the task (followRowsPaint). */
function followAnswerTask(a: AnswerTask, on: boolean) {
  const me = profileIn(a.org)
  const uuid = a.uuid
  if (!me || (a.answer.follow !== null) === on) return
  if (refusePausedWrite(on ? api.issues.subscribe : api.issues.unsubscribe)) return
  const at = new Date().toISOString()
  const view: View = {
    detail: {
      task: uuid,
      paint: () => {
        const shown = detailRows.task
        if (!shown || shown.task.id !== uuid || (shown.follow !== null) === on) return
        shown.follow = on ? { issue_id: uuid, profile_id: me, created_at: at } : null
      },
    },
    workspace: followRowsPaint(uuid, me, on, at, a.org),
  }
  void send(
    on ? api.issues.subscribe : api.issues.unsubscribe,
    { org_id: a.org, issue_id: uuid },
    view,
    { about: { task: uuid, answer: true } },
  )
}

/* The parent the window's own answer names for task `it`, the watched
   task, as a view model whose own parent that answer does not hold
   (store/taskDetail.ts shapeShortTask), kept while the painted answer
   holds the same row; undefined for another task or none. */
let parentShaped: { row: ShortRow; view: IssueVM } | null = null
function answerParent(it: { uuid: string; parent: string | null }): IssueVM | undefined {
  const row = it.parent && it.uuid === watchedComments ? paintedAnswer()?.parent : null
  if (!row) return undefined
  if (parentShaped?.row !== row)
    parentShaped = {
      row,
      view: shapeShortTask(row, PLANNER.handleNow(row.id, row.org_id, row.num)),
    }
  return parentShaped.view.id === it.parent ? parentShaped.view : undefined
}

/* What P.familyOf answered last for a task the window shows from its own
   answer, kept while the painted answer and the model are the same. */
let familyShaped: { answer: TaskOk; it: IssueVM; family: TaskFamily | null } | null = null

/* Task `it`'s family from the watched task's own answer (P.familyOf):
   the answer's whole list of leaf subtasks under it, with the parent the
   workspace or the answer holds, or null while the answer lacks one. */
function answerFamilyOf(it: IssueVM, answer: TaskOk): TaskFamily | null {
  if (familyShaped?.answer === answer && familyShaped.it === it) return familyShaped.family
  const kids = answerFamily(answer, it, PLANNER.handleNow)
  let family: TaskFamily | null = null
  if (kids) {
    const children = Object.keys(kids)
    const hidden = answer.task.has_hidden_subtasks
    const root: IssueVM = {
      ...it,
      children,
      hasHiddenSubtasks: hidden,
      isGroup: children.length > 0 || hidden,
    }
    const byId: Record<string, IssueVM> = { ...kids, [root.id]: root }
    const parent = root.parent ? (PLANNER.issueById[root.parent] ?? answerParent(root)) : undefined
    if (parent) byId[parent.id] = parent
    family = { root, byId, done: isIssueDone(root, byId) }
  }
  familyShaped = { answer, it, family }
  return family
}

/** P.updateIssue on the watched task the window shows from its own answer
    (answerTaskOf), which the workspace does not hold. It takes every field
    the window offers, Remove parent (a `parent` of null) and a parent the
    Parent picker offered, named by its uuid with its row in
    `opts.parentRow`, which the window's Parent row shows at once; a
    parent without that row is refused (PARENT_UNKNOWN). The held
    path's rules hold, read from the answer: the text caps, a new holder's
    sight of the tasks above (P.unseenAbove reads the answer's parent; a
    hidden parent and the parent's own parent are left to the server), a
    group's dates and own hours dropped and its status left out of the
    paint, where the answer's view model counts a subtask list that is not
    whole as a group, and each field equal to what the person saw left
    unsent. A group's status, Pause or new reviewer still goes, and the
    server refuses it, as on the held path. Its expected values are the
    painted answer's row with `opts.seen` over it, and its hidden parent
    pair. It paints the answer (`detail`), every view copy (`view`) and the
    workspace's row (`workspace`, which skips until the workspace holds the
    task), and sends to the answer's organization, marked as a write from
    the answer (WriteAbout). It joins no Roadmap history: a visit records
    nothing while a task window is open (recordRoadmapChange), so a drag on
    the Roadmap under the window saves as an ordinary write, as a held
    task's does. */
function updateAnswerTask(a: AnswerTask, patch: IssuePatch, opts: UpdateOptions): Promise<boolean> {
  if (refusePausedEdit()) return Promise.resolve(false)
  // a new parent comes from the Parent picker's row, which the window's
  // Parent row is painted from
  const parentRow = patch.parent && opts.parentRow?.id === patch.parent ? opts.parentRow : null
  if (patch.parent && !parentRow) {
    toast(PARENT_UNKNOWN, 'error')
    return Promise.resolve(false)
  }
  // text the server would refuse is refused before the paint, as on the
  // held path
  if ('title' in patch && refuseOver(LIMITS.title, cleanTitle(patch.title)))
    return Promise.resolve(false)
  if ('description' in patch && refuseText(LIMITS.description, patch.description ?? ''))
    return Promise.resolve(false)
  const it = a.model
  for (const holder of [patch.assignee, patch.reviewer]) {
    const unseen = holder ? PLANNER.unseenAbove(it, holder) : null
    const project = unseen && PLANNER.project(unseen.project)
    if (holder && project) {
      const who = knownName(holder) || 'This person'
      toast(
        `${who} has no access to ${PLANNER.projectLabel(project)}, where a task above ${it.key} is. Give them access or choose someone else.`,
        'error',
      )
      return Promise.resolve(false)
    }
  }
  // a group's dates come from its subtasks and it has no hours of its own;
  // a list that is not whole counts as a group (store/taskDetail.ts)
  const group = PLANNER.isGroup(it)
  let asked = patch
  if (group && ('start' in asked || 'end' in asked || 'remaining' in asked)) {
    asked = { ...asked }
    delete asked.start
    delete asked.end
    delete asked.remaining
    if (!Object.keys(asked).length) return Promise.resolve(true)
  }
  const row = a.answer.task
  const uuid = a.uuid
  const seenRow: Record<string, unknown> = { ...row, ...opts.seen }
  const wire = mapIssuePatch(asked, parentRow ?? undefined)
  if (!wire) {
    toast(PARENT_UNKNOWN, 'error')
    return Promise.resolve(false)
  }
  // as on the held path, a field sent with the value the person saw stays
  // unsent; a detach from a parent the person cannot see is a change
  for (const key of Object.keys(wire) as (keyof typeof wire)[]) {
    const value = wire[key]
    const shown = seenRow[key]
    const same =
      key === 'title'
        ? String(value ?? '').trim() === String(shown ?? '').trim()
        : key === 'description'
          ? (value || null) === (shown || null)
          : (key !== 'parent_id' || !row.has_hidden_parent) && (value ?? null) === (shown ?? null)
    if (same) delete wire[key]
  }
  if (!Object.keys(wire).length) return Promise.resolve(true)
  const paintDb = { ...wire }
  if (group) delete paintDb.status
  // a view's row sends no text
  const viewDb = { ...paintDb }
  delete viewDb.description
  // a detach, or a new parent, replaces a hidden parent too
  const parentChange = 'parent_id' in paintDb
  const newParent = paintDb.parent_id ?? null
  const prevDesc = String(row.description || '')
  const at = new Date().toISOString()
  // the new parent's short row as the window's next answer holds it
  const parentShort = newParent && parentRow ? parentShortOf(parentRow, at) : null
  const viewPart = viewPaint([uuid], () => {
    for (const copy of viewCopiesIn(uuid, a.org)) {
      stampTaskPatch(copy, viewDb, at)
      if (parentChange) copy.has_hidden_parent = false
    }
  })
  if ('description' in paintDb) unsentText.set(viewPart, uuid)
  const view: View = {
    detail: {
      task: uuid,
      paint: () => {
        const shown = detailRows.task
        if (!shown || shown.task.id !== uuid) return
        stampTaskPatch(shown.task, paintDb, at)
        // the parent goes, a hidden one too, or the new one shows
        if (parentChange) {
          shown.task.has_hidden_parent = false
          shown.parent = parentShort ? { ...parentShort } : null
        }
      },
    },
    view: viewPart,
    // skips until the workspace holds the task in its organization, then
    // paints it as the held path does
    workspace: () => {
      clearParentHours(newParent, at, a.org)
      if (!holdsIn(uuid, a.org)) return
      patchIssueRow(uuid, paintDb, at)
      if (parentChange) rows.hiddenParentTasks.delete(uuid)
      if ('description' in paintDb)
        paintDescriptionImages(uuid, prevDesc, String(paintDb.description || ''), at)
    },
  }
  // a kept draft rebases on the value on screen (shownOf), which reads the
  // workspace's row of the task first. While the workspace holds another
  // organization's task of this id, that row is another task's, so the
  // value comes from the window's own answer of this task, or none once
  // the window shows another
  const keep = opts.keepDraft
  return send(api.issues.update, { org_id: a.org, id: uuid, patch: wire }, view, {
    over: {
      ...overOf('issues', row, Object.keys(wire), opts.seen),
      hiddenParent: row.has_hidden_parent,
    },
    keepDraft:
      keep &&
      ((shown) => {
        if (!heldElsewhere(uuid, a.org)) return keep(shown)
        const field = Object.keys(wire)[0]
        const now = paintedAnswer()?.task
        const own = now?.id === uuid && now.org_id === a.org ? now : undefined
        return keep(own && Object.entries(own).find(([key]) => key === field)?.[1])
      }),
    keepUnsaved: opts.keepUnsaved,
    about: { task: uuid, answer: true },
  })
}

/** A link of `kind` from task `from` to task `to`, as seen from `from`, in
    the form the server stores it (convex/model/links.ts storedLink): a
    blocks link runs from the blocking task, a blocked_by one flips, and a
    relates link is ordered by uuid. Answers its source, target and type. */
function storedLinkOf(
  from: string,
  kind: string,
  to: string,
): [string, string, Row<'issue_links'>['type']] {
  if (kind === 'blocks') return [from, to, 'blocks']
  if (kind === 'blocked_by') return [to, from, 'blocks']
  return from < to ? [from, to, 'relates'] : [to, from, 'relates']
}

/** Picker row `row` as the short row the window's answer lists it by
    (convex/lib/taskWindow.ts ShortRow), without the picker's own fields,
    with whether it has subtasks, which a pick decides. */
function shortOfCandidate(row: RelationCandidate, has_subtasks: boolean): ShortRow {
  const { parent_id: _parent, has_hidden_parent: _hidden, exact: _exact, ...fields } = row
  return { ...fields, has_subtasks }
}

/** Picker row `row` as the short row of a new parent (convex/lib/taskWindow.ts
    ShortRow) the window's answer holds once the server attached the
    opened task under it: a group, without the row's own hours, which a
    parent loses when it gains a subtask (clearParentHours). */
function parentShortOf(row: RelationCandidate, at: string): ShortRow {
  const short = shortOfCandidate(row, true)
  if (short.remaining_hours != null || short.review_at != null) {
    short.remaining_hours = undefined
    short.remaining_set_at = undefined
    short.review_at = undefined
    short.updated_at = at
  }
  return short
}

/* Paints the issues.update wire patch `db` on task `uuid` at `at`, with the
   server's touch and stamp rules (updateIssueCore, 0072), worked out from
   the row it paints. The wire carries null-to-clear; the STORED row carries
   absence as undefined (the snapshot's own shape), so nulls translate on
   the way in. Skips a task that is gone. */
function patchIssueRow(uuid: string, db: IssueWirePatch, at: string) {
  const row = rows.issues.get(uuid)
  if (row) stampTaskPatch(row, db, at)
}

/* The task fields issues.update's stamps touch, of a workspace row or a
   view's answer row (store/viewRows.ts). */
type PatchedTask = Pick<
  Row<'issues'>,
  | 'status'
  | 'paused'
  | 'updated_at'
  | 'done_at'
  | 'status_at'
  | 'remaining_hours'
  | 'remaining_set_at'
  | 'review_at'
  | 'reviewer_id'
  | 'project_id'
>

/* Paints wire patch `db` on task row `row` at `at` with the server's touch
   and stamp rules (patchIssueRow). */
function stampTaskPatch(row: PatchedTask, db: IssueWirePatch, at: string) {
  const prevStatus = row.status
  const before = { status: row.status, reviewer_id: row.reviewer_id, review_at: row.review_at }
  const oldRem = row.remaining_hours == null ? null : Number(row.remaining_hours)
  const newRem = db.remaining_hours == null ? null : Number(db.remaining_hours)
  const remChanged = 'remaining_hours' in db && oldRem !== newRem
  Object.entries(db).forEach(([k, v]) => {
    ;(row as Record<string, unknown>)[k] = v === null ? undefined : v
  })
  // mirror the server's pause rule: a move into Done or Backlog resumes
  if (db.status === 'done' || db.status === 'backlog') row.paused = false
  row.updated_at = at // mirror the server's touch
  // mirror updateIssueCore's stamps: a status change stamps status_at now,
  // and a move into Done stamps done_at while a move out clears it (0071)
  if (db.status !== undefined && db.status !== prevStatus) {
    row.done_at = db.status === 'done' ? row.updated_at : undefined
    row.status_at = row.updated_at
  }
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

/* Paints what the server's description save does to task `uuid`'s images
   (convex/model/descriptionImages.ts settleDescriptionImages): an inline
   image no `att:` of the new text names any more is dropped at `at`, so
   the attachment cap frees its place at once, and a dropped one the new
   text shows is back. The server also drops images no saved text named
   for a day, which a delivery brings. */
function paintDescriptionImages(uuid: string, before: string, after: string, at: string) {
  const was = imageRefs(before)
  const named = imageRefs(after)
  const shown = shownImages(after)
  for (const a of rows.attachments.values()) {
    if (a.issue_id !== uuid) continue
    if (a.inline && a.dropped_at === undefined && was.has(a.id) && !named.has(a.id))
      rows.attachments.set(a.id, { ...a, dropped_at: at })
    else if (a.dropped_at !== undefined && shown.has(a.id))
      rows.attachments.set(a.id, { ...a, dropped_at: undefined })
  }
}

/* The paint of new task `row` in the workspace's rows, in a store that
   asked for every task (newTaskParts): inserted unless the server's row is
   there, its dependents included, with the number the server answered
   (`created.num`) or else the next one free in its organization's counter,
   which it raises. A task created under a parent clears the parent's own
   hours, as the server does. */
function newTaskPaint(row: Row<'issues'>, created: { num: number | null }): Paint {
  return () => {
    const org = rows.orgs.get(row.org_id)
    if (rows.issues.has(row.id) || !org || !rows.projects.has(row.project_id)) return
    const num = created.num ?? Math.max(row.num, (org.next_issue_num || 0) + 1)
    org.next_issue_num = Math.max(org.next_issue_num || 0, num)
    rows.issues.set(row.id, { ...row, num })
    clearParentHours(row.parent_id, row.created_at, row.org_id)
  }
}

/* The paint of new task `row`'s number in the workspace's rows, in a store
   that never asked for every task, whose rows hold no task: its
   organization's counter, raised to the number the server answered or
   the preview (store/layers.ts rule 3), so the next create's preview is
   the number after it. */
function newTaskCounterPaint(row: Row<'issues'>, created: Created): Paint {
  return () => {
    const org = rows.orgs.get(row.org_id)
    if (!org) return
    org.next_issue_num = Math.max(org.next_issue_num || 0, created.num ?? row.num)
  }
}

/** The views a new task goes into: those whose read runs now and takes
    the person's new tasks (ViewQuery takesNew), the Board's and the
    Roadmap's, captured when the create is sent (store/layers.ts rule 2).
    A view whose read stopped, as a kept page behind another, takes none:
    its rows hear no change until it reads again. */
function newTaskSlots(): ViewSlot[] {
  const out: ViewSlot[] = []
  for (const [slot, read] of viewReads)
    if (read.query.takesNew && read.live !== null && viewRows.holds(slot)) out.push(slot)
  return out
}

/** The views of `slots` whose read runs but whose newest result is not a
    current one, as after a reconnect until its result arrives again. A
    create's acceptance shows nothing of what such a read holds, so a new
    task's insert stays there until its next delivery (viewPartHeld). Every
    other read that runs has delivered what the create changed before the
    create answered (lib/convexOrdering.test.ts), so its answer decides
    whether the new task shows, and a stopped one reads afresh when it
    shows again. */
function slotsBehind(slots: readonly ViewSlot[]): ViewSlot[] {
  return slots.filter((slot) => {
    const read = viewReads.get(slot)
    if (!read || read.live === null) return false
    return !(read.current && read.connection === latestConnection && !read.behind)
  })
}

/** New task `row`, numbered `num`, as a view's answer sends it (ViewRow):
    no text, no hidden parent or subtasks, and a group without the facts
    only a read of its subtasks gives when `group`. */
function newViewRow(row: Row<'issues'>, num: number, group: boolean): ViewRow {
  const { description: _text, ...fields } = row
  return {
    ...fields,
    num,
    has_subtasks: group,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
}

/** The `view` part of the create of new task `row` (P.addIssue,
    P.createParent, P.createLinked) in the views `slots` (newTaskSlots):
    its row goes into each view's rows that do not hold it yet
    (viewRows.insert), with the number the server answered (`created`) or
    else the preview, never the counter's next one, and with the stored
    row once the create answered with it. Where it went in, the other end
    of the create in the same view changes too, so the view files them
    together: a new subtask's parent becomes a group without its own hours
    or review hand-off (clearParentHours), and the subtask of a new parent
    (`child`) names it as its parent. A view whose rows hold the task
    already, as its answer that holds the create, changes nothing
    (store/layers.ts rule 4). A new parent (`group`) has no dates until a
    read brings its facts. */
function newTaskViewPaint(
  slots: readonly ViewSlot[],
  row: Row<'issues'>,
  created: Created,
  ends: { group?: boolean; child?: string } = {},
): Paint {
  const tasks = [
    row.id,
    ...(row.parent_id ? [row.parent_id] : []),
    ...(ends.child ? [ends.child] : []),
  ]
  const paint = viewPaint(tasks, () => {
    const next = newViewRow(answeredRow(row, created), created.num ?? row.num, !!ends.group)
    for (const slot of slots) {
      if (!viewRows.insert(slot, next)) continue
      // each end is of the new task's organization, so a view's task of
      // another organization with its id is another task, which stays
      // (viewCopiesIn)
      const parent = row.parent_id ? viewRows.editIn(slot, row.parent_id) : undefined
      if (parent?.org_id === row.org_id) {
        parent.has_subtasks = true
        if (parent.remaining_hours != null || parent.review_at != null) {
          parent.remaining_hours = undefined
          parent.remaining_set_at = undefined
          parent.review_at = undefined
          parent.updated_at = row.created_at
        }
      }
      const child = ends.child ? viewRows.editIn(slot, ends.child) : undefined
      if (child?.org_id === row.org_id && child.parent_id !== row.id) {
        child.parent_id = row.id
        child.has_hidden_parent = false
        child.updated_at = row.created_at
      }
    }
  })
  viewPaintSlots.set(paint, new Set(slots))
  return paint
}

/** The parts of the create of new task `row` beside its window's: the
    views' rows (newTaskViewPaint) and the workspace's, which in a store
    that asked for every task (`asked`, captured at send) take the task as
    every held task's, so a delivery with every task keeps it on screen
    (`held`, the create's own workspace paint), and in one that never
    asked only the organization's counter, since no delivery would keep a
    task there. Answers the view to send, and the one an answer keeps:
    the views' rows end at the answer in every view whose read is current
    then, and stay only where a read is behind (slotsBehind). */
function newTaskParts(
  row: Row<'issues'>,
  created: Created,
  asked: boolean,
  held: Paint,
  ends: { group?: boolean; child?: string } = {},
) {
  const slots = newTaskSlots()
  const workspace = asked ? held : newTaskCounterPaint(row, created)
  const at = (live: readonly ViewSlot[]): View =>
    live.length ? { workspace, view: newTaskViewPaint(live, row, created, ends) } : { workspace }
  return { sent: at(slots), kept: () => at(slotsBehind(slots)) }
}

/** Records the create of new task `row` of the person's own as on its way
    (PendingCreate), and answers what its write does on the server's
    answer: `take` keeps the answer (`created`), and `refused` keeps the
    refusal, so a window on the task shows it as gone and the writes sent
    behind it say no more (refusedCreates). */
function pendingCreate(
  row: Row<'issues'>,
  created: Created,
  level: ShortRow['level'],
  ends: { parent?: ShortRow | null; child?: ShortRow | null } = {},
) {
  const uuid = row.id
  pendingCreates.set(uuid, {
    org: row.org_id,
    row,
    created,
    level,
    parent: ends.parent ?? null,
    child: ends.child ?? null,
    taken: false,
    answer: null,
  })
  // a number a view's answer or an earlier create of the person's own
  // holds already moves before the first paint; no caller holds its
  // preview yet
  renumberPending()
  pendingMoves.delete(uuid)
  return {
    take(answer: { num: number; row?: Partial<Row<'issues'>> }) {
      created.num = answer.num
      // merged over what was sent: an answer may name fewer fields
      if (answer.row) created.row = { ...answer.row }
    },
    refused() {
      pendingCreates.delete(uuid)
      refusedCreates.add(uuid)
      // a window on it shows it as gone once the refusal's paint goes
      if (watchedComments === uuid) owe('sections')
    },
  }
}

/** Short row `row` of a task, as the window's answer lists the parent of a
    new subtask (convex/lib/taskWindow.ts ShortRow), with the person's
    `level` on its project: a group, without the hours and review hand-off
    a task loses when it gains a subtask (clearParentHours), as of `at`. */
function newParentShort(
  row: Row<'issues'> | TaskOk['task'],
  level: ShortRow['level'],
  at: string,
): ShortRow {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_parent: _hiddenParent,
    has_hidden_subtasks: _hidden,
    has_subtasks: _group,
    ...fields
  } = row as TaskOk['task']
  const short: ShortRow = { ...fields, has_subtasks: true, level }
  if (short.remaining_hours != null || short.review_at != null) {
    short.remaining_hours = undefined
    short.remaining_set_at = undefined
    short.review_at = undefined
    short.updated_at = at
  }
  return short
}

/** Short row `row` of a task the window shows from its answer, with the
    person's `level` on its project, as the window's answer of its new
    parent (P.createParent) lists it once the server attached it, at
    `at`. */
function newChildShort(row: TaskOk['task'], level: ShortRow['level'], at: string): ShortRow {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_parent: _hiddenParent,
    has_hidden_subtasks: _hidden,
    has_subtasks: group,
    ...fields
  } = row
  return { ...fields, has_subtasks: !!group, level, updated_at: at }
}

/** Whether a write about task `about.task`, or the task its arguments name
    (`issue_id`, else `id`), went out behind a create the server refused
    (refusedCreates). It reached the server after the create, as Convex
    runs one client's mutations in the order sent, and was refused for a
    task that never existed, which the create's own refusal said already. */
function refusedBehind(about: WriteAbout | undefined, args: unknown): boolean {
  if (refusedCreates.size === 0) return false
  const a = (args ?? {}) as { id?: unknown; issue_id?: unknown }
  const task =
    about?.task ??
    (typeof a.issue_id === 'string' ? a.issue_id : typeof a.id === 'string' ? a.id : undefined)
  return task !== undefined && refusedCreates.has(task)
}

/* The person's answer the keep-open notice waits for
   (P.answerInboxNotice), while a bulk Inbox action shows it. */
let noticeAnswer: ((go: boolean) => void) | null = null

/** What shows the keep-open notice: the Inbox, while it shows
    (P.hostInboxNotice). `prepare` readies it to ask, such as by closing
    its row menu, and answers false when the notice must not open now,
    such as while the person types in a field. */
type NoticeHost = { prepare: () => boolean }

/* The Inbox that shows the notice now, if any. */
let noticeHost: NoticeHost | null = null

/** A press of a bulk Inbox action, with the Inbox that showed it, when it
    asks for the notice. */
type Press = { host: NoticeHost | null }

/* The press still asking messages.bulkReach or waiting for its notice, if
   any. Its Inbox unregistering ends it (P.hostInboxNotice), and what a
   press does once it is no longer this one is nothing. */
let asking: Press | null = null

/* The keys of the stop toasts a bulk Inbox action left on screen, so a
   later run that finishes there takes them away. */
const stopToasts = new Set<string>()

/** How long a press of a bulk Inbox action waits for the inbox writes sent
    before it and then for messages.bulkReach, so a connection that drops
    while it asks does not hold the buttons disabled. */
const REACH_WAIT_MS = 10_000

/** Sets P.inboxBulk and shows it in the Inbox. */
function setInboxBulk(next: InboxBulk | null) {
  PLANNER.inboxBulk = next
  emit('inbox')
}

/** messages.bulkReach's answer for `action`, asked once every inbox write
    sent before the press has been answered (inboxWrites), so its cutoffs
    and counts include them, such as a message marked unread or read just
    before. Null when the question fails, or when the writes and the answer
    do not come within REACH_WAIT_MS of the press. */
async function askReach(action: BulkAction) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REACH_WAIT_MS)
  })
  try {
    const earlier = Promise.allSettled(inboxWrites).then(() => true)
    if ((await Promise.race([earlier, late])) === null) return null
    const answer = await Promise.race([convex.query(api.messages.bulkReach, { action }), late])
    return answer && Array.isArray(answer.seats) ? answer : null
  } catch (error) {
    console.error('[qivo] could not ask how much an Inbox action has to do:', error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** One seat a bulk Inbox action sends batches to, with the cutoff
    bulkReach answered for it at the press, which every Mark all as read
    batch there passes. */
type BulkSeat = { org: string; before?: number }

/** A row the Inbox showed when a bulk action was pressed
    (P.markAllMessagesRead, P.deleteReadMessages): its organization, task
    and cutoff, and whether it was read and snoozed. */
export type ShownInboxRow = {
  org: string
  task: string
  through: number
  read: boolean
  snoozed: boolean
}

/** The seats bulkReach says a bulk Inbox action has work in, in seat
    order, each with its cutoff, whether the action needs more than one
    round and why (InboxBulk.why): a seat with more than one batch, or more
    seats with work than BULK_SEATS. */
function planBulk(reach: NonNullable<Awaited<ReturnType<typeof askReach>>>) {
  const answered = new Map(reach.seats.map((seat) => [seat.org_id, seat]))
  // a seat the server did not list holds no active seat there
  const seats = [...myProfiles.keys()].flatMap((org): BulkSeat[] => {
    const seat = answered.get(org)
    return seat === undefined || seat.reach === 'none' ? [] : [{ org, before: seat.before }]
  })
  const many = seats.some(({ org }) => answered.get(org)?.reach === 'many')
  const long = many || seats.length > BULK_SEATS
  return { seats, long, why: long ? (many ? ('many' as const) : ('seats' as const)) : null }
}

/** Shows sticky stop toast `text` under `key` and remembers it until the
    person closes it or a later run takes it away (stopToasts). */
function showStopToast(key: string, text: string) {
  stopToasts.add(key)
  window.showToast?.(text, 'error', { sticky: true, key, onDismiss: () => stopToasts.delete(key) })
}

/** Takes away stop toast `key` when one shows. */
function dropStopToast(key: string) {
  if (!stopToasts.delete(key)) return
  window.dismissToast?.(key)
}

/* Runs bulk Inbox action `action` (Mark all as read or Remove all read)
   with its progress in P.inboxBulk. It waits for the inbox writes sent
   before the press, then asks messages.bulkReach, and skips the seats with
   nothing to do. When the writes or the answer do not come within
   REACH_WAIT_MS, or the question fails, it changes nothing and says so,
   because only bulkReach gives each seat its cutoff. With `ask`, an action
   of more than one round waits for the keep-open notice
   (P.answerInboxNotice) and sends nothing when the person cancels it; the
   press ends, sending nothing, when the Inbox that showed it hides or goes
   (P.hostInboxNotice). Then the `messages` it reached when pressed show
   `paint`, under one umbrella layer per seat, and the `flags` it clears
   under one more; rows that arrived later stay as they are, as the press's
   cutoff leaves them out. The Inbox's rows on screen at the press, `shown`,
   that the action changes in a planned seat, the unread ones that are not
   snoozed for Mark all as read and the read ones that are not snoozed for
   Remove all read, take a read or removed mark at their cutoff
   (P.inboxMarks). A seat's marks settle when its lane ends, a stop ends
   them at once, so a refused seat's rows come back, and a fault ends them
   all. The seats run on the shared runner
   (lib/batchRunner.ts runLanes), at most BULK_SEATS at once, a long action
   on the app's shared lanes: each sends `batch` until an answer has no
   more, every Mark all as read batch with its seat's cutoff from the
   press, and each batch keeps a layer, `named`, for the rows its answer
   names (`keep`).
   A seat's umbrella goes when its batches end, so a refused or paused batch
   takes back only the rows no accepted batch named, and the seat stops
   while the others go on. The pause (refusedAsPaused) stops every seat,
   the queued ones before they send anything. The first refusal takes the
   flags back; with every seat done they stay until the next delivery. The
   last seat's umbrella and the flags end in one repaint. A long action ends
   with a toast of what it did, a seat a refusal stopped with a sticky toast
   of what was done there and what was not, the pause with one such toast
   for every seat it stopped, and a short action that finished with
   nothing, as its rows show it. A later run that finishes in an
   organization takes that action's stop toasts there away.
   Every batch's outcome is known in this session: the Convex client sends
   a write in flight again after a reconnect and answers it, so nothing
   here stops waiting for an answer that could still commit. A reload or a
   disposed store ends the action, and the next press asks bulkReach again
   for a new cutoff. A fault here, such as a paint that throws, ends the
   action, its paints and its notice, and says so. */
async function bulkInboxAction<R extends { ids: string[]; hasMore: boolean }>(
  action: BulkAction,
  ask: boolean,
  a: {
    ref: FunctionReference<'mutation'>
    messages: () => MessageVM[]
    paint: (ids: string[]) => View
    named: (ids: string[]) => View
    flags: View
    count: (answer: R) => number
  },
  batch: (seat: BulkSeat, previous: R | null, keep: (answer: R) => View) => Promise<R>,
  shown: readonly ShownInboxRow[] = [],
): Promise<void> {
  if (bulkBusy(PLANNER.inboxBulk) || refusePausedWrite(a.ref)) return
  const epoch = storeEpoch
  const live = () => epoch === storeEpoch
  // this press, which an Inbox that hides or goes ends while it asks
  const press: Press = { host: ask ? noticeHost : null }
  asking = press
  const current = () => live() && asking === press
  // the rows the press reaches, as loaded now
  const pressed = messagesByOrg(a.messages().map((message) => message.id))
  const opened: Layer[] = []
  // the marks of the shown rows the action changes, by seat
  const marked = new Map<string, MarkOf[]>()
  const endMarks = (org: string | null, accepted: boolean) => {
    for (const [seat, marks] of marked)
      if (org === null || seat === org) settleInboxMarks(marks, accepted)
  }
  try {
    let bulk: InboxBulk = {
      action,
      state: 'asking',
      long: false,
      why: null,
      done: 0,
      seats: 0,
      seatsDone: 0,
      stops: [],
    }
    setInboxBulk(bulk)
    const reach = await askReach(action)
    if (!current()) return
    if (reach === null) {
      asking = null
      setInboxBulk(null)
      return toast(bulkUncheckedText(action))
    }
    const plan = planBulk(reach)
    // the pause may have begun while bulkReach was asked
    if (plan.seats.length === 0 || refusePausedWrite(a.ref)) {
      asking = null
      return setInboxBulk(null)
    }
    bulk = { ...bulk, long: plan.long, why: plan.why, seats: plan.seats.length }
    if (plan.long && ask) {
      // only the Inbox that showed the press asks, and not over a field the
      // person types in
      if (!press.host || noticeHost !== press.host || !press.host.prepare()) {
        asking = null
        return setInboxBulk(null)
      }
      setInboxBulk({ ...bulk, state: 'notice' })
      const go = await new Promise<boolean>((resolve) => {
        noticeAnswer = resolve
      })
      if (!current()) return
      asking = null
      if (!go || refusePausedWrite(a.ref)) return setInboxBulk(null)
    }
    asking = null
    for (const { org } of plan.seats)
      marked.set(
        org,
        setInboxMarks(
          shown
            .filter(
              (row) =>
                row.org === org && !row.snoozed && (action === 'read' ? !row.read : row.read),
            )
            .map((row) => ({
              org,
              task: row.task,
              mark:
                action === 'read'
                  ? { through: row.through, read: true }
                  : { through: row.through, removed: true },
            })),
        ),
      )
    const name = getFunctionName(a.ref)
    const flag = openUmbrella(name, a.flags)
    opened.push(flag)
    const umbrellas = new Map<string, Layer>()
    for (const { org } of plan.seats) {
      const umbrella = openUmbrella(name, a.paint(pressed.get(org) ?? []))
      opened.push(umbrella)
      umbrellas.set(org, umbrella)
    }
    bulk = { ...bulk, state: 'running' }
    setInboxBulk(bulk)
    const keep = (answer: R) => a.named(answer.ids)
    const stops: BulkStop[] = []
    // the rows each seat's accepted batches confirmed
    const doneIn = new Map<string, number>()
    let last: Layer | null = null
    const ran = await runLanes<BulkSeat, R>({
      lanes: plan.seats,
      // a long action shares the app's lanes with every other large action
      pool: plan.long ? LANE_POOL : undefined,
      live,
      send: (seat, previous) => batch(seat, previous, keep),
      more: (_seat, answer) => answer.hasMore,
      pauseOf: (error) => (refusedAsPaused(error) ? refusalPauseText(error) : null),
      reasonOf: refusalSentence,
      onAnswer: (seat, answer) => {
        const count = a.count(answer)
        doneIn.set(seat.org, (doneIn.get(seat.org) ?? 0) + count)
        bulk = {
          ...bulk,
          long: bulk.long || answer.hasMore,
          done: bulk.done + count,
          seatsDone: bulk.seatsDone + (answer.hasMore ? 0 : 1),
        }
        setInboxBulk(bulk)
      },
      onStop: ({ lane: seat, reason, paused }) => {
        // the seat's rows show as the server keeps them, at once
        endMarks(seat.org, false)
        // the first stop takes the flags back
        if (stops.length === 0) endUmbrella(flag, false)
        stops.push({ org: seat.org, done: doneIn.get(seat.org) ?? 0, reason, paused })
        bulk = { ...bulk, stops: [...stops] }
        setInboxBulk(bulk)
      },
      onLaneEnd: (seat, lastSeat) => {
        endMarks(seat.org, true)
        const umbrella = umbrellas.get(seat.org)
        // the last seat's umbrella ends with the flags in one repaint
        if (lastSeat) last = umbrella ?? null
        else if (umbrella) endUmbrella(umbrella, false)
      },
    })
    if (ran === null) return endMarks(null, false)
    const finished = ran.finished.map((seat) => seat.org)
    together(() => {
      if (last) endUmbrella(last, false)
      endUmbrella(flag, stops.length === 0)
    })
    bulk = { ...bulk, state: stops.length ? 'stopped' : 'finished' }
    setInboxBulk(bulk)
    const orgName = (org: string) => rows.orgs.get(org)?.name ?? 'an organization'
    const keyOf = (org: string) => `inbox-bulk:${action}:${org}`
    // a seat that finished now leaves no stop toast of an earlier run
    for (const org of finished) dropStopToast(keyOf(org))
    if (stops.every((stop) => !stop.paused)) dropStopToast(keyOf('pause'))
    for (const stop of stops)
      if (!stop.paused)
        showStopToast(
          keyOf(stop.org),
          bulkStopText(action, [{ orgName: orgName(stop.org), done: stop.done }], stop.reason),
        )
    const pauses = stops.filter((stop) => stop.paused)
    if (pauses.length)
      showStopToast(
        keyOf('pause'),
        bulkStopText(
          action,
          pauses.map((stop) => ({ orgName: orgName(stop.org), done: stop.done })),
          pauses[0].reason,
        ),
      )
    if (stops.length === 0 && bulk.long) toast(bulkDoneText(bulk), 'success')
  } catch (fault) {
    if (asking === press) asking = null
    endMarks(null, false)
    if (!live()) return
    reportFault(fault)
    noticeAnswer = null
    for (const layer of opened) endUmbrella(layer, false)
    setInboxBulk(null)
    toast(`${bulkName(action)} stopped after a fault in Qivo. What it already did stays done.`)
  }
}

/* The paint of removing messages `ids`. With `onlyRead` it removes, as the
   server's Remove all read selects at commit, only those still read and not
   snoozed, for rows named before the server answered. */
function removeMessagesPaint(ids: string[], onlyRead = false): View {
  return {
    workspace: () =>
      ids.forEach((id) => {
        const row = rows.messages.get(id)
        if (!row) return
        if (onlyRead && (row.read_at === undefined || row.snoozed_until !== undefined)) return
        rows.messages.delete(id)
      }),
  }
}

/** The values of `row`'s `fields` on screen before a write paints over them
    (Over), for the field check. `seen` replaces some of them with what an
    editor showed when the person began, such as a title at the click. */
function overOf(
  table: string,
  row: { id: string },
  fields: string[],
  seen: Record<string, unknown> = {},
): Over {
  const values: Record<string, unknown> = { ...row, ...seen }
  return { table, id: row.id, fields: Object.fromEntries(fields.map((f) => [f, values[f]])) }
}

/** The value on screen of `over`'s first field, for a kept draft
    (SendOptions.keepDraft): a task's, a comment's, or a settings field's
    organization, team, project or person. A task the workspace does not
    hold shows from the window's painted answer, else a view's row. */
function shownOf(over: Over | undefined): unknown {
  const field = over && Object.keys(over.fields)[0]
  if (!over || !field) return undefined
  const table: Partial<Record<string, { get: (id: string) => object | undefined }>> = {
    issues: rows.issues,
    comments: rows.comments,
    organizations: rows.orgs,
    teams: rows.teams,
    projects: rows.projects,
    profiles: rows.profiles,
  }
  const unheld = () => {
    const answer = paintedAnswer()
    return answer?.task.id === over.id ? answer.task : viewRows.peek(over.id)
  }
  const row = table[over.table]?.get(over.id) ?? (over.table === 'issues' ? unheld() : undefined)
  return row ? Object.entries(row).find(([key]) => key === field)?.[1] : undefined
}

/* The fields the app sends as prints rather than values, with their
   compare forms (convex/lib/fieldPrints.ts), so an edit never carries a long
   text twice. */
const PRINTED: Record<string, Record<string, (value: unknown) => unknown>> = {
  issues: { title: trimmedForm, description: descriptionForm },
  comments: { body: trimmedForm },
}

/** A write's `expected` from `over` (convex/model/expected.ts): null for
    unset, a long text as its print, and a task's parent as the pair a read
    shows, with has_hidden_parent: the one `over` carries from the row it
    was made from, such as the window's own answer, else the workspace's.
    Read before the write's paint, which may take the hidden parent away. */
function expectedOf(over: Over): Record<string, unknown> {
  const printed = PRINTED[over.table] ?? {}
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(over.fields)) {
    const form = printed[field]
    out[field] = form ? printOf(form(value)) : (value ?? null)
  }
  if (over.table === 'issues' && 'parent_id' in over.fields)
    out.has_hidden_parent =
      over.fields.parent_id == null && (over.hiddenParent ?? rows.hiddenParentTasks.has(over.id))
  return out
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
/** What the Archived tasks page reads (P.fetchArchivedPage): some projects
    of organization `org`, a top-level project standing for its
    sub-projects, or, chosen on purpose, every project of `org`. */
export type ArchivedScope = { org: string; projectIds: string[] } | { org: string; all: true }
type SearchPageData = FunctionReturnType<typeof api.search.page>
/** A narrower scope for main Search (P.fetchSearchPage) than every
    organization: one organization, and in it one project. */
export type SearchScope = NonNullable<FunctionArgs<typeof api.search.page>['scope']>
/** A task result of main Search, with its display key ("QN-12") and the
    handle the app had for it when the page arrived (handleFor), which the
    list names its row by. Opening it reads the handle again (handleNow). */
export type SearchTaskRow = Extract<SearchPageData['rows'][number], { kind: 'task' }> & {
  key: string
  handle: string
}
/** A project result of main Search, as the server sends it. */
export type SearchProjectRow = Extract<SearchPageData['rows'][number], { kind: 'project' }>
export type SearchRow = SearchTaskRow | SearchProjectRow
/** What P.fetchSearchPage answers: a page; a refusal with its code and
    sentence, `bad_request` for a cursor of another search and `rule` for a
    text past LIMITS.search; or a failed read. */
export type SearchPageAnswer =
  | {
      state: 'ok'
      rows: SearchRow[]
      nextCursor: string | null
      coverage: SearchPageData['coverage']
    }
  | { state: 'refused'; code: 'bad_request' | 'rule'; message: string }
  | { state: 'failed' }
export type ProjectPatch = Partial<{
  name: string
  lead: string | null
  description: string | null
  key: string
  trackDelay: boolean
  reviewHours: number | null // null inherits; the caller passes a rounded value
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
}>
export type TeamPatch = Partial<{
  name: string
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
/** What a settings field gives a save of its draft (lib/savedDraft.ts).
    `seen` holds the values the draft began from, by the row's field names,
    such as `max_attachment_mb`, which go out as the write's `expected` in
    place of the row on screen. keepDraft and keepUnsaved run when a sent
    save fails (SendOptions). Without them a save checks the values on screen.
    onSettled runs once the server answered a sent save, either way, after
    keepDraft or keepUnsaved, for a field that tells its list while its save
    waits (P.updateUser's name, address and hours). */
export type FieldSave = {
  seen?: Record<string, unknown>
  keepDraft?: SendOptions<unknown>['keepDraft']
  keepUnsaved?: () => void
  onSettled?: () => void
}

/** A project as a page that read it from the server showed it
    (projectSettings.get), for a write the workspace may not hold the
    project for: its organization. */
export type ProjectShown = { orgId: string }

/** A team as a page that read it from the server showed it (teams.get), for
    a write the workspace may not hold the team for: its organization and
    the name the page showed, the write's `expected`. */
export type TeamShown = { orgId: string; name: string }

/** A member as a team's page showed them (teams.members): the team's
    organization and whether the page showed them leading the team. */
export type MemberShown = { orgId: string; isLeader: boolean }

/** A label as Settings › Labels showed it (labels.settingsPage, or the
    store's catalogue while it holds the label): its organization, name and
    color, which a write sends as its `expected`. */
export type LabelShown = { orgId: string; name: string; color: string }

/** A grant as a page that read it from the server showed it: the
    project's organization, the level the grant held there (null for none)
    and, for a person's, the project's own lead (projects.lead_id, null for
    none), which the write decides and checks from. */
export type GrantShown = ProjectShown & { level: GrantLevel | null; leadId: string | null }

/** The send() options of settings field save `save`: its callbacks, and for
    a field that keeps its draft the notice that asks for Keep mine. */
const fieldSendOptions = (save: FieldSave) => ({
  keepDraft: save.keepDraft,
  keepUnsaved: save.keepUnsaved,
  ...(save.keepDraft ? { notice: { keepMine: true } } : {}),
  ...(save.onSettled ? { onSettled: save.onSettled } : {}),
})
/** What a new personal token may do and the instant it stops working (UTC
    ISO 8601). Both are fixed when it is created; no expiresAt means never. */
export type McpTokenChoice = {
  access: FunctionArgs<typeof api.tokens.createMcpToken>['access']
  expiresAt?: string
}
/** The credential tables an admin can revoke from on API access. */
export type ApiCredentialTable = FunctionArgs<typeof api.apiAccess.revoke>['table']
/** What one API access page asks for (P.apiAccessPage). */
export type ApiAccessPageArgs = Omit<FunctionArgs<typeof api.apiAccess.page>, 'org_id'>

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
  /** The loader of description and comment images (lib/inlineImages.ts),
      one a store. */
  inlineImages,
  /** What the file URL mints, the pictures and the inline images hold now,
      for the benchmark page's measurement and the closing review. */
  fileStats: () => ({
    mints: {
      running: mintQueue.running(),
      most: mintQueue.mostRunning(),
      sent: mintQueue.sent(),
    },
    pictures: {
      keptBytes: avatarSources.keptBytes(),
      downloading: avatarSources.downloading(),
      mostDownloading: avatarSources.mostDownloading(),
      named: namedPictures.length,
    },
    people: {
      cached: profileCache.size(),
      named: profileCache.named().length,
      reads: profileCache.reads().map((read) => read.ids.length),
    },
    images: inlineImages.stats(),
  }),
  setInboxOpener,
  get roadmapUndo() {
    return {
      count: roadmapVisit?.count ?? 0,
      // any write in flight: a task content write clears the history when
      // it is accepted, which an undo sent before it would not know
      busy: (roadmapVisit?.pending ?? 0) > 0 || layers.waiting(),
      disabled: !roadmapVisit || roadmapVisit.disabled,
    }
  },
  /** Runs `change`, whose Roadmap operations go to the server as one write
      with one layer that holds all their paints. */
  batchRoadmapChanges: (change: () => void) => {
    if (roadmapBatch || !roadmapVisit || roadmapVisit.disabled || roadmapDetailOpen) {
      change()
      return
    }
    const batch: NonNullable<typeof roadmapBatch> = {
      operations: [],
      saved: [],
      layer: layers.open('roadmap:change', {}),
    }
    roadmapBatch = batch
    try {
      change()
    } finally {
      roadmapBatch = null
      if (!batch.operations.length) layers.remove(batch.layer)
      else
        void submitRoadmapChanges(batch.operations, batch.layer).then((ok) => {
          for (const answer of batch.saved) answer(ok)
        })
    }
  },
  /** Moves a task only the Roadmap's dependency answer holds, for
      Auto-move (moveDependencyTask). */
  moveDependencyTask,
  undoRoadmap: (all = false) => {
    expireRoadmapHistory()
    const visit = roadmapVisit
    if (!visit || visit.disabled || visit.pending || layers.waiting()) return
    if (!visit.count || refusePausedEdit()) return
    visit.pending++
    // the undone values arrive with the next delivery
    void send(api.roadmap.undo, { session_id: visit.id, all }, 'none', {
      onOk: (result) => {
        if (roadmapVisit === visit && !visit.disabled) visit.count = result.count
        toast(all ? 'Roadmap changes reverted' : 'Roadmap change undone', 'success')
      },
      onError: (error) => {
        // A conflicting history remains unavailable until a fresh visit. The
        // server refused the entire undo, preserving all current work.
        const d = errData(error)
        if (['conflict', 'forbidden', 'not_found'].includes(d.code ?? ''))
          clearRoadmapHistory(visit)
        if (refusedAsPaused(error)) toastPaused(refusalPauseText(error))
        else
          toast(
            d.message
              ? // a refusal that is whole sentences, such as an occupied
                // milestone week, ends with its own period
                `Couldn't undo: ${String(d.message).replace(/\.$/, '')}. No changes reverted.`
              : "Couldn't undo. Try again.",
          )
      },
      onSettled: () => {
        visit.pending--
        emit()
      },
    })
    emit()
  },
  /* timeline + formatting (same names as the prototype) */
  TIMELINE_START,
  TODAY_WEEK,
  TODAY_POS,
  TODAY_ISO,
  MONTHS,
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
     every read and every callback over them infers). Each list, and each
     item in it, keeps its identity while its data stays the same
     (stable.ts); a task also takes a new object when its delay or a task
     above or below it changed (store/taskIndex.ts). */
  gridEpoch: 0, // bumped whenever TIMELINE_START re-anchors (see rebuild)
  users: [] as UserVM[],
  CURRENT_USER: '',
  org: {} as OrgVM, // populated by the first rebuild, before `loaded` flips
  homeOrg: '',
  /* whether the login may create an organization now, as the server's
     createOrganization decides (convex/lib/billingAccess.ts OrgCreate): the
     sidebar and the phone list offer it only for 'now' */
  orgCreate: 'now' as OrgCreate,
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
  // the watched task's history, oldest first, while a window shows All
  // (showHistory); empty until it is delivered
  threadEvents: [] as ActivityVM[],
  labels: [] as LabelVM[],
  labelById: {} as Record<string, LabelVM>,
  comments: [] as CommentVM[],
  commentsLoaded: false, // the watched issue's comments (watchComments)
  // whether the watched thread holds comments before the oldest loaded one.
  // 'none' once its first comment is loaded (or before anything is), else
  // 'more', or 'loading' while P.loadEarlierComments runs and 'failed' after
  // it failed
  commentsEarlier: 'none' as CommentsEarlier,
  // whether the watched task's history holds rows before the oldest loaded
  // one, as commentsEarlier says for its comments (P.loadEarlierHistory);
  // 'none' until the history is delivered
  historyEarlier: 'none' as CommentsEarlier,
  // whether the watched task's history arrived, which only a window that
  // shows All asks for (showHistory); false again once none does
  historyLoaded: false,
  // whether the store let go of comments between the two runs it keeps of
  // the watched thread past its budget (lib/threadBudget.ts), which Show
  // newer comments reads back: 'none' with no gap, else 'more', 'loading'
  // while P.loadNewerComments runs and 'failed' after it failed
  commentsNewer: 'none' as CommentsEarlier,
  // the same for the history's changes (P.loadNewerHistory)
  historyNewer: 'none' as CommentsEarlier,
  // each kind's gap as the window places it (spineGap), or null with none
  threadGap: null as ThreadGap | null,
  // the comments held apart for an editor after a release passed over
  // them (P.holdComment), which only that editor's window shows
  pinnedComments: [] as string[],
  // the comments and changes a release held apart at an instant only the
  // other kind's live rows hold, which sit among the rows it let go, so no
  // window shows them
  threadApart: [] as string[],
  /* Changes whenever a rebuild changes anything a task's view reads besides
     the task's own view model and delay (store/taskIndex.ts): people (but not their
     Team sync stamps), organizations and their settings, projects and
     access, teams, labels, milestones, the week grid and today. A view that
     skips unchanged tasks by identity compares this as well. The
     organization-wide load reaches a task's view through its delay only. */
  contextVersion: Object.freeze({ revision: 0 }) as StoreVersion,
  // whether the watched thread stopped loading; the comments delivered
  // before the failure stay (P.retryComments)
  commentsFailure: 'none' as CommentsFailure,
  // whether the watched task's history stopped loading, as commentsFailure
  // says for its comments (P.retryHistory)
  historyFailure: 'none' as CommentsFailure,
  // the watched task's Subtasks, Linked tasks and Attachments while a window
  // shows them (showSections), else null; a window shows only those of its
  // own task (TaskSectionsVM.task)
  sections: null as TaskSectionsVM | null,
  // the watched task as a window shows it from its own read while the
  // workspace does not hold it, else null (P.taskDetail)
  detail: null as TaskDetailVM | null,
  // the reference a window registered for a task the workspace does not
  // hold, and where its read stands (P.watchTaskRef), else null
  reference: null as TaskRefVM | null,
  // Team sync (watchTeamSync): issue UUID → ms of its latest comment, or
  // null when it has none, for the open, visible tasks the last answer
  // covered; a task with no entry is not known yet
  lastComments: new Map<string, number | null>(),
  // the watched people whose latest-comment answer stayed cut short by the
  // server's budgets even when asked alone, so some of their cards lack marks
  lastCommentsCut: [] as string[],
  /* The workspace inbox part's messages, and their groups one per task.
     No view reads them since the Inbox lists inbox.page. The desktop
     alerts read the part (announceNewMessages), the store's tests read
     these, and scripts/smoke.mjs reads P.messages to pick tasks it can
     open without marking unread messages read. They go with the part
     (t3/limits-inbox-feed). */
  messages: [] as MessageVM[],
  messageGroups: [] as MessageGroupVM[],
  /** The loaded message groups (P.messageGroups) that are unread and not
      snoozed. No view reads it, as the Inbox badge counts every unread
      task from the unread summary (P.inboxSummary). The store's tests read it to
      check the paint of loaded messages, and the browser benchmark's checks
      read it on builds before and after that move
      (scripts/benchmark-browser.mjs). It goes with the workspace inbox
      part. */
  unreadMessages: 0,
  // the read messages the part counts, beyond those it sent too; no view
  // reads it, the store's tests do, and it goes with the part
  readMessageCount: 0,
  // whether the Inbox's Mark all as read and Remove all read may change
  // anything, from the unread summary's seat flags, and true while it has
  // no answer (deriveInboxFlags)
  canMarkAllRead: true,
  canRemoveRead: true,
  // the unread summary across the login's seats, which the Inbox badge
  // counts from and the bulk actions take their availability from
  inboxSummary: { state: 'loading', answer: null, current: false } as InboxSummaryVM,
  // the open task's inbox item, which its window takes the New divider and
  // the read on open from, else null (subscribeItem)
  inboxItem: null as InboxItemVM | null,
  // the bulk action running or last run, with its progress (store/inboxBulk.ts)
  inboxBulk: null as InboxBulk | null,
  // the marks of the person's own Inbox writes by inboxMarkKey, which the
  // Inbox shows its rows by until its page answers them (inboxMarks)
  inboxMarks: new Map() as ReadonlyMap<string, InboxMark>,
  // the Deleted items restore or Delete now running or last run, with its
  // progress (runDeletedItems), and the deferred items it watches
  deletedAction: null as DeletedAction | null,
  deletedWaiting: new Set<string>() as ReadonlySet<string>,
  // whether the inbox part left out older messages than it sent (its 500),
  // and which of Mark all as read and Remove all read reach some of them;
  // no view reads them since the Inbox lists inbox.page, the store's tests
  // do, and they go with the part
  inboxCut: false,
  inboxCutReach: { markAllRead: false, removeRead: false },
  loaded: false,

  /** Whether the newest workspace delivery brought the projects, a
      complete one or a partial one while every task loads, and no paint
      of the workspace is owed, so what the workspace holds is what the
      server held then. For a reader that waits for the workspace to hold
      a project a server read named, such as the open rule after
      projectNav.resolve (components/projectNavRows.tsx), which stops
      waiting when this holds and the project is still missing. */
  workspaceCurrent: (): boolean => inboxCurrent && !owed.workspace,

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
  /** Person `id` as every place that shows another person names and paints
      them (store/viewModels.ts PersonView): from the workspace's people part,
      else from the profile cache (store/profileCache.ts) as `ok` with their
      face or a picker's name, `loading` until a view's read answers,
      `failed` after a failed read, or `gone` only when the server's current
      answer leaves them out of organization `org`. Null for no id. A person
      no open view names stays `loading`, so each host names the people it
      shows (components/usePeople.ts). It marks nothing and decides no
      right; the rights helpers read P.user. */
  person: (id: string | null | undefined, org?: string): PersonView | null => {
    if (!id) return null
    const view = personViews.get(id)
    if (view && (org === undefined || view.org === org)) return view
    const known = profileCache.look(id, org)
    const state = known.state === 'face' || known.state === 'name' ? 'loading' : known.state
    const key = `${state}\n${id}`
    let shown = personStates.get(key)
    if (!shown) {
      shown = { state, id }
      personStates.set(key, shown)
      if (personStates.size > 2_000) personStates.delete(personStates.keys().next().value ?? '')
    }
    return shown
  },
  /** Names `people` under view `owner`, in its rows' order, replacing what
      it named before; an empty list releases them. The profile cache reads
      the ones the workspace does not hold, and the store asks for the
      pictures of the named people only (components/usePeople.ts). */
  namePeople: (owner: string, people: readonly NamedPerson[]) => profileCache.name(owner, people),
  /** Keeps a picker's person rows of organization `org`, its answers and
      picks, as names the views show at once until a face arrives. */
  takePeople: (org: string, people: readonly PersonRow[]) => profileCache.take(org, people),
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
  /** My seat in organization `orgId`, its profile id, or '' when I hold
      none there, as the New sub-project dialog names its creator. */
  seatIn: (orgId: string): string => profileIn(orgId),
  /* org admins lead every team — of THEIR OWN organization (0081). Being an
     admin at home says nothing about a team that shared a project with me,
     so the caller is resolved to the profile they hold in the team's org
     (actorIn); with an explicit uid, that person must live there too. It
     reads the store's own memberships, which the Settings navigation's
     Teams item, its org-teams check and Settings › Teams' check whether a
     seat leads any team (panels/settings/TeamSettings.tsx OrgTeamsPage)
     use until the roster stages give them a server answer; a team's page
     decides from teams.get's can_manage instead (panels/Settings.tsx). */
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
     and the outcome agree: the lead, an individual grant at any level or a
     share with one of the user's teams can see it, for an org admin as for
     anyone. */
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
  /** Whether `uid` (me by default) manages project `pid`, the server's
      management rule (convex/lib/access.ts managesIn): an active seat of
      the project's organization, the project a top-level meta or a
      sub-project of one, and an organization admin or the project's
      effective lead. Settings, the access editors and every New
      sub-project opener ask it; it gives no level. */
  canManageOwnProjectAccess: (pid: string, uid?: string): boolean => {
    const p = PLANNER.project(pid)
    if (!p) return false
    const root = p.parent ? PLANNER.project(p.parent) : p
    if (!root || root.org !== p.org || root.parent || root.type !== 'meta') return false
    const u = actorIn(p.org, uid)
    if (!u?.active) return false
    return u.orgRole === 'admin' || levelOnProject(p, uid) === 'lead'
  },
  /* Every top-level project this user can see in the workspace, in one
     list (0078 retired the per-workspace silo and its switcher), blended
     across organizations since 0081: home-org projects first, then each
     foreign org's granted ones, each in sort order. The sidebar's tree no
     longer reads it, as it lists the server's navigation reads
     (components/SidebarProjects.tsx), nor does App, which opens a project
     only once the server checked it (App.tsx startup). Its readers are
     scopeInfo's wide scopes, Team sync's scope menu and notes, and the
     smoke drive's startup block and phone check (scripts/smoke.mjs). */
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

  MINE_SCOPE,
  isMineScope: (id: string | null | undefined) => id === MINE_SCOPE,
  /* The scope that names no projects row, which is My view (MINE_SCOPE):
     `P.project(id)` is undefined for it, so there is no lead, no settings
     page, no archive and nowhere to create. isMineScope asks the same now
     that My view is the only sentinel; the rules that mean "names no
     project" ask this one. */
  isWideScope: (id: string | null | undefined) => id === MINE_SCOPE,
  /* Shared scope for Overview, Board and Roadmap; null means it disappeared.
     subIds names task-holding sub-projects. Groups are sub-projects within a
     project, top-level projects in My view, or the single selected sub.
     Its milestones are the milestone reads' (P.watchMilestones), not here.
     wide is the scope that names no project row, My view, and mine narrows
     its tasks to me. Rollups use the only predicate but ignore transient
     toolbar filters. */
  scopeInfo: (scopeId: string) => {
    if (scopeId === MINE_SCOPE) {
      const mine = true
      const metas = PLANNER.visibleProjects()
      const groups = metas.map((m) => ({
        proj: m,
        subIds: (m.children || []).filter((id) => PLANNER.canSee(id)),
      }))
      const subIds = groups.flatMap((g) => g.subIds)
      return {
        wide: true,
        mine,
        only: PLANNER.isMine,
        id: scopeId,
        name: 'My view',
        proj: null as ProjectVM | null,
        isMeta: false,
        metas,
        groups,
        subIds,
        subIdSet: new Set(subIds),
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
    }
  },
  /** The tasks a scope holds, its sub-projects', narrowed by the scope's
      own `only` predicate, from the workspace's tasks. No app reader calls
      it: the Roadmap reads its tasks from the server (tasks.roadmap). Its
      callers are the parity oracles and tests of a store that holds every
      task (store/roadmapOracle.setup.ts, store/overviewOracle.setup.ts and
      the parity and spy tests), which t3/limits-retire-task-windows ends.
      The guard's scan keeps any app reader out
      (store/guard/layerGuard.test.ts). Typed on the two fields it reads,
      so any scopeInfo() result passes. */
  scopedIssues: (info: { subIdSet: Set<string>; only: ((it: IssueVM) => boolean) | null }) => {
    if (STRICT_LAYERS) wholeListRead('P.scopedIssues')
    return tasks
      .issues()
      .filter((i) => info.subIdSet.has(i.project) && (!info.only || info.only(i)))
  },
  /** The summed remaining hours of the not-done leaf tasks in each of
      `groups`, lists of sub-projects, in one pass, own hours only (0066),
      from the workspace's tasks. No app reader calls it: the Roadmap's
      headings read the answer's counts. The Roadmap's oracle
      (store/roadmapOracle.setup.ts) and the parity tests call it, and
      t3/limits-retire-task-windows ends it; the guard's scan keeps any app
      reader out. */
  remainingByGroups: (groups: string[][], only?: ((it: IssueVM) => boolean) | null) => {
    const sums = groups.map(() => 0)
    for (const it of PLANNER.issuesInGroups(groups, only))
      if (it.issue.status !== 'done') for (const i of it.groups) sums[i] += it.issue.remaining || 0
    return sums.map((sum) => Math.round(sum * 10) / 10)
  },
  /** The leaf tasks in any of `groups` that `only` keeps, in task order,
      each with the indexes of the groups whose sub-projects hold it, from
      the workspace's tasks, for P.remainingByGroups and the tests that
      call it, which t3/limits-retire-task-windows ends. */
  issuesInGroups: function* (groups: string[][], only?: ((it: IssueVM) => boolean) | null) {
    if (STRICT_LAYERS) wholeListRead('P.issuesInGroups')
    const groupsOf = new Map<string, number[]>()
    groups.forEach((subIds, i) => {
      for (const id of new Set(subIds)) groupsOf.set(id, [...(groupsOf.get(id) ?? []), i])
    })
    for (const issue of tasks.issues()) {
      const found = groupsOf.get(issue.project)
      if (found && !PLANNER.isGroup(issue) && (!only || only(issue))) yield { issue, groups: found }
    }
  },
  /* The organization a project (or sub-project) belongs to. */
  orgOf: (projectId: string) => {
    const p = PLANNER.project(projectId)
    return p ? p.org : ''
  },
  /* No roster here lists people for a picker. `users` is BLENDED, every
     profile the people part sends from every organization I hold a seat
     in, and t3/limits-roster-parts stops sending the whole roster, so a
     list read from it would come out short without saying so. The people
     pickers read the server's people of the task's or project's
     organization instead: a task's owner lists and Team sync's Mention
     window (P.ownerChoices, P.recipientChoices and P.ownerChecks), the
     editor's @ mention popup (P.mentionChoices), and Settings' and the
     dialogs' people pickers. `user` still names a person the workspace
     holds. */
  /* Whoever holds a subtask must also see every task above it: the parent
     carries its context. This checks the tasks above that this view holds;
     one outside it (a hidden parent) is left to the server, which refuses
     with the same rule. The writes use it before they paint a new holder.
     The first task above `it` (its parent, then up) in a project the person
     cannot see, or null. A task outside this view is left to the server.
     `sees` replaces the current grants, as tests of the view rows pass it. */
  unseenAbove: (
    x: IssueVM | string,
    uid: string,
    sees = (projectId: string) => PLANNER.canSee(projectId, uid),
  ): IssueVM | null => {
    // the parents an open view's answer brings count as the workspace's do,
    // and so does the parent the window's own answer names, whose own
    // parent that answer does not hold
    const it = typeof x === 'string' ? (PLANNER.anyTask(x) ?? PLANNER.taskShown(x)) : x
    const seen = new Set<string>()
    for (let up = it?.parent ? (PLANNER.anyTask(it.parent) ?? answerParent(it)) : null; up; ) {
      if (seen.has(up.id)) break
      seen.add(up.id)
      if (!sees(up.project)) return up
      up = up.parent ? PLANNER.anyTask(up.parent) : null
    }
    return null
  },
  /* Who works on `it` (when `self`) and on its visible subtasks at any depth:
     each assignee, and each reviewer of a task without subtasks (a group's
     reviewer is dormant). A switched-off person holds no new work, as on the
     server. */
  holdersOf: (it: IssueVM, self: boolean, family?: TaskFamily): Holder[] => {
    const out: Holder[] = []
    const add = (task: IssueVM) => {
      for (const role of ['assignee', 'reviewer'] as const) {
        const uid = task[role]
        if (!uid || (role === 'reviewer' && PLANNER.isGroup(task))) continue
        if (PLANNER.user(uid)?.active) out.push({ uid, task, role })
      }
    }
    const root = family?.root ?? it
    if (self) add(root)
    eachDescendant(root, add, family?.byId)
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
     (moveCarriesSubtasks). With `family` (P.familyOf) the task, its
     parent and its subtasks are the family's, as for a task the window
     shows from its own answer. */
  moveFamily: (
    it: IssueVM,
    projectId: string,
    family?: TaskFamily,
  ): { leavesParent: boolean; carriesSubtasks: boolean; carried: IssueVM[] } => {
    const root = family?.root ?? it
    const byId = family?.byId ?? PLANNER.issueById
    const dst = PLANNER.topLevelOf(projectId)
    const crosses = PLANNER.topLevelOf(root.project) !== dst
    const parent = root.parent ? byId[root.parent] : undefined
    const parentTop = PLANNER.topLevelOf(parent ? parent.project : root.project)
    const leavesParent = crosses && (!!root.parent || root.hasHiddenParent) && parentTop !== dst
    const carried: IssueVM[] = []
    if (crosses) {
      eachDescendant(
        root,
        (child) => {
          if (PLANNER.topLevelOf(child.project) !== dst) carried.push(child)
        },
        byId,
      )
    }
    return {
      leavesParent,
      carriesSubtasks: crosses && (carried.length > 0 || root.hasHiddenSubtasks),
      carried,
    }
  },
  /* Who would lose access if `it` moved to `projectId`. The assignee and
     leaf reviewer of the task and of each subtask it carries need edit
     access there, and the people on its other subtasks need sight of it, the
     same checks the server makes. */
  moveBlockers: (it: IssueVM, projectId: string, family?: TaskFamily): AccessBlocker[] => {
    const project = PLANNER.project(projectId)
    if (!project) return []
    // the tasks that move must be held there by their assignee and leaf
    // reviewer, switched off or not; people on the subtasks that stay only
    // need to see the task
    const root = family?.root ?? it
    const movers = [root, ...PLANNER.moveFamily(root, projectId, family).carried]
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
      ...PLANNER.holdersOf(root, false, family)
        .filter((h) => !moving.has(h.task.id))
        .map((h) => ({ ...h, project, edit: false }))
        .filter((b) => !PLANNER.canSee(projectId, b.uid)),
    ]
  },
  /** The server's preview of `change` for the removal window
      (accessRemovals.preview), read once and never subscribed to, because
      one call can read a few thousand rows. With `reassignTo` it also says
      whether that person can take the tasks (reassign.holder_eligible).
      Null when the read failed or no organization is known, and for an
      answer that lacks a field the window decides by, as one from an older
      backend does (readablePreview), so such an answer removes nothing. */
  previewRemoval: async (
    change: AccessRemoval,
    reassignTo?: string,
  ): Promise<RemovalPreview | null> => {
    const orgId = removalOrg(change)
    if (!orgId) return null
    try {
      const answer = await convex.query(api.accessRemovals.preview, {
        org_id: orgId,
        change: removalChange(change),
        ...(reassignTo === undefined ? {} : { reassign_to: reassignTo }),
      })
      return readablePreview(answer, reassignTo !== undefined)
    } catch (e) {
      console.error('[qivo] removal preview failed:', e)
      return null
    }
  },

  /** One batch of the removal window's Reassign picker
      (accessRemovals.reassignChoices): the people who could take every task
      `change` takes out of sight once the access is gone, whose names match
      `search`, after `after`, an earlier batch's `next`, or from the start.
      The server works the removal out again for each batch. Read once a
      batch, never subscribed to; null when the read failed. */
  reassignChoices: async (
    change: AccessRemoval,
    search: string,
    after: string | null,
  ): Promise<ReassignChoices | null> => {
    const orgId = removalOrg(change)
    if (!orgId) return null
    try {
      return await convex.query(api.accessRemovals.reassignChoices, {
        org_id: orgId,
        change: removalChange(change),
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] reassign choices failed:', e)
      return null
    }
  },

  /** Whether the removal of `change` is on its way to the server, so a
      page that lists the access from the server's answer hides its row
      until the answer no longer holds it, and shows it again on a refusal
      (removeAtOnce). Its organization does not count. */
  removingAccess: (change: AccessRemoval): boolean => removing.has(removalKey(change)),

  /** One batch of a project's Add team or user picker, or of the New
      project dialog's Project access without `project_id`, where `lead_id`
      is the lead the dialog has chosen (projectSettings.candidates): teams
      and then people in name order, matching `search`, after `after`, an
      earlier batch's `next`, or from the start. Read once a batch, never
      subscribed to; null when the read failed. */
  accessChoices: async (
    on: { org_id: string; project_id?: string; lead_id?: string },
    search: string,
    after: string | null,
  ): Promise<AccessChoices | null> => {
    try {
      return await convex.query(api.projectSettings.candidates, {
        ...on,
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] access choices failed:', e)
      return null
    }
  },

  /** One batch of a lead picker (projectSettings.leadCandidates): the
      people a lead write accepts for project `project_id`'s Lead field, the
      New sub-project dialog's under `parent_id` or, with neither, the New
      project dialog's, matching `search`, after `after` or from the start.
      Read once a batch, never subscribed to; null when the read failed. */
  leadChoices: async (
    on: { org_id: string; project_id?: string; parent_id?: string },
    search: string,
    after: string | null,
  ): Promise<LeadChoices | null> => {
    try {
      return await convex.query(api.projectSettings.leadCandidates, {
        ...on,
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] lead choices failed:', e)
      return null
    }
  },

  /** One batch of a team's Add member picker (teams.addable): the people
      of team `team_id`'s organization `org_id` who may join it, matching
      `search`, after `after`, an earlier batch's `next`, or from the
      start. Read once a batch while the picker is open, never subscribed
      to; null when the read failed. */
  teamMemberChoices: async (
    on: { org_id: string; team_id: string },
    search: string,
    after: string | null,
  ): Promise<TeamChoices | null> => {
    try {
      return await convex.query(api.teams.addable, {
        ...on,
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] team member choices failed:', e)
      return null
    }
  },

  /** One batch of the New sub-project dialog's Project list
      (projectSettings.projects with sub_project_parents): the live
      top-level projects of organization `orgId` under which I may create a
      sub-project, every one for an organization admin and the ones I lead
      for anyone else, in name order, matching `search`, after `after` or
      from the start. Read once a batch, never subscribed to; null when the
      read failed. */
  subProjectParents: async (
    orgId: string,
    search: string,
    after: string | null,
  ): Promise<SubProjectParents | null> => {
    try {
      return await convex.query(api.projectSettings.projects, {
        org_id: orgId,
        sub_project_parents: true,
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] sub-project parents failed:', e)
      return null
    }
  },

  /** One batch of Settings › Archived projects (projectSettings.archived)
      in organization `orgId`, its archived projects for an organization
      admin and else the ones I see, newest archived first, matching
      `search`, after `after` or from the start. The page reads its own live
      batches; this one-shot read is the staging check's, whose sweep finds
      there an archived project its signed-in admin only manages, which no
      REST list and no store list holds. Never subscribed to; null when the
      read failed. */
  settingsArchivedProjects: async (
    orgId: string,
    search: string,
    after: string | null,
  ): Promise<ArchivedProjectEntries | null> => {
    try {
      return await convex.query(api.projectSettings.archived, {
        org_id: orgId,
        ...(search === '' ? {} : { search }),
        ...(after === null ? {} : { after }),
      })
    } catch (e) {
      console.error('[qivo] archived projects failed:', e)
      return null
    }
  },

  /** The seat `email` names in organization `orgId` and its grant on
      project `projectId` (projectSettings.inviteTarget), which the invite
      form sends as its `expected`. Read once, at the press. A rule the
      read refuses with, such as an address past LIMITS.email, answers as
      `refused` with the server's sentence; null when the read failed. */
  projectInviteTarget: async (
    orgId: string,
    projectId: string,
    email: string,
  ): Promise<InviteLookup | null> => {
    try {
      return await convex.query(api.projectSettings.inviteTarget, {
        org_id: orgId,
        project_id: projectId,
        email: email.trim(),
      })
    } catch (e) {
      const d = errData(e)
      if (d.code === 'rule' && d.message) return { state: 'refused', message: d.message }
      console.error('[qivo] invite lookup failed:', e)
      return null
    }
  },

  /** What a press or the removal window says when the access `change`
      takes away is already gone, as when someone else removed it first. */
  removalGoneText: (change: AccessRemoval): string => {
    const team = removalTeamName(change)
    const person = removalPersonName(change, 'Someone')
    switch (change.kind) {
      case 'userGrant':
        return `${person} no longer has this access.`
      case 'teamGrant':
        return `The ${teamNoun(team)} no longer has this access.`
      case 'teamMember':
        return `${person} has already left the ${teamNoun(team)}.`
      case 'deleteTeam':
        return `The ${teamNoun(team)} was already deleted.`
    }
  },

  /* What Keep as Viewer leaves the people of `shown`, the server's preview,
     able to do, for the removal window: they keep their tasks and see the
     listed projects, and can't change those tasks. Someone who can still
     change a listed project or one of its sub-projects once the access is
     gone is named with those projects, a few of them and a count of the
     rest (keep.changers), so the window never says they can't change
     anything there. Names, places and counts come from the answer, never
     from the workspace's tasks. */
  keepText: (change: AccessRemoval, shown: RemovalAnswer): string => {
    const refs = new Map(shown.projects.map((p) => [p.id, p]))
    const label = (id: string) => {
      const ref = refs.get(id)
      return ref ? PLANNER.projectLabel(ref) : PLANNER.projectLabelOf(id) || 'a project'
    }
    const { people } = shown
    const first = (name: string) => (name || 'Someone').split(' ')[0]
    const count = shown.tasks
    // "the task" and "this task" read better than "the 1 task"
    const theTasks = count === 1 ? 'the task' : `the ${count} tasks`
    const these = count === 1 ? 'this task' : 'these tasks'
    const places = shown.keep.targets
    const others = (n: number) => `${n} other project${n === 1 ? '' : 's'}`
    // a project removal names its own project; a team change names where it reached
    const granted = 'projectId' in change ? change.projectId : null
    // the preview names the granted project as its Keep target; else what
    // the page showed, else the workspace's project
    const topLevel = (id: string) => {
      const ref = refs.get(id)
      if (ref) return ref.parent_id === null
      if ('topLevel' in change && change.topLevel !== undefined) return change.topLevel
      return PLANNER.project(id)?.type === 'meta'
    }
    const seen = granted
      ? topLevel(granted)
        ? 'the whole project'
        : 'the whole sub-project'
      : andList(places.map(label), others)
    const inIt = places.length > 1 ? 'them' : 'it'
    // a deleted team's people each keep sight of the projects of their own tasks
    const canSee =
      change.kind === 'deleteTeam' && places.length > 1 && people.length > 1
        ? 'can each see the projects that hold them'
        : `can see ${seen}`
    // what each person can still change, as the server names it: the first
    // few projects and how many more
    const changers = shown.keep.changers.map((c) => ({
      id: c.id,
      name: people.find((p) => p.id === c.id)?.name ?? '',
      list: andMore(c.projects.map(label), c.more, others),
    }))
    if (people.length === 1) {
      const who = first(people[0].name)
      return changers.length
        ? `${who} keeps ${theTasks} and ${canSee}, but can change only ${changers[0].list} in ${inIt}, not ${these}.`
        : `${who} keeps ${theTasks} and ${canSee}, but can't change anything in ${inIt}, including ${these}.`
    }
    if (!changers.length)
      return `They keep their tasks and ${canSee}, but can't change anything in ${inIt}, including ${these}.`
    const still = andList(
      changers.map((c) => `${first(c.name)} can still change ${c.list}`),
      (n) => `${n} others can still change parts of ${inIt}`,
    )
    const rest = people.filter((p) => !changers.some((c) => c.id === p.id))
    // "the others" would be ambiguous after "2 others can still change"
    const tail = !rest.length
      ? ''
      : `, and ${rest.length === 1 ? first(rest[0].name) : changers.length > 3 ? `${rest.length} more` : 'the others'} can't change anything in ${inIt}`
    // one of them may change another's task, never their own
    return `They keep their tasks and ${canSee}, but can't change the tasks they keep. ${still}${tail}.`
  },

  /** Removes `change` at once and leaves the tasks it takes out of sight
      with their holders, then, once the server accepts it, says who can no
      longer see how many tasks. `answer`, the server's preview, names the
      people and counts every such task, also those in projects the caller
      cannot see. For a caller who cannot carry out both choices of the
      removal window (design-spec row 330), and for an organization admin
      while the organization is read-only (`leave_only`). Resolves whether
      the server accepted it. */
  removeLeavingTasks: async (change: AccessRemoval, answer: RemovalAnswer): Promise<boolean> => {
    const removed = await PLANNER.removeAccess(change, { to: null })
    if (removed && answer.tasks > 0) {
      const who = andList(answer.people.map((p) => p.name || 'Someone'))
      toast(
        answer.tasks === 1
          ? `${who} can no longer see a task they are assigned to or reviewing. A project lead can reassign it.`
          : `${who} can no longer see ${answer.tasks} tasks they are assigned to or reviewing. A project lead can reassign them.`,
        'info',
      )
    }
    return removed
  },

  /** Starts removing `change` from a Settings page. It asks the server's
      preview (P.previewRemoval) and answers it when the removal window
      should ask: someone loses sight of open tasks and the caller may keep
      them as Viewers where that is offered, or may reassign the tasks where
      it is not (settlesRemoval). Otherwise it answers null, having done
      what the preview calls for:
      - a failed or unreadable preview, or one from an older backend: says
        so (REMOVAL_UNCHECKED) and removes nothing;
      - nothing left to remove (`unavailable`, or `pending` false): says the
        access is already gone and changes nothing;
      - `refused` or `too_large`: the server's sentence, and removes nothing;
      - no task taken out of sight: the plain removal;
      - a caller the window cannot offer a choice, or an organization admin
        while the organization is read-only (`leave_only`): the removal at
        once, leaving the tasks, with a notice once the server accepts it
        (P.removeLeavingTasks).
      `still` says whether the page that pressed is still shown; when it
      answers false once the preview arrives, nothing happens at all. A
      paused save refuses before anything is read, since the read would
      wait for the connection. `removed` runs once the access is gone: the
      server accepted the removal this press made, or the preview says it
      was gone already. */
  startRemoval: async (
    change: AccessRemoval,
    still: () => boolean,
    removed: () => void = () => {},
  ): Promise<RemovalAnswer | null> => {
    if (refusePausedEdit()) return null
    const answer = await PLANNER.previewRemoval(change)
    if (!still()) return null
    if (answer === null) {
      toast(REMOVAL_UNCHECKED)
      return null
    }
    if (answer.state === 'unavailable' || (answer.state === 'ok' && !answer.pending)) {
      toast(`${PLANNER.removalGoneText(change)} Nothing was changed.`, 'info')
      removed()
      return null
    }
    if (answer.state !== 'ok') {
      toast(asSentence(answer.message))
      return null
    }
    if (answer.tasks === 0) {
      void PLANNER.removeAccess(change, { to: null }).then((ok) => {
        if (ok) removed()
      })
      return null
    }
    if (answer.leave_only || !settlesRemoval(answer)) {
      void PLANNER.removeLeavingTasks(change, answer).then((ok) => {
        if (ok) removed()
      })
      return null
    }
    return answer
  },

  /** Applies a removal with the choice made in the removal window, for
      `shown`, the preview the person read there: keep its people as Viewers
      ('keep_as_viewer', when it names anyone), or hand every lost task to
      `to` (null clears them) when it counts any task, else leave them.
      Without `shown` it sends 'leave' and paints the removal alone, as the
      staging check's cleanup and the write recipes call it. A person's or a
      team's grant, a member leaving a team, or a deleted team goes in one
      server write that works out at commit which tasks leave sight and
      settles them (projects.removeAccess, teams.removeMember,
      teams.deleteDeep), so a refusal changes nothing. Resolves whether the
      server accepted the removal. */
  removeAccess: async (
    change: AccessRemoval,
    choice: { keep: true } | { to: string | null },
    shown?: RemovalAnswer,
  ): Promise<boolean> => {
    if (refusePausedEdit()) return false
    const teamName = removalTeamName(change)
    const named = teamNoun(teamName)
    const person = removalPersonName(change, 'This person')
    // who keeps their access when a write is refused
    const stays =
      change.kind === 'userGrant'
        ? `${person} keeps access`
        : change.kind === 'teamGrant'
          ? `The ${named} keeps access`
          : change.kind === 'teamMember'
            ? `${person} stays in the ${named}`
            : `The ${named} stays`
    // the server refuses to delete the last team: say so before anything is
    // sent, for a change from the store's team; a page that showed its
    // organization turns Delete off from the server's count, and the
    // preview refuses the last team over the whole organization
    if (
      change.kind === 'deleteTeam' &&
      change.orgId === undefined &&
      rows.teams.has(change.teamId) &&
      !PLANNER.canDeleteTeam(change.teamId)
    ) {
      toast(
        `The ${named} can't be deleted, because an organization needs at least one team. Create another team first.`,
        'error',
      )
      return false
    }
    const held =
      shown === undefined
        ? ('leave' as const)
        : 'keep' in choice
          ? shown.people.length > 0
            ? ('keep_as_viewer' as const)
            : ('leave' as const)
          : shown.tasks > 0
            ? { reassign_to: choice.to }
            : ('leave' as const)
    const removed = await removeAtOnce(change, held, shown, stays)
    if (removed && change.kind === 'deleteTeam' && teamName)
      toast(`Team “${teamName}” deleted`, 'success')
    return removed
  },
  /* One sentence naming who blocks a change and how to clear it. */
  blockerText: (b: AccessBlocker): string => {
    const known = PLANNER.person(b.uid)
    const person = known?.state === 'ok' ? known : null
    const who = person?.name || 'Someone'
    const holds = b.role === 'reviewer' ? 'is reviewing' : 'is assigned to'
    const lacks = b.edit ? "can't edit" : 'has no access to'
    const fix = b.role === 'reviewer' ? 'choose another reviewer for' : 'reassign'
    // giving access back does not help a switched-off person
    if (person && !person.active)
      return `${who} is switched off and ${holds} ${b.task.key}. ${fix.charAt(0).toUpperCase()}${fix.slice(1)} ${b.task.key} first.`
    return `${who} ${holds} ${b.task.key} but ${lacks} ${PLANNER.projectLabel(b.project)}. Give them ${b.edit ? 'edit ' : ''}access or ${fix} ${b.task.key} first.`
  },
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
  /* Claim a home organization (0081) — the one-time door for a login with no
     home seat, active or not, which the app offers while P.orgCreate is
     'now'. The mutation creates the org, its first team, an admin profile
     for the caller and its billing, and refuses while the login holds a
     home seat; a full re-init then swaps the blend over to it (HOME_ORG, the
     roster, the handle scheme). Resolves false on refusal. */
  createOrg: async (name: string): Promise<boolean> => {
    try {
      await sendAwaited(api.identity.createOrganization, { name: name.trim() }, 'none')
    } catch (e) {
      const msg = errData(e).message || "couldn't create the organization"
      toast(msg.charAt(0).toUpperCase() + msg.slice(1))
      return false
    }
    // the workspace on screen never shrinks to a partial one
    try {
      await initStore(undefined, undefined, { whole: true })
    } catch (e) {
      // The organization exists, so a second create would be refused. The
      // workspace on screen shows as out of date with edits paused, and a
      // read that stopped its subscriptions starts them again, as Try
      // again does, so its first delivery ends the trouble.
      console.error('[qivo] workspace load failed:', e)
      snapshotFailed(e)
      if (!parts) {
        const epoch = storeEpoch
        parts = startParts(() => epoch === storeEpoch && !demoDisposed)
      }
      toast('The organization was created, but Qivo could not load it. Reload the page to open it.')
    }
    emit()
    return true
  },
  /* Invite someone to ONE project by email (0082). Awaited: the server
     decides known-vs-new guest, and a refusal is toasted with its own
     sentence (capitalized, like createOrg's). The new grant/seat arrives
     with the snapshot delivery — no refetch. Null on a refusal; otherwise
     `emailed` is the new seat that an invitation email goes to, or null when
     the server found a seat for the address and mailed nothing. `shown`
     is a page's lookup of the address on the server
     (P.projectInviteTarget): the project's organization and the level the
     address's seat holds there, null for none or no seat, which always goes
     out as `expected`, so a seat or grant made since refuses. */
  inviteToProject: async (
    metaId: string,
    email: string,
    level = 'user',
    shown?: Omit<GrantShown, 'leadId'>,
  ): Promise<{ emailed: string | null } | null> => {
    const org = shown?.orgId ?? orgOfProject(metaId)
    if (!org) return null
    // a seat the address already names: the level it holds on screen, so a
    // change made meanwhile is not overwritten unseen. Found by the stored
    // form, as the server finds it, so a seat whose address predates the
    // address rule is found too.
    const address = asciiEmail(email)
    const seat =
      address && !shown
        ? [...rows.profiles.values()].find((p) => p.org_id === org && p.email === address)
        : undefined
    const held =
      seat && rows.access.find((a) => a.project_id === metaId && a.profile_id === seat.id)
    const expected = shown
      ? { expected: { level: shown.level } }
      : seat
        ? { expected: { level: held?.level ?? null } }
        : {}
    let invited: { id: string; emailed: boolean }
    try {
      invited = await sendAwaited(
        api.projects.inviteGuest,
        {
          org_id: org,
          project_id: metaId,
          email: email.trim(),
          level,
          ...expected,
        },
        'none',
      )
    } catch (e) {
      if (errData(e).reason === FIELD_CHANGED) {
        noticeFieldChanged(e)
        return null
      }
      const msg = errData(e).message || "couldn't send the invitation"
      toast(msg.charAt(0).toUpperCase() + msg.slice(1))
      return null
    }
    return { emailed: invited.emailed ? invited.id : null }
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
     from taskSearchText, which REST and MCP task search build too, and the
     Archived tasks page searches the archive on the server by it. A task
     whose assignee's name has not loaded (P.person) may match by that name,
     so the filter keeps it: it never drops what it cannot tell. */
  matchesSearch: (x: IssueVM | string, query: string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it) return false
    const assignee = PLANNER.person(it.assignee, it.org)
    const hay = taskSearchText({
      key: it.key,
      title: it.title,
      description: it.description,
      status: it.status,
      group: PLANNER.isGroup(it),
      priority: it.priority,
      assigneeName: assignee?.state === 'ok' ? assignee.name : undefined,
      labelNames: it.labels.map((lid) => PLANNER.labelById[lid]?.name),
    })
    return matchesAllWords(hay, query) || nameUnknown(assignee)
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
     two states that carry pressure: yellow behind, red late. Neither judges
     a task the workspace holds until it holds every task, since the load of
     the owners' tasks still to come is missing: before an ask it holds
     none, and during the load only the person's new tasks. The person's
     new task in a store that never asked is a view's row, judged from the
     owner-load cache like any. */
  delayOf: (x: IssueVM | string): DelayInfo | null => {
    const it = typeof x === 'string' ? PLANNER.anyTask(x) : x
    // a task only a view holds is judged from the owner-load cache, which
    // does not wait for the workspace (store/viewDelay.ts)
    if (it && viewRows.factsOf(it)) {
      const verdict = viewDelays.get(it.uuid)
      return verdict && verdict !== DELAY_UNKNOWN ? verdict : null
    }
    return (tasksAll && it && delayMap.get(it.uuid)) || null
  },
  /** The task window's delay verdict for `it` where the workspace cannot
      judge it: for a task the window shows from its own read, the
      person's new task from its creating answer among them, and for a held
      one, such as the person's new task in a store that asked, until the
      workspace holds every task. It reads the owner's load from the owner-load cache
      (store/ownerLoadCache.ts), which the store asks for while a window
      shows the task's details (syncWindowLoad), by the Board's rules
      (store/viewDelay.ts judgeDelay), so a window over a Board card shows
      the card's verdict. Null while that load's first answer is on its
      way, DELAY_UNKNOWN where it came back unavailable or failed, or where
      a group's subtasks are not all there. The window's own registration
      is never capped, since a guest's cap counts the calls of one view. A
      task shown from its answer takes its group facts from P.taskDetail,
      or a group's Done and span from the row of a view that still reads
      it where the answer cannot give its dates (windowSpanRow), a held
      one from the workspace's tasks. Only a held group can have subtasks
      still to load. Those an answer leaves out are hidden from the
      person, which no load changes. */
  windowDelay: (it: IssueVM): DelayInfo | typeof DELAY_UNKNOWN | null => {
    const { issue, facts } = windowDelayIssue(it)
    return judgeDelay(issue, it.org, viewDelayCtx, facts)
  },
  tracksDelay: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.anyTask(x) : x
    const p = it && PLANNER.project(it.project)
    return !!p && p.trackDelay !== false
  },
  /* The remaining time a task in this project gets on entering Review: the
     project's own value, else its parent's, else DEFAULT_REVIEW_HOURS. */
  reviewHoursFor: (projectId: string) => reviewHoursForProject(projectId),
  /* Hours a person is committed to in `week` ORG-WIDE, spread the way the
     delay projection spreads it: the rows of the tasks on screen through
     the server's fence (convex/lib/loadRows.ts, paused, Done, unscheduled
     work and groups left out), and the snapshot's anonymous rows of
     projects this viewer cannot see. A pending hours or owner edit moves
     it at once (store/taskIndex.ts). Team sync read it until it took each
     person's week from its agenda (convex/teamSync.ts agenda); its readers
     now are Team sync's parity oracle (store/teamSyncOracle.setup.ts) and
     the tests of the workspace's load rows (store/derivedLoad.test.ts,
     store/teamSync.test.ts), until the stage that removes those rows. */
  weekLoadOf: (profileId: string, week: number): number => {
    let byWeek = committedByOwner.get(profileId)
    if (!byWeek) {
      byWeek = new Map()
      committedByOwner.set(profileId, byWeek)
    }
    let hours = byWeek.get(week)
    if (hours === undefined) {
      // only the asked week, however far the owner's plans run
      const load = tasks.loads().get(profileId) || []
      hours = committedByWeek(load, null, { from: week, to: week }).get(week) || 0
      byWeek.set(week, hours)
    }
    return hours
  },
  delayColor: (x: IssueVM | string): string | null => {
    const it = typeof x === 'string' ? PLANNER.anyTask(x) : x
    if (!it || !PLANNER.tracksDelay(it)) return null
    if (viewRows.factsOf(it)) {
      const d = PLANNER.delayOf(it)
      return d ? DELAY_COLORS[d.status] : DELAY_NEUTRAL
    }
    // a held task waits for every task, as delayOf does
    if (!tasksAll) return null
    const d = delayMap.get(it.uuid)
    return d ? DELAY_COLORS[d.status] : DELAY_NEUTRAL
  },
  /* one curated list for the whole organization (0078). `orgId` picks which:
     the blend (0081) also carries a host org's vocabulary, and a label only
     attaches to tasks of its OWN org (the 0028 trigger). Defaults to home.
     Settings › Labels lists its rows from the server (labels.settingsPage)
     and reads this catalogue for its duplicate-name check and to paint its
     rows' names and colors. The task label picker and the window's Labels
     section never list from it (panels/LabelPicker.tsx). */
  orgLabels: (orgId?: string) => {
    const org = orgId || PLANNER.homeOrg
    return PLANNER.labels.filter((l) => l.org === org)
  },
  subscribe: updates.subscribe,
  updates: updates.channels,
  emit,

  /** Calls `listener` with every task handle that moved, as a map from the
      old handle to the new, once per repaint (moveHandles). A caller that
      keeps a handle, such as the open task window, applies the whole map
      at once. Answers a function that stops it. */
  watchHandles: (listener: (moved: ReadonlyMap<string, string>) => void) => {
    handleWatchers.add(listener)
    return () => {
      handleWatchers.delete(listener)
    }
  },
  /** The handle task `uuid` shows now, or null when it is gone. Work that
      outlasts a moment, such as an image upload, follows a task by uuid,
      because a new task's handle can move to another task meanwhile. */
  handleOf: (uuid: string): string | null => uuidToKey.get(uuid) ?? null,
  /** The handle task `uuid` shows by now: the workspace's, else the
      window's while it shows the task from its own answer, or null. With
      `org`, of that organization's task only, as two organizations can
      hold one task id (heldHandle). The description editor follows its
      uploads by it (P.handleOf answers only the workspace's, which the
      views read as whether it holds the task). */
  shownHandleOf: (uuid: string, org?: string): string | null => {
    const held = heldHandle(uuid, org)
    if (held !== undefined) return held
    const detail = PLANNER.detail
    const ours = detail?.task === uuid && (!org || detail.org === org)
    return ours && detail.answered === 'ok' ? (detail.view?.id ?? null) : null
  },
  /** The task handle or uuid `id` names as the window shows it: the
      workspace's view, else the window's view from its own answer while
      the workspace does not hold the task in its organization
      (P.taskDetail), the person's own new task on its way among them
      before a window watches it, or undefined. While the workspace holds
      another organization's task of the same id, the window's handle names
      the window's task and the uuid alone names neither (answerTaskOf). A
      window's editors are built for the task this names
      (components/descEditor.tsx), so naming the new task from the window's
      first render builds them once. */
  taskShown: (id: string): IssueVM | undefined => {
    const held = PLANNER.issueById[id]
    if (held) return held
    const detail = PLANNER.detail
    const view = detail?.answered === 'ok' ? detail.view : null
    const names = (it: IssueVM) => it.id === id || (it.uuid === id && !rows.issues.has(id))
    if (view && !holdsIn(view.uuid, view.org) && names(view)) return view
    for (const uuid of pendingCreates.keys()) {
      const creating = PLANNER.taskDetail(uuid)?.view
      if (creating && detail?.task !== uuid && names(creating)) return creating
    }
    return undefined
  },
  /** The watched task the workspace does not hold, as a window names it,
      when handle `id` is the one it opens by now (P.handleNow): its uuid,
      organization, key, title and project, from the window's own read,
      else as the workspace last held it, as for a task that left before
      its read answered. Null for any other handle. A second window on the
      same task, as the Inbox pane's pop-out, names it so. */
  unheldTask: (
    id: string,
  ): { uuid: string; org: string; key: string; title: string; project: string } | null => {
    const shown = unheldWatched()
    if (!shown || PLANNER.handleNow(shown.uuid, shown.org, shown.num) !== id) return null
    const view = PLANNER.detail?.task === shown.uuid ? PLANNER.detail.view : null
    const was = watchedHeld?.uuid === shown.uuid ? watchedHeld : null
    return {
      uuid: shown.uuid,
      org: shown.org,
      key: `${ISSUE_PREFIX}-${shown.num}`,
      title: view?.title ?? was?.title ?? '',
      project: view?.project ?? was?.project ?? '',
    }
  },
  /** Whether the window can save a change to task `id` from its own answer
      now (answerTaskOf): the workspace does not hold it, and the window
      shows it from a current answer of its own read. */
  editsFromAnswer: (id: string): boolean => answerTaskOf(id) !== null,
  /** Whether a save to task `id` waits because the window shows the task
      from its own answer, which is not current now: its read failed or
      runs again (P.editsFromAnswer is false), so Qivo cannot tell whether
      someone changed the task meanwhile. Only the watched task waits so.
      P.taskShown also names the person's new task while no window
      watches it, as before its window watches it or once that window
      closed, and a save then is one whose window is gone (refuseUpload). */
  answerSaveWaits: (id: string): boolean => {
    const shown = PLANNER.taskShown(id)
    return (
      !!shown &&
      !holdsIn(shown.uuid, shown.org) &&
      watchedComments === shown.uuid &&
      watchedOrgOf() === shown.org &&
      answerTaskOf(id) === null
    )
  },
  /** Refuses a save to task `id` while it waits (P.answerSaveWaits), with
      a toast that says why, so the editor keeps its draft, as
      refusePausedEdit does. Answers whether it refused. */
  refuseStaleEdit: (id: string): boolean => {
    if (!PLANNER.answerSaveWaits(id)) return false
    toast(STALE_SAVE_TEXT, 'error')
    return true
  },
  /** What Move and Archive or delete take along with task `it` (TaskFamily):
      the workspace's subtasks once every task has loaded, else the whole
      list of leaf subtasks the watched task's own answer holds, neither
      failed nor running again, for a task the window shows from it or one
      the workspace holds before it holds every task, such as the person's
      new task. Null while neither knows them, a list that is not whole or
      holds a subtask stored before the rule of one level, so both windows
      say they cannot read every subtask, or wait for every task. Null
      too while the window shows the person's new task from its creating
      answer (P.taskDetail saving), whose lists the server has not read. */
  familyOf: (it: IssueVM): TaskFamily | null => {
    const held = holdsIn(it.uuid, it.org)
    if (held && tasksAll) return { root: it, byId: PLANNER.issueById, done: PLANNER.isDone(it) }
    // the watched task's answer, of its own organization's task; a
    // creating answer's lists are a new task's, which the server has not
    // stored yet, so Move and Archive or delete wait for its own read
    const watched = watchedComments === it.uuid && watchedOrgOf() === it.org
    const answer =
      watched && sectionFailure.task === 'none' && !creatingShown() ? paintedAnswer() : null
    return answer ? answerFamilyOf(it, answer) : null
  },
  /** The tasks, by uuid, whose text a view's row does not send, their
      description or their labels, that a live write from the window's own
      answer changes, until the views' answers hold it (unsentText). The
      Board counts such a card unsure under a text filter. A label toggle
      leaves this list once the server accepts it, since no view's row
      changes with it. */
  ownUnsentEdits: (): ReadonlySet<string> => {
    const out = new Set<string>()
    for (const layer of layers.ordered()) {
      const uuid = layer.view.view && unsentText.get(layer.view.view)
      if (uuid) out.add(uuid)
    }
    return out
  },
  /** The tasks, by uuid, that a live layer of the person's own writes
      changed from the server's applied rows: created, removed, edited or
      given other labels, and the parents such a task left or joined.
      Where a view's own answer and the rows on screen disagree about such
      a task, the rows on screen decide, as the task window's sections do
      (lib/taskSections.ts shows). */
  ownPaintedTasks: (): ReadonlySet<string> => {
    const own = paintedTaskIds()
    for (const uuid of viewRows.paintedTasks()) own.add(uuid)
    return own
  },
  /** Registers view `slot`'s read of the Board's answer (tasks.board) for
      the arguments `key`, JSON in boardArgs.ts's fixed order, or none with
      null, as the view's effect runs. The view passes null while its page
      or the tab is hidden: the read stops and keeps its rows, which show
      again, as refreshing, when it asks for the same arguments. Other
      arguments, or a new `attempt` (Try again), drop what it held.
      Arguments that only narrow the held answer's text filter (`narrows`,
      views/board/useBoardView.ts narrowsText) keep that answer and its
      rows until the answer for `key` arrives, so the Board narrows its
      cards on screen meanwhile. `owner` names the mounted view: a leaving
      page stays mounted, hidden, until the next one painted
      (components/KeptView.tsx), so the one that asks last owns the read,
      and another's null asks nothing. `delays` says whether the view shows
      its cards' delays, which then read owners' loads
      (store/ownerLoadCache.ts). */
  watchBoard: (
    slot: ViewSlot,
    key: string | null,
    attempt = 0,
    owner = 0,
    delays = true,
    narrows = false,
  ) => watchView(slot, BOARD_QUERY, key, attempt, owner, delays, narrows),
  /** What view `slot`'s read of the Board's answer holds: the arguments'
      key its result answers (null for none), its value or error, whether
      it is the live subscription's on the current connection, and whether
      the read held a value before, so a wait is a refresh. */
  boardRead: (slot: ViewSlot) => {
    const { value, fitted: _fitted, ...read } = viewRead(slot)
    return { ...read, ...(value === undefined ? {} : { value: value as BoardAnswer }) }
  },
  /** Forgets view `slot`'s read and rows: its page left. */
  releaseView,
  /** Registers the Roadmap's read of tasks.roadmap for the arguments `key`,
      JSON in views/roadmap/roadmapArgs.ts's fixed order, or none with null
      while its page or the tab is hidden, by P.watchBoard's rules for
      `attempt` and `owner`. Arguments that `keep` the held answer
      (roadmapArgs.ts keepsRoadmap: the same scope with another window or
      planned task, or typing that only narrows the text filter) keep that
      answer and its rows, which the Roadmap shows as refreshing, until the
      answer for `key` replaces them; any other change drops them. Its
      rows' owners register with the owner-load cache for their bars'
      delays, with Team utilization's people (P.watchRoadmapTeam). */
  watchRoadmap: (key: string | null, attempt = 0, owner = 0, keep = false) =>
    watchView(ROADMAP_SLOT, ROADMAP_QUERY, key, attempt, owner, true, keep),
  /** What the Roadmap's read holds (P.boardRead's fields). */
  roadmapRead: () => {
    const { value, ...read } = viewRead(ROADMAP_SLOT)
    return { ...read, ...(value === undefined ? {} : { value: value as RoadmapAnswer }) }
  },
  /** Registers the Roadmap's read of tasks.roadmapDependencies for the
      arguments `key`, its scope alone, or none with null, by
      P.watchRoadmap's rules. A pan, a filter or a keystroke never changes
      it. */
  watchRoadmapDependencies: (key: string | null, attempt = 0, owner = 0) =>
    watchView(ROADMAP_DEPS_SLOT, DEPENDENCIES_QUERY, key, attempt, owner, false),
  /** What the Roadmap's dependency read holds (P.boardRead's fields). */
  roadmapDependenciesRead: () => {
    const { value, ...read } = viewRead(ROADMAP_DEPS_SLOT)
    return { ...read, ...(value === undefined ? {} : { value: value as DependencyAnswer }) }
  },
  /** Registers Team utilization's people, `owners`, each with how many of
      the Roadmap's shown rows they own, with the owner-load cache under the
      Roadmap's own slot, beside its bars' owners, so a guest's or Viewer's
      calls for both stay under one GUEST_CALLS cap, the owners with the
      most rows first. They read while the Roadmap's read asks, and keep
      their last answers while it is stopped. */
  watchRoadmapTeam: (owners: readonly OwnerNeed[]) => {
    const was = slotExtraOwners.get(ROADMAP_SLOT) ?? []
    if (
      was.length === owners.length &&
      was.every((need, i) => {
        const next = owners[i]
        return need.org === next?.org && need.owner === next.owner && need.cards === next.cards
      })
    )
      return
    if (owners.length) slotExtraOwners.set(ROADMAP_SLOT, [...owners])
    else slotExtraOwners.delete(ROADMAP_SLOT)
    registerViewOwners(ROADMAP_SLOT, (viewReads.get(ROADMAP_SLOT)?.want ?? null) !== null)
  },
  /** Registers the planning panel's owner, owner `owner` of organization
      `org`, with the owner-load cache under the panel's own view key, one
      owner a call that never meets a guest's cap, as the task window's, or
      releases it with null. It reads while `live`, which the Roadmap sets
      while its page shows. */
  watchPlanLoad: (need: { org: string; owner: string } | null, live = true) => {
    if (need) ownerLoads.register(PLAN_LOADS, [{ ...need, cards: 1 }], live)
    else ownerLoads.release(PLAN_LOADS)
  },
  /** Owner `owner` of organization `org`'s load as the owner-load cache
      knows it now (store/ownerLoadCache.ts OwnerLoad). */
  ownerLoad: (org: string, owner: string): OwnerLoad => ownerLoads.loadOf(org, owner),
  /** Owner `owner` of organization `org`'s work as Team utilization and the
      planning panel spread it (store/viewDelay.ts ownerItemsOf): the
      cache's spans and paused tasks reconciled by task with the rows this
      person holds, pending edits counted once. Null while the load is not
      `ok`, and where an older backend sent no project or paused list, so
      the caller shows it as unknown, never as free time. */
  ownerItems: (org: string, owner: string): OwnerItem[] | null => {
    const load = ownerLoads.loadOf(org, owner)
    return load.state === 'ok' && load.team ? ownerItemsOf(org, owner, load, ownerItemsCtx) : null
  },
  /** Forgets the Roadmap's reads, their rows, its milestone reads and the
      phone agenda's (AGENDA_MILESTONE_SLOTS) and their answers, and the
      owners Team utilization and the planning panel registered: its page
      left. A kept page's reads only stop while it hides, so their answers
      show again on its return; App calls this once the page is no longer
      kept. */
  releaseRoadmap: () => {
    slotExtraOwners.delete(ROADMAP_SLOT)
    releaseView(ROADMAP_SLOT)
    releaseView(ROADMAP_DEPS_SLOT)
    ownerLoads.release(PLAN_LOADS)
    for (const slot of [
      ...ROADMAP_MILESTONE_SLOTS,
      ...AGENDA_MILESTONE_SLOTS.upcoming,
      ...AGENDA_MILESTONE_SLOTS.past,
    ])
      PLANNER.releaseMilestones(slot)
  },
  /** Registers the Overview's reads for `key` (store/overviewLists.ts
      overviewKey: its scope and its clock), or none with null while its
      page or the tab is hidden, which stops them and keeps what they held:
      the summary, the delays and the batches each list holds, read again
      with the same arguments when the page asks for them again. `owner`
      names the mounted page, as P.watchBoard's does, and a new `attempt`
      (the page's Try again) asks the summary and the delays afresh. A key
      whose day is not the local day now asks for nothing: a kept page shown
      again after midnight renders once with the day it held, and where the
      store has not reached the new day yet, as before its day watch ran
      after sleep (lib/localDay.ts), it moves to it, so the page renders
      again on the new day. */
  watchOverview: (key: string | null, owner = 0, attempt = 0) => {
    const base = key === null ? null : baseOfKey(key)
    const now = new Date()
    const today = isoFromDate(now)
    const stale = base !== null && base.clock.day !== today
    overviewStep(() => overview.watch(stale ? null : base, owner, attempt))
    if (stale && PLANNER.loaded && PLANNER.TODAY_ISO !== today) {
      rebuild(now)
      emit()
    }
  },
  /** Registers the health table the Overview asks for, `table` (its column,
      direction and search), or none with null, for the page `owner` names,
      as P.watchOverview's: apart from the scope's reads, so a new sort,
      search or Load more asks the health read alone. It reads only while
      the Overview's reads ask (P.watchOverview). */
  watchOverviewTable: (table: HealthTable | null, owner = 0) =>
    overviewStep(() => overview.watchTable(table, owner)),
  /** What the Overview's reads hold (store/overviewLists.ts OverviewView):
      the summary's and the delays' answers for the Overview asked now and
      whether each is current, each list's batches and state, and the
      health table's answer. */
  overviewRead: (): OverviewView => overview.view(),
  /** Load more on Overview list `list`, or on the health table. */
  overviewMore: (list: ListKind | 'health') =>
    overviewStep(() => (list === 'health' ? overview.moreHealth() : overview.more(list))),
  /** Shows Overview list `list` from its first batch again. */
  overviewFromStart: (list: ListKind) => overviewStep(() => overview.fromStart(list)),
  /** Asks batch `batch` of Overview list `list` afresh (Try again, Retry),
      or the health table, with no batch (its Try again, or a failed Load
      more's Retry). */
  overviewRetry: (list: ListKind | 'health', batch = 0) =>
    overviewStep(() => (list === 'health' ? overview.retryHealth() : overview.retry(list, batch))),
  /** Forgets the Overview's reads and rows, its milestone reads
      (OVERVIEW_MILESTONE_SLOTS) among them: its page left. A kept page's
      reads only stop while it hides; App calls this once the page is no
      longer kept. */
  releaseOverview: () => {
    overviewStep(() => overview.release())
    for (const slot of [
      ...OVERVIEW_MILESTONE_SLOTS.upcoming,
      ...OVERVIEW_MILESTONE_SLOTS.past,
      OVERVIEW_MILESTONE_SLOTS.next,
    ])
      PLANNER.releaseMilestones(slot)
  },
  /** Registers milestone read `slot` (the milestone reads' header above):
      `ask`, one milestone by id, a section batch or a range of days of
      the milestones of top-level projects (convex/milestones.ts get,
      section and between), or none with null, as the view's effect runs.
      The view passes null while its page or the tab is hidden: the read
      stops and keeps its answer, which shows again, as refreshing, when it
      asks for the same arguments. Other arguments drop what it held, and a
      new `attempt` (Retry) asks afresh and keeps the answer it held until
      the new one arrives, so an editor over it keeps its draft. `owner`
      names the mounted view, as P.watchBoard's does. An ask of more
      top-level projects than MILESTONE_READS.projects reads nothing and
      answers `too_many` (LIMITS.milestoneProjects). */
  watchMilestones: (slot: ViewSlot, ask: MilestoneAsk | null, owner = 0, attempt = 0) => {
    together(() => {
      const read = viewReads.get(slot)
      if (ask === null) {
        if (!read) return
        const was = read.live !== null
        watchView(slot, read.query, null, attempt, owner)
        // the view shows its kept answer as refreshing from now on
        if (was && read.live === null) {
          viewReadsChanged = true
          owe('view')
        }
        return
      }
      if (milestoneAskTooMany(ask)) {
        if (read && read.owner !== owner && read.want !== null) return
        if (milestonesTooMany.has(slot)) return
        milestonesTooMany.add(slot)
        if (read) releaseView(slot)
        else if (milestoneRows.holds(slot)) releaseMilestoneRows(slot)
        viewReadsChanged = true
        owe('view')
        return
      }
      if (milestonesTooMany.delete(slot)) {
        viewReadsChanged = true
        owe('view')
      }
      const key = milestoneKey(ask)
      // an answer kept through a Retry is for the arguments it was asked with
      const kept = milestoneRows.keyOf(slot)
      if (kept !== null && kept !== key) {
        releaseMilestoneRows(slot)
        viewReadsChanged = true
        owe('view')
      }
      watchView(slot, MILESTONE_QUERIES[ask.kind], key, attempt, owner, false)
    })
  },
  /** What milestone read `slot` holds now (MilestoneRead), painted with the
      person's own milestone writes. A failure or refusal after an answer
      keeps that answer beside it. `ask` names the arguments the view shows
      now, which its effect registers after the render: an answer or a
      failure for other arguments says nothing of them, so the read is
      loading until theirs arrives, and an ask of more top-level projects
      than one read names is too_many at once. */
  milestoneRead: (slot: ViewSlot, ask?: MilestoneAsk): MilestoneRead => {
    if (ask ? milestoneAskTooMany(ask) : milestonesTooMany.has(slot)) return { state: 'too_many' }
    const want = ask ? milestoneKey(ask) : null
    const held = viewRead(slot)
    const kept = want === null || milestoneRows.keyOf(slot) === want ? milestoneAnswer(slot) : null
    if (held.error !== undefined && (want === null || held.key === want)) {
      const d = errData(held.error)
      if (d.reason === MILESTONE_TOO_MANY) return { state: 'too_many' }
      if (d.reason !== undefined && MILESTONE_REFUSALS.has(d.reason))
        return {
          state: 'refused',
          reason: d.reason,
          sentence: asSentence(d.message ?? ''),
          kept,
        }
      return { state: 'failed', kept }
    }
    if (!kept) return { state: 'loading' }
    return {
      state: 'ok',
      current: held.current && held.key === milestoneRows.keyOf(slot),
      answer: kept,
    }
  },
  /** Forgets milestone read `slot` and its answer: its view left. Another
      mounted view's read is left alone when `owner` names this one. */
  releaseMilestones: (slot: ViewSlot, owner?: number) => {
    const read = viewReads.get(slot)
    if (owner !== undefined && read && read.owner !== owner) return
    together(() => {
      if (milestonesTooMany.delete(slot)) viewReadsChanged = true
      if (read) releaseView(slot)
      else if (milestoneRows.holds(slot)) {
        releaseMilestoneRows(slot)
        viewReadsChanged = true
        owe('view')
      }
    })
  },
  /** Registers Team sync's read of its agenda (convex/teamSync.ts agenda)
      for the arguments `key` (lib/teamSync.ts syncAgendaKey), or none with
      null while its page or the tab is hidden, which stops it and keeps
      what it held, read again with the same arguments when the page asks
      for them again. `owner` names the mounted page and a new `attempt`
      (Try again) asks afresh, as P.watchBoard's, but keeps the meeting it
      last fitted, not current, until the attempt's answer arrives
      (watchView), so a stale meeting's cards keep their unsent text; with
      no meeting kept it drops what it held. The same meeting, its
      organization and scope, on another day or week grid keeps the meeting
      it held, never as current, until the new day's answer arrives
      (watchView `hold`), so a card's unsent text survives midnight. A key
      whose day is not the local day now asks for nothing and moves the
      store to the new day, as P.watchOverview's. The read registers no
      owner with the owner-load cache: the answer carries its verdicts and
      weeks. */
  watchSync: (key: string | null, owner = 0, attempt = 0) => {
    const now = new Date()
    const today = isoFromDate(now)
    const day = key === null ? null : JSON.parse(key).day
    const stale = day !== null && day !== today
    const held = viewReads.get(SYNC_SLOT)?.held?.key ?? null
    const meeting = key === null ? null : syncMeetingOf(key)
    const hold = meeting !== null && held !== null && syncMeetingOf(held) === meeting
    watchView(SYNC_SLOT, SYNC_QUERY, stale ? null : key, attempt, owner, false, hold)
    if (stale && PLANNER.loaded && PLANNER.TODAY_ISO !== today) {
      rebuild(now)
      emit()
    }
  },
  /** What Team sync's read holds: the arguments' key its result answers
      (null for none), its value or error, whether it is the live
      subscription's on the current connection, whether the read held a
      value before, and `fitted`, the last ok answer whose rows it holds,
      which the page shows under a refusal or a failure that kept them,
      with `until`, when it stopped being the current answer (ms), the
      earliest of the read stopping, as in a hidden tab or on a new day, a
      reconnect leaving it to arrive again and the refusal or failure
      arriving, null while it is current. */
  syncRead: () => {
    const { value, fitted, ...read } = viewRead(SYNC_SLOT)
    return {
      ...read,
      ...(value === undefined ? {} : { value: value as AgendaAnswer }),
      fitted: fitted as {
        key: string
        value: Extract<AgendaAnswer, { state: 'ok' }>
        until: number | null
      } | null,
    }
  },
  /** Forgets Team sync's read and rows, an organization Viewer's people's
      loads and the last comments' marks: its page left, or Done ended the
      sitting. */
  releaseSync: () => {
    releaseView(SYNC_SLOT)
    ownerLoads.release(SYNC_PEOPLE)
    PLANNER.watchTeamSync(null)
  },
  /** Task `uuid` of Team sync's answer as the page shows it: the
      workspace's model where it holds the task, none where the workspace
      held it and the person's own pending archive or delete took it away,
      else the model shaped from the answer's row (P.ownOnScreen). */
  syncTask: (uuid: string): IssueVM | undefined => PLANNER.ownOnScreen(SYNC_SLOT, uuid),
  /** Task `uuid`'s row as the page shows it, painted with the person's own
      pending writes: the workspace's where it holds the task, else Team
      sync's row of it. */
  syncRowOnScreen: (uuid: string) => rows.issues.get(uuid) ?? viewRows.rowsOf(SYNC_SLOT)?.get(uuid),
  /** How the person's own pending writes move each owner's hours in week
      `week` (the app's week index), over the tasks of the answer Team sync
      shows, `saved` by uuid as it sent them (its rows, asks and Done
      tasks): for each such task a live layer changed (P.ownPaintedTasks),
      the hours its row on screen adds for its owner less those its saved
      row adds (lib/teamSync.ts weekHoursOf), unrounded, by owner. So a
      pending Remaining, status, pause or owner edit moves the figure at
      once, an owner change moves the hours from one person to the other,
      and once the answer holds the write the two rows agree and add
      nothing, so nothing counts twice. */
  syncLoadChanges: (saved: ReadonlyMap<string, ViewRow>, week: number): Map<string, number> => {
    const out = new Map<string, number>()
    const add = (hit: { owner: string; hours: number } | null, sign: number) => {
      if (hit) out.set(hit.owner, (out.get(hit.owner) ?? 0) + sign * hit.hours)
    }
    for (const uuid of PLANNER.ownPaintedTasks()) {
      const before = saved.get(uuid)
      if (!before) continue
      const after = PLANNER.syncRowOnScreen(uuid)
      const factsOf = (row: { project_id: string; org_id: string }, group: boolean) => ({
        isGroup: group,
        projectLive: !!PLANNER.project(row.project_id),
        ownerInOrg: (id: string) => rows.profiles.get(id)?.org_id === row.org_id,
      })
      add(weekHoursOf(before, factsOf(before, before.has_subtasks), week), -1)
      if (after) {
        const handle = uuidToKey.get(uuid)
        const group =
          handle === undefined
            ? !!viewRows.rowsOf(SYNC_SLOT)?.get(uuid)?.has_subtasks
            : PLANNER.isGroup(handle)
        add(weekHoursOf(after, factsOf(after, group), week), 1)
      }
    }
    return out
  },
  /** Registers with the owner-load cache, under Team sync's own view key,
      the people an organization Viewer's page shows (the person of a person
      step and of the steps beside it, or the expanded agents), and whether
      it reads now (`live`, while the page and the tab show). A Viewer gets
      one owner a call (store/ownerLoadCache.ts). None releases them. */
  watchSyncPeople: (owners: readonly string[], live: boolean) => {
    const org = PLANNER.homeOrg
    if (!org || owners.length === 0) return ownerLoads.release(SYNC_PEOPLE)
    ownerLoads.register(
      SYNC_PEOPLE,
      owners.map((owner) => ({ org, owner, cards: 1 })),
      live,
    )
  },
  /** Person `owner`'s hours in this week as an organization Viewer's Team
      sync shows them, from the projects the Viewer can see: their load from
      the owner-load cache with the rows on screen, pending edits included,
      in place of the cache's spans of the same tasks (store/viewDelay.ts
      viewLoadOf), rounded to tenths; `waiting` while it is on its way and
      `unknown` where it is unavailable, failed or past the cap. */
  syncPersonLoad: (
    owner: string,
  ): { state: 'ok'; hours: number } | { state: 'waiting' | 'unknown' } => {
    const org = PLANNER.homeOrg
    const load = ownerLoads.loadOf(org, owner)
    if (load.state === 'waiting') return { state: 'waiting' }
    if (load.state !== 'ok') return { state: 'unknown' }
    const spans = viewLoadOf(org, owner, load, viewDelayCtx)
    const week = TODAY_WEEK
    const hours = committedByWeek(spans, null, { from: week, to: week }).get(week) ?? 0
    return { state: 'ok', hours: roundTenths(hours) }
  },
  /** The verdicts of Team sync's tasks `uuids` for an organization Viewer,
      judged by the Board's rule (store/viewDelay.ts judgeDelay) against
      their owners' loads from the owner-load cache (P.watchSyncPeople):
      null while a load is on its way, as a Board card shows no mark then,
      and `unknown` where it is unavailable, failed or past the cap. The
      page asks only for rows whose agenda verdict is unknown and whose
      owner it registered. */
  syncViewerVerdicts: (uuids: readonly string[]): Map<string, SyncVerdict> => {
    const out = new Map<string, SyncVerdict>()
    viewDelayCtx.memo = new Map()
    viewDelayCtx.filed = undefined
    try {
      for (const uuid of uuids) {
        const it = PLANNER.syncTask(uuid)
        if (!it) continue
        const issue = delayIssueOfTask(
          it,
          { isGroup: false, isDone: it.status === 'done', partial: false },
          viewDelayCtx.capacity,
        )
        const verdict = judgeDelay(issue, it.org, viewDelayCtx)
        out.set(
          uuid,
          verdict === DELAY_UNKNOWN
            ? 'unknown'
            : verdict === null || verdict.status === 'ok'
              ? null
              : verdict.status,
        )
      }
    } finally {
      viewDelayCtx.memo = undefined
      viewDelayCtx.filed = undefined
    }
    return out
  },
  /** Task `uuid` as the rows on screen show it to view `slot`, for a task
      the person's own pending writes changed (P.ownPaintedTasks): the
      workspace's where it holds the task, none where the workspace held it
      and a write took it away (an archive or a delete), else the model of
      the answer's row (store/viewRows.ts). */
  ownOnScreen: (slot: ViewSlot, uuid: string): IssueVM | undefined => {
    const handle = uuidToKey.get(uuid)
    if (handle !== undefined) return PLANNER.issueById[handle]
    if (base.map('issues').has(uuid)) return undefined
    return viewRows.model(slot, uuid)
  },
  /** The view model of task `uuid` that view `slot`'s answer brings, when
      the workspace does not hold the task (store/viewRows.ts). */
  viewTask: (slot: ViewSlot, uuid: string): IssueVM | undefined => viewRows.model(slot, uuid),
  /** The task handle `id` names: the workspace's, else one an open view's
      answer brings. */
  anyTask: (id: string): IssueVM | undefined => PLANNER.issueById[id] ?? viewRows.byHandle(id),
  /** The tasks a Board looks its cards' parents up in, by handle: the
      workspace's, with the tasks only the views hold. The same object
      while neither changes, so a Board's cell groups stay
      (lib/boardGroups.ts createCellGrouper). */
  boardTasksById: (): Record<string, IssueVM> => {
    const extra = viewRows.handles()
    if (extra.size === 0) return PLANNER.issueById
    if (boardLookup?.base !== PLANNER.issueById)
      boardLookup = {
        base: PLANNER.issueById,
        map: { ...Object.fromEntries(extra), ...PLANNER.issueById },
      }
    return boardLookup.map
  },
  /** Whether task `x`'s delay is unknown: a task only a view holds, in a
      project that shows delays, whose verdict needs its owner's load, which
      came back unavailable, failed or past the cap (ownerLoadCache.ts). */
  delayUnknown: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.anyTask(x) : x
    return (
      !!it &&
      !!viewRows.factsOf(it) &&
      PLANNER.tracksDelay(it) &&
      viewDelays.get(it.uuid) === DELAY_UNKNOWN
    )
  },
  /** Whether task `x`'s card shows a delay band: Slipping, Delayed or Delay
      unknown (views/kanbanCards.tsx DelayBanner), as the card's height and
      its hierarchy line read it. */
  delayBanner: (x: IssueVM | string): boolean => !!PLANNER.delayColor(x) || PLANNER.delayUnknown(x),
  /** What opening task handle `id` passes on (lib/taskReference.ts): the
      handle when the workspace holds the task, else a reference with the
      organization, number and uuid of the view row that brings it, as a
      Board card's, a phone row's or an Overview row's, the person's new
      task on its way where two rows share the handle
      (store/viewRows.ts byHandle), else `id`. */
  openTarget: (id: string): string => {
    if (PLANNER.issueById[id]) return id
    const it = viewRows.byHandle(id)
    const row = it && viewRows.peek(it.uuid)
    return it && row ? taskRef({ org: it.org, num: row.num, uuid: it.uuid }) : id
  },
  /** What opening task `uuid`, number `num` of organization `org` passes
      on: its handle when the workspace holds it in that organization,
      else a reference that names all three (lib/taskReference.ts), as
      Search, the related rows and an Inbox row open a task. Another
      organization's held task of the same id is another task
      (heldHandle). */
  openTask: (uuid: string, org: string, num: number | null): string =>
    heldHandle(uuid, org) ?? taskRef({ org, num, uuid }),
  /** The key a person reads for what `open` opens (QN-n): the workspace's
      key of a handle, or the number a reference names, else `open`, as App
      names the person's new task in its toasts. */
  keyOfOpen: (open: string): string => {
    const held = PLANNER.issueById[open]
    if (held) return held.key
    const named = refParts(open)
    return named?.num !== undefined ? `${ISSUE_PREFIX}-${named.num}` : open
  },
  /** Whether task `uuid` is a create of the person's own the server has not
      taken yet, shown from the views' rows since the workspace does not
      hold it: its card's owner list waits (WAITS_FOR_SAVE), as the server
      has no task to read for it yet. */
  createOnItsWay: (uuid: string): boolean => createOnItsWay(uuid),
  /** Whether the server refused the create of the person's own new task
      `uuid` (refusedCreates), so the writes sent behind it, a comment
      among them, say nothing more than the create's own refusal did. */
  refusedCreate: (uuid: string): boolean => refusedCreates.has(uuid),
  /** The search text of task `uuid` while it is a create of the person's
      own on its way that the workspace does not hold, as the screen shows
      it with the writes sent behind the create. The fields come from its
      row in the views, and its description and labels, which a view's row
      does not send, from the window's painted answer while a window shows
      it from its creating answer, else as the create sent them. Null for
      any other task, and where a change of its description or labels
      went out behind the create that no window shows, or a label or the
      assignee has no name the store knows, so the views count the card as
      unsure. The
      views check such a card against the whole text filter (views/board
      useBoardView.ts), as the server will once it holds the task, and a
      refused write's paint going takes its text back with it. */
  createText: (uuid: string): string | null => {
    const pending = pendingCreates.get(uuid)
    if (!pending || holdsIn(uuid, pending.org)) return null
    const shown =
      watchedComments === uuid && creatingShown() && drawnAnswer?.task.id === uuid
        ? drawnAnswer
        : null
    if (!shown && PLANNER.ownUnsentEdits().has(uuid)) return null
    const sent = pendingRow(pending)
    const row = viewRows.peek(uuid) ?? sent
    const labelNames: string[] = []
    for (const { label_id } of shown?.labels ?? []) {
      const name = rows.labels.get(label_id)?.name
      if (name === undefined) return null
      labelNames.push(name)
    }
    // an assignee whose name has not loaded leaves the card unsure too
    const assignee = PLANNER.person(row.assignee_id)
    if (nameUnknown(assignee)) return null
    return taskSearchText({
      key: `${ISSUE_PREFIX}-${row.num}`,
      title: row.title,
      description: shown ? shown.task.description : sent.description,
      status: row.status,
      group: pending.child !== null,
      priority: row.priority,
      assigneeName: assignee?.state === 'ok' ? assignee.name : undefined,
      labelNames,
    })
  },
  /** The handle task `uuid`, number `num` of organization `orgId` opens by
      now: the store's when it holds the task in that organization, else
      the home organization's key or another organization's uuid
      (handleFor). While the workspace holds another organization's task
      of the same id, whose handle that would be, it is a reference that
      names all three, which no lookup of a handle finds (heldHandle). Read
      when the task opens, as a role change since a search answered can
      change it. */
  handleNow: (uuid: string, orgId: string, num: number): string =>
    heldHandle(uuid, orgId) ??
    (uuidToKey.has(uuid)
      ? taskRef({ org: orgId, num, uuid })
      : handleFor(uuid, orgId, `${ISSUE_PREFIX}-${num}`)),
  /** The handle the views name the task that `open` opens by: a handle as
      it is, and a reference that names a task's organization, number and
      uuid (P.openTask) by the handle that task opens by now (P.handleNow),
      as the Board names a card only its answer brings, so App reveals
      that card. Any other reference as it is. */
  handleOfOpen: (open: string): string => {
    const named = refParts(open)
    return named?.org && named.uuid && named.num !== undefined
      ? PLANNER.handleNow(named.uuid, named.org, named.num)
      : open
  },
  /** Why the live snapshot is stale, or null while it is current. Observe
      it through the `health` channel. */
  snapshotTrouble: (): SnapshotTrouble | null => snapshotTrouble,
  /** The root part's answer when the last boot found no seat it can open,
      because the login's organization is being deleted or deactivated it,
      with when the login may create an organization, otherwise null. */
  seatless: (): Seatless | null => bootSeatless,
  /** Null once the workspace holds every task, else the share of task
      windows that answered since the ask, and 0 before one, so a wait that
      reads it keeps waiting until every task is held. Prefer P.tasksHeld
      for a reader that asks and P.tasksArriving for one that does not. */
  stillLoading: (): number | null => (tasksAll ? null : (stillLoading ?? 0)),
  /** Whether the workspace holds every task the person may see. The
      readers that ask for every task (P.askTasks) wait for it. */
  tasksHeld: (): boolean => tasksAll,
  /** Whether the task windows an ask subscribed are on their way: asked,
      not all held yet, and not stopped (P.taskLoad). A reader that does not
      ask waits on it, so its wait never starts in a session that never
      asks and never outlasts a load. */
  tasksArriving: (): boolean => stillLoading !== null && !tasksAll && taskTrouble === null,
  /** Where the load of every task stands, for the note at the bottom, the
      pages that wait for every task and their Try again. It shows no share:
      the windows' answers come as one or two large transitions after a
      small first one. */
  taskLoad: (): TaskLoad =>
    tasksAll
      ? { state: 'all' }
      : taskTrouble
        ? { state: 'failed', reason: taskTrouble.reason, retrying: taskTrouble.retrying }
        : stillLoading !== null
          ? { state: 'arriving' }
          : { state: 'not_asked' },
  /** Asks for every task for `reason`, once per store (askTasks). */
  askTasks: (reason: AskReason) => askTasks(reason),
  /** Try again for a stopped task load (retryTasks). */
  retryTasks: () => retryTasks(),
  /** Task `it`'s subtasks, links and attachment count as the cap checks
      before a write count them: the larger of the workspace's and its whole
      section lists' (capInputs). */
  capInputs,
  /** Task `uuid` as a row of Parent, Subtasks or Linked tasks
      (RelatedTaskVM), from the workspace's view of it, or null when the
      workspace does not hold it. */
  relatedTask: (uuid: string): RelatedTaskVM | null => relatedTask(uuid, undefined),
  /** The sections a window on task `uuid` shows: P.sections when they are
      that task's, else, in a workspace that holds every task, the
      workspace's own lists of it (workspaceSections), so a window that has
      just switched to a task, before the store follows it, lists that
      task's rows rather than another's or none. Null before the workspace
      holds every task, when the window says its lists load. */
  sectionsFor: (uuid: string): TaskSectionsVM | null => {
    if (PLANNER.sections?.task === uuid) return PLANNER.sections
    const handle = tasksAll ? uuidToKey.get(uuid) : undefined
    const it = handle === undefined ? undefined : PLANNER.issueById[handle]
    return it ? workspaceSections(it) : null
  },
  /** Whether the parent of held task `x` is a task still to arrive before
      the workspace holds every task (hiddenParentsNow). */
  parentLoading: (x: IssueVM | string): boolean => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    const parent = it && !tasksAll ? rows.issues.get(it.uuid)?.parent_id : undefined
    return !!parent && !rows.issues.has(parent)
  },
  /** Why Qivo cannot save now, or null (lib/syncStatus). Observe it through
      the `health` channel. */
  savePause,
  /** Whether edits pause: the snapshot is stale or Qivo cannot save. */
  editsPaused: () => snapshotTrouble !== null || savePause() !== null,
  /** The pause's sentence while Qivo cannot save, else null, for a panel that
      calls Convex directly and so does not pause during snapshot trouble. */
  cannotSaveText: (): string | null => {
    const pause = savePause()
    return pause ? (pause.kind === 'slow' ? SLOW_TEXT : OFFLINE_TEXT) : null
  },
  /** Whether a change waits for the server's answer. */
  hasUnconfirmed: () => syncStatus.unconfirmed() > 0,
  /** Whether closing the page now would lose work, for the close warning
      (lib/leaveGuard): a change waiting for the server's answer, an upload
      under way, or text an editor has not sent. */
  hasUnsavedWork: () => syncStatus.unconfirmed() > 0 || hasUnsaved(),
  /** What the crash note found at start: the changes a page that closed
      could not confirm, as one sentence, until dismissed. Observe it through
      the `health` channel. */
  unconfirmedReport: (): string | null => unconfirmedReport,
  dismissUnconfirmedReport: () => {
    unconfirmedReport = null
    emit('health')
  },
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
    const it = typeof x === 'string' ? PLANNER.anyTask(x) : x
    if (!it) return false
    // a task only a view holds: its group facts, as the answer judged them
    const facts = viewRows.factsOf(it)
    return facts ? facts.done : isIssueDone(it, PLANNER.issueById)
  },
  /* progress — computed from descendant leaves, never group statuses. A
     group's is unknown while tasks still load, since subtasks may be still
     to come (subtaskParentsNow). */
  progressOf: (x: IssueVM | string) => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    return it ? groupProgress(it, PLANNER.issueById) : { pct: 0, done: 0, total: 0, unknown: false }
  },

  /* remaining is own hours for a leaf. For a group it is the sum over the
     unfinished leaves of its visible subtree (a group has no hours of its
     own, 0066, and a Done task has no work left, as in every other remaining
     total). Cycle-safe like progressOf. undefined when no unfinished leaf has
     hours entered. Only the parent/sub-issue tree feeds this, and linked
     issues never count. A group has none before the workspace holds every
     task, since its subtasks may be still to come. */
  remainingOf: (x: IssueVM | string): number | undefined => {
    const it = typeof x === 'string' ? PLANNER.issueById[x] : x
    if (!it) return undefined
    if (!PLANNER.isGroup(it)) return it.remaining
    if (!tasksAll) return undefined
    let sum = 0
    let any = false
    eachDescendant(it, (child) => {
      if (PLANNER.isGroup(child) || child.status === 'done' || child.remaining == null) return
      sum += child.remaining
      any = true
    })
    return any ? Math.round(sum * 10) / 10 : undefined
  },

  loadUI: preferences.load,
  saveUI: preferences.save,
  saveUINow: preferences.saveNow,

  /* ------------------------------- mutations -------------------------------
     send(mutation, args, view): the view paints its own layer, with
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

  /** Creates a task from the New task dialog, a window's subtask create or
      a new sub-project's starter task, and answers what opening it passes
      on (P.openTask): its handle where the workspace holds it, which only
      a store that asked for every task does, else a reference that names
      its organization, preview number and uuid. Nothing asks for every
      task. The preview number is exact unless someone else creates first
      (0050's organization-wide counter). Once a view's answer brings
      another task with that number, the new task moves to the next free
      one (renumberPending), and the server's answer fixes it. A held
      handle moves with the rows, and the reference moves with the number
      (P.watchHandles), so a caller that keeps either follows it. The new
      task shows at once in the Board's
      and the Roadmap's rows (newTaskParts) and in a window opened on it,
      from its creating answer (creatingAnswerOf), until the server took
      the create and the views' and the window's own reads answer.
      `onRefused` hears the handle or reference shown just before the
      refusal takes the task away, so an open window can close first. A
      `parent` names a task the workspace holds, or the task the window
      shows from a current answer, whose Subtasks list shows the new task
      at once and whose write is marked as from the answer; any other
      parent is refused, never created as a top-level task. Returns null
      for an invalid target or a refused parent (callers take their
      no-create path). */
  addIssue: (it: NewIssueInput, onRefused?: (open: string) => void) => {
    const proj = rows.projects.get(it.project)
    // Numbering, org and reporter all follow the TARGET project's organization
    // (0081): creating in a foreign project is attributed to my guest profile
    const orgRow = proj ? rows.orgs.get(proj.org_id) : null
    if (proj?.type !== 'project' || !orgRow) return null
    if (refuseOver(LIMITS.title, cleanTitle(it.title)) || refusePausedEdit()) return null
    // a parent the workspace does not hold is the task the window shows
    // from a current answer; any other is refused rather than created as a
    // top-level task
    const parentId = it.parent ? parentUuidOf(it.parent) : undefined
    if (it.parent && !parentId) {
      if (!PLANNER.refuseStaleEdit(it.parent)) toast(PARENT_UNKNOWN, 'error')
      return null
    }
    const shownParent =
      it.parent && parentId && !holdsIn(parentId, orgRow.id) ? answerTaskOf(it.parent) : null
    const uuid = crypto.randomUUID()
    const now = new Date().toISOString()
    const previewNum = (orgRow.next_issue_num || 0) + 1
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
      title: cleanTitle(it.title),
      // trimmed as the server stores it (cleanDescription)
      description: trimMarkdown(it.description || ''),
      status: it.status || 'backlog',
      priority: it.priority || 'low',
      assignee_id: it.assignee || undefined,
      reviewer_id: it.reviewer || undefined,
      reporter_id: reporterId,
      created_by: profileIn(orgRow.id) || undefined,
      parent_id: parentId,
      start_week: it.start != null ? weekToISO(it.start) : undefined,
      end_week: it.end != null ? weekToISO(it.end) : undefined,
      due_date: it.due || undefined,
      // to the tenth, as the server stores it
      remaining_hours: hasRemaining
        ? roundTenths(Number(it.remaining))
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
      status_at: now, // mirror createIssueCore's status stamp
      created_at: now,
      updated_at: now,
    }
    const created: Created = { num: null, row: null }
    // the person's level on the new task's project: the window's answer's
    // for a subtask in the project of the task it shows, else the workspace's
    const level =
      (shownParent?.answer.task.project_id === it.project ? shownParent.answer.level : null) ??
      levelOf(PLANNER.levelOn(it.project)) ??
      'viewer'
    // the parent as the new task's window lists it: the window's answer of
    // it, else the workspace's row while it holds the parent in the new
    // task's organization
    const parentRow = parentId
      ? (shownParent?.answer.task ??
        (holdsIn(parentId, orgRow.id) ? rows.issues.get(parentId) : undefined))
      : undefined
    const parentLevel =
      shownParent?.answer.level ??
      (parentRow ? levelOf(PLANNER.levelOn(parentRow.project_id)) : null) ??
      'viewer'
    const pending = pendingCreate(row, created, level, {
      parent: parentRow ? newParentShort(parentRow, parentLevel, now) : null,
    })
    const parts = newTaskParts(row, created, asked, newTaskPaint(row, created))
    // the window's Subtasks list of the parent shows the new task at once
    const detail: View['detail'] = parentId
      ? {
          task: parentId,
          paint: () =>
            subtaskListPaint(
              parentId,
              newShortRow(row, created.num ?? row.num, false, level),
              uuid,
              now,
            ),
        }
      : undefined
    const withDetail = (view: View): View => (detail ? { ...view, detail } : view)
    void send(
      api.issues.create,
      {
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
      },
      withDetail(parts.sent),
      {
        // the server's number and stored row, painted while no delivery
        // holds the task yet
        keep: (result) => {
          if (result) pending.take({ num: result.num, row: result })
          return withDetail(parts.kept())
        },
        onOk: () => {
          // its window reads its thread and lists from now on, also before
          // a delivery holds it
          tookCreate(uuid, row.org_id)
          // the reference a caller keeps names the number shown while the
          // create waited (renumberPending), and moves to the server's
          const from = PLANNER.openTask(uuid, row.org_id, row.num)
          const next = PLANNER.openTask(uuid, row.org_id, created.num ?? row.num)
          if (isTaskRef(next) && isTaskRef(from)) movePendingRef(uuid, from, next)
          tellPendingMoves()
        },
        ...(shownParent ? { about: { task: uuid, answer: true as const } } : {}),
        onError: (error) => {
          pending.refused()
          toastWriteError(error)
          // the handle on screen, which a delivery may have moved, or the
          // reference to the number shown
          onRefused?.(PLANNER.openTask(uuid, row.org_id, row.num))
        },
      },
    )
    // the handle once the workspace holds the task, else the reference to
    // the number it shows, the preview unless another task holds that
    return PLANNER.openTask(uuid, row.org_id, row.num)
  },

  /* Paints the change at once and sends it. Resolves true when the server
     accepts it or nothing needed sending, false when it is refused here or
     by the server (both toast the reason). Callers that only paint can
     ignore it; removeAccess waits on it before taking a grant away. Only
     the fields that differ from what the person saw go out, each with that
     value as its `expected`. `opts.seen` gives what an editor showed when
     the person began, by wire field, in place of the row on screen, and
     `opts.keepDraft` runs when the server refuses because someone changed
     the field first and the editor keeps the draft, and `opts.keepUnsaved`
     when the save fails for any other reason (SendOptions.keepUnsaved). A
     `parent` names a task by its handle or its uuid; one the workspace does
     not hold needs the Parent picker's row of it in `opts.parentRow`, and
     any other is refused (PARENT_UNKNOWN) rather than sent as a detach. A
     new parent also paints the window's own answer of the task, so its
     Parent row shows it where the workspace does not hold the parent. A
     task the workspace does not hold saves from the window's own answer
     while the window shows it from a current one (updateAnswerTask), else
     from a view's row (updateViewTask). */
  updateIssue: (id: string, patch: IssuePatch, opts: UpdateOptions = {}): Promise<boolean> => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!patch || !Object.keys(patch).length) return Promise.resolve(false)
    if (!row || !uuid) {
      // the task the window shows from its own current answer, else one
      // only an open view's answer brings (store/viewRows.ts)
      const shown = answerTaskOf(id)
      return shown ? updateAnswerTask(shown, patch, opts) : updateViewTask(id, patch)
    }
    if (refusePausedEdit()) return Promise.resolve(false)
    // text the server would refuse is refused before the paint, so a draft
    // is never lost to a refusal
    if ('title' in patch && refuseOver(LIMITS.title, cleanTitle(patch.title)))
      return Promise.resolve(false)
    if ('description' in patch && refuseText(LIMITS.description, patch.description ?? ''))
      return Promise.resolve(false)
    // a parent the workspace does not hold comes from the Parent picker's
    // row; any other is refused rather than sent as a detach
    const parentUuid = patch.parent ? parentUuidOf(patch.parent, opts.parentRow) : null
    if (parentUuid === undefined) {
      toast(PARENT_UNKNOWN, 'error')
      return Promise.resolve(false)
    }
    // whoever holds a subtask must see every task above it: refuse here, with
    // the server's reason, before anything is painted (a hidden parent, or
    // one the workspace does not hold, is left to the server)
    const it = PLANNER.issueById[id]
    const parentHandle = parentUuid ? uuidToKey.get(parentUuid) : undefined
    const stranded = it && parentHandle ? PLANNER.parentBlockers(it, parentHandle) : []
    if (stranded.length) {
      toast(PLANNER.blockerText(stranded[0]), 'error')
      return Promise.resolve(false)
    }
    for (const holder of [patch.assignee, patch.reviewer]) {
      const unseen = it && holder ? PLANNER.unseenAbove(it, holder) : null
      const project = unseen && PLANNER.project(unseen.project)
      if (it && holder && project) {
        const who = knownName(holder) || 'This person'
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
    const at = new Date().toISOString()
    // attaching a sub-issue clears the new parent's own hours (0066 mirror)
    const newParent = parentUuid ?? undefined
    const prevDesc = String(row.description || '') // pre-patch, for the image paint below
    const seenRow: Record<string, unknown> = { ...row, ...opts.seen }
    const hiddenSeen = opts.hiddenParent ?? rows.hiddenParentTasks.has(uuid)
    const wire = mapIssuePatch(patch, opts.parentRow)
    if (!wire) {
      toast(PARENT_UNKNOWN, 'error')
      return Promise.resolve(false)
    }
    // A field sent with the value the person saw changes nothing they
    // chose, such as the start date setEnd sends along, so it stays unsent
    // and cannot undo a change someone made to it meanwhile. Dates compare
    // as sent, so an off-grid stored start still goes with a new end.
    for (const key of Object.keys(wire) as (keyof typeof wire)[]) {
      const value = wire[key]
      const shown = seenRow[key]
      const same =
        key === 'title'
          ? String(value ?? '').trim() === String(shown ?? '').trim()
          : key === 'description'
            ? (value || null) === (shown || null)
            : // a detach from a parent the person cannot see is a change
              (key !== 'parent_id' || !hiddenSeen) && (value ?? null) === (shown ?? null)
      if (same) delete wire[key]
    }
    if (!Object.keys(wire).length) return Promise.resolve(true)
    const paintDb = { ...wire }
    if (PLANNER.isGroup(id)) delete paintDb.status
    // the window's Parent row of a parent the workspace does not hold reads
    // the window's own answer (P.shownParent), which a picked one paints
    const parentShort =
      parentUuid && opts.parentRow?.id === parentUuid ? parentShortOf(opts.parentRow, at) : null
    const view: View = {
      ...('parent_id' in paintDb
        ? {
            detail: {
              task: uuid,
              paint: () => {
                const shown = detailRows.task
                if (!shown || shown.task.id !== uuid) return
                shown.task.parent_id = paintDb.parent_id ?? undefined
                shown.task.has_hidden_parent = false
                shown.parent = parentShort ? { ...parentShort } : null
              },
            },
          }
        : {}),
      workspace: () => {
        clearParentHours(newParent, at, row.org_id)
        patchIssueRow(uuid, paintDb, at)
        // a new visible parent or a detach replaces a hidden one
        if ('parent_id' in paintDb && rows.issues.has(uuid)) rows.hiddenParentTasks.delete(uuid)
        if ('description' in paintDb) {
          paintDescriptionImages(uuid, prevDesc, String(paintDb.description || ''), at)
        }
      },
    }
    // Only a write of dates alone joins the Roadmap's history. Remaining
    // takes the ordinary write like any other field, so a saved one ends
    // the history (isTaskContentWrite).
    const planningOnly = Object.keys(wire).every((key) => ['start_week', 'end_week'].includes(key))
    const over: Over = {
      ...overOf('issues', row, Object.keys(wire), opts.seen),
      ...(opts.hiddenParent === undefined ? {} : { hiddenParent: opts.hiddenParent }),
    }
    const saved =
      (planningOnly && recordRoadmapChange({ kind: 'task', id: uuid, patch: wire }, view, over)) ||
      send(api.issues.update, { org_id: row.org_id, id: uuid, patch: wire }, view, {
        over,
        keepDraft: opts.keepDraft,
        keepUnsaved: opts.keepUnsaved,
        // a parent the workspace does not hold came from a server answer
        ...(parentUuid && !rows.issues.has(parentUuid)
          ? { about: { task: uuid, answer: true as const } }
          : {}),
      })
    return saved
  },

  setStatus: (id: string, status: Row<'issues'>['status']) => {
    PLANNER.updateIssue(id, { status })
  },

  /** Whether the server would carry subtasks along if the task `id` moved
      to `projectId` (api.issues.moveCarriesSubtasks), archived ones
      included. The snapshot holds no archived tasks, so moveFamily cannot
      tell. It takes the task's organization and uuid from its model, the
      workspace's or the window's from its own answer; a handle names a
      task the workspace holds. Null on transport error or for a task
      outside this view. */
  moveCarriesSubtasks: async (id: IssueVM | string, projectId: string): Promise<boolean | null> => {
    const it = typeof id === 'string' ? PLANNER.issueById[id] : id
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

  /** Creates a top-level task titled `title` in task `id`'s sub-project and
      makes it that task's parent, for the Parent picker, in one server
      transaction (api.issues.createParent). The view holds no archived
      subtasks, which also keep a task from getting a parent
      (convex/lib/limits.ts), so a refusal shows its sentence and takes
      the new task away again. Nothing asks for every task. The new task
      paints at once, with createIssueCore's defaults, in the Board's and
      the Roadmap's rows with the task under it (newTaskParts), the
      window's Parent row shows it, and a window opened on it shows it from
      its creating answer until the server took it. A task the workspace
      does not hold creates from the window's current answer of it
      (answerTaskOf), with that answer's parent pair as the expected
      values, marked as from the answer. In a store that asked for every
      task the workspace's rows take the new parent and the held task's
      new parent too. Resolves whether the server accepted it, false when
      refused here or there. */
  createParent: (id: string, title: string): Promise<boolean> => {
    if (refuseOver(LIMITS.title, title) || refusePausedEdit()) return Promise.resolve(false)
    const held = PLANNER.issueById[id]
    const shown = held ? null : answerTaskOf(id)
    const it = held ?? shown?.model
    const orgRow = it ? rows.orgs.get(it.org) : undefined
    if (!it || !orgRow) {
      PLANNER.refuseStaleEdit(id)
      return Promise.resolve(false)
    }
    const level = shown?.answer.level ?? levelOf(PLANNER.levelOn(it.project)) ?? 'viewer'
    const parentId = crypto.randomUUID()
    const at = new Date().toISOString()
    const me = profileIn(it.org) || undefined
    const parent: Row<'issues'> = {
      id: parentId,
      project_id: it.project,
      num: (orgRow.next_issue_num || 0) + 1,
      org_id: it.org,
      title: cleanTitle(title),
      description: '',
      status: 'backlog',
      priority: 'low',
      reporter_id: me,
      created_by: me,
      paused: false,
      status_at: at,
      created_at: at,
      updated_at: at,
    }
    const created: Created = { num: null, row: null }
    const paintParent = newTaskPaint(parent, created)
    const child: IssueWirePatch = { parent_id: parentId }
    // the held path: the new parent and the held task's new parent, in a
    // store that asked for every task
    const heldPaint: Paint = () => {
      // a task the window shows from its answer gets its new parent at
      // once, and its own row once the workspace holds it in its
      // organization
      if (!shown && !holdsIn(it.uuid, it.org)) return
      paintParent()
      if (!holdsIn(it.uuid, it.org)) return
      if (rows.issues.get(it.uuid)?.parent_id === parentId) return
      patchIssueRow(it.uuid, child, at)
      rows.hiddenParentTasks.delete(it.uuid)
    }
    const pending = pendingCreate(parent, created, level, {
      child: shown ? newChildShort(shown.answer.task, shown.answer.level, at) : null,
    })
    const parts = newTaskParts(parent, created, asked, heldPaint, { group: true, child: it.uuid })
    // the window's Parent row
    const detail: View['detail'] = {
      task: it.uuid,
      paint: () => {
        const answer = detailRows.task
        if (!answer || answer.task.id !== it.uuid) return
        answer.task.parent_id = parentId
        answer.task.has_hidden_parent = false
        answer.task.updated_at = at
        answer.parent = newShortRow(parent, created.num ?? parent.num, true, level)
      },
    }
    const row = holdsIn(it.uuid, it.org) ? rows.issues.get(it.uuid) : undefined
    const over: Over | undefined = row
      ? overOf('issues', row, ['parent_id'])
      : shown
        ? {
            ...overOf('issues', shown.answer.task, ['parent_id']),
            hiddenParent: shown.answer.task.has_hidden_parent,
          }
        : undefined
    return send(
      api.issues.createParent,
      { org_id: it.org, id: it.uuid, parent_id: parentId, title: title.trim() },
      { ...parts.sent, detail },
      {
        // the server's number for the parent, painted while no delivery holds it
        keep: (answer) => {
          if (answer) pending.take({ num: answer.parent_num })
          return { ...parts.kept(), detail }
        },
        // the new parent's window reads its thread and lists from now on,
        // also before a delivery holds it (addIssue)
        onOk: () => tookCreate(parentId, it.org),
        onError: (error) => {
          pending.refused()
          toastWriteError(error)
        },
        ...(over ? { over } : {}),
        ...(shown ? { about: { task: it.uuid, answer: true as const } } : {}),
      },
    )
  },

  /** The Link picker's Create new linked task: a new task titled `title` in
      task `id`'s sub-project, linked to it with `type` as seen from task
      `id`, in one server write (api.issues.createLinked), so a refused link
      leaves no new task behind. The view's own link cap check toasts first;
      the server also counts links to tasks this view does not hold.
      Nothing asks for every task. The new task paints at once in the
      Board's and the Roadmap's rows (newTaskParts) and in a window opened
      on it, from its creating answer, until the server took it. A task the
      workspace does not hold creates from the window's current answer of
      it (answerTaskOf), marked as from the answer, and the window's Linked
      tasks show the new task with the links answer's next delivery. In a
      store that asked for every task the workspace's rows take the new
      task, and the link where they hold both tasks. Resolves whether the
      server accepted it. */
  createLinked: (id: string, type: string, title: string): Promise<boolean> => {
    if (refuseOver(LIMITS.title, title) || refusePausedEdit()) return Promise.resolve(false)
    const held = PLANNER.issueById[id]
    const shown = held ? null : answerTaskOf(id)
    const it = held ?? shown?.model
    const orgRow = it ? rows.orgs.get(it.org) : undefined
    if (!it || !orgRow) {
      PLANNER.refuseStaleEdit(id)
      return Promise.resolve(false)
    }
    const full = linkBlock(capInputs(it).links)
    if (full) {
      toast(full)
      return Promise.resolve(false)
    }
    const kind = type === 'blocks' || type === 'blocked_by' ? type : 'relates'
    const level = shown?.answer.level ?? levelOf(PLANNER.levelOn(it.project)) ?? 'viewer'
    const taskId = crypto.randomUUID()
    const at = new Date().toISOString()
    const me = profileIn(it.org) || undefined
    const task: Row<'issues'> = {
      id: taskId,
      project_id: it.project,
      num: (orgRow.next_issue_num || 0) + 1,
      org_id: it.org,
      title: cleanTitle(title),
      description: '',
      status: 'backlog',
      priority: 'low',
      reporter_id: me,
      created_by: me,
      paused: false,
      status_at: at,
      created_at: at,
      updated_at: at,
    }
    const created: Created = { num: null, row: null }
    const paintTask = newTaskPaint(task, created)
    // the stored form, as addLink and the server's storedLink canonicalize it
    const [source, target] =
      kind === 'blocked_by' || (kind === 'relates' && taskId < it.uuid)
        ? [taskId, it.uuid]
        : [it.uuid, taskId]
    const link: Row<'issue_links'> = {
      id: crypto.randomUUID(),
      source_id: source,
      target_id: target,
      type: kind === 'relates' ? 'relates' : 'blocks',
      pair_key: source < target ? `${source}:${target}` : `${target}:${source}`,
      created_at: at,
    }
    // the held path, in a store that asked for every task
    const heldPaint: Paint = () => {
      if (!shown && !holdsIn(it.uuid, it.org)) return
      paintTask()
      if (!holdsIn(it.uuid, it.org) || !holdsIn(taskId, it.org) || rows.links.has(link.id)) return
      rows.links.set(link.id, { ...link })
    }
    const pending = pendingCreate(task, created, level)
    const parts = newTaskParts(task, created, asked, heldPaint)
    return send(
      api.issues.createLinked,
      { org_id: it.org, id: it.uuid, new_id: taskId, link_id: link.id, title: task.title, kind },
      parts.sent,
      {
        // the server's number and stored row for the new task, painted
        // while no delivery holds it
        keep: (answer) => {
          if (answer) pending.take({ num: answer.num, row: answer })
          return parts.kept()
        },
        // the new task's window reads its thread and lists from now on,
        // also before a delivery holds it (addIssue)
        onOk: () => tookCreate(taskId, it.org),
        onError: (error) => {
          pending.refused()
          toastWriteError(error)
        },
        ...(shown ? { about: { task: it.uuid, answer: true as const } } : {}),
      },
    )
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
    if (!row || !uuid) {
      // the task the window shows from its own answer
      const shown = answerTaskOf(id)
      return shown ? moveAnswerTask(shown, projectId) : null
    }
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
    const at = new Date().toISOString() // the server's move fires the touch
    const family = [uuid, ...carried.map((task) => task.uuid)]
    const view: View = {
      workspace: moveRowsPaint(family, projectId, leavesParent, at, row.org_id),
    }
    void send(
      api.issues.move,
      {
        org_id: row.org_id,
        id: uuid,
        project_id: projectId,
        ...(leavesParent ? { detach_parent: true } : {}),
      },
      view,
      { over: overOf('issues', row, leavesParent ? ['project_id', 'parent_id'] : ['project_id']) },
    )
    return id
  },

  /* What the Archive or delete window lists for deleting a task: each
     subtask under it, and under every subtask that would be deleted with it,
     with whether I can delete it (Edit access to its project). A subtask I
     cannot delete stays, keeping its own subtasks, so those are not listed.
     `hidden` is true when the task, or a subtask that would be deleted, has
     subtasks in projects I cannot see; how many is not known here. With
     `family` (P.familyOf) the task and its subtasks are the family's. */
  deletePlan: (
    id: string,
    family?: TaskFamily,
  ): { rows: DeleteRow[]; deletable: IssueVM[]; hidden: boolean } => {
    const byId = family?.byId ?? PLANNER.issueById
    const root = family?.root ?? PLANNER.issueById[id]
    const rows: DeleteRow[] = []
    if (!root) return { rows, deletable: [], hidden: false }
    let hidden = root.hasHiddenSubtasks
    const seen = new Set([root.id])
    const walk = (it: IssueVM, depth: number) => {
      for (const key of it.children) {
        const child = byId[key]
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
     Archive or delete window listed as deletable, from the task's family
     (P.familyOf), so also subtasks the workspace does not hold yet. Every
     other subtask under a deleted task loses its parent and becomes a
     top-level task; the server checks the subtasks again and refuses the
     whole delete if they changed, and a chosen subtask the family no longer
     holds sends nothing and resolves false (chosenSubtaskIds).
     Resolves whether the server deleted it (a refusal is toasted). Normally
     the change paints at once and goes again on refusal; with `wait`, as the
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
    if (!row || !uuid) {
      // the task the window shows from its own answer, which always waits
      const shown = answerTaskOf(id)
      return shown ? deleteAnswerTask(shown, subtasks, reason) : Promise.resolve(false)
    }
    if (refusePausedEdit()) return Promise.resolve(false)
    // While tasks still load, the window lists the subtasks from the task's
    // own answer (P.familyOf), which can name subtasks the workspace does
    // not hold yet, so each is found there too
    const model = PLANNER.issueById[id]
    const family = subtasks.length && model ? PLANNER.familyOf(model) : null
    const uuidOf = (key: string) => keyToUuid.get(key) ?? family?.byId[key]?.uuid
    const subtaskIds = chosenSubtaskIds(subtasks, uuidOf)
    if (!subtaskIds) return Promise.resolve(false)
    const gone = new Set([uuid, ...subtaskIds])
    // the paint of the delete; the server moves the rows to Deleted items
    // (convex/model/deletedItems.ts) and keeps the attachment bytes there
    const at = new Date().toISOString()
    const view: View = { workspace: () => dropDeletedTasks(gone, at, row.org_id) }
    const text = (reason || '').trim()
    const args = {
      org_id: row.org_id,
      id: uuid,
      ...(subtaskIds.length ? { subtask_ids: subtaskIds } : {}),
      ...(text ? { reason: text } : {}),
    }
    // The task's window releases its thread once the task leaves the rows
    // (IssueDetail), and takes it again if a refusal brings the task back.
    if (!wait) return send(api.issues.deleteDeep, args, view)
    const epoch = storeEpoch
    // the delivery may already hold the result; nothing paints then
    return sendAwaited(api.issues.deleteDeep, args, 'none', { keep: () => view }).then(
      () => true,
      (error) => {
        // it painted nothing, so a refusal has nothing to revert
        if (epoch === storeEpoch) toastWriteError(error, false)
        return false
      },
    )
  },

  /* ---- archive (0070): the Active/Archived axis, orthogonal to status ----
     Archived issues are invisible to the snapshot, so archiving locally
     means dropping rows from the row cache, exactly what the next delivery
     holds. The Archive or delete window waits for the server, so nothing
     changes here until it accepts and a refusal leaves the task and the
     window in place (toasted). Resolves whether the server archived it, or
     'already' when it was archived before this call, by another person,
     another tab, the person's own REST or MCP token or auto-archive, so
     this call changed nothing, posted no reason and paints nothing.
     `reason` travels as an argument, and the server posts it as a comment in
     the same transaction. With `keepSubtasks` the server detaches the task's
     active direct children first and archives the task alone, so only the
     task leaves the board and its subtasks become top-level tasks;
     otherwise the whole subtree goes with it. */
  archiveIssue: (
    id: string,
    reason?: string,
    keepSubtasks = false,
  ): Promise<boolean | 'already'> => {
    const uuid = keyToUuid.get(id)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!row || !uuid) {
      // the task the window shows from its own answer
      const shown = answerTaskOf(id)
      if (!shown || !PLANNER.familyOf(shown.model)) return Promise.resolve(false)
      return sendArchive(shown.org, shown.uuid, reason, keepSubtasks, {
        task: shown.uuid,
        answer: true,
      })
    }
    return sendArchive(row.org_id, uuid, reason, keepSubtasks)
  },

  /** Restore from Archived tasks. Awaited, never optimistic, because the
      row is not in the snapshot. The snapshot pulls the restored rows back
      in reactively, with no refetch. Resolves false on refusal (toasted).
      A subtask whose parent is full, or whose parent's delete still has to
      detach it, comes back as a top-level task, which is toasted too. The
      task's organization is `orgId` when the caller knows it, as an
      archived row does, else that of the loaded project `projectId`, else
      the home organization. */
  unarchiveIssue: async (
    issueUuid: string,
    title?: string,
    projectId?: string,
    orgId?: string,
  ): Promise<boolean> => {
    const org = orgId || orgOfProject(projectId) || HOME_ORG
    const seen = inboxDeliveries
    pendingRestores.set(issueUuid, false)
    try {
      const out = await sendAwaited(api.issues.unarchive, { org_id: org, id: issueUuid }, 'none')
      // a delivery taken since the send holds the restore (pendingRestores)
      if (pendingRestores.has(issueUuid)) {
        if (inboxCurrent && inboxDeliveries > seen) pendingRestores.delete(issueUuid)
        else pendingRestores.set(issueUuid, true)
      }
      // the parent was full (LIMITS.subtasks), or was deleted after this
      // task was archived and came back since
      if (out.left_parent) {
        const why =
          out.left_parent === 'full'
            ? `its parent already has ${grouped(LIMITS.subtasks.max)} active subtasks`
            : 'its parent was deleted after this task was archived'
        toast(
          `${title ? `"${title}"` : 'The task'} is back as a top-level task, because ${why}.`,
          'info',
        )
      }
    } catch (e) {
      pendingRestores.delete(issueUuid)
      console.error('[qivo] restore failed:', e)
      toast(restoreErrorText(e))
      return false
    }
    return true
  },

  /** One page of archived tasks of `scope` for the Archived tasks page,
      most recently archived first, or null on a transport or server error.
      Never part of the snapshot. The scope is some projects of one
      organization, a top-level project standing for its sub-projects, or
      every project of the organization this person sees; the server
      decides which (issues.archivedPage). With `search` the rows are the
      matches only, and a page may hold fewer rows than asked, even none,
      while `nextCursor` says more remain. `scanned` counts the archived
      tasks of the scope the page looked at. `tooWide` says the scope holds
      more of this person's projects than one page lists side by side, so
      the page holds no rows and a narrower scope lists them. */
  fetchArchivedPage: async (
    scope: ArchivedScope,
    o: { cursor?: string | null; search?: string; limit?: number } = {},
  ): Promise<{
    rows: ArchivedListRowVM[]
    nextCursor: string | null
    scanned: number
    tooWide: boolean
  } | null> => {
    let data: FunctionReturnType<typeof api.issues.archivedPage>
    try {
      data = await convex.query(api.issues.archivedPage, {
        scope:
          'all' in scope
            ? { org_id: scope.org, all: true }
            : { org_id: scope.org, project_ids: scope.projectIds },
        ...(o.cursor ? { cursor: o.cursor } : {}),
        ...(o.search ? { search: o.search } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
      })
    } catch (e) {
      console.error('[qivo] archived fetch failed:', e)
      return null
    }
    return {
      rows: data.rows.map((row) =>
        shapeArchivedListRow(
          row,
          handleFor(row.id, row.org_id, `${ISSUE_PREFIX}-${row.num}`),
          `${ISSUE_PREFIX}-${row.num}`,
        ),
      ),
      nextCursor: data.next_cursor,
      scanned: data.scanned,
      tooWide: data.too_wide === true,
    }
  },
  /** Stars (`favorite` true) or unstars top-level project `project.id` of
      organization `project.org_id` for this person's seat there
      (projectNav.setFavorite), as the All projects directory's star does.
      A favorite never reaches the workspace, so nothing paints: the
      navigation reads' next answers move the project between their
      groups. The server checks the star by ordinary access and refuses it,
      with the store's toast, for a project the seat cannot see, a
      sub-project or a read-only organization. It changes only the seat's
      own row, so it goes out while the snapshot is stale (UNPAUSED_WRITES)
      and pauses only without a seat, signed out and while Qivo cannot
      save. Resolves whether the server took it. */
  setFavorite: (project: { id: string; org_id: string }, favorite: boolean): Promise<boolean> =>
    send(
      api.projectNav.setFavorite,
      { org_id: project.org_id, project_id: project.id, favorite },
      'none',
    ),
  /** Whether the project `ask` names is open to this person for
      navigation (projectNav.resolve), with its name, number, organization
      and top-level project. `ask` is the project's id, which goes alone,
      or its organization and number, as a project address names it. The
      server judges it by ordinary access, as the project picker's lists,
      so an organization admin resolves only the projects their own leads,
      grants and team shares reach. A check the server could not finish
      answers `unavailable` with reason access_unchecked and its sentence,
      apart from a project the person cannot open. Null for a failed read.
      One read, never subscribed to and never part of the snapshot. Its
      callers are startup's check of the remembered project and of a
      project address the workspace does not hold (App.tsx), the open rule
      of the lists on the navigation reads (components/projectNavRows.tsx
      useNavOpen), Search's Search in and Settings › Archived tasks. */
  resolveProject: async (ask: ProjectAsk): Promise<ProjectResolved | null> => {
    try {
      return await convex.query(
        api.projectNav.resolve,
        typeof ask === 'string' ? { project_id: ask } : { org_id: ask.org_id, num: ask.num },
      )
    } catch (e) {
      console.error('[qivo] project resolve failed:', e)
      return null
    }
  },
  /** One page of main Search for `text` (search:page): task and project
      results ranked together across every organization of this login, or
      the narrower `scope`, with archived tasks when `includeArchived`, from
      `cursor`, the next_cursor of the page before (none for the first). A
      task row gains its display key and the handle the app has for it now,
      the key for a home organization's task and the uuid for another's. A
      refusal answers its code and sentence, and any other failure
      `failed`. One-shot, never part of the snapshot, so a hidden tab reads
      nothing. */
  fetchSearchPage: async (
    text: string,
    o: { includeArchived: boolean; scope?: SearchScope | null; cursor?: string | null },
  ): Promise<SearchPageAnswer> => {
    try {
      const data = await convex.query(api.search.page, {
        text,
        include_archived: o.includeArchived,
        ...(o.scope ? { scope: o.scope } : {}),
        ...(o.cursor ? { cursor: o.cursor } : {}),
      })
      // shaped inside the try, so an answer of another shape is a failure
      return {
        state: 'ok',
        rows: data.rows.map((row) => {
          if (row.kind !== 'task') return row
          const key = `${ISSUE_PREFIX}-${row.num}`
          return { ...row, key, handle: handleFor(row.id, row.org_id, key) }
        }),
        nextCursor: data.next_cursor,
        coverage: data.coverage,
      }
    } catch (e) {
      const { code, message } = errData(e)
      if (code === 'bad_request' || code === 'rule')
        return { state: 'refused', code, message: asSentence(message || 'Search refused this.') }
      console.error('[qivo] search failed:', e)
      return { state: 'failed' }
    }
  },
  /** Whether the snapshot holds task `uuid` as an active task, such as an
      archived one that someone restored. A task it holds is active also
      before it holds every task; one it lacks then may be active all the
      same, as it holds no task until something asks for every one. */
  isLiveTask: (uuid: string): boolean => rows.issues.has(uuid),
  /** Links two tasks the workspace holds, `type` as seen from task `srcId`.
      Resolves whether the server accepted it; false for a link it sent
      nothing for. A link with a task the workspace does not hold goes
      through P.linkTasks. */
  addLink: (srcId: string, type: string, dstId: string): Promise<boolean> => {
    if (srcId === dstId) return Promise.resolve(false)
    const a = keyToUuid.get(srcId)
    const b = keyToUuid.get(dstId)
    if (!a || !b) return Promise.resolve(false)
    const already = [...rows.links.values()].some(
      (l) => (l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a),
    )
    if (already || refusePausedEdit()) return Promise.resolve(false)
    const src = rows.issues.get(a)
    if (!src) return Promise.resolve(false)
    // the per-task cap on links, as this view counts them (the server checks too)
    const from = PLANNER.issueById[srcId]
    const to = PLANNER.issueById[dstId]
    const full =
      linkBlock(from ? capInputs(from).links : []) ||
      linkBlock(to ? capInputs(to).links : [], to?.key)
    if (full) {
      toast(full)
      return Promise.resolve(false)
    }
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
    const view: View = {
      workspace: () => {
        if (!rows.issues.has(source) || !rows.issues.has(target)) return
        if (rows.links.keysWhere((l) => l.pair_key === row.pair_key).length) return
        rows.links.set(row.id, { ...row })
      },
    }
    return send(
      api.issues.addLink,
      { org_id: src.org_id, id: row.id, source_id: source, target_id: target, type: dbType },
      view,
    )
  },

  /** Removes the link between two tasks the workspace holds, sending the
      kind its row shows as the one expected. Resolves whether the server
      accepted it. A link with a task the workspace does not hold goes
      through P.unlinkTasks. */
  removeLink: (aId: string, bId: string): Promise<boolean> => {
    const a = keyToUuid.get(aId)
    const b = keyToUuid.get(bId)
    if (!a || !b) return Promise.resolve(false)
    const src = rows.issues.get(a) || rows.issues.get(b)
    if (!src || refusePausedEdit()) return Promise.resolve(false)
    const view: View = {
      workspace: () => {
        for (const id of rows.links.keysWhere(
          (l) =>
            (l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a),
        ))
          rows.links.delete(id)
      },
    }
    // the kind on screen, as seen from task a: a link of another kind put
    // there since is refused rather than removed unseen
    const shown = [...rows.links.values()].find(
      (l) => (l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a),
    )
    const kind = !shown
      ? null
      : shown.type !== 'blocks'
        ? 'relates'
        : shown.source_id === a
          ? 'blocks'
          : 'blocked_by'
    return send(
      api.issues.removeLink,
      { org_id: src.org_id, a, b, ...(kind ? { expected: { kind } } : {}) },
      view,
      { notice: { deletes: true } },
    )
  },

  /* --- the task window's relation pickers ------------------------------- */
  /** One batch of the tasks the window's Parent, Subtasks or Linked tasks
      picker offers for task `task` (taskWindow.relationCandidates), read
      once and never subscribed to: after `cursor` (an earlier answer's
      `next` or `all_projects`), matching `search`. A search past its limit
      or a cursor the server no longer accepts answers `refused` with the
      server's sentence, and a failed read null. */
  relationCandidates: async (o: {
    task: { uuid: string; org: string }
    kind: RelationKind
    search: string
    cursor: string | null
  }): Promise<RelationCandidates | null> => {
    try {
      return await convex.query(api.taskWindow.relationCandidates, {
        org_id: o.task.org,
        issue_id: o.task.uuid,
        kind: o.kind,
        ...(o.search === '' ? {} : { search: o.search }),
        ...(o.cursor === null ? {} : { cursor: o.cursor }),
      })
    } catch (e) {
      const { code, message } = errData(e)
      if (code === 'bad_request' || code === 'rule')
        return { state: 'refused', message: asSentence(message || 'Qivo refused this search.') }
      console.error('[qivo] relation picker read failed:', e)
      return null
    }
  },

  /* --- the task label picker and the editor's mention popup ------------ */
  /** One batch of the task label picker for organization `org`
      (labels.picker), read once and never subscribed to: the labels whose
      name holds every word of `search`, after `cursor`, an earlier answer's
      `next`, or from the start, with `exact` and, in a first batch,
      `can_create`. A search past its limit or a cursor the server no
      longer accepts answers `refused` with the server's sentence, and a
      failed read null. */
  labelChoices: async (o: {
    org: string
    search: string
    cursor: string | null
  }): Promise<LabelChoices | null> => {
    try {
      const batch: LabelPickerBatch | null = await convex.query(api.labels.picker, {
        org_id: o.org,
        ...(o.search === '' ? {} : { search: o.search }),
        ...(o.cursor === null ? {} : { after: o.cursor }),
      })
      // an answer that holds no batch is a failed read, never an empty list
      return Array.isArray(batch?.rows) ? { state: 'ready', ...batch } : null
    } catch (e) {
      const { code, message } = errData(e)
      if (code === 'bad_request' || code === 'rule')
        return { state: 'refused', message: asSentence(message || 'Qivo refused this search.') }
      console.error('[qivo] label picker read failed:', e)
      return null
    }
  },

  /** One batch of the editor's @ mention popup for organization `org`
      (pickers.mentions), read once and never subscribed to: the people
      whose name, initials and email hold every word of `search`, after
      `cursor`, an earlier answer's `next`, or from the start. A search past
      its limit or a cursor the server no longer accepts answers `refused`
      with the server's sentence, and a failed read null. */
  mentionChoices: async (
    org: string,
    search: string,
    cursor: string | null,
  ): Promise<MentionChoices | null> => {
    try {
      return await convex.query(api.pickers.mentions, {
        org_id: org,
        ...(search === '' ? {} : { search }),
        ...(cursor === null ? {} : { after: cursor }),
      })
    } catch (e) {
      const { code, message } = errData(e)
      if (code === 'bad_request' || code === 'rule')
        return { state: 'refused', message: asSentence(message || 'Qivo refused this search.') }
      console.error('[qivo] mention suggestions read failed:', e)
      return null
    }
  },

  /* --- the task owner pickers and Team sync's Mention window ---------- */
  /** One batch of the people who could become task `task`'s assignee or
      reviewer (`field`, pickers.taskOwners), read once and never
      subscribed to. It holds the people whose name holds every word of
      `search`, after `cursor`, an earlier answer's `next`, or from the
      start. A search past its limit or a cursor the server no longer
      accepts answers `refused` with the server's sentence, and a failed
      read null. */
  ownerChoices: (o: {
    task: { uuid: string; org: string }
    field: 'assignee' | 'reviewer'
    search: string
    cursor: string | null
  }): Promise<OwnerChoices | null> =>
    pickerRead('owner picker', () =>
      convex.query(api.pickers.taskOwners, {
        org_id: o.task.org,
        issue_id: o.task.uuid,
        field: o.field,
        ...(o.search === '' ? {} : { search: o.search }),
        ...(o.cursor === null ? {} : { after: o.cursor }),
      }),
    ),

  /** One batch of the people Team sync's Mention window may notify about
      task `task` (pickers.syncRecipients), read once as P.ownerChoices
      reads its batches. */
  recipientChoices: (o: {
    task: { uuid: string; org: string }
    search: string
    cursor: string | null
  }): Promise<OwnerChoices | null> =>
    pickerRead('mention recipients', () =>
      convex.query(api.pickers.syncRecipients, {
        org_id: o.task.org,
        issue_id: o.task.uuid,
        ...(o.search === '' ? {} : { search: o.search }),
        ...(o.cursor === null ? {} : { after: o.cursor }),
      }),
    ),

  /** Whether each person of `ids` could be chosen now in task `task`'s
      picker for `field` (pickers.canOwn), read once: their row, null for
      an id the organization does not hold, and `eligible`. More ids than
      the server takes answers `refused` with the server's sentence, and a
      failed read null. */
  ownerChecks: (o: {
    task: { uuid: string; org: string }
    field: 'assignee' | 'reviewer' | 'recipient'
    ids: string[]
  }): Promise<OwnerChecks | null> =>
    pickerRead('owner check', () =>
      convex.query(api.pickers.canOwn, {
        org_id: o.task.org,
        issue_id: o.task.uuid,
        field: o.field,
        ids: o.ids,
      }),
    ),

  /** The parent of task `uuid` as the window's own answer of it shows it,
      painted, for the Parent row of a task the workspace holds whose
      parent it does not hold, as one the Parent picker offered. Null for
      none, a hidden one, or a task the window does not watch. */
  shownParent: (uuid: string): RelatedTaskVM | null => {
    const parent = uuid === watchedComments ? paintedAnswer()?.parent : null
    return parent ? relatedTask(parent.id, parent) : null
  },

  /** Subtask `uuid` of the watched task as the window's own answer lists
      it, painted, as a Subtasks picker's row without a parent
      (convex/lib/relationPicker.ts RelationCandidate), so a picker that
      took it off can make it a subtask again (P.setSubtaskParent needs the
      row for a task the workspace does not hold). Null for a task the
      answer does not list. Reads the answer's own list, never the
      workspace's tasks. */
  subtaskPickRow: (uuid: string): RelationCandidate | null => {
    const short = paintedAnswer()?.subtasks.rows.find((row) => row.id === uuid)
    if (!short) return null
    const { has_subtasks: _group, ...fields } = short
    return fields
  },

  /** Whether the person may edit some live sub-project of organization
      `org`, for Link task on a task they only view: a link needs Edit on
      either task (convex/model/issues.ts linkAccess), and the Linked tasks
      picker then lists the projects they can edit. Reads the workspace's
      projects, never its tasks. */
  editsSomeProject: (org: string): boolean =>
    PLANNER.projects.some((p) => p.type === 'project' && p.org === org && PLANNER.canWrite(p.id)),

  /** Makes task `child` a subtask of the window's task `open` with `on`,
      or takes it off `open`, for a pick in the Subtasks picker and a
      Subtasks row's ×. `open` is the window's handle of its task, held or
      shown from a current answer; for any other it sends nothing and says
      why (P.refuseStaleEdit). Either way the write's expected values are
      the child's parent pair as the window showed it (`child.parent` and
      `child.hiddenParent`), so a change someone made meanwhile is refused
      rather than overwritten, also once the workspace holds the child
      with another parent. A child the workspace holds goes through
      P.updateIssue with that pair. Any other sends issues.update from what
      the window showed of it, marked as from an answer; it paints the
      window's Subtasks list (subtaskListPaint), the views' copies of the
      child, the hours a held parent loses, and the child's workspace row
      once the workspace holds it, as when the child arrives while the
      write waits, so the Board never shows its old parent meanwhile.
      Resolves whether the server accepted it, false when refused here or
      there, with a toast that says why. */
  setSubtaskParent: (open: string, child: SubtaskEnd, on: boolean): Promise<boolean> => {
    if (refusePausedEdit()) return Promise.resolve(false)
    const heldOpen = PLANNER.issueById[open]
    const shown = heldOpen ? null : answerTaskOf(open)
    const openUuid = heldOpen?.uuid ?? shown?.uuid
    const org = heldOpen?.org ?? shown?.org
    if (!openUuid || !org) {
      PLANNER.refuseStaleEdit(open)
      return Promise.resolve(false)
    }
    const handle = uuidToKey.get(child.uuid)
    if (handle !== undefined && holdsIn(child.uuid, org))
      return PLANNER.updateIssue(
        handle,
        { parent: on ? openUuid : null },
        { seen: { parent_id: child.parent ?? undefined }, hiddenParent: child.hiddenParent },
      )
    const parentId = on ? openUuid : null
    if (child.parent === parentId && !child.hiddenParent) return Promise.resolve(true)
    if (on && !child.row) return Promise.resolve(false)
    const at = new Date().toISOString()
    const patch: IssueWirePatch = { parent_id: parentId }
    const kid = on && child.row ? shortOfCandidate(child.row, false) : null
    const uuid = child.uuid
    const view: View = {
      view: viewPaint([uuid], () => {
        for (const copy of viewCopiesIn(uuid, org)) {
          stampTaskPatch(copy, patch, at)
          copy.has_hidden_parent = false
        }
      }),
      detail: { task: openUuid, paint: () => subtaskListPaint(openUuid, kid, uuid, at) },
      // a parent the workspace holds loses its own hours, and the child,
      // once the workspace holds it, takes the new parent in place of the
      // one it had, a hidden one too, as the held path paints it
      workspace: () => {
        clearParentHours(parentId, at, org)
        if (!holdsIn(uuid, org)) return
        patchIssueRow(uuid, patch, at)
        rows.hiddenParentTasks.delete(uuid)
      },
    }
    return send(api.issues.update, { org_id: org, id: uuid, patch }, view, {
      over: {
        table: 'issues',
        id: uuid,
        fields: { parent_id: child.parent },
        hiddenParent: child.hiddenParent,
      },
      about: { task: uuid, answer: true },
    })
  },

  /** Links the window's task `open` to task `other`, `kind` as seen from
      `open`, for a pick in the Linked tasks picker. `open` is held or
      shown from a current answer, as for P.setSubtaskParent. Two tasks the
      workspace holds go through P.addLink. Any other pair sends
      issues.addLink in its stored form, marked as from an answer, after
      the link limit check of `open` (the other end's is the server's); it
      paints the workspace's link only where the workspace holds both
      tasks, and the window's Linked tasks show it with the links answer's
      next delivery. Resolves whether the server accepted it. */
  linkTasks: (open: string, kind: string, other: { uuid: string }): Promise<boolean> => {
    if (refusePausedEdit()) return Promise.resolve(false)
    const heldOpen = PLANNER.issueById[open]
    const it = heldOpen ?? answerTaskOf(open)?.model
    if (!it) {
      PLANNER.refuseStaleEdit(open)
      return Promise.resolve(false)
    }
    if (other.uuid === it.uuid) return Promise.resolve(false)
    const otherHandle = uuidToKey.get(other.uuid)
    if (heldOpen && otherHandle !== undefined && holdsIn(other.uuid, it.org))
      return PLANNER.addLink(open, kind, otherHandle)
    const full = linkBlock(capInputs(it).links)
    if (full) {
      toast(full)
      return Promise.resolve(false)
    }
    const [source, target, type] = storedLinkOf(it.uuid, kind, other.uuid)
    const row: Row<'issue_links'> = {
      id: crypto.randomUUID(),
      source_id: source,
      target_id: target,
      type,
      pair_key: source < target ? `${source}:${target}` : `${target}:${source}`,
      created_at: new Date().toISOString(),
    }
    const view: View = {
      workspace: () => {
        if (!holdsIn(source, it.org) || !holdsIn(target, it.org)) return
        if (rows.links.keysWhere((l) => l.pair_key === row.pair_key).length) return
        rows.links.set(row.id, { ...row })
      },
    }
    return send(
      api.issues.addLink,
      { org_id: it.org, id: row.id, source_id: source, target_id: target, type },
      view,
      { about: { task: it.uuid, answer: true } },
    )
  },

  /** Removes the link between the window's task `open` and task `other`,
      for a Linked tasks row's × and a pick of a linked task in the
      picker, with `shownKind`, the relation the window showed as seen from
      `open`, as the one expected, so a link someone changed meanwhile is
      refused rather than removed unseen, also where the workspace holds
      the link with another kind by now. It is marked as from an answer
      unless the workspace holds both tasks, and paints the workspace's
      link rows only where it holds both tasks. Resolves whether the
      server accepted it. */
  unlinkTasks: (open: string, other: { uuid: string }, shownKind: string): Promise<boolean> => {
    if (refusePausedEdit()) return Promise.resolve(false)
    const heldOpen = PLANNER.issueById[open]
    const it = heldOpen ?? answerTaskOf(open)?.model
    if (!it) {
      PLANNER.refuseStaleEdit(open)
      return Promise.resolve(false)
    }
    const a = it.uuid
    const b = other.uuid
    const bothHeld = !!heldOpen && uuidToKey.get(b) !== undefined && holdsIn(b, it.org)
    const pair = (l: Row<'issue_links'>) =>
      (l.source_id === a && l.target_id === b) || (l.source_id === b && l.target_id === a)
    const kind = shownKind === 'blocks' || shownKind === 'blocked_by' ? shownKind : 'relates'
    const view: View = {
      workspace: () => {
        if (!holdsIn(a, it.org) || !holdsIn(b, it.org)) return
        for (const id of rows.links.keysWhere(pair)) rows.links.delete(id)
      },
    }
    return send(api.issues.removeLink, { org_id: it.org, a, b, expected: { kind } }, view, {
      notice: { deletes: true },
      ...(bothHeld ? {} : { about: { task: a, answer: true as const } }),
    })
  },

  /* --- attachments ---------------------------------------------------------- */
  /** Per-file cap in bytes belongs to the project's organization, including
      when the current user is working on a project shared by another org.
      The demo stores at most DEMO_FILE_BYTES whatever the organization
      allows. */
  projectAttachmentLimit: (projectId: string) => {
    const project = rows.projects.get(projectId)
    const org = project ? rows.orgs.get(project.org_id) : null
    const cap = LIMITS.attachmentSize.max
    const limit = Math.min(org?.max_attachment_mb ?? cap, cap) * MIB
    return DEMO_MODE ? Math.min(limit, DEMO_FILE_BYTES) : limit
  },

  /** Takes a derived key or the issue uuid, like addAttachment: the size
      limit of its project, also for the task the window shows from its own
      answer (P.taskShown). */
  attachmentLimit: (issueKey: string) => {
    const it =
      PLANNER.issueById[issueKey] ??
      PLANNER.issueById[uuidToKey.get(issueKey) ?? ''] ??
      PLANNER.taskShown(issueKey)
    return PLANNER.projectAttachmentLimit(it?.project ?? '')
  },

  /** Upload + register one file: files.uploadUrl → POST the bytes →
      files.attach. Awaited by the drawer so it can show an uploading row;
      resolves the new attachment id, or null on any failure (toasted).
      `inline` marks description images, which the attachments list hides.

      files.uploadUrl gets the file's size and name, after compression, since
      the compressed file is what is sent. Outside the private demo it answers
      an upload ticket's URL on the API origin, which stores one file of that
      size, and only this person's attach of that file to this task takes it,
      with the ticket's id as the attachment's (uploadTicket); in the demo it
      reserves that size in the demo's shared storage, and the attachment's
      id is a new one. A
      refusal from the URL's receiver is toasted in its own words, and a
      POST that ended without the receiver's answer with
      UPLOAD_NOT_FINISHED, which then cancels a demo reservation that would
      otherwise hold its bytes until it expires, without waiting for the
      cancel's answer (cancelDemoReservation).

      No optimistic row until the server accepts it: three awaited hops make
      optimism pointless, and the server deletes oversize bytes inside attach
      itself (the returned refusal). The accepted row paints until a
      delivery holds it. bc022c2's pendingIssueInserts gate is
      dead too — mutations from one ConvexClient are ordered on one socket, so
      by the time uploadUrl's handler runs, a just-dispatched issues.create
      has already been accepted or refused server-side. A task the window
      shows from its own answer takes files the same way, with its
      organization, project and cap from that answer (answerUploadTarget),
      and none while that answer is not current (P.refuseStaleEdit). So
      does the person's new task the window shows from its creating
      answer, and a file of it resolves null without a toast once the
      server refused the create, whose own toast said why
      (refusedCreates). The upload follows the task `issueKey` names when
      it starts, by its uuid and organization, whatever that handle names
      later. With `opts.org` it is that organization's task, as two
      organizations can hold one task id, so the window's task shown from
      its answer takes a file by its uuid while the workspace holds another
      organization's task of that id. */
  addAttachment: withUpdateBlock(
    async (
      issueKey: string,
      input: File,
      opts?: { inline?: boolean; org?: string },
    ): Promise<string | null> => {
      // issueKey may be a derived key ("QN-482") or the issue uuid — the
      // New-issue modal and the drawer attach by uuid, which survives the rare
      // INSERT renumbering that reassigns the derived key mid-flight
      const first = uploadTarget(issueKey, opts?.org)
      // a task the window shows from an answer that is not current takes no
      // file yet, and says why, as does one the window no longer shows
      if (!first) {
        refuseUpload(issueKey, input.name)
        return null
      }
      if (refusePausedEdit()) return null
      // Shrink BEFORE the cap is applied: a 12 MB screenshot that re-encodes to
      // 600 KB should attach, not bounce. This is the choke point every caller
      // reaches, so the guard lives here rather than in each of the three
      // surfaces; the two that also pre-compress (to show an honest size, or to
      // name the file) hand over WebP, which comes straight back out.
      // Re-encoding is real wall-clock work — re-check the issue after it: the
      // row can be deleted from another tab while we encode, and a handle
      // can move to another task, so it is checked by the uuid and the
      // organization found first.
      const file = await compressImage(input)
      const target = uploadTarget(first.uuid, first.org)
      if (!target) {
        refuseUpload(first.uuid, file.name)
        return null
      }
      const { uuid, org } = first
      // the per-task cap, before any bytes are sent (the server checks too);
      // an image a description save took out no longer counts
      const full = attachmentBlock(target.count)
      if (full) {
        toast(`Couldn't upload "${file.name}". ${full}`)
        return null
      }
      const limit = PLANNER.projectAttachmentLimit(target.project)
      if (file.size > limit) {
        toast(attachmentTooLarge(file.name, limit))
        return null
      }
      const inline = !!opts?.inline
      const about: WriteAbout = { task: uuid, ...(target.answer ? { answer: true } : {}) }
      try {
        const url = await sendAwaited(
          api.files.uploadUrl,
          { org_id: org, issue_id: uuid, size: file.size, name: file.name },
          'none',
          { about },
        )
        const attId = uploadTicket(url) ?? crypto.randomUUID()
        const posted = await postUpload(url, file)
        if (!('storageId' in posted)) {
          const why = 'refused' in posted ? asSentence(posted.refused) : UPLOAD_NOT_FINISHED
          toast(`Couldn't upload "${file.name}". ${why}`)
          if ('unanswered' in posted) cancelDemoReservation(url)
          return null
        }
        const { storageId } = posted
        const out = await sendAwaited(
          api.files.attach,
          {
            org_id: org,
            id: attId,
            issue_id: uuid,
            storage_id: storageId as Id<'_storage'>,
            name: file.name,
            ...(file.type ? { mime: file.type } : {}),
            inline,
          },
          'none',
          {
            about,
            // a file of a task the workspace does not hold in its
            // organization shows with the attachments answer, which Convex
            // delivers before the write resolves (lib/convexOrdering.test.ts);
            // this paint skips then
            keep: (answer) =>
              'refused' in answer
                ? null
                : {
                    workspace: () => {
                      if (!holdsIn(uuid, org) || rows.attachments.has(attId)) return
                      rows.attachments.set(attId, { ...answer.attachment })
                    },
                  },
          },
        )
        if ('refused' in out) {
          // the server's cap verdict (size from storage metadata, never ours) —
          // a RETURNED refusal so its byte-delete commits; belt-and-braces
          // behind the pre-check above
          toast(`Couldn't upload "${file.name}". ${asSentence(out.refused.message)}`)
          return null
        }
        return attId
      } catch (e) {
        console.error('[qivo] upload failed:', e)
        // a file sent behind a create the server refused was refused for a
        // task that never existed, which the create's own refusal said
        if (refusedCreates.has(uuid)) return null
        const msg = errData(e).message || ''
        toast(`Couldn't upload "${file.name}"${msg ? `. ${asSentence(msg)}` : ''}`)
        return null
      }
    },
  ),

  /** Delete an attachment (row + bytes, one server transaction). Optimistic
      like every other send() mutator; any project member may remove any
      attachment on an issue they can write. With `deferWhilePaused`, for an
      upload only a discarded draft held, a paused delete says nothing and
      runs once edits resume (reapPausedUploads). A file the workspace does
      not hold is removed without a paint (removeUnheldAttachment), and
      `task` names the task of an upload no list holds, with `org` its
      organization, which the uploader kept. Resolves whether the server
      removed it. */
  removeAttachment: (
    attId: string,
    opts: { deferWhilePaused?: boolean; task?: string; org?: string } = {},
  ): Promise<boolean> => {
    const rec = rows.attachments.get(attId)
    if (!rec) return removeUnheldAttachment(attId, opts)
    if (opts.deferWhilePaused && (snapshotTrouble || savePause())) {
      reapAfterPause.set(attId, { task: rec.issue_id })
      return Promise.resolve(false)
    }
    if (refusePausedEdit()) return Promise.resolve(false)
    const issueRow = rows.issues.get(rec.issue_id)
    // no visible issue = the server cascade already owns (or took) the row
    if (!issueRow) return Promise.resolve(false)
    return send(
      api.files.removeAttachment,
      { org_id: issueRow.org_id, id: attId },
      {
        workspace: () => {
          rows.attachments.delete(attId)
          minted.delete(`att:${attId}`)
          inlineImages.drop(attId)
        },
      },
      { about: { task: issueRow.id } },
    )
  },

  /** Resolve an attachment to a fetchable gateway URL — minted fresh through
      the mint queue (files.mintUrls) when the cache has nothing younger than
      the skew. download=true appends &download=1 (Content-Disposition:
      attachment with the original file name); the token covers the uuid,
      not the query flags, so a download can reuse a cached token. Resolves
      null on refusal, a failed mint or a missing row, deliberately silent:
      its callers (imgActions, the Attachments section's Open and Download)
      do nothing then. A file the workspace does not hold resolves while the
      watched task's attachments answer holds it (sectionAttachment), or
      while the task the window shows from its answer names it in its
      description (detailAttachment), and null once those stop: the row gate
      the inline image loader asks before every show (attachmentHeld). */
  attachmentUrl: async (attId: string, download = false): Promise<string | null> => {
    if (!attachmentHeld(attId)) return null
    const key = `att:${attId}`
    let url = mintedUrl(key)
    if (!url) {
      await primeMint([{ kind: 'attachment', id: attId }])
      url = mintedUrl(key)
    }
    if (!url) return null
    return download ? `${url}&download=1` : url
  },

  /** Subscribe to one task's thread (subscribeThread), and to its history
      while a window shows All (showHistory). Comment changes still waiting
      for their answer paint over it again, and saved ones of other tasks
      go. `orgId` is the task's organization as its window knows it, which
      a task the workspace does not hold takes its thread, its history and
      its task answer through (P.taskDetail); the workspace's row decides
      while it holds the task. A later call for the watched task that
      brings an organization the first did not starts the watch over with
      it. */
  watchComments: (issueUuid: string | null, orgId?: string) => {
    // the organization a later call brings for the watched task starts its
    // watch over, so the empty thread and lists of a task without one go,
    // and so does another organization's, whose task of the same id is
    // another task
    if (watchedComments === issueUuid) {
      if (!issueUuid || !orgId || watchedOrg === orgId) return
      watchedComments = null
    }
    ++commentsWatchEpoch
    if (watchedHeld?.uuid !== issueUuid || (orgId && watchedHeld.org !== orgId)) watchedHeld = null
    // a create the server took shows from its creating answer only in the
    // window that watched it then
    for (const [uuid, pending] of pendingCreates)
      if (pending.taken && uuid !== issueUuid) pendingCreates.delete(uuid)
    watchedComments = issueUuid
    const row = issueUuid ? serverTask(issueUuid) : undefined
    watchedOrg = orgId ?? row?.org_id ?? null
    stopThread()
    stopHistory()
    resetHistory()
    stopSections()
    resetSections()
    commentsSnap = null
    olderComments = []
    dropCommentsGap()
    pinnedComments.clear()
    apartComments.clear()
    // the places and the press named rows of the task before
    threadPlaces.clear()
    pressKeep = new Set()
    acceptedCommentChanges.clear()
    threadStart = false
    earlierLoad = 'idle'
    threadCurrent = false
    detailFresh = false
    layers.dropSaved('thread', issueUuid ?? undefined, true)
    // a write's paint of another task's own answer can never show again
    layers.dropSaved('detail', issueUuid ?? undefined, true)
    PLANNER.commentsLoaded = false
    PLANNER.commentsFailure = 'none'
    // threadComments is org-scoped: the organization comes from the task's
    // row in the snapshot, else, for a task the workspace does not hold,
    // from its window. A uuid without either loads an empty thread rather
    // than spinning forever, and so does a new task whose create is on its
    // way: it has no comments yet, and its thread subscribes once a
    // delivery holds the task or the server took its create
    // (subscribeWaitingThread).
    const creating = watchedCreating()
    // a create the server refused never existed: its window shows it as
    // gone (watchedGone) and reads nothing
    const refused = !!issueUuid && refusedCreates.has(issueUuid) && row?.org_id !== watchedOrg
    if (issueUuid && creating) {
      PLANNER.commentsLoaded = true
      threadStart = true
      if (historyOwners.size > 0) startHistory()
    }
    // the thread, and with it the sections and the task answer
    // (syncSections), then the emptied thread and lists show, in the
    // organization the window named
    const org = watchedOrg
    if (issueUuid && org && !creating && !refused) subscribeThread(issueUuid, org)
    repaint({ thread: true, sections: true })
  },

  /** Registers whether the window `owner` shows All for the watched task,
      which shows its history beside the comments. The history subscribes
      while at least one window does (startHistory), and stops as soon as
      none does, which drops every history row, so a window back on
      Comments asks for no history at all. Each window passes one object of
      its own, since the Inbox pane and its pop-out can show one task under
      different filters. The history's start and its stop close the
      comments' gap with the comments above it (dropAboveGap): the window
      opens the other filter at its newest end, and with the gap kept, All
      would show Show earlier activity and Show newer activity over a gap
      in the comments its newest changes never reach. A second window on
      the task under Comments loses its place then. */
  showHistory: (owner: object, on: boolean) => {
    const before = historyOwners.size
    if (on) historyOwners.add(owner)
    else historyOwners.delete(owner)
    if (before > 0 === historyOwners.size > 0) return
    const gap = commentsGap !== null
    dropAboveGap()
    if (on) {
      if (startHistory() || gap) repaint({ thread: true })
      return
    }
    stopHistory()
    resetHistory()
    repaint({ thread: true })
  },

  /** Registers whether the window `owner` shows the watched task's
      Subtasks, Linked tasks and Attachments (P.sections), as showHistory
      does for the history. Their side queries subscribe while at least one
      window does, with the task's organization, and stop as soon as none
      does, which drops their answers (syncSections). The task answer stays
      while a window shows the task from it (P.taskDetail), so a phone's
      switch to Activity or a closed pop-out keeps it. A second window on
      the same task, such as an Inbox pane at phone width and its pop-out,
      subscribes nothing more, and a new one subscribes only the sides not
      running. Each window passes one object of its own. */
  showSections: (owner: object, on: boolean) => {
    const before = sectionOwners.size
    if (on) sectionOwners.add(owner)
    else sectionOwners.delete(owner)
    if (before > 0 === sectionOwners.size > 0) return
    repaint({ sections: true })
  },

  /** Retry for one section, as retryHistory is for the history: a fresh
      subscription of its side query, with 'retrying' until the server
      answers it. Does nothing unless that section failed. */
  retrySection: (name: SectionName) => retrySide(SECTION_SIDE[name]),

  /** The task the window shows from its own read while the workspace does
      not hold it (store/taskDetail.ts), when `uuid` is the watched task and
      its organization is known, and with `org`, when that organization is
      `org`, as two organizations can hold one task id; else null. Its read
      is the task side of the sections, which runs while a window shows the
      sections or the workspace does not hold the watched task. The
      person's own new task on its way that no window watches yet shows
      from its creating answer (creatingDetailOf), of organization `org`
      when named, so a window App opens on it shows it on its first
      render. */
  taskDetail: (uuid: string | null | undefined, org?: string): TaskDetailVM | null => {
    if (!uuid) return null
    const detail = PLANNER.detail
    if (detail?.task === uuid) return !org || detail.org === org ? detail : null
    if (watchedComments === uuid) return null
    const creating = creatingDetailOf(uuid)
    return creating && (!org || creating.org === org) ? creating : null
  },

  /** Retry for the window's read of the task it shows from its answer
      (P.taskDetail): a fresh subscription of the task answer, with
      'retrying' until the server answers, whether or not the sections
      show. A failure keeps the answer delivered before it. Does nothing
      unless the read failed. While the reference read serves the task, a
      failure of that read runs it again instead, and a uuid every seat
      said unavailable for is read in the seats again, from the first. */
  retryTask: () => {
    const read = refRead
    const walked = !!read && refWalkEnded(read)
    if (
      read &&
      (walked || (read.state === 'failed' && read.args && sectionFailure.task === 'none'))
    ) {
      if (walked) read.tried.clear()
      read.rechecking = false
      read.state = 'retrying'
      // a fresh subscription runs the failed query again
      parts?.stopSide('reference')
      runRefRead(read)
      repaint({ sections: true })
      return
    }
    retrySide('task')
  },

  /** Registers the reference `ref` a window opens a task by
      (lib/taskReference.ts), or none. It reads a reference that does not
      name both the task's uuid and organization until an answer does
      (P.reference), and moves the reference to the task's handle in the
      repaint in which the workspace first holds the task
      (P.watchHandles). One reference at a time, as one task is watched;
      the Inbox pane's pop-out leaves it to the pane. None stops the
      boot's read of its address, which no window took over, as when the
      workspace holds the task the address names. */
  watchTaskRef: (ref: string | null) => {
    const named = refParts(ref)
    if (!refRead && !named) {
      if (parts?.sideArgs('reference')) parts.stopSide('reference')
      return
    }
    if ((refRead?.ref ?? null) === (named ? ref : null)) return
    const known = named?.uuid && named.org ? { uuid: named.uuid, org: named.org } : null
    refRead =
      ref && named
        ? {
            ref,
            parts: named,
            tried: new Set(),
            args: null,
            answer: null,
            state: known ? 'resolved' : 'loading',
            task: known && {
              ...known,
              num: named.num ?? null,
              title: null,
              project: null,
              owner: null,
            },
            rechecking: false,
            moved: null,
          }
        : null
    if (refRead) runRefRead(refRead)
    else parts?.stopSide('reference')
    repaint({ sections: true })
    // a task the workspace holds already moves to its handle at once
    const handle = refRead && refHandle(refRead)
    if (refRead && handle) {
      refRead.moved = handle
      moveHandles(new Map([[refRead.ref, handle]]))
    }
  },

  /** Retry for the history, as retryComments is for the comments: a fresh
      subscription, with 'retrying' until the server answers it. Does
      nothing unless the history failed. */
  retryHistory: () => {
    const watched = historyWatched
    if (!watched || PLANNER.historyFailure !== 'failed') return
    PLANNER.historyFailure = 'retrying'
    emit('comments')
    subscribeHistory(watched.task, watched.org)
  },

  /** Retry. A fresh subscription makes the server run the watched thread's
      failed query again (it never caches a failed run), and 'retrying'
      lasts until the server answers it. The comments on screen stay
      meanwhile. Does nothing unless the
      thread failed. */
  retryComments: () => {
    const org = watchedOrgOf()
    if (!watchedComments || !org || PLANNER.commentsFailure !== 'failed' || watchedGone()) return
    PLANNER.commentsFailure = 'retrying'
    // the new subscription has delivered nothing yet
    threadCurrent = false
    emit('comments')
    subscribeThread(watchedComments, org)
  },

  /** Loads the comments before the oldest loaded one in the watched thread
      (snapshot.commentsBefore, one page) and adds them above it. One load at
      a time. A failure shows as commentsEarlier 'failed', and calling this
      again retries. When the oldest loaded comment was deleted meanwhile, it
      is dropped and the load asks before the next one. Past the budget the
      store then lets go of the rows nearest the newest end, outside the
      live window (keepThread), and keeps the page and the row the window
      measures. Never throws. */
  loadEarlierComments: async (): Promise<void> => {
    const issueUuid = watchedComments
    const watchEpoch = commentsWatchEpoch
    const org = watchedOrgOf()
    if (!issueUuid || !org || commentsSnap === null || threadStart || earlierLoad === 'loading')
      return
    const current = () => watchedComments === issueUuid && commentsWatchEpoch === watchEpoch
    // the anchors may have changed too, so the thread paints again
    const show = (state: typeof earlierLoad) => {
      earlierLoad = state
      repaint({ thread: true })
    }
    startPress('earlier')
    show('loading')
    for (;;) {
      const first = olderComments[0] ?? commentsSnap?.[0]
      if (!first) return show('idle')
      let page: FunctionReturnType<typeof api.snapshot.commentsBefore>
      try {
        page = await convex.query(api.snapshot.commentsBefore, {
          org_id: org,
          issue_id: issueUuid,
          before: first.id,
        })
      } catch (e) {
        if (!current()) return
        // The one bad_request this query answers means `before` is no comment
        // now. Drop it, unless my own delete already did, and ask again before
        // the next one. Each pass drops a comment, so this ends.
        if (errData(e).code === 'bad_request') {
          dropComment(first.id)
          continue
        }
        console.error('[qivo] earlier comments failed to load:', e)
        return show('failed')
      }
      if (!current()) return
      // Added only above the comment the page was asked about. When the
      // thread started over from its live window meanwhile, the next click
      // asks again.
      if ((olderComments[0] ?? commentsSnap?.[0])?.id === first.id) {
        const known = new Set(
          [...olderComments, ...newerComments, ...(commentsSnap ?? [])].map((r) => r.id),
        )
        const added = anchor(page.comments.filter((r) => !known.has(r.id)))
        olderComments = [...added, ...olderComments]
        if (!page.earlier) threadStart = true
        for (const r of added) pressKeep.add(r.id)
        keepThread('earlier')
      }
      return show('idle')
    }
  },

  /** Loads the history before the oldest loaded row of the watched task
      (snapshot.historyBefore, one page) and adds it above. One load at a
      time, and only once the live page is delivered. An answer that comes
      after the history stopped or the task changed is dropped. A failure
      shows as historyEarlier 'failed', and calling this again retries.
      Past the budget the store then lets go of the rows nearest the
      newest end, outside the live page (keepThread), and keeps the page
      and the row the window measures. Never throws. */
  loadEarlierHistory: async (): Promise<void> => {
    const issueUuid = watchedComments
    const epoch = historyEpoch
    const org = watchedOrgOf()
    if (!issueUuid || !org || historySnap === null || historyStart || historyLoad === 'loading')
      return
    const current = () => watchedComments === issueUuid && historyEpoch === epoch
    const show = (state: typeof historyLoad) => {
      historyLoad = state
      repaint({ thread: true })
    }
    const before = historyNext
    if (!before) return
    startPress('earlier')
    show('loading')
    let page: FunctionReturnType<typeof api.snapshot.historyBefore>
    try {
      page = await convex.query(api.snapshot.historyBefore, {
        org_id: org,
        issue_id: issueUuid,
        before,
      })
    } catch (e) {
      if (!current()) return
      console.error('[qivo] earlier history failed to load:', e)
      return show('failed')
    }
    if (!current()) return
    // Added only above the row the page was asked about. When the history
    // started over from its live page meanwhile, the next click asks again.
    if (historyNext === before) {
      const known = new Set(
        [...olderEvents, ...newerEvents, ...(historySnap ?? [])].map((r) => r.id),
      )
      const added = anchor(page.events.filter((r) => !known.has(r.id)))
      olderEvents = [...added, ...olderEvents]
      historyNext = page.next
      if (!page.earlier) historyStart = true
      for (const r of added) pressKeep.add(r.id)
      keepThread('earlier')
    }
    show('idle')
  },

  /** Loads back comments the store let go between its two runs of the
      watched thread (Show newer comments): snapshot.commentsBefore with the
      watched task in its organization, before the 50th released id, or the
      first comment kept below the gap when fewer are released
      (lib/threadBudget.ts newerAnchor), and joins the page to the run above
      (joinNewer). A page that reaches no comment of that run and does not
      start the thread, which only comments past the server's page bytes
      make, reads on before its own first comment. An anchor the server
      calls no comment (bad_request) leaves the gap, or the run below it,
      and the read asks before its neighbour above, so the page still
      reaches the run. Any other failure shows as commentsNewer 'failed',
      and calling this again retries. One read at a time; an answer that
      comes after the task changed or the gap moved is dropped. Then the
      store lets go of the rows at the oldest end (keepThread). Never
      throws. */
  loadNewerComments: async (): Promise<void> => {
    const issueUuid = watchedComments
    const watchEpoch = commentsWatchEpoch
    const org = watchedOrgOf()
    if (!issueUuid || !org || commentsSnap === null || commentsGap === null) return
    if (newerLoad === 'loading') return
    startPress('newer')
    const ask = ++newerAsk
    const show = (state: typeof newerLoad) => {
      if (newerAsk !== ask) return
      newerLoad = state
      repaint({ thread: true })
    }
    show('loading')
    // the run above the gap and the gap's first id, which must stay as they
    // were for the pages to join (a refusal below moves the latter)
    const top = olderComments.at(-1)?.id
    let head = commentsGap[0]
    const mine = () =>
      watchedComments === issueUuid && commentsWatchEpoch === watchEpoch && newerAsk === ask
    const current = () =>
      mine() && commentsGap !== null && olderComments.at(-1)?.id === top && commentsGap[0] === head
    // an answer that came after the runs moved is dropped, and the row
    // offers the read again
    const dropped = () => {
      if (mine()) show('idle')
    }
    const below = () => (newerComments[0] ?? commentsSnap?.[0])?.id
    let before = newerAnchor(commentsGap, below())
    let from: string | undefined
    const pages: Row<'comments'>[] = []
    for (let reads = 0; before !== undefined && reads < 100; reads++) {
      let page: FunctionReturnType<typeof api.snapshot.commentsBefore>
      try {
        page = await convex.query(api.snapshot.commentsBefore, {
          org_id: org,
          issue_id: issueUuid,
          before,
        })
      } catch (e) {
        if (!current()) return dropped()
        if (errData(e).code !== 'bad_request' || pages.length || commentsGap === null) {
          console.error('[qivo] newer comments failed to load:', e)
          return show('failed')
        }
        // `before` is no comment now. It leaves the gap, or the run below
        // it, and the read asks before its neighbour above in the gap
        // (G[48] for G[49]), whose page still reaches the run above; a
        // first released id or a first row below asks by the rule again.
        const gone = before
        const at = commentsGap.indexOf(gone)
        if (at !== -1) {
          commentsGap = commentsGap.filter((id) => id !== gone)
          head = commentsGap[0]
        } else dropComment(gone)
        before = at > 0 ? commentsGap[at - 1] : newerAnchor(commentsGap, below())
        continue
      }
      if (!current()) return dropped()
      from ??= before
      pages.unshift(...anchor(page.comments))
      const joined = joinNewer(olderComments, commentsGap, from, pages, !page.earlier, false)
      if (joined.kind !== 'join') {
        before = page.comments[0]?.id
        continue
      }
      if (joined.gap === null) {
        olderComments = [...joined.older, ...newerComments]
        dropCommentsGap()
        newerAsk = ask
      } else {
        olderComments = joined.older
        commentsGap = joined.gap
      }
      if (joined.added.length === joined.older.length && !page.earlier) threadStart = true
      for (const r of joined.added) pressKeep.add(r.id)
      keepThread('newer')
      return show('idle')
    }
    if (current()) show(before === undefined ? 'idle' : 'failed')
    else dropped()
  },

  /** Loads back changes the store let go between its two runs of the
      watched task's history (Show newer activity), as loadNewerComments
      does for comments, through snapshot.historyBefore. A page that reaches
      no change of the run above and holds only released ids reads on from
      its `next`. One that holds a change the store never had without
      reaching that run, which a change in what the person may see makes,
      starts the history over from what it read, with nothing above it, so
      no gap is stitched across unproven (joinNewer `restart`). */
  loadNewerHistory: async (): Promise<void> => {
    const issueUuid = watchedComments
    const epoch = historyEpoch
    const org = watchedOrgOf()
    if (!issueUuid || !org || historySnap === null || historyGap === null) return
    if (historyNewerLoad === 'loading') return
    startPress('newer')
    const ask = ++historyNewerAsk
    const show = (state: typeof historyNewerLoad) => {
      if (historyNewerAsk !== ask) return
      historyNewerLoad = state
      repaint({ thread: true })
    }
    show('loading')
    const top = olderEvents.at(-1)?.id
    let head = historyGap[0]
    const mine = () =>
      watchedComments === issueUuid && historyEpoch === epoch && historyNewerAsk === ask
    const current = () =>
      mine() && historyGap !== null && olderEvents.at(-1)?.id === top && historyGap[0] === head
    const dropped = () => {
      if (mine()) show('idle')
    }
    const below = () => (newerEvents[0] ?? historySnap?.[0])?.id
    let before = newerAnchor(historyGap, below())
    let from: string | undefined
    const pages: Row<'activity_events'>[] = []
    // at most a read for every page of the gap and two more
    const most = Math.ceil(historyGap.length / 50) + 2
    for (let reads = 0; before !== undefined && reads < most; reads++) {
      let page: FunctionReturnType<typeof api.snapshot.historyBefore>
      try {
        page = await convex.query(api.snapshot.historyBefore, {
          org_id: org,
          issue_id: issueUuid,
          before,
        })
      } catch (e) {
        if (!current()) return dropped()
        if (errData(e).code !== 'bad_request' || pages.length || historyGap === null) {
          console.error('[qivo] newer history failed to load:', e)
          return show('failed')
        }
        // as for comments: the row leaves the gap or the run below it
        const gone = before
        const at = historyGap.indexOf(gone)
        if (at !== -1) {
          historyGap = historyGap.filter((id) => id !== gone)
          head = historyGap[0]
        } else newerEvents = newerEvents.filter((r) => r.id !== gone)
        before = at > 0 ? historyGap[at - 1] : newerAnchor(historyGap, below())
        continue
      }
      if (!current()) return dropped()
      from ??= before
      pages.unshift(...anchor(page.events))
      const joined = joinNewer(olderEvents, historyGap, from, pages, !page.earlier, true)
      if (joined.kind === 'short') {
        before = page.next ?? undefined
        continue
      }
      if (joined.kind === 'restart') break
      if (joined.gap === null) {
        olderEvents = [...joined.older, ...newerEvents]
        dropHistoryGap()
        historyNewerAsk = ask
      } else {
        olderEvents = joined.older
        historyGap = joined.gap
      }
      if (joined.added.length === joined.older.length && !page.earlier) {
        historyStart = true
        historyNext = null
      }
      for (const r of joined.added) pressKeep.add(r.id)
      keepThread('newer')
      return show('idle')
    }
    if (!current()) return dropped()
    // No page could be shown to meet the run above. The history starts over
    // from the run below the gap, with nothing above it, and Show earlier
    // activity reads on before its oldest row, so nothing is stitched across
    // a gap the server did not prove.
    historyEpoch++
    olderEvents = newerEvents
    apartEvents.clear()
    dropHistoryGap()
    historyNewerAsk = ask
    historyStart = false
    historyNext = (olderEvents[0] ?? historySnap?.[0])?.id ?? null
    historyLoad = 'idle'
    show('idle')
  },

  /** Registers the comment the window `owner` has open in its editor, or
      none, as the window's editingComment changes and with null when it
      unmounts. A release passes over such a comment and holds it apart
      (P.pinnedComments), so its editor and draft stay. Once no editor
      holds a comment held apart, it goes, and the store lets go of rows on
      an arrival's side (keepThread). Each window passes one object of its
      own, as for P.showHistory. */
  holdComment: (owner: object, id: string | null) => {
    const was = commentHolds.get(owner) ?? null
    if (was === id) return
    if (id === null) commentHolds.delete(owner)
    else commentHolds.set(owner, id)
    if (was === null || [...commentHolds.values()].includes(was)) return
    const pinned = pinnedComments.delete(was)
    if (keepThread('arrival') || pinned) repaint({ thread: true })
  },

  /** Reports the first comment or change on screen in the window `owner`,
      by its id, or null while the window shows the thread's newest end, as
      the reader scrolls. Every release keeps the rows around each place,
      and a comment or change that arrives past the budget lets go of rows
      on the side farther from the topmost window's place (keepThread).
      Called with no
      `first`, it drops the window's report, as on unmount. A window that
      never reported counts as at its newest end. */
  threadPlace: (owner: object, first?: string | null) => {
    if (first === undefined) threadPlaces.delete(owner)
    else threadPlaces.set(owner, first)
  },

  /* ---- Team sync (deviation #316) ----
     The page's one fact the snapshot lacks: when each open task was last
     commented on (api.teamSync.lastComments), for its "untouched" and
     "changed" marks. Subscribed only while the page is open, and only for
     `ownerIds`, the people whose cards it shows or shows next, most needed
     first. The server takes SYNC_OWNERS_MAX people a call and cuts an answer
     short past its task and byte budgets, so the people are asked in parts
     of SYNC_OWNERS_MAX, and a part whose answer comes back cut short is
     asked again as two halves, down to one person. Someone whose own answer
     is still cut short is listed in P.lastCommentsCut, which the page names
     so no card lacks its mark without a word. The page calls this with the
     home organization whenever they change, and follows the hidden-tab
     gate (lib/viewVisibility.ts) with `live`: false while the page or the
     tab is hidden, and on unmount, stops every part and keeps the marks it
     has; true asks again, the kept marks shown until every part has
     answered. Null, when the page leaves the kept pages or Done ends the
     sitting (P.releaseSync), stops the parts and empties the marks. No
     owners means no subscription. A new organization empties the marks; new
     owners in the same one keep the old marks until every part has
     answered, so stepping through the walk does not blank them. A part that
     fails shows no marks for its people until its subscription answers
     again. Nothing here is optimistic, so no paint gate is needed. */
  watchTeamSync: (orgId: string | null, ownerIds: readonly string[] = [], live = true) => {
    const owners = orgId ? [...new Set(ownerIds)] : []
    const key = owners.join(',')
    const paused = !!orgId && !live
    if (watchedSyncOrg === orgId && watchedSyncOwners === key && syncPaused === paused) return
    const watchEpoch = ++syncWatchEpoch
    syncFallback = PLANNER.lastComments
    stopSyncParts()
    watchedSyncOwners = key
    syncPaused = paused
    if (watchedSyncOrg !== orgId) {
      watchedSyncOrg = orgId
      syncFallback = new Map()
      PLANNER.lastComments = new Map()
      PLANNER.lastCommentsCut = []
      emit('teamSync')
    }
    if (paused || !orgId || !owners.length) return
    const publish = () => {
      const answered = syncParts.every((part) => part.rows !== null)
      const marks = new Map(answered ? [] : syncFallback)
      for (const part of syncParts) {
        for (const row of part.rows ?? []) {
          marks.set(row.issue_id, row.at === null ? null : Date.parse(row.at))
        }
      }
      PLANNER.lastComments = marks
      PLANNER.lastCommentsCut = syncParts
        .filter((part) => part.rows !== null && !part.complete)
        .flatMap((part) => part.owners)
      emit('teamSync')
    }
    const watch = (part: string[], at: number) => {
      // a stop asked before onUpdate returns (an answer delivered at once)
      // ends the subscription as soon as it exists
      let stopped = false
      let unsub: (() => void) | undefined
      const entry: SyncPart = {
        owners: part,
        unsub: () => {
          stopped = true
          unsub?.()
        },
        rows: null,
        complete: true,
      }
      syncParts.splice(at, 0, entry)
      unsub = convex.onUpdate(
        api.teamSync.lastComments,
        { org_id: orgId, owner_ids: part },
        (answer) => {
          if (syncWatchEpoch !== watchEpoch || !syncParts.includes(entry)) return
          if (!answer.complete && part.length > 1) {
            // cut short: ask again in halves, in the same place in the order
            const i = syncParts.indexOf(entry)
            entry.unsub()
            syncParts.splice(i, 1)
            const half = Math.ceil(part.length / 2)
            watch(part.slice(0, half), i)
            watch(part.slice(half), i + 1)
            return
          }
          entry.rows = answer.rows
          entry.complete = answer.complete
          publish()
        },
        (err) => {
          if (syncWatchEpoch !== watchEpoch || !syncParts.includes(entry)) return
          // fail closed to "nothing known" for this part's people, so none
          // of their cards claims untouched. The subscription stays, and its
          // next good answer brings their marks back.
          console.error('[qivo] team sync subscription failed:', err)
          entry.rows = []
          entry.complete = true
          // the marks kept from before cover this part's people too
          syncFallback = new Map()
          publish()
        },
      )
      if (stopped) unsub()
    }
    for (let i = 0; i < owners.length; i += SYNC_OWNERS_MAX) {
      watch(owners.slice(i, i + SYNC_OWNERS_MAX), syncParts.length)
    }
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
    if (snapshotTrouble || savePause()) return
    const prev = syncStampOf(row)
    const now = Date.now()
    const first_since =
      prev === null
        ? firstSittingDay(now, rows.orgs.get(row.org_id)?.week_start ?? DEFAULT_WEEK_START)
        : undefined
    const at = new Date(now).toISOString()
    // the sitting rule runs on the stamp the paint finds, as the server's
    // runs on the one it stores
    const view: View = {
      workspace: () => {
        const live = rows.profiles.get(profileId)
        if (!live) return
        const next = nextSyncStamp(syncStampOf(live), at, first_since)
        live.sync_at = next.at
        live.sync_since = next.since
      },
    }
    void send(
      api.teamSync.stamp,
      { org_id: row.org_id, profile_id: profileId, first_since },
      view,
      { quietPause: true },
    )
  },

  /** Post a comment (issue uuid — modal-side, like addAttachment). Resolves
      whether the server saved it, so the caller keeps the draft until it
      did. A body the server would refuse after trimming (textRefusal), or
      any comment while edits are paused, is refused here with a toast,
      before the optimistic row. A server refusal, such as lost access, is
      toasted and its row taken away before the promise resolves false. A
      task the workspace does not hold takes the organization its window
      named (orgOfTask); without one the comment is refused. */
  addComment: (issueUuid: string, body: string): Promise<boolean> => {
    const org = orgOfTask(issueUuid)
    if (!org) return Promise.resolve(false)
    const text = (body || '').trim()
    if (!text || refuseText(LIMITS.comment, text) || refusePausedEdit())
      return Promise.resolve(false)
    const rec: Row<'comments'> = {
      id: crypto.randomUUID(),
      issue_id: issueUuid,
      author: profileIn(org),
      body: text,
      created_at: new Date().toISOString(), // ISO-Z, the isNewer format
    }
    return send(
      api.comments.create,
      { org_id: org, id: rec.id, issue_id: issueUuid, body: text },
      {
        thread: {
          task: issueUuid,
          paint: () => {
            if (!rows.comments.has(rec.id)) rows.comments.set(rec.id, { ...rec })
          },
        },
      },
    )
  },

  /** Replaces a comment's body with `body`, trimmed, and stamps the edit.
      Resolves whether the server saved it, so the editor keeps the draft
      until it did; the same text resolves true without a write, and a
      missing comment or a blank body false. A body the server would refuse
      (textRefusal) is refused here with a toast, before the paint, even when
      it is the stored body. */
  updateComment: (
    id: string,
    body: string,
    opts: { seen?: string; keepDraft?: (shown: unknown) => boolean } = {},
  ): Promise<boolean> => {
    const rec = rows.comments.get(id)
    const text = (body || '').trim()
    if (!rec || !text || refuseText(LIMITS.comment, text)) return Promise.resolve(false)
    if (rec.body === text) return Promise.resolve(true)
    if (refusePausedEdit()) return Promise.resolve(false)
    // the task's organization, also for a task shown from its answer; the
    // home one only for a comment of a task neither held nor watched
    const org = orgOfTask(rec.issue_id) ?? HOME_ORG
    // the server stamps the profile I hold in the ISSUE's org (0081) — mirror
    // that optimistically, or a foreign edit would flash my home identity
    const edit = {
      body: text,
      edited_at: new Date().toISOString(),
      edited_by: profileIn(org) || CURRENT_USER,
    }
    return send(
      api.comments.update,
      { org_id: org, id, body: text },
      {
        thread: {
          task: rec.issue_id,
          paint: () => {
            const live = rows.comments.get(id)
            if (live) Object.assign(live, edit)
          },
        },
      },
      {
        about: { task: rec.issue_id },
        // the body the editor began from, which a delivery may have passed
        over: overOf('comments', rec, ['body'], opts.seen === undefined ? {} : { body: opts.seen }),
        keepDraft: opts.keepDraft,
        onError: (error) => {
          toastWriteError(error)
          // an older comment gets no delivery, so it is read again to show
          // the text that refused this edit
          if (errData(error).reason === FIELD_CHANGED && heldBeforeWindow(id))
            void refreshOlderComment(id)
        },
        // A comment older than the live window gets no delivery, so the saved
        // edit goes into the run that holds it, the truth the thread is built
        // from, or into the comment held apart for its editor.
        onOk: () => {
          acceptedCommentChanges.set(id, edit)
          patchHeldComment(id, edit)
        },
      },
    )
  },

  deleteComment: (id: string) => {
    const rec = rows.comments.get(id)
    if (!rec || refusePausedEdit()) return
    // as updateComment does for an edit
    void send(
      api.comments.remove,
      { org_id: orgOfTask(rec.issue_id) ?? HOME_ORG, id },
      {
        thread: {
          task: rec.issue_id,
          paint: () => {
            rows.comments.delete(id)
          },
        },
      },
      {
        about: { task: rec.issue_id },
        over: overOf('comments', rec, ['body']),
        notice: { deletes: true },
        onError: (error) => {
          toastWriteError(error)
          // as for an edit: an older comment is read again to show the
          // text that refused this delete
          if (errData(error).reason === FIELD_CHANGED && heldBeforeWindow(id))
            void refreshOlderComment(id)
        },
        onOk: () => {
          acceptedCommentChanges.set(id, null)
          patchHeldComment(id, null)
        },
      },
    )
  },

  /* ---- inbox messages (0074) ----
     Rows are created only by the server; the client's whole write surface is
     read_at (and delete). The Inbox acts on an ITEM, every message for one
     task, by its organization and task with the row's cutoff (readItem,
     unreadItem, removeItem, snoozeItem). The id-list actions here
     (markMessagesRead, markMessagesUnread, deleteMessages, snoozeMessages
     and the singular forms) act on the workspace inbox part's loaded
     messages; no view calls them since the Inbox lists inbox.page, the
     store's tests do, and they go with the part (t3/limits-inbox-feed).
     Each checks the pause before its paint, so a paused write paints
     nothing, and sends one write per organization, each with its own
     layer, so a seat that refuses takes back only its rows. */
  /** Marks messages read and answers whether it sent the mark, for the
      Inbox's rows. */
  markMessagesRead: (ids: string[]): boolean => {
    const at = new Date().toISOString()
    const hit = ids.filter((id) => {
      const r = rows.messages.get(id)
      return r && !r.read_at
    })
    if (!hit.length || refusePausedWrite(api.messages.markRead)) return false
    // an item's messages share one org, but a bulk mark-all spans seats —
    // group per org BEFORE any paint prunes the hit rows
    messagesByOrg(hit).forEach((list, org) => {
      void send(
        api.messages.markRead,
        { org_id: org, ids: list },
        { workspace: () => markLoadedMessagesRead(list, at) },
      )
    })
    return true
  },
  /** Marks the person's inbox item about task `task` in organization `org`
      read (messages.readItem), every unread message the server stored up
      to `through`, the item's newest _creationTime as inbox.item or a page
      row answered it, loaded or not, and answers whether it sent the read.
      Its paint marks read the loaded messages of the task that are unread,
      not snoozed and no newer than `latestAt`, the item's newest message,
      so the Inbox's row turns read at once; the badge changes once the
      unread summary answers again. The paint compares `created_at`, where
      the server cuts by _creationTime, so a backdated notice stored after
      the answer is painted read and comes back unread when the server
      answers. `quiet` refuses a paused read without a toast and leaves it
      out of what the notice counts, for the read that opening a task sends
      on its own (P.readOnOpen). Its read mark turns the Inbox's row read
      at once (P.inboxMarks). Once the server accepts it, a read of the
      watched task supersedes every Mark as unread or snooze that went out
      before it, accepted, waiting or failed, so their hold goes
      (holdWatched). A read on open the hold turned away then runs, as it
      does once a refusal frees the hold, and reads news that came past
      this read's cutoff, or sends nothing when the item holds no unread
      message. Later news on the task is read on open again, as the
      person's newest choice is read. A Mark as unread or snooze that went
      out after it is newer and holds while it waits or once accepted, and
      holds nothing once refused or failed. The read on open never frees
      it. */
  readItem: (
    target: { org: string; task: string; through: number; latestAt: string },
    { quiet = false } = {},
  ): boolean => {
    const before = holdWrites
    return sendItemRead(target, quiet, () => {
      const watched = threadWatched
      if (watched?.task !== target.task || watched.org !== target.org) return
      const hold = itemHold
      hold.readThrough = Math.max(hold.readThrough, before)
      // the read superseded the unread choices before it, so a read on
      // open the hold turned away runs now, unless a newer choice still
      // holds, for news past this read's cutoff
      if (heldBack(hold) || !hold.keptBack) return
      hold.keptBack = false
      PLANNER.readOnOpen(target.task)
    })
  },
  /** The read on open of task `task`, which a window shows once it froze
      where its unread part starts. It reads the task's inbox item with the
      organization, the task and the `through` of its item answer
      (P.inboxItem), once that answer is ok and current with unread
      messages and no snooze. It sends that read with sendItemRead, never
      P.readItem, whose acceptance frees the hold below. Nothing goes out
      while the item loads, while the seat's items are building, after a
      failure, for no item, a read item or a snoozed one, or for a task the
      store does not watch. Once the person marked the task unread from
      this client, with Mark as unread, a snooze or its end, it sends
      nothing more until the thread changes or stops, or until a row's
      accepted Mark as read of the task frees the hold (P.readItem), so
      their choice holds while the task stays open, from the moment that
      write goes out. One the server refused or that failed holds nothing
      once answered. A read the hold turned away runs again once nothing
      holds, after a refusal, a failure or a row's accepted Mark as read
      (holdWatched, P.readItem). It sends each `through` once a visit of
      the watched task, so the Inbox pane and its pop-out send one read,
      and once more when the server confirmed that read and the item's
      answer, one that came after the read went out, still holds unread
      messages at the same `through`, as for a message whose mutation
      started before the read and committed after it. It checks that at
      the confirmation too, since Convex brings the answer that holds the
      read before the read's promise resolves, so the answer that came
      with it may hold such a message, and no later answer may come. A
      paused read is refused quietly and goes out once the pause ends, and
      a refusal by the server is not sent again for its `through`. Answers
      whether it sent one. */
  readOnOpen: (task: string): boolean => {
    const shown = PLANNER.inboxItem
    if (!shown || shown.task !== task || shown.state !== 'ok' || !shown.current) return false
    // the person chose unread for this visit, or the write that does waits
    if (heldBack(itemHold)) {
      itemHold.keptBack = true
      return false
    }
    const item = shown.item
    if (!item || item.unread_count === 0 || item.snoozed_until !== null) return false
    const last = itemRead?.task === task && itemRead.org === shown.org ? itemRead : null
    if (last && item.through < last.through) return false
    const again = last !== null && item.through === last.through
    // the same `through` again only once, after the confirmation, for an
    // answer that came after the read went out
    if (
      last &&
      item.through === last.through &&
      (last.again || !last.confirmed || itemAnswers <= last.sent)
    )
      return false
    const read: NonNullable<typeof itemRead> = {
      task,
      org: shown.org,
      through: item.through,
      sent: itemAnswers,
      confirmed: false,
      again,
    }
    const sent = sendItemRead(
      { org: shown.org, task, through: item.through, latestAt: item.latest_at },
      true,
      () => {
        if (itemRead !== read) return
        read.confirmed = true
        // the answer that came with the confirmation may still hold a
        // message committed after the read
        PLANNER.readOnOpen(task)
      },
    )
    if (sent) itemRead = read
    return sent
  },
  /** Runs the unread summary again from a fresh subscription when its
      latest answer is a failure, as opening the Inbox does once a press,
      so the badge says it is loading until the answer arrives. */
  retryInboxSummary: () => {
    if (PLANNER.inboxSummary.state !== 'failed' || !parts?.rerunSide('summary')) return
    PLANNER.inboxSummary = { state: 'loading', answer: null, current: false }
    emit('inbox')
  },
  /* Mark every current notification read, including messages the
     workspace did not load and notifications in other organization seats.
     Each seat keeps the cutoff bulkReach answered at the press, so new
     arrivals stay unread (bulkInboxAction). The Inbox passes `ask`, so a
     long action waits for the keep-open notice, and the rows it shows,
     `shown`, so they turn read at once. */
  markAllMessagesRead: async (ask = false, shown: readonly ShownInboxRow[] = []): Promise<void> => {
    if (!PLANNER.canMarkAllRead) return
    const at = new Date().toISOString()
    await bulkInboxAction<FunctionReturnType<typeof api.messages.markAllRead>>(
      'read',
      ask,
      {
        ref: api.messages.markAllRead,
        messages: () =>
          PLANNER.messages.filter((message) => !message.read && message.snoozedUntil === null),
        paint: (ids) => ({ workspace: () => markLoadedMessagesRead(ids, at, true) }),
        named: (ids) => ({ workspace: () => markLoadedMessagesRead(ids, at, true) }),
        flags: {
          workspace: () => {
            unexaminedUnread = false
          },
        },
        count: (answer) => answer.marked,
      },
      (seat, previous, keep) =>
        sendAwaited(
          api.messages.markAllRead,
          { org_id: seat.org, before: previous?.before ?? seat.before },
          'none',
          { keep },
        ),
      shown,
    )
  },
  /* Back to unread, the same column the other way. Nothing is pruned by
     it: the rows it re-opens are no longer read, which is exactly what the
     server's prune asks. Marking the open task's messages unread holds off
     its read on open for the rest of the visit, unless the server refuses
     it or it fails (holdUnreadOf). */
  markMessagesUnread: (ids: string[]) => {
    const hit = ids.filter((id) => {
      const r = rows.messages.get(id)
      return r?.read_at
    })
    if (!hit.length || refusePausedWrite(api.messages.markUnread)) return
    messagesByOrg(hit).forEach((list, org) => {
      const view: View = {
        workspace: () =>
          list.forEach((id) => {
            const row = rows.messages.get(id)
            if (row) row.read_at = undefined
          }),
      }
      void send(api.messages.markUnread, { org_id: org, ids: list }, view, holdUnreadOf(list))
    })
  },
  /* Removing an item removes every message in it — the caller passes the
     whole list (P.messageGroups' ids). */
  deleteMessages: (ids: string[]) => {
    const hit = ids.filter((id) => rows.messages.has(id))
    if (!hit.length || refusePausedWrite(api.messages.remove)) return
    messagesByOrg(hit).forEach((list, org) => {
      void send(api.messages.remove, { org_id: org, ids: list }, removeMessagesPaint(list))
    })
  },
  /* Inbox cleanup spans every seat and the full server inbox, loaded or
     not. Each bounded batch selects current read rows, so unread arrivals
     and messages reopened on another device survive (bulkInboxAction).
     Completion means all writes settled. The Inbox passes `ask` and
     `shown`, as for markAllMessagesRead, so its read rows leave at once. */
  deleteReadMessages: async (ask = false, shown: readonly ShownInboxRow[] = []): Promise<void> => {
    if (!PLANNER.canRemoveRead) return
    await bulkInboxAction<FunctionReturnType<typeof api.messages.removeRead>>(
      'remove',
      ask,
      {
        ref: api.messages.removeRead,
        messages: () =>
          PLANNER.messages.filter((message) => message.read && message.snoozedUntil === null),
        paint: (ids) => removeMessagesPaint(ids, true),
        // the rows each batch's answer names, which the server removed
        named: (ids) => removeMessagesPaint(ids),
        flags: {
          workspace: () => {
            hiddenReadMessages = 0
            unexaminedRead = false
          },
        },
        count: (answer) => answer.removed,
      },
      (seat, _previous, keep) =>
        sendAwaited(api.messages.removeRead, { org_id: seat.org }, 'none', { keep }),
      shown,
    )
  },
  /* The person's answer to the keep-open notice of the bulk action that
     waits for it (bulkInboxAction): true starts it, false sends nothing. A
     cancel ends the action's state at once, so the Inbox's buttons are back
     as the notice closes. */
  answerInboxNotice: (go: boolean) => {
    const answer = noticeAnswer
    noticeAnswer = null
    // a notice nothing waits on any more, after a fault, just closes
    if (!go && PLANNER.inboxBulk?.state === 'notice') setInboxBulk(null)
    answer?.(go)
  },
  /* Registers `host` as what shows the keep-open notice, while the Inbox
     shows (it calls this from an effect, which a kept Inbox's hiding ends).
     The answered function unregisters it, and a press it showed that still
     asks bulkReach or waits for its notice then ends as if cancelled, so
     none opens its notice in an Inbox shown again, with an old plan and
     cutoff. */
  hostInboxNotice: (host: NoticeHost) => {
    noticeHost = host
    return () => {
      if (noticeHost === host) noticeHost = null
      // the press this Inbox showed ends, asking or waiting for its notice
      if (asking?.host !== host) return
      asking = null
      const answer = noticeAnswer
      noticeAnswer = null
      setInboxBulk(null)
      answer?.(false)
    }
  },
  markMessageRead: (id: string) => {
    void PLANNER.markMessagesRead([id])
  },
  deleteMessage: (id: string) => {
    PLANNER.deleteMessages([id])
  },
  /* Snooze an item until an ISO instant, or bring it back now (null). Both
     leave it UNREAD, as a reminder returns bold. The ids name the item; the
     server stamps every row of the (recipient, task) pair, so the paint
     walks the loaded rows of the same pairs rather than just the ids. The
     timed return is the server's scheduled wake (messages.wake), never a
     client timer, so every device shows it at the same instant. Since both
     leave it unread, either on the open task holds off its read on open
     for the rest of the visit, unless the server refuses it or it fails
     (holdUnreadOf). */
  snoozeMessages: (ids: string[], until: string | null) => {
    const hit = ids.filter((id) => rows.messages.has(id))
    if (!hit.length || refusePausedWrite(api.messages.snooze)) return
    const pairOf = (r: Row<'messages'>) => `${r.recipient_id}\n${r.issue_id}`
    messagesByOrg(hit).forEach((list, org) => {
      // the items, named before the paint
      const pairs = new Set(
        list.flatMap((id) => {
          const row = rows.messages.get(id)
          return row ? [pairOf(row)] : []
        }),
      )
      const view: View = {
        workspace: () =>
          rows.messages
            .where((r) => pairs.has(pairOf(r)))
            .forEach((r) => {
              if (until === null) {
                if (r.snoozed_until === undefined) return
                r.snoozed_until = undefined
                r.read_at = undefined
              } else {
                r.snoozed_until = until
                r.read_at = undefined
                r.woke_at = undefined
              }
            }),
      }
      void send(api.messages.snooze, { org_id: org, ids: list, until }, view, holdUnreadOf(list))
    })
  },

  /** Marks the person's inbox item about task `task` in organization
      `org` unread (messages.unreadItem), every message of it, loaded or
      not, and answers whether it sent the write. An unread mark turns the
      Inbox's row, whose cutoff is `through`, unread at once (P.inboxMarks),
      and the paint marks the item's loaded messages unread. On the watched
      task it holds off the read on open for the rest of the visit, unless
      the server refuses it or it fails (holdUnreadOfItem). The pause
      refuses it first, with no mark. */
  unreadItem: (target: { org: string; task: string; through: number }): boolean => {
    if (refusePausedWrite(api.messages.unreadItem)) return false
    const { org, task } = target
    const mark = setInboxMark(org, task, { through: target.through, read: false })
    void send(
      api.messages.unreadItem,
      { org_id: org, issue_id: task },
      {
        workspace: () =>
          rows.messages
            .where((r) => r.issue_id === task && r.org_id === org)
            .forEach((r) => {
              r.read_at = undefined
            }),
      },
      settlingMark(org, task, mark, holdUnreadOfItem(org, task)),
    )
    return true
  },
  /** Removes the person's inbox item about task `task` in organization
      `org` (messages.removeItem), every message the server stored up to
      `through`, the row's cutoff, loaded or not, and answers whether it
      sent the write. A message stored after it stays as the item's only
      one. A removed mark hides the Inbox's row at once (P.inboxMarks), and
      the paint removes the item's loaded messages no newer than
      `latestAt`, its newest one at the press. The pause refuses it first,
      with no mark. */
  removeItem: (target: {
    org: string
    task: string
    through: number
    latestAt: string
  }): boolean => {
    if (refusePausedWrite(api.messages.removeItem)) return false
    const { org, task } = target
    const latest = Date.parse(target.latestAt)
    const mark = setInboxMark(org, task, { through: target.through, removed: true })
    void send(
      api.messages.removeItem,
      { org_id: org, issue_id: task, through: target.through },
      {
        workspace: () =>
          rows.messages
            .where(
              (r) => r.issue_id === task && r.org_id === org && Date.parse(r.created_at) <= latest,
            )
            .forEach((r) => {
              rows.messages.delete(r.id)
            }),
      },
      settlingMark(org, task, mark),
    )
    return true
  },
  /** Snoozes the person's inbox item about task `task` in organization
      `org` until the ISO instant `until`, or with null wakes it now
      (messages.snoozeItem), and answers whether it sent the write. Both
      leave it unread, as a reminder returns bold, and the timed return is
      the server's scheduled wake. A snooze mark shows the Inbox's row,
      whose cutoff is `through`, snoozed or woken at once (P.inboxMarks),
      and the paint stamps the item's loaded messages. On the watched task
      either holds off the read on open for the rest of the visit, unless
      the server refuses it or it fails (holdUnreadOfItem). The pause
      refuses it first, with no mark. */
  snoozeItem: (
    target: { org: string; task: string; through: number },
    until: string | null,
  ): boolean => {
    if (refusePausedWrite(api.messages.snoozeItem)) return false
    const { org, task } = target
    const mark = setInboxMark(org, task, { through: target.through, snoozedUntil: until })
    void send(
      api.messages.snoozeItem,
      { org_id: org, issue_id: task, until },
      {
        workspace: () =>
          rows.messages
            .where((r) => r.issue_id === task && r.org_id === org)
            .forEach((r) => {
              if (until === null) {
                if (r.snoozed_until === undefined) return
                r.snoozed_until = undefined
                r.read_at = undefined
              } else {
                r.snoozed_until = until
                r.read_at = undefined
                r.woke_at = undefined
              }
            }),
      },
      settlingMark(org, task, mark, holdUnreadOfItem(org, task)),
    )
    return true
  },
  /** Ends the settled marks `marks` (P.inboxMarks), which an Inbox passes
      once it shows an answer that is current after they settled, so its
      rows show as the server keeps them. A mark that a later write
      replaced, or that is not settled, stays. */
  endInboxMarks: (marks: readonly InboxMark[]) => {
    const ended = new Set(marks.filter((mark) => mark.settled))
    let changed = false
    for (const [key, mark] of inboxMarks)
      if (ended.has(mark)) {
        inboxMarks.delete(key)
        changed = true
      }
    if (changed) showInboxMarks()
  },

  /* How long this person keeps a message they have read (0110); null = for
     ever. Fans out across every seat of this login server-side (auth +
     address arms); the paint walks the auth arm, exactly as the old echo
     did — the delivery trues any invited-seat stragglers. Answers whether
     the change was sent. */
  setMessageRetention: (days: number | null): boolean => {
    const me = rows.profiles.get(CURRENT_USER)
    if (!me || refusePausedWrite(api.profiles.setMessageRetention)) return false
    const account = me.auth_user_id
    const view: View = {
      workspace: () =>
        rows.profiles
          .where((p) => !!p.auth_user_id && p.auth_user_id === account)
          .forEach((p) => {
            p.message_retention_days = days == null ? undefined : days
          }),
    }
    void send(api.profiles.setMessageRetention, { days }, view)
    return true
  },

  /* Account appearance stays separate from the navigation prefs blob and the
     planner snapshot. The app provider applies it across every planner view. */
  watchAppearance: (
    receive: (preferences: AppearancePreferences) => void,
    fail: (error: Error) => void,
  ) => convex.onUpdate(api.appearance.get, {}, receive, fail),
  setAppearance: (preferences: Pick<AppearancePreferences, 'mode' | 'image_source'>) =>
    sendAwaited(api.appearance.save, preferences, 'none', {
      onError: (e) => toastWriteError(e, false),
    }),
  removeAppearanceImage: () =>
    sendAwaited(api.appearance.removeCustom, {}, 'none', {
      onError: (e) => toastWriteError(e, false),
    }),
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
      const ticket = await sendAwaited(
        api.appearance.createUpload,
        { name: file.name, size: file.size },
        'none',
      )
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
        await sendAwaited(
          api.appearance.cancelUpload,
          { ticket_id: ticket.ticket_id },
          'none',
        ).catch(() => {})
        throw error
      }
    })()
    // Leaving account settings cancels an in-flight upload, which is not a
    // failed preference save to report in the next screen.
    void pending.catch((error) => {
      if (!signal.aborted) toastWriteError(error, false)
    })
    return pending
  },

  /* Your own name (0116) — renames EVERY seat this login holds. Awaited,
     never optimistic (refusable, and an optimistic write would be taken back
     in front of the person who made it); the server RETURNS the rule
     sentence rather than throwing it, and the snapshot delivery repaints
     every seat — no manual fan-out echo. Returns an error string, or null
     when it landed. `save.seen.name` is the name the field's draft began
     from, sent as the one seen, and `save.keepDraft` runs on a
     field_changed refusal (FieldSave). */
  setDisplayName: async (name: string, save: FieldSave = {}): Promise<string | null> => {
    const me = rows.profiles.get(CURRENT_USER)
    if (!me) return 'You are not signed in'
    // collapse runs of whitespace as well as trimming, exactly as the server
    // does, so what the field echoes back is what would be stored
    const next = cleanName(String(name ?? ''))
    if (!next) return 'A name cannot be blank'
    if (overText(LIMITS.personName, next)) return limitSentence(LIMITS.personName)
    if (next === me.name) return null
    let sentence: string | null
    const epoch = storeEpoch
    try {
      // the name this seat shows: another seat of the person may differ
      const seen = typeof save.seen?.name === 'string' ? save.seen.name : me.name
      const expected = { profile_id: me.id, name: seen }
      sentence = await sendAwaited(api.profiles.setDisplayName, { name: next, expected }, 'none')
    } catch (e) {
      console.error('[qivo] rename failed:', e)
      if (epoch === storeEpoch) keepAwaitedDraft(e, save, rows.profiles.get(me.id)?.name)
      if (errData(e).reason === FIELD_CHANGED) return keptFieldText(e)
      return refusedAsPaused(e) ? refusalPauseText(e) : 'That name could not be saved'
    }
    if (sentence) return sentence.charAt(0).toUpperCase() + sentence.slice(1)
    return null
  },

  /* ---- agent keys (Settings → Organization → Users) ----
     An agent's key is its login (0100). Keys live outside the snapshot, so
     they are read on demand, once, and every mutator is AWAITED, since the
     secret exists only in createAgentKey's return value, minted in the
     browser, and the server keeps a SHA-256 and a display fingerprint,
     nothing more. */

  /** The keys of the agents of organization `orgId` among `agentIds`
      (tokens.agentKeys), each agent with its newest keys and `more`, or
      null when a read failed. One read, never subscribed, because machine
      auth stamps a key on every API call; ids go in calls of at most
      LIST_BATCH, together, and one failed call fails the answer. Each
      key's organization is recorded from `orgId`, so revoke and delete
      reach the agent's organization whether or not the store holds the
      agent. */
  agentKeys: async (
    orgId: string,
    agentIds: readonly string[],
  ): Promise<AgentKeysAnswer | null> => {
    const ids = [...new Set(agentIds)]
    if (ids.length === 0) return { agents: [] }
    const calls: string[][] = []
    for (let at = 0; at < ids.length; at += LIST_BATCH) calls.push(ids.slice(at, at + LIST_BATCH))
    let answers: AgentKeysAnswer[]
    try {
      answers = await Promise.all(
        calls.map((agent_ids) => convex.query(api.tokens.agentKeys, { org_id: orgId, agent_ids })),
      )
    } catch (e) {
      console.error('[qivo] agent key list failed:', e)
      return null
    }
    const agents = answers.flatMap((a) => a.agents)
    // revoke/delete take only the key id, and the wrapper needs the
    // AGENT's organization to pick the caller's seat
    for (const agent of agents) for (const k of agent.keys) agentKeyOrg.set(k.id, orgId)
    return { agents }
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
      await sendAwaited(
        api.tokens.createAgentKey,
        {
          org_id: org,
          id,
          agent_id: agentId,
          name,
          key_prefix: `${secret.slice(0, 7)}...${secret.slice(-5)}`,
          key_hash: hash,
        },
        'none',
      )
      agentKeyOrg.set(id, org)
      return { id, secret }
    } catch (e) {
      console.error('[qivo] agent key create failed:', e)
      return null
    }
  }),

  revokeAgentKey: async (id: string) => {
    // a paused revoke says why, beside the panel's own failure line
    if (refusePausedWrite(api.tokens.revokeAgentKey)) return false
    try {
      await sendAwaited(
        api.tokens.revokeAgentKey,
        { org_id: agentKeyOrg.get(id) || HOME_ORG, id },
        'none',
      )
      return true
    } catch (e) {
      console.error('[qivo] agent key revoke failed:', e)
      return false
    }
  },

  deleteAgentKey: async (id: string) => {
    if (refusePausedWrite(api.tokens.deleteAgentKey)) return false
    try {
      await sendAwaited(
        api.tokens.deleteAgentKey,
        { org_id: agentKeyOrg.get(id) || HOME_ORG, id },
        'none',
      )
      return true
    } catch (e) {
      console.error('[qivo] agent key delete failed:', e)
      return false
    }
  },

  /* ---- API access (Settings → Organization → API access) ----
     An admin's view of every credential in the home organization with its
     calls in one usage period, read on demand: the period list and figures,
     one page of credentials, and the people the person filter offers. Each
     API call changes the rows, so a subscription would re-render on every
     call. Each answers null when the read failed. */
  apiAccessSummary: async (period?: string) => {
    try {
      return await convex.query(api.apiAccess.summary, {
        org_id: HOME_ORG,
        ...(period === undefined ? {} : { period }),
      })
    } catch (e) {
      console.error('[qivo] API access summary failed:', e)
      return null
    }
  },

  /** One page of credentials for `args`: the period, the filters, the
      search and the cursor of the page's start (apiAccess.page). */
  apiAccessPage: async (args: ApiAccessPageArgs) => {
    try {
      return await convex.query(api.apiAccess.page, { org_id: HOME_ORG, ...args })
    } catch (e) {
      console.error('[qivo] API access page failed:', e)
      return null
    }
  },

  /** One batch of the people the person filter offers, matching `search`,
      from `cursor`, an earlier batch's `next`, or from the start. */
  apiAccessPeople: async (search: string, cursor: string | null) => {
    try {
      return await convex.query(api.apiAccess.people, {
        org_id: HOME_ORG,
        ...(search === '' ? {} : { search }),
        ...(cursor === null ? {} : { cursor }),
      })
    } catch (e) {
      console.error('[qivo] API access people failed:', e)
      return null
    }
  },

  /** One batch of Deleted items' people (deletedItems.people) for Deleted by
      and Assigned to: organization `orgId`'s people and agents in name
      order, matching `search`, from `cursor`, an earlier batch's `next`, or
      from the start. Read once a batch, never subscribed to and kept out
      of the workspace; null when the read failed. */
  deletedPeople: async (orgId: string, search: string, cursor: string | null) => {
    try {
      return await convex.query(api.deletedItems.people, {
        org_id: orgId,
        ...(search === '' ? {} : { search }),
        ...(cursor === null ? {} : { cursor }),
      })
    } catch (e) {
      console.error('[qivo] Deleted items people failed:', e)
      return null
    }
  },

  /** Revokes any credential in the home organization as its admin. Resolves
      whether the server accepted it; revoking one that is already revoked
      counts as accepted. */
  revokeApiCredential: async (table: ApiCredentialTable, id: string) => {
    if (refusePausedWrite(api.apiAccess.revoke)) return false
    try {
      await sendAwaited(api.apiAccess.revoke, { org_id: HOME_ORG, table, id }, 'none')
      return true
    } catch (e) {
      console.error('[qivo] API credential revoke failed:', e)
      return false
    }
  },

  /* ---- OAuth connections (self-service, separately listed from tokens) ---- */
  getOAuthConnectionContext: (oauthQuery: string) =>
    sendAwaited(api.oauthConnections.getContext, { oauth_query: oauthQuery }, 'none', {
      onError: (e) => toastWriteError(e, false),
    }),
  /** One batch of my connected apps (connectedApps.list), 25 at most,
      newest approval first, matching `search` when it is not empty and
      after `cursor`, an earlier batch's `next`, when given; null when the
      read failed. Read once a batch and never subscribed, because every
      call made with a connection stamps its last use. */
  connectedApps: async (
    search: string,
    cursor: string | null,
  ): Promise<ConnectedAppBatch | null> => {
    try {
      return await convex.query(api.connectedApps.list, {
        ...(search === '' ? {} : { search }),
        ...(cursor === null ? {} : { cursor }),
      })
    } catch (e) {
      console.error('[qivo] connected apps list failed:', e)
      return null
    }
  },
  /** Deletes one of my connected apps. Resolves true once it is gone,
      including when the server no longer has it (a removal from the
      organization deletes that seat's connections). The caller shows any
      other refusal, so nothing is toasted here. */
  revokeOAuthConnection: async (id: string) => {
    if (refusePausedWrite(api.oauthConnections.revoke)) return false
    try {
      await sendAwaited(api.oauthConnections.revoke, { id }, 'none')
      return true
    } catch (e) {
      return errData(e).code === 'not_found'
    }
  },

  /* ---- personal MCP tokens (Settings → Your preferences) ----
     Read a batch at a time on demand, as the connected apps are. The owner
     manages their own tokens here (authedMutations, no org_id) and nothing
     narrates; an organization admin can also list and revoke them on API
     access (apiAccessPage above). */

  /** One batch of my personal tokens across my seats
      (tokens.personalTokens), 25 at most, newest first, matching `search`
      when it is not empty and after `cursor`, an earlier batch's `next`,
      when given; null when the read failed. Read once a batch and never
      subscribed, because machine auth stamps a token's last use on every
      call made with it. */
  personalTokens: async (
    search: string,
    cursor: string | null,
  ): Promise<PersonalTokenBatch | null> => {
    try {
      return await convex.query(api.tokens.personalTokens, {
        ...(search === '' ? {} : { search }),
        ...(cursor === null ? {} : { cursor }),
      })
    } catch (e) {
      console.error('[qivo] personal token list failed:', e)
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
      await sendAwaited(
        api.tokens.createMcpToken,
        {
          id,
          profile_id: CURRENT_USER,
          name,
          token_prefix: secret.slice(0, 11),
          token_hash: hash,
          access,
          ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
        },
        'none',
      )
      return { id, secret }
    } catch (e) {
      console.error('[qivo] mcp token create failed:', e)
      return null
    }
  }),

  revokeMcpToken: async (id: string) => {
    if (refusePausedWrite(api.tokens.revokeMcpToken)) return false
    try {
      await sendAwaited(api.tokens.revokeMcpToken, { id }, 'none')
      return true
    } catch (e) {
      console.error('[qivo] mcp token revoke failed:', e)
      return false
    }
  },

  deleteMcpToken: async (id: string) => {
    if (refusePausedWrite(api.tokens.deleteMcpToken)) return false
    try {
      await sendAwaited(api.tokens.deleteMcpToken, { id }, 'none')
      return true
    } catch (e) {
      console.error('[qivo] mcp token delete failed:', e)
      return false
    }
  },

  /** Paints the project at once and returns its uuid. `onSaved` runs once the
      server has stored it. `onRefused` runs after the refusal toast, just
      before the refusal takes the project away. `shown` is the organization
      a dialog that read the parent from the server showed it in
      (ProjectShown). The create then goes to that organization, with the
      caller's seat there as lead when `p.lead` names none, and paints only
      where the workspace holds the parent. Without it the create goes to the
      organization of the parent the workspace holds, else the home
      organization. It sends no sort_order, so the server places the project
      after every sibling (convex/model/projects.ts nextSiblingPlace), and
      the paint places it by the same rule over the siblings the workspace
      holds in that organization. An organization the workspace has no row
      for sends nothing and says so in a toast. */
  addProject: (
    p: NewProjectInput,
    onSaved?: () => void,
    onRefused?: () => void,
    shown?: ProjectShown,
  ) => {
    const what = `${p.type === 'meta' ? 'project' : 'sub-project'} “${p.name}”`
    const orgId = shown?.orgId || (p.parent ? orgOfProject(p.parent) : '') || HOME_ORG
    const orgRow = rows.orgs.get(orgId)
    if (!orgRow) {
      window.showToast?.(
        `Couldn't create ${what}. Its organization hasn't loaded, so reload Qivo and try again.`,
        'error',
      )
      return
    }
    if (refusePausedEdit()) return
    const uuid = crypto.randomUUID()
    // the siblings the workspace holds in that organization, archived ones
    // included: the parent's sub-projects, or its top-level projects
    const siblings = [...rows.projects.values()].filter((x) =>
      p.parent
        ? x.parent_id === p.parent && x.type === 'project'
        : x.org_id === orgId && x.parent_id === undefined && x.type === 'meta',
    )
    // projects.num is a per-org durable number used only in links (0050);
    // preview it like addIssue previews issue numbers, fixed by the answer
    const previewNum = (orgRow.next_project_num || 0) + 1
    const row: Row<'projects'> = {
      id: uuid,
      org_id: orgId,
      type: p.type,
      parent_id: p.parent || undefined,
      key: p.key,
      num: previewNum,
      name: p.name,
      lead_id: p.lead || profileIn(orgId),
      description: p.description || '',
      // one past the largest place, as the server places it, skipping a
      // place that is not a finite number as the server does
      sort_order: siblings.reduce(
        (place, x) => (Number.isFinite(x.sort_order) ? Math.max(place, x.sort_order + 1) : place),
        0,
      ),
      track_delay: true,
      created_at: new Date().toISOString(),
    }
    // the grant rows the server stores: the caller's map ('lead' entries are
    // carried by lead_id, null ones name no grant) and the creator's own
    const grants = newProjectGrants(p, profileIn(orgId), row.lead_id || '')
    const teamAccess = { ...p.teamAccess }
    // the server replaces a key held by an archived or hidden project
    let saved: { num: number; key: string } | null = null
    const projectPaint = () => {
      const org = rows.orgs.get(orgId)
      if (rows.projects.has(uuid) || !org) return
      if (row.parent_id && !rows.projects.has(row.parent_id)) return
      const num = saved?.num ?? Math.max(previewNum, (org.next_project_num || 0) + 1)
      org.next_project_num = Math.max(org.next_project_num || 0, num)
      rows.projects.set(uuid, { ...row, num, key: saved?.key ?? row.key })
      Object.entries(grants).forEach(([uid, level]) => {
        if (rows.profiles.has(uid)) rows.access.push({ project_id: uuid, profile_id: uid, level })
      })
      Object.entries(teamAccess).forEach(([teamId, level]) => {
        if (rows.teams.has(teamId))
          rows.teamAccess.push({ project_id: uuid, team_id: teamId, level })
      })
    }
    // ONE mutation carries row + access map; the follow-up grant upsert died
    const sent = send(
      api.projects.create,
      {
        org_id: orgId,
        id: uuid,
        type: p.type,
        parent_id: p.type === 'meta' ? null : p.parent,
        key: p.key,
        name: p.name,
        lead_id: row.lead_id,
        description: p.description || '',
        track_delay: row.track_delay,
        access: p.access || {},
        team_access: p.teamAccess,
      },
      { workspace: projectPaint },
      {
        keep: (created) => {
          saved = { num: created.num, key: created.key }
          return { workspace: projectPaint }
        },
        onError: (error) => {
          toastCreateProjectError(error, what)
          onRefused?.()
        },
      },
    )
    // once the accepted project shows with its final number and key
    if (onSaved) void sent.then((ok) => ok && onSaved())
    return uuid
  },

  /* Paints the change at once and sends it. Resolves true when the server
     accepts it or nothing needed sending, false when it is missing here or
     refused by the server (toasted). Access changes one grant at a time
     (setProjectAccess, setProjectTeamAccess, removeAccess). `save` is a
     settings field's draft (FieldSave). `shown` is the project as a page
     that read it from the server showed it (ProjectShown): the write then
     goes to its organization with `expected` from `save.seen`, which must
     hold every field the patch changes, and paints only where the
     workspace holds the project. Without it a project the workspace does
     not hold is missing here. */
  updateProject: (
    id: string,
    patch: ProjectPatch,
    save: FieldSave = {},
    shown?: ProjectShown,
  ): Promise<boolean> => {
    const row = rows.projects.get(id)
    if ((!row && !shown) || refusePausedEdit()) return Promise.resolve(false)
    if ('name' in patch && refuseOver(LIMITS.projectName, patch.name ?? ''))
      return Promise.resolve(false)
    if ('description' in patch && refuseOver(LIMITS.projectDescription, patch.description ?? ''))
      return Promise.resolve(false)
    const wire: FunctionArgs<typeof api.projects.update>['patch'] = {}
    if ('name' in patch) wire.name = patch.name
    if ('lead' in patch) wire.lead_id = patch.lead || null
    if ('description' in patch) wire.description = patch.description || ''
    if ('key' in patch) wire.key = patch.key
    if ('trackDelay' in patch) wire.track_delay = !!patch.trackDelay
    if ('reviewHours' in patch) wire.review_hours = patch.reviewHours ?? null
    if (!Object.keys(wire).length) return Promise.resolve(true)
    const db: Partial<Row<'projects'>> = {}
    if ('name' in patch) db.name = patch.name
    if ('lead' in patch) db.lead_id = patch.lead || undefined
    if ('description' in patch) db.description = patch.description || ''
    if ('key' in patch) db.key = patch.key
    if ('trackDelay' in patch) db.track_delay = !!patch.trackDelay
    if ('reviewHours' in patch) db.review_hours = patch.reviewHours ?? undefined
    const lead = patch.lead || null
    const view: View = {
      workspace: () => {
        const live = rows.projects.get(id)
        if (!live) return
        // a lead handover: the server keeps the outgoing lead as User and
        // drops the incoming lead's own grant
        if (lead && lead !== live.lead_id) {
          const after = grantsAfterHandover(grantsOn(id), live.lead_id, lead)
          workspaceRows.keepList('access', (a) => a.project_id !== id)
          Object.entries(after).forEach(([uid, level]) => {
            rows.access.push({ project_id: id, profile_id: uid, level })
          })
        }
        Object.assign(live, db)
      },
    }
    const fields = Object.keys(db)
    // a project the workspace does not hold paints nothing, and checks the
    // values the page showed
    const over = row
      ? overOf('projects', row, fields, save.seen)
      : overOf('projects', { id }, fields, save.seen)
    return send(
      api.projects.update,
      { org_id: shown?.orgId ?? row?.org_id ?? '', id, patch: wire },
      row ? view : {},
      { over, ...fieldSendOptions(save) },
    )
  },

  /* Archive a project (0106). The row stays — that is the difference between
     archiving and deleting — but everything it holds leaves the working
     snapshot on the spot. The server cascade carries the active subs on the
     parent's own stamp; painted here on one timestamp so the optimistic
     snapshot and the delivery agree about which of them came along. */
  archiveProject: (id: string, shown?: ProjectShown) => {
    const row = rows.projects.get(id)
    // a project the workspace does not hold goes to the organization the
    // page showed, and paints nothing
    if (!row && shown && !refusePausedEdit()) {
      void send(api.projects.archive, { org_id: shown.orgId, id }, {})
      return
    }
    if (!row || row.archived_at || refusePausedEdit()) return
    const stamp = new Date().toISOString()
    const view: View = {
      workspace: () => {
        const live = rows.projects.get(id)
        if (!live) return
        const ids =
          live.type === 'meta' ? [id, ...rows.projects.keysWhere((x) => x.parent_id === id)] : [id]
        // an already archived sub-project keeps its own stamp
        ids.forEach((pid) => {
          const r = rows.projects.get(pid)
          if (r && !r.archived_at) r.archived_at = stamp
        })
        const issueIds = new Set(rows.issues.keysWhere((i) => ids.includes(i.project_id)))
        // A project archive hides its tasks; it does not archive the tasks. A
        // subtask in an archived project no longer makes a task in an active
        // one a group (convex/lib/liveTasks.ts countsAsSubtask), so a parent
        // left in another project keeps only its other subtasks, as the next
        // delivery says.
        for (const iid of issueIds) rows.issues.delete(iid)
        // and a child left in another project now has its parent outside this
        // view, as the next delivery says
        for (const r of rows.issues.where((i) => !!i.parent_id && issueIds.has(i.parent_id))) {
          r.parent_id = undefined
          rows.hiddenParentTasks.add(r.id)
        }
        for (const key of rows.links.keysWhere(
          (l) => !rows.issues.has(l.source_id) || !rows.issues.has(l.target_id),
        ))
          rows.links.delete(key)
        workspaceRows.keepList('issueLabels', (il) => rows.issues.has(il.issue_id))
      },
      // milestones sit on top-level projects, so a sub-project's archive
      // takes none from the milestone reads
      milestones: hideProjectMilestones(id),
    }
    void send(api.projects.archive, { org_id: row.org_id, id }, view)
  },

  /** Restore an archived project. Awaited rather than optimistic: its tasks
      are not in this client at all, and the snapshot pulls them back in
      reactively. Resolves false when the write was refused (toasted).
      `shown` names the organization a page that read the project from the
      server showed it in (ProjectShown, as Archived projects reads it), so
      a project the workspace does not hold restores too; the workspace's
      own row decides where it holds one. Without either it sends nothing
      and resolves false. */
  unarchiveProject: async (id: string, shown?: ProjectShown): Promise<boolean> => {
    const org = rows.projects.get(id)?.org_id ?? shown?.orgId
    if (!org) return false
    try {
      await sendAwaited(api.projects.unarchive, { org_id: org, id }, 'none')
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
      unreachable. `shown` names the organization of a project the
      workspace does not hold (ProjectShown). */
  projectRemovalSummary: async (
    id: string,
    shown?: ProjectShown,
  ): Promise<ProjectRemovalSummary | null> => {
    const org = rows.projects.get(id)?.org_id ?? shown?.orgId
    if (!org) return null
    try {
      return await convex.query(api.projects.removalSummary, { org_id: org, id })
    } catch (e) {
      console.error('[qivo] removal summary failed:', e)
      return null
    }
  },

  /** Restore Deleted items (Settings, Deleted items). Awaited, never
      optimistic: the work comes back through the snapshot, and the page's
      list drops the items as the server does. Runs on the shared runner
      (runDeletedItems), per organization, 25 ids a call, its progress in
      P.deletedAction, and refuses at once while another restore or Delete
      now runs. `bulk` marks every call as part of a restore of several
      items, so that a call left with one task item sends no Restored
      notice; a single row's Restore leaves it out. A deferred item is sent
      again once its project is back, also after the page is left. Toasts
      only for an action of more than one round, which may end while the
      page is gone; the page words every other outcome. */
  restoreDeletedItems: (
    items: readonly DeletedTarget[],
    { bulk = false }: { bulk?: boolean } = {},
  ): Promise<DeletedItemsOutcome<RestoreRefusal>> =>
    runDeletedItems(items, RESTORE_CALLS(bulk), { bulk }),

  /** Delete now, where an organization admin deletes Deleted items for good.
      Awaited like restoreDeletedItems, on the same runner, and never toasts
      for an action of one round either. */
  purgeDeletedItems: (
    items: readonly DeletedTarget[],
  ): Promise<DeletedItemsOutcome<PurgeRefusal>> => runDeletedItems(items, PURGE_CALLS),

  /* Move a project, its sub-projects and every task in them to Deleted
     items. Awaited, as the Archive or delete window asks. Nothing changes
     here until the server accepts, so a refusal (toasted) leaves the project
     and the window in place. `reason` is shown in Deleted items. Resolves
     whether the server deleted it. `shown` names the organization of a
     project the workspace does not hold (ProjectShown), which then paints
     nothing. */
  removeProject: (id: string, reason?: string, shown?: ProjectShown): Promise<boolean> => {
    const row = rows.projects.get(id)
    const org = row?.org_id ?? shown?.orgId
    if (!org || refusePausedEdit()) return Promise.resolve(false)
    const text = (reason || '').trim()
    const epoch = storeEpoch
    return sendAwaited(
      api.projects.deleteDeep,
      { org_id: org, id, ...(text ? { reason: text } : {}) },
      'none',
      // the delivery may already hold the result; nothing paints then
      row
        ? {
            keep: () => ({
              workspace: () => dropProjectRows(id),
              milestones: hideProjectMilestones(id),
            }),
          }
        : {},
    ).then(
      () => true,
      (error) => {
        console.error('[qivo] project delete failed:', error)
        // it painted nothing, so a refusal has nothing to revert
        if (epoch === storeEpoch) toastWriteError(error, false)
        return false
      },
    )
  },

  /* Organization settings — the old six independent UPDATEs fold into ONE
     patch mutation. A name or number outside its limit is refused here with
     the limit's sentence, never clamped. Narrates nothing, name included. Resolves whether
     the server saved the change: false without sending when it refused the
     change first (toasted) or there is no home organization here, and false
     after a refusal, which is toasted and taken back. `weekStartRefused`
     takes the sentence of a refused first day of the week, the milestones
     that would share a week or that the server could not check them all
     (WEEK_START_REFUSALS), and answers whether it showed it; one it did
     not show, as its field has gone, is toasted. `save` is a settings
     field's draft (FieldSave). */
  setOrg: (
    patch: OrgPatch,
    weekStartRefused?: (sentence: string) => boolean,
    save: FieldSave = {},
  ): Promise<boolean> => {
    const org = homeRow()
    if (!org || refusePausedEdit()) return Promise.resolve(false)
    if ('name' in patch && refuseOver(LIMITS.orgName, patch.name ?? ''))
      return Promise.resolve(false)
    if (
      'defaultPlannableHours' in patch &&
      refuseOutside(LIMITS.plannableHours, Number(patch.defaultPlannableHours))
    )
      return Promise.resolve(false)
    if (
      'maxAttachmentMb' in patch &&
      refuseOutside(LIMITS.attachmentLimit, Number(patch.maxAttachmentMb))
    )
      return Promise.resolve(false)
    const wire: FunctionArgs<typeof api.orgs.update>['patch'] = {}
    if ('name' in patch) wire.name = patch.name
    if ('dateFormat' in patch && DATE_FORMATS.includes(patch.dateFormat))
      wire.date_format = patch.dateFormat
    if (
      'weekStart' in patch &&
      Number.isInteger(patch.weekStart) &&
      patch.weekStart >= 0 &&
      patch.weekStart <= 6
    )
      wire.week_start = patch.weekStart
    if ('weekOneRule' in patch && (WEEK_ONE_RULES as readonly string[]).includes(patch.weekOneRule))
      wire.week_one_rule = patch.weekOneRule
    if ('defaultPlannableHours' in patch)
      wire.default_plannable_hours = Number(patch.defaultPlannableHours)
    if ('maxAttachmentMb' in patch) wire.max_attachment_mb = Number(patch.maxAttachmentMb)
    if ('projectCreators' in patch && isProjectCreators(patch.projectCreators))
      wire.project_creators = patch.projectCreators
    if (!Object.keys(wire).length) return Promise.resolve(true)
    const orgId = org.id
    // the rebuild re-anchors the grid when the week settings moved
    const view: View = {
      workspace: () => {
        const live = rows.orgs.get(orgId)
        if (live) Object.assign(live, wire)
      },
    }
    // the field shows the default limit for an organization that stores
    // none (shapeOrg), so a limit seen that reads as the stored one is it
    const seen = { ...save.seen }
    if (seen.max_attachment_mb === (org.max_attachment_mb ?? LIMITS.attachmentSize.max))
      seen.max_attachment_mb = org.max_attachment_mb
    return send(api.orgs.update, { org_id: orgId, patch: wire }, view, {
      over: overOf('organizations', org, Object.keys(wire), seen),
      ...fieldSendOptions(save),
      ...(weekStartRefused && {
        onError: (error: unknown) => {
          const d = errData(error)
          const shown =
            !!d.message && weekStartRefusal(d) && weekStartRefused(asSentence(String(d.message)))
          if (!shown) toastWriteError(error)
        },
      }),
    })
  },

  /** Change the organization's address — the first segment under /app/.
      Returns an error string, or null when it landed. AWAITED, never
      optimistic: the slug is the one organization column whose local value
      IS an address, so an optimistic write would move the address bar to a
      slug the server never accepted. The refusal taxonomy — taken /
      reserved / malformed — survives as sentences via ConvexError
      {code:'conflict', reason}; the FORMAT rule is mirrored here so the
      obvious typo answers without a round trip. `save.seen.slug` is the
      address the field's draft began from, sent as the one seen, and
      `save.keepDraft` runs on a field_changed refusal (FieldSave). */
  setOrgSlug: async (next: string, save: FieldSave = {}): Promise<string | null> => {
    const org = homeRow()
    if (!org) return 'Only an organization you belong to has an address'
    const slug = String(next || '')
      .trim()
      .toLowerCase()
    if (!slug) return 'An address cannot be empty'
    if (slug === org.slug) return null
    if (overText(LIMITS.slug, slug) || !SLUG_SHAPE.test(slug)) return limitSentence(LIMITS.slug)
    const orgId = org.id
    const seen = typeof save.seen?.slug === 'string' ? save.seen.slug : org.slug
    const epoch = storeEpoch
    try {
      // the accepted address paints now, so the address-bar sync moves now
      // rather than a delivery later
      await sendAwaited(
        api.orgs.setSlug,
        { org_id: orgId, slug, expected: { slug: seen } },
        'none',
        {
          keep: () => ({
            workspace: () => {
              const live = rows.orgs.get(orgId)
              if (live) live.slug = slug
            },
          }),
        },
      )
    } catch (e) {
      console.error('[qivo] slug change failed:', e)
      if (epoch === storeEpoch) keepAwaitedDraft(e, save, rows.orgs.get(orgId)?.slug)
      return slugErrorText(e)
    }
    return null
  },

  /** Paints the new team at once and resolves whether the server created
      it. Resolves false without sending when it refused the change first
      (toasted), and false after a refusal, which is toasted and taken
      back. `uuid` is the new team's id, a fresh one unless the caller
      passes its own, as Settings › Teams does to keep the team it created
      in view until a batch lists it. */
  addTeam: (name: string, uuid: string = crypto.randomUUID()): Promise<boolean> => {
    const org = homeRow()
    if (!org || !String(name || '').trim() || refusePausedEdit()) return Promise.resolve(false)
    const team: Row<'teams'> = {
      id: uuid,
      org_id: org.id,
      name,
      track_delay_default: true,
      created_at: new Date().toISOString(),
    }
    const view: View = {
      workspace: () => {
        if (!rows.teams.has(uuid) && rows.orgs.has(team.org_id)) rows.teams.set(uuid, { ...team })
      },
    }
    return send(api.teams.create, { org_id: org.id, id: uuid, name }, view)
  },

  /** Sends `patch` to team `id` as the page showed it (`shown`, TeamShown):
      to its organization, with the name the page showed as `expected`
      under the draft's `save.seen`, whether or not the store holds the
      team, and paints only where it does. Resolves whether the server saved
      it, false without sending when it refused the change first (toasted),
      and false after a refusal, which is toasted and taken back. */
  updateTeam: (
    id: string,
    patch: TeamPatch,
    save: FieldSave,
    shown: TeamShown,
  ): Promise<boolean> => {
    if (refusePausedEdit()) return Promise.resolve(false)
    if ('name' in patch && refuseOver(LIMITS.teamName, patch.name ?? ''))
      return Promise.resolve(false)
    const wire: FunctionArgs<typeof api.teams.update>['patch'] = {}
    if ('name' in patch) wire.name = patch.name
    if ('trackDelayDefault' in patch) wire.track_delay_default = !!patch.trackDelayDefault
    if (!Object.keys(wire).length) return Promise.resolve(true)
    const view: View = {
      workspace: () => {
        const live = rows.teams.get(id)
        if (live) Object.assign(live, wire)
      },
    }
    // the page shows no default of a team's delay setting, so only a name
    // goes out with an expected value
    const checked = Object.keys(wire).filter((key) => key === 'name')
    return send(
      api.teams.update,
      { org_id: shown.orgId, id, patch: wire },
      rows.teams.has(id) ? view : {},
      {
        ...(checked.length
          ? { over: overOf('teams', { id }, checked, { name: shown.name, ...save.seen }) }
          : {}),
        ...fieldSendOptions(save),
      },
    )
  },

  /* --- team membership (managed in Team settings) ------------------------- */
  /** Paints the membership at once and resolves whether the server added
      it. Resolves false without sending for a membership the store holds
      already or a paused change (toasted), and false after a refusal,
      which is toasted and taken back. It goes to the
      organization the page showed (`shown`), whether or not the store holds
      the team. A team's page keeps the added member in view until its list
      holds them, and asks the list whether it passed their place only once
      this resolved. */
  addTeamMember: (teamId: string, uid: string, shown: { orgId: string }): Promise<boolean> => {
    if (rows.teamMembers.some((m) => m.team_id === teamId && m.profile_id === uid))
      return Promise.resolve(false)
    if (refusePausedEdit()) return Promise.resolve(false)
    // the server always inserts a plain member; leadership is its own verb
    const view: View = {
      workspace: () => {
        if (!rows.teams.has(teamId) || !rows.profiles.has(uid)) return
        if (rows.teamMembers.some((m) => m.team_id === teamId && m.profile_id === uid)) return
        rows.teamMembers.push({ team_id: teamId, profile_id: uid, is_leader: false })
      },
    }
    return send(
      api.teams.addMember,
      { org_id: shown.orgId, team_id: teamId, profile_id: uid },
      view,
    )
  },

  /** Makes member `uid` of team `teamId` a leader or not, as the page
      showed them (`shown`, MemberShown): nothing when the page already
      showed them so, else to the page's organization, painting only where
      the store holds the membership. teams.setLeader takes no expected
      value. */
  setTeamLeader: (teamId: string, uid: string, isLeader: boolean, shown: MemberShown) => {
    if (shown.isLeader === isLeader || refusePausedEdit()) return
    const view: View = {
      workspace: () => {
        const live = rows.teamMembers.find((m) => m.team_id === teamId && m.profile_id === uid)
        if (live) live.is_leader = isLeader
      },
    }
    void send(
      api.teams.setLeader,
      { org_id: shown.orgId, team_id: teamId, profile_id: uid, is_leader: isLeader },
      view,
    )
  },

  /** Whether a team exists and is not the last one in its organization.
      Other organizations' teams in this client do not count. P.removeAccess
      asks it before it sends a team's deletion, and the staging check's
      cleanup waits on it; Settings › Teams turns Delete off from the
      server's count of teams instead (teams.settingsPage). */
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
      toast(emailRefusal(rec.email))
      return
    }
    // the SAME rule the server applies on a rename (0116), so a person's
    // initials do not silently change shape the first time they rename, and
    // the cap counts the name as stored
    const name = cleanName(String(rec.name ?? ''))
    if (refuseOver(LIMITS.personName, name)) return
    if (
      email &&
      [...rows.profiles.values()].some((p) => p.org_id === org.id && p.email === email)
    ) {
      toast(`${email} already has a seat in this organization`)
      return
    }
    const uuid = crypto.randomUUID()
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
    const teams: string[] = [...(rec.teams || [])]
    const view: View = {
      workspace: () => {
        if (rows.profiles.has(uuid) || !rows.orgs.has(row.org_id)) return
        rows.profiles.set(uuid, { ...row })
        teams.forEach((t) => {
          if (!rows.teams.has(t)) return
          if (!rows.teamMembers.some((m) => m.team_id === t && m.profile_id === uuid))
            rows.teamMembers.push({ team_id: t, profile_id: uuid, is_leader: false })
        })
      },
    }
    // ONE mutation: profile + memberships land or none do (the two-step
    // insert died with the phase-5 port)
    void send(
      api.profiles.create,
      {
        org_id: org.id,
        id: uuid,
        name,
        email: email,
        org_role: orgRole,
        kind: isAgent ? 'agent' : 'person',
        color: row.color,
        teams,
      },
      view,
    )
    return uuid
  },

  /** Emails pending seat `profileId` of organization `orgId` its invitation
      again (api.invites.sendAgain), which counts against the organization's
      hourly cap. Resolves whether the server took it; a refusal, such as a
      full hour, is toasted. The seat's delivery row then shows the send. */
  sendInvitationAgain: (orgId: string, profileId: string): Promise<boolean> =>
    send(api.invites.sendAgain, { org_id: orgId, profile_id: profileId }, 'none'),

  /** Applies an admin's edit to one seat. Returns false when a client
      rule refused the whole patch (with a toast), so an inline editor can
      put the stored value back. `save` is a settings field's draft
      (FieldSave), for each write the patch makes. */
  /** Sends `patch` to person `id` as the page showed them (`shown`,
      PersonShown): the client's refusals come from what the page showed,
      a field equal to what it showed goes unsent, and the rest go to its
      organization with those values as their `expected`, the draft's
      `save.seen` over them. It paints only where the workspace holds the
      person. Answers whether anything was sent, or whether nothing needed
      sending. */
  updateUser: (id: string, patch: UserPatch, save: FieldSave, shown: PersonShown): boolean => {
    // deactivation alone only takes access away, so it goes on while paused,
    // unless every seat is gone
    const deactivation = Object.keys(patch).length === 1 && patch.active === false
    const paused = deactivation ? refusePausedWrite(api.profiles.deactivate) : refusePausedEdit()
    if (paused) return false
    // the page showed no value to send as expected for these
    if ('email' in patch && shown.email === undefined) return false
    if ('canCreateProjects' in patch && shown.canCreateProjects === undefined) return false
    /* The client-predicted refusals stay audible first (the server states
       the same rules); a refusal here aborts the whole patch, matching the
       server's all-or-nothing mutation. */
    if ('name' in patch) {
      const next = cleanName(String(patch.name ?? ''))
      if (!next) {
        toast('A name cannot be blank')
        return false
      }
      if (refuseOver(LIMITS.personName, next)) return false
    }
    if ('email' in patch) {
      const next = normalizeEmail(patch.email)
      // the organization-wide address check reads the profiles the store
      // holds, none of them the target's row; t3/limits-roster-parts
      // leaves it to the server's refusal
      const taken =
        next &&
        [...rows.profiles.values()].some(
          (p) => p.id !== id && p.org_id === shown.orgId && p.email === next,
        )
      if (shown.isAgent) {
        toast('An agent has no email address. Its login is a key.')
        return false
      }
      // a person who is not an invitation any more has signed in
      if (!shown.pending) {
        toast('This email cannot be changed after the user has signed in.')
        return false
      }
      if (!PLANNER.emailLooksValid(next)) {
        toast(emailRefusal(patch.email))
        return false
      }
      if (taken) {
        toast(`${next} already has a seat in this organization`)
        return false
      }
    }
    if (
      'plannableHours' in patch &&
      !shown.isAgent &&
      refuseOutside(LIMITS.plannableHours, Number(patch.plannableHours))
    )
      return false
    // the row as the page showed it, by the row's field names
    const shownRow: Record<string, unknown> = {
      name: shown.name,
      org_role: shown.orgRole,
      active: shown.active,
      email: shown.email ?? null,
      can_create_projects: shown.canCreateProjects ?? null,
      plannable_hours: shown.plannableHours,
    }
    // Capacity has its own write path (0094): the column may also be set by
    // a team's LEADER, so it is its own mutation (orgMutation, not admin),
    // with its own layer. An agent has no plannable week (0103), so its
    // hours are skipped; hours outside LIMITS.plannableHours were refused
    // above, never clamped. Hours equal to what the page showed go unsent.
    if ('plannableHours' in patch && !shown.isAgent) {
      const h = Number(patch.plannableHours)
      const hours: View = {
        workspace: () => {
          const live = rows.profiles.get(id)
          if (live) live.plannable_hours = h
        },
      }
      if (h !== (shown.plannableHours ?? null))
        void send(
          api.profiles.setPlannableHours,
          { org_id: shown.orgId, profile_id: id, hours: h },
          hours,
          {
            over: overOf('profiles', { id }, ['plannable_hours'], { ...shownRow, ...save.seen }),
            ...fieldSendOptions(save),
          },
        )
      else save.onSettled?.()
    }
    const db: Partial<Row<'profiles'>> = {}
    const wire: FunctionArgs<typeof api.profiles.update>['patch'] = {}
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
    /* The admin door onto the name pair (deviation #93): writes ONE row —
       an admin's authority stops at their organization; set_display_name's
       every-seat fan-out is the other door, and they are different rules. */
    if ('name' in patch) {
      const next = cleanName(String(patch.name ?? ''))
      if (next !== shown.name) {
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
    // teams: the membership the server diffs to, exactly
    const teams = 'teams' in patch ? [...(patch.teams || [])] : null
    if (teams) wire.teams = teams
    // the role select sends orgRole even when it is unchanged, and only a
    // real change clears the right; worked out on the row the paint finds,
    // before the role lands, as the server does
    const rightUpdate = {
      org_role: patch.orgRole,
      can_create_projects: 'canCreateProjects' in patch ? !!patch.canCreateProjects : undefined,
    }
    const view: View = {
      workspace: () => {
        const live = rows.profiles.get(id)
        if (!live) return
        if (teams) {
          const prev = rows.teamMembers.filter((m) => m.profile_id === id).map((m) => m.team_id)
          workspaceRows.keepList(
            'teamMembers',
            (m) => !(m.profile_id === id && !teams.includes(m.team_id)),
          )
          teams
            .filter((t) => !prev.includes(t) && rows.teams.has(t))
            .forEach((t) => {
              rows.teamMembers.push({ team_id: t, profile_id: id, is_leader: false })
            })
        }
        const right = projectRightAfterUpdate(live, rightUpdate)
        Object.assign(live, db)
        if (right !== live.can_create_projects) live.can_create_projects = right
      },
    }
    // Deactivation alone has its own door, which an admin can still use while
    // billing has paused editing. Every other change, reactivation included,
    // goes through update.
    // a field sent with the value the page showed changes nothing the
    // person chose, such as the role select's active: true, so it goes
    // unsent and unchecked, and cannot undo a change someone else made to it
    for (const key of ['org_role', 'active', 'email', 'can_create_projects'] as const)
      if (key in wire && (wire[key] ?? null) === (shownRow[key] ?? null)) delete wire[key]
    const deactivateOnly = wire.active === false && Object.keys(wire).length === 1
    if (deactivateOnly) void send(api.profiles.deactivate, { org_id: shown.orgId, id }, view)
    else if (Object.keys(wire).length) {
      // teams is a list the server diffs, not a field the check compares
      const checked = Object.keys(wire).filter((key) => key !== 'teams')
      void send(api.profiles.update, { org_id: shown.orgId, id, patch: wire }, view, {
        ...(checked.length
          ? { over: overOf('profiles', { id }, checked, { ...shownRow, ...save.seen }) }
          : {}),
        ...fieldSendOptions(save),
      })
    } else if (!('plannableHours' in patch)) save.onSettled?.()
    return true
  },

  /** Whether `v` is an address the app can store: the server's own rule
      (convex/lib/email.ts cleanEmail). The UI asks before offering to
      write one. */
  emailLooksValid: (v: unknown) => normalizeEmail(v) !== null,

  /* --- profile picture ------------------------------------------------------
     Who may: that person, or an admin of their organization. The server owns
     that rule; the UI mirrors it in what it offers. Both mutators are
     AWAITED, returning an error sentence or null. An accepted change paints
     until a delivery holds it. */

  /** True when this session may change the picture of person `profileId`
      of organization `orgId`: their own, or as an admin of that
      organization, whether or not the store holds them. Mirrors the server
      rule so the UI can hide a control that would be refused. */
  canSetAvatar: (profileId: string, orgId: string) => {
    if (myProfileSet.has(profileId)) return true
    const me = rows.profiles.get(profileIn(orgId))
    return !!me && me.org_id === orgId && me.org_role === 'admin'
  },

  /** Upload a picture and hang it on the profile: files.avatarUploadUrl →
      POST → files.setAvatar. Returns an error string, or null when it landed.
      The type and LIMITS.avatarSize pre-checks mirror the server's (the old avatars
      bucket's rules, now enforced in files.setAvatar) so a refusal is caught
      before any bytes move. bc022c2's bytes-first/rows-first ceremony
      collapses server-side: row-swap and old-byte delete commit atomically. */
  setAvatar: withUpdateBlock(async (profileId: string, file: File, shownAvatar: string | null) => {
    // the picture on screen when the person picked the file
    const expected = { avatar_storage_id: shownAvatar as Id<'_storage'> | null }
    const type = (file.type || '').toLowerCase().split(';')[0].trim()
    if (!(AVATAR_TYPES as readonly string[]).includes(type)) {
      return 'A picture has to be a PNG, JPEG, WebP or GIF'
    }
    // scaled to 256px and re-encoded to WebP before it leaves the browser:
    // an avatar is fetched on nearly every screen, so the bytes matter more
    // here than anywhere else in the app
    const small = await avatarImage(file)
    if (small.size > LIMITS.avatarSize.max * MIB) return limitSentence(LIMITS.avatarSize)
    try {
      const url = await sendAwaited(
        api.files.avatarUploadUrl,
        { profile_id: profileId, size: small.size },
        'none',
      )
      // the POST's Content-Type is also what the server's allowlist checks
      const posted = await postUpload(url, small)
      if ('refused' in posted) return asSentence(posted.refused)
      if ('unanswered' in posted) {
        cancelDemoReservation(url)
        return UPLOAD_NOT_FINISHED
      }
      const stored = posted.storageId as Id<'_storage'>
      // the accepted portrait paints until a delivery holds it; a rebuild
      // prunes and revokes the replaced portrait source
      await sendAwaited(
        api.files.setAvatar,
        { profile_id: profileId, storage_id: stored, expected },
        'none',
        {
          keep: () => ({
            workspace: () => {
              const live = rows.profiles.get(profileId)
              if (live) live.avatar_storage_id = stored
            },
          }),
        },
      )
    } catch (e) {
      console.error('[qivo] avatar upload failed:', e)
      return avatarErrorText(e, "Couldn't set that picture")
    }
    return null
  }),

  /** Drop the uploaded picture `shownAvatar`, the one the page showed. The
      person falls back to their initials, or to their sample portrait in the
      demo. */
  clearAvatar: async (profileId: string, shownAvatar: string | null) => {
    if (!shownAvatar) return null
    try {
      const expected = { avatar_storage_id: shownAvatar as Id<'_storage'> }
      await sendAwaited(api.files.clearAvatar, { profile_id: profileId, expected }, 'none', {
        keep: () => ({
          workspace: () => {
            const live = rows.profiles.get(profileId)
            if (live) live.avatar_storage_id = undefined
          },
        }),
      })
    } catch (e) {
      console.error('[qivo] avatar clear failed:', e)
      return avatarErrorText(e, "Couldn't remove that picture")
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
     the avatar bytes, so there is no client-side reap. `shown` is the
     person's organization as the page showed it, which the removal goes to
     whether or not the store holds the person; the store paints only where
     it does. The server refuses the last admin over the whole organization
     (assertNotLastAdmin). Resolves whether the server accepted it. */
  removeUser: (id: string, shown: { orgId: string }): Promise<boolean> => {
    if (id === CURRENT_USER) return Promise.resolve(false)
    // removal only takes access away, so it goes on while edits are paused,
    // unless every seat is gone
    if (refusePausedWrite(api.profiles.remove)) return Promise.resolve(false)
    const at = new Date().toISOString()
    const view: View = {
      workspace: () => {
        const named = rows.issues.where(
          (i) =>
            i.assignee_id === id ||
            i.reviewer_id === id ||
            i.reporter_id === id ||
            i.created_by === id,
        )
        for (const i of named) {
          if (i.assignee_id === id) i.assignee_id = undefined
          if (i.reviewer_id === id) i.reviewer_id = undefined
          if (i.reporter_id === id) i.reporter_id = undefined
          if (i.created_by === id) i.created_by = undefined
          i.updated_at = at
        }
        workspaceRows.keepList('teamMembers', (m) => m.profile_id !== id)
        workspaceRows.keepList('access', (a) => a.profile_id !== id)
        for (const p of rows.projects.where((x) => x.lead_id === id)) p.lead_id = undefined
        rows.profiles.delete(id)
      },
    }
    return send(api.profiles.remove, { org_id: shown.orgId, id }, rows.profiles.has(id) ? view : {})
  },

  /* Roles are viewer / user / lead; exactly one lead per project (the
     Lead field). Promoting someone hands the lead over and steps the old
     lead down to user, through updateProject, one mutation for grants and
     lead. Any other level is one grant, sent alone (projects.setAccess), so
     a page loaded before someone else changed access cannot undo that
     change. Removing access goes through the removal window
     (PLANNER.removeAccess). `shown` is what a page that read the project
     from the server showed (GrantShown): the person's grant level there
     and the project's own lead. The write then decides and checks from it,
     never from the workspace, goes to its organization, and paints only
     where the workspace holds the project. */
  setProjectAccess: (
    metaId: string,
    userId: string,
    role: AccessLevel,
    shown?: GrantShown,
  ): Promise<boolean> => {
    const m = PLANNER.projects.find((p) => p.id === metaId)
    const row = rows.projects.get(metaId)
    if (!shown && (!m || !row)) return Promise.resolve(false)
    const lead = shown ? shown.leadId : (m?.lead ?? null)
    // a handover: the server keeps the outgoing lead as User
    // (convex/lib/projectGrants.ts grantsAfterHandover)
    if (role === 'lead') {
      if (lead === userId) return Promise.resolve(true)
      return shown
        ? PLANNER.updateProject(metaId, { lead: userId }, { seen: { lead_id: lead } }, shown)
        : PLANNER.updateProject(metaId, { lead: userId })
    }
    // the lead's access is the Lead field: hand it over first
    if (lead === userId || refusePausedEdit()) return Promise.resolve(false)
    const level = shown
      ? shown.level
      : (rows.access.find((a) => a.project_id === metaId && a.profile_id === userId)?.level ?? null)
    if (level === role) return Promise.resolve(true)
    const view: View = {
      workspace: () => {
        if (!rows.projects.has(metaId) || !rows.profiles.has(userId)) return
        const live = rows.access.find((a) => a.project_id === metaId && a.profile_id === userId)
        if (live) live.level = role
        else rows.access.push({ project_id: metaId, profile_id: userId, level: role })
      },
    }
    // the level on screen, none included, so a change made meanwhile refuses
    return send(
      api.projects.setAccess,
      {
        org_id: shown?.orgId ?? row?.org_id ?? '',
        id: metaId,
        user_id: userId,
        level: role,
        expected: { level },
      },
      row ? view : {},
    )
  },

  /* One team's level on a project, sent alone like setProjectAccess, with
     `shown` as setProjectAccess takes it (its lead unread). */
  setProjectTeamAccess: (
    metaId: string,
    teamId: string,
    role: TeamAccessLevel,
    shown?: Omit<GrantShown, 'leadId'>,
  ): Promise<boolean> => {
    const row = rows.projects.get(metaId)
    if ((!row && !shown) || refusePausedEdit()) return Promise.resolve(false)
    const level = shown
      ? shown.level
      : (rows.teamAccess.find((a) => a.project_id === metaId && a.team_id === teamId)?.level ??
        null)
    if (level === role) return Promise.resolve(true)
    const view: View = {
      workspace: () => {
        if (!rows.projects.has(metaId) || !rows.teams.has(teamId)) return
        const live = rows.teamAccess.find((a) => a.project_id === metaId && a.team_id === teamId)
        if (live) live.level = role
        else rows.teamAccess.push({ project_id: metaId, team_id: teamId, level: role })
      },
    }
    return send(
      api.projects.setAccess,
      {
        org_id: shown?.orgId ?? row?.org_id ?? '',
        id: metaId,
        team_id: teamId,
        level: role,
        expected: { level },
      },
      row ? view : {},
    )
  },

  /** Moves milestone `id` to week `week`, as a flag's drag does. `seen` is
      the milestone as the flag showed it, its stored name and day from the
      answer it came from; updateMilestone sends only the fields it
      changes, so the move's expected value is the day in `seen`. Without
      it the row on screen gives it. */
  setMilestone: (id: string, week: number, seen?: { name: string; week: string }) => {
    void PLANNER.updateMilestone(id, { week }, seen)
  },

  /* Milestones sit on a project's roadmap (0078). The caller passes the meta
     project; a sub-project id is folded up to it. Paints the milestone at
     once and resolves whether the server created it: false without sending
     when it refused the change first (toasted), and false after a refusal,
     which is toasted and taken back. */
  addMilestone: (m: { project: string; name: string; week: number }): Promise<boolean> => {
    const meta = PLANNER.metaOf(m.project)
    if (!meta || refusePausedEdit()) return Promise.resolve(false)
    const uuid = crypto.randomUUID()
    const week = weekToISO(m.week)
    const milestone: Row<'milestones'> = {
      id: uuid,
      project_id: meta.id,
      name: m.name,
      week,
      created_at: new Date().toISOString(),
    }
    // every milestone read that would answer it, in its place
    const view: View = {
      milestones: milestonePaint({ ids: [uuid], rows: [milestone] }, () =>
        milestoneRows.insert(milestone),
      ),
    }
    return (
      recordRoadmapChange(
        { kind: 'milestone_create', id: uuid, project_id: meta.id, name: m.name, week },
        view,
      ) ??
      send(
        api.projects.addMilestone,
        { org_id: meta.org, id: uuid, project_id: meta.id, name: m.name, week },
        view,
      )
    )
  },

  /** Paints the change at once and resolves whether the server saved it.
      Resolves false without sending when it refused the change first
      (toasted), or when the milestone or its organization is not known here:
      the row comes from a milestone read (milestoneOnScreen), and the
      organization from a `get` answer, else the project's (milestoneOrg).
      Resolves false after a refusal, which is toasted and taken back.
      `seen` is the milestone as an editor showed it when opened, which goes
      out as the expected values, and `keepDraft` runs when the server
      refuses because someone changed it first (SendOptions). The paint
      changes every copy a milestone read holds, and adds the changed row
      to a read it now belongs to from a copy another read shows; it skips
      while no read shows the milestone (store/milestoneRows.ts update). */
  updateMilestone: (
    id: string,
    patch: { name?: string; week?: number },
    seen?: { name: string; week: string },
    keepDraft?: () => boolean,
  ): Promise<boolean> => {
    const row = milestoneOnScreen(id)
    const org = row ? milestoneOrg(row) : ''
    if (!row || !org) return Promise.resolve(false)
    const db: FunctionArgs<typeof api.projects.updateMilestone>['patch'] = {}
    // only what differs from what the person saw goes out: a rename alone
    // leaves the date as stored, and neither undoes a change made meanwhile.
    // The week compares as the week shown, so a stored day off the week grid
    // stays unless the person picks another week.
    const shown = seen ?? row
    if ('name' in patch && (patch.name ?? '').trim() !== shown.name.trim()) db.name = patch.name
    if (patch.week != null && patch.week !== isoToWeek(shown.week)) db.week = weekToISO(patch.week)
    if (!Object.keys(db).length) return Promise.resolve(true)
    if (refusePausedEdit()) return Promise.resolve(false)
    if ('name' in patch && refuseOver(LIMITS.milestoneName, patch.name ?? ''))
      return Promise.resolve(false)
    const fields = { ...db }
    // every copy, each read keeping its rows where the server would
    const view: View = {
      milestones: milestonePaint({ ids: [id], rows: [{ ...row, ...fields }] }, () =>
        milestoneRows.update(id, fields),
      ),
    }
    // moved/renamed verb logic is server-side now (it diffs against its row)
    const over = overOf('milestones', row, Object.keys(db), seen)
    return (
      recordRoadmapChange({ kind: 'milestone_update', id, patch: db }, view, over, keepDraft) ??
      send(api.projects.updateMilestone, { org_id: org, id, patch: db }, view, { over, keepDraft })
    )
  },

  /** Removes the milestone from every milestone read at once, and resolves
      whether the server deleted it, as updateMilestone does, with its row
      and organization found as there.
      `seen` is the milestone as an editor showed it, the values the delete
      is checked against. */
  removeMilestone: (id: string, seen?: { name: string; week: string }): Promise<boolean> => {
    const row = milestoneOnScreen(id)
    const org = row ? milestoneOrg(row) : ''
    if (!row || !org || refusePausedEdit()) return Promise.resolve(false)
    const view: View = {
      milestones: milestonePaint({ ids: [id] }, () => milestoneRows.hide(id)),
    }
    // what an editor showed, which may be older than the row on screen
    const over = overOf('milestones', row, ['name', 'week'], seen)
    return (
      recordRoadmapChange({ kind: 'milestone_remove', id }, view, over) ??
      send(api.projects.removeMilestone, { org_id: org, id }, view, {
        over,
        notice: { deletes: true },
      })
    )
  },

  /* --- labels: one shared, curated list per organization (0078) ------------ */
  /** Paints a new label of the home organization at once. Returns its id,
      its color and whether the server created it. Null when it refused the
      change first (toasted) or there is nothing to create. A name over
      LIMITS.labelName is refused with its sentence before anything else.
      It reads no catalogue: the label picker and Settings › Labels call it
      only once the server's `exact` said no label of that name exists, or
      after that read failed, and the server refuses a name another label
      holds in any case, which is toasted and taken back (a toggle that
      follows it is refused with it, toggleIssueLabel `created`). The color
      comes from the new id (labelColorFor) unless `rec.color` gives one. */
  addLabel: (rec: {
    name?: string
    color?: string
  }): { id: string; color: string; saved: Promise<boolean> } | null => {
    const name = (rec.name || '').trim()
    const org = homeRow()
    if (!name || !org || refuseOver(LIMITS.labelName, name)) return null
    // paused first, so a paused create never reads as done
    if (refusePausedEdit()) return null
    const uuid = crypto.randomUUID()
    const color = rec.color || labelColorFor(uuid)
    const label: Row<'labels'> = {
      id: uuid,
      org_id: org.id,
      name,
      name_lower: name.toLowerCase(),
      color,
      created_at: new Date().toISOString(),
    }
    const view: View = {
      workspace: () => {
        if (!rows.labels.has(uuid)) rows.labels.set(uuid, { ...label })
      },
    }
    return {
      id: uuid,
      color,
      saved: send(api.labels.create, { org_id: org.id, id: uuid, name, color }, view),
    }
  },

  /** Renames or recolors label `id` as the page showed it (`shown`,
      LabelShown). Returns false when nothing was written, either refused
      with a toast or already as shown, so an inline editor can keep or put
      back its text, else the write's promise, which resolves whether the
      server accepted it, so a page that shows a label the store does not
      hold takes the new name or color as saved only then. It goes to the
      organization the page showed, with the name and color the row showed
      as `expected`, the draft's `save.seen` over them, whether or not the
      store holds the label, and paints only where it does. The server
      refuses a name another label holds, in any case, and a refusal keeps
      the draft. */
  updateLabel: (
    id: string,
    patch: { name?: string; color?: string },
    save: FieldSave,
    shown: LabelShown,
  ): Promise<boolean> | false => {
    if (refusePausedEdit()) return false
    const wire: FunctionArgs<typeof api.labels.update>['patch'] = {}
    if ('name' in patch) {
      const name = (patch.name || '').trim()
      if (!name || refuseOver(LIMITS.labelName, name)) return false
      if (name !== shown.name) wire.name = name
    }
    if ('color' in patch && patch.color?.toLowerCase() !== shown.color.toLowerCase())
      wire.color = patch.color
    if (!Object.keys(wire).length) return false
    const view: View = {
      workspace: () => {
        const live = rows.labels.get(id)
        if (!live) return
        Object.assign(live, wire)
        if (wire.name !== undefined) live.name_lower = wire.name.toLowerCase()
      },
    }
    return send(
      api.labels.update,
      { org_id: shown.orgId, id, patch: wire },
      rows.labels.has(id) ? view : {},
      {
        over: overOf('labels', { id }, Object.keys(wire), {
          name: shown.name,
          color: shown.color,
          ...save.seen,
        }),
        ...fieldSendOptions(save),
      },
    )
  },

  /** Deletes label `id` as the page showed it (`shown`, LabelShown): to its
      organization, with the name and color the page showed as `expected`,
      whether or not the store holds the label, which it takes off the
      screen at once where it does. Resolves whether the server deleted it:
      false without sending when it refused the change first (toasted), and
      false after a refusal, which is toasted and taken back. */
  removeLabel: (id: string, shown: LabelShown): Promise<boolean> => {
    if (refusePausedEdit()) return Promise.resolve(false)
    // the attach rows go with the label server-side — mirror the sweep
    const view: View = {
      workspace: () => {
        workspaceRows.keepList('issueLabels', (il) => il.label_id !== id)
        rows.labels.delete(id)
      },
    }
    return send(api.labels.remove, { org_id: shown.orgId, id }, rows.labels.has(id) ? view : {}, {
      over: overOf('labels', { id }, ['name', 'color'], {
        name: shown.name,
        color: shown.color,
      }),
      notice: { deletes: true },
    })
  },

  /** Puts the label on the task or takes it off. `created` is the `saved`
      answer of an addLabel this toggle follows: when the server refuses
      that create, it refuses the toggle too, and only the create's refusal
      is toasted. The workspace need not hold the label, such as one the
      picker's batch or labels.byIds named: the server checks that it is
      one of the task's organization (labels.toggle), and a refusal takes
      the paint back with its toast. A label deleted meanwhile is refused
      as another organization's is, which the toast says as "This label no
      longer exists.", after which labelGone says so. */
  toggleIssueLabel: (issueId: string, labelId: string, created?: Promise<boolean>) => {
    const uuid = keyToUuid.get(issueId)
    const issue = uuid ? rows.issues.get(uuid) : null
    if (!uuid || !issue) {
      // the task the window shows from its own answer
      const shown = answerTaskOf(issueId)
      if (shown) toggleAnswerLabel(shown, labelId, created)
      return
    }
    if (refusePausedEdit()) return
    // the state asked for travels with the write (`on`), so the paint and
    // the server set it, and a repeat changes nothing
    const on = !rows.issueLabels.some((il) => il.issue_id === uuid && il.label_id === labelId)
    const full = on && labelBlock(rows.issueLabels.filter((il) => il.issue_id === uuid))
    if (full) {
      toast(full)
      return
    }
    const view: View = { workspace: labelRowsPaint(uuid, labelId, on, issue.org_id) }
    void send(
      api.labels.toggle,
      { org_id: issue.org_id, issue_id: uuid, label_id: labelId, on },
      view,
      { onError: labelToggleRefused(labelId, created) },
    )
  },

  /** Whether the server refused a toggle of label `id` because the label
      no longer exists in the task's organization (toggleIssueLabel), so a
      label picker drops it from a batch it read before the delete. */
  labelGone: (id: string) => goneLabels.has(id),

  /* Each open subscriber popover owns its reactive roster; the shared
     snapshot continues to own the current user's eye indicator. The
     popover passes the task's model, the workspace's or the window's from
     its own answer, whose organization and uuid the roster takes; a handle
     names a task the workspace holds. */
  watchIssueSubscribers: (
    issueId: IssueVM | string,
    onChange: (value: IssueSubscribers) => void,
    onError: () => void,
  ): (() => void) => {
    const issue = typeof issueId === 'string' ? PLANNER.issueById[issueId] : issueId
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

  /* Adds or removes another person's follow, for a lead or an admin, on
     the task the popover shows (watchIssueSubscribers), by its
     organization and uuid. */
  setIssueSubscriber: (
    issueId: IssueVM | string,
    profileId: string,
    subscribed: boolean,
    onSettled: () => void,
    onSuccess?: () => void,
  ) => {
    const issue = typeof issueId === 'string' ? PLANNER.issueById[issueId] : issueId
    if (!issue) {
      onSettled()
      return
    }
    void send(
      api.issues.setSubscriber,
      { org_id: issue.org, issue_id: issue.uuid, profile_id: profileId, subscribed },
      'none',
      {
        onOk: () => onSuccess?.(),
        onSettled,
        about: { task: issue.uuid, ...(holdsIn(issue.uuid, issue.org) ? {} : { answer: true }) },
      },
    )
  },

  /* Follow / stop following a task (0114). The server also subscribes users
     when they are assigned, mentioned or comment. */
  setIssueSubscribed: (issueId: string, on: boolean) => {
    const uuid = keyToUuid.get(issueId)
    const row = uuid ? rows.issues.get(uuid) : null
    if (!uuid || !row) {
      // the task the window shows from its own answer, which anyone it
      // shows the task to follows as from a held task
      const shown = answerTaskOf(issueId)
      if (shown) followAnswerTask(shown, on)
      return
    }
    // `me` is resolved per ORG: one human is several profiles (0081), and
    // following a task in a guest org must write that seat's id
    const me = profileIn(row.org_id)
    if (!me) return
    const has = workspaceRows
      .peekList('issueSubs')
      .some((s) => s.issue_id === uuid && s.profile_id === me)
    if (has === on) return // already in the asked-for state
    if (refusePausedWrite(on ? api.issues.subscribe : api.issues.unsubscribe)) return
    const at = new Date().toISOString()
    const view: View = { workspace: followRowsPaint(uuid, me, on, at, row.org_id) }
    void send(
      on ? api.issues.subscribe : api.issues.unsubscribe,
      { org_id: row.org_id, issue_id: uuid },
      view,
    )
  },

  /** Signs out and reloads, or leaves the demo. Work that is not saved is
      never dropped behind the person's back: while a change waits for the
      server or a field holds typed text, the first press says what would be
      lost, and only a second press within SIGN_OUT_CONFIRM_MS goes ahead,
      without the close warning asking again. Signing out works offline
      too, because it clears the sign-in stored in this browser. When the
      server answers that it could not end the session, the person stays
      signed in and is told to try again (lib/authSession.ts signOut). A
      press while a sign-out runs does nothing. Returns the sign-out request
      when this press started one, for the control to show that it runs. */
  signOut: (): Promise<void> | undefined => {
    const waiting = syncStatus.unconfirmed()
    if ((waiting || hasUnsaved()) && Date.now() - signOutWarnedAt > SIGN_OUT_CONFIRM_MS) {
      signOutWarnedAt = Date.now()
      const what = !waiting
        ? 'Text you typed is not saved'
        : waiting === 1
          ? '1 change is not saved yet'
          : `${waiting} changes are not saved yet`
      const again = DEMO_MODE ? 'Leave demo again to leave' : 'Sign out again to sign out'
      toast(`${what}. Press ${again} and lose ${waiting > 1 ? 'them' : 'it'}.`)
      return
    }
    // a demo can start again in this page, so its warning stays armed
    if (DEMO_MODE) {
      unconfirmedNote.forgetAll()
      clearAvatarSources()
      notifyDemoEnded(new DemoSessionEnded('lost'))
      return
    }
    if (signingOut) return
    signingOut = true
    const leave = () => {
      unconfirmedNote.forgetAll()
      clearAvatarSources()
      leaveDeliberately()
      reloadPage()
    }
    return authSignOut()
      .then(leave, (failure: unknown) => {
        if (failure instanceof SignOutFailed) toast(failure.message)
        else leave()
      })
      .finally(() => {
        signingOut = false
      })
  },
}

/* --- loading --------------------------------------------------------------
   The workspace arrives in live parts (convex/workspace.ts), which the
   registry (store/liveParts.ts) adopts once per Convex transition. Its first
   complete transition settles initStore; every later one that changed a
   part is the new anchor the rows are built from (owe).

   Tasks load on demand. The workspace holds no task until something that
   needs every task asks for them (P.askTasks), a create, and keeps them
   once asked until the store resets (`asked`). The views show the
   server's own answers meanwhile. From the ask until every task window
   answered, the registry's
   reports are partial and carry no task: they repaint the projects, people
   and Inbox, hold no write, and move the share loaded (stillLoading), and
   the store holds only the person's own new tasks. The paint of the
   complete delivery that ends the load holds every task (tasksAll). A task
   load that fails stops only that load (taskTrouble): the rest of the tab
   keeps working, the readers that wait for every task offer Try again
   (P.retryTasks), and writes made meanwhile show as made until the load
   ends. A part that fails after the first is snapshot trouble (see
   snapshot health), and so is a later answer with no seat left, and so is
   a task window that fails once every task arrived. Network drops only
   delay transitions until Convex reconnects and resubscribes. The last
   workspace stays on screen and shared edits pause until a later complete
   transition arrives and reaches the screen. */

/* Whether the server delivered a workspace, never undone by a later answer
   with no seat. Its rows are staged in the base (store/workspaceBase.ts),
   which a repaint applies before it paints every live layer over them, so
   they run ahead of the rows on screen until then. The parts' answers are
   not kept beside it: the base keeps each unchanged row's earlier object. */
let hasSnapshot = false
/* The root part's answer when the boot found no seat it can open, because a
   running organization deletion holds the login's seats or an organization
   deactivated it (convex/lib/workspaceParts.ts readRoot), so AuthGate says
   so and offers a new organization only when the server allows one. */
let bootSeatless: Seatless | null = null
/* While the task windows an ask subscribed are on their way
   (store/liveParts.ts), the share of them that answered, from 0 to 1; null
   before the ask and once every task is held. A partial delivery holds no
   write for certain, since the window a write changed may not have
   arrived, so it is no live good delivery: writes accepted meanwhile stay
   saved until the complete one. No reader shows the share
   (P.taskLoad). */
let stillLoading: number | null = null
/* Whether the complete delivery that ends a task load waits for its
   paint, which sets stillLoading to null and tasksAll true: until then the
   rows on screen hold no task but the person's own new ones. */
let loadEnds = false
/* Whether this store asked for every task (P.askTasks). Every registry it
   starts afterwards subscribes the task windows from the start
   (startParts), after Try again and a new organization's re-init too, and
   only disposeDemoStore and a reload undo it. */
let asked = false
/* Whether the workspace on screen holds every task: set by the boot's first
   delivery and by the paint of a complete delivery that holds them
   (tasksNext), so no reader sees it before the rows are rebuilt. The
   store's checks that read every task held key on it, never on
   stillLoading, which is null before an ask too. */
let tasksAll = false
/* Whether the latest complete delivery holds every task, which its paint
   shows (tasksAll). */
let tasksNext = false

/** What asked for every task (P.askTasks): the scripts and the
    benchmark. A create asks for none (P.addIssue), and the Inbox's search
    asks the server instead (inbox.page). */
export type AskReason = 'script' | 'benchmark'

/** Why a task load stopped while the rest of the workspace stays live:
    the sentence the readers that wait for every task show beside Try
    again, since when, and whether Try again runs (one RETRY_GAP_MS window).
    It is not snapshot trouble, so it pauses no edit. */
export type TaskTrouble = { reason: string; since: number; retrying: boolean }
let taskTrouble: TaskTrouble | null = null
let taskRetryTimer: ReturnType<typeof setTimeout> | null = null

/** Where the load of every task stands (P.taskLoad): not asked, on its way
    with no share, stopped, or done. */
export type TaskLoad =
  | { state: 'not_asked' }
  | { state: 'arriving' }
  | { state: 'failed'; reason: string; retrying: boolean }
  | { state: 'all' }

/* In tests, the reasons P.askTasks was called with, in order, for the
   not-asked suites (__layerProbe.asks). */
const askReasons: AskReason[] = []

/** The sentence a stopped task load shows beside Try again, which says
    that the person's changes show as made until the tasks load; its
    reason (TaskTrouble) says what stopped it. */
export const TASKS_FAILED_TEXT =
  'Tasks did not load. Changes you make show as you made them until they do.'
/* The live parts of the running store, null before boot and after
   disposal. */
let parts: LiveParts | null = null
let cancelDemoBoot: (() => void) | null = null
let stopDayWatch: (() => void) | null = null
/* Try again resubscribes at most once per window; `retrying` lasts it. */
const RETRY_GAP_MS = 5000
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** Whether `error` refuses the demo itself, which ends it with the error as
    the cause the demo gate reads (lib/demoMode.ts notifyDemoEnded). */
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

/** Records snapshot trouble of `kind` after the first delivery. Keeps when
    the trouble began and a running retry. */
function beginTrouble(kind: SnapshotTrouble['kind'], detail: string, reason?: string) {
  snapshotTrouble = {
    kind,
    since: snapshotTrouble?.since ?? Date.now(),
    asOf: lastDeliveryAt,
    retrying: snapshotTrouble?.retrying ?? false,
    detail,
    ...(reason === undefined ? {} : { reason }),
  }
  // a held delivery from before this trouble no longer ends it
  recoveryHeld = false
  emit('health')
}

/** Records a failed snapshot query after the first delivery. A lost sign-in
    (the server's `forbidden('not signed in')`) is `signed_out`; anything
    else is `failed`, except after every seat is gone. A fault says nothing
    about access, so `no_access` holds until a snapshot brings a seat back.
    A part that refused to load says why in a sentence (lib/liveParts.ts),
    which the notice shows as it is, as the load-failed screen does. */
function snapshotFailed(err: unknown) {
  const d = errData(err)
  const signedOut = d.code === 'forbidden' && d.message === 'not signed in'
  if (!signedOut && snapshotTrouble?.kind === 'no_access') return
  if (d.code === 'rule' && d.message) {
    const reason = loadFailureText(err)
    beginTrouble('failed', reason, reason)
    return
  }
  const text = err instanceof Error ? err.message : String(err)
  beginTrouble(
    signedOut ? 'signed_out' : 'failed',
    // Convex appends where the call came from; support needs the rest
    text.replace(/\s*Called by client\s*$/, '').trim(),
  )
}

/** Ends snapshot trouble when a delivery succeeds, and says so. */
function snapshotRecovered() {
  if (!snapshotTrouble) return
  resetSnapshotTrouble()
  toast('Qivo is up to date again.', 'success')
  emit('health')
  reapPausedUploads()
  resumeAfterPause()
}

/* The pause while Qivo cannot save (lib/syncStatus) and its waiting count
   show in the snapshot notice. When it ends, the person hears so, and what
   waited for it goes out: a deferred upload removal, a deferred item's
   second send (resumeAfterPause) and the view preferences a paused save
   kept. */
let savePauseKind: SavePause['kind'] | null = null
syncStatus.subscribe((ended) => {
  if (!PLANNER.loaded) return
  const kind = savePause()?.kind ?? null
  // views read P.editsPaused(), such as the read that opening a task sends
  // once the pause ends; the count alone concerns only the notice
  emit(kind === savePauseKind ? 'health' : 'workspace')
  savePauseKind = kind
  if (!ended) return
  // snapshot trouble can still pause edits, and its notice says why
  const back = ended === 'offline' ? 'Back online.' : 'Saving caught up.'
  toast(snapshotTrouble ? back : `${back} Editing is on again.`, 'success')
  reapPausedUploads()
  resumeAfterPause()
  // after the failed save's own handler, which runs once this one returns
  setTimeout(() => preferences.retry(), 0)
})

/* The side queries' news that came with the boot's transitions, before the
   first workspace settled the boot, the latest of each side, with the
   socket connection its transition arrived on. initStore hands it on once
   the store holds that workspace, except a side a later transition brought
   newer news of, so news held across a reconnect during the boot is not
   current. */
const bootSideNews = new Map<SideName, { news: SideNews; connection: number }>()

/** Starts the workspace's live parts, with the task windows from the start
    once this store asked for every task (`asked`, or TASKS.atBoot in
    tests). With `first`, the first transition that completes or fails the
    workspace settles it (boot); without, every report updates the store (a
    retry's or re-init's fresh parts). A boot that waits for the whole
    workspace takes a stopped task load as a failure, so it ends with a
    visible one. A boot that fails before its first workspace ignores
    everything after. initStore stops those parts, and a later error must
    not report trouble behind the load-failed screen, where the pause would
    refuse the next boot's seat claim. */
function startParts(
  stillCurrent: () => boolean,
  first?: {
    resolve: (snap: Snapshot | null) => void
    reject: (err: unknown) => void
    /** whether the boot waits for the complete workspace, not a partial one */
    whole?: boolean
    /** the task the boot's address names, read with the first parts */
    address?: AddressedTask
  },
): LiveParts {
  let settled = !first
  let bootFailed = false
  // saves pause offline, and a stalled part is no fault while they do
  const online = () => savePause()?.kind !== 'offline'
  if (TASKS.atBoot && !asked) {
    asked = true
    stillLoading ??= 0
  }
  return createLiveParts(
    live,
    (news) => {
      if (!stillCurrent() || bootFailed) return
      // a reconnect shows here first, also while no view read hears
      // transitions, so a side's answer from before it is not current
      latestConnection = Math.max(latestConnection, news.connection)
      const ws = news.workspace
      if (!settled) {
        staleInboxReads()
        for (const name of SIDE_NAMES) {
          const side = news.sides?.[name]
          if (side) bootSideNews.set(name, { news: side, connection: news.connection })
        }
        if (ws.state === 'held') return
        // a boot that waits for the whole workspace shows no partial one,
        // and ends with a failure where the task load stopped
        const failed =
          ws.state === 'failed'
            ? ws.error
            : ws.state === 'partial' && first?.whole
              ? ws.tasksFailed
              : undefined
        if (failed === undefined && ws.state === 'partial' && first?.whole) return
        settled = true
        if (failed !== undefined) {
          bootFailed = true
          if (DEMO_MODE && isDemoLifecycleRefusal(failed)) notifyDemoEnded(failed)
          first?.reject(failed)
          return
        }
        if (ws.state === 'failed') return
        const snap = ws.value && anchor(ws.value)
        hasSnapshot = snap !== null
        bootSeatless = (ws.state === 'complete' && ws.seatless) || null
        // the boot paints this delivery before anything rebuilds
        tasksAll = tasksNext = ws.state === 'complete' && ws.tasks === 'all'
        stillLoading = snap && ws.state === 'partial' ? ws.loaded : null
        loadEnds = false
        if (ws.state === 'partial') noteTaskTrouble(ws.tasksFailed)
        if (snap) {
          if (ws.state !== 'partial') {
            snapshotCurrent = true
            snapshotDeliveries++
          }
          noteDelivery(base.stage(snap), snap)
          tookInbox()
        }
        first?.resolve(snap)
        return
      }
      // the workspace and the side queries of one transition repaint once
      together(() => {
        staleInboxReads()
        receiveWorkspace(ws, news.at)
        for (const name of SIDE_NAMES) {
          const side = news.sides?.[name]
          if (!side) continue
          bootSideNews.delete(name)
          SIDE_NEWS[name](side, news.connection)
        }
      })
    },
    online,
    // a store that asked for every task keeps asking for them
    { ask: asked, ...(first?.address ? { address: first.address } : {}) },
  )
}

/** Takes in the workspace's state after a transition at `at`, past boot. */
function receiveWorkspace(ws: PartsReport['workspace'], at: number) {
  // A part still loading, such as a new seat's organization or a window
  // after a reconnect, holds the workspace: what is on screen stays, and
  // writes accepted meanwhile stay saved until a complete transition.
  if (ws.state === 'held') {
    snapshotCurrent = false
    inboxCurrent = false
    return
  }
  // While the task windows an ask subscribed are on their way, the report
  // holds no task: it repaints the projects, people and Inbox when one of
  // them changed, else only moves the share, says whether the load
  // stopped, and holds no write. A workspace that held every task never
  // shrinks to one without them: fresh parts after Try again hold it, as a
  // held transition does.
  if (ws.state === 'partial') {
    snapshotCurrent = false
    if (stillLoading === null) {
      inboxCurrent = false
      return
    }
    stillLoading = ws.loaded
    const troubled = noteTaskTrouble(ws.tasksFailed)
    subscribeWaitingThread()
    if (ws.changed) {
      const snap = anchor(ws.value)
      noteDelivery(base.stage(snap), snap)
      owe('workspace')
    } else if (troubled) emit()
    tookInbox()
    return
  }
  if (ws.state === 'failed') {
    // Convex keeps the subscription and reruns the failed part when the data
    // it read changes, and a later complete transition ends the trouble.
    const demoEnded = DEMO_MODE && isDemoLifecycleRefusal(ws.error)
    if (demoEnded) notifyDemoEnded(ws.error)
    console.error('[qivo] workspace part failed:', ws.error)
    snapshotCurrent = false
    inboxCurrent = false
    if (!demoEnded) snapshotFailed(ws.error)
    return
  }
  // No seat left means every seat vanished mid-session. The last workspace
  // stays on screen and stays the anchor, so a refused edit still takes
  // only its own paint away, and the notice says access ended. A
  // recovering delivery not painted yet ends no trouble now.
  if (ws.value === null) {
    snapshotCurrent = false
    inboxCurrent = false
    if (DEMO_MODE) {
      recoveryHeld = false
      notifyDemoEnded()
    } else beginTrouble('no_access', '', ws.seatless?.deleting ? ORG_DELETING_TEXT : undefined)
    return
  }
  hasSnapshot = true
  snapshotCurrent = true
  snapshotDeliveries++
  // the repaint that paints this delivery ends the load (repaint), and
  // shows every task held from then on (tasksAll)
  tasksNext = ws.tasks === 'all'
  const loadedNow = stillLoading !== null && tasksNext
  if (loadedNow) loadEnds = true
  if (tasksNext && taskTrouble) endTaskTrouble()
  if (ws.changed) {
    const snap = anchor(ws.value)
    noteDelivery(base.stage(snap), snap)
  } else lastDeliveryAt = new Date(at).toISOString()
  tookInbox()
  subscribeWaitingThread()
  // a complete transition holds every write accepted before it
  const dropped = layers.dropSaved('workspace')
  // Snapshot trouble ends with the paint of this delivery (endHeldRecovery)
  if (snapshotTrouble) recoveryHeld = true
  if (ws.changed || dropped || recoveryHeld || loadedNow) owe('workspace')
}

/** Try again. Runs the failed parts again from fresh
    subscriptions (Convex never caches a failed run). Does nothing unless the
    workspace failed, and at most once per RETRY_GAP_MS; it cannot cure a
    limit the data itself exceeds. */
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
  // the parts run again have delivered nothing yet
  snapshotCurrent = false
  inboxCurrent = false
  if (parts?.retry()) return
  // nothing failed any more, such as a stall: start every part afresh
  const epoch = storeEpoch
  stopParts()
  parts = startParts(() => epoch === storeEpoch && !demoDisposed)
}

/** Asks for every task, once per store: the registry subscribes every task
    window (store/liveParts.ts askTasks), and the readers that need every
    task wait until they are held. Without a running registry, between
    stopParts and the next startParts, the next one starts with them. A
    create asks for none: it paints the views' rows and its window
    (P.addIssue). In tests it records `reason`. */
function askTasks(reason: AskReason) {
  if (STRICT_LAYERS) askReasons.push(reason)
  if (asked) return
  asked = true
  stillLoading = 0
  parts?.askTasks()
  emit()
}

/** Sets the task load's trouble from a partial report's failure, or ends
    it when the report names none, as when the windows run again after Try
    again. Answers whether it changed. */
function noteTaskTrouble(failed: unknown): boolean {
  if (failed === undefined) {
    if (!taskTrouble) return false
    endTaskTrouble()
    return true
  }
  const reason = loadFailureText(failed)
  if (taskTrouble?.reason === reason) return false
  if (!taskTrouble) console.error('[qivo] task load failed:', failed)
  taskTrouble = {
    reason,
    since: taskTrouble?.since ?? Date.now(),
    retrying: taskTrouble?.retrying ?? false,
  }
  return true
}

/** Forgets the task load's trouble without notifying. */
function endTaskTrouble() {
  taskTrouble = null
  if (taskRetryTimer) clearTimeout(taskRetryTimer)
  taskRetryTimer = null
}

/** Try again for a stopped task load: runs the task windows that failed or
    stayed silent again (store/liveParts.ts retryTasks), at most once per
    RETRY_GAP_MS, or starts every part afresh when none is left to run. The
    rest of the workspace keeps showing meanwhile. */
function retryTasks() {
  const trouble = taskTrouble
  if (!trouble || trouble.retrying) return
  taskTrouble = { ...trouble, retrying: true }
  emit()
  taskRetryTimer = setTimeout(() => {
    taskRetryTimer = null
    if (!taskTrouble?.retrying) return
    taskTrouble = { ...taskTrouble, retrying: false }
    emit()
  }, RETRY_GAP_MS)
  if (parts?.retryTasks()) return
  const epoch = storeEpoch
  stopParts()
  parts = startParts(() => epoch === storeEpoch && !demoDisposed)
}

/** Stops the live parts and the thread, history and sections riding along.
    No thread delivery holds a write accepted after this, so none counts as
    current until the next subscription answers. What the thread, its
    history and the sections delivered stays until the next parts deliver
    again (subscribeWaitingThread). */
function stopParts() {
  parts?.stop()
  parts = null
  threadWatched = null
  historyWatched = null
  for (const side of SECTION_SIDES) sectionsWatched[side] = null
  threadCurrent = false
  detailFresh = false
  // the summary and the item answers held stay, not current, until the
  // next registry's answer arrives
  summaryFresh = false
  itemFresh = false
  staleInboxReads()
  bootSideNews.clear()
  // the reference read runs again on the next registry (syncRefRead)
  refLast = null
}

/** Destroy demo memory before rendering the expired/session-loss screen.
 * Epoch guards prevent late write and file responses repopulating the cache. */
export function disposeDemoStore() {
  if (!DEMO_MODE) return
  storeEpoch++
  demoDisposed = true
  // a bulk Inbox action, and the notice it waits on, end with the store,
  // and a press in the next demo waits on none of this demo's writes
  asking = null
  noticeAnswer?.(false)
  noticeAnswer = null
  PLANNER.inboxBulk = null
  inboxWrites.clear()
  stopToasts.clear()
  inboxMarks.clear()
  PLANNER.inboxMarks = new Map()
  // a Deleted items action and its deferred items' watches end with it too
  PLANNER.deletedAction = null
  stopDeferredWatches()
  stopDayWatch?.()
  stopDayWatch = null
  cancelDemoBoot?.()
  cancelDemoBoot = null
  stopParts()
  resetSnapshotTrouble()
  watchedComments = null
  watchedOrg = null
  commentsSnap = null
  olderComments = []
  dropCommentsGap()
  commentHolds.clear()
  pinnedComments.clear()
  apartComments.clear()
  threadPlaces.clear()
  pressKeep = new Set()
  historyOwners.clear()
  resetHistory()
  sectionOwners.clear()
  resetSections()
  PLANNER.sections = null
  PLANNER.detail = null
  // the next demo's summary and item load afresh, and the rebuild below
  // derives the bulk actions' flags from that
  PLANNER.inboxSummary = { state: 'loading', answer: null, current: false }
  PLANNER.inboxItem = null
  itemRead = null
  itemRerun = false
  itemHold = freeHold()
  summaryFresh = false
  summaryConnection = 0
  itemFresh = false
  itemConnection = 0
  itemAnswers = 0
  acceptedCommentChanges.clear()
  threadStart = false
  earlierLoad = 'idle'
  ++syncWatchEpoch
  stopSyncParts()
  syncFallback = new Map()
  watchedSyncOrg = null
  watchedSyncOwners = ''
  syncPaused = false
  PLANNER.lastComments = new Map()
  PLANNER.lastCommentsCut = []
  pendingRestores.clear()
  inboxCurrent = false
  lastMessageTasks = new Set()
  tookCreates.clear()
  pendingCreates.clear()
  refusedCreates.clear()
  hasSnapshot = false
  stillLoading = null
  loadEnds = false
  // the next demo asks for its own tasks
  asked = false
  tasksAll = false
  tasksNext = false
  endTaskTrouble()
  layers.clear()
  for (const read of viewReads.values()) read.stop?.()
  viewReads.clear()
  viewRows.clear()
  milestoneRows.clear()
  shapedMilestones.clear()
  milestonesTooMany.clear()
  overview.clear()
  viewDelays = new Map()
  boardLookup = null
  ownerLoads.clear()
  owed.workspace = false
  owed.thread = false
  owed.sections = false
  owed.view = false
  if (payTimer) clearTimeout(payTimer)
  payTimer = null
  snapshotDeliveries = 0
  threadDeliveries = 0
  viewDeliveries = 0
  detailDeliveries = 0
  milestoneDeliveries = 0
  threadCurrent = false
  detailFresh = false
  detailConnection = 0
  detailRows = { from: null, task: null }
  drawnAnswer = null
  parentShaped = null
  familyShaped = null
  preferences.dispose(myProfileSet)
  clearAvatarSources()
  // Settings hold only appearance mode here, never image bytes or credentials.
  try {
    localStorage.removeItem('qivo-appearance-mode')
  } catch {
    /* storage unavailable */
  }
  // every row, the server's and the paints'
  workspaceRows.reset()
  rows.comments = new Map()
  rows.threadEvents = []
  hiddenReadMessages = 0
  unexaminedUnread = false
  unexaminedRead = false
  messagesCut = false
  // the demo's seats end with it, and its sign-out is this disposal
  unconfirmedNote.forgetAll()
  unconfirmedReport = null
  HOME_ORG = ''
  CURRENT_USER = ''
  myProfiles.clear()
  myProfileSet.clear()
  tasks.clear()
  committedByOwner.clear()
  agentKeyOrg.clear()
  announcedMessages = null
  lastDeliveryAt = null
  snapshotCurrent = false
  reapAfterPause.clear()
  roadmapVisit = null
  roadmapBatch = null
  roadmapDetailOpen = false
  PLANNER.loaded = false
  PLANNER.commentsLoaded = false
  PLANNER.commentsFailure = 'none'
  PLANNER.historyLoaded = false
  rebuild(new Date(), true)
  emit()
}

/* The tasks the previous live delivery held messages of (noteDelivery). */
let lastMessageTasks: ReadonlySet<string> = new Set()

/* How long a message's commit can trail its created_at. A mutation reads
   the clock when it starts and commits later, so a delivery can carry a
   delivered_at past a message's created_at and still not hold it. A
   message made this close before the previous delivery counts as new. */
const COMMIT_SLACK_MS = 60_000

/* The arrival bookkeeping of live delivery `snap`, once per delivery and
   never on a repaint: the stored messages of tasks that a restore brought
   back, or that newly came into view, raise no desktop notification, and
   new messages do. Once the workspace holds every task, the tasks that
   newly came into view are `newlyVisibleIssueIds`, the tasks it holds that
   the previous delivery did not (base.stage), not the tasks the painted
   rows lacked. Before that no task enters the delivery's rows, so they are
   the tasks with a message in this delivery and none in the previous one,
   as when access returns or a task moves back into view, and the Inbox
   part brings its stored messages back. A message made within
   COMMIT_SLACK_MS before the previous delivery, but whose commit reached
   only this one, still counts as new, so a task's first mention notifies;
   one made earlier than that counts as stored. */
function noteDelivery(newlyVisibleIssueIds: ReadonlySet<string>, snap: Snapshot) {
  const byRows = tasksAll
  const messageTasks = new Set(snap.messages.map((message) => message.issue_id))
  const newly = byRows
    ? newlyVisibleIssueIds
    : new Set([...messageTasks].filter((id) => !lastMessageTasks.has(id)))
  lastMessageTasks = messageTasks
  const arrived = [...pendingRestores.keys()].filter((id) => newly.has(id))
  if (arrived.length > 0) {
    /* A child restore can also surface archived ancestors. Suppress the
       restored tasks and the ancestors that entered with them, so their
       historical messages that are still unread do not trigger desktop
       notifications. Every other task that entered with the delivery, such
       as the rest of the tasks a load brings in the same delivery, keeps
       the rule below, so its new messages still notify. Before every task
       is held no ancestor enters, and the rule below covers their stored
       messages. */
    const parentOf = new Map(snap.issues.map((issue) => [issue.id, issue.parent_id]))
    const restored = new Set<string>()
    for (const id of arrived) {
      for (let at: string | undefined = id; at !== undefined && !restored.has(at); ) {
        if (!newly.has(at)) break
        restored.add(at)
        at = byRows ? (parentOf.get(at) ?? undefined) : undefined
      }
      pendingRestores.delete(id)
    }
    if (announcedMessages !== null) {
      for (const message of snap.messages) {
        if (restored.has(message.issue_id)) announcedMessages.set(message.id, message.woke_at)
      }
    }
  }
  /* A task also enters the working set when access returns or it moves back
     into view, and its stored messages come with it. Those created before the
     previous delivery, less the slack a commit can trail its clock read by,
     raise no desktop notification; newer ones still do. */
  if (announcedMessages !== null && lastDeliveryAt !== null) {
    const storedBefore = Date.parse(lastDeliveryAt) - COMMIT_SLACK_MS
    for (const message of snap.messages) {
      if (
        newly.has(message.issue_id) &&
        Date.parse(message.created_at) <= storedBefore &&
        !announcedMessages.has(message.id)
      )
        announcedMessages.set(message.id, message.woke_at)
    }
  }
  lastDeliveryAt = snap.delivered_at
  announceNewMessages(snap)
}

/* Takes the identity from the server's rows (base). The snapshot says which
   roster rows are mine (myProfileIds), so the blend can be re-keyed on every
   delivery. The HOME pick mirrors the old boot: first non-guest seat, else
   the first seat (guest-only logins have no home org, only a display
   fallback). */
function adoptIdentity() {
  const ids = base.scalars()?.myProfileIds ?? []
  const profById = base.map('profiles')
  myProfiles = new Map()
  myProfileSet.clear()
  const mine: Snapshot['profiles'] = []
  ids.forEach((pid) => {
    const p = profById.get(pid)
    if (!p) return
    myProfiles.set(p.org_id, pid)
    myProfileSet.add(pid)
    mine.push(p)
  })
  const home = mine.find((p) => p.org_role !== 'guest') || mine[0] || null
  HOME_ORG = home && home.org_role !== 'guest' ? home.org_id : ''
  CURRENT_USER = home ? home.id : ''
}

/* Sets the inbox counters from the server's rows (base), as a repaint
   starts; paints change them from there. */
function countInbox() {
  const scalars = base.scalars()
  const messages = base.list('messages')
  // the server's predicate: read rows minus snoozed ones (removeRead's scope)
  const loadedReadCount = messages.filter(
    (message) => message.read_at !== undefined && message.snoozed_until === undefined,
  ).length
  hiddenReadMessages = Math.max(0, (scalars?.readMessageCount ?? loadedReadCount) - loadedReadCount)
  unexaminedUnread = scalars?.unreadTruncated === true
  unexaminedRead = scalars?.readTruncated === true
  messagesCut = scalars?.messagesCut === true
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
  /** `whole` waits for the complete workspace rather than a partial one, as
      a new organization's boot does (P.createOrg): a store that asked for
      every task keeps them on screen until the new workspace arrives with
      every task, and one that never asked settles on the complete
      workspace without tasks. A task load that stops during such a boot
      fails it. `address` is the task the boot's address names under an
      organization's slug (lib/router.ts addressedTask), which the live
      parts read with their first parts, so the window shows it with the
      first paint (store/liveParts.ts). */
  opts?: { whole?: boolean; address?: AddressedTask },
): Promise<{ profileId: string; homeOrg: string } | null> {
  stopDayWatch?.()
  stopDayWatch = null
  clearAvatarSources()
  demoDisposed = false
  bootSeatless = null
  const epoch = storeEpoch
  const stillCurrent = () => epoch === storeEpoch && !demoDisposed
  // AuthGate already had to establish this session before it could render
  // the workspace. Reuse that result on the first boot; retries and callers
  // such as DemoGate omit it and perform their own session read.
  const session = knownSession ?? (await authClient.getSession(NO_QUERY))
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
  if (!DEMO_MODE) await sendAwaited(api.identity.claimMySeats, {}, 'none')
  if (!stillCurrent()) return null
  // Both reads use the post-claim seat set. Preferences resolve the home
  // profile on the server, so they do not wait for the snapshot's roster.
  const bootPreferences = preferences.beginBoot()
  stopParts()
  // the new parts have delivered nothing yet; what shows stays partial, if
  // it is, until their first delivery paints
  snapshotCurrent = false
  inboxCurrent = false
  // New parts start from a clean state; their first complete transition
  // settles the boot, so it never reports recovery from earlier trouble.
  if (snapshotTrouble) {
    resetSnapshotTrouble()
    emit('health')
  }
  let bootParts: LiveParts | null = null
  const first = await new Promise<Snapshot | null>((resolve, reject) => {
    if (DEMO_MODE) cancelDemoBoot = () => resolve(null)
    parts = bootParts = startParts(stillCurrent, {
      resolve,
      reject,
      whole: opts?.whole,
      address: opts?.address,
    })
  }).catch((err: unknown) => {
    // a failed boot keeps no subscription (see startParts)
    if (parts === bootParts) stopParts()
    throw err
  })
  if (epoch === storeEpoch) cancelDemoBoot = null
  if (!stillCurrent()) return null
  if (first === null) {
    // signed in, no seat anywhere — AuthGate's noProfile screen; the next
    // initStore (after createOrg) subscribes afresh
    stopParts()
    return null
  }
  // a thread and its history watched before a re-init ride along with the
  // new parts, and ones watched during the boot hear what the boot's
  // transitions brought, which repaints once
  subscribeWaitingThread()
  const bootNews = [...bootSideNews]
  bootSideNews.clear()
  together(() => {
    for (const [name, side] of bootNews) SIDE_NEWS[name](side.news, side.connection)
  })
  // the rows, with any layer from before a re-init painted over them
  paintRows(true, false)
  syncPictureKeys()
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
  // Changes an earlier page sent and never heard back about, said once. With
  // seats in several organizations, each change says which one.
  void unconfirmedNote.collect(noteScopes()).then((changes) => {
    const several = myProfiles.size > 1
    const text = unconfirmedText(
      changes.map(({ scope, ...change }) => {
        const org = several ? rows.orgs.get(scope.split(':')[0])?.name : undefined
        if (!org) return change
        return change.task
          ? { ...change, task: `${change.task} in ${org}` }
          : { ...change, what: `${change.what} in ${org}` }
      }),
    )
    if (!text || !stillCurrent()) return
    unconfirmedReport = text
    emit('health')
  })
  // While a load of every task is on its way, the first parts and the
  // views' first render are two long tasks; a paint between them keeps
  // each frame shorter.
  if (stillLoading !== null) await afterPaint()
  if (!stillCurrent()) return null
  return { profileId: CURRENT_USER, homeOrg: HOME_ORG }
}

/** Resolves once the browser painted the next frame, or after 100ms in a
    hidden tab, which paints nothing; at once without frames. */
function afterPaint() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') return resolve()
    const timer = setTimeout(resolve, 100)
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(timer)
        resolve()
      }, 0),
    )
  })
}

/** Test builds only (STRICT_LAYERS): refuses a read of the whole task list
    before the workspace holds every task, naming the reader, so a reader
    that needs every task asks for them and waits (P.askTasks,
    P.tasksHeld), and one that does not reads its view's own answer. */
function wholeListRead(what: string) {
  if (!tasksAll)
    throw new Error(
      `${what} was read before every task is held: ask for every task (P.askTasks) and wait for P.tasksHeld(), or read the view's own answer`,
    )
}

/* In test builds P.issues is an accessor that refuses a read before every
   task is held (wholeListRead); rebuild assigns through it. The store's
   own reads go through the task index (tasks.issues()). */
if (STRICT_LAYERS) {
  let shownIssues = PLANNER.issues
  Object.defineProperty(PLANNER, 'issues', {
    get() {
      wholeListRead('P.issues')
      return shownIssues
    },
    set(list: IssueVM[]) {
      shownIssues = list
    },
    enumerable: true,
    configurable: true,
  })
}

export const P = PLANNER

/* The scope description P.scopeInfo answers with (null aside) — the shape
   App threads to every view. Derived after the store so the type can name
   the method's own return. */
export type ScopeInfo = NonNullable<ReturnType<typeof PLANNER.scopeInfo>>

// the design prototype exposed the store as window.PLANNER; keep that hook —
// verify drives (scripts/verify-*.mjs) reach mutations through it directly
window.PLANNER = PLANNER
