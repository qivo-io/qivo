import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { floatSlot } from '../lib/floatStack'
import { asOfText, savePauseWords } from '../lib/noticeText'
import { reloadPage } from '../lib/pageHistory'
import { ORG_DELETING_TEXT, P, type SnapshotTrouble } from '../store/planner'
import { usePlannerVersion } from '../store/usePlannerVersion'
import { NoticeCard } from './NoticeCard'
import { Button } from './ui/button'

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
  // A part that refused to load says why, which retrying alone may not end.
  const words: Record<SnapshotTrouble['kind'], { title: string; line: string }> = {
    failed: {
      title: 'Qivo can’t load the latest changes',
      line: trouble?.reason
        ? `${asOf}${trouble.reason} Editing is paused until it loads again.`
        : asOf
          ? `${asOf}Editing is paused until it loads again. Qivo keeps trying.`
          : 'Editing is paused until your workspace loads again. Qivo keeps trying.',
    },
    signed_out: {
      title: 'You’re signed out',
      line: 'Reload Qivo to sign in again. Text you haven’t saved will be lost.',
    },
    // the reason, when the seats went because the organization is being deleted
    no_access: {
      title:
        trouble?.reason === ORG_DELETING_TEXT
          ? 'This organization is being deleted'
          : 'You no longer have access to this workspace',
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
        <NoticeCard
          kind={pause ? pause.kind : 'unconfirmed'}
          title={other.title}
          line={other.line}
          actions={
            report && (
              <Button variant="outline" onClick={() => P.dismissUnconfirmedReport()}>
                Dismiss
              </Button>
            )
          }
        />
      )}
      {trouble && (
        <NoticeCard
          kind={trouble.kind}
          title={words[trouble.kind].title}
          line={words[trouble.kind].line}
          details={
            details &&
            !reloadOnly && (
              <div
                id={detailsId}
                className="mt-2 max-h-[min(160px,25dvh)] overflow-y-auto rounded-sm bg-surface-3 px-2 py-1.5 font-mono text-xs leading-normal whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]"
              >
                {trouble.detail}
              </div>
            )
          }
          actions={
            reloadOnly ? (
              <Button variant="outline" onClick={() => reloadPage()}>
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
            )
          }
        />
      )}
    </div>,
    floatSlot('snapshot'),
  )
}
