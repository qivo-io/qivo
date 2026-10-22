/* The closed value sets of the schema, most of them also on the wire. Each
 * exports the `as const` member list, a literals() validator for
 * schema.ts / args validators, and the TS union type. */

import { literals } from 'convex-helpers/validators'

export const ORG_ROLES = ['admin', 'user', 'guest', 'viewer'] as const
export const vOrgRole = literals(...ORG_ROLES)
export type OrgRole = (typeof ORG_ROLES)[number]

export const ISSUE_STATUSES = ['backlog', 'todo', 'progress', 'review', 'done'] as const
export const vIssueStatus = literals(...ISSUE_STATUSES)
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

export const ISSUE_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export const vIssuePriority = literals(...ISSUE_PRIORITIES)
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number]

// 'blocked_by' is the reverse view of 'blocks', never stored
export const LINK_TYPES = ['blocks', 'relates'] as const
export const vLinkType = literals(...LINK_TYPES)
export type LinkType = (typeof LINK_TYPES)[number]

export const PROJECT_TYPES = ['meta', 'project'] as const
export const vProjectType = literals(...PROJECT_TYPES)
export type ProjectType = (typeof PROJECT_TYPES)[number]

export const PROFILE_KINDS = ['person', 'agent'] as const
export const vProfileKind = literals(...PROFILE_KINDS)
export type ProfileKind = (typeof PROFILE_KINDS)[number]

export const MESSAGE_KINDS = ['mention', 'change', 'comment'] as const
export const vMessageKind = literals(...MESSAGE_KINDS)
export type MessageKind = (typeof MESSAGE_KINDS)[number]

export const ACTIVITY_TARGETS = ['issue', 'project', 'milestone', 'user', 'team', 'org'] as const
export const vActivityTarget = literals(...ACTIVITY_TARGETS)
export type ActivityTarget = (typeof ACTIVITY_TARGETS)[number]

/* access_level keeps its unstorable legacy members ('admin', 'lead') because
 * level_rank still ranks them; only vGrantLevel below is ever stored
 * (project_access_level_ck, 0013). */
export const ACCESS_LEVELS = ['admin', 'lead', 'user', 'viewer'] as const
export const vAccessLevel = literals(...ACCESS_LEVELS)
export type AccessLevel = (typeof ACCESS_LEVELS)[number]

export const GRANT_LEVELS = ['user', 'viewer'] as const
export const vGrantLevel = literals(...GRANT_LEVELS)
export type GrantLevel = (typeof GRANT_LEVELS)[number]

/* Personal appearance: the theme picks the palette; the Canvas source picks
 * the background image painted behind every theme, or none. */
export const APPEARANCE_MODES = ['dark', 'light'] as const
export const vAppearanceMode = literals(...APPEARANCE_MODES)
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]

export const IMAGE_SOURCES = ['daily', 'custom', 'none'] as const
export const vImageSource = literals(...IMAGE_SOURCES)
export type ImageSource = (typeof IMAGE_SOURCES)[number]

/* Who may create top-level projects besides org admins (lib/projectCreators.ts). */
export const PROJECT_CREATORS = ['admins', 'users', 'selected'] as const
export const vProjectCreators = literals(...PROJECT_CREATORS)
export type ProjectCreators = (typeof PROJECT_CREATORS)[number]

/* What a machine credential may do (lib/access.ts credentialAccess). */
export const CREDENTIAL_ACCESS = ['read', 'write'] as const
export const vCredentialAccess = literals(...CREDENTIAL_ACCESS)
export type CredentialAccess = (typeof CREDENTIAL_ACCESS)[number]

/* The background steps of a profile removal, in the order they run
 * (profileRemovals.ts). Stored on profile_removals only, never on the wire. */
export const REMOVAL_PHASES = [
  'access',
  'tasks',
  'activity',
  'comments',
  'sent_messages',
  'inbox',
  'subscriptions',
  'attachments',
  'agent_keys',
  'oauth',
  'finish',
] as const
export const vRemovalPhase = literals(...REMOVAL_PHASES)
export type RemovalPhase = (typeof REMOVAL_PHASES)[number]

/* Why an organization is read-only before its deletion (orgRemovals.ts): its
 * service ended, an admin asked for deletion, or checkout never completed. */
export const ORG_REMOVAL_REASONS = ['service_ended', 'requested', 'no_checkout'] as const
export const vOrgRemovalReason = literals(...ORG_REMOVAL_REASONS)
export type OrgRemovalReason = (typeof ORG_REMOVAL_REASONS)[number]

/* The background steps of an organization deletion, in the order they run
 * (orgRemovals.ts). Stored on org_removals only, never on the wire. 'trash'
 * empties Deleted items (model/orgDeletion.ts says why it runs there). */
export const ORG_REMOVAL_PHASES = [
  'profiles',
  'trash',
  'tasks',
  'projects',
  'teams',
  'labels',
  'activity',
  'webhooks',
  'billing',
  'finish',
] as const
export const vOrgRemovalPhase = literals(...ORG_REMOVAL_PHASES)
export type OrgRemovalPhase = (typeof ORG_REMOVAL_PHASES)[number]

/* Deleted items (model/deletedItems.ts). A deletion moves the rows of these
 * ten tables into deleted_rows; messages are deleted instead. */
export const STORED_TABLES = [
  'issues',
  'comments',
  'issue_labels',
  'issue_subscriptions',
  'issue_attachments',
  'issue_links',
  'projects',
  'milestones',
  'project_access',
  'project_team_access',
] as const
export const vStoredTable = literals(...STORED_TABLES)
export type StoredTable = (typeof STORED_TABLES)[number]

/** Whether deleted_rows stores rows of `table`. */
export const isStoredTable = (table: string): table is StoredTable =>
  (STORED_TABLES as readonly string[]).includes(table)

export const DELETED_ITEM_KINDS = ['task', 'project'] as const
export const vDeletedItemKind = literals(...DELETED_ITEM_KINDS)
export type DeletedItemKind = (typeof DELETED_ITEM_KINDS)[number]

/* moving and restoring items still have background steps to run; purging
 * ones are being deleted for good; stuck ones stopped after their retries
 * and wait for an organization admin's Delete now. */
export const DELETED_ITEM_STATES = ['moving', 'ready', 'restoring', 'purging', 'stuck'] as const
export const vDeletedItemState = literals(...DELETED_ITEM_STATES)
export type DeletedItemState = (typeof DELETED_ITEM_STATES)[number]

/* The phases of a deleted item's background steps, in the order each kind of
 * work runs them (model/deletedItems.ts). Stored on deleted_item_jobs only,
 * never on the wire. */
export const TRASH_PHASES = [
  'move_edges',
  'move_tasks',
  'move_drain',
  'move_finish',
  'restore_split',
  'restore_rows',
  'restore_links',
  'restore_tasks',
  'restore_access',
  'restore_reveal',
  'restore_grants',
  'restore_attach',
  'restore_detach',
  'purge_dependents',
  'purge_live',
  'purge_rows',
  'purge_activity',
  'purge_projects',
  'purge_finish',
] as const
export const vTrashPhase = literals(...TRASH_PHASES)
export type TrashPhase = (typeof TRASH_PHASES)[number]

/* The credential a REST or MCP delete came through (deleted_items.via). */
export const CREDENTIAL_TABLES = ['agent_keys', 'mcp_tokens', 'oauth_connections'] as const
export const vCredentialTable = literals(...CREDENTIAL_TABLES)
export type CredentialTable = (typeof CREDENTIAL_TABLES)[number]

export const LEVEL_RANK: Record<AccessLevel, number> = { admin: 3, lead: 3, user: 2, viewer: 1 }
