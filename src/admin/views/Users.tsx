/* Users: cross-org account search and recovery actions. */
import { useEffect, useState } from 'react'
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
import { UserActions } from '../actions'
import { fmtWhen, isBanned, listUsers, type UserRow } from '../api'
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminToolbar,
  Badge,
  ErrorNote,
  LinkReveal,
  Loading,
} from '../ui'

export function Users() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [role, setRole] = useState('all')
  const [sort, setSort] = useState('organization')
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const timer = setTimeout(
      () => {
        listUsers(search.trim())
          .then((result) => {
            if (active) setRows(result)
          })
          .catch((cause: Error) => {
            if (active) setError(cause.message)
          })
          .finally(() => {
            if (active) setLoading(false)
          })
      },
      search ? 250 : 0,
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [search, tick])

  const filtered = [...(rows ?? [])]
    .filter((user) => role === 'all' || user.org_role === role)
    .filter((user) => {
      if (status === 'banned') return isBanned(user.banned_until)
      if (status === 'no-login') return !user.has_login
      if (status === 'can-sign-in') return user.has_login && !isBanned(user.banned_until)
      return true
    })
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'recent') {
        return (b.last_sign_in_at ?? '').localeCompare(a.last_sign_in_at ?? '')
      }
      return a.org_name.localeCompare(b.org_name) || a.name.localeCompare(b.name)
    })
  const hasFilters = !!search || role !== 'all' || status !== 'all'
  const clearFilters = () => {
    setSearch('')
    setRole('all')
    setStatus('all')
  }

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title="Users"
        description="Find an account across organizations, review access and help a customer sign in."
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => setTick((n) => n + 1)}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <AdminToolbar>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, email, or organization…"
          aria-label="Search users"
          className="min-w-0 flex-1 basis-72"
        />
        <NativeSelect
          aria-label="Filter users by role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="all">All roles</option>
          <option value="admin">Organization admins</option>
          <option value="user">Users</option>
          <option value="viewer">Viewers</option>
          <option value="guest">Guests</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Filter users by access"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">All access</option>
          <option value="can-sign-in">Can sign in</option>
          <option value="no-login">No login</option>
          <option value="banned">Banned</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Sort users"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="organization">Organization A–Z</option>
          <option value="name">Name A–Z</option>
          <option value="recent">Recent sign-in</option>
        </NativeSelect>
        {hasFilters && (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </AdminToolbar>
      {error && <ErrorNote message={error} />}
      {link && <LinkReveal link={link} onClose={() => setLink('')} />}
      {loading ? (
        <Loading />
      ) : (
        rows && (
          <>
            <p role="status" className="text-sm text-text-2">
              {filtered.length.toLocaleString()} account{filtered.length === 1 ? '' : 's'}
              {hasFilters ? ' matching your filters' : ' across all organizations'}
            </p>
            {filtered.length === 0 ? (
              <AdminEmptyState
                title={hasFilters ? 'No matching users' : 'No users yet'}
                description={
                  hasFilters
                    ? 'Try a different name, email or organization, or clear the access and role filters.'
                    : 'Organization members will appear here when they are added.'
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
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Organization</TableHead>
                      <TableHead>Role and access</TableHead>
                      <TableHead>Last sign-in</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((user) => {
                      const banned = isBanned(user.banned_until)
                      return (
                        <TableRow key={user.profile_id}>
                          <TableCell className="max-w-56 whitespace-normal font-semibold">
                            {user.name}
                          </TableCell>
                          <TableCell className="max-w-64 break-words whitespace-normal text-sm">
                            {user.email ?? <span className="text-text-2">No email</span>}
                          </TableCell>
                          <TableCell className="max-w-48 whitespace-normal">
                            {user.org_name}
                          </TableCell>
                          <TableCell>
                            <div className="flex max-w-56 flex-wrap gap-1.5">
                              <Badge kind={user.org_role === 'admin' ? 'accent' : 'muted'}>
                                {user.org_role === 'admin' ? 'org admin' : user.org_role}
                              </Badge>
                              {!user.has_login && <Badge kind="muted">no login</Badge>}
                              {banned && <Badge kind="danger">banned</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-text-2">
                            {fmtWhen(user.last_sign_in_at)}
                          </TableCell>
                          <TableCell className="max-w-80 text-right whitespace-normal">
                            <UserActions
                              email={user.email}
                              profileId={user.profile_id}
                              orgRole={user.org_role}
                              hasLogin={user.has_login}
                              banned={banned}
                              onLink={setLink}
                              onChanged={() => setTick((n) => n + 1)}
                              onError={setError}
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
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
