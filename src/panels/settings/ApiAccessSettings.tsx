/* Settings › Organization › API access. An organization admin browses every
   API credential in the organization, personal tokens, connected apps and
   agent keys, with each one's calls in a usage period, a page at a time,
   and can revoke any of them. The server decides who may and applies the
   period, filters, search and order before it pages (convex/apiAccess.ts);
   the org- page guard in Settings.tsx keeps everyone else out.

   Everything is read on demand, never subscribed to: the summary and the
   current page on opening, on a period change, after a revoke and from
   Refresh (P.apiAccessSummary, P.apiAccessPage), the page alone when
   browsing with Previous and Next or changing a filter, and the person
   filter's people as it opens and is searched (P.apiAccessPeople). Every API
   call changes a credential's last use and calls, so a live subscription
   would re-render on each one, as Billing's usage would. Nothing subscribes,
   so a hidden tab has nothing to pause, and leaving the page drops answers
   still on their way.

   Billing's View credentials opens the page with an entry (ApiAccessEntry,
   Settings.tsx): its period and account apply to the very first read, with
   every kind and state and no search. */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { Avatar, Icon, MenuItem, Popover, Seg } from '../../components/qivo'
import { PageTitle } from '../../components/settingsPage'
import {
  ACCESS_LABEL,
  type ApiAccessEntry,
  type ApiAccessFilters,
  type ApiAccessPageAnswer,
  type ApiAccessPerson,
  type ApiAccessSummaryAnswer,
  type ApiCredentialRow,
  credentialEnded,
  credentialPrefix,
  expiryNote,
  KIND_ICON,
  KIND_LABEL,
  lastUsedLabel,
  periodLabel,
  planLine,
  rangeLabel,
  revokeSentence,
  stateTag,
} from '../../lib/apiAccess'
import { DEMO_MODE } from '../../lib/demoMode'
import { limitSentence, overLimit } from '../../lib/fieldLimits'
import { focusAround, useFocusWhenGone } from '../../lib/focusWhenGone'
import { type ApiAccessPageArgs, P } from '../../store/planner'
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

/** How long typing rests before a search goes to the server, as on
    Archived tasks. */
const SEARCH_DELAY_MS = 250

/** The most page starts Previous can step back through. Past it the
    oldest one after the first page's is dropped, so a long walk with Next
    keeps a bounded stack and Previous still leads back to the first page. */
const STACK_MOST = 1000

/** The most people the person filter keeps loaded with Load more; past
    it, a search narrows the list. */
const PEOPLE_MOST = 500

/** Where a page starts: the cursor of the page before's `next`, null for
    the first page, and how many rows the pages before it held. */
type PageStart = { cursor: string | null; first: number }
const FIRST_PAGE: PageStart = { cursor: null, first: 0 }

/** What the page asks the server for: the period (absent for the current
    one), the filters, and the starts of the pages browsed so far, the last
    of them the page asked for. */
type Ask = ApiAccessFilters & { period: string | undefined; pages: PageStart[] }

/** What the page shows: the answers of the last read that succeeded and
    what it asked for. */
type Shown = { ask: Ask; figures: ApiAccessSummaryAnswer; page: ApiAccessPageAnswer }

/* The first read: the entry's period and account, or the current period
   and everyone, every kind and state, no search, the first page. */
const firstAsk = (entry: ApiAccessEntry | null): Ask => ({
  period: entry?.period_key,
  kind: 'all',
  state: 'all',
  person: entry ? { id: entry.profile_id } : null,
  search: '',
  pages: [FIRST_PAGE],
})

/* The page arguments for `ask`. */
const pageArgs = (ask: Ask): ApiAccessPageArgs => {
  const start = ask.pages[ask.pages.length - 1] ?? FIRST_PAGE
  return {
    kind: ask.kind,
    state: ask.state,
    ...(ask.period === undefined ? {} : { period: ask.period }),
    ...(ask.person === null ? {} : { person: ask.person.id }),
    ...(ask.search === '' ? {} : { search: ask.search }),
    ...(start.cursor === null ? {} : { cursor: start.cursor }),
  }
}

/** The API access page; the demo shows a notice instead. `entry` comes
    from Billing's View credentials and is used once: `onEntryUsed` lets
    Settings forget it, so a later visit starts unfiltered. */
export function OrgApiAccessPage({
  entry = null,
  onEntryUsed,
}: {
  entry?: ApiAccessEntry | null
  onEntryUsed?: () => void
}) {
  if (DEMO_MODE)
    return (
      <>
        <PageTitle>API access</PageTitle>
        <DemoCapabilityNotice>The demo has no API credentials to manage.</DemoCapabilityNotice>
      </>
    )
  return <ApiAccessPage entry={entry} onEntryUsed={onEntryUsed} />
}

function ApiAccessPage({
  entry,
  onEntryUsed,
}: {
  entry: ApiAccessEntry | null
  onEntryUsed?: () => void
}) {
  // the entry as the page opened with it; Settings forgets it at once
  const [opened] = useState(entry)
  // an entry from another organization's Billing shows no list until asked
  const [foreign, setForeign] = useState(opened !== null && opened.org_id !== P.homeOrg)
  const [ask, setAsk] = useState<Ask>(() => firstAsk(foreign ? null : opened))
  const [shown, setShown] = useState<Shown | null>(null)
  const [loading, setLoading] = useState(!foreign)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => new Date())
  // The search box, which only typing and Escape change, and its settled
  // text: the trimmed text once typing rests, at once when cleared. Every
  // read applies the settled text as its search (withQuery).
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [revoking, setRevoking] = useState<ApiCredentialRow | null>(null)
  /* The credential whose Revoke opened the window last, with where focus
     goes once that Revoke has left: the next row's Revoke, the previous
     row's, the line that says no credential matches, or the filter field.
     The window gives focus back to the Revoke, and the page read after the
     revoke takes it away, with the row itself under the Active filter. */
  const [asked, setAsked] = useState<{ key: string; focus: () => HTMLElement | null }>()
  // A newer request replaces an older one still in flight, and leaving the
  // page drops whatever is still on its way.
  const sequence = useRef(0)
  // the last request, which Retry sends again
  const attempt = useRef<{ ask: Ask; figures: boolean } | null>(null)
  // what timers and late answers read: the newest ask and shown data
  const askRef = useRef(ask)
  askRef.current = ask
  const shownRef = useRef(shown)
  shownRef.current = shown
  const queryRef = useRef(query)

  /* `ask` with the search box's settled text as its search. Cursors belong
     to one search, so a changed search starts at the first page. */
  const withQuery = (ask: Ask): Ask =>
    ask.search === queryRef.current
      ? ask
      : { ...ask, search: queryRef.current, pages: [FIRST_PAGE] }

  /* Reads the page for `next`, with the summary when `figures`, and also
     when the figures on screen belong to another period than `next` names,
     as when a filter changes while a period change is still on its way.
     Callers pass `next` through withQuery. A failed read keeps what is on
     screen, the controls go back to what it belongs to and the search box
     stays as typed, and the error line offers Retry. */
  const load = async (next: Ask, figures: boolean) => {
    const n = ++sequence.current
    attempt.current = { ask: next, figures }
    // at once, so a second change made before the next render builds on it
    askRef.current = next
    setAsk(next)
    setLoading(true)
    const kept = shownRef.current
    const reuse = !figures && kept !== null && kept.ask.period === next.period
    const [summary, page] = await Promise.all([
      reuse ? kept.figures : P.apiAccessSummary(next.period),
      P.apiAccessPage(pageArgs(next)),
    ])
    if (n !== sequence.current) return
    setLoading(false)
    setNow(new Date())
    if (summary === null || page === null) {
      setFailed(true)
      if (!kept) return
      askRef.current = kept.ask
      setAsk(kept.ask)
      return
    }
    let settled = next
    // The opening read names no period. The page is to show the summary's,
    // which a read at a bucket's turn could miss, and later reads name it.
    if (next.period === undefined && summary.state === 'ready') {
      if (page.state === 'ready' && page.period !== summary.period)
        return void load({ ...next, period: summary.period }, true)
      settled = { ...settled, period: summary.period }
    }
    // the person as the server resolved them, so the filter names them
    if (page.state === 'ready' && page.person && settled.person)
      settled = { ...settled, person: { id: page.person.id, name: page.person.name } }
    setFailed(false)
    askRef.current = settled
    setAsk(settled)
    setShown({ ask: settled, figures: summary, page })
  }

  useEffect(() => {
    if (opened !== null) onEntryUsed?.()
    if (!foreign) void load(withQuery(askRef.current), true)
    return () => {
      sequence.current++
    }
  }, [])

  /* A filter or search change reads the first page of the new list. */
  const filter = (patch: Partial<Omit<ApiAccessFilters, 'search'>>) =>
    void load(withQuery({ ...askRef.current, ...patch, pages: [FIRST_PAGE] }), false)

  // The box's text settles once typing rests, at once when cleared, and
  // the list reads it.
  const typed = text.trim()
  const tooLong = overLimit(LIMITS.search, typed)
  useEffect(() => {
    if (typed === queryRef.current || tooLong || foreign) return
    const settle = () => {
      queryRef.current = typed
      setQuery(typed)
      filter({})
    }
    if (typed === '') return settle()
    const timer = window.setTimeout(settle, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [typed, tooLong, foreign])

  const me = P.CURRENT_USER
  const figures = shown?.figures
  const page = shown?.page
  const rows = page?.state === 'ready' ? page.rows : []
  const start = shown ? (shown.ask.pages[shown.ask.pages.length - 1] ?? FIRST_PAGE) : FIRST_PAGE
  const largest = rows.reduce((max, row) => Math.max(max, row.calls), 0)
  const range = rangeLabel(start.first, rows.length)
  const shownPeriod =
    figures?.state === 'ready' ? figures.periods.find((p) => p.key === figures.period) : undefined
  useFocusWhenGone(
    !!asked && rows.some((row) => credentialKey(row) === asked.key && !credentialEnded(row)),
    () => asked?.focus() ?? null,
  )

  const refresh = () => void load(withQuery(askRef.current), true)
  // Previous and Next browse the list on screen, which a failed search read
  // can leave behind the search box; Retry reads the box's search then.
  const behind = shown !== null && shown.ask.search !== query
  const next = () => {
    if (page?.state !== 'ready' || page.next === null || !shown || behind) return
    const pages = [...shown.ask.pages, { cursor: page.next, first: start.first + rows.length }]
    // keep the first page's start and drop the oldest after it (STACK_MOST)
    if (pages.length > STACK_MOST) pages.splice(1, 1)
    void load({ ...shown.ask, pages }, false)
  }
  const previous = () => {
    if (!shown || shown.ask.pages.length < 2 || behind) return
    void load({ ...shown.ask, pages: shown.ask.pages.slice(0, -1) }, false)
  }
  // the current period, a deliberate change of scope from an unavailable one
  const currentPeriod = () =>
    void load(withQuery({ ...askRef.current, period: undefined, pages: [FIRST_PAGE] }), true)

  const personName = ask.person ? (ask.person.name ?? 'Chosen account') : null

  let body: ReactNode = null
  if (tooLong) body = <Note>{limitSentence(LIMITS.search)}</Note>
  else if (page?.state === 'period_unavailable' || figures?.state === 'period_unavailable')
    body = (
      <Note data="period-unavailable">
        This usage period is no longer available, so no credentials are listed for it.
        <Button
          type="button"
          variant="outline"
          className="ml-3 h-control-sm"
          onClick={currentPeriod}
        >
          Show the current period
        </Button>
      </Note>
    )
  else if (page?.state === 'unknown_person')
    body = (
      <Note data="unknown-person">
        This account is not in the organization, and no usage names it.
        <Button
          type="button"
          variant="outline"
          className="ml-3 h-control-sm"
          onClick={() => filter({ person: null })}
        >
          Show everyone
        </Button>
      </Note>
    )
  else if (page?.state === 'not_ready')
    body = (
      <Note data="not-ready">
        API access is not ready yet. Qivo is still preparing the organization's credentials and
        usage after an update. Refresh in a few minutes.
      </Note>
    )
  else if (page?.state === 'ready' && rows.length === 0 && !page.stopped)
    body =
      start.first > 0 ? (
        <Note data="none" focusable>
          No more credentials match.
        </Note>
      ) : !shown?.ask || !filteredOf(shown.ask) ? (
        <Note data="empty">No API credentials yet.</Note>
      ) : onlyPerson(shown.ask) ? (
        <Note data="none" focusable>
          No credentials for {page.person?.name ?? personName} in this period.
        </Note>
      ) : (
        <Note data="none" focusable>
          No credentials match the filters.
        </Note>
      )
  else if (page?.state === 'ready' && rows.length === 0)
    // without a filter nothing was a miss: the part it checked holds only
    // credentials it does not list here, such as those listed with their calls
    body = (
      <Note data="none" focusable>
        {shown && filteredOf(shown.ask)
          ? 'Qivo checked part of the list and found no matches there. Next continues with the rest.'
          : 'Qivo checked part of the list. Next continues with the rest.'}
      </Note>
    )

  return (
    <>
      <PageTitle
        action={
          <Button
            type="button"
            variant="outline"
            data-api-access-refresh=""
            disabled={loading || foreign}
            onClick={refresh}
          >
            {loading && shown !== null ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        API access
      </PageTitle>
      {foreign && (
        <div data-api-access-foreign="" className="text-sm text-text-2">
          <p>
            This link came from another organization's Billing page, so it does not apply to this
            organization's credentials.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 h-control-sm"
            onClick={() => {
              setForeign(false)
              void load(withQuery(firstAsk(null)), true)
            }}
          >
            Show this organization's credentials
          </Button>
        </div>
      )}
      {!foreign && shown === null && loading && (
        <p role="status" className="text-sm text-text-2">
          Loading…
        </p>
      )}
      {failed && !loading && (
        <div role="alert" className="mb-4 flex items-center gap-2 text-sm text-danger">
          {shown ? "Couldn't refresh API access." : "Couldn't load API access."}
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm text-sm"
            onClick={() => {
              const last = attempt.current
              // the failed read's filters, with the search box as it is now
              if (last) void load(withQuery(last.ask), last.figures || shown === null)
            }}
          >
            <Icon name="rotateCcw" size={16} />
            Retry
          </Button>
        </div>
      )}
      {shown && figures && (
        <div data-api-access="" aria-busy={loading}>
          <div data-api-access-summary="" className="mb-6">
            <div className="flex items-center gap-4">
              <p className="min-w-0 flex-1 text-base text-text-2">
                {figures.state !== 'ready' ? null : figures.summary.calls === null ? (
                  <span data-api-access-total-pending="">
                    This period's total is not available yet. Qivo is still counting its calls after
                    an update.
                  </span>
                ) : (
                  <>
                    <strong className="font-semibold text-text-1 tabular-nums">
                      {figures.summary.calls.toLocaleString()}
                    </strong>
                    {figures.summary.included_calls === null
                      ? ' API calls'
                      : ` of ${figures.summary.included_calls.toLocaleString()} included API calls`}
                  </>
                )}
              </p>
              <NativeSelect
                aria-label="Billing period"
                data-api-access-period=""
                value={ask.period ?? (figures.state === 'ready' ? figures.period : '')}
                onChange={(e) =>
                  void load(
                    withQuery({ ...askRef.current, period: e.target.value, pages: [FIRST_PAGE] }),
                    true,
                  )
                }
                className="h-control min-w-[150px] shrink-0 bg-surface-1 font-sans text-sm"
              >
                {ask.period !== undefined && !figures.periods.some((p) => p.key === ask.period) && (
                  <option value={ask.period} disabled>
                    Period no longer available
                  </option>
                )}
                {figures.periods.map((p) => (
                  <option key={p.key} value={p.key}>
                    {periodLabel(p, now)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {figures.state === 'ready' &&
              figures.summary.calls !== null &&
              figures.summary.included_calls !== null && (
                <Progress
                  aria-label="Included API calls used"
                  value={Math.min(
                    100,
                    (figures.summary.calls / Math.max(1, figures.summary.included_calls)) * 100,
                  )}
                  className="mt-3 h-1.5 bg-border"
                  indicatorClassName="rounded-full bg-primary"
                />
              )}
            {figures.state === 'ready' && figures.summary.plan && shownPeriod && (
              <p className="mt-2 text-sm text-text-2">{planLine(figures.summary, shownPeriod)}</p>
            )}
          </div>
          <div data-api-access-filters="" className="mb-3 flex flex-wrap items-center gap-2">
            <Seg
              label="Kind"
              value={ask.kind}
              options={KIND_OPTIONS}
              onChange={(kind) => filter({ kind })}
            />
            <Seg
              label="State"
              value={ask.state}
              options={STATE_OPTIONS}
              onChange={(state) => filter({ state })}
            />
            <PersonFilter
              chosen={ask.person}
              name={personName}
              me={me}
              onChange={(person) => filter({ person })}
            />
            <div className="flex h-control w-[200px] items-center gap-2 rounded-md border border-border bg-surface-1 px-2">
              <Icon name="search" size={16} color="var(--text-3)" />
              <LimitedInput
                limit={LIMITS.search}
                aria-label="Filter credentials"
                data-api-access-search=""
                placeholder="Filter credentials"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Escape clears a filter first; an empty field lets it
                  // close Settings
                  if (e.key === 'Escape' && text) {
                    e.stopPropagation()
                    setText('')
                  }
                }}
                wrapperClassName="h-full flex-1"
                className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
              />
            </div>
            {range && !tooLong && (
              <span data-api-access-count="" className="ml-auto text-sm text-text-2 tabular-nums">
                {range}
              </span>
            )}
          </div>
          {body}
          {!tooLong && rows.length > 0 && (
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
                            (listed) =>
                              listed.querySelector<HTMLElement>('[data-api-credential-revoke]'),
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
              {page?.state === 'ready' && page.stopped && (
                <p data-api-access-stopped="" className="mt-3 text-sm text-text-2">
                  Qivo checked part of the list for this page. Next continues with the rest.
                </p>
              )}
              <p className="mt-3 text-sm text-text-2">
                Revoked and expired credentials stay listed because their calls in the period still
                count.
              </p>
            </>
          )}
          {!tooLong && page?.state === 'ready' && (start.first > 0 || page.next !== null) && (
            <div data-api-access-pager="" className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                data-api-access-previous=""
                disabled={loading || behind || shown.ask.pages.length < 2}
                onClick={previous}
              >
                <Icon name="chevronLeft" size={16} />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                data-api-access-next=""
                disabled={loading || behind || page.next === null}
                onClick={next}
              >
                Next
                <Icon name="chevronRight" size={16} />
              </Button>
            </div>
          )}
        </div>
      )}
      {revoking && (
        <RevokeWindow
          row={revoking}
          me={me}
          onClose={() => {
            // closed without a revoke, so a later end of the credential, as
            // another admin's revoke, moves nothing
            setAsked(undefined)
            setRevoking(null)
          }}
          onRevoked={() => {
            setRevoking(null)
            refresh()
          }}
        />
      )}
    </>
  )
}

/* Whether `ask` narrows the list at all. */
const filteredOf = (ask: Ask) =>
  ask.kind !== 'all' || ask.state !== 'all' || ask.person !== null || ask.search !== ''

/* Whether `ask` narrows the list to one person and nothing else, as
   Billing's View credentials does. */
const onlyPerson = (ask: Ask) =>
  ask.person !== null && ask.kind === 'all' && ask.state === 'all' && ask.search === ''

/* A line in place of the list or beside it. `focusable` takes focus when a
   revoke empties the page (focusAround's last resort). */
function Note({
  children,
  data,
  focusable = false,
}: {
  children: ReactNode
  data?: string
  focusable?: boolean
}) {
  return (
    <p
      data-api-access-note={data}
      data-api-access-none={focusable ? '' : undefined}
      tabIndex={focusable ? -1 : undefined}
      className="text-sm text-text-2"
    >
      {children}
    </p>
  )
}

/** The key a row is listed under, for React, data-api-credential and
    focus. A uuid a deleted credential had can come back as another
    profile's credential, and both can be listed, so the key names the
    owner and the deleted state besides the table and id. Revoke sends the
    table and id alone. */
const credentialKey = (row: ApiCredentialRow) =>
  `${row.table}:${row.id}:${row.profile_id}${row.state === 'deleted' ? ':deleted' : ''}`

/* The person filter: a button naming the chosen account, or Everyone, that
   opens a searchable list read from the server a batch at a time. A person
   chosen here or carried from Billing stays named on the button, also when
   they are on no page and in no batch. */
function PersonFilter({
  chosen,
  name,
  me,
  onChange,
}: {
  chosen: ApiAccessFilters['person']
  name: string | null
  me: string
  onChange: (person: ApiAccessFilters['person']) => void
}) {
  const label =
    chosen === null ? 'Everyone' : `${name ?? 'Chosen account'}${chosen.id === me ? ' (you)' : ''}`
  return (
    <Popover
      width={260}
      onEscapeKeyDown={(event) => {
        // Escape clears the people search first (PersonChoices), and closes
        // the list once the search is empty
        const field = event.target
        if (field instanceof HTMLInputElement && field.matches('[data-api-access-people-search]'))
          if (field.value !== '') event.preventDefault()
      }}
      button={(toggle, open) => (
        <Button
          type="button"
          variant="outline"
          data-api-access-person=""
          data-on={open ? '' : undefined}
          aria-label={`Person: ${label}`}
          onClick={toggle}
          className="h-control w-[160px] shrink-0 justify-between bg-surface-1 px-2 text-sm font-normal"
        >
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="chevronDown" size={14} />
        </Button>
      )}
    >
      {(close) => (
        <PersonChoices
          chosen={chosen}
          me={me}
          onPick={(person) => close(() => person?.id !== chosen?.id && onChange(person))}
        />
      )}
    </Popover>
  )
}

/** The people the person filter lists so far, and where reading stands. */
type People = {
  rows: ApiAccessPerson[]
  next: string | null
  stopped: boolean
  phase: 'first' | 'ready' | 'more' | 'failed' | 'not_ready'
}
const NO_PEOPLE: People = { rows: [], next: null, stopped: false, phase: 'first' }

/* The open person filter: Everyone, the viewer marked "(you)", then the
   organization's people and agents in name order, matching the search once
   typing rests, with Load more for the next batch. */
function PersonChoices({
  chosen,
  me,
  onPick,
}: {
  chosen: ApiAccessFilters['person']
  me: string
  onPick: (person: ApiAccessFilters['person']) => void
}) {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<People>(NO_PEOPLE)
  const [attempt, setAttempt] = useState(0)
  const sequence = useRef(0)
  // the list, by its sequence, whose Load more is on its way, so a second
  // press or a Retry starts no second read of it
  const reading = useRef<number | null>(null)
  const typed = text.trim()
  const tooLong = overLimit(LIMITS.search, typed)
  useEffect(() => {
    if (typed === '') return setQuery('')
    if (tooLong) return
    const timer = window.setTimeout(() => setQuery(typed), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [typed, tooLong])
  useEffect(() => {
    const n = ++sequence.current
    setList(NO_PEOPLE)
    void P.apiAccessPeople(query, null).then((answer) => {
      if (n !== sequence.current) return
      setList(
        answer === null
          ? { ...NO_PEOPLE, phase: 'failed' }
          : answer.state === 'not_ready'
            ? { ...NO_PEOPLE, phase: 'not_ready' }
            : { rows: answer.rows, next: answer.next, stopped: answer.stopped, phase: 'ready' },
      )
    })
    return () => {
      sequence.current++
    }
  }, [query, attempt])
  /* The next batch, after the rows listed: Load more, or Retry once a
     Load more failed. */
  const more = () => {
    const n = sequence.current
    if (list.next === null || reading.current === n) return
    if (list.phase !== 'ready' && list.phase !== 'failed') return
    reading.current = n
    setList((current) => ({ ...current, phase: 'more' }))
    void P.apiAccessPeople(query, list.next).then((answer) => {
      if (reading.current === n) reading.current = null
      if (n !== sequence.current) return
      setList((current) =>
        answer === null || answer.state !== 'ready'
          ? { ...current, phase: 'failed' }
          : {
              rows: [...current.rows, ...answer.rows],
              next: answer.next,
              stopped: answer.stopped,
              phase: 'ready',
            },
      )
    })
  }
  const myName = P.user(me)?.name ?? 'You'
  // the viewer leads the list without a search, and keeps their place in one
  const matches = query === '' ? list.rows.filter((person) => person.id !== me) : list.rows
  const full = list.rows.length >= PEOPLE_MOST
  return (
    <div data-api-access-people="" className="flex flex-col gap-1">
      <LimitedInput
        limit={LIMITS.search}
        aria-label="Search people"
        data-api-access-people-search=""
        placeholder="Search people"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears the search first; an empty field closes the list
          if (e.key === 'Escape' && text) {
            e.stopPropagation()
            setText('')
          }
        }}
        className="h-control text-sm"
      />
      <div className="max-h-[280px] overflow-y-auto">
        <MenuItem active={chosen === null} onClick={() => onPick(null)}>
          Everyone
        </MenuItem>
        {query === '' && (
          <MenuItem
            active={chosen?.id === me}
            onClick={() => onPick({ id: me, name: myName })}
            data-api-access-person-choice={me}
          >
            {myName} (you)
          </MenuItem>
        )}
        {matches.map((person) => (
          <MenuItem
            key={person.id}
            active={chosen?.id === person.id}
            onClick={() => onPick({ id: person.id, name: person.name })}
            data-api-access-person-choice={person.id}
          >
            <span className="min-w-0 truncate">
              {person.name}
              {person.id === me ? ' (you)' : ''}
            </span>
            {person.agent && <span className="ml-auto text-xs text-text-2">agent</span>}
          </MenuItem>
        ))}
        {tooLong ? (
          <p className="px-2 py-1 text-sm text-text-2">{limitSentence(LIMITS.search)}</p>
        ) : list.phase === 'first' ? (
          <p role="status" className="px-2 py-1 text-sm text-text-2">
            Loading people…
          </p>
        ) : list.phase === 'not_ready' ? (
          <p className="px-2 py-1 text-sm text-text-2">
            The people list is not ready yet. Try again in a few minutes.
          </p>
        ) : list.phase === 'failed' ? (
          <div role="alert" className="flex items-center gap-2 px-2 py-1 text-sm text-danger">
            Couldn't load people.
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm text-sm"
              // a failed Load more keeps its place, which a batch with no
              // match before it has too; a failed first batch starts again
              onClick={() => (list.next === null ? setAttempt((n) => n + 1) : more())}
            >
              Retry
            </Button>
          </div>
        ) : list.next !== null && full ? (
          <p className="px-2 py-1 text-sm text-text-2">Search to find more people.</p>
        ) : list.next !== null ? (
          <>
            {list.stopped && (
              <p className="px-2 py-1 text-sm text-text-2">
                Qivo checked part of the list. Load more continues.
              </p>
            )}
            <MenuItem
              data-api-access-people-more=""
              disabled={list.phase === 'more'}
              onClick={more}
            >
              {list.phase === 'more' ? 'Loading…' : 'Load more'}
            </MenuItem>
          </>
        ) : matches.length === 0 && query !== '' ? (
          <p className="px-2 py-1 text-sm text-text-2">No people match.</p>
        ) : null}
      </div>
    </div>
  )
}

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
          {row.removed ? (
            // a person who left has no portrait; Avatar would call them Unassigned
            <span
              aria-hidden="true"
              className="grid size-5 shrink-0 place-items-center rounded-[4px] border border-dashed border-border-strong bg-surface-3"
            >
              <Icon name="user" size={11} color="var(--text-3)" />
            </span>
          ) : (
            <Avatar id={row.profile_id} size={20} />
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
