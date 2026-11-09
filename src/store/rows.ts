/* Workspace rows retain application IDs and omit database metadata and private
 * query indexes. Field types still follow the generated Convex schema. */
import type { Doc, TableNames } from '../../convex/_generated/dataModel'

export type { TableNames }

type InternalFields<T extends TableNames> =
  | '_id'
  | '_creationTime'
  | (T extends 'issue_links' | 'issue_labels' | 'issue_attachments' ? 'org_id' : never)
  | (T extends 'issue_links' | 'issue_labels' | 'issue_attachments' | 'issue_subscriptions'
      ? 'task_archived'
      : never)
  | (T extends 'issues' ? 'relations_marked' : never)
  | (T extends 'issues' | 'projects' ? 'window_key' : never)
  | (T extends 'projects' ? 'archive_state' : never)
  | (T extends
      | 'profiles'
      | 'teams'
      | 'projects'
      | 'team_members'
      | 'project_access'
      | 'project_team_access'
      ? 'name_key'
      : never)
  | (T extends 'issue_links' | 'issue_labels' | 'issue_attachments' | 'issue_subscriptions'
      ? 'task_key'
      : never)

// The workspace parts add each organization's task number and, once
// counted, its count of active tasks, which live in org_counters, and
// whether a task has subtasks, which the workspace reads before every task
// is held (convex/lib/workspaceParts.ts). They send no project count or
// number, as the app reads its projects by id.
type AddedFields<T extends TableNames> = T extends 'organizations'
  ? Pick<Doc<'org_counters'>, 'next_issue_num' | 'active_tasks'>
  : T extends 'issues'
    ? { has_subtasks?: boolean }
    : unknown

export type Row<T extends TableNames> = Omit<Doc<T>, InternalFields<T>> & AddedFields<T>

// organization_billing merged into organizations: the old
// Row<'organization_billing'> is now the home org doc's billing object,
// absent until billing exists and redacted for non-admins in the snapshot
export type OrgBilling = NonNullable<Row<'organizations'>['billing']>
