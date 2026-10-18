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
  vCredentialAccess,
  vCredentialTable,
  vDeletedItemKind,
  vDeletedItemState,
  vGrantLevel,
  vImageSource,
  vIssuePriority,
  vIssueStatus,
  vLinkType,
  vMessageKind,
  vOrgRemovalPhase,
  vOrgRemovalReason,
  vOrgRole,
  vProfileKind,
  vProjectCreators,
  vProjectType,
  vRemovalPhase,
  vStoredTable,
  vTrashPhase,
} from './lib/enums'
import { vPanoramaStatus } from './lib/panorama'
import { vEventFilters, vEventName, vEventOwner } from './lib/taskEvents'

/* `task_archived` on a task's relation rows (links, label assignments, follows
 * and attachments) marks a row the app snapshot skips by index
 * (convex/snapshot.ts, lib/snapshotRelations.ts). Only a background step sets
 * it, for a task it finds archived in its own transaction, and that step also
 * sets the task's `relations_marked`. After a restore, other steps clear the
 * marks, and only the one that finds none left while the task is active
 * unsets the flag (model/archiveMarks.ts). Every marked row therefore belongs
 * to a task with relations_marked, a link through at least one end, and the
 * snapshot reads an active task with the flag through its own indexes, which
 * include marked rows. A row written after the archive, or before marks
 * existed, stays unmarked, and readers filter it as before. Every other
 * reader sees marked rows like any other. */
const taskArchived = v.optional(v.literal(true))

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
  description: v.string(), // PROJECT_DESCRIPTION_MAX UTF-16 units, enforced by model/projects
  sort_order: v.number(),
  num: v.number(), // org-scoped, assigned by counter, immutable
  icon: v.optional(v.string()), // sub-projects carry no icon (0069)
  icon_color: v.optional(v.string()),
  track_delay: v.boolean(),
  // remaining time a task gets on entering Review; absent = the parent
  // project's value, else DEFAULT_REVIEW_HOURS (2); 0..REVIEW_HOURS_MAX
  // (999), 0.1 h grain
  review_hours: v.optional(v.number()),
  archived_at: v.optional(v.string()),
  created_at: v.string(),
})
  .index('by_uuid', ['id'])
  .index('by_org', ['org_id'])
  .index('by_org_key', ['org_id', 'key'])
  .index('by_org_num', ['org_id', 'num'])
  .index('by_parent', ['parent_id'])
  .index('by_team', ['team_id'])
  .index('by_lead', ['lead_id']) // projects_lead_idx — removeProfile's SET NULL

const projectAccessTable = defineTable({
  project_id: v.string(), // explicit grants may target a project or sub-project
  profile_id: v.string(),
  level: vGrantLevel, // the validator IS project_access_level_ck
})
  .index('by_project', ['project_id'])
  .index('by_profile', ['profile_id'])
  .index('by_project_profile', ['project_id', 'profile_id'])

const projectTeamAccessTable = defineTable({
  project_id: v.string(), // explicit shares may target a project or sub-project
  team_id: v.string(), // same organization as the project
  level: vGrantLevel,
})
  .index('by_project', ['project_id'])
  .index('by_team', ['team_id'])
  .index('by_project_team', ['project_id', 'team_id'])

const issuesTable = defineTable({
  id: v.string(),
  project_id: v.string(), // always a sub-project, never a meta
  org_id: v.string(), // denormalized, pinned from the project, immutable
  num: v.number(), // org-scoped, assigned by counter, immutable
  title: v.string(), // ≤80 chars (0061)
  description: v.string(),
  status: vIssueStatus,
  priority: vIssuePriority,
  assignee_id: v.optional(v.string()), // same org, active, never a viewer
  // same rule as the assignee (same org, active, never a viewer, Edit+);
  // owns the task while it is In Review (lib/review.ts)
  reviewer_id: v.optional(v.string()),
  parent_id: v.optional(v.string()), // no self-parent, cycle walk ≤20, same org
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
  // Done, cleared by any other move out, never on a group
  review_at: v.optional(v.string()),
  archived_at: v.optional(v.string()),
  // server-owned: some relation rows of this task may carry task_archived
  // (above). Never sent to clients, REST, MCP, webhooks or the export.
  relations_marked: v.optional(v.literal(true)),
  created_at: v.string(),
  updated_at: v.string(),
})
  .index('by_uuid', ['id'])
  .index('by_org', ['org_id'])
  // The working snapshot and planning reads do not scan archived task bodies.
  .index('by_org_archived', ['org_id', 'archived_at'])
  // The nightly archive reads only Done tasks past the shortest threshold.
  .index('by_org_archived_status_done', ['org_id', 'archived_at', 'status', 'done_at'])
  // The nightly repair finds active tasks still flagged relations_marked.
  .index('by_org_archived_marked', ['org_id', 'archived_at', 'relations_marked'])
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

const issueLinksTable = defineTable({
  org_id: v.optional(v.string()),
  id: v.string(),
  source_id: v.string(), // source <> target; 'relates' stored with source < target
  target_id: v.string(),
  type: vLinkType,
  // sorted `${min(source,target)}:${max(...)}` — at most one link per pair,
  // unique-checked on by_pair (replaces the (least, greatest) unique index)
  pair_key: v.string(),
  created_at: v.string(),
  task_archived: taskArchived,
})
  // The snapshot's org-wide read of unmarked rows (org, mark), and the
  // archive steps' reads of one end's unmarked or marked rows (all three).
  .index('by_org_task_archived_source', ['org_id', 'task_archived', 'source_id'])
  .index('by_org_task_archived_target', ['org_id', 'task_archived', 'target_id'])
  .index('by_uuid', ['id'])
  .index('by_source', ['source_id'])
  .index('by_target', ['target_id'])
  .index('by_pair', ['pair_key'])

const issueLabelsTable = defineTable({
  org_id: v.optional(v.string()),
  issue_id: v.string(), // label and issue must share an org
  label_id: v.string(),
  task_archived: taskArchived,
})
  .index('by_org_task_archived_issue', ['org_id', 'task_archived', 'issue_id'])
  .index('by_issue', ['issue_id'])
  // a label's assignments; REST and MCP search read only its unmarked ones
  .index('by_label', ['label_id', 'task_archived'])
  .index('by_issue_label', ['issue_id', 'label_id'])

const issueSubscriptionsTable = defineTable({
  issue_id: v.string(),
  profile_id: v.string(), // recipient must be able to see the project
  created_at: v.string(),
  task_archived: taskArchived,
})
  // a task's follows, and the archive steps' unmarked or marked ones
  .index('by_issue_task_archived', ['issue_id', 'task_archived'])
  // the snapshot reads one's unmarked follows; profile cleanup takes the
  // whole profile range
  .index('by_profile_task_archived', ['profile_id', 'task_archived'])
  .index('by_issue_profile', ['issue_id', 'profile_id'])

const issueAttachmentsTable = defineTable({
  org_id: v.optional(v.string()),
  // The task's project. attachFileCore and moveIssueCore keep it equal to
  // issues.project_id, so storage totals group by project without reading
  // tasks (model/billing.ts storageUsage). Any new code that changes a
  // task's project or writes attachment rows back must set it too, as a
  // restore from Deleted items does (model/deletedItems.ts writeRowBack).
  // Rows stored before it existed lack it until
  // internal/attachmentScopeBackfill fills them, and readers use the task's
  // project meanwhile.
  project_id: v.optional(v.string()),
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
})
  .index('by_org_task_archived_issue', ['org_id', 'task_archived', 'issue_id'])
  // An organization's rows in the order they were stored. Archiving a task
  // moves its rows within by_org_task_archived_issue but not here, so the
  // billing storage sample pages through this one (model/billing.ts
  // storagePage).
  .index('by_org', ['org_id'])
  .index('by_uuid', ['id'])
  .index('by_issue', ['issue_id'])
  .index('by_storage', ['storage_id'])
  .index('by_uploaded_by', ['uploaded_by']) // removeProfile's SET NULL

const milestonesTable = defineTable({
  id: v.string(),
  project_id: v.string(), // writes store a top-level project (model/milestones.ts)
  name: v.string(),
  week: v.string(), // YYYY-MM-DD calendar day, usually the first day of its week
  created_at: v.string(),
})
  .index('by_uuid', ['id'])
  .index('by_project', ['project_id'])

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
    expiry_scheduled_id: v.optional(v.id('_scheduled_functions')),
    cleanup_phase: v.optional(v.string()),
    cleanup_parent: v.optional(v.string()),
    cleanup_progress_at: v.optional(v.number()),
    cleanup_scheduled_id: v.optional(v.id('_scheduled_functions')),
    cleanup_file_after: v.optional(v.number()),
    cleanup_file_cursor: v.optional(v.string()),
    cleanup_file_wait_until: v.optional(v.number()),
    write_window_at: v.optional(v.number()),
    write_window_count: v.optional(v.number()),
    write_count: v.optional(v.number()),
    insert_count: v.optional(v.number()),
    metrics_counted_at: v.optional(v.number()),
    visitor_browser: v.optional(v.string()),
    visitor_os: v.optional(v.string()),
    visitor_country: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_org', ['org_id'])
    .index('by_expiry', ['expires_at'])
    .index('by_status_progress', ['status', 'cleanup_progress_at'])
    .index('by_status_expiry', ['status', 'expires_at']),

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
    state: v.union(v.literal('empty'), v.literal('ready')),
    version: v.number(),
    anchor: v.optional(v.string()),
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
    updated_at: v.string(),
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    .index('by_provider', ['polar_subscription_id']),

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
    created_at: v.string(),
  })
    .index('by_subscription_period', ['subscription_id', 'period_start'])
    .index('by_org', ['org_id']),

  // API calls per credential and bucket. `period_start` is the bucket key
  // chosen by `usagePeriod` (model/billingUsage.ts): a paid period's ISO start,
  // a pending interval's ISO start, or `month:YYYY-MM` for a UTC calendar month
  // without a paid period. Older rows may be keyed by `complimentary_start`.
  billing_usage: defineTable({
    org_id: v.string(),
    profile_id: v.string(),
    credential_id: v.string(),
    credential_name: v.string(),
    period_start: v.string(),
    calls: v.number(),
  })
    .index('by_org_period', ['org_id', 'period_start'])
    .index('by_credential_period', ['credential_id', 'period_start'])
    .index('by_subject_credential_period', [
      'org_id',
      'profile_id',
      'credential_id',
      'period_start',
    ]),

  billing_usage_totals: defineTable({
    org_id: v.string(),
    period_start: v.string(),
    calls: v.number(),
    reported_api_blocks: v.number(),
  }).index('by_org_period', ['org_id', 'period_start']),

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

  billing_webhooks: defineTable({
    event_id: v.string(),
    subscription_id: v.string(),
    received_at: v.string(),
  }).index('by_event', ['event_id']),

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

  organizations: defineTable({
    id: v.string(),
    name: v.string(),
    slug: v.string(), // lowercase; shape + reserved list checked in model/orgs
    created_at: v.string(),
    // Legacy. The activity row count retention kept before the background
    // trim (model/activity.ts). Only the backfill reads it, to clear it.
    activity_count: v.optional(v.number()),
    // Legacy. Moved to org_counters by the organization's first task or
    // project number, or by internal/orgCountersBackfill. Only model/orgs
    // and the backfill read them.
    next_issue_num: v.optional(v.number()),
    next_project_num: v.optional(v.number()),
    date_format: v.string(),
    week_start: v.number(),
    week_one_rule: v.string(), // jan1 | first4day | firstfull
    default_plannable_hours: v.number(), // whole hours (0095)
    gravatar_avatars: v.boolean(),
    // Org-wide upload cap, 1..20 MiB. Older organizations default to 20.
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
    created_at: v.string(),
  })
    .index('by_org', ['org_id'])
    .index('by_progress', ['progress_at']),

  // Per-organization number counters (model/orgs.ts). Task and project
  // creation write this row instead of the organization row, which every
  // settings read and every member's snapshot depend on. Only model/orgs.ts
  // writes it; numbers are dense at assignment and never reused.
  org_counters: defineTable({
    org_id: v.string(),
    next_issue_num: v.number(),
    next_project_num: v.number(),
  }).index('by_org', ['org_id']),

  // Activity retention (model/activity.ts). The row holds trim_due_at while a
  // trim of the organization's activity is scheduled. Writers then only read
  // the row, so concurrent activity writes do not conflict.
  activity_retention: defineTable({
    org_id: v.string(),
    trim_due_at: v.optional(v.number()), // epoch ms; absent = no trim pending
  }).index('by_org', ['org_id']),

  teams: defineTable({
    id: v.string(),
    org_id: v.string(),
    name: v.string(),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    // Ignored legacy column: optional so existing demo rows remain valid.
    // Only organizations.max_attachment_mb controls uploads; no team setter.
    max_attachment_mb: v.optional(v.number()),
    stale_days: v.number(),
    archive_days: v.number(),
    track_delay_default: v.boolean(),
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id']),

  team_members: defineTable({
    team_id: v.string(),
    profile_id: v.string(),
    is_leader: v.boolean(),
  })
    .index('by_team', ['team_id'])
    .index('by_profile', ['profile_id'])
    .index('by_team_profile', ['team_id', 'profile_id']),

  profiles: defineTable({
    id: v.string(),
    auth_user_id: v.optional(v.string()), // Better Auth user id; absent = unclaimed seat
    org_id: v.string(),
    email: v.optional(v.string()), // lowercase; (kind='agent') = (email absent) (0104)
    name: v.string(), // non-blank, ≤80 codepoints (0116)
    initials: v.string(), // 1–3 chars; derived on rename, hand-picked values stand
    color: v.string(),
    org_role: vOrgRole, // agents are never admin or guest (0100/0102)
    active: v.boolean(),
    kind: vProfileKind,
    plannable_hours: v.optional(v.number()), // whole hours; agents have none (0103)
    message_retention_days: v.optional(v.number()), // 1..3650; absent = keep forever
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
    // Team sync (lib/teamSync.ts): the latest change made on this person through
    // the sync page (server clock), and the reading point of the sitting that
    // change belongs to: the previous sitting's last change, or in a first
    // sitting the day the page read from (YYYY-MM-DD); absent = the default.
    sync_at: v.optional(v.string()),
    sync_since: v.optional(v.string()),
    // The per-user project-creation right. It only counts for a standard
    // user, person or agent, while project_creators is 'selected'; absent =
    // off.
    can_create_projects: v.optional(v.boolean()),
    created_at: v.string(),
    // uniqueness (mutation-checked): (org_id, email), (org_id, auth_user_id),
    // and at most one accepted non-guest seat per login across all orgs
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
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
  })
    .index('by_profile', ['profile_id'])
    .index('by_progress', ['progress_at']),

  projects: projectsTable,
  project_access: projectAccessTable,
  project_team_access: projectTeamAccessTable,
  issues: issuesTable,
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
    .index('by_org_name_lower', ['org_id', 'name_lower']),

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
  })
    .index('by_uuid', ['id'])
    .index('by_profile_expiry', ['profile_id', 'expires_at'])
    .index('by_expiry', ['expires_at']),

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
    // into the item's projects (or 0) and the _creationTime last done there.
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
    .index('by_row', ['table', 'row_id'])
    .index('by_storage', ['storage_id'])
    .index('by_org_key', ['org_id', 'project_key'])
    .index('by_org_lead', ['org_id', 'lead_id'])
    .index('by_org', ['org_id']),

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
    // also need access to it (snapshot.ts memberSeesActivity). Like target_id
    // it may outlive its project.
    related_project_id: v.optional(v.string()),
    // The team a membership row describes, or a deleted project's legacy
    // owning team. Like related_project_id it may outlive its team; a deleted
    // team's membership rows then reach admins only (snapshot.ts).
    team_id: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_org_ts', ['org_id', 'ts'])
    .index('by_actor', ['actor_id']), // removeProfile's SET NULL — rows survive their actor

  comments: commentsTable,

  // How many comments a task holds, for the per-task cap
  // (model/commentCounts.ts). It is its own table and not a task field,
  // because the app snapshot reads every active task and no other write
  // changes the task when a comment is posted. A task without a row is not
  // counted yet. While `cursor` is set, `count` covers the comments before
  // that position in the by_issue index, and later steps count the rest.
  comment_counts: defineTable({
    issue_id: v.string(),
    count: v.number(),
    cursor: v.optional(v.string()),
  }).index('by_issue', ['issue_id']),

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
    read_at: v.optional(v.string()), // client-writable (markRead/markUnread; snooze and wake clear it)
    // Snooze: the item is hidden on every client until this ISO instant, when
    // the scheduled messages.wake clears it (or an arrival does — news wakes
    // the row). Every row of one (recipient, issue) item carries the SAME
    // value or none: snooze, wake and postMessage all patch the whole pair.
    snoozed_until: v.optional(v.string()),
    // Stamped by the wake, so clients can float and announce the returned
    // item; the next arrival's own created_at outranks it.
    woke_at: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_recipient', ['recipient_id'])
    .index('by_recipient_read', ['recipient_id', 'read_at'])
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
    // the nightly sweep's fallback wake finds a recipient's overdue snoozes
    .index('by_recipient_snoozed', ['recipient_id', 'snoozed_until']),

  user_prefs: defineTable({
    profile_id: v.string(),
    prefs: v.any(),
    updated_at: v.string(),
    // excluded from the snapshot query on purpose (0036)
  }).index('by_profile', ['profile_id']),

  agent_keys: defineTable({
    id: v.string(),
    profile_id: v.string(), // always a kind='agent' profile
    name: v.string(),
    key_prefix: v.string(), // safe first/last fingerprint of the qva_ secret, display only
    key_hash: v.string(), // sha256 hex, unique-checked on by_hash; secret never stored
    created_by: v.optional(v.string()),
    created_at: v.string(),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_profile', ['profile_id'])
    .index('by_hash', ['key_hash'])
    .index('by_created_by', ['created_by']), // removeProfile's SET NULL

  mcp_tokens: defineTable({
    id: v.string(),
    profile_id: v.string(),
    name: v.string(),
    token_prefix: v.string(), // first chars of the qvt_ secret, display only
    token_hash: v.string(), // sha256 hex, unique-checked on by_hash; secret never stored
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
    .index('by_profile', ['profile_id'])
    .index('by_hash', ['token_hash']),

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
    // list), 'admin' from API access (apiAccess.ts), 'credential_replay' or
    // 'fixture_retirement'.
    revocation_reason: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_authorization', ['authorization_hash'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_profile', ['profile_id'])
    // OAuth client cleanup keeps a client with an approved connection or a
    // pending authorization (oauthRegistrations.ts).
    .index('by_client', ['client_id', 'approved_at', 'authorization_expires_at']),

  // Retained hash tombstones catch replay even after the provider deletes its
  // code/refresh rows. Never store a bearer credential here.
  oauth_credential_uses: defineTable({
    connection_id: v.string(),
    credential_hash: v.string(),
    kind: v.union(v.literal('authorization_code'), v.literal('refresh_token')),
    used_at: v.optional(v.string()),
  })
    .index('by_hash', ['kind', 'credential_hash'])
    .index('by_connection', ['connection_id']),

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
    .index('by_target_org', ['target_org_id', 'ts']),
})
