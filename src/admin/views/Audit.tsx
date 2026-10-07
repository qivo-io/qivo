/* Audit log: the immutable trail of everything platform operators have done. */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type AuditRow, auditLog, listOrgs } from '../api'
import { AdminEmptyState, AdminPageHeader, AdminToolbar, ErrorNote, Loading } from '../ui'

const ACTION_LABEL: Record<string, string> = {
  'billing.subscription': 'Updated billing subscription',
  'billing.usage_delivery_stopped': 'Stopped usage delivery at billing boundary',
  'billing.create_plan': 'Created billing plan',
  'billing.connect_plan': 'Connected billing plan to Polar',
  'billing.set_default_plan': 'Changed default for new customers',
  'billing.assign_plan': 'Assigned organization billing plan',
  'billing.grant_complimentary': 'Granted complimentary access',
  promote_org_admin: 'Promoted member to org admin',
  recovery_link: 'Generated recovery link',
  ban: 'Banned sign-in',
  unban: 'Lifted sign-in ban',
  create_break_glass: 'Created break-glass admin',
  delete_orphan: 'Deleted orphaned login',
  panorama_refill_started: 'Started image import',
  panorama_refill_completed: 'Completed image import',
  panorama_refill_failed: 'Image import failed',
  panorama_library_settings_updated: 'Updated image library settings',
  panorama_image_approved: 'Approved background image',
  panorama_image_removed: 'Removed background image',
  panorama_date_assigned: 'Updated weekly image assignment',
  panorama_curation_key_created: 'Created agent curation key',
  panorama_curation_key_revoked: 'Revoked agent curation key',
  panorama_agent_precheck: 'Agent prechecked an image',
  panorama_agent_submission: 'Agent proposed an image',
  panorama_agent_submission_precheck: 'Agent prechecked a submission',
  panorama_submission_declined: 'Declined image submission',
  panorama_submission_accepted: 'Accepted image submission',
  panorama_submission_file_attached: 'Added licensed submission image',
}

export function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [orgNames, setOrgNames] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('all')
  const [organization, setOrganization] = useState('all')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    auditLog()
      .then((audit) => {
        if (active) setRows(audit)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load audit log.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    listOrgs()
      .then((orgs) => {
        if (active) setOrgNames(Object.fromEntries(orgs.map((org) => [org.id, org.name])))
      })
      .catch(() => {
        // Organization names are decoration; the audit log still renders.
      })
    return () => {
      active = false
    }
  }, [attempt])

  const actionOptions = useMemo(
    () =>
      [...new Set((rows ?? []).map((row) => row.action))].sort((a, b) =>
        (ACTION_LABEL[a] ?? a).localeCompare(ACTION_LABEL[b] ?? b),
      ),
    [rows],
  )
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (rows ?? [])
      .filter((row) => action === 'all' || row.action === action)
      .filter((row) => organization === 'all' || row.target_org_id === organization)
      .filter((row) => {
        if (!needle) return true
        const detail =
          row.detail && Object.keys(row.detail as object).length > 0
            ? JSON.stringify(row.detail)
            : ''
        return [
          row.actor_email,
          ACTION_LABEL[row.action] ?? row.action,
          orgNames[row.target_org_id ?? ''] ?? '',
          detail,
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      })
      .sort((a, b) => (sort === 'newest' ? b.ts.localeCompare(a.ts) : a.ts.localeCompare(b.ts)))
  }, [action, organization, orgNames, rows, search, sort])
  const hasFilters = !!search || action !== 'all' || organization !== 'all'
  const clearFilters = () => {
    setSearch('')
    setAction('all')
    setOrganization('all')
  }

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title="Audit log"
        description="Review the operator actions that changed accounts, billing and image curation."
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <AdminToolbar>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search actions, operators, organizations…"
          aria-label="Search audit log"
          className="min-w-0 flex-1 basis-72"
        />
        <NativeSelect
          aria-label="Filter audit actions"
          value={action}
          onChange={(event) => setAction(event.target.value)}
        >
          <option value="all">All actions</option>
          {actionOptions.map((key) => (
            <option key={key} value={key}>
              {ACTION_LABEL[key] ?? key}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter audit organizations"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        >
          <option value="all">All organizations</option>
          {Object.entries(orgNames)
            .sort(([, a], [, b]) => a.localeCompare(b))
            .map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Sort audit log"
          value={sort}
          onChange={(event) => setSort(event.target.value as 'newest' | 'oldest')}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </NativeSelect>
        {hasFilters && (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </AdminToolbar>
      {error && <ErrorNote message={error} />}
      {loading ? (
        <Loading />
      ) : (
        <>
          <p role="status" className="text-sm text-text-2">
            {filtered.length.toLocaleString()} entr{filtered.length === 1 ? 'y' : 'ies'}
            {hasFilters ? ' matching your filters' : ''}
          </p>
          {filtered.length === 0 ? (
            <AdminEmptyState
              title={hasFilters ? 'No matching audit entries' : 'No operator actions recorded yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Actions taken in the console will appear here.'
              }
              action={
                hasFilters ? (
                  <Button type="button" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Card className="min-w-0 gap-0 overflow-hidden py-0 shadow-card">
              <Table className="min-w-[960px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Operator</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const detail =
                      row.detail && Object.keys(row.detail as object).length > 0
                        ? JSON.stringify(row.detail)
                        : ''
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-normal font-mono text-xs text-text-2">
                          {new Date(row.ts).toLocaleString()}
                        </TableCell>
                        <TableCell className="max-w-56 whitespace-normal break-words text-sm">
                          {row.actor_email || '—'}
                        </TableCell>
                        <TableCell className="max-w-64 whitespace-normal">
                          {ACTION_LABEL[row.action] ?? row.action}
                        </TableCell>
                        <TableCell className="max-w-48 whitespace-normal">
                          {row.target_org_id
                            ? (orgNames[row.target_org_id] ?? row.target_org_id.slice(0, 8))
                            : '—'}
                        </TableCell>
                        <TableCell className="max-w-[420px] whitespace-normal break-all font-mono text-xs text-text-2">
                          {detail}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
