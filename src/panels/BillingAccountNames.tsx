/* One of Billing's names-only lists, Who counts toward your bill (`kind`
   billable) or Who does not count toward your bill (non_billable): the
   organization's people and agents in name order, a batch of 25 at a time
   with Load more and a search of names (billing.accountList), each kept on
   the server by the rule that counts them, so the list and the counters
   agree. The page mounts it only while its list is open, so a closed list
   reads nothing and closing one drops its rows. It reads each batch once
   through the shared paged list's `once` source (lib/pagedList.ts), holds
   at most NAME_LIST.most rows, and starts over from its first batch,
   keeping its search, when `refresh`, the page's Refresh count, changes. */
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '../../convex/_generated/api'
import type { AccountNameRow, AccountNames } from '../../convex/lib/billingTypes'
import { LIMITS } from '../../convex/lib/limits'
import { LimitedInput } from '../components/LimitedField'
import { NAME_LIST } from '../lib/billingDisplay'
import { convex } from '../lib/convex'
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'

/** Which of the two lists. */
export type AccountListKind = 'billable' | 'non_billable'

/* What each list says where it differs: its search box's name and its line
   for an empty list. */
const KINDS: Record<AccountListKind, { search: string; empty: string }> = {
  billable: { search: 'Search who counts toward your bill', empty: 'No billable users.' },
  non_billable: {
    search: 'Search who does not count toward your bill',
    empty: 'No non-billable users.',
  },
}

/* One batch read once, or null for a read that failed. Empty fields are
   left out. */
async function readNames(
  orgId: string,
  kind: AccountListKind,
  search: string,
  cursor: string | null,
): Promise<AccountNames | null> {
  try {
    return await convex.query(api.billing.accountList, {
      org_id: orgId,
      kind,
      ...(search === '' ? {} : { search }),
      ...(cursor === null ? {} : { cursor }),
    })
  } catch {
    return null
  }
}

const noteClass = 'py-1 text-sm text-text-2'
const nameId = (row: AccountNameRow) => row.profile_id

/** The `kind` list of organization `orgId`'s names, started over whenever
    `refresh` changes. */
export function BillingAccountNames({
  orgId,
  kind,
  refresh,
}: {
  orgId: string
  kind: AccountListKind
  refresh: number
}) {
  const words = KINDS[kind]
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = JSON.stringify([orgId, refresh, kind, search.settled])
  const list = usePagedList({
    key,
    source: { kind: 'once', read: (at) => readNames(orgId, kind, search.settled, at.after) },
    batch: (answer: AccountNames) => (answer.state === 'ready' ? answer : null),
    id: nameId,
    most: NAME_LIST.most,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')

  // The focus rules of Storage by project (BillingStorage): once Load more
  // goes, focus moves to the first new name, else to the search box, and a
  // first batch's Retry that goes moves focus to the search box.
  const searchBox = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const moreFrom = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    const element = [...(listRef.current?.querySelectorAll<HTMLElement>('li') ?? [])].find(
      (li) => row !== undefined && li.dataset.billingName === row.profile_id,
    )
    return element ?? searchBox.current
  })
  const more = () => {
    if (list.phase === 'more') return
    moreFrom.current = list.rows.length
    list.more()
  }
  const retried = useRef<string | null>(null)
  useFocusWhenGone(end === 'failed' && list.batches.length === 0, () =>
    retried.current === key ? searchBox.current : null,
  )
  const retry = () => {
    retried.current = list.batches.length === 0 ? key : null
    list.retry()
  }

  return (
    <div className="mt-3" data-billing-names={kind}>
      <LimitedInput
        ref={searchBox}
        limit={LIMITS.search}
        aria-label={words.search}
        data-billing-names-search={kind}
        placeholder="Search names"
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
        data-billing-names-list={kind}
        data-billing-names-end={end}
        aria-busy={end === 'loading' || list.phase === 'more' || undefined}
      >
        {list.rows.length > 0 && (
          <ul ref={listRef} className="space-y-2">
            {list.rows.map((row) => (
              <li
                key={row.profile_id}
                data-billing-name={row.profile_id}
                data-billable-account={kind === 'billable' ? row.profile_id : undefined}
                data-non-billable-account={kind === 'non_billable' ? row.profile_id : undefined}
                tabIndex={-1}
                className="break-words rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {row.name}
              </li>
            ))}
          </ul>
        )}
        <EndLine
          end={end}
          empty={words.empty}
          stopped={list.stopped}
          none={list.rows.length === 0}
          first={list.batches.length === 0}
          preparing={list.failure?.state === 'not_ready'}
          loading={list.phase === 'more'}
          searching={search.settled !== ''}
          onMore={more}
          onRetry={retry}
        />
      </div>
    </div>
  )
}

/* The line that ends the list (lib/pagedList.ts listEnd), with its Load
   more and Retry, which is the same button in the same place. */
function EndLine({
  end,
  empty,
  stopped,
  none,
  first,
  preparing,
  loading,
  searching,
  onMore,
  onRetry,
}: {
  end: ListEnd | 'too_long'
  /** what an empty list says */
  empty: string
  stopped: boolean
  none: boolean
  first: boolean
  /** whether a later batch answered that the names are being prepared */
  preparing: boolean
  loading: boolean
  searching: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const line = (text: string, status = false) => (
    <p data-billing-names-note={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  const button = (label: string, onClick: () => void, more = false) => (
    <Button
      type="button"
      variant="ghost"
      data-billing-names-more={more ? '' : undefined}
      data-billing-names-retry={more ? undefined : ''}
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
      return line('Loading…', true)
    case 'held':
      return line('This list is being prepared. Check again later.')
    case 'failed':
      if (preparing) return line('This list is being prepared again. Refresh to start it over.')
      return (
        <div
          role="alert"
          data-billing-names-note={end}
          className="flex flex-wrap items-center gap-2 py-1 text-sm text-danger"
        >
          {first ? "Couldn't load this list." : "Couldn't load more names."}
          {button('Retry', onRetry)}
        </div>
      )
    case 'full':
      return line('Search to find more accounts.')
    case 'more':
      return (
        <div data-billing-names-note={end} className="mt-1 flex flex-col items-start gap-1">
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
      return none && !searching ? line(empty) : null
  }
}
