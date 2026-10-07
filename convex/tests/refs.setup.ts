/* The FK graph as data, covering app UUIDs and exact database-row references.
 * Each field pair in schema.ts is hand-listed
 * so the cascade sweep is table-driven: a new FK edge cannot be forgotten.
 * Shared by cascade.test.ts and orgGuards.test.ts.
 *
 * Two dots in the basename keep the Convex CLI from deploying this module,
 * same rule as helpers.setup.ts.
 *
 * uncoveredRefFields() is the forgetting-proof: it walks schema.ts itself and
 * reports any ref-shaped field (`*_id`, or the profile-ref names author/
 * created_by/edited_by/uploaded_by) that is neither an edge below nor a
 * documented exclusion — cascade.test.ts pins it to []. */

import type { TableNames } from '../_generated/dataModel'
import schema from '../schema'
import type { T } from './helpers.setup'

type RefEdge = { table: TableNames; field: string; target: TableNames; targetKey?: '_id' }

export const REF_EDGES: readonly RefEdge[] = [
  { table: 'billing_settings', field: 'default_plan_id', target: 'billing_plans' },
  { table: 'billing_subscriptions', field: 'org_id', target: 'organizations' },
  { table: 'billing_subscriptions', field: 'plan_id', target: 'billing_plans' },
  { table: 'billing_periods', field: 'org_id', target: 'organizations' },
  { table: 'billing_periods', field: 'plan_id', target: 'billing_plans' },
  { table: 'billing_usage', field: 'org_id', target: 'organizations' },
  { table: 'billing_usage_totals', field: 'org_id', target: 'organizations' },
  { table: 'billing_events', field: 'org_id', target: 'organizations' },
  { table: 'billing_notices', field: 'org_id', target: 'organizations' },
  { table: 'marketing_demo', field: 'org_id', target: 'organizations' },
  { table: 'teams', field: 'org_id', target: 'organizations' },
  { table: 'team_members', field: 'team_id', target: 'teams' },
  { table: 'team_members', field: 'profile_id', target: 'profiles' },
  { table: 'profiles', field: 'org_id', target: 'organizations' },
  { table: 'projects', field: 'org_id', target: 'organizations' },
  { table: 'projects', field: 'team_id', target: 'teams' },
  { table: 'projects', field: 'parent_id', target: 'projects' },
  { table: 'projects', field: 'lead_id', target: 'profiles' },
  { table: 'project_access', field: 'project_id', target: 'projects' },
  { table: 'project_access', field: 'profile_id', target: 'profiles' },
  { table: 'project_team_access', field: 'project_id', target: 'projects' },
  { table: 'project_team_access', field: 'team_id', target: 'teams' },
  { table: 'issues', field: 'project_id', target: 'projects' },
  { table: 'issues', field: 'org_id', target: 'organizations' },
  { table: 'issues', field: 'assignee_id', target: 'profiles' },
  { table: 'issues', field: 'reviewer_id', target: 'profiles' },
  { table: 'issues', field: 'parent_id', target: 'issues' },
  { table: 'issues', field: 'created_by', target: 'profiles' },
  { table: 'issues', field: 'reporter_id', target: 'profiles' },
  { table: 'issue_links', field: 'org_id', target: 'organizations' },
  { table: 'issue_links', field: 'source_id', target: 'issues' },
  { table: 'issue_links', field: 'target_id', target: 'issues' },
  { table: 'labels', field: 'org_id', target: 'organizations' },
  { table: 'issue_labels', field: 'org_id', target: 'organizations' },
  { table: 'issue_labels', field: 'issue_id', target: 'issues' },
  { table: 'issue_labels', field: 'label_id', target: 'labels' },
  { table: 'issue_subscriptions', field: 'issue_id', target: 'issues' },
  { table: 'issue_subscriptions', field: 'profile_id', target: 'profiles' },
  { table: 'issue_attachments', field: 'org_id', target: 'organizations' },
  { table: 'issue_attachments', field: 'issue_id', target: 'issues' },
  { table: 'issue_attachments', field: 'uploaded_by', target: 'profiles' },
  { table: 'milestones', field: 'project_id', target: 'projects' },
  { table: 'activity_events', field: 'org_id', target: 'organizations' },
  { table: 'activity_events', field: 'actor_id', target: 'profiles' },
  { table: 'activity_events', field: 'project_id', target: 'projects' },
  { table: 'activity_events', field: 'team_id', target: 'teams' },
  { table: 'comments', field: 'issue_id', target: 'issues' },
  { table: 'comments', field: 'author', target: 'profiles' },
  { table: 'comments', field: 'edited_by', target: 'profiles' },
  { table: 'messages', field: 'org_id', target: 'organizations' },
  { table: 'messages', field: 'recipient_id', target: 'profiles' },
  { table: 'messages', field: 'actor_id', target: 'profiles' },
  { table: 'messages', field: 'issue_id', target: 'issues' },
  { table: 'user_prefs', field: 'profile_id', target: 'profiles' },
  { table: 'account_appearance', field: 'custom_image_id', target: 'custom_backgrounds' },
  { table: 'agent_keys', field: 'profile_id', target: 'profiles' },
  { table: 'agent_keys', field: 'created_by', target: 'profiles' },
  { table: 'mcp_tokens', field: 'profile_id', target: 'profiles' },
  { table: 'oauth_connections', field: 'profile_id', target: 'profiles' },
  { table: 'oauth_connections', field: 'org_id', target: 'organizations' },
  { table: 'webhook_events', field: 'org_id', target: 'organizations' },
  { table: 'webhook_health', field: 'org_id', target: 'organizations' },
  {
    table: 'webhook_health',
    field: 'subscription_row_id',
    target: 'webhook_subscriptions',
    targetKey: '_id',
  },
  { table: 'webhook_subscriptions', field: 'org_id', target: 'organizations' },
  { table: 'webhook_deliveries', field: 'org_id', target: 'organizations' },
  { table: 'oauth_credential_uses', field: 'connection_id', target: 'oauth_connections' },
  { table: 'panorama_calendar', field: 'image_id', target: 'panorama_images' },
  { table: 'panorama_library', field: 'active_run_id', target: 'panorama_refills' },
  { table: 'panorama_library', field: 'default_image_id', target: 'panorama_images' },
  { table: 'panorama_submissions', field: 'key_id', target: 'panorama_curation_keys' },
  { table: 'panorama_submissions', field: 'image_id', target: 'panorama_images' },
]

/* Ref-shaped fields that are deliberately NOT integrity edges. */
export const EXCLUDED_REFS: ReadonlySet<string> = new Set([
  // Polar resource IDs and webhook delivery IDs belong to the provider,
  // not to rows in this schema. Period subscription_id is also a Polar ID.
  'billing_plans.polar_product_id',
  'billing_plans.api_meter_id',
  'billing_plans.storage_meter_id',
  'billing_subscriptions.polar_subscription_id',
  'billing_subscriptions.polar_customer_id',
  'billing_subscriptions.checkout_id',
  'billing_periods.subscription_id',
  'billing_webhooks.event_id',
  'billing_webhooks.subscription_id',
  // Delivery receipts survive deleted tasks, projects and subscriptions until retention.
  // Authorization is checked again before each attempted callback.
  'webhook_events.project_id',
  'webhook_events.source_project_id',
  'webhook_events.task_id',
  'webhook_events.subscription_rows',
  'webhook_deliveries.source_project_id',
  'webhook_deliveries.scheduled_job',
  'webhook_workers.scheduled_job',
  'webhook_deliveries.subscription_id',
  'webhook_deliveries.subscription_row_id',
  'webhook_deliveries.project_id',
  'webhook_deliveries.task_id',
  // Historical accounting retains deleted users/credentials, so removing a
  // profile cannot erase usage owed by its organization. Reminder receipts
  // retain their recipient ID too; delivery rechecks the current admin row.
  // billing_periods.profile_ids similarly records the renewal snapshot.
  'billing_usage.profile_id',
  'billing_usage.credential_id',
  'billing_notices.profile_id',
  // Demo receipts/ledgers outlive planning parents while bounded cleanup runs.
  'demo_sessions.auth_user_id',
  'demo_sessions.org_id',
  'demo_sessions.expiry_scheduled_id',
  'demo_sessions.cleanup_scheduled_id',
  'demo_uploads.demo_id',
  'demo_uploads.auth_user_id',
  'demo_uploads.target_id',
  'demo_uploads.storage_id',
  // Opaque sampler delivery fence, not a reference to another database row.
  'demo_metrics_scans.run_id',
  // Binds a private local credentials file; not the id of a database row.
  'marketing_demo.credential_set_id',
  // dangles by design: the feed renders dead issue targets as plain text (0026)
  'activity_events.target_id',
  // Better Auth login ids — not rows in this schema
  'profiles.auth_user_id',
  'roadmap_history.auth_user_id',
  // OAuth identities and clients live inside the Better Auth component.
  'oauth_connections.auth_user_id',
  'oauth_connections.client_id',
  'platform_admins.auth_user_id',
  // Appearance belongs to a login across all organization seats.
  'account_appearance.auth_user_id',
  'custom_backgrounds.auth_user_id',
  'background_uploads.auth_user_id',
  // Convex _storage ids — byte-liveness asserted separately, not row refs
  'profiles.avatar_storage_id',
  'issue_attachments.storage_id',
  'panorama_images.storage_id',
  'panorama_images.preview_storage_id',
  'custom_backgrounds.storage_id',
  'custom_backgrounds.preview_storage_id',
  // Provider identity retained for deduplication, not an app database uuid.
  'panorama_images.source_id',
  'panorama_submissions.source_id',
  // Opaque idempotency and review-version identifiers, not row references.
  'panorama_submissions.request_id',
  'panorama_submissions.agent_review_id',
  'panorama_images.agent_review_id',
  // Historical Better Auth identity; keys are disabled if the issuer loses operator access.
  'panorama_curation_keys.created_by',
  // Better Auth actor identity retained with historical refill/audit records,
  // even after the account or its platform-operator enrollment is removed.
  'panorama_refills.actor_auth_id',
  // the platform audit log survives its subjects on purpose
  'platform_audit_log.actor_auth_id',
  'platform_audit_log.target_org_id',
  'platform_audit_log.target_profile_id',
])

const REF_NAME = /_id$/
const PROFILE_REF_NAMES = new Set(['author', 'created_by', 'edited_by', 'uploaded_by'])

/* Every ref-shaped schema field not accounted for above — pinned to []. */
export function uncoveredRefFields(): string[] {
  const covered = new Set(REF_EDGES.map((e) => `${e.table}.${e.field}`))
  const tables = schema.tables as unknown as Record<
    string,
    { validator: { json: { value: Record<string, unknown> } } }
  >
  const missing: string[] = []
  for (const [table, def] of Object.entries(tables)) {
    for (const field of Object.keys(def.validator.json.value)) {
      if (!REF_NAME.test(field) && !PROFILE_REF_NAMES.has(field)) continue
      const key = `${table}.${field}`
      if (!covered.has(key) && !EXCLUDED_REFS.has(key)) missing.push(key)
    }
  }
  return missing
}

// Every declared edge contributes its target, including platform image/run
// records; a second hand-maintained list could silently omit a new target.
const TARGETS: readonly TableNames[] = [...new Set(REF_EDGES.map((edge) => edge.target))]

/* After a cascade, no surviving row anywhere may reference a deleted id:
 * walk every edge over the WHOLE database and fail loudly per dangler. */
export async function assertNoDanglingRefs(t: T, label: string): Promise<void> {
  await t.run(async (ctx) => {
    const live = new Map<TableNames, { id: Set<string>; _id: Set<string> }>()
    for (const table of TARGETS) {
      const ids = { id: new Set<string>(), _id: new Set<string>() }
      for (const row of await ctx.db.query(table).collect()) {
        ids.id.add((row as unknown as { id: string }).id)
        ids._id.add(row._id)
      }
      live.set(table, ids)
    }
    const dangling: string[] = []
    for (const edge of REF_EDGES) {
      for (const row of await ctx.db.query(edge.table).collect()) {
        const value = (row as unknown as Record<string, unknown>)[edge.field]
        if (value === undefined) continue
        if (!live.get(edge.target)?.[edge.targetKey ?? 'id'].has(value as string)) {
          dangling.push(
            `${label}: ${edge.table}.${edge.field} → ${edge.target} dangles (${String(value)})`,
          )
        }
      }
    }
    if (dangling.length > 0) throw new Error(dangling.join('\n'))
  })
}
