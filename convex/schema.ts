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
  vGrantLevel,
  vImageSource,
  vIssuePriority,
  vIssueStatus,
  vLinkType,
  vMessageKind,
  vOrgRole,
  vProfileKind,
  vProjectType,
} from './lib/enums'
import { vPanoramaStatus } from './lib/panorama'
import { vEventFilters, vEventName, vEventOwner } from './lib/taskEvents'

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
    // 'image' is the retired Canvas theme (deviation #302). Demo visitor or
    // production rows written before it may still hold it, so the schema
    // accepts it for deploys; appearanceSettings reads it as 'blue' and every
    // save writes a current mode. Drop it once no deployment holds one.
    mode: v.union(vAppearanceMode, v.literal('image')),
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
    storage_bytes: v.number(),
    storage_blocks: v.number(),
    created_at: v.string(),
  })
    .index('by_subscription_period', ['subscription_id', 'period_start'])
    .index('by_org', ['org_id']),

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
  }).index('by_key', ['key']),

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
    activity_count: v.optional(v.number()), // retained activity rows; bootstrapped for imports
    next_issue_num: v.number(), // org-scoped counters; only model/orgs touches them
    next_project_num: v.number(),
    date_format: v.string(),
    week_start: v.number(),
    week_one_rule: v.string(), // jan1 | first4day | firstfull
    default_plannable_hours: v.number(), // whole hours (0095)
    gravatar_avatars: v.boolean(),
    // Org-wide upload cap, 1..20 MiB. Older organizations default to 20.
    max_attachment_mb: v.optional(v.number()),
    // Missing values retain the default strict policy for existing orgs.
    only_team_leads_manage_project_users: v.optional(v.boolean()),
    // organization_billing merged in; absent until billing exists. seats > 0
    // is a mutation check; redacted for non-admins in the snapshot query.
    billing: v.optional(
      v.object({
        plan: v.string(),
        seats: v.number(),
        renewal_date: v.union(v.string(), v.null()),
      }),
    ),
  })
    .index('by_uuid', ['id'])
    .index('by_slug', ['slug']),

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

  projects: defineTable({
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
    .index('by_lead', ['lead_id']), // projects_lead_idx — removeProfile's SET NULL

  project_access: defineTable({
    project_id: v.string(), // explicit grants may target a project or sub-project
    profile_id: v.string(),
    level: vGrantLevel, // the validator IS project_access_level_ck
  })
    .index('by_project', ['project_id'])
    .index('by_profile', ['profile_id'])
    .index('by_project_profile', ['project_id', 'profile_id']),

  project_team_access: defineTable({
    project_id: v.string(), // explicit shares may target a project or sub-project
    team_id: v.string(), // same organization as the project
    level: vGrantLevel,
  })
    .index('by_project', ['project_id'])
    .index('by_team', ['team_id'])
    .index('by_project_team', ['project_id', 'team_id']),

  issues: defineTable({
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
    start_week: v.optional(v.string()), // (start absent) = (end absent), start <= end
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
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_org', ['org_id'])
    // The working snapshot and planning reads do not scan archived task bodies.
    .index('by_org_archived', ['org_id', 'archived_at'])
    .index('by_org_num', ['org_id', 'num'])
    .index('by_project', ['project_id'])
    .index('by_parent', ['parent_id'])
    // Profile refs — removeProfile's SET NULLs.
    .index('by_assignee', ['assignee_id'])
    .index('by_reviewer', ['reviewer_id'])
    .index('by_created_by', ['created_by'])
    .index('by_reporter', ['reporter_id']),

  issue_links: defineTable({
    org_id: v.optional(v.string()),
    id: v.string(),
    source_id: v.string(), // source <> target; 'relates' stored with source < target
    target_id: v.string(),
    type: vLinkType,
    // sorted `${min(source,target)}:${max(...)}` — at most one link per pair,
    // unique-checked on by_pair (replaces the (least, greatest) unique index)
    pair_key: v.string(),
    created_at: v.string(),
  })
    .index('by_org', ['org_id'])
    .index('by_uuid', ['id'])
    .index('by_source', ['source_id'])
    .index('by_target', ['target_id'])
    .index('by_pair', ['pair_key']),

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

  issue_labels: defineTable({
    org_id: v.optional(v.string()),
    issue_id: v.string(), // label and issue must share an org
    label_id: v.string(),
  })
    .index('by_org', ['org_id'])
    .index('by_issue', ['issue_id'])
    .index('by_label', ['label_id'])
    .index('by_issue_label', ['issue_id', 'label_id']),

  issue_subscriptions: defineTable({
    issue_id: v.string(),
    profile_id: v.string(), // recipient must be able to see the project
    created_at: v.string(),
  })
    .index('by_issue', ['issue_id'])
    .index('by_profile', ['profile_id'])
    .index('by_issue_profile', ['issue_id', 'profile_id']),

  issue_attachments: defineTable({
    org_id: v.optional(v.string()),
    id: v.string(),
    issue_id: v.string(),
    name: v.string(),
    size_bytes: v.number(), // copied from _storage metadata in attach, never client-sent
    mime: v.optional(v.string()),
    storage_id: v.id('_storage'), // replaces storage_path
    inline: v.boolean(),
    uploaded_by: v.optional(v.string()),
    created_at: v.string(),
  })
    .index('by_org', ['org_id'])
    .index('by_uuid', ['id'])
    .index('by_issue', ['issue_id'])
    .index('by_storage', ['storage_id']),

  milestones: defineTable({
    id: v.string(),
    project_id: v.string(),
    name: v.string(),
    week: v.string(), // Monday of the milestone week
    created_at: v.string(),
  })
    .index('by_uuid', ['id'])
    .index('by_project', ['project_id']),

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
    team_id: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_org_ts', ['org_id', 'ts'])
    .index('by_actor', ['actor_id']), // removeProfile's SET NULL — rows survive their actor

  comments: defineTable({
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
    .index('by_edited_by', ['edited_by']),

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
    .index('by_issue', ['issue_id'])
    .index('by_actor', ['actor_id']), // messages_actor_idx — removeProfile's SET NULL

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
    .index('by_hash', ['key_hash']),

  mcp_tokens: defineTable({
    id: v.string(),
    profile_id: v.string(),
    name: v.string(),
    token_prefix: v.string(), // first chars of the qvt_ secret, display only
    token_hash: v.string(), // sha256 hex, unique-checked on by_hash; secret never stored
    created_at: v.string(),
    last_used_at: v.optional(v.string()),
    revoked_at: v.optional(v.string()),
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
    revocation_reason: v.optional(v.string()),
  })
    .index('by_uuid', ['id'])
    .index('by_authorization', ['authorization_hash'])
    .index('by_auth_user', ['auth_user_id'])
    .index('by_profile', ['profile_id']),

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
    detail: v.any(),
  }).index('by_ts', ['ts']),
})
