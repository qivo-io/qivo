/* Billing's API calls by account: the accounts with calls in the usage
   bucket the figures show, most calls first, a batch of 25 at a time with
   Load more and a search of account names over the whole list
   (billing.apiAccounts, from the server's account totals). It reads each
   batch once through the shared paged list's `once` source
   (lib/pagedList.ts) and never subscribes, holds only the rows it shows,
   at most ACCOUNT_LIST.most, and drops them when Billing is left. Each row
   is an account's total over all its credentials, with View credentials,
   which opens API access on that account and the same bucket. Calls change
   while an admin browses and nothing freezes a snapshot, so an account can
   be missed until Refresh, and one the server answers again shows once.
   `refresh` is the page's Refresh count, which starts the list over from
   its first batch and keeps its search; a new search starts only this list
   over. */
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ApiAccessEntry } from '@/lib/apiAccess'
import { api } from '../../convex/_generated/api'
import type { ApiAccountRow, ApiAccounts } from '../../convex/lib/billingTypes'
import { LIMITS } from '../../convex/lib/limits'
import { LimitedInput } from '../components/LimitedField'
import { SettingsGroup } from '../components/settingsPage'
import { ACCOUNT_LIST } from '../lib/billingDisplay'
import { convex } from '../lib/convex'
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'

/* One batch read once, or null for a read that failed. Empty fields are
   left out. */
async function readAccounts(
  orgId: string,
  period: string,
  search: string,
  cursor: string | null,
): Promise<ApiAccounts | null> {
  try {
    return await convex.query(api.billing.apiAccounts, {
      org_id: orgId,
      period,
      ...(search === '' ? {} : { search }),
      ...(cursor === null ? {} : { cursor }),
    })
  } catch {
    return null
  }
}

const noteClass = 'px-0.5 py-1 text-sm text-text-2'
const accountId = (row: ApiAccountRow) => row.profile_id

/** API calls by account for organization `orgId` in the bucket keyed
    `period`, the one the figures answered, started over whenever `refresh`
    or `period` changes. View credentials hands `onViewCredentials` the
    organization, the account and `period`. */
export function BillingApiAccounts({
  orgId,
  period,
  refresh,
  onViewCredentials,
}: {
  orgId: string
  period: string
  refresh: number
  onViewCredentials: (entry: ApiAccessEntry) => void
}) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = JSON.stringify([orgId, refresh, period, search.settled])
  const list = usePagedList({
    key,
    source: { kind: 'once', read: (at) => readAccounts(orgId, period, search.settled, at.after) },
    batch: (answer: ApiAccounts) => (answer.state === 'ready' ? answer : null),
    id: accountId,
    most: ACCOUNT_LIST.most,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')

  // The focus rules of Storage by project (BillingStorage): Load more keeps
  // focus while it reads, and its Retry is the same button; once it goes,
  // focus moves to the first new row, else to the search box. A first
  // batch's Retry that goes moves focus to the search box. A Refresh or a
  // new search leaves focus where it is.
  const searchBox = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const moreFrom = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    const id = row === undefined ? null : accountId(row)
    const element = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-billing-account]') ?? []),
    ].find((li) => li.dataset.billingAccount === id)
    return element ?? searchBox.current
  })
  const more = () => {
    if (list.phase === 'more') return
    moreFrom.current = list.rows.length
    list.more()
  }
  // the list whose failed first batch a Retry read again
  const retried = useRef<string | null>(null)
  useFocusWhenGone(end === 'failed' && list.batches.length === 0, () =>
    retried.current === key ? searchBox.current : null,
  )
  const retry = () => {
    retried.current = list.batches.length === 0 ? key : null
    list.retry()
  }

  return (
    <SettingsGroup
      legend="API calls by account"
      description="Most calls first. Each account’s total covers all of its credentials."
      data-billing-accounts=""
    >
      <LimitedInput
        ref={searchBox}
        limit={LIMITS.search}
        aria-label="Search accounts"
        data-billing-accounts-search=""
        placeholder="Search accounts"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears a typed search first
          if (e.key === 'Escape' && text) {
            e.stopPropagation()
            setText('')
          }
        }}
        wrapperClassName="mb-2"
        className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
      />
      <div
        data-billing-accounts-list=""
        data-billing-accounts-end={end}
        aria-busy={end === 'loading' || list.phase === 'more' || undefined}
      >
        {list.rows.length > 0 && (
          <ul ref={listRef} className="flex flex-col gap-3">
            {list.rows.map((row) => (
              <AccountRow
                key={row.profile_id}
                row={row}
                onView={() =>
                  onViewCredentials({
                    org_id: orgId,
                    profile_id: row.profile_id,
                    period_key: period,
                  })
                }
              />
            ))}
          </ul>
        )}
        <EndLine
          end={end}
          stopped={list.stopped}
          none={list.rows.length === 0}
          first={list.batches.length === 0}
          counting={list.failure?.state === 'counting'}
          loading={list.phase === 'more'}
          searching={search.settled !== ''}
          onMore={more}
          onRetry={retry}
        />
      </div>
    </SettingsGroup>
  )
}

/* One account: its name, or Removed user, its calls and View credentials.
   It takes focus from the code after Load more, never from Tab. */
function AccountRow({ row, onView }: { row: ApiAccountRow; onView: () => void }) {
  return (
    <li
      data-billing-account={row.profile_id}
      tabIndex={-1}
      className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="block break-words text-sm font-semibold">{row.name}</span>
      <span className="mt-1 flex flex-wrap items-baseline gap-x-3 text-sm text-text-2">
        <span data-billing-account-calls="">
          {row.calls.toLocaleString()} call{row.calls === 1 ? '' : 's'}
        </span>
        <Button
          type="button"
          variant="unstyled"
          data-billing-view-credentials={row.profile_id}
          aria-label={`View credentials of ${row.name}`}
          onClick={onView}
          className="align-baseline font-normal text-text-1 underline underline-offset-4"
        >
          View credentials
        </Button>
      </span>
    </li>
  )
}

/* The line that ends the list (lib/pagedList.ts listEnd), with its Load
   more and Retry. The failure's Retry is the same button as Load more, in
   the same place, so focus stays on it when a Load more fails. */
function EndLine({
  end,
  stopped,
  none,
  first,
  counting,
  loading,
  searching,
  onMore,
  onRetry,
}: {
  end: ListEnd | 'too_long'
  stopped: boolean
  /** whether no loaded batch holds a row */
  none: boolean
  /** whether no batch answered yet, so a failure is the list's, not a
      Load more's */
  first: boolean
  /** whether a later batch answered that the calls are being counted */
  counting: boolean
  /** whether a Load more is on its way */
  loading: boolean
  searching: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const line = (text: string, status = false) => (
    <p data-billing-accounts-note={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  const button = (label: string, onClick: () => void, more = false) => (
    <Button
      type="button"
      variant="ghost"
      data-billing-accounts-more={more ? '' : undefined}
      data-billing-accounts-retry={more ? undefined : ''}
      aria-disabled={loading || undefined}
      onClick={() => !loading && onClick()}
      className="h-control-sm text-sm"
    >
      {label}
    </Button>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return line('Loading API calls by account…', true)
    case 'held':
      return line('API calls are being counted. Check again later.')
    case 'failed':
      if (counting)
        return line('API calls are being counted again. Refresh to start the list over.')
      return (
        <div
          role="alert"
          data-billing-accounts-note={end}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {first ? "Couldn't load API calls by account." : "Couldn't load more accounts."}
          {button('Retry', onRetry)}
        </div>
      )
    case 'full':
      return line('Search to find more accounts.')
    case 'more':
      return (
        <div data-billing-accounts-note={end} className="mt-1 flex flex-col items-start gap-1">
          {stopped && (
            <p className={noteClass}>
              {none
                ? 'Qivo checked part of the list and found no matches there. Load more continues.'
                : 'Qivo checked part of the list. Load more continues.'}
            </p>
          )}
          {button(loading ? 'Loading…' : 'Load more', onMore, true)}
        </div>
      )
    case 'partial':
      return null
    case 'none':
      return line('No accounts match.')
    case 'end':
      return none && !searching ? line('No recorded API calls this period.') : null
  }
}
