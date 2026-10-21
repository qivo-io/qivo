/* Snapshot rows retain application IDs and omit database metadata and private
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

// The snapshot adds each organization's task and project counters, which
// live in org_counters (convex/snapshot.ts).
type AddedFields<T extends TableNames> = T extends 'organizations'
  ? Pick<Doc<'org_counters'>, 'next_issue_num' | 'next_project_num'>
  : unknown

export type Row<T extends TableNames> = Omit<Doc<T>, InternalFields<T>> & AddedFields<T>

// organization_billing merged into organizations: the old
// Row<'organization_billing'> is now the home org doc's billing object,
// absent until billing exists and redacted for non-admins in the snapshot
export type OrgBilling = NonNullable<Row<'organizations'>['billing']>
