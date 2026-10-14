/* The Organizations view. It shows the fleet table with New organization,
   and a per-org drill-down with billing, people and their invitations,
   teams, and break-glass admin access. */
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import {
  authAction,
  fmtBytes,
  fmtWhen,
  listOrgs,
  type OrgDetail,
  type OrgRow,
  orgDetail,
} from '../api'
import { NewOrganizationDialog } from '../components/InviteDialogs'
import { OrgBilling } from '../components/OrgBilling'
import { OrgPeople } from '../components/OrgPeople'
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminToolbar,
  ErrorNote,
  LinkReveal,
  Loading,
} from '../ui'

export function Orgs() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null)
  const [openOrg, setOpenOrg] = useState<OrgRow | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [plan, setPlan] = useState('all')
  const [sort, setSort] = useState('name')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    listOrgs()
      .then((result) => {
        if (active) setOrgs(result)
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [attempt])

  /* Reloads the list after New organization, then opens the new page. */
  async function openCreated(orgId: string) {
    try {
      const result = await listOrgs()
      setOrgs(result)
      setOpenOrg(result.find((org) => org.id === orgId) ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setCreating(false)
  }

  if (openOrg) return <OrgDetailView org={openOrg} onBack={() => setOpenOrg(null)} />

  const plans = [
    ...new Set((orgs ?? []).map((org) => org.plan).filter((value): value is string => !!value)),
  ].sort()
  const visible = (orgs ?? [])
    .filter((org) => plan === 'all' || org.plan === plan)
    .filter(
      (org) =>
        !search.trim() ||
        `${org.name} ${org.plan ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => {
      if (sort === 'recent') return (b.last_activity ?? '').localeCompare(a.last_activity ?? '')
      if (sort === 'members') return b.member_count - a.member_count || a.name.localeCompare(b.name)
      return a.name.localeCompare(b.name)
    })
  const hasFilters = !!search || plan !== 'all'
  const clearFilters = () => {
    setSearch('')
    setPlan('all')
  }

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title="Organizations"
        description="Review workspace health, membership and billing one organization at a time."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button type="button" variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New organization
            </Button>
          </>
        }
      />
      {creating && (
        <NewOrganizationDialog onClose={() => setCreating(false)} onCreated={openCreated} />
      )}
      <AdminToolbar>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search organizations…"
          aria-label="Search organizations"
          className="min-w-0 flex-1 basis-72"
        />
        <NativeSelect
          aria-label="Filter organizations by plan"
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
        >
          <option value="all">All plans</option>
          {plans.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Sort organizations"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="name">Name A–Z</option>
          <option value="members">Most members</option>
          <option value="recent">Recent activity</option>
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
        orgs && (
          <>
            <p role="status" className="text-sm text-text-2">
              {visible.length.toLocaleString()} organization{visible.length === 1 ? '' : 's'}
              {hasFilters ? ' matching your filters' : ''}
            </p>
            {visible.length === 0 ? (
              <AdminEmptyState
                title={hasFilters ? 'No matching organizations' : 'No organizations yet'}
                description={
                  hasFilters
                    ? 'Try another search or clear the plan filter.'
                    : 'Create one with New organization.'
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
                <Table className="min-w-[1080px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Members</TableHead>
                      <TableHead>Guests</TableHead>
                      <TableHead>Teams</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Tasks</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead>Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((org) => (
                      <TableRow
                        key={org.id}
                        className="cursor-pointer"
                        onClick={() => setOpenOrg(org)}
                      >
                        <TableCell className="max-w-64 whitespace-normal font-semibold">
                          {org.name}
                        </TableCell>
                        <TableCell>
                          {org.plan ?? <span className="text-text-2">No plan</span>}
                        </TableCell>
                        <TableCell>
                          {org.member_count}{' '}
                          <span className="text-text-2">({org.login_count} logins)</span>
                        </TableCell>
                        <TableCell>{org.guest_count || 0}</TableCell>
                        <TableCell>{org.team_count}</TableCell>
                        <TableCell>{org.project_count}</TableCell>
                        <TableCell>{org.issue_count}</TableCell>
                        <TableCell className="text-sm">{fmtBytes(org.approx_bytes)}</TableCell>
                        <TableCell className="text-xs text-text-2">
                          {fmtWhen(org.last_activity)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </>
        )
      )}
    </div>
  )
}

function OrgDetailView({ org, onBack }: { org: OrgRow; onBack: () => void }) {
  const [detail, setDetail] = useState<OrgDetail | null>(null)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [bgEmail, setBgEmail] = useState('')
  const [bgBusy, setBgBusy] = useState(false)
  /* Counts the reloads, so the billing card recounts seats after people
     are invited, cancelled or added for break-glass access. */
  const [loads, setLoads] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useUpdateBlocker(!!bgEmail || bgBusy || !!link)

  /* Resolves once the page shows the reload, so a row's write stays busy
     until its result is on screen. */
  const refresh = useCallback(
    () =>
      orgDetail(org.id)
        .then((result) => {
          setDetail(result)
          setError('')
          setLoads((n) => n + 1)
        })
        .catch((e: Error) => setError(e.message)),
    [org.id],
  )
  useEffect(() => {
    refresh()
  }, [refresh])
  /* Opened from a row click or a dialog that has closed, focus is nowhere,
     so it starts at the page title. */
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body)
      heading.current?.focus()
  }, [])

  function createBreakGlass(e: React.FormEvent) {
    e.preventDefault()
    const releaseUpdateBlock = beginUpdateBlock()
    setBgBusy(true)
    setError('')
    authAction({ action: 'create_break_glass', org_id: org.id, email: bgEmail.trim() })
      .then((r) => {
        if (r.link) setLink(r.link)
        setBgEmail('')
        refresh()
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setBgBusy(false)
        releaseUpdateBlock()
      })
  }

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title={org.name}
        headingRef={heading}
        description={`Created ${fmtWhen(org.created_at)}, ~${fmtBytes(org.approx_bytes)} of data`}
        actions={
          <Button type="button" variant="ghost" onClick={onBack}>
            ← All organizations
          </Button>
        }
      />
      {error && detail && <ErrorNote message={error} />}
      {link && <LinkReveal link={link} onClose={() => setLink('')} />}
      {!detail ? (
        error ? (
          <div className="space-y-2" role="alert">
            <ErrorNote message={error} />
            <Button type="button" variant="outline" onClick={refresh}>
              Retry loading organization
            </Button>
          </div>
        ) : (
          <Loading />
        )
      ) : (
        <>
          <OrgBilling orgId={org.id} seatsVersion={loads} />
          <OrgPeople
            orgId={org.id}
            orgName={detail.org.name}
            members={detail.members}
            onChanged={refresh}
            onLink={setLink}
          />
          <div className="grid grid-cols-1 items-start lg:grid-cols-2 gap-6">
            <Card className="gap-0 p-5 shadow-card">
              <div className="mb-2 text-md font-semibold">Teams</div>
              {detail.teams.length === 0 ? (
                <AdminEmptyState
                  title="No teams yet"
                  description="Teams created in this organization will appear here."
                />
              ) : (
                detail.teams.map((w) => (
                  <div key={w.id} className="flex justify-between py-2 text-base">
                    <span>{w.name}</span>
                    <span className="text-text-2">
                      {w.member_count} member{w.member_count === 1 ? '' : 's'}, {w.project_count}{' '}
                      project{w.project_count === 1 ? '' : 's'}
                    </span>
                  </div>
                ))
              )}
            </Card>
            <Card className="gap-0 p-5 shadow-card">
              <div className="mb-2 text-md font-semibold">Break-glass access</div>
              <div className="mb-2 text-sm leading-normal text-text-2">
                Creates an organization admin account for lockout recovery. Share its one-time link
                securely with the customer, then have them remove the account after recovery.
              </div>
              <form onSubmit={createBreakGlass} className="flex flex-wrap gap-2">
                <Input
                  value={bgEmail}
                  onChange={(e) => setBgEmail(e.target.value)}
                  type="email"
                  placeholder="Email address"
                  aria-label="Break-glass account email"
                  className="min-w-0 flex-1 basis-40 bg-surface-2"
                />
                <Button variant="primary" type="submit" disabled={bgBusy || !bgEmail.trim()}>
                  {bgBusy ? 'Creating…' : 'Create'}
                </Button>
              </form>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
