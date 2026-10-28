/* The actions of platform_audit_log rows, with the label Qivo Admin's Audit
 * view shows for each (src/admin/views/Audit.tsx). model/admin.ts audit is
 * the one writer of the table and takes only an AuditAction, so an action
 * cannot be written without a label here. The stored column stays a string,
 * because rows keep the actions of older releases for their 90 days
 * (FORMER_AUDIT_ACTION_LABELS). */

export const AUDIT_ACTION_LABELS = {
  'billing.subscription': 'Updated billing subscription',
  'billing.usage_delivery_stopped': 'Stopped usage delivery at billing boundary',
  'billing.storage_sample_failed': 'Stopped a storage sample that kept failing',
  'billing.storage_sample_restarted': 'Started a stopped storage sample again',
  'billing.webhook_failed': 'Stopped processing a Polar subscription event',
  'billing.create_plan': 'Created billing plan',
  'billing.connect_plan': 'Connected billing plan to Polar',
  'billing.set_default_plan': 'Changed default for new customers',
  'billing.assign_plan': 'Assigned organization billing plan',
  'billing.grant_complimentary': 'Granted complimentary access',
  create_org: 'Created organization',
  invite_member: 'Invited member',
  edit_invite: 'Edited invitation',
  invite_email: 'Invitation email',
  notice_email_unsent: 'Billing or deletion email not confirmed delivered',
  cancel_invite: 'Cancelled invitation',
  set_member_role: 'Changed member role',
  promote_org_admin: 'Promoted member to org admin',
  'org.deletion_requested': 'Requested organization deletion',
  'org.deletion_stopped': 'Stopped organization deletion',
  add_operator: 'Added platform operator',
  remove_operator: 'Removed platform operator',
  recovery_link: 'Generated recovery link',
  ban: 'Banned sign-in',
  unban: 'Lifted sign-in ban',
  create_break_glass: 'Created break-glass admin',
  delete_orphan: 'Deleted orphaned login',
  retire_legacy_fixture_credentials: 'Retired legacy test fixture credentials',
  expire_sessions: 'Deleted expired sign-in sessions',
  expire_oauth_tokens: 'Deleted spent MCP connection tokens',
  expire_audit_log: 'Deleted audit entries older than 90 days',
  archive_done_issues: 'Archived done tasks',
  sweep_read_messages: 'Deleted old read messages',
  reap_orphans: 'Checked for files nothing refers to',
  usage_month: 'Stored monthly usage',
  live_counts_backfill: 'Counted live tasks and projects',
  window_keys_backfill: 'Gave tasks and projects their window keys',
  descriptions_backfill: 'Gave tasks their description rows',
  name_keys_backfill: 'Gave people, teams and projects their name keys',
  panorama_library_image_added: 'Added Unsplash image to the library',
  panorama_manual_image_added: 'Uploaded image to the library',
  panorama_image_approved: 'Approved background image',
  panorama_image_removed: 'Removed background image',
  panorama_date_assigned: 'Updated weekly image assignment',
  panorama_default_image_set: 'Changed default background image',
  panorama_curation_key_created: 'Created agent curation key',
  panorama_curation_key_revoked: 'Revoked agent curation key',
  panorama_agent_precheck: 'Agent prechecked an image',
  panorama_agent_submission: 'Agent proposed an image',
  panorama_agent_submission_precheck: 'Agent prechecked a submission',
  panorama_submission_declined: 'Declined image submission',
  panorama_submission_accepted: 'Accepted image submission',
  panorama_submission_file_attached: 'Added licensed submission image',
} as const

/** An action Qivo writes to platform_audit_log. */
export type AuditAction = keyof typeof AUDIT_ACTION_LABELS

/** Labels of actions no code writes any more, for rows written before that
 * which the nightly expiry has not reached yet. */
export const FORMER_AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  panorama_refill_started: 'Started image import',
  panorama_refill_completed: 'Completed image import',
  panorama_refill_failed: 'Image import failed',
  panorama_library_settings_updated: 'Updated image library settings',
}

const LABELS: Readonly<Record<string, string>> = {
  ...FORMER_AUDIT_ACTION_LABELS,
  ...AUDIT_ACTION_LABELS,
}

/** The label of a stored action, or the action itself when it has none. */
export const auditActionLabel = (action: string): string =>
  Object.hasOwn(LABELS, action) ? LABELS[action] : action
