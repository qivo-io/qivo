/* Connected apps on Settings → Your preferences → MCP access: the apps the
   signed-in login connected over OAuth, newest approval first, 25 a batch
   from the server (connectedApps.list) with Load more, read once a batch
   through the shared paged list's `once` source (lib/pagedList.ts) and
   never subscribed, since every call made with a connection stamps its last
   use. Each row names the app, the organization and seat it acts in, its
   scopes and dates, and whether an admin revoked it or its app is gone. A
   search over the whole list, by app, organization or seat name, appears
   once a list without a search has more than one batch in this visit, or
   while it holds text. Delete asks first; a delete hides its row at once
   and reads the list again from its first batch with its search kept,
   while the other rows stay on screen. Past APP_LIST.most rows the list
   asks for a search, and leaving the page drops every row. */
import { type RefObject, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { restoreFocus } from '@/lib/focusVisibility'
import { focusAround, useFocusAfterRender, useFocusWhenGone } from '@/lib/focusWhenGone'
import { LIMITS } from '../../convex/lib/limits'
import { LimitedInput } from '../components/LimitedField'
import { Icon } from '../components/qivo'
import { SettingsGroup } from '../components/settingsPage'
import { useClosingWords } from '../lib/closingWords'
import { APP_LIST } from '../lib/credentialLists'
import { limitSentence } from '../lib/fieldLimits'
import { connectionScopeLabel } from '../lib/oauthConnection'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { useUpdateBlocker } from '../lib/updateSafety'
import { type ConnectedAppBatch, P } from '../store/planner'

/** One connected app as the list shows it (connectedApps.list). */
type Connection = ConnectedAppBatch['rows'][number]

const noteClass = 'px-0.5 py-1 text-sm text-text-2'
const appId = (connection: Connection) => connection.id
/** The Delete button of the connection row with id `id`. */
const rowButton = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-oauth-connection]')]
    .find((row) => row.dataset.oauthConnection === id)
    ?.querySelector<HTMLElement>('button') ?? null

/** The Connected apps group: the search, the list with its end line, and
    the delete question. */
export function ConnectedApps() {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = JSON.stringify([search.settled])
  const list = usePagedList({
    key,
    source: { kind: 'once', read: (at) => P.connectedApps(search.settled, at.after) },
    batch: (answer: ConnectedAppBatch) => answer,
    id: appId,
    most: APP_LIST.most,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')
  // The search the list on screen answers, which the end line carries for
  // the staging check (scripts/staging-check.mjs listSettled). It follows
  // the settled search in the effect after the one that opens its list, so
  // it changes in the same render as the list's state.
  const [listed, setListed] = useState(search.settled)
  useEffect(() => setListed(search.settled), [search.settled])
  // The search shows once the list without a search answered more than
  // one batch's worth in this visit, and stays for the rest of it.
  const [searchShown, setSearchShown] = useState(false)
  const showSearch = searchShown || text !== '' || (search.settled === '' && list.next)
  useEffect(() => {
    if (showSearch) setSearchShown(true)
  }, [showSearch])
  // connections deleted here, hidden until the list's refresh has landed
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set())
  const rows = deleted.size === 0 ? list.rows : list.rows.filter((c) => !deleted.has(c.id))
  const [selected, setSelected] = useState<Connection | null>(null)
  // a refused delete, shown in the dialog only and cleared when it opens
  const [deleteError, setDeleteError] = useState('')
  const [busy, setBusy] = useState(false)
  // where focus goes once the dialog has closed, taken as it opens: the
  // Delete that opened it, else, once its connection is gone, the next
  // row's, else the nearest one before it, else the empty list's line,
  // else Try again, which shows only when the refresh failed and took
  // every row
  const focusAfter = useRef<() => HTMLElement | null>(() => null)
  const focusAfterRender = useFocusAfterRender()
  const empty = useRef<HTMLParagraphElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useUpdateBlocker(busy)
  // a close clears the selection, so the closing dialog keeps its words
  const shown = useClosingWords(!!selected, { name: selected?.clientName, busy })
  const remove = async () => {
    if (!selected || busy) return
    setBusy(true)
    setDeleteError('')
    const id = selected.id
    if (await P.revokeOAuthConnection(id)) {
      setDeleted((current) => new Set(current).add(id))
      setSelected(null)
      await list.refresh()
      setDeleted(new Set())
      // The rows' Delete buttons stay disabled while the list reads again,
      // so a dialog that closed first left focus nowhere. One still fading
      // gives focus itself.
      focusAfterRender(() => (content.current?.isConnected ? null : focusAfter.current()))
    } else setDeleteError('Could not delete this connection. Try again.')
    setBusy(false)
  }

  // A refresh that failed took every row away; focus goes to its Try again,
  // here, or through focusAfter when the closing dialog still held focus.
  const endLine = useRef<HTMLDivElement>(null)
  const retryButton = () =>
    endLine.current?.querySelector<HTMLElement>('[data-connected-apps-retry]') ?? null
  useFocusWhenGone(list.rows.length > 0, () => (end === 'failed' ? retryButton() : null))
  // Load more keeps focus while it reads, and its Retry is the same button;
  // once it goes, focus moves to the first new row's Delete, else to the
  // search.
  const searchBox = useRef<HTMLInputElement>(null)
  const moreFrom = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    return (row ? rowButton(row.id) : null) ?? searchBox.current
  })
  const more = () => {
    if (list.phase === 'more' || list.refreshing) return
    moreFrom.current = list.rows.length
    list.more()
  }
  // A first batch's Try again leaves before anything it could give focus to
  // shows, so focus moves once the batch it reads again has ended: to the
  // search, else the first row's Delete, else the empty list's line, or to
  // the new Try again when it failed again.
  const retried = useRef<string | null>(null)
  useFocusWhenGone(end === 'loading' && list.batches.length === 0, () => {
    if (retried.current !== key) return null
    retried.current = null
    if (end === 'failed') return retryButton()
    return searchBox.current ?? (rows[0] ? rowButton(rows[0].id) : null) ?? empty.current
  })
  const retry = () => {
    retried.current = list.batches.length === 0 ? key : null
    list.retry()
  }

  return (
    <SettingsGroup legend="Connected apps" data-connected-apps="">
      <p className="mb-4 text-sm text-text-2">
        Delete a connection to remove it from this list and stop the app’s access. You can connect
        it again from the app.
      </p>
      {showSearch && (
        <LimitedInput
          ref={searchBox}
          limit={LIMITS.search}
          aria-label="Search connected apps"
          data-connected-apps-search=""
          placeholder="Search connected apps"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears a typed search first
            if (e.key === 'Escape' && text) {
              e.stopPropagation()
              setText('')
            }
          }}
          wrapperClassName="mb-3"
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
        />
      )}
      <div
        ref={endLine}
        data-connected-apps-end={end}
        data-connected-apps-settled-search={listed}
        aria-busy={end === 'loading' || list.phase === 'more' || list.refreshing || undefined}
      >
        <div className="space-y-2">
          {rows.map((connection) => (
            <div
              key={connection.id}
              data-oauth-connection={connection.id}
              className="rounded-md border border-border bg-surface-1 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="break-words text-sm font-semibold">{connection.clientName}</div>
                  <div className="mt-1 break-words text-xs text-text-2">
                    {connection.orgName}, {connection.profileName}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  disabled={busy}
                  onClick={() => {
                    focusAfter.current = focusAround(
                      'data-oauth-connection',
                      connection.id,
                      (row) => row.querySelector('button'),
                      () => empty.current ?? retryButton(),
                    )
                    setDeleteError('')
                    setSelected(connection)
                  }}
                >
                  <Icon name="trash" size={16} />
                  Delete
                </Button>
              </div>
              <div className="mt-2 space-y-1 text-xs text-text-2">
                {connection.revokedAt ? (
                  <div data-oauth-connection-revoked="" className="text-danger">
                    {connection.revokedByAdmin ? 'Revoked by an admin' : 'Access revoked'}
                  </div>
                ) : (
                  // its app is no longer in Qivo, so it can never act again
                  connection.appGone && (
                    <div data-oauth-connection-revoked="app-gone" className="text-danger">
                      App no longer available
                    </div>
                  )
                )}
                {connection.scopes.map((scope) => (
                  <div key={scope}>{connectionScopeLabel(scope)}</div>
                ))}
                <div>
                  Connected {P.fmtDate(new Date(connection.createdAt))}
                  {connection.lastUsedAt
                    ? `, last used ${P.fmtDate(new Date(connection.lastUsedAt))}`
                    : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
        <AppsEnd
          end={end}
          stopped={list.stopped}
          none={rows.length === 0}
          first={list.batches.length === 0}
          loading={list.phase === 'more'}
          refreshing={list.refreshing}
          searching={search.settled !== ''}
          empty={empty}
          onMore={more}
          onRetry={retry}
        />
      </div>
      <AlertDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null)
        }}
      >
        <AlertDialogContent
          ref={content}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus(focusAfter.current())
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {shown.name} connection?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the connection and stops the app’s access to Qivo, including automatic
              renewal. You can connect it again from the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-danger">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={shown.busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={shown.busy}
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              {shown.busy ? 'Deleting…' : 'Delete connection'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  )
}

/* The line that ends the list (lib/pagedList.ts listEnd), with its Load
   more and Retry. A failed Load more's Retry is the same button as Load
   more, in the same place, so focus stays on it. While a refresh reads,
   Load more stays but reads nothing, and the list claims no end. The empty
   line takes focus once the last row has left, so it holds `empty`. */
function AppsEnd({
  end,
  stopped,
  none,
  first,
  loading,
  refreshing,
  searching,
  empty,
  onMore,
  onRetry,
}: {
  end: ListEnd | 'too_long'
  stopped: boolean
  /** whether the list shows no row */
  none: boolean
  /** whether no batch answered yet, so a failure is the list's, not a
      Load more's */
  first: boolean
  /** whether a Load more is on its way */
  loading: boolean
  /** whether the list reads its first batch again */
  refreshing: boolean
  searching: boolean
  empty: RefObject<HTMLParagraphElement | null>
  onMore: () => void
  onRetry: () => void
}) {
  const busy = loading || refreshing
  const line = (text: string, status = false) => (
    <p data-connected-apps-note={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  const emptyLine = (text: string) => (
    <p ref={empty} tabIndex={-1} data-connected-apps-note={end} className="text-sm text-text-2">
      {text}
    </p>
  )
  const button = (label: string, onClick: () => void, more = false) => (
    <Button
      type="button"
      variant="ghost"
      size={more ? undefined : 'sm'}
      data-connected-apps-more={more ? '' : undefined}
      data-connected-apps-retry={more ? undefined : ''}
      aria-disabled={busy || undefined}
      onClick={() => !busy && onClick()}
      className={more ? 'h-control-sm text-sm' : undefined}
    >
      {label}
    </Button>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return (
        <p role="status" data-connected-apps-note={end} className="text-sm text-text-2">
          Loading…
        </p>
      )
    case 'failed':
      return first ? (
        <div data-connected-apps-note={end} className="mb-3">
          <p role="alert" className="text-sm text-danger">
            Could not load connected apps. Try again.
          </p>
          {button('Try again', onRetry)}
        </div>
      ) : (
        <div
          role="alert"
          data-connected-apps-note={end}
          className="mt-2 flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          Couldn't load more connected apps.
          {button('Retry', onRetry)}
        </div>
      )
    case 'full':
      return line('Search to find more connected apps.')
    case 'more':
      return (
        <div data-connected-apps-note={end} className="mt-2 flex flex-col items-start gap-1">
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
    case 'none':
      return refreshing ? null : emptyLine('No connected apps match.')
    case 'end':
      return none && !searching && !refreshing ? emptyLine('No connected apps.') : null
    case 'held':
    case 'partial':
      return null
  }
}
