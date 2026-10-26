import { ConvexError } from 'convex/values'
import { useRef, useState } from 'react'
import { SettingsSection } from '@/components/settingsPage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { billingDate } from '@/lib/billingDisplay'
import { useClosingWords } from '@/lib/closingWords'
import { convex } from '@/lib/convex'
import { restoreFocus } from '@/lib/focusVisibility'
import { useFocusWhenGone } from '@/lib/focusWhenGone'
import { holdUnsaved } from '@/lib/leaveGuard'
import { useOrgRemovalState } from '@/lib/orgRemovalState'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../convex/_generated/api'
import { P } from '../store/planner'

/** A refusal's own sentence, or `fallback` for any other failure. */
const failure = (cause: unknown, fallback: string) => {
  const message = cause instanceof ConvexError ? cause.data?.message : null
  return typeof message === 'string' ? message : fallback
}

/** Lets an admin delete the organization after its read-only period, or
 * stop a deletion an admin asked for. The question stays mounted when the
 * scheduled deletion arrives: it waits for its own request, and one that
 * waits for nothing closes. Once its button is gone, focus that it or the
 * closed question left goes to the deletion's date, and once Keep
 * organization is gone, to Delete organization when it is back. */
export function OrganizationDeletion({ orgId, orgName }: { orgId: string; orgName: string }) {
  const state = useOrgRemovalState(orgId)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const opener = useRef<HTMLButtonElement>(null)
  const scheduled = useRef<HTMLParagraphElement>(null)
  const question = useRef<HTMLDivElement>(null)
  useUpdateBlocker(busy)
  // another admin's deletion, or this one's after a lost answer, while the
  // question waits for nothing: what it typed and its refusal go with it
  if (state?.deletion && open && !busy) {
    setOpen(false)
    setConfirm('')
    setError('')
  }
  // the deletion or its stop can arrive after the answer, once focus went
  // back to the button it takes away
  useFocusWhenGone(!!state && !state.deletion, () => scheduled.current, question)
  useFocusWhenGone(!!state?.deletion?.keep_available, () => opener.current ?? scheduled.current)
  // Cancel clears the confirmation and the refusal, and a finished deletion
  // clears busy, as the dialog closes. It shows them until it has faded.
  const shown = useClosingWords(open, { confirm, error, busy })
  if (!state) return null

  /** Runs one admin action, closing the dialog on success and showing the
   * refusal otherwise. */
  async function run(work: () => Promise<unknown>, fallback: string) {
    // offline the request would wait without a word
    const paused = P.cannotSaveText()
    if (paused) {
      setError(paused)
      return
    }
    setBusy(true)
    setError('')
    // closing the page before the answer would leave the request unknown
    const releaseUnsaved = holdUnsaved()
    try {
      await work()
      setOpen(false)
      setConfirm('')
    } catch (cause) {
      setError(failure(cause, fallback))
    } finally {
      releaseUnsaved()
      setBusy(false)
    }
  }

  const deletion = state.deletion
  const matches = shown.confirm.trim().toLowerCase() === state.slug
  return (
    <SettingsSection
      title="Delete organization"
      description="The organization becomes read-only for 30 days so admins can export its data. Then everything in it is deleted."
      data-org-deletion=""
    >
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          setOpen(next)
          // A close and an opening both start over. The closing dialog
          // still shows what it had (useClosingWords), and input that
          // reached its fading field, such as a paste from the browser's
          // Edit menu, does not carry over.
          setConfirm('')
          setError('')
        }}
      >
        {deletion ? (
          <>
            <p ref={scheduled} tabIndex={-1} data-org-deletion-date className="text-sm text-text-1">
              {deletion.reason !== 'requested'
                ? `The subscription has ended. The organization will be deleted on ${billingDate(deletion.delete_after)} unless someone subscribes in Billing.`
                : deletion.keep_available
                  ? `Deletion is scheduled for ${billingDate(deletion.delete_after)}.`
                  : `Deletion is scheduled for ${billingDate(deletion.delete_after)}. To keep the organization, subscribe again in Billing first.`}
            </p>
            {deletion.keep_available && (
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                disabled={busy}
                data-org-keep
                onClick={() =>
                  void run(
                    () => convex.mutation(api.orgRemovals.keep, { org_id: orgId }),
                    'The deletion could not be stopped. Try again.',
                  )
                }
              >
                {busy ? 'Stopping…' : 'Keep organization'}
              </Button>
            )}
          </>
        ) : (
          // the trigger takes focus back once the dialog has closed
          <AlertDialogTrigger asChild>
            <Button ref={opener} type="button" variant="outline" data-org-delete disabled={busy}>
              Delete organization
            </Button>
          </AlertDialogTrigger>
        )}
        <AlertDialogContent
          ref={question}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) return
            event.preventDefault()
            restoreFocus(scheduled.current)
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {orgName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any paid subscription ends now, and nothing is refunded. The organization becomes
              read-only for 30 days so admins can export its data, and is then deleted with all of
              its projects, tasks, comments and files.{' '}
              {state.last_export_at
                ? `The last export was made on ${billingDate(state.last_export_at)}.`
                : 'No export has been made yet.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="org-delete-confirm">Type {state.slug} to confirm</Label>
            <Input
              id="org-delete-confirm"
              value={shown.confirm}
              autoComplete="off"
              spellCheck={false}
              data-org-delete-confirm-input
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>
          {shown.error && (
            <p role="alert" className="text-sm text-danger">
              {shown.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={shown.busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={shown.busy || !matches}
              data-org-delete-confirm
              onClick={(event) => {
                event.preventDefault()
                void run(
                  () => convex.action(api.orgRemovals.request, { org_id: orgId, confirm: confirm }),
                  'The organization could not be deleted. Try again.',
                )
              }}
            >
              {shown.busy ? 'Deleting…' : 'Delete organization'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && deletion && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
