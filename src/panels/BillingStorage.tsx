/* Billing's Storage by project: the organization's projects with counted
   task files, largest first, a batch of 25 at a time with Load more and a
   search of project names over the whole list (billing.storageProjects,
   from the server's stored-byte totals). It reads each batch once through
   the shared paged list's `once` source (lib/pagedList.ts) and never
   subscribes, holds only the rows it shows and drops them when Billing is
   left. Projects in Deleted items and removed projects are listed with
   their label, since their files still count until they are deleted for
   good. Bytes change while an admin browses and nothing freezes a
   snapshot, so a project can be missed until Refresh, and one the server
   answers again shows once. `refresh` is the page's Refresh count, which
   starts the list over from its first batch and keeps its search. */
import { useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '../../convex/_generated/api'
import type { StorageProjectRow, StorageProjects } from '../../convex/lib/billingTypes'
import { LIMITS } from '../../convex/lib/limits'
import { LimitedInput } from '../components/LimitedField'
import { SettingsGroup } from '../components/settingsPage'
import { billingBytes, STORAGE_LIST, storageRowId } from '../lib/billingDisplay'
import { convex } from '../lib/convex'
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'

/** The label beside a project that is not active. */
const STATUS_LABEL: Record<StorageProjectRow['status'], string | null> = {
  active: null,
  archived: 'Archived',
  deleted: 'In Deleted items',
  removed: 'Removed',
}

/* One batch read once, or null for a read that failed. Empty fields are
   left out. */
async function readStorage(
  orgId: string,
  search: string,
  cursor: string | null,
): Promise<StorageProjects | null> {
  try {
    return await convex.query(api.billing.storageProjects, {
      org_id: orgId,
      ...(search === '' ? {} : { search }),
      ...(cursor === null ? {} : { cursor }),
    })
  } catch {
    return null
  }
}

const noteClass = 'px-0.5 py-1 text-sm text-text-2'

/** Storage by project for organization `orgId`, started over whenever
    `refresh` changes. */
export function BillingStorage({ orgId, refresh }: { orgId: string; refresh: number }) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: JSON.stringify([orgId, refresh, search.settled]),
    source: { kind: 'once', read: (at) => readStorage(orgId, search.settled, at.after) },
    batch: (answer: StorageProjects) => (answer.state === 'ready' ? answer : null),
    id: storageRowId,
    most: STORAGE_LIST.most,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')

  // Load more keeps focus while it reads (aria-disabled), and the Retry
  // that takes its place after a failure is the same button. When Load
  // more goes, focus moves to the first new row, else to the search box.
  const searchBox = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const moreFrom = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    const id = row === undefined ? null : storageRowId(row)
    const element = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-billing-storage-row]') ?? []),
    ].find((li) => li.dataset.billingStorageRow === id)
    return element ?? searchBox.current
  })
  const more = () => {
    if (list.phase === 'more') return
    moreFrom.current = list.rows.length
    list.more()
  }

  return (
    <SettingsGroup
      legend="Storage by project"
      description="Largest first. Archived projects and projects in Deleted items included."
      data-billing-storage=""
    >
      <LimitedInput
        ref={searchBox}
        limit={LIMITS.search}
        aria-label="Search projects"
        data-billing-storage-search=""
        placeholder="Search projects"
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
        data-billing-storage-list=""
        data-billing-storage-end={end}
        aria-busy={end === 'loading' || list.phase === 'more' || undefined}
      >
        {list.rows.length > 0 && (
          <ul ref={listRef} className="flex flex-col gap-2">
            {list.rows.map((row) => (
              <StorageRow key={storageRowId(row)} row={row} />
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
          onRetry={() => list.retry()}
        />
      </div>
    </SettingsGroup>
  )
}

/* One project: its key and name, or "Removed project" for a row with no
   name left, its label when it is not active, and its bytes and files. It
   takes focus from the code after Load more, never from Tab. */
function StorageRow({ row }: { row: StorageProjectRow }) {
  const label = STATUS_LABEL[row.status]
  return (
    <li
      data-billing-storage-row={storageRowId(row)}
      data-billing-storage-status={row.status}
      tabIndex={-1}
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        {row.key !== null && <span className="font-mono text-xs text-text-2">{row.key}</span>}
        <span className="min-w-0 break-words">{row.name ?? 'Removed project'}</span>
        {label !== null && (
          <Badge variant="outline" data-billing-storage-label="" className="font-normal">
            {label}
          </Badge>
        )}
      </span>
      <span className="text-sm whitespace-nowrap text-text-2">
        {billingBytes(row.bytes)} · {row.files === 1 ? '1 file' : `${row.files} files`}
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
  /** whether a later batch answered that the totals are being counted */
  counting: boolean
  /** whether a Load more is on its way */
  loading: boolean
  searching: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const line = (text: string, status = false) => (
    <p data-billing-storage-note={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  const button = (label: string, onClick: () => void, more = false) => (
    <Button
      type="button"
      variant="ghost"
      data-billing-storage-more={more ? '' : undefined}
      data-billing-storage-retry={more ? undefined : ''}
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
      return line('Loading storage by project…', true)
    case 'held':
      return line('Storage is being counted. Check again later.')
    case 'failed':
      if (counting) return line('Storage is being counted again. Refresh to start the list over.')
      return (
        <div
          role="alert"
          data-billing-storage-note={end}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {first ? "Couldn't load storage by project." : "Couldn't load more projects."}
          {button('Retry', onRetry)}
        </div>
      )
    case 'full':
      return line('Search to find more projects.')
    case 'more':
      return (
        <div data-billing-storage-note={end} className="mt-1 flex flex-col items-start gap-1">
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
      return line('No projects match.')
    case 'end':
      return none && !searching ? line('No stored files.') : null
  }
}
