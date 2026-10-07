/* The twelve closed value sets the schema and the wire share.
 * Each exports the `as const` member list, a literals() validator for
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
export const APPEARANCE_MODES = ['blue', 'dark', 'light'] as const
export const vAppearanceMode = literals(...APPEARANCE_MODES)
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]

export const IMAGE_SOURCES = ['daily', 'custom', 'none'] as const
export const vImageSource = literals(...IMAGE_SOURCES)
export type ImageSource = (typeof IMAGE_SOURCES)[number]

export const LEVEL_RANK: Record<AccessLevel, number> = { admin: 3, lead: 3, user: 2, viewer: 1 }
