/* The Usage view: what each organization used in one month, for setting
   limits and add-on prices. A closed month shows the rows the monthly job
   stored (convex/usage.ts); the current month is computed when the page
   loads. Every column sorts, the first rows give each column's median, 90th
   and 99th percentile and maximum across organizations, and the month
   downloads as CSV. An organization opens to its months side by side and,
   on request, who did what in one month. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { spread, type UsageField } from '../../../convex/lib/usage'
import {
  fmtWhen,
  type OrgUsageMonth,
  orgUsageMonths,
  orgUsagePeople,
  type UsageMonth,
  type UsagePeople,
  type UsageRow,
  usageMonth,
} from '../api'
import { AdminEmptyState, AdminPageHeader, AdminToolbar, ErrorNote, Loading } from '../ui'
import { fmtMonth, fmtValue, pickerMonths, USAGE_COLUMNS, usageCsv } from '../usage'

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

type Sort = { key: UsageField | 'name'; desc: boolean }

export function Usage() {
  const [months] = useState(() => pickerMonths(Date.now()))
  const [month, setMonth] = useState(months[1])
  const [table, setTable] = useState<UsageMonth | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [sort, setSort] = useState<Sort>({ key: 'name', desc: false })
  const [open, setOpen] = useState<Pick<UsageRow, 'org_id' | 'name'> | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setTable(null)
    usageMonth(month)
      .then((result) => {
        if (active) setTable(result)
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
  }, [month, attempt])

  const rows = useMemo(() => {
    const list = [...(table?.rows ?? [])]
    const { key, desc } = sort
    list.sort((a, b) => {
      const order =
        key === 'name'
          ? a.name.localeCompare(b.name)
          : (a.counts[key] ?? -1) - (b.counts[key] ?? -1) || a.name.localeCompare(b.name)
      return desc ? -order : order
    })
    return list
  }, [table, sort])

  if (open) return <OrgUsage org={open} months={months} onBack={() => setOpen(null)} />

  const toggle = (key: Sort['key']) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }))
  const ariaSort = (key: Sort['key']) =>
    sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined
  const stats = table
    ? USAGE_COLUMNS.map((c) => spread(table.rows.map((row) => row.counts[c.key])))
    : []
  const mail = table?.person_mail

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title="Usage"
        description="What each organization used in a month. Set limits and add-on prices from the median, the 90th and 99th percentile and the maximum."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setAttempt((n) => n + 1)}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!table || table.rows.length === 0}
              onClick={() => table && download(`qivo-usage-${table.month}.csv`, usageCsv(table))}
            >
              Download CSV
            </Button>
          </>
        }
      />
      <AdminToolbar>
        <NativeSelect
          aria-label="Month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        >
          {months.map((m, i) => (
            <option key={m} value={m}>
              {fmtMonth(m)}
              {i === 0 ? ' (so far)' : ''}
            </option>
          ))}
        </NativeSelect>
        {table && (
          <p role="status" className="text-sm text-text-2">
            {table.current
              ? 'This month so far, computed now.'
              : table.rows.length === 0
                ? 'No usage was stored for this month.'
                : `Stored ${fmtWhen(table.rows[0]?.computed_at ?? null)}.`}{' '}
            {mail &&
              `Mail to people without an organization: ${mail.mail_verification} verification, ${mail.mail_password_reset} password reset, ${mail.mail_account_notes} account notes.`}
          </p>
        )}
      </AdminToolbar>
      {error && <ErrorNote message={error} />}
      {loading ? (
        <Loading />
      ) : (
        table &&
        (rows.length === 0 ? (
          <AdminEmptyState
            title="No usage for this month"
            description="The monthly job stores a month early on the 1st of the next month."
          />
        ) : (
          <Card className="min-w-0 gap-0 overflow-x-auto py-0 shadow-card">
            <Table className="min-w-[1800px]">
              <TableHeader>
                <TableRow>
                  <SortHead
                    label="Organization"
                    sort={ariaSort('name')}
                    onSort={() => toggle('name')}
                  />
                  {USAGE_COLUMNS.map((c) => (
                    <SortHead
                      key={c.key}
                      label={c.label}
                      hint={c.hint}
                      sort={ariaSort(c.key)}
                      onSort={() => toggle(c.key)}
                      numeric
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(['median', 'p90', 'p99', 'max'] as const).map((stat) => (
                  <TableRow key={stat} className="bg-surface-2/60 text-text-2">
                    <TableCell className="font-medium">
                      {
                        {
                          median: 'Median',
                          p90: '90th percentile',
                          p99: '99th percentile',
                          max: 'Maximum',
                        }[stat]
                      }
                    </TableCell>
                    {USAGE_COLUMNS.map((c, i) => (
                      <TableCell key={c.key} className="text-right tabular-nums">
                        {fmtValue(c, stats[i][stat])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {rows.map((row) => (
                  <TableRow
                    key={row.org_id}
                    className="cursor-pointer"
                    onClick={() => setOpen({ org_id: row.org_id, name: row.name })}
                  >
                    <TableCell className="max-w-64 whitespace-normal font-semibold">
                      <Button type="button" variant="unstyled" className="text-left">
                        {row.name}
                      </Button>
                    </TableCell>
                    {USAGE_COLUMNS.map((c) => (
                      <TableCell key={c.key} className="text-right tabular-nums">
                        {fmtValue(c, row.counts[c.key])}
                        {c.key === 'api_calls' && row.api_estimated ? ' ≈' : ''}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))
      )}
      {rows.some((row) => row.api_estimated) && (
        <p className="text-sm text-text-2">
          ≈ marks API calls split by time from a paid billing period that crosses the month.
        </p>
      )}
    </div>
  )
}

/* A column heading that sorts the table, with its meaning as a tooltip. */
function SortHead({
  label,
  hint,
  sort,
  onSort,
  numeric = false,
}: {
  label: string
  hint?: string
  sort: 'ascending' | 'descending' | undefined
  onSort: () => void
  numeric?: boolean
}) {
  return (
    <TableHead aria-sort={sort} className={cn(numeric && 'text-right')}>
      <HoverTooltip content={hint}>
        <Button
          type="button"
          variant="unstyled"
          onClick={onSort}
          className="inline-flex items-center gap-1 font-medium hover:text-text-1"
        >
          {label}
          <span aria-hidden="true" className="w-2">
            {sort === 'ascending' ? '↑' : sort === 'descending' ? '↓' : ''}
          </span>
        </Button>
      </HoverTooltip>
    </TableHead>
  )
}

/* One organization's months side by side, newest first, and on request who
   did what in one of them. */
function OrgUsage({
  org,
  months: choices,
  onBack,
}: {
  org: Pick<UsageRow, 'org_id' | 'name'>
  /** The months the people breakdown offers. */
  months: readonly string[]
  onBack: () => void
}) {
  const [months, setMonths] = useState<OrgUsageMonth[] | null>(null)
  const [error, setError] = useState('')
  const [peopleMonth, setPeopleMonth] = useState('')
  const [people, setPeople] = useState<UsagePeople | null>(null)
  const [peopleBusy, setPeopleBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let active = true
    orgUsageMonths(org.org_id)
      .then((result) => {
        if (!active) return
        const newest = [...result].reverse()
        setMonths(newest)
        setPeopleMonth(newest[0]?.month ?? '')
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message)
      })
    return () => {
      active = false
    }
  }, [org.org_id])
  useEffect(() => {
    heading.current?.focus()
  }, [])

  function loadPeople() {
    setPeopleBusy(true)
    setPeople(null)
    setError('')
    orgUsagePeople(org.org_id, peopleMonth)
      .then(setPeople)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setPeopleBusy(false))
  }

  return (
    <div className="min-w-0 space-y-6">
      <AdminPageHeader
        title={org.name}
        headingRef={heading}
        description="Usage by month. The current month is computed now."
        actions={
          <Button type="button" variant="ghost" onClick={onBack}>
            ← All organizations
          </Button>
        }
      />
      {error && <ErrorNote message={error} />}
      {!months ? (
        !error && <Loading />
      ) : (
        <>
          <Card className="min-w-0 gap-0 overflow-x-auto py-0 shadow-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Figure</TableHead>
                  {months.map((m) => (
                    <TableHead key={m.month} className="text-right">
                      {fmtMonth(m.month)}
                      {m.computed_at === null ? ' (so far)' : ''}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {USAGE_COLUMNS.map((c) => (
                  <TableRow key={c.key}>
                    <TableCell>
                      <HoverTooltip content={c.hint}>
                        <span>{c.label}</span>
                      </HoverTooltip>
                    </TableCell>
                    {months.map((m) => (
                      <TableCell key={m.month} className="text-right tabular-nums">
                        {fmtValue(c, m.counts[c.key])}
                        {c.key === 'api_calls' && m.api_estimated ? ' ≈' : ''}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <Card className="min-w-0 gap-3 p-5 shadow-card">
            <div className="text-md font-semibold">People</div>
            <p className="text-sm text-text-2">
              Changes, comments and API calls per person in one month, computed from the records
              Qivo keeps.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                aria-label="Month for the people breakdown"
                value={peopleMonth}
                onChange={(event) => {
                  setPeopleMonth(event.target.value)
                  setPeople(null)
                }}
              >
                {choices.map((m) => (
                  <option key={m} value={m}>
                    {fmtMonth(m)}
                  </option>
                ))}
              </NativeSelect>
              <Button type="button" variant="outline" disabled={peopleBusy} onClick={loadPeople}>
                {peopleBusy ? 'Loading…' : 'Show people'}
              </Button>
            </div>
            {people &&
              (people.people.length === 0 ? (
                <p className="text-sm text-text-2">Nobody was active in this month.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Signed in</TableHead>
                      <TableHead className="text-right">Changes</TableHead>
                      <TableHead className="text-right">Comments</TableHead>
                      <TableHead className="text-right">API calls</TableHead>
                      <TableHead>Credentials</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...people.people]
                      .sort(
                        (a, b) =>
                          b.changes +
                          b.comments +
                          b.api_calls -
                          (a.changes + a.comments + a.api_calls),
                      )
                      .map((p) => (
                        <TableRow key={p.profile_id}>
                          <TableCell className="font-semibold">
                            {p.name ?? <span className="text-text-2">Removed person</span>}
                          </TableCell>
                          <TableCell>{p.signed_in ? 'Yes' : 'No'}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.changes.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.comments.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.api_calls.toLocaleString()}
                            {people.api_estimated && p.api_calls > 0 ? ' ≈' : ''}
                          </TableCell>
                          <TableCell className="whitespace-normal text-sm text-text-2">
                            {p.credentials
                              .map((k) => `${k.name}: ${k.calls.toLocaleString()}`)
                              .join(', ') || '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ))}
          </Card>
        </>
      )}
    </div>
  )
}
