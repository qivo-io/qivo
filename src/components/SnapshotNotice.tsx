import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { fmtDateYear, fmtTime } from '../lib/dates'
import { floatSlot } from '../lib/floatStack'
import type { SavePause } from '../lib/syncStatus'
import { P, type SnapshotTrouble } from '../store/planner'
import { usePlannerVersion } from '../store/usePlannerVersion'
import { Icon } from './qivo'
import { Button } from './ui/button'

/** When the view was last current. Today it is the time, on an earlier day
    the date and time ("16 Oct, 14:32"), in the organization's day and month
    order. */
export function asOfText(asOf: string, now = new Date()): string {
  const at = new Date(asOf)
  const sameDay = at.toDateString() === now.toDateString()
  return sameDay ? fmtTime(at) : `${fmtDateYear(at, now)}, ${fmtTime(at)}`
}

/** The title and line of the notice while Qivo cannot save. The line
    counts the changes sent before the pause that still wait. */
export function savePauseWords({ kind, waiting }: SavePause): { title: string; line: string } {
  const changes = waiting === 1 ? '1 change' : `${waiting} changes`
  if (kind === 'slow')
    return {
      title: 'Saving is taking longer than usual',
      line: `Editing is paused until it finishes.${waiting ? ` ${changes} ${waiting === 1 ? 'is' : 'are'} still saving.` : ''}`,
    }
  return {
    title: 'You’re offline',
    line: `Editing is paused until the connection is back.${waiting ? ` ${changes} made before the connection dropped will save when it is back. Keep Qivo open until then.` : ''}`,
  }
}

/** The floating notice. It shows, first, while the live workspace snapshot
    is stale, because the query failed mid-session, the sign-in ended or
    every seat is gone: it says when the view was last current and that
    editing is paused, and offers Try again, or Reload when only a reload
    can help. Then, while Qivo cannot save (offline, or saving takes too
    long), it says so and counts the changes still waiting. Neither can be
    hidden while editing is paused. Last, it tells about changes a page that
    closed could not confirm, until dismissed. Mounted once at the root, and
    the floating column places it (lib/floatStack). */
export function SnapshotNotice() {
  usePlannerVersion('health')
  const trouble = P.snapshotTrouble()
  const pause = trouble ? null : P.savePause()
  const report = trouble || pause ? null : P.unconfirmedReport()
  // Details belong to one failure, so a later one starts with them closed.
  const [detailsFor, setDetailsFor] = useState<number | null>(null)
  const details = trouble !== null && detailsFor === trouble.since
  const detailsId = useId()

  const asOf = trouble?.asOf ? `You’re seeing your workspace as of ${asOfText(trouble.asOf)}. ` : ''
  // Each kind's title and line. A lost sign-in or seat does not end by
  // retrying, so those two offer Reload instead of Try again and Details.
  const words: Record<SnapshotTrouble['kind'], { title: string; line: string }> = {
    failed: {
      title: 'Qivo can’t load the latest changes',
      line: asOf
        ? `${asOf}Editing is paused until it loads again. Qivo keeps trying.`
        : 'Editing is paused until your workspace loads again. Qivo keeps trying.',
    },
    signed_out: {
      title: 'You’re signed out',
      line: 'Reload Qivo to sign in again. Text you haven’t saved will be lost.',
    },
    no_access: {
      title: 'You no longer have access to this workspace',
      line: `${asOf}Reload Qivo to continue. Text you haven’t saved will be lost.`,
    },
  }
  const reloadOnly = trouble !== null && trouble.kind !== 'failed'

  // The notice while Qivo cannot save, or else the crash note's report.
  const other = pause
    ? savePauseWords(pause)
    : report
      ? { title: 'Some changes may not have saved', line: report }
      : null

  // Like the update notice, the live region stays mounted outside the app
  // root, so a screen reader hears the notice even over a modal layer.
  return createPortal(
    <div aria-live="polite">
      {other && (
        <div
          data-snapshot-notice={pause ? pause.kind : 'unconfirmed'}
          data-floating-surface
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
        >
          <div className="min-w-0 flex-1 basis-60 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <Icon name="alert" size={16} color="var(--warn)" />
              {other.title}
            </div>
            <div className="mt-1 text-muted-foreground">{other.line}</div>
          </div>
          {report && (
            <div
              className="ml-auto flex items-center gap-2"
              onMouseDown={(event) => event.preventDefault()}
            >
              <Button variant="outline" onClick={() => P.dismissUnconfirmedReport()}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      )}
      {trouble && (
        <div
          data-snapshot-notice={trouble.kind}
          data-floating-surface
          // The notice is outside any modal's DOM. A press here must not close
          // the dialog or window that holds the person's draft.
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
        >
          <div className="min-w-0 flex-1 basis-60 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <Icon name="alert" size={16} color="var(--warn)" />
              {words[trouble.kind].title}
            </div>
            <div className="mt-1 text-muted-foreground">{words[trouble.kind].line}</div>
            {details && !reloadOnly && (
              <div
                id={detailsId}
                className="mt-2 max-h-[min(160px,25dvh)] overflow-y-auto rounded-sm bg-surface-3 px-2 py-1.5 font-mono text-xs leading-normal whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]"
              >
                {trouble.detail}
              </div>
            )}
          </div>
          <div
            className="ml-auto flex items-center gap-2"
            // A focused button outside an open dialog makes the dialog take
            // focus back and select its field's text, which the next key
            // would replace. The Details text stays selectable.
            onMouseDown={(event) => event.preventDefault()}
          >
            {reloadOnly ? (
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  aria-expanded={details}
                  aria-controls={details ? detailsId : undefined}
                  onClick={() => setDetailsFor(details ? null : trouble.since)}
                >
                  {details ? 'Hide details' : 'Details'}
                </Button>
                <Button
                  variant="outline"
                  disabled={trouble.retrying}
                  onClick={() => P.retrySnapshot()}
                >
                  {trouble.retrying ? 'Trying again…' : 'Try again'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>,
    floatSlot('snapshot'),
  )
}
