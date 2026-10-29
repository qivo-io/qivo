/* Qivo schema.
 *
 * Conventions (each is load-bearing):
 * - Field names stay snake_case. Every ported table keeps its client-generated
 *   uuid `id: v.string()` as THE application key; cross-table refs are uuid
 *   strings, not v.id(). `_id`/`_creationTime` stay internal. The app-key
 *   index is named `by_uuid` — Convex reserves the name `by_id`, so the
 *   design docs' `by_id` could not be used.
 * - Timestamps (`*_at`, `ts`) are ISO-8601 UTC strings; week/date columns
 *   (`start_week`, `end_week`, `due_date`, `week`, `renewal_date`) are
 *   ISO `YYYY-MM-DD` strings. Lexicographic order = time order.
 * - NULLable Postgres columns become v.optional(); NOT NULL DEFAULT columns
 *   stay required (mutations fill them in).
 * - Uniqueness and every CHECK that is not a pure value-set restriction are
 *   mutation-checked (insertUnique / model guards), noted per field below.
 *
 * Deliberate schema choices:
 * - organization_billing merged into organizations as optional `billing`.
 * - 0118 auto-join backend CUT: no org_domains / org_join_blocks /
 *   free_email_domains; profiles keep accepted_at but not
 *   joined_via/joined_at/joined_claim/activated_at.
 * - avatar_path / storage_path replaced by Convex storage ids.
 * - issue_links gains computed pair_key (sorted `min:max`), replacing the
 *   (least, greatest) unique index.
 * - labels gain name_lower for the per-org case-insensitive unique check.
 * - platform tables move from the `private` schema to plain tables reached
 *   only through platform wrappers. (The once-planned recoveryLinks table
 *   died before its first writer: the operator recovery link is captured in
 *   a per-action ref — auth.ts createCaptureAuth — and stored nowhere.)
 */

import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { billingPlanFields, vBillingStatus } from './lib/billingTypes'
import {
  vActivityTarget,
  vAppearanceMode,
  vArchiveState,
  vCredentialAccess,
  vCredentialTable,
  vDeletedItemKind,
  vDeletedItemState,
  vGranteeKind,
  vGrantLevel,
  vImageSource,
  vIssuePriority,
  vIssueStatus,
  vLinkType,
  vMessageKind,
  vNameSource,
  vOrgRemovalPhase,
  vOrgRemovalReason,
  vOrgRole,
  vProfileKind,
  vProjectCreators,
  vProjectType,
  vReachKind,
  vRemovalPhase,
  vRemovedAccessKind,
  vStoredTable,
  vTrashPhase,
  vUsedIdTable,
} from './lib/enums'
import { vPanoramaStatus } from './lib/panorama'
import { vEventFilters, vEventName, vEventOwner } from './lib/taskEvents'
import { vUsageCounts, vUsageMetric } from './lib/usage'

/* `task_archived` on a task's relation rows (links, label assignments, follows
 * and attachments) marks a row that the label search of REST and MCP
 * (lib/core.ts activeLabelNames) skips by index. Only a background step sets
 * it, for a task it finds archived in its own transaction, and that step also
 * sets the task's `relations_marked`. After a restore, other steps clear the
 * marks, and only the one that finds none left while the task is active
 * unsets the flag (model/archiveMarks.ts). Every marked row therefore belongs
 * to a task with relations_marked, a link through at least one end, and the
 * search reads such a task through its own assignments. A row written after
 * the archive, or before marks existed, stays unmarked, and readers filter it
 * as before. Every other reader, the app's workspace parts and billing's
 * storage totals included, sees marked rows like any other. */
const taskArchived = v.optional(v.literal(true))

/* `task_key` on a task's relation rows (label assignments, attachments,
 * follows, and a link's on its source's behalf): the task's window_key, so
 * the app's windows read the rows of their tasks in one range
 * (lib/workspaceParts.ts readTasks). A writer copies it from the task; a
 * task's key never changes once set. Rows stored before keys have none, as
 * their tasks have none, and both sort first, into the first window, until
 * internal/windowKeysBackfill gives the task a key and its rows the same. */
const taskKey = v.optional(v.string())

/* The ten tables whose rows a deleted task or project keeps in deleted_rows
 * (lib/enums.ts STORED_TABLES), defined first so deleted_rows can reuse each
 * one's validator. Convex validates the stored copies against it, so a shape
 * change fails the deploy until they fit. A semantic change does not: restore
 * writes a stored document back unchanged, so a migration or backfill of one
 * of these tables must also walk the deleted_rows rows with that `table`. */
const projectsTable = defineTable({
  id: v.string(),
  org_id: v.string(),
  // Legacy ownership column. New projects and sub-projects are teamless;
  // teams receive permissions through project_team_access.
  team_id: v.optional(v.string()),
  type: vProjectType,
  parent_id: v.optional(v.string()), // parent must be a meta; type/parent/org immutable
  key: v.string(), // ^[A-Z0-9]{1,5}$, unique (org_id, key)
  name: v.string(),
  lead_id: v.optional(v.string()), // same org, never a viewer
  description: v.string(), // LIMITS.projectDescription (lib/limits.ts), trimmed, enforced by model/projects
  sort_order: v.number(),
  num: v.number(), // org-scoped, assigned by counter, immutable
  // Legacy icon and its color: nothing writes or shows them now. Optional
  // so rows written before remain valid.
  icon: v.optional(v.string()),
  icon_color: v.optional(v.string()),
  track_delay: v.boolean(),
  // remaining time a task gets on entering Review; absent = the parent
  // project's value, else DEFAULT_REVIEW_HOURS (2); LIMITS.reviewHours (lib/limits.ts)
  // (999), 0.1 h grain
  review_hours: v.optional(v.number()),
  archived_at: v.optional(v.string()),
  created_at: v.string(),
  // server-owned: where the project sorts in the app's windows
  // (lib/db.ts newWindowKey), set once. Never sent to clients, REST, MCP,
  // webhooks or the export. A project stored before it had one sorts first,
  // in the first window, until internal/windowKeysBackfill gives it one.
  window_key: v.optional(v.string()),
  // The name as name-ordered lists sort and search it (lib/nameKey.ts),
  // server-owned and written with the name. Never sent to clients, REST,
  // MCP, webhooks or the export. A project stored before it had one has none
  // until internal/nameKeysBackfill gives it one, and a restore from Deleted
  // items computes it again from the name (model/deletedItems.ts
  // cleanProject).
  name_key: v.optional(v.string()),
  // Where the project stands in the archive (lib/enums.ts ARCHIVE_STATES),
  // server-owned and derived from archived_at and the parent's archived_at
  // by model/projectNav.ts archiveStateOf: 'live' without archived_at,
  // 'listed' for an archived top-level project or an archived sub-project of
  // a live parent, 'under' for a sub-project archived beneath an archived
  // parent. Every writer of archived_at sets it (model/projects.ts archive
  // and restore), and a restore from Deleted items computes it again
  // (model/deletedItems.ts revealProjects). Never sent to clients, REST,
  // MCP, webhooks or the export. A project stored before it had one has
  // none until internal/navBackfill gives it one; readers wait for
  // org_ready.nav_at.
  archive_state: v.optional(vArchiveState),
})
  .index('by_uuid', ['id'])
  .index('by_org', ['org_id'])
  // A parent's sub-projects, or with parent_id absent the organization's
  // top-level projects, of one archive state in name order, the id breaking
  // ties: the admin Settings list, expanded sub-project lists and the chips
  // of an archived parent.
  .index('by_org_parent_state_name', ['org_id', 'parent_id', 'archive_state', 'name_key', 'id'])
  // The organization's Archived projects entries ('listed') by archive time.
  .index('by_org_state_archived', ['org_id', 'archive_state', 'archived_at'])
  // the app's project windows: a range of window keys (lib/workspaceParts.ts)
  .index('by_org_window', ['org_id', 'window_key'])
  .index('by_org_key', ['org_id', 'key'])
  .index('by_org_num', ['org_id', 'num'])
  .index('by_parent', ['parent_id'])
  // an organization's top-level projects (parent_id absent), which the label
  // write check reads once to tell a meta from a sub-project
  // (lib/access.ts canWriteOrgLabels)
  .index('by_org_parent', ['org_id', 'parent_id'])
  .index('by_team', ['team_id'])
  .index('by_lead', ['lead_id']) // projects_lead_idx — removeProfile's SET NULL
  // The nightly archive pages the live projects (archived_at absent).
  .index('by_archived_org', ['archived_at', 'org_id'])
  // Name search of the directory, Settings and Archived projects, within
  // one organization and archive state.
  .searchIndex('search_name', { searchField: 'name', filterFields: ['org_id', 'archive_state'] })

/* `name_key` on a membership, a grant or a team share is a server-owned copy
 * of its profile's or team's name_key, so a team's members and a project's
 * grants read in name order from one range. The writer of the row copies it,
 * and a rename brings the copies in line, the first NAME_COPIES.inline in
 * its own transaction and the rest in bounded background steps
 * (model/nameKeys.ts, nameCopies.ts), so a copy can trail a rename for a
 * moment but never goes missing. A restore from Deleted items computes it
 * again (model/deletedItems.ts cleanGrant, cleanShare). Never sent to
 * clients, REST, MCP, webhooks or the export. */
const nameCopy = v.optional(v.string())

const projectAccessTable = defineTable({
  project_id: v.string(), // explicit grants may target a project or sub-project
  profile_id: v.string(),
  level: vGrantLevel, // the validator IS project_access_level_ck
  name_key: nameCopy, // the profile's
})
  .index('by_project', ['project_id'])
  .index('by_profile', ['profile_id'])
  .index('by_project_profile', ['project_id', 'profile_id'])
  // a project's user grants in name order
  .index('by_project_name', ['project_id', 'name_key', 'profile_id'])
  // the grants whose copy differs from the person's current key, which a
  // rename brings in line (model/nameKeys.ts staleCopies)
  .index('by_profile_name', ['profile_id', 'name_key'])

const projectTeamAccessTable = defineTable({
  project_id: v.string(), // explicit shares may target a project or sub-project
  team_id: v.string(), // same organization as the project
  level: vGrantLevel,
  name_key: nameCopy, // the team's
})
  .index('by_project', ['project_id'])
  .index('by_team', ['team_id'])
  .index('by_project_team', ['project_id', 'team_id'])
  // a project's team shares in name order
  .index('by_project_name', ['project_id', 'name_key', 'team_id'])
  // the shares a team rename brings in line, as project_access by_profile_name
  .index('by_team_name', ['team_id', 'name_key'])

const issuesTable = defineTable({
  id: v.string(),
  project_id: v.string(), // always a sub-project, never a meta
  org_id: v.string(), // denormalized, pinned from the project, immutable
  num: v.number(), // org-scoped, assigned by counter, immutable
  title: v.string(), // LIMITS.title (lib/limits.ts), trimmed
  // Markdown, LIMITS.description (lib/limits.ts), trimmed; '' for none.
  // Moving to issue_descriptions (below): every writer still sets it until
  // the third release of that move clears it, and readers read the
  // description row, this only for a task without one
  // (scripts/check-task-reads.mjs fails on any other read). Optional for
  // good, because deleted_rows checks its stored copies, which keep the
  // text, against this validator.
  description: v.optional(v.string()),
  status: vIssueStatus,
  priority: vIssuePriority,
  assignee_id: v.optional(v.string()), // same org, active, never a viewer
  // same rule as the assignee (same org, active, never a viewer, Edit+);
  // owns the task while it is In Review (lib/review.ts)
  reviewer_id: v.optional(v.string()),
  // no self-parent, same org, one level of subtasks (lib/limits.ts)
  parent_id: v.optional(v.string()),
  // (start absent) = (end absent), start <= end; dormant while the task has
  // active subtasks, whose leaves give its dates
  start_week: v.optional(v.string()),
  end_week: v.optional(v.string()),
  due_date: v.optional(v.string()),
  remaining_hours: v.optional(v.number()), // >= 0; parents with children have none
  remaining_set_at: v.optional(v.string()), // server-owned; (hours absent) = (stamp absent)
  paused: v.boolean(), // work on hold; never true on a Done or Backlog task
  created_by: v.optional(v.string()), // internal writer audit; absent after profile removal
  reporter_id: v.optional(v.string()), // immutable; project access checked at creation
  done_at: v.optional(v.string()),
  // server-owned review hand-off (lib/review.ts reviewStamp): when the task
  // last entered In Review or went to a different reviewer there; kept into
  // Done, cleared by any other move out, never on a group. A move to another
  // sub-project restarts it, and done_at, at the move (model/issues.ts
  // moveIssueCore).
  review_at: v.optional(v.string()),
  // server-owned: when the status was last set while the task was in its
  // current project. createIssueCore and updateIssueCore stamp it and
  // moveIssueCore clears it (model/issues.ts). Never in the REST or MCP task
  // JSON or a webhook's changed_fields.
  status_at: v.optional(v.string()),
  archived_at: v.optional(v.string()),
  // server-owned: some relation rows of this task may carry task_archived
  // (above). Never sent to clients, REST, MCP, webhooks or the export.
  relations_marked: v.optional(v.literal(true)),
  // server-owned: where the task sorts in the app's windows (lib/db.ts
  // newWindowKey), as projects' window_key above; its relation rows carry
  // it as task_key
  window_key: v.optional(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
})
  .index('by_uuid', ['id'])
  .index('by_org', ['org_id'])
  // The working snapshot and planning reads do not scan archived task bodies.
  .index('by_org_archived', ['org_id', 'archived_at'])
  // the app's task and hidden load windows: a range of active tasks' window
  // keys (lib/workspaceParts.ts)
  .index('by_org_archived_window', ['org_id', 'archived_at', 'window_key'])
  // The nightly archive reads only a live project's Done tasks past the
  // threshold.
  .index('by_project_archived_status_done', ['project_id', 'archived_at', 'status', 'done_at'])
  // The nightly repair finds the organizations with active tasks still
  // flagged relations_marked, and each one's flagged tasks.
  .index('by_archived_marked_org', ['archived_at', 'relations_marked', 'org_id'])
  .index('by_org_num', ['org_id', 'num'])
  .index('by_project', ['project_id'])
  // An access removal reads only the open tasks of the projects it touches.
  .index('by_project_archived', ['project_id', 'archived_at'])
  .index('by_parent', ['parent_id'])
  // The nightly leaf guard asks whether a parent has an unarchived child.
  .index('by_parent_archived', ['parent_id', 'archived_at'])
  // A project's move to Deleted items reads a task's children outside the
  // moving projects through ranges between their ids, so it never reads the
  // children inside, however many there are (model/deletedItems.ts
  // childrenOutside).
  .index('by_parent_project', ['parent_id', 'project_id'])
  // Profile refs for removeProfile's SET NULLs. The removal transaction
  // reads only open tasks (archived_at absent), the background steps the
  // whole range.
  .index('by_assignee_archived', ['assignee_id', 'archived_at'])
  .index('by_reviewer_archived', ['reviewer_id', 'archived_at'])
  // Team sync reads a person's open tasks without their Backlog and Done
  // ones (teamSync.ts lastComments).
  .index('by_assignee_archived_status', ['assignee_id', 'archived_at', 'status'])
  .index('by_reviewer_archived_status', ['reviewer_id', 'archived_at', 'status'])
  .index('by_created_by_archived', ['created_by', 'archived_at'])
  .index('by_reporter_archived', ['reporter_id', 'archived_at'])

// A task is an end of at most LIMITS.links.max links (lib/limits.ts).
const issueLinksTable = defineTable({
  org_id: v.string(),
  id: v.string(),
  source_id: v.string(), // source <> target; 'relates' stored with source < target
  target_id: v.string(),
  type: vLinkType,
  // sorted `${min(source,target)}:${max(...)}` — at most one link per pair,
  // unique-checked on by_pair (replaces the (least, greatest) unique index)
  pair_key: v.string(),
  created_at: v.string(),
  task_archived: taskArchived,
  task_key: taskKey, // the source's
})
  // The archive steps' reads of one end's unmarked or marked rows.
  .index('by_org_task_archived_source', ['org_id', 'task_archived', 'source_id'])
  // the app's windows: the unmarked links from a range of window keys
  .index('by_org_task_archived_key', ['org_id', 'task_archived', 'task_key'])
  .index('by_org_task_archived_target', ['org_id', 'task_archived', 'target_id'])
  .index('by_uuid', ['id'])
  .index('by_source', ['source_id'])
  .index('by_target', ['target_id'])
  .index('by_pair', ['pair_key'])

// A task carries at most LIMITS.labels.max labels (lib/limits.ts).
const issueLabelsTable = defineTable({
  org_id: v.string(),
  issue_id: v.string(), // label and issue must share an org
  label_id: v.string(),
  task_archived: taskArchived,
  task_key: taskKey,
})
  .index('by_org_task_archived_issue', ['org_id', 'task_archived', 'issue_id'])
  // the app's windows: the unmarked rows of a range of window keys
  .index('by_org_task_archived_key', ['org_id', 'task_archived', 'task_key'])
  .index('by_issue', ['issue_id'])
  // a label's assignments; REST and MCP search read only its unmarked ones
  .index('by_label', ['label_id', 'task_archived'])
  .index('by_issue_label', ['issue_id', 'label_id'])

const issueSubscriptionsTable = defineTable({
  issue_id: v.string(),
  profile_id: v.string(), // recipient must be able to see the project
  created_at: v.string(),
  task_archived: taskArchived,
  task_key: taskKey,
})
  // a task's follows, and the archive steps' unmarked or marked ones
  .index('by_issue_task_archived', ['issue_id', 'task_archived'])
  // one person's unmarked follows; profile cleanup takes the whole profile
  // range
  .index('by_profile_task_archived', ['profile_id', 'task_archived'])
  // one person's unmarked follows of a range of window keys (the app's windows)
  .index('by_profile_task_archived_key', ['profile_id', 'task_archived', 'task_key'])
  .index('by_issue_profile', ['issue_id', 'profile_id'])

// A task holds at most LIMITS.attachments.max rows (lib/limits.ts) without a
// dropped_at, and at most DROPPED_IMAGES_MAX with one (model/descriptionImages.ts).
// A row names no project. The billing sample reads it through its task
// (model/billing.ts storagePage), and the stored-byte totals through its
// task's storage_task_totals row, so a move writes no attachment row.
const issueAttachmentsTable = defineTable({
  org_id: v.string(),
  id: v.string(),
  issue_id: v.string(),
  name: v.string(),
  size_bytes: v.number(), // copied from _storage metadata in attach, never client-sent
  mime: v.optional(v.string()),
  storage_id: v.id('_storage'), // replaces storage_path
  inline: v.boolean(),
  uploaded_by: v.optional(v.string()),
  created_at: v.string(),
  task_archived: taskArchived,
  task_key: taskKey,
  // When a description save took this image out of the description
  // (model/descriptionImages.ts settleDescriptionImages). It no longer counts
  // toward LIMITS.attachments.max, and a save that shows it again within a day
  // brings it back; after that it is deleted with its bytes.
  dropped_at: v.optional(v.string()),
})
  .index('by_org_task_archived_issue', ['org_id', 'task_archived', 'issue_id'])
  // the app's windows: the unmarked rows of a range of window keys
  .index('by_org_task_archived_key', ['org_id', 'task_archived', 'task_key'])
  // An organization's rows in the order they were stored. Archiving a task
  // moves its rows within by_org_task_archived_issue but not here, so the
  // billing storage sample pages through this one (model/billing.ts
  // storagePage) and leaves out the rows stored after the period began.
  .index('by_org', ['org_id'])
  .index('by_uuid', ['id'])
  .index('by_issue', ['issue_id'])
  // the rows that count toward LIMITS.attachments.max are those without dropped_at
  .index('by_issue_dropped', ['issue_id', 'dropped_at'])
  .index('by_storage', ['storage_id'])
  .index('by_uploaded_by', ['uploaded_by']) // removeProfile's SET NULL

const milestonesTable = defineTable({
  id: v.string(),
  project_id: v.string(), // writes store a top-level project (model/milestones.ts)
  name: v.string(),
  // YYYY-MM-DD calendar day, usually the first day of its week. A top-level
  // project holds at most one milestone in each calendar week of its
  // organization (LIMITS.milestonesPerWeek), mutation-checked by
  // model/milestones.ts assertWeekFree; internal/milestoneWeeks reports
  // rows stored before the rule that break it.
  week: v.string(),
  created_at: v.string(),
})
  .index('by_uuid', ['id'])
  .index('by_project', ['project_id'])
  // one project's milestones in day order: a write reads the days of one
  // week (model/milestones.ts assertWeekFree), a change of the first day of
  // the week reads each project's whole range (assertWeekStartFits), and
  // the app's milestone reads (milestones.ts section and between) merge the
  // ranges of the projects they list a day at a time (readMilestones)
  .index('by_project_week', ['project_id', 'week'])

const commentsTable = defineTable({
  id: v.string(),
  issue_id: v.string(),
  author: v.optional(v.string()),
  body: v.string(),
  created_at: v.string(), // shares its instant with the comment's inbox message (0111)
  edited_at: v.optional(v.string()),
  edited_by: v.optional(v.string()),
})
  .index('by_uuid', ['id'])
  .index('by_issue', ['issue_id'])
  // comments_author_idx / comments_edited_by_idx — removeProfile's SET NULLs
  .index('by_author', ['author'])
  .index('by_edited_by', ['edited_by'])

export default defineSchema({
  // Durable ownership for public demo copies. This outlives profiles and
  // authentication while a bounded purge drains their remaining files.
  demo_sessions: defineTable({
    id: v.string(),
    auth_user_id: v.string(),
    org_id: v.optional(v.string()),
    created_at: v.number(),
    expires_at: v.number(),
    status: v.union(v.literal('unprovisioned'), v.literal('ready'), v.literal('deleting')),
    seed_version: v.optional(v.number()),
    anchor: v.optional(v.string()),
    // Set while ensureMine builds the demo one bounded call at a time
    // (model/demoSeed.ts provisionPublicDemoStep): the next call, the write
    // time every call shares and the call layout it started with.
    provision: v.optional(v.object({ step: v.number(), now: v.string(), layout: v.string() })),
    expiry_scheduled_id: v.optional(v.id('_scheduled_functions')),
    cleanup_phase: v.optional(v.string()),
    cleanup_parent: v.optional(v.string()),
    cleanup_progress_at: v.optional(v.number()),
    cleanup_scheduled_id: v.optional(v.id('_scheduled_functions')),
    cleanup_file_after: v.optional(v.number()),
    // No longer written: the purge now waits for checkStoredFiles instead of
    // paging every stored file. Remove once no receipt holds one.
    cleanup_file_cursor: v.optional(v.string()),
    cleanup_file_wait_until: v.optional(v.number()),
    // Counters a receipt kept before demo_write_counts. New writes count
    // there, starting from these (lib/demo.ts demoCounts).
    write_window_at: v.optional(v.number()),
    write_window_count: v.optional(v.number()),
    write_count: v.optional(v.number()),
    insert_count: v.optional(v.number()),
    metrics_counted_at: v.optional(v.number()),
    visitor_browser: v.optional(v.string()),
    visitor_os: v.optional(v.string()),
    // No longer written. Earlier receipts with a country are purged with
    // their demo; remove the field once none remain.
    visitor_country: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_org', ['org_id'])
    .index('by_expiry', ['expires_at'])
    .index('by_status_progress', ['status', 'cleanup_progress_at'])
    .index('by_status_expiry', ['status', 'expires_at']),

  // A public demo's write and insert counters (lib/demo.ts), one row per
  // demo_sessions receipt, kept apart so that counting a write does not
  // change the receipt every call reads. The purge deletes it with the
  // receipt.
  demo_write_counts: defineTable({
    demo_id: v.string(),
    write_window_at: v.optional(v.number()),
    write_window_count: v.optional(v.number()),
    write_count: v.optional(v.number()),
    insert_count: v.optional(v.number()),
  }).index('by_demo', ['demo_id']),

  // Demo uploads reserve capacity before bytes are accepted. Kept after
  // attachment so ownership is independent of editable planning records.
  demo_uploads: defineTable({
    id: v.string(),
    demo_id: v.string(),
    auth_user_id: v.string(),
    kind: v.union(
      v.literal('attachment'),
      v.literal('avatar'),
      v.literal('background'),
      v.literal('preview'),
    ),
    target_id: v.string(),
    expires_at: v.number(),
    reserved_bytes: v.number(),
    state: v.union(v.literal('pending'), v.literal('receiving'), v.literal('stored')),
    lease_until: v.optional(v.number()),
    started_at: v.optional(v.number()),
    storage_id: v.optional(v.id('_storage')),
  })
    .index('by_uuid', ['id'])
    .index('by_demo', ['demo_id'])
    .index('by_storage', ['storage_id'])
    .index('by_state_started', ['state', 'started_at'])
    .index('by_state_lease', ['state', 'lease_until'])
    .index('by_expiry', ['expires_at']),

  // At most one row: how far the demo upload recovery and the demo purge have
  // checked stored files (model/demoUploads.ts checkStoredFiles). No row
  // makes the next check start at the oldest file.
  demo_upload_sweeps: defineTable({
    // the creation time of the newest file it checked, epoch milliseconds
    checked_through: v.number(),
    // After a full page, the files created at checked_through that it
    // checked, as others created then may remain. Absent, it checked them all.
    checked_at: v.optional(v.array(v.id('_storage'))),
  }),

  // Anonymous admission counters contain no addresses or workspace data.
  // Global admission windows expire automatically; no client IP is stored.
  demo_admission: defineTable({
    key: v.string(),
    count: v.number(),
    expires_at: v.number(),
  })
    .index('by_key', ['key'])
    .index('by_expiry', ['expires_at']),

  // Anonymous, durable deployment totals survive deletion of 24-hour demos.
  // Coverage starts when tracking was installed, never at an inferred date.
  demo_metrics: defineTable({
    key: v.string(),
    tracking_started_at: v.number(),
    total_created: v.number(),
    sampled_at: v.optional(v.number()),
    database_bytes: v.optional(v.number()),
    file_bytes: v.optional(v.number()),
  }).index('by_key', ['key']),

  demo_metrics_daily: defineTable({
    date: v.string(),
    created: v.number(),
    samples: v.number(),
    database_bytes_sum: v.number(),
    file_bytes_sum: v.number(),
    browsers: v.optional(v.record(v.string(), v.number())),
    operating_systems: v.optional(v.record(v.string(), v.number())),
    // No longer written. The hourly storage sample strips earlier country
    // counts; remove the field once none remain.
    countries: v.optional(v.record(v.string(), v.number())),
  }).index('by_date', ['date']),

  // Main-deployment reporting cache receives only aggregate demo metrics.
  demo_metric_reports: defineTable({
    key: v.string(),
    generated_at: v.number(),
    received_at: v.number(),
    payload: v.string(),
  }).index('by_key', ['key']),

  // One resumable sampler. Its own changing progress is excluded from the
  // application-document byte estimate; no identity or document is copied.
  demo_metrics_scans: defineTable({
    key: v.string(),
    run_id: v.string(),
    started_at: v.number(),
    progress_at: v.number(),
    step: v.number(),
    schema_key: v.string(),
    phase: v.union(v.literal('receipts'), v.literal('database'), v.literal('files')),
    table_index: v.number(),
    cursor: v.optional(v.string()),
    database_bytes: v.number(),
    file_bytes: v.number(),
  }).index('by_key', ['key']),

  // Private, short-lived roadmap undo receipts. Only the authenticated
  // owner can replay them; snapshots never expose this table. Serialized
  // changes contain server-captured values, never client-supplied history.
  roadmap_history: defineTable({
    auth_user_id: v.string(),
    session_key: v.string(),
    position: v.number(),
    expires_at: v.number(),
    changes: v.string(),
  }).index('by_owner_session', ['auth_user_id', 'session_key']),

  // Personal appearance follows a login across its organization seats. These
  // rows and files never enter an org snapshot or the public image library.
  account_appearance: defineTable({
    auth_user_id: v.string(),
    // 'image' is the retired Canvas theme (deviation #302) and 'blue' the
    // retired Blue theme. Demo visitor or production rows written before they
    // retired may still hold them, so the schema accepts them for deploys;
    // appearanceSettings reads both as 'dark' and every save writes a current
    // mode. Drop them once no deployment holds one.
    mode: v.union(vAppearanceMode, v.literal('blue'), v.literal('image')),
    image_source: vImageSource,
    custom_image_id: v.optional(v.string()),
    revision: v.string(), // upload replacement/removal fence, not a theme version
    updated_at: v.string(),
  }).index('by_auth_user', ['auth_user_id']),

  custom_backgrounds: defineTable({
    id: v.string(),
    auth_user_id: v.string(),
    storage_id: v.id('_storage'),
    preview_storage_id: v.optional(v.id('_storage')),
    preview_version: v.optional(v.number()),
    name: v.string(),
    mime: v.string(),
    width: v.number(),
    height: v.number(),
    byte_size: v.number(),
    sha256: v.string(),
    uploaded_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_storage', ['storage_id'])
    .index('by_preview_storage', ['preview_storage_id']),

  // The HTTP upload endpoint stores the request's bytes itself. A ticket
  // never lets a caller hand in an arbitrary existing Convex storage id.
  background_uploads: defineTable({
    id: v.string(),
    auth_user_id: v.string(),
    name: v.string(),
    expires_at: v.number(),
    expected_revision: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_expiry', ['expires_at']),

  // Operator-only ownership receipt for the repeatable Northstar marketing
  // dataset. Never included in client snapshots; names/slugs alone do not
  // authorize adopting accounts or resetting an organization.
  marketing_demo: defineTable({
    key: v.string(),
    org_id: v.string(),
    auth_ids: v.record(v.string(), v.string()),
    credential_set_id: v.string(), // binds the receipt to one private CLI stash
    state: v.union(v.literal('empty'), v.literal('seeding'), v.literal('ready')),
    version: v.number(),
    anchor: v.optional(v.string()),
    // While 'seeding': the next step of internal/marketingDemo.ts SEED_STEPS
    // (the reserved-id check parts, then model/demoSeed.ts NORTHSTAR_STEPS),
    // the write time every step of this seed uses, and the SEED_LAYOUT the
    // step index belongs to.
    seed: v.optional(v.object({ step: v.number(), now: v.string(), layout: v.string() })),
    created_at: v.string(),
    updated_at: v.string(),
  }).index('by_key', ['key']),

  billing_plans: defineTable({
    id: v.string(),
    ...billingPlanFields,
    archived: v.boolean(),
    created_at: v.string(),
  }).index('by_uuid', ['id']),

  billing_settings: defineTable({
    key: v.string(),
    default_plan_id: v.string(),
  }).index('by_key', ['key']),

  // Never read by the planner snapshot. The org admin's Billing page has its
  // own query; usage is an explicit fetch rather than a hot subscription.
  billing_subscriptions: defineTable({
    id: v.string(),
    org_id: v.string(),
    plan_id: v.string(),
    status: vBillingStatus,
    polar_subscription_id: v.optional(v.string()),
    polar_customer_id: v.optional(v.string()),
    provider_modified_at: v.optional(v.string()),
    ended_at: v.optional(v.string()),
    current_period_start: v.optional(v.string()),
    current_period_end: v.optional(v.string()),
    billed_seats: v.number(),
    next_seats: v.number(),
    cancel_at_period_end: v.boolean(),
    past_due_at: v.optional(v.string()),
    complimentary_start: v.optional(v.string()),
    complimentary_until: v.optional(v.string()),
    checkout_id: v.optional(v.string()),
    checkout_url: v.optional(v.string()),
    checkout_expires_at: v.optional(v.string()),
    checkout_lock: v.optional(v.string()),
    checkout_lock_until: v.optional(v.string()),
    // When an organization that never completes checkout is deleted
    // (orgRemovals.ts). Set only on enrollment while billing is enabled, so
    // organizations enrolled before billing started are never deleted by it.
    checkout_due_at: v.optional(v.string()),
    sync_lock: v.optional(v.string()),
    sync_lock_until: v.optional(v.string()),
    sync_error: v.optional(v.string()),
    synced_at: v.optional(v.string()),
    // When the minute sweep next reconciles this organization with Polar
    // (billingSync.ts nextSyncDue). Absent only on rows enrolled before due
    // times existed, which the sweep treats as due after the other targeted
    // times.
    sync_due_at: v.optional(v.string()),
    // True when sync_due_at is only the daily safety pass, which the
    // sweep starts after every other due organization.
    sync_safety: v.optional(v.boolean()),
    // Reconciliations that failed in a row, which set the retry's delay.
    sync_attempts: v.optional(v.number()),
    // When the hourly organization sweep next reads this row
    // (orgRemovals.ts): when its service may end or its checkout deadline
    // pass (model/orgRetention.ts retentionDue), or, while the organization
    // has a removal, the removal's date. Never later than the first time the
    // sweep has work for it. Null when nothing can fall due without a write.
    // Absent only on rows written before it existed, which the sweep reads
    // and fills in.
    retention_at: v.optional(v.union(v.string(), v.null())),
    // The time of the free period's next reminder that has not gone out
    // (model/billing.ts nextReminder), which the minute sweep reads until it
    // has, so a reminder an outage held back goes out late. Null when none is
    // left, as once Polar bills the organization. Absent only on rows written
    // before it existed, which the sweep fills in.
    remind_at: v.optional(v.union(v.string(), v.null())),
    updated_at: v.string(),
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    .index('by_provider', ['polar_subscription_id'])
    .index('by_sync_due', ['sync_safety', 'sync_due_at'])
    .index('by_retention', ['retention_at'])
    .index('by_remind', ['remind_at']),

  billing_periods: defineTable({
    org_id: v.string(),
    subscription_id: v.string(),
    plan_id: v.string(),
    period_start: v.string(),
    period_end: v.string(),
    seats: v.number(),
    // Local membership evidence, never profiles from another tenant.
    profile_ids: v.array(v.string()),
    // The storage sampled at period start and the blocks over the allowance
    // it charges. Both are absent while the sample runs (billingSync.ts
    // storageStep), and set once it finishes.
    storage_bytes: v.optional(v.number()),
    storage_blocks: v.optional(v.number()),
    // The running sample's id, which its steps check before each page, and
    // when its last step ran. Both are cleared when it finishes.
    storage_run: v.optional(v.string()),
    storage_run_at: v.optional(v.string()),
    // How many times the sample started, cleared when it finishes, and when
    // apply stopped it after STORAGE_ATTEMPTS starts (billingSync.ts).
    storage_attempts: v.optional(v.number()),
    storage_failed_at: v.optional(v.string()),
    created_at: v.string(),
  })
    .index('by_subscription_period', ['subscription_id', 'period_start'])
    .index('by_org', ['org_id']),

  // API calls per credential and bucket. `period_start` is the bucket key
  // chosen by `usagePeriod` (model/billingUsage.ts): a paid period's ISO start,
  // a pending interval's ISO start, or `month:YYYY-MM` for a UTC calendar month
  // without a paid period. Older rows may be keyed by `complimentary_start`.
  //
  // `neg_calls` and `name_key` rank a row, server-owned and written with
  // `calls` and `credential_name` (model/billingUsage.ts writeUsageRow): the
  // negated calls, so one ascending range reads calls descending, and the
  // credential name's key (lib/nameKey.ts). A ranked row's -neg_calls is in
  // its account's billing_usage_accounts row and, for a calendar month, in
  // the organization's billing_month_totals; a row without them, stored
  // before ranks existed, is in neither until the next call of its
  // credential or internal/usageRanksBackfill ranks it. Such a row sorts
  // first in the rank indexes, so one read of a bucket's range says whether
  // the bucket's aggregates are complete (usageRanked).
  billing_usage: defineTable({
    org_id: v.string(),
    profile_id: v.string(),
    credential_id: v.string(),
    credential_name: v.string(),
    period_start: v.string(),
    calls: v.number(),
    neg_calls: v.optional(v.number()),
    name_key: v.optional(v.string()),
  })
    .index('by_org_period', ['org_id', 'period_start'])
    .index('by_credential_period', ['credential_id', 'period_start'])
    .index('by_subject_credential_period', [
      'org_id',
      'profile_id',
      'credential_id',
      'period_start',
    ])
    // a bucket's credentials, the organization's or one account's, by calls
    // descending, then name, with the credential breaking ties
    .index('by_org_period_rank', [
      'org_id',
      'period_start',
      'neg_calls',
      'name_key',
      'credential_id',
    ])
    .index('by_org_period_profile_rank', [
      'org_id',
      'period_start',
      'profile_id',
      'neg_calls',
      'name_key',
      'credential_id',
    ]),

  // The calls of a paid, pending or older ISO-keyed bucket, every call
  // counted in its own transaction (model/billingUsage.ts recordApiCall). A
  // calendar month keeps its total in billing_month_totals instead.
  billing_usage_totals: defineTable({
    org_id: v.string(),
    period_start: v.string(),
    calls: v.number(),
    reported_api_blocks: v.number(),
    // How many times the bucket's account rows were written
    // (model/billingUsage.ts addRankedCalls). It only grows, so with `calls`
    // it tells internal/usageRanksBackfill's check whether any write landed
    // while it read the bucket. Absent until the first such write.
    account_writes: v.optional(v.number()),
  }).index('by_org_period', ['org_id', 'period_start']),

  // One account's calls in one usage bucket, every credential of the
  // profile together: the sum of -neg_calls of the profile's ranked
  // billing_usage rows in the bucket, kept in the transaction that ranks or
  // counts each of them (model/billingUsage.ts addRankedCalls). Kept when the
  // profile leaves, as its usage rows are, and deleted with the
  // organization.
  billing_usage_accounts: defineTable({
    org_id: v.string(),
    period_start: v.string(), // the bucket key, as on billing_usage
    profile_id: v.string(),
    calls: v.number(),
  })
    .index('by_org_period_profile', ['org_id', 'period_start', 'profile_id'])
    // Billing's API calls by account: read in descending order
    .index('by_org_period_calls', ['org_id', 'period_start', 'calls', 'profile_id']),

  // A calendar-month bucket's calls, the organization's total in
  // MONTH_TOTAL_SHARDS rows (model/billingUsage.ts), each holding the
  // ranked calls of the profiles whose id hashes to it. Every call of one
  // profile writes the same row, which its rate-limit row already
  // serializes, so calls of different profiles rarely touch the same row.
  // The total is the sum of the shards, which equals the bucket's calls
  // once usageRanked says every row is in it. Deleted with the
  // organization.
  billing_month_totals: defineTable({
    org_id: v.string(),
    period_start: v.string(), // 'month:YYYY-MM'
    shard: v.number(),
    calls: v.number(),
    // how many times this row was written, which only grows, as
    // billing_usage_totals account_writes
    writes: v.number(),
  }).index('by_org_period_shard', ['org_id', 'period_start', 'shard']),

  // Durable outbox. Provider event external_id is this id, so a timeout and
  // retry cannot bill twice. Metering is never reconstructed from logs.
  billing_events: defineTable({
    id: v.string(),
    org_id: v.string(),
    kind: v.union(v.literal('api'), v.literal('storage')),
    period_start: v.string(),
    units: v.number(),
    attempts: v.number(),
    next_attempt_at: v.string(),
    sent_at: v.optional(v.string()),
    abandoned_at: v.optional(v.string()),
    finished_at: v.optional(v.string()),
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org_period', ['org_id', 'period_start'])
    .index('by_pending', ['finished_at', 'next_attempt_at']),

  /* One verified Polar subscription delivery, by Polar's event id, stored
   * before the webhook answers and processed afterwards (billingSync.ts
   * receiveWebhook). A row without `pending` is done, as every row written
   * before deliveries were stored first is. */
  billing_webhooks: defineTable({
    event_id: v.string(),
    subscription_id: v.string(),
    received_at: v.string(),
    // set until the delivery is processed or given up
    pending: v.optional(v.literal(true)),
    // processing attempts so far, and when the next may start
    attempts: v.optional(v.number()),
    next_attempt_at: v.optional(v.string()),
    // the claim of the attempt that holds the delivery (claimWebhook)
    claim: v.optional(v.string()),
    processed_at: v.optional(v.string()),
    // when processing was given up after WEBHOOK_ATTEMPTS
    failed_at: v.optional(v.string()),
  })
    .index('by_event', ['event_id'])
    .index('by_pending', ['pending', 'next_attempt_at'])
    .index('by_received', ['received_at']),

  billing_notices: defineTable({
    key: v.string(),
    org_id: v.string(),
    profile_id: v.string(),
    kind: v.string(),
    sent_at: v.optional(v.string()),
    created_at: v.string(),
  })
    .index('by_key', ['key'])
    .index('by_org', ['org_id']),

  machine_rate_limits: defineTable({
    key: v.string(),
    window_start: v.number(),
    count: v.number(),
  }).index('by_key', ['key']),

  // One organization's usage in one closed UTC month, for Qivo Admin's Usage
  // page (usage.ts). The monthly job writes it early on the 1st and a rerun
  // replaces it. Deleted after USAGE_RETENTION_DAYS and with the organization.
  usage_months: defineTable({
    org_id: v.string(),
    month: v.string(), // YYYY-MM
    counts: vUsageCounts,
    // Part of api_calls was split by time from a paid billing period that
    // crosses the month's start or end (usage.ts apiBuckets).
    api_estimated: v.boolean(),
    computed_at: v.string(),
  })
    .index('by_org_month', ['org_id', 'month'])
    .index('by_month', ['month']),

  // Counts nothing else keeps: mail the provider accepted, by organization
  // and kind, with person mail (verification, password reset) under no
  // organization, and the webhook deliveries the retention sweep deleted, by
  // the month they finished. One row per organization, month and metric
  // (usage.ts countUsage). The bytes of account backgrounds and of deleted
  // files held for a restore when a month was stored are two more rows
  // under no organization (setMonthBytes).
  usage_counts: defineTable({
    org_id: v.optional(v.string()),
    month: v.string(), // YYYY-MM
    metric: vUsageMetric,
    count: v.number(),
  })
    .index('by_org_month_metric', ['org_id', 'month', 'metric'])
    .index('by_month', ['month']),

  // A month a login's sign-in session was used in, kept when Better Auth
  // deletes the session at sign-out or once it expired, so the month still
  // counts the person as active (lib/signIns.ts keepSignIns). Deleted after
  // USAGE_RETENTION_DAYS and with the login.
  usage_sign_ins: defineTable({
    auth_user_id: v.string(),
    month: v.string(), // YYYY-MM
    // the latest sign-in in this month among the ended sessions, in ms, for
    // Qivo Admin's last sign-in (adminPeople.ts)
    signed_in_at: v.optional(v.number()),
  })
    .index('by_user_month', ['auth_user_id', 'month'])
    .index('by_month', ['month']),

  // One UTC month of the usage job (usage.ts). The daily job first writes
  // it during the month, when it saw the month begin (`seen_at`); counting
  // mail, deleted webhook deliveries and ended sign-in sessions began about
  // then, so a month first seen after its first day is partial. Once the
  // month has ended, the run that stores its usage_months rows keeps its
  // progress here, so a run that stopped resumes from its next page. Deleted
  // after USAGE_RETENTION_DAYS.
  usage_runs: defineTable({
    month: v.string(), // YYYY-MM
    seen_at: v.number(),
    // The run under way or done: its id, which its steps carry, the next
    // page of organizations, the organizations saved and failed so far, when
    // its last step began and when it finished.
    run: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    saved: v.optional(v.number()),
    failed: v.optional(v.number()),
    step_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
  }).index('by_month', ['month']),

  organizations: defineTable({
    id: v.string(),
    name: v.string(),
    slug: v.string(), // lowercase; shape + reserved list checked in model/orgs
    created_at: v.string(),
    date_format: v.string(),
    week_start: v.number(),
    week_one_rule: v.string(), // jan1 | first4day | firstfull
    default_plannable_hours: v.number(), // whole hours (0095)
    // Retired and unread. Qivo no longer requests Gravatar pictures. New
    // organizations still store false (model/orgs.ts newOrgDefaults) so a
    // rollback to an earlier release, whose schema requires it, can deploy.
    // Optional so rows can drop it later.
    gravatar_avatars: v.optional(v.boolean()),
    // Org-wide upload cap in MiB, LIMITS.attachmentLimit (lib/limits.ts).
    max_attachment_mb: v.optional(v.number()),
    // Retired and unread. No rule consults it and nothing writes it. Kept
    // optional so rows that stored it still validate.
    only_team_leads_manage_project_users: v.optional(v.boolean()),
    // Who may create top-level projects besides org admins, who always can.
    // Missing means 'users' (lib/projectCreators.ts).
    project_creators: v.optional(vProjectCreators),
    // organization_billing merged in; absent until billing exists. seats > 0
    // is a mutation check; redacted for non-admins in the snapshot query.
    billing: v.optional(
      v.object({
        plan: v.string(),
        seats: v.number(),
        renewal_date: v.union(v.string(), v.null()),
      }),
    ),
    // The last time an admin's browser finished an export. Qivo cannot see
    // the file reach disk, so this only decides whether to remind admins.
    last_export_at: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_slug', ['slug']),

  // An organization that is read-only before its deletion, or being deleted
  // (orgRemovals.ts). Every org-scoped call reads this row through by_org.
  // It changes rarely, so the read does not re-run queries on every write.
  // `phase` is set once deletion begins; until then admins can still export
  // and the deletion can stop. Deleted items background work (deletedItems.ts)
  // also reads it: items keep expiring while the organization is read-only,
  // and nothing touches its items once `phase` is set.
  org_removals: defineTable({
    org_id: v.string(),
    reason: vOrgRemovalReason,
    ended_at: v.string(), // when the service ended; exports a week before count
    delete_after: v.string(), // when deletion may begin
    requested_by: v.optional(v.string()), // the admin profile, for 'requested'
    phase: v.optional(vOrgRemovalPhase),
    progress_at: v.optional(v.string()), // the last committed step
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
    // While the profiles phase marks one deleted profile's guest
    // organizations due over more than one step (model/orgDeletion.ts): that
    // profile, and the _creationTime and _id of the last profile with its
    // email the marking read (lib/billableUsers.ts markHomeProfileRemoved).
    // A row from before through_id stands for its whole _creationTime.
    guest_marking: v.optional(
      v.object({
        profile_id: v.string(),
        through: v.number(),
        through_id: v.optional(v.id('profiles')),
      }),
    ),
    created_at: v.string(),
  })
    .index('by_org', ['org_id'])
    // progress_at is absent until deletion begins, so the hourly sweep reads
    // the removals still waiting whose date has passed in one range.
    .index('by_progress', ['progress_at', 'delete_after']),

  // The access an organization's running deletion has already deleted
  // (model/orgDeletion.ts), so that a call through it still hears that the
  // organization is being deleted (lib/billingAccess.ts removedWithOrg)
  // rather than that it has no seat or an unknown credential. `key` is, by
  // `kind`, a login's Better Auth user id, a profile's uuid, a personal
  // token's or agent key's hash, or an OAuth connection's uuid. Only access
  // that still worked is recorded: an unrevoked agent key, an unrevoked and
  // unexpired personal token of a login that is not banned, an approved and
  // unrevoked connection. The deletion's last steps delete the rows after
  // the organization.
  removed_access: defineTable({
    org_id: v.string(),
    kind: vRemovedAccessKind,
    key: v.string(),
  })
    .index('by_key', ['kind', 'key', 'org_id'])
    .index('by_org', ['org_id']),

  // Per-organization number counters (model/orgs.ts). Task and project
  // creation write this row instead of the organization row, which every
  // settings read and every member's snapshot depend on. Only model/orgs.ts
  // writes it; numbers are dense at assignment and never reused.
  org_counters: defineTable({
    org_id: v.string(),
    next_issue_num: v.number(),
    next_project_num: v.number(),
    // The rows the app's windows read (lib/workspaceParts.ts): the
    // organization's active tasks (in issues, no archived_at) and its
    // projects in the live tables, archived ones included. Every write that
    // adds, removes, archives or restores one keeps them (model/orgs.ts
    // tallyRow), and the app sizes an organization's first windows by them
    // (lib/idWindows.ts startWindows). Absent until
    // internal/liveCountsBackfill counts the organization. While it counts,
    // `counted` holds the task and project numbers it has counted through,
    // and a write moves the counts only for a row at or below them.
    active_tasks: v.optional(v.number()),
    live_projects: v.optional(v.number()),
    counted: v.optional(v.object({ tasks: v.number(), projects: v.number() })),
  }).index('by_org', ['org_id']),

  // Which one-time migrations an organization's rows have finished, one row
  // per organization (model/orgs.ts insertOrgRows, deleteOrgBookkeeping). A
  // reader that depends on one refuses while its stamp is absent. Kept off
  // org_counters and the organization row, which every member's workspace
  // reads. `name_keys_at` says from when every profile, team, project,
  // membership, grant and team share of the organization holds its name key
  // (internal/nameKeysBackfill.ts). An organization created since every
  // writer keeps them gets it at its creation. `nav_at` says the same of
  // every project's archive_state and every lead's, grant's and team share's
  // project_reach rows (internal/navBackfill.ts); a reader in name order
  // needs both (model/projectNav.ts navReady).
  org_ready: defineTable({
    org_id: v.string(),
    name_keys_at: v.optional(v.string()),
    nav_at: v.optional(v.string()),
  }).index('by_org', ['org_id']),

  // Team sync stamps (model/syncStamps.ts, lib/teamSync.ts), one row per
  // stamped person: the latest change made on them through the sync page
  // (server clock), and the reading point of the sitting that change belongs
  // to: the previous sitting's last change, or in a first sitting the day the
  // page read from (YYYY-MM-DD); absent = the default. Kept off the profile,
  // which every query its owner subscribes reads.
  sync_stamps: defineTable({
    org_id: v.string(),
    profile_id: v.string(),
    at: v.string(),
    since: v.optional(v.string()),
  })
    .index('by_profile', ['profile_id'])
    .index('by_org', ['org_id'])
    // the stamps of one of the app's people windows (lib/workspaceParts.ts)
    .index('by_org_profile', ['org_id', 'profile_id']),

  teams: defineTable({
    id: v.string(),
    org_id: v.string(),
    name: v.string(),
    // Legacy icon and its color, as on projects.
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    track_delay_default: v.boolean(),
    created_at: v.string(),
    // The name as name-ordered lists sort and search it, server-owned as on
    // projects. project_team_access copies it.
    name_key: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    // the organization's teams in name order
    .index('by_org_name', ['org_id', 'name_key', 'id']),

  team_members: defineTable({
    team_id: v.string(),
    profile_id: v.string(),
    is_leader: v.boolean(),
    name_key: nameCopy, // the profile's
  })
    .index('by_team', ['team_id'])
    .index('by_profile', ['profile_id'])
    .index('by_team_profile', ['team_id', 'profile_id'])
    // a team's members in name order
    .index('by_team_name', ['team_id', 'name_key', 'profile_id'])
    // the memberships a rename brings in line, as project_access by_profile_name
    .index('by_profile_name', ['profile_id', 'name_key']),

  // One team's member count (model/teamCounts.ts), for Settings > Teams, the
  // team page and the REST and MCP team summaries, kept off the team row,
  // which every member's catalog and many permission reads load. `members`
  // counts the team's team_members rows whose profile exists in the team's
  // organization and is not a guest, as model/teams.ts teamJson lists them:
  // inactive people, agents and viewers count, and a guest's membership
  // left from before the guest rule does not. A membership a profile
  // removal left for its background steps still counts until a step deletes
  // it (profile_removals.counted_org_id). Every write of a membership moves
  // the count in its own transaction. A team has no row until
  // internal/teamCountsBackfill counts it, and teams created since this
  // release start with one. While the backfill counts a team, `through`
  // holds the _creationTime of the last membership it counted, and a write
  // moves the count only for a membership at or below it. `revision` goes
  // up with every write of the row, so a dry run sees a change that ends
  // where it began. No reader uses the count yet; one is to show it only
  // for a row without `through` (memberCount), never a missing row as zero.
  team_counts: defineTable({
    team_id: v.string(),
    org_id: v.string(),
    members: v.number(),
    through: v.optional(v.number()),
    revision: v.number(),
  })
    .index('by_team', ['team_id'])
    .index('by_org', ['org_id']),

  profiles: defineTable({
    id: v.string(),
    auth_user_id: v.optional(v.string()), // Better Auth user id; absent = unclaimed seat
    org_id: v.string(),
    email: v.optional(v.string()), // lowercase; (kind='agent') = (email absent) (0104)
    name: v.string(), // non-blank, LIMITS.personName (lib/limits.ts)
    initials: v.string(), // 1–3 chars; derived on rename, hand-picked values stand
    color: v.string(),
    org_role: vOrgRole, // agents are never admin or guest (0100/0102)
    active: v.boolean(),
    kind: vProfileKind,
    plannable_hours: v.optional(v.number()), // whole hours; agents have none (0103)
    message_retention_days: v.optional(v.number()), // LIMITS.messageRetention; absent = keep forever
    avatar_storage_id: v.optional(v.id('_storage')), // replaces avatar_path
    // Public sample portraits are immutable build assets, never private storage.
    sample_avatar: v.optional(
      v.union(
        v.literal('nora'),
        v.literal('leo'),
        v.literal('aisha'),
        v.literal('emil'),
        v.literal('sofia'),
        v.literal('daniel'),
        v.literal('ben'),
        v.literal('atlas'),
      ),
    ),
    accepted_at: v.optional(v.string()), // kept from 0118: home-org uniqueness gates on it
    // The per-user project-creation right. It only counts for a standard
    // user, person or agent, while project_creators is 'selected'; absent =
    // off.
    can_create_projects: v.optional(v.boolean()),
    created_at: v.string(),
    // The name as name-ordered lists sort and search it, server-owned as on
    // projects. team_members and project_access copy it.
    name_key: v.optional(v.string()),
    // uniqueness (mutation-checked): (org_id, email), (org_id, auth_user_id),
    // and at most one accepted non-guest seat per login across all orgs
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    // the organization's people in name order, all of them or one role
    .index('by_org_name', ['org_id', 'name_key', 'id'])
    .index('by_org_role_name', ['org_id', 'org_role', 'name_key', 'id'])
    // the app's people windows: a range of profile ids (lib/workspaceParts.ts)
    .index('by_org_id', ['org_id', 'id'])
    .index('by_auth', ['auth_user_id'])
    .index('by_email', ['email']) // cross-org claim scan (identity.ts)
    .index('by_org_email', ['org_id', 'email'])
    .index('by_org_auth', ['org_id', 'auth_user_id'])
    // files.ts cross-reference fence + reapOrphans' avatar reference set
    .index('by_avatar', ['avatar_storage_id']),

  // A removed profile whose history still names it. removeProfile deletes
  // the profile and its access in one transaction and inserts this row;
  // bounded background steps (profileRemovals.ts) clear the rest, then
  // delete it. Until then the row reserves the id, so profiles.create cannot
  // give it to a new seat. It has no org_id, because a removal also finishes
  // after its organization is deleted.
  profile_removals: defineTable({
    profile_id: v.string(),
    removed_at: v.string(),
    phase: vRemovalPhase,
    progress_at: v.string(), // the last committed step; recovery restarts a stalled row
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
    // Set when the profile was no guest and memberships outlived the
    // removal's own transaction: the organization whose team_counts still
    // count them. The access phase takes each one off its team's count as
    // it deletes it (model/teamCounts.ts countingOrgOf).
    counted_org_id: v.optional(v.string()),
  })
    .index('by_profile', ['profile_id'])
    .index('by_progress', ['progress_at']),

  // A renamed profile or team whose name key copies (schema `nameCopy` above)
  // bounded background steps still bring in line (nameCopies.ts). The rename
  // brings the first ones in line in its own transaction and writes this row
  // only when more are left (model/nameKeys.ts copyNameKey). Each step reads
  // the source's current name, so the last rename wins. It has no org_id,
  // because a step also ends after its organization is deleted, as
  // label_removals do.
  name_copies: defineTable({
    source: vNameSource,
    source_id: v.string(),
    // the source's _creationTime, which a profile or team that later takes
    // the same id does not share, so the row never passes to it
    source_created: v.number(),
    progress_at: v.string(), // the last committed step; recovery restarts a stalled row
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
  })
    .index('by_source', ['source', 'source_id'])
    .index('by_progress', ['progress_at']),

  projects: projectsTable,
  project_access: projectAccessTable,
  project_team_access: projectTeamAccessTable,

  // Which projects each seat and each team reaches through ordinary access,
  // so a person's projects page in name order across their seats and teams
  // with reads bounded by the page, not by the grants (model/projectNav.ts).
  // A row is a presence fact that finds candidates and grants nothing:
  // every permission check keeps using lib/access.ts, and a reader checks
  // the live project of each row it returns. Admin status alone writes no
  // row. Rows exist only in a top-level meta's tree in the grantee's
  // organization (lib/access.ts inMetaTree):
  // - a child row for a sub-project on which the grantee holds a source of
  //   its own: a team share for a team; for a seat a user grant or the
  //   sub-project's own lead_id;
  // - a root row for a top-level project on which the grantee holds a
  //   source (on_root, which reaches the whole tree) or that holds one of
  //   the grantee's child rows (navigation only).
  // A membership change writes none, because a page reads one range for
  // each team of the person. Whether the grantee's role turns a source into
  // access (a guest gets no team share, a viewer leads nothing) is left to
  // the reader, as lib/access.ts decides it.
  //
  // One recompute, syncReach, keeps the rows of a grantee on a project and
  // its root exact, and every lead, grant and share writer calls it in its
  // own transaction, the user grant and team share inserts and deletes
  // through model/projectNav.ts (insertGrant, deleteGrant, insertShare,
  // deleteShare, grantBatch). A rename, a key change, an archive or a
  // restore updates the rows of the projects it changes in the same
  // transaction, and refuses with LIMITS.projectTreeChange's sentence, before
  // it writes, when the sub-projects it writes and the rows it reads are
  // more than LIMITS.projectTreeChange.max, shared by every such change of
  // one mutation (about half of Convex's 4,096 reads, as a label deletion
  // measured; no background job takes the rest; model/projectNav.ts
  // TreeBudget). A move to Deleted items deletes the rows of its projects
  // in its steps, and a restore writes them again before its reveal and
  // brings them in line again after it (model/deletedItems.ts
  // clearProjectRows, restoreAccess, restoreGrants). Not a stored table: nothing goes to
  // deleted_rows. Teardowns delete them by organization. Rows written before
  // this table existed are none; internal/navBackfill writes them, and
  // readers wait for org_ready.nav_at. Never sent to clients, REST, MCP,
  // webhooks or the export.
  project_reach: defineTable({
    org_id: v.string(), // the project's
    grantee_kind: vGranteeKind,
    grantee_id: v.string(), // a profile id or a team id
    kind: vReachKind,
    project_id: v.string(), // the top-level project of a root row, the sub-project of a child row
    root_id: v.string(), // the top-level project, project_id itself on a root row
    // copies of the project's name key (lib/nameKey.ts of its name), key,
    // and whether it is live (archived_at absent), which the project's
    // rename, key change, archive and restore keep in line
    name_key: v.string(),
    key: v.string(),
    live: v.boolean(),
    // a root row: whether the grantee holds a source on the top-level
    // project itself, which reaches every sub-project; false on a root row
    // for navigation to a sub-project only, and on every child row
    on_root: v.boolean(),
  })
    // a grantee's top-level projects (kind 'root') or sub-projects in name
    // order, live or archived, the project id breaking ties
    .index('by_grantee_list', [
      'grantee_kind',
      'grantee_id',
      'kind',
      'live',
      'name_key',
      'project_id',
    ])
    // a grantee's sub-projects under one top-level project in name order
    .index('by_grantee_root', [
      'grantee_kind',
      'grantee_id',
      'root_id',
      'kind',
      'live',
      'name_key',
      'project_id',
    ])
    // as by_grantee_list in key order, for REST and MCP
    .index('by_grantee_key', ['grantee_kind', 'grantee_id', 'kind', 'live', 'key', 'project_id'])
    // every grantee's row on one project, at most one each
    .index('by_project_grantee', ['project_id', 'grantee_kind', 'grantee_id'])
    // the child rows under one top-level project, live or archived, which
    // an archive or a restore of the project reads in one range
    .index('by_root_child', ['root_id', 'kind', 'live'])
    .index('by_org', ['org_id']),

  issues: issuesTable,

  /* A task's description in a row of its own, so that the reads of task
   * lists read small task rows (an issues row with a description at
   * LIMITS.description is about 60 KB, one stored before the caps up to
   * 1 MiB). The server owns it, with exactly one row per live issues row
   * and '' for a task without a description. Only model/descriptions.ts
   * writes it, in the transaction that writes the task
   * (scripts/check-task-writes.mjs fails on any other writer). A row copies
   * its task's organization, project and archived state, and every write
   * of the row, and every change of the task's project or archived state,
   * writes the copies from the task in that transaction (patchTask), so
   * main Search can filter descriptions by project and archived state
   * (search_description). A write that finds a row resets every copy, since
   * a create may take the id of a task deleted for good before used_ids
   * recorded it, also in another organization. Deleted items stores a task
   * with its text and deletes its row in its steps, so a task in Deleted
   * items has no row once they have run, and a restore writes the row again
   * from the restored task (model/deletedItems.ts).
   *
   * The move takes three releases. In the first, every writer keeps both
   * copies and every reader reads issues.description, the source of truth;
   * internal/descriptionsBackfill gives older tasks their rows. The second,
   * this one, reads this table: every reader takes a task's text from its
   * first row in creation order that holds the task's copies, which every
   * writer keeps on the first row, else from its first row, and only a task
   * without a row reads issues.description (model/descriptions.ts
   * descriptionOf). Writers still
   * keep both copies, so a rollback to the first release loses nothing. It
   * ships only once a dry run of that backfill on every deployment reports
   * zero missing, differing, duplicate, orphaned and skipped rows
   * (docs/deployment.md). The third stops writing issues.description and
   * clears it. A rollback from it to this release still shows every
   * description, because this one reads the rows; one to the first release
   * no longer does, so the second is the third's rollback floor.
   *
   * The project and archived copies came after the table, in the same
   * release or a later one. A row holds them once project_id is present
   * (stamped). A row written by code from before them, or restored from an
   * older backup, holds none, and a release from before the table, which
   * still deploys, leaves rows with stale ones when it moves or archives
   * tasks. The same backfill reports and mends both (`differ`). Main Search
   * reads search_description only after a dry run on every deployment
   * reports zero (docs/deployment.md). */
  issue_descriptions: defineTable({
    issue_id: v.string(),
    org_id: v.string(), // the task's, for the teardowns that delete an organization's rows
    description: v.string(),
    // the task's; absent only on a row not yet stamped (above). Optional
    // until the backfill has stamped every deployment's rows.
    project_id: v.optional(v.string()),
    archived_at: v.optional(v.string()), // the task's, absent while it is active
  })
    .index('by_issue', ['issue_id'])
    .index('by_org', ['org_id'])
    // a project's active tasks' rows (archived_at absent), which a REST or
    // MCP search that needs most of them reads in chunks
    // (model/descriptions.ts projectTextReader)
    .index('by_project_archived', ['project_id', 'archived_at'])
    // main Search's description matches within an organization, narrowed to
    // a project and to active tasks (archived_at absent)
    .searchIndex('search_description', {
      searchField: 'description',
      filterFields: ['org_id', 'project_id', 'archived_at'],
    }),

  issue_links: issueLinksTable,

  labels: defineTable({
    id: v.string(),
    org_id: v.string(),
    name: v.string(), // non-blank, ≤40 chars
    name_lower: v.string(), // unique (org_id, name_lower), mutation-checked
    color: v.string(),
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    // the uniqueness check and lookups by name (model/labels.ts), and the
    // organization's labels in name order, name_lower then _creationTime,
    // for Settings > Labels and the task label picker (labels.settingsPage,
    // labels.picker through model/labels.ts labelBatch)
    .index('by_org_name_lower', ['org_id', 'name_lower']),

  // One label's use on active tasks (model/labelCounts.ts), for Settings >
  // Labels and its delete confirmation, kept off the label row, which every
  // member's catalog loads. `active_tasks` counts the live tasks without
  // archived_at that carry the label, each once, since a task holds a label
  // at most once. Done tasks the nightly archive has not reached count, and
  // so do tasks in archived projects, because archiving a project stamps
  // none of its tasks; org_counters counts active tasks the same way.
  // Deleted items hold no live task, and deleting a label deletes its row.
  // Every write of an assignment, and every write that adds, deletes,
  // archives or restores a task (model/orgs.ts tallyRows), moves the counts
  // in its own transaction. A label has no row until
  // internal/labelCountsBackfill counts its organization, and labels created
  // since this release start with one. `revision` goes up with every write
  // of the row, so a dry run sees a change that ends where it began.
  // labels.settingsPage answers the count for Settings > Labels only while
  // its organization has no label_count_runs row (model/labelCounts.ts
  // shownCount), and never a missing row as zero.
  label_counts: defineTable({
    label_id: v.string(),
    org_id: v.string(),
    active_tasks: v.number(),
    revision: v.number(),
  })
    .index('by_label', ['label_id'])
    .index('by_org', ['org_id']),

  // An organization whose label counts internal/labelCountsBackfill is
  // counting. It first sets every label's row to zero (`counting` false),
  // then reads the active tasks in _creationTime order. `through` holds the
  // _creationTime of the last task it counted, below every task until the
  // first; a write moves a count only for a task at or below it. A recount
  // sets a row it finds back to that start. The row is deleted once every
  // task is counted, and with the organization.
  label_count_runs: defineTable({
    org_id: v.string(),
    counting: v.boolean(),
    through: v.number(),
  }).index('by_org', ['org_id']),

  issue_labels: issueLabelsTable,

  // A deleted label whose task assignments background steps still remove
  // (labelRemovals.ts). The row reserves the id, so labels.create cannot
  // give it to a new label. It has no org_id, because a removal also
  // finishes after its organization is deleted, as profile_removals does.
  label_removals: defineTable({
    label_id: v.string(),
    removed_at: v.string(),
    progress_at: v.string(), // the last committed step; recovery restarts a stalled row
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
  })
    .index('by_label', ['label_id'])
    .index('by_progress', ['progress_at']),

  issue_subscriptions: issueSubscriptionsTable,
  issue_attachments: issueAttachmentsTable,

  // A deleted file waiting to be erased (model/fileHolds.ts). No row names
  // its file any more; it is kept until `erase_at` so a restore from a
  // backup without files finds it, then its scheduled erase, or else
  // files.ts eraseHeldFiles, erases it. One row per file. `size_bytes` is
  // the file's size when it was let go. `after_restore` marks the hold of a
  // file a restore left unnamed (files.ts reapOrphans), which no release
  // made.
  file_holds: defineTable({
    storage_id: v.id('_storage'),
    size_bytes: v.number(),
    erase_at: v.number(), // epoch milliseconds
    after_restore: v.optional(v.literal(true)),
  })
    .index('by_storage', ['storage_id'])
    .index('by_erase_at', ['erase_at']),

  // One row: the scheduled witness that tells the eraser whether a restore
  // rewound the database (model/fileHolds.ts noteRestore), and when it last
  // found one, in epoch milliseconds.
  restore_watch: defineTable({
    witness: v.id('_scheduled_functions'),
    restored_at: v.optional(v.number()),
  }),

  // A REST upload in progress (model/attachments.ts). It names the caller
  // that asked for the upload URL, the task it attaches to and when it
  // expires. Only that caller may confirm it, once, for that task, with a
  // file stored after the ticket's _creationTime. files.ts reapOrphans
  // deletes expired tickets with the unreferenced bytes.
  attachment_uploads: defineTable({
    id: v.string(), // the ticket
    org_id: v.string(),
    profile_id: v.string(),
    issue_id: v.string(),
    name: v.string(),
    content_type: v.optional(v.string()),
    size_bytes: v.number(), // declared by the client, checked against the stored file
    expires_at: v.number(), // epoch milliseconds
    // epoch milliseconds when the upload URL's current POST began, and that
    // POST's own id, absent while the URL is unused (model/attachments.ts
    // beginTicketUpload)
    upload_started_at: v.optional(v.number()),
    upload_attempt: v.optional(v.string()),
    // the one file the upload URL stored, which confirm must name
    storage_id: v.optional(v.id('_storage')),
  })
    .index('by_uuid', ['id'])
    .index('by_profile_expiry', ['profile_id', 'expires_at'])
    .index('by_expiry', ['expires_at']),

  // At most one row, written by the last leg of each finished files.ts
  // reapOrphans run, and deleted by one that spans a restore. No row makes
  // the next run a full one.
  orphan_reaps: defineTable({
    // every stored file created at or before this has been checked
    files_through: v.number(), // epoch milliseconds
    full_at: v.number(), // the start of the last finished full run, epoch milliseconds
  }),

  /* Stored task-file totals (model/storageTotals.ts) hold the bytes and
   * files of an organization's task attachments and description images, per
   * organization, per project and per task. A file counts from the
   * transaction that attaches it (model/attachments.ts attachFileCore) until
   * the one that deletes its last row for good, live or stored in Deleted
   * items, and counts once in between. A move to Deleted items, a restore,
   * an archive and their retries change no total. A file whose last row is
   * deleted counts as deleted at that commit, even while its bytes wait out
   * the backup hold (file_holds), which no organization owns. An upload
   * that never attaches never counts, and neither do profile pictures,
   * personal backgrounds or their previews. Each table is kept off
   * org_counters and the other rows every member's queries read, so the
   * writes rerun none of them. Readers use an organization's totals only
   * while its row exists without `counting` (storageTotalsOf).
   *
   * A project or task row is found by its organization, its id and its
   * number, which the organization never gives another project or task, so
   * one row holds one object's files for good. A new task or project that
   * takes the id of a purged one, in any organization, gets a row of its
   * own, and no writer ever reads or changes another's. A row a purged
   * object leaves behind goes with a recount of its organization, and the
   * rows of an organization that is gone with the backfill's stray check.
   *
   * One row per organization. No row means the organization is not counted
   * yet. internal/storageTotalsBackfill counts it, and until then every
   * writer leaves its totals alone. New organizations start counted
   * (model/orgs.ts insertOrgRows). */
  storage_org_totals: defineTable({
    org_id: v.string(),
    bytes: v.number(),
    files: v.number(),
    // Raised by every write to the organization's totals rows, its project
    // and task rows included, so a dry run of the backfill can tell that
    // they held still while it counted. It never goes back.
    revision: v.number(),
    // The backfill run that began the organization's latest count; absent
    // for an organization counted from its start
    run: v.optional(v.string()),
    // While the backfill counts, the task number it has counted through. A
    // writer moves the totals only for a task numbered at or below it, and
    // for any task that already has its storage_task_totals row.
    counting: v.optional(v.object({ through: v.number() })),
  }).index('by_org', ['org_id']),

  // The same totals per project (always a sub-project, as tasks name), for
  // the Storage by project breakdown. A row exists while the project has a
  // counted file and is deleted at none, so a project in Deleted items keeps
  // its row until its files are purged. `name` is the project's, copied
  // when the row is written and on each rename (model/projects.ts
  // updateProjectCore). project_id may name a project that is gone for good
  // while a subtask of a task item still holds files there.
  storage_project_totals: defineTable({
    org_id: v.string(),
    project_id: v.string(),
    // the project's number; absent, as `name` is, when the backfill found no
    // copy of the project, live or stored
    num: v.optional(v.number()),
    name: v.optional(v.string()),
    bytes: v.number(),
    files: v.number(),
  })
    .index('by_org_project', ['org_id', 'project_id', 'num'])
    // the breakdown, largest first, and the teardowns' drain by organization
    .index('by_org_bytes', ['org_id', 'bytes']),

  // The same totals per task, with the project the task's files count in,
  // so a move between projects shifts a task's bytes by reading this row
  // rather than its attachment rows (model/issues.ts moveIssueCore), and a
  // purge finds the project of a file whose task row is already gone. A row
  // exists while the task has a counted file, live or stored, and is
  // deleted at none. issue_id may name a task held only in Deleted items,
  // or one whose stored rows a purge is still deleting.
  storage_task_totals: defineTable({
    org_id: v.string(),
    issue_id: v.string(),
    // the task's number, which no other task of its organization ever has
    num: v.number(),
    // the project the files count in, with its number as that project's row
    // holds it
    project_id: v.string(),
    project_num: v.optional(v.number()),
    bytes: v.number(),
    files: v.number(),
  })
    // one task's row, and the teardowns' drain by organization
    .index('by_org_issue', ['org_id', 'issue_id', 'num']),

  milestones: milestonesTable,

  /* Deleted items (model/deletedItems.ts). Deleting a task or a project
   * moves its rows out of the live tables into deleted_rows, so every
   * existing reader treats it as gone. One deleted_items row stands for one
   * deletion as people see it in Settings: a task with the subtasks chosen
   * with it, or a project with its sub-projects and every task in them. It
   * has a fixed size, because Deleted items pages read many of them; nothing
   * in it grows with the project. Restore writes the rows back with their
   * uuids, numbers and keys, and the nightly expiry deletes them for good 30
   * days after the deletion. */
  deleted_items: defineTable({
    id: v.string(), // server-generated
    org_id: v.string(),
    kind: vDeletedItemKind,
    target_id: v.string(), // the root task or root project
    num: v.number(), // the root's task or project number
    name: v.string(), // root task title or project name at deletion
    key: v.optional(v.string()), // project items: the project key
    status: v.optional(vIssueStatus), // task items: the root's status
    archived: v.boolean(), // the root was archived when deleted
    // task item: the root task's project; project item: the root project
    project_id: v.string(),
    parent_project_id: v.optional(v.string()), // the top-level project above project_id
    // display names at deletion: [top, sub] for a task, [parent] for a
    // sub-project, [] for a top-level project. Readers prefer live names.
    path: v.array(v.string()),
    // The projects whose tasks are in the item: a task item's root project
    // and each cross-project subtask's, a project item's root and each
    // sub-project. Bounded by the sub-project count.
    projects: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        key: v.string(),
        type: vProjectType,
        tasks: v.number(),
        archived_tasks: v.number(),
      }),
    ),
    counts: v.object({
      tasks: v.number(),
      archived_tasks: v.number(),
      subtasks: v.number(),
      sub_projects: v.number(),
    }),
    deleted_at: v.string(),
    deleted_by: v.optional(v.string()), // the deleter's profile id
    // the credential of a REST or MCP delete, as it was named then
    via: v.optional(v.object({ table: vCredentialTable, id: v.string(), name: v.string() })),
    reason: v.optional(v.string()), // app deletes only, trimmed, ≤500 characters
    state: vDeletedItemState,
    purge_after: v.number(), // epoch ms, deleted_at + 30 days
    // the profile restoring it, for the steps and the final activity row.
    // Kept until the item is ready again after a failed restore, because
    // rows may be back in the live tables under its stored tasks until then.
    restore_by: v.optional(v.string()),
    dropped_rows: v.optional(v.number()), // rows too large to store, deleted instead
  })
    .index('by_uuid', ['id'])
    .index('by_target', ['target_id'])
    .index('by_org_deleted', ['org_id', 'deleted_at'])
    .index('by_org_deleter', ['org_id', 'deleted_by', 'deleted_at'])
    .index('by_org_project', ['org_id', 'project_id', 'deleted_at'])
    .index('by_org_parent', ['org_id', 'parent_project_id', 'deleted_at'])
    // A project item's purge also purges the ready and stuck items that
    // need its projects (model/deletedItems.ts purgeDependents), task items
    // by project_id and sub-project items by parent_project_id. Kind and
    // state in the index let it read only those, however many items in
    // other states name the same project. A filter would still read each.
    .index('by_org_project_kind_state', ['org_id', 'project_id', 'kind', 'state'])
    .index('by_org_parent_kind_state', ['org_id', 'parent_project_id', 'kind', 'state'])
    .index('by_state_purge', ['state', 'purge_after'])
    // whether an organization has an item in flight, which decides whether
    // its export reads each task's parent (orgExport.ts)
    .index('by_org_state', ['org_id', 'state']),

  /* The background steps of one moving, restoring or purging item. Kept off
   * deleted_items, so a step never invalidates an open Deleted items page.
   * recover (deletedItems.ts) restarts a row whose last step committed more
   * than a minute ago with no step waiting, at half the budget each time.
   * Once its organization's deletion has begun, its steps stand down and
   * recover leaves it for that deletion to delete (model/orgDeletion.ts). */
  deleted_item_jobs: defineTable({
    item_id: v.string(),
    phase: vTrashPhase,
    // Where a phase that reads a range it does not empty goes on: an index
    // into the item's projects (or 0), or for restore_access into each grant
    // table of each of them, and the _creationTime last done there.
    cursor: v.optional(v.object({ index: v.number(), after: v.number() })),
    // The tasks the item stores, as its steps count them: a move adds each
    // task it stores, and a restore subtracts each one it writes back. The
    // item takes these numbers when it becomes ready, so the steps never
    // rewrite the listed row.
    tally: v.optional(
      v.object({
        tasks: v.number(),
        archived_tasks: v.number(),
        dropped_rows: v.number(),
        projects: v.array(
          v.object({ id: v.string(), tasks: v.number(), archived_tasks: v.number() }),
        ),
      }),
    ),
    progress_at: v.string(), // the last committed step
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
    attempts: v.number(), // restarts since the last committed step
    budget_scale: v.number(), // 1, halved by each restart down to 1/16
    // a restore whose call held this task item alone and was not part of a
    // bulk restore: its reveal sends the Restored notice (model/deletedItems.ts)
    alone: v.optional(v.boolean()),
    // the tasks a task item's move deleted for good because they were too
    // large to store, whose history its steps still delete (move_drain).
    // Only the release before set it; a move now stores such a task cut
    // to the caps.
    purge_history: v.optional(v.array(v.string())),
    // a restore whose restore_access wrote the item's grants and shares back
    // before its reveal, so restore_grants only deletes the stored rows; a
    // job the release before left has none and writes back what is missing
    granted: v.optional(v.literal(true)),
  })
    .index('by_item', ['item_id'])
    .index('by_progress', ['progress_at']),

  /* The parent each task of a restoring project item waits for. A task
   * whose parent is outside the item goes back to issues without it while
   * the item fills, so that parent stays as it is until the reveal. After
   * the reveal the restore gives the task its parent by the parent table
   * (model/deletedItems.ts attachParents). It keeps one row per task rather
   * than a field on deleted_item_jobs, because an item can hold any number
   * of such tasks and every step rewrites its job. The rows outlive the
   * reveal with the item and its job and go with the item. Any move of such
   * a task to Deleted items, by this item or another, takes its row by task
   * and stores the task with this parent while it still waits for it
   * (takeParent). The row of a task whose project went to Deleted items
   * again before its turn goes to the item that holds that project. */
  deleted_item_parents: defineTable({
    item_id: v.string(),
    task_id: v.string(), // the task written back without its parent
    parent_id: v.string(), // the parent it had in Deleted items
  })
    .index('by_item_task', ['item_id', 'task_id'])
    .index('by_task', ['task_id']),

  /* The archived subtasks a deleted task left, which background steps
   * detach (model/deletedItems.ts detachArchivedChildren). The delete writes
   * the row, each step that leaves work rewrites it and the last step
   * deletes it, so recovery restarts a step that failed or stopped
   * (recoverArchivedDetaches). A restore from the archive reads it too: a
   * subtask archived by `deleted_at` leaves its parent even when the parent
   * came back from Deleted items first (model/issues.ts restoreLeavesParent).
   * It has no org_id: once the organization is deleted, the next step finds
   * no subtasks and deletes the row, as label_removals finish on their own. */
  archived_detaches: defineTable({
    parent_id: v.string(), // the deleted task
    actor_id: v.string(), // who deleted it, the detaches' actor
    deleted_at: v.string(), // the delete's time; subtasks archived by then leave
    progress_at: v.string(), // the last committed step
    scheduled_id: v.optional(v.id('_scheduled_functions')), // the next step
    attempts: v.number(), // restarts since the last committed step
  })
    .index('by_parent', ['parent_id', 'deleted_at'])
    .index('by_progress', ['progress_at']),

  /* One original document of a deleted item, typed by its table. Only
   * model/deletedItems.ts storeRow inserts here, writing `table` and `row`
   * together; restore writes `row.doc` back unchanged, which is why a
   * migration or backfill of a stored table must walk these rows too (see
   * the stored tables above). The indexed copies reserve what the live
   * tables would: uuids (by_row, lib/db.ts insertUnique), project keys
   * (by_org_key, model/projects.ts keyHolder) and attachment bytes
   * (by_storage, model/attachments.ts storageIdInUse). */
  deleted_rows: defineTable({
    item_id: v.string(),
    org_id: v.string(),
    table: vStoredTable,
    owner_id: v.string(), // the task the row travels with, or the project for project rows
    row_id: v.optional(v.string()), // the row's own uuid, for tables that have one
    created_ts: v.number(), // the original _creationTime
    storage_id: v.optional(v.id('_storage')), // issue_attachments: the bytes
    project_key: v.optional(v.string()), // projects: the key
    // projects: the stored lead, so a lead finds the projects they led in
    // Deleted items (model/deletedItemsList.ts)
    lead_id: v.optional(v.string()),
    // project_access: the profile, project_team_access: the team, so a level
    // check reads one person's grants of an item (model/deletedItems.ts)
    grantee: v.optional(v.string()),
    row: v.union(
      v.object({ table: v.literal('issues'), doc: issuesTable.validator }),
      v.object({ table: v.literal('comments'), doc: commentsTable.validator }),
      v.object({ table: v.literal('issue_labels'), doc: issueLabelsTable.validator }),
      v.object({
        table: v.literal('issue_subscriptions'),
        doc: issueSubscriptionsTable.validator,
      }),
      v.object({ table: v.literal('issue_attachments'), doc: issueAttachmentsTable.validator }),
      v.object({ table: v.literal('issue_links'), doc: issueLinksTable.validator }),
      v.object({ table: v.literal('projects'), doc: projectsTable.validator }),
      v.object({ table: v.literal('milestones'), doc: milestonesTable.validator }),
      v.object({ table: v.literal('project_access'), doc: projectAccessTable.validator }),
      v.object({
        table: v.literal('project_team_access'),
        doc: projectTeamAccessTable.validator,
      }),
    ),
  })
    .index('by_item_table_owner', ['item_id', 'table', 'owner_id'])
    .index('by_item_owner', ['item_id', 'owner_id'])
    .index('by_item_table_grantee', ['item_id', 'table', 'grantee'])
    .index('by_row', ['table', 'row_id'])
    // one task's stored rows of a table, whichever item holds them. A
    // project item can store them before the task, and a split moves them
    // between items one at a time (internal/storageTotalsBackfill.ts)
    .index('by_table_org_owner', ['table', 'org_id', 'owner_id'])
    .index('by_storage', ['storage_id'])
    .index('by_org_key', ['org_id', 'project_key'])
    .index('by_org_lead', ['org_id', 'lead_id'])
    .index('by_org', ['org_id']),

  /* Every id a task or a project has held (lib/enums.ts USED_ID_TABLES),
   * one row per id and organization, so no new task or project takes an id
   * once used. Rows in many other tables are keyed by such an id and can
   * outlive the object: a purge from Deleted items, a step that stopped
   * partway or a teardown still running leaves them for a while, and a new
   * object with the id would take them over or have them deleted. Only
   * lib/db.ts writes a row, in the transaction that inserts the object
   * (insertUnique for an id a caller chose, insertUsed for an id the server
   * chose and for a restore), and an id that any organization's row holds is
   * refused (scripts/check-task-writes.mjs fails on another insert of a task
   * or project). A move to Deleted items, a restore and a purge leave the
   * row. Only the end of an organization's teardown deletes its rows, once
   * nothing else of the organization is left (model/usedIds.ts
   * releaseUsedIds): its deletion in steps, deleteOrgDeep, the public demo's
   * cleanup, and the Northstar wipe, which keeps the organization but none
   * of its work. A row whose id something outside the organization still
   * names stays instead (`kept`), until a teardown of the same organization
   * finds the id named nowhere. The table grows by one row of
   * about 170 bytes, as Convex counts a document's size, with its two index
   * entries, for every task and project an organization creates.
   *
   * Ids freed before this table existed are unknown and stay free. Live
   * and stored tasks and projects from before it get their rows from
   * internal/usedIdsBackfill, as do those an earlier release creates after
   * a rollback, once the backfill runs again. */
  used_ids: defineTable({
    table: vUsedIdTable,
    row_id: v.string(), // the task's or project's uuid
    // the organization whose task or project held it, whose teardown deletes the row
    org_id: v.string(),
    // the round (used_id_rounds) of the last teardown that found the id
    // still named outside the organization (model/usedIds.ts heldOutside);
    // such a row stays until a teardown of the organization finds it named
    // nowhere
    kept: v.optional(v.number()),
  })
    // whether any organization, or one, holds an id
    .index('by_row', ['table', 'row_id', 'org_id'])
    // the rows a teardown looks at: never kept, then kept in an earlier round
    .index('by_org_kept', ['org_id', 'kept']),

  /* The round of the teardown that is letting go of an organization's
   * used_ids rows, while it runs (model/usedIds.ts releaseUsedIds). The
   * first step writes it, one past the last round a row was kept in. Each
   * step looks at the rows never kept and those kept in an earlier round,
   * deletes those nothing names and marks the others kept in this round,
   * which takes them out of what the next step reads, so the release goes
   * on past held rows across bounded steps. The step that finds none of
   * those left deletes this row, and only then reports the release done. */
  used_id_rounds: defineTable({
    org_id: v.string(),
    round: v.number(),
  }).index('by_org', ['org_id']),

  /* One light row per stored task, written and deleted with its issues row
   * in deleted_rows: what search, counts and finding a task's item need. */
  deleted_tasks: defineTable({
    org_id: v.string(),
    item_id: v.string(),
    task_id: v.string(),
    num: v.number(),
    title: v.string(),
    project_id: v.string(),
    archived: v.boolean(),
    // a task item's subtask in another project than the item's root: that
    // project, so its lead finds the item (model/deletedItemsList.ts). It is
    // a sibling sub-project of the root's, or, for a subtask from before the
    // subtask rule (model/issues.ts sameTopLevel), any other project.
    cross_project_id: v.optional(v.string()),
  })
    .index('by_task', ['task_id'])
    .index('by_item', ['item_id'])
    .index('by_org_num', ['org_id', 'num'])
    .index('by_org_cross_project', ['org_id', 'cross_project_id'])
    .searchIndex('search_title', { searchField: 'title', filterFields: ['org_id'] }),

  webhook_subscriptions: defineTable({
    id: v.string(),
    org_id: v.string(),
    owner: vEventOwner,
    name: vEventName,
    filters: vEventFilters,
    url: v.string(),
    encrypted_secret: v.string(),
    secret_hash: v.optional(v.string()),
    previous_secret: v.optional(v.string()),
    rotation_until: v.optional(v.number()),
    expires_at: v.optional(v.number()),
    revision: v.optional(v.number()),
    // Legacy fallback for registrations without a separate health row.
    failed_since: v.optional(v.number()),
    last_failure_at: v.optional(v.number()),
    last_success_at: v.optional(v.number()),
    last_status: v.optional(v.number()),
    disabled_at: v.optional(v.number()),
    disabled_reason: v.optional(v.literal('delivery_failures')),
    created_at: v.number(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    .index('by_org_expiry', ['org_id', 'expires_at'])
    .index('by_org_name_expiry', ['org_id', 'name', 'expires_at'])
    .index('by_expiry', ['expires_at']),

  // Frequent acknowledgments must not conflict with task writers reading registrations.
  webhook_health: defineTable({
    subscription_row_id: v.id('webhook_subscriptions'),
    org_id: v.string(),
    failed_since: v.optional(v.number()),
    last_failure_at: v.optional(v.number()),
    last_success_at: v.optional(v.number()),
    last_status: v.optional(v.number()),
  })
    .index('by_subscription', ['subscription_row_id'])
    .index('by_org', ['org_id']),

  // One atomic change with its originally authorized recipients, expanded in bounded batches.
  webhook_events: defineTable({
    id: v.string(),
    org_id: v.string(),
    project_id: v.string(),
    source_project_id: v.optional(v.string()),
    task_id: v.string(),
    name: vEventName,
    payload: v.string(),
    subscription_rows: v.array(v.id('webhook_subscriptions')),
    next_recipient: v.number(),
    created_at: v.number(),
  }).index('by_org', ['org_id']),

  // Background workers share one scheduled reservation each, outside task transactions.
  webhook_workers: defineTable({
    kind: v.union(v.literal('expand'), v.literal('dispatch')),
    generation: v.string(),
    scheduled_job: v.id('_scheduled_functions'),
    rerun: v.boolean(),
  }).index('by_kind', ['kind']),

  webhook_deliveries: defineTable({
    id: v.string(),
    org_id: v.string(),
    subscription_id: v.string(),
    // Optional for existing deliveries, which the dispatcher retires without sending.
    subscription_row_id: v.optional(v.id('webhook_subscriptions')),
    subscription_revision: v.optional(v.number()),
    project_id: v.string(),
    source_project_id: v.optional(v.string()),
    task_id: v.string(),
    name: vEventName,
    payload: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('queued'),
      v.literal('sending'),
      v.literal('delivered'),
      v.literal('failed'),
    ),
    attempts: v.number(),
    lease_until: v.optional(v.number()),
    scheduled_for: v.optional(v.number()),
    scheduled_job: v.optional(v.id('_scheduled_functions')),
    completed_at: v.optional(v.number()),
    last_status: v.optional(v.number()),
    created_at: v.number(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    .index('by_org_status_scheduled', ['org_id', 'status', 'scheduled_for'])
    .index('by_status_scheduled', ['status', 'scheduled_for'])
    .index('by_completed', ['completed_at']),

  activity_events: defineTable({
    id: v.string(),
    org_id: v.string(),
    ts: v.string(), // explicit — seeds backdate it
    actor_id: v.optional(v.string()),
    verb: v.string(),
    target_type: vActivityTarget,
    target_id: v.string(), // uuid-as-text for issues (0026), free text otherwise
    label: v.string(),
    detail: v.optional(v.string()),
    project_id: v.optional(v.string()),
    // Another project the row names, such as a move's destination. Members
    // also need access to it (lib/activityVisibility.ts memberSeesActivity).
    // Like target_id it may outlive its project.
    related_project_id: v.optional(v.string()),
    // The team a membership row describes, or a deleted project's legacy
    // owning team. Like related_project_id it may outlive its team. Only
    // task rows reach clients, so these rows are read in the export only.
    team_id: v.optional(v.string()),
    // On task rows, the QN numbers of the other tasks the detail names, in
    // text order, [] when none. The visibility rule reads it instead of the
    // text, and a task row without it reaches organization admins only
    // (lib/activityVisibility.ts).
    named_task_nums: v.optional(v.array(v.number())),
    // On task rows written since the field check, the print of each field
    // the write changed, by field (lib/fieldPrints.ts), so a refused edit
    // can tell who wrote the stored value (model/expected.ts taskWriters).
    // Only the server reads it: the app's thread and the export strip it.
    field_prints: v.optional(v.record(v.string(), v.string())),
  })
    .index('by_uuid', ['id'])
    .index('by_org_ts', ['org_id', 'ts'])
    .index('by_actor', ['actor_id']) // removeProfile's SET NULL — rows survive their actor
    // One subject's history in insertion order, for its readers (model/activity.ts)
    .index('by_target', ['org_id', 'target_type', 'target_id'])
    // The rows filed under one project, for the project purge
    .index('by_project', ['org_id', 'project_id']),

  comments: commentsTable,

  // One comment count per task (model/commentLimits.ts), so a post checks
  // the cap of LIMITS.comments by reading one row instead of the thread.
  // `count` is how many of the task's rows in comments were created at or
  // before `counted`, and with `counted` absent all of them: the exact
  // count. While `counted` is set a count is under way, and a write moves
  // `count` only for a comment created at or before it. A post never
  // relies on such a row: it counts the rest of the thread first or is
  // refused. No row means the task is not counted yet. The row stays while
  // its task is in Deleted items: a move counts the comments out and a
  // restore counts them back. It goes in the transaction that deletes its
  // task for good, and a row naming another organization than its task's
  // counts nothing, so a task that takes a freed id never adopts it.
  // Server-owned, never sent to clients, REST, MCP, webhooks or the export.
  // Not named comment_counts, a table an earlier release dropped whose rows
  // some deployments may still hold.
  task_comment_counts: defineTable({
    org_id: v.string(),
    issue_id: v.string(), // one row per task, unique by mutation check
    count: v.number(),
    // a comment _creationTime; Number.MIN_SAFE_INTEGER before the first page
    counted: v.optional(v.number()),
    // how many writes moved the count or the comments under it since the row
    // was inserted, never less, so the backfill's dry run can tell a thread
    // that changed while it counted from one that held still
    revision: v.number(),
    // while a count is under way, when it last moved, in server
    // milliseconds, for its recovery; absent once it is exact or stuck
    progress_at: v.optional(v.number()),
    // recoveries since the count last moved; each halves a step's budget
    attempts: v.optional(v.number()),
    // a count whose step kept failing at the smallest budget: recovery
    // leaves it, posts on the task stay refused for now, and the backfill
    // lists it
    stuck: v.optional(v.literal(true)),
  })
    .index('by_issue', ['issue_id'])
    .index('by_org', ['org_id'])
    // the counts under way, least recently moved first (commentLimits.ts recover)
    .index('by_progress', ['progress_at']),

  // The recent posts of one author on one task, for the posting rate
  // (LIMITS.commentRate, model/commentLimits.ts). `posts` holds the server
  // times, in milliseconds and oldest first, of the author's last posts
  // there, at most LIMITS.commentRate.max. `until` is when the newest of
  // them stops counting; the hourly sweep deletes the row after it.
  // Deleting or editing a comment leaves the row alone, so neither gives a
  // post back. The row goes with its task when the task is deleted for good,
  // and one naming another organization counts no post. Server-owned, like
  // task_comment_counts.
  comment_rates: defineTable({
    org_id: v.string(),
    issue_id: v.string(),
    author: v.string(), // the posting profile; one row per author and task
    posts: v.array(v.number()),
    until: v.number(),
  })
    .index('by_author_issue', ['author', 'issue_id'])
    // a task's post logs, deleted with the task
    .index('by_issue', ['issue_id'])
    .index('by_until', ['until'])
    .index('by_org', ['org_id']),

  // Every insert, patch and delete of a message goes through an ItemEdits
  // (model/inboxItems.ts), which keeps the item's inbox_items row, except
  // the teardowns, which delete the items after the messages, and profile
  // removal's patch of actor_id, which no item reads.
  messages: defineTable({
    id: v.string(),
    org_id: v.string(),
    recipient_id: v.string(),
    actor_id: v.optional(v.string()), // absent = machine caller or removed profile
    issue_id: v.string(),
    issue_title: v.string(), // snapshot; clients prefer the live title
    kind: vMessageKind,
    detail: v.string(),
    created_at: v.string(),
    // client-writable (markRead/markUnread; snooze and wake clear it). A
    // write that leaves a row read and not snoozed keeps message_sweeps in
    // step (model/messages.ts noteSweepable).
    read_at: v.optional(v.string()),
    // Snooze: the item is hidden on every client until this ISO instant, when
    // the scheduled messages.wake clears it (or an arrival does — news wakes
    // the row). Every row of one (recipient, issue) item carries the SAME
    // value or none: snooze, wake and postMessage all patch the whole pair.
    snoozed_until: v.optional(v.string()),
    // Stamped by the wake, so clients can float and announce the returned
    // item; the next arrival's own created_at outranks it.
    woke_at: v.optional(v.string()),
    // How many older unread messages of this item the item cap deleted
    // (model/messages.ts trimRows), kept on the item's newest unread row,
    // which the bounded inbox reads always hold when they list the item.
    // The app, REST and MCP show the sum over an item's unread rows, so
    // nobody loses an update without a word.
    dropped: v.optional(v.number()),
  })
    .index('by_uuid', ['id'])
    .index('by_recipient', ['recipient_id'])
    .index('by_recipient_read', ['recipient_id', 'read_at'])
    // a recipient's unsnoozed rows, unread first and then oldest read
    // first, which the nightly sweep (jobs.ts oldestDue and sweepProfile),
    // Mark all as read and Remove all read (model/messages.ts
    // markAllMessagesRead, removeReadMessages) read without passing over the
    // snoozed ones
    .index('by_recipient_snoozed_read', ['recipient_id', 'snoozed_until', 'read_at'])
    .index('by_recipient_issue', ['recipient_id', 'issue_id'])
    .index('by_recipient_issue_read_order', [
      'recipient_id',
      'issue_id',
      'read_at',
      'created_at',
      'id',
    ])
    // a task's messages; also the unread ones alone (read_at absent), which
    // the archive steps mark read without scanning rows already read
    .index('by_issue_read', ['issue_id', 'read_at'])
    // the snoozed ones, which an archive step also releases
    .index('by_issue_snoozed', ['issue_id', 'snoozed_until'])
    .index('by_actor', ['actor_id']) // messages_actor_idx — removeProfile's SET NULL
    // the nightly sweep's fallback wake finds the overdue snoozes of every
    // recipient in one range
    .index('by_snoozed', ['snoozed_until']),

  // When the nightly read-message sweep next visits a profile (jobs.ts
  // sweepReadMessages): no later than the oldest of its read, unsnoozed
  // messages falls due under its retention period. At most one row per
  // profile, and none for a profile with nothing the sweep could delete.
  // The writes that make a message read keep it in step
  // (model/messages.ts noteSweepable), and the sweep moves it to the next
  // due time or deletes it. Deleted with its profile.
  message_sweeps: defineTable({
    profile_id: v.string(),
    due_at: v.string(), // ISO instant
  })
    .index('by_profile', ['profile_id'])
    .index('by_due', ['due_at']),

  // At most one row: the run of the read-message sweep's last finished full
  // pass, which gave every profile with a read message under a retention
  // period a message_sweeps row due no later than that message. A run
  // starts with the full pass when this row is missing or older than
  // jobs.ts SWEEP_FULL_AFTER_MS (sweepReadMessages).
  message_sweep_seeds: defineTable({
    seeded_at: v.string(), // ISO instant, the run's start
  }),

  // One row per inbox item, the (recipient, task) pair of messages the app
  // lists as one row, holding what a page of items, its filters and the
  // capped unread count need without reading the messages. Every field is
  // a function of the pair's messages (model/inboxItems.ts itemOf), and
  // every message write keeps it so once the recipient's inbox_state says
  // the pair is built. The row goes when the item's last message goes, and
  // never comes back with a restore, as messages do not. convex/inbox.ts
  // reads the rows for the capped unread summary and one task's item
  // (model/inboxReads.ts), and answers that a profile is not ready while
  // its inbox_state is not built. The app does not show those reads yet.
  // The app, REST and MCP read the messages until a later release switches
  // them, once every deployment has run internal/inboxItemsBackfill.
  inbox_items: defineTable({
    recipient_id: v.string(),
    issue_id: v.string(),
    // The task's project at the item's last arrival, build or re-key, absent
    // when a build found the task not live. Other writes keep it. A move
    // re-keys it, inline up to a budget and then in background steps
    // (model/inboxItems.ts rekeyItems), so readers check it against the
    // task.
    project_id: v.optional(v.string()),
    // The list order: the newest message's created_at, or woke_at when the
    // item returned from a snooze later, as the app's `ts` (store/viewModels.ts
    // shapeMessageGroup).
    sort_at: v.string(),
    // The newest message by (created_at, id), the order the prune keeps.
    latest_id: v.string(),
    latest_at: v.string(), // its created_at
    unread: v.boolean(), // unread_count > 0, for the indexes
    unread_count: v.number(),
    // The item's dropped counts summed over its unread messages (schema.ts
    // messages.dropped), the earlier updates the item cap deleted.
    dropped: v.number(),
    // Messages of each kind, which the Inbox kind filter reads. Their sum is
    // the item's message count, so an item at zero is deleted.
    mentions: v.number(),
    changes: v.number(),
    comments: v.number(),
    snoozed: v.boolean(), // snoozed_until is set, for the indexes
    snoozed_until: v.optional(v.string()), // the newest message's
    // The latest wake's stamp while one of its messages remains, and how
    // many do, so sort_at follows when the last of them goes. A wake stamps
    // every message of the item alike.
    woke_at: v.optional(v.string()),
    woke_rows: v.number(),
  })
    .index('by_recipient_issue', ['recipient_id', 'issue_id'])
    // a task's items, for the teardowns and the move's re-key, which reads
    // only those whose project_id differs from the task's
    .index('by_issue_project', ['issue_id', 'project_id'])
    // a page of the list, newest or oldest first, snoozed items as their own
    // range
    .index('by_recipient_list', ['recipient_id', 'snoozed', 'sort_at', 'issue_id'])
    // Unread only
    .index('by_recipient_unread_list', ['recipient_id', 'snoozed', 'unread', 'sort_at', 'issue_id'])
    // the capped unread count, which skips a project it may not count with
    // one seek
    .index('by_recipient_unread_project', ['recipient_id', 'unread', 'snoozed', 'project_id']),

  // Whether a profile's inbox_items rows are complete, at most one row per
  // profile. internal/inboxItemsBackfill builds a profile's items in task id
  // order and records the last task it built in `built_through`, then sets
  // `built`. A message write keeps an item only while this row covers its
  // task, and the backfill reads the messages it builds from in the same
  // transaction that moves the row, so Convex orders every write before or
  // after a build and no change is lost or counted twice. A profile with no
  // row has no complete items, except that the first message to a profile
  // without messages adds the row, built (model/inboxItems.ts
  // ensureInboxState). Deleted with its profile.
  inbox_state: defineTable({
    profile_id: v.string(),
    built: v.boolean(),
    built_through: v.optional(v.string()), // an issue_id, while built is false
  }).index('by_profile', ['profile_id']),

  user_prefs: defineTable({
    profile_id: v.string(),
    prefs: v.any(),
    updated_at: v.string(),
    // excluded from the snapshot query on purpose (0036)
  }).index('by_profile', ['profile_id']),

  /* `org_id` and `name_key` on agent keys and personal tokens are
   * server-owned and written with the row: the owner profile's organization,
   * which never changes, and the name as name-ordered lists sort and search
   * it (lib/nameKey.ts), which never changes either, because a credential
   * cannot be renamed. API access pages read them by organization or by
   * person in name order. Never sent to clients, REST, MCP, webhooks or the
   * export. A row stored before they existed has neither until
   * internal/credentialKeysBackfill gives it both, so a reader that pages by
   * organization first checks that no row of its organization's live
   * profiles is left without an org_id: it reads the rows of by_org_name
   * with org_id undefined, a few at most, and their owners (apiAccess.ts
   * credentialsKeyed). */
  agent_keys: defineTable({
    id: v.string(),
    profile_id: v.string(), // always a kind='agent' profile
    org_id: v.optional(v.string()), // the agent's
    name: v.string(),
    name_key: v.optional(v.string()),
    key_prefix: v.string(), // safe first/last fingerprint of the qva_ secret, display only
    // sha256 hex, unique-checked on by_hash; secret never stored. A pending
    // test credential holds 'pending:' + the hash (machine/testing.ts).
    key_hash: v.string(),
    created_by: v.optional(v.string()),
    created_at: v.string(),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_profile', ['profile_id'])
    .index('by_hash', ['key_hash'])
    .index('by_created_by', ['created_by']) // removeProfile's SET NULL
    // API access: the organization's keys, or one agent's, in name order
    .index('by_org_name', ['org_id', 'name_key', 'id'])
    .index('by_profile_name', ['profile_id', 'name_key', 'id']),

  mcp_tokens: defineTable({
    id: v.string(),
    profile_id: v.string(),
    org_id: v.optional(v.string()), // the owner profile's, as on agent_keys
    name: v.string(),
    name_key: v.optional(v.string()), // as on agent_keys
    token_prefix: v.string(), // first chars of the qvt_ secret, display only
    // sha256 hex, unique-checked on by_hash; secret never stored. A pending
    // test credential holds 'pending:' + the hash (machine/testing.ts).
    token_hash: v.string(),
    // What the token may do (lib/access.ts credentialAccess). A missing value
    // means read, so the rule fails closed and tokens minted before this field
    // existed can only read. Optional only so those rows still validate.
    access: v.optional(vCredentialAccess),
    // ISO-8601 UTC. Absent means the token never expires; after it, the token
    // is refused like a revoked one.
    expires_at: v.optional(v.string()),
    created_at: v.string(),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
    // Set when an organization admin revoked the token on API access
    // (apiAccess.ts), so its owner sees who ended it.
    revoked_by_admin: v.optional(v.literal(true)),
  })
    .index('by_uuid', ['id'])
    // also the owner's own list, newest first: insertion order is created_at order
    .index('by_profile', ['profile_id'])
    .index('by_hash', ['token_hash'])
    // API access: the organization's tokens, or one person's, in name order
    .index('by_org_name', ['org_id', 'name_key', 'id'])
    .index('by_profile_name', ['profile_id', 'name_key', 'id']),

  // One immutable authorization transaction, bound to the consenting home seat.
  // Revocation is permanent; reconnecting creates a different transaction/id.
  oauth_connections: defineTable({
    id: v.string(),
    authorization_hash: v.string(),
    auth_user_id: v.string(),
    profile_id: v.string(),
    org_id: v.string(),
    client_id: v.string(),
    client_name: v.string(),
    // client_name as name-ordered lists sort and search it (lib/nameKey.ts),
    // server-owned and written with the row, unfinished authorizations
    // included; client_name never changes. Never sent to clients or the
    // export. A row stored before it existed has none until
    // internal/credentialKeysBackfill gives it one, so a reader that pages
    // in name order first checks that none of its organization's rows is
    // left without one (one read of by_org_name with name_key undefined).
    name_key: v.optional(v.string()),
    resource: v.string(),
    requested_scopes: v.array(v.string()),
    scopes: v.array(v.string()),
    created_at: v.string(),
    authorization_expires_at: v.string(),
    approved_at: v.optional(v.string()),
    code_used_at: v.optional(v.string()),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
    // 'deleted' by the owner or a profile removal (hidden from the owner's
    // list), 'admin' from API access (apiAccess.ts), 'credential_replay',
    // 'fixture_retirement' or 'client_deleted' when Better Auth deletes its
    // client (authTriggers.ts).
    revocation_reason: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_authorization', ['authorization_hash'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_profile', ['profile_id'])
    // OAuth client cleanup keeps a client with an approved connection or a
    // pending authorization (oauthRegistrations.ts).
    .index('by_client', ['client_id', 'approved_at', 'authorization_expires_at'])
    // API access: the organization's connections, or one person's, in name
    // order. Unfinished authorizations are in these ranges too; readers skip
    // the rows without approved_at.
    .index('by_org_name', ['org_id', 'name_key', 'id'])
    .index('by_profile_name', ['profile_id', 'name_key', 'id'])
    // The login's connected apps, newest approval first. A range from
    // approved_at '' reads approved connections only, so the unfinished
    // authorizations every consent attempt leaves are never read.
    .index('by_auth_user_approved', ['auth_user_id', 'approved_at']),

  // Retained hash tombstones catch replay even after the provider deletes its
  // code/refresh rows. Never store a bearer credential here. A used refresh
  // token's hash is kept while the token could still be accepted, plus a
  // day, and a code's for the connection's life (authRetention.ts
  // expireTokens).
  oauth_credential_uses: defineTable({
    connection_id: v.string(),
    credential_hash: v.string(),
    kind: v.union(v.literal('authorization_code'), v.literal('refresh_token')),
    used_at: v.optional(v.string()),
  })
    .index('by_hash', ['kind', 'credential_hash'])
    .index('by_connection', ['connection_id'])
    .index('by_used', ['kind', 'used_at']),

  // A browser session that ended, such as at sign-out or a ban. The OAuth
  // access tokens issued in it before `ended_at` are refused
  // (oauthAccess.ts lookupAccess). The row goes once every such token
  // has expired (lib/sessionEnd.ts endSessionAccess).
  oauth_ended_sessions: defineTable({
    session_id: v.string(),
    ended_at: v.number(),
  }).index('by_session', ['session_id']),

  // Curated platform backgrounds. Removed rows keep provenance + hashes so a
  // declined photo cannot be silently reimported. Their bytes are deleted.
  panorama_images: defineTable({
    id: v.string(),
    source_id: v.string(),
    source_url: v.string(),
    download_url: v.string(),
    title: v.string(),
    location: v.optional(v.string()),
    creator: v.string(),
    filename: v.optional(v.string()),
    license: v.string(),
    license_url: v.string(),
    attribution: v.string(),
    source_metadata: v.string(),
    storage_id: v.optional(v.id('_storage')),
    preview_storage_id: v.optional(v.id('_storage')),
    preview_version: v.optional(v.number()),
    sha256: v.string(),
    width: v.number(),
    height: v.number(),
    byte_size: v.number(),
    status: vPanoramaStatus,
    imported_at: v.string(),
    reviewed_at: v.optional(v.string()),
    reviewed_by: v.optional(v.string()),
    review_note: v.optional(v.string()),
    agent_review: v.optional(v.union(v.literal('approved'), v.literal('declined'))),
    agent_review_note: v.optional(v.string()),
    agent_reviewed_at: v.optional(v.string()),
    agent_review_id: v.optional(v.string()),
    agent_reviewer: v.optional(v.string()),
    requested_day: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_source', ['source_id'])
    .index('by_hash', ['sha256'])
    .index('by_status', ['status'])
    .index('by_status_agent_review', ['status', 'agent_review'])
    .index('by_storage', ['storage_id'])
    .index('by_preview_storage', ['preview_storage_id']),

  panorama_calendar: defineTable({
    day: v.string(), // W01–W53 recurring ISO week; legacy MM-DD maps through 2026
    image_id: v.string(),
    updated_at: v.string(),
    updated_by: v.string(),
  })
    .index('by_day', ['day'])
    .index('by_image', ['image_id']),

  // Explicit platform curation authority, separate from org agent/MCP keys.
  // Secrets are revealed once; only SHA-256 + a display fingerprint persist.
  panorama_curation_keys: defineTable({
    id: v.string(),
    name: v.string(),
    key_hash: v.string(),
    key_prefix: v.string(),
    created_by: v.string(), // historical Better Auth login, not an org profile
    created_by_email: v.string(),
    created_at: v.string(),
    expires_at: v.string(),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
    request_window_at: v.optional(v.number()),
    request_count: v.optional(v.number()),
  })
    .index('by_uuid', ['id'])
    .index('by_hash', ['key_hash'])
    .index('by_creator', ['created_by']),

  panorama_submissions: defineTable({
    id: v.string(),
    key_id: v.string(),
    request_id: v.string(),
    payload_json: v.string(),
    source_url: v.string(),
    source_id: v.string(),
    day: v.string(),
    title: v.optional(v.string()),
    creator: v.optional(v.string()),
    reason: v.optional(v.string()),
    submitted_at: v.string(),
    submitted_by: v.string(),
    status: v.union(
      v.literal('needs_file'),
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('declined'),
    ),
    image_id: v.optional(v.string()),
    agent_review: v.optional(v.union(v.literal('approved'), v.literal('declined'))),
    agent_review_note: v.optional(v.string()),
    agent_reviewed_at: v.optional(v.string()),
    agent_review_id: v.optional(v.string()),
    agent_reviewer: v.optional(v.string()),
    reviewed_at: v.optional(v.string()),
    reviewed_by: v.optional(v.string()),
    review_note: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_key_request', ['key_id', 'request_id'])
    .index('by_status', ['status'])
    .index('by_image', ['image_id']),

  panorama_library: defineTable({
    key: v.literal('default'),
    pending: v.number(),
    approved: v.number(),
    removed: v.number(),
    // Operator-selected approved fallback for dates without an available image.
    default_image_id: v.optional(v.string()),
    // Retired Commons-import state is retained for existing rows only. New
    // libraries omit these fields; no function reads or writes them.
    target: v.optional(v.number()),
    refill_batch_size: v.optional(v.number()),
    cursor: v.optional(v.object({ category: v.number(), continue: v.optional(v.string()) })),
    active_run_id: v.optional(v.string()),
    lease_until: v.optional(v.number()),
  }).index('by_key', ['key']),

  // Historical Commons import records. The importer and its cron are retired;
  // preserve these rows alongside the existing image provenance and audit log.
  panorama_refills: defineTable({
    id: v.string(),
    trigger: v.union(v.literal('manual'), v.literal('daily')),
    actor_auth_id: v.optional(v.string()),
    actor_email: v.optional(v.string()),
    status: v.union(v.literal('running'), v.literal('completed'), v.literal('failed')),
    added: v.number(),
    skipped: v.number(),
    pages: v.number(),
    retries: v.number(),
    started_at: v.string(),
    finished_at: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index('by_uuid', ['id']),

  // Platform tables: never returned by public functions; reached only through
  // the platformQuery/platformMutation wrappers (the `private` schema's successor).
  platform_admins: defineTable({
    auth_user_id: v.string(), // Better Auth user id
    note: v.string(),
    created_at: v.string(),
  }).index('by_auth_user', ['auth_user_id']),

  // Rows are deleted once they are 90 days old (auditRetention.ts).
  platform_audit_log: defineTable({
    ts: v.string(),
    actor_auth_id: v.optional(v.string()),
    actor_email: v.string(),
    action: v.string(),
    target_org_id: v.optional(v.string()),
    target_profile_id: v.optional(v.string()),
    // 'app' marks the app's own invitation emails; operator rows have none
    channel: v.optional(v.literal('app')),
    detail: v.any(),
  })
    .index('by_ts', ['ts'])
    // The operator's audit listing reads the rows without a channel.
    .index('by_channel_ts', ['channel', 'ts'])
    // A pending seat's latest invite email, and the caps on the app's
    // invitation email per seat and per organization (invites.ts).
    .index('by_target_profile', ['target_profile_id', 'ts'])
    // A pending seat's newest invite email, past its other entries (invites.ts).
    .index('by_target_profile_action', ['target_profile_id', 'action', 'ts'])
    .index('by_target_org', ['target_org_id', 'ts']),
})
