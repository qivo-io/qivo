import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState } from 'react'
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
import { focusAround } from '@/lib/focusWhenGone'
import type { api } from '../../convex/_generated/api'
import { Icon } from '../components/qivo'
import { SettingsGroup } from '../components/settingsPage'
import { useClosingWords } from '../lib/closingWords'
import { connectionScopeLabel } from '../lib/oauthConnection'
import { useUpdateBlocker } from '../lib/updateSafety'
import { P } from '../store/planner'

type Connection = FunctionReturnType<typeof api.oauthConnections.list>[number]

export function ConnectedApps() {
  const [connections, setConnections] = useState<Connection[] | null>(null)
  // the list's load failure, shown on the page
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Connection | null>(null)
  // a refused delete, shown in the dialog only and cleared when it opens
  const [deleteError, setDeleteError] = useState('')
  const [busy, setBusy] = useState(false)
  // where focus goes once the dialog has closed, taken as it opens: the
  // Delete that opened it, else, once its connection is gone, the next
  // row's, else the nearest one before it, else the empty list's line
  const focusAfter = useRef<() => HTMLElement | null>(() => null)
  const empty = useRef<HTMLParagraphElement>(null)
  useUpdateBlocker(busy)
  // a close clears the selection, so the closing dialog keeps its words
  const shown = useClosingWords(!!selected, { name: selected?.clientName, busy })
  const reload = async () => {
    const result = await P.listOAuthConnections()
    if (result === null) setError('Could not load connected apps. Try again.')
    else {
      setConnections(result)
      setError('')
    }
  }
  useEffect(() => {
    void reload()
  }, [])
  const remove = async () => {
    if (!selected || busy) return
    setBusy(true)
    setDeleteError('')
    if (await P.revokeOAuthConnection(selected.id)) {
      setConnections(
        (current) => current?.filter((connection) => connection.id !== selected.id) ?? null,
      )
      setSelected(null)
      await reload()
    } else setDeleteError('Could not delete this connection. Try again.')
    setBusy(false)
  }
  return (
    <SettingsGroup legend="Connected apps" data-connected-apps="">
      <p className="mb-4 text-sm text-text-2">
        Delete a connection to remove it from this list and stop the app’s access. You can connect
        it again from the app.
      </p>
      {connections === null && !error && (
        <p role="status" className="text-sm text-text-2">
          Loading…
        </p>
      )}
      {error && (
        <div className="mb-3">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}
      {connections?.length === 0 && (
        <p ref={empty} tabIndex={-1} className="text-sm text-text-2">
          No connected apps.
        </p>
      )}
      <div className="space-y-2">
        {connections?.map((connection) => (
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
                    () => empty.current,
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
      <AlertDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null)
        }}
      >
        <AlertDialogContent
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
