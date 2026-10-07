import type { Value } from 'convex/values'

/* Order is significant: clients read organization tables first, then traverse
 * the exported parent UUIDs. Personal inboxes, subscriptions, view preferences,
 * MCP credentials, roadmap undo receipts, account appearance, platform data
 * and operational billing/metering ledgers are outside this list. Billing
 * terms and usage retain their separate admin-only projections; raw provider
 * identifiers, checkout URLs and delivery state are not portable work data.
 * A new schema table must be classified in the export coverage test. */
export const ORG_EXPORT_SECTIONS = {
  organizations: null,
  teams: null,
  profiles: null,
  projects: null,
  issues: null,
  labels: null,
  activity_events: null,
  team_members: 'teams',
  project_access: 'projects',
  project_team_access: 'projects',
  milestones: 'projects',
  issue_links: 'issues',
  issue_labels: 'issues',
  issue_attachments: 'issues',
  comments: 'issues',
  agent_keys: 'profiles',
} as const

export type OrgExportSection = keyof typeof ORG_EXPORT_SECTIONS
export type OrgExportRow = Record<string, Value | undefined>
export type OrgExportPage = {
  rows: OrgExportRow[]
  continueCursor: string
  isDone: boolean
}
