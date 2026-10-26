/* Settings › Organization › API access. An organization admin sees every API
   credential in the organization, personal tokens, connected apps and agent
   keys, with each one's calls in a usage period, and can revoke any of them.
   The server decides who may (convex/apiAccess.ts); the org- page guard in
   Settings.tsx keeps everyone else out.

   The list is read on demand (P.listApiAccess): on opening, on a period
   change, after a revoke and from Refresh. Every API call changes a
   credential's last use and calls, so a live subscription would re-render on
   each one, as Billing's usage would. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { Avatar, Icon, Seg } from '../../components/qivo'
import { PageTitle } from '../../components/settingsPage'
import {
  ACCESS_LABEL,
  type ApiAccessFilters,
  type ApiAccessList,
  type ApiCredentialRow,
  credentialEnded,
  credentialPrefix,
  expiryNote,
  filterCredentials,
  KIND_ICON,
  KIND_LABEL,
  lastUsedLabel,
  periodLabel,
  personOptions,
  planLine,
  revokeSentence,
  stateTag,
} from '../../lib/apiAccess'
import { DEMO_MODE } from '../../lib/demoMode'
import { focusAround, useFocusWhenGone } from '../../lib/focusWhenGone'
import { P } from '../../store/planner'
import { ModalShell } from '../Modals'
import { DemoCapabilityNotice } from './controls'

/* Column widths, shared by the headings and every row. The columns need
   about 840px, so in a narrower list a container query in
   styles/mobile-settings.css hides the headings and cells and each row's
   summary line says the same. */
const PERSON_COL = 'w-[140px]'
const KIND_COL = 'w-[100px]'
const ACCESS_COL = 'w-[120px]'
const USED_COL = 'w-[76px]'
const CALLS_COL = 'w-[128px]'
const ACTION_COL = 'w-[72px]'
const HEADING = 'shrink-0 text-xs font-semibold text-text-2'
const CELL = 'shrink-0 text-sm'

const KIND_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'mcp_tokens', label: 'Personal tokens' },
  { value: 'oauth_connections', label: 'Connected apps' },
  { value: 'agent_keys', label: 'Agent keys' },
]
const STATE_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
]

/** The API access page; the demo shows a notice instead. */
export function OrgApiAccessPage() {
  if (DEMO_MODE)
    return (
      <>
        <PageTitle>API access</PageTitle>
        <DemoCapabilityNotice>The demo has no API credentials to manage.</DemoCapabilityNotice>
      </>
    )
  return <ApiAccessPage />
}

function ApiAccessPage() {
  // null while the first load runs; false when it failed with nothing shown
  const [data, setData] = useState<ApiAccessList | null | false>(null)
  const [period, setPeriod] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [filters, setFilters] = useState<ApiAccessFilters>({
    kind: 'all',
    state: 'all',
    person: '',
    search: '',
  })
  const [revoking, setRevoking] = useState<ApiCredentialRow | null>(null)
  /* The credential whose Revoke opened the window last, with where focus
     goes once that Revoke has left: the next row's Revoke, the previous
     row's, the line that says no credential matches, or the filter field.
     The window gives focus back to the Revoke, and the list read after the
     revoke takes it away, with the row itself under the Active filter. */
  const [asked, setAsked] = useState<{ key: string; focus: () => HTMLElement | null }>()
  // A newer request replaces an older one still in flight.
  const sequence = useRef(0)

  const load = async (key: string | undefined) => {
    const n = ++sequence.current
    // the list on screen when this request starts
    const shown = data
    setLoading(true)
    const result = await P.listApiAccess(key)
    if (n !== sequence.current) return
    setLoading(false)
    setNow(new Date())
    if (result === null) {
      setFailed(true)
      setData(shown || false)
      // A failed switch keeps the old figures, so the period control goes
      // back to the period they belong to.
      if (shown) setPeriod(shown.period)
      return
    }
    setFailed(false)
    setData(result)
    setPeriod(result.period)
  }
  useEffect(() => {
    void load(undefined)
  }, [])

  const me = P.CURRENT_USER
  const list = data || null
  const shownPeriod = list?.periods.find((p) => p.key === list.period)
  const people = list ? personOptions(list.credentials, me) : []
  // a person with no credential in the period shown falls back to everyone
  const person = people.some((p) => p.id === filters.person) ? filters.person : ''
  const rows = list ? filterCredentials(list.credentials, { ...filters, person }) : []
  const largest = rows.reduce((max, row) => Math.max(max, row.calls), 0)
  const set = (patch: Partial<ApiAccessFilters>) => setFilters((f) => ({ ...f, ...patch }))
  useFocusWhenGone(
    !!asked && rows.some((row) => credentialKey(row) === asked.key && !credentialEnded(row)),
    () => asked?.focus() ?? null,
  )

  return (
    <>
      <PageTitle
        action={
          <Button
            type="button"
            variant="outline"
            data-api-access-refresh=""
            disabled={loading}
            onClick={() => void load(period)}
          >
            {loading && data !== null ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        API access
      </PageTitle>
      {data === null && (
        <p role="status" className="text-sm text-text-2">
          Loading…
        </p>
      )}
      {failed && !loading && (
        <div role="alert" className="mb-4 flex items-center gap-2 text-sm text-danger">
          {list ? "Couldn't refresh API access." : "Couldn't load API access."}
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm text-sm"
            onClick={() => void load(period)}
          >
            <Icon name="rotateCcw" size={16} />
            Retry
          </Button>
        </div>
      )}
      {list && shownPeriod && (
        <div data-api-access="" aria-busy={loading}>
          <div data-api-access-summary="" className="mb-6">
            <div className="flex items-center gap-4">
              <p className="min-w-0 flex-1 text-base text-text-2">
                <strong className="font-semibold text-text-1 tabular-nums">
                  {list.summary.calls.toLocaleString()}
                </strong>
                {list.summary.included_calls === null
                  ? ' API calls'
                  : ` of ${list.summary.included_calls.toLocaleString()} included API calls`}
              </p>
              <NativeSelect
                aria-label="Billing period"
                data-api-access-period=""
                value={period ?? list.period}
                onChange={(e) => {
                  setPeriod(e.target.value)
                  void load(e.target.value)
                }}
                className="h-control min-w-[150px] shrink-0 bg-surface-1 font-sans text-sm"
              >
                {list.periods.map((p) => (
                  <option key={p.key} value={p.key}>
                    {periodLabel(p, now)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {list.summary.included_calls !== null && (
              <Progress
                aria-label="Included API calls used"
                value={Math.min(
                  100,
                  (list.summary.calls / Math.max(1, list.summary.included_calls)) * 100,
                )}
                className="mt-3 h-1.5 bg-border"
                indicatorClassName="rounded-full bg-primary"
              />
            )}
            {list.summary.plan && (
              <p className="mt-2 text-sm text-text-2">{planLine(list.summary, shownPeriod)}</p>
            )}
          </div>
          <div data-api-access-filters="" className="mb-3 flex flex-wrap items-center gap-2">
            <Seg
              label="Kind"
              value={filters.kind}
              options={KIND_OPTIONS}
              onChange={(kind) => set({ kind })}
            />
            <Seg
              label="State"
              value={filters.state}
              options={STATE_OPTIONS}
              onChange={(state) => set({ state })}
            />
            <NativeSelect
              aria-label="Person"
              data-api-access-person=""
              value={person}
              onChange={(e) => set({ person: e.target.value })}
              className="h-control w-[148px] shrink-0 bg-surface-1 font-sans text-sm"
            >
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
            <div className="flex h-control w-[200px] items-center gap-2 rounded-md border border-border bg-surface-1 px-2">
              <Icon name="search" size={16} color="var(--text-3)" />
              <Input
                aria-label="Filter credentials"
                data-api-access-search=""
                placeholder="Filter credentials"
                value={filters.search}
                onChange={(e) => set({ search: e.target.value })}
                onKeyDown={(e) => {
                  // Escape clears a filter first; an empty field lets it
                  // close Settings
                  if (e.key === 'Escape' && filters.search) {
                    e.stopPropagation()
                    set({ search: '' })
                  }
                }}
                className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <span data-api-access-count="" className="ml-auto text-sm text-text-2 tabular-nums">
              {rows.length === 1 ? '1 credential' : `${rows.length.toLocaleString()} credentials`}
            </span>
          </div>
          {list.credentials.length === 0 ? (
            <p className="text-sm text-text-2">No API credentials yet.</p>
          ) : rows.length === 0 ? (
            <p data-api-access-none="" tabIndex={-1} className="text-sm text-text-2">
              No credentials match the filters.
            </p>
          ) : (
            <>
              <div
                data-api-access-list=""
                className="overflow-hidden rounded-md border border-border"
              >
                <div
                  aria-hidden="true"
                  data-api-access-columns=""
                  className="flex h-8 items-center gap-3 border-b border-border px-3"
                >
                  <div className={cn(HEADING, 'min-w-0 flex-1')}>Credential</div>
                  <div className={cn(HEADING, PERSON_COL)}>Person</div>
                  <div className={cn(HEADING, KIND_COL)}>Kind</div>
                  <div className={cn(HEADING, ACCESS_COL)}>Access</div>
                  <div className={cn(HEADING, USED_COL)}>Last used</div>
                  <div className={cn(HEADING, CALLS_COL, 'flex items-center gap-1 text-text-1')}>
                    Calls
                    <Icon name="child" size={12} />
                  </div>
                  <div className={cn('shrink-0', ACTION_COL)} />
                </div>
                <div>
                  {rows.map((row) => (
                    <CredentialRow
                      key={credentialKey(row)}
                      row={row}
                      me={me}
                      now={now}
                      largest={largest}
                      onRevoke={() => {
                        const key = credentialKey(row)
                        setAsked({
                          key,
                          focus: focusAround(
                            'data-api-credential',
                            key,
                            (shown) =>
                              shown.querySelector<HTMLElement>('[data-api-credential-revoke]'),
                            () =>
                              document.querySelector<HTMLElement>('[data-api-access-none]') ??
                              document.querySelector<HTMLElement>('[data-api-access-search]'),
                          ),
                        })
                        setRevoking(row)
                      }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-3 text-sm text-text-2">
                Revoked and expired credentials stay listed because their calls in the period still
                count.
              </p>
            </>
          )}
        </div>
      )}
      {revoking && (
        <RevokeWindow
          row={revoking}
          me={me}
          onClose={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null)
            void load(period)
          }}
        />
      )}
    </>
  )
}

/** The key a credential is listed under, unique across its three tables. */
const credentialKey = (row: ApiCredentialRow) => `${row.table}:${row.id}`

/* One credential. Revoked, expired and deleted ones are dimmed and cannot be
   revoked; one whose owner's account is inactive can. The calls bar is scaled
   to the largest row shown. */
function CredentialRow({
  row,
  me,
  now,
  largest,
  onRevoke,
}: {
  row: ApiCredentialRow
  me: string
  now: Date
  largest: number
  onRevoke: () => void
}) {
  const ended = credentialEnded(row)
  const tag = stateTag(row, now)
  const prefix = credentialPrefix(row)
  const access = row.access === null ? null : ACCESS_LABEL[row.access]
  const expiry = expiryNote(row, now)
  const used = lastUsedLabel(row.last_used_at, now)
  const known = !!P.user(row.profile_id)
  const summary = [
    `${row.person}${row.profile_id === me ? ' (you)' : ''}`,
    KIND_LABEL[row.table],
    ...(access ? [access] : []),
    ...(expiry ? [expiry] : []),
    used === 'Never' ? 'never used' : `last used ${used.charAt(0).toLowerCase()}${used.slice(1)}`,
    `${row.calls.toLocaleString()} ${row.calls === 1 ? 'call' : 'calls'}`,
  ]
  return (
    <div
      data-api-credential={credentialKey(row)}
      className="border-t border-border first:border-t-0 hover:bg-hover/60"
    >
      <div className={cn('flex items-center gap-3 px-3 py-1.5', ended && 'opacity-60')}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon name={KIND_ICON[row.table]} size={16} color="var(--text-2)" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-text-1">{row.name}</div>
            {(tag || prefix) && (
              <div className="flex min-w-0 items-baseline gap-[7px] text-xs">
                {tag && (
                  <span
                    data-api-credential-state={row.state}
                    className={cn(
                      'shrink-0 font-bold whitespace-nowrap',
                      row.state === 'inactive' ? 'text-text-2' : 'text-danger',
                    )}
                  >
                    {tag}
                  </span>
                )}
                {prefix && <span className="truncate font-mono text-text-2">{prefix}</span>}
              </div>
            )}
            {/* the narrow list's stand-in for the columns */}
            <div data-api-credential-summary="" className="text-xs text-text-2">
              {summary.join(', ')}
            </div>
          </div>
        </div>
        <div
          data-api-credential-cell="person"
          className={cn(CELL, PERSON_COL, 'flex items-center gap-2 text-text-1')}
        >
          {known ? (
            <Avatar id={row.profile_id} size={20} />
          ) : (
            // a person who left has no portrait; Avatar would call them Unassigned
            <span
              aria-hidden="true"
              className="grid size-5 shrink-0 place-items-center rounded-[4px] border border-dashed border-border-strong bg-surface-3"
            >
              <Icon name="user" size={11} color="var(--text-3)" />
            </span>
          )}
          <span className="min-w-0 truncate">
            {row.person}
            {row.profile_id === me && <span className="font-medium text-text-2"> (you)</span>}
          </span>
        </div>
        <div data-api-credential-cell="kind" className={cn(CELL, KIND_COL, 'text-text-2')}>
          {KIND_LABEL[row.table]}
        </div>
        <div data-api-credential-cell="access" className={cn(CELL, ACCESS_COL, 'text-text-1')}>
          {access}
          {expiry && <div className="text-xs text-text-2">{expiry}</div>}
        </div>
        <div data-api-credential-cell="used" className={cn(CELL, USED_COL, 'text-text-2')}>
          <span className="sr-only">Last used </span>
          {used}
        </div>
        <div
          data-api-credential-cell="calls"
          className={cn('flex shrink-0 items-center gap-2', CALLS_COL)}
        >
          <span className="w-[52px] text-right text-sm text-text-1 tabular-nums">
            <span className="sr-only">Calls </span>
            {row.calls.toLocaleString()}
          </span>
          <Progress
            aria-hidden="true"
            value={largest > 0 ? (row.calls / largest) * 100 : 0}
            className="h-1 flex-1 bg-border"
            indicatorClassName="rounded-full bg-text-2"
          />
        </div>
        <div className={cn('flex shrink-0 justify-end', ACTION_COL)}>
          {!ended && (
            <Button
              type="button"
              variant="ghost"
              data-api-credential-revoke=""
              aria-label={`Revoke ${row.name}`}
              onClick={onRevoke}
            >
              Revoke
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/* The window that revokes one credential. It says whose access stops and
   what they can do next, and stays open until the server answers. */
function RevokeWindow({
  row,
  me,
  onClose,
  onRevoked,
}: {
  row: ApiCredentialRow
  me: string
  onClose: () => void
  onRevoked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prefix = credentialPrefix(row)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    const ok = await P.revokeApiCredential(row.table, row.id)
    setBusy(false)
    if (!ok) {
      setError("That didn't go through. Try again.")
      return
    }
    window.showToast?.(`“${row.name}” revoked`)
    onRevoked()
  }
  return (
    <ModalShell
      icon="warning"
      title={`Revoke ${row.name}?`}
      danger
      width={440}
      onClose={() => (busy ? false : onClose())}
      onSubmit={() => void submit()}
      canSubmit={!busy}
      submitLabel={busy ? 'Revoking…' : 'Revoke'}
      footerLeft={error ? <span className="text-sm text-danger">{error}</span> : undefined}
    >
      <div data-api-access-revoke={credentialKey(row)}>
        <p className="text-base leading-normal text-text-2">{revokeSentence(row, me)}</p>
        <div className="mt-3 flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
          <Icon name={KIND_ICON[row.table]} size={16} color="var(--text-2)" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-1">{row.name}</div>
            <div className="truncate text-xs text-text-2">
              {KIND_LABEL[row.table]}
              {prefix && (
                <>
                  , <span className="font-mono">{prefix}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
