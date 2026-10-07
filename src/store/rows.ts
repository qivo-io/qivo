/* Snapshot rows retain application IDs and omit database metadata and private
 * query indexes. Field types still follow the generated Convex schema. */
import type { Doc, TableNames } from '../../convex/_generated/dataModel'

export type { TableNames }

type InternalFields<T extends TableNames> =
  | '_id'
  | '_creationTime'
  | (T extends 'issue_links' | 'issue_labels' | 'issue_attachments' ? 'org_id' : never)
  | (T extends 'organizations' ? 'activity_count' : never)

export type Row<T extends TableNames> = Omit<Doc<T>, InternalFields<T>>

// organization_billing merged into organizations: the old
// Row<'organization_billing'> is now the home org doc's billing object,
// absent until billing exists and redacted for non-admins in the snapshot
export type OrgBilling = NonNullable<Row<'organizations'>['billing']>
