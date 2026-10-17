import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
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
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { billingDate } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../convex/_generated/api'

export type OrgRemovalState = FunctionReturnType<typeof api.orgRemovals.state>

/** The admin's view of the organization's last export and pending deletion. */
export function useOrgRemovalState(orgId: string): OrgRemovalState | null {
  const [state, setState] = useState<OrgRemovalState | null>(null)
  useEffect(() => {
    if (!orgId) return
    return convex.onUpdate(api.orgRemovals.state, { org_id: orgId }, setState, () => setState(null))
  }, [orgId])
  return state
}

/** A refusal's own sentence, or `fallback` for any other failure. */
const failure = (cause: unknown, fallback: string) => {
  const message = cause instanceof ConvexError ? cause.data?.message : null
  return typeof message === 'string' ? message : fallback
}

/** Lets an admin delete the organization after its read-only period, or
 * stop a deletion an admin asked for. */
export function OrganizationDeletion({ orgId, orgName }: { orgId: string; orgName: string }) {
  const state = useOrgRemovalState(orgId)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useUpdateBlocker(busy)
  if (!state) return null

  /** Runs one admin action, closing the dialog on success and showing the
   * refusal otherwise. */
  async function run(work: () => Promise<unknown>, fallback: string) {
    setBusy(true)
    setError('')
    try {
      await work()
      setOpen(false)
      setConfirm('')
    } catch (cause) {
      setError(failure(cause, fallback))
    } finally {
      setBusy(false)
    }
  }

  const deletion = state.deletion
  const matches = confirm.trim().toLowerCase() === state.slug
  return (
    <SettingsSection
      title="Delete organization"
      description="The organization becomes read-only for 30 days so admins can export its data. Then everything in it is deleted."
      data-org-deletion=""
    >
      {deletion ? (
        <>
          <p data-org-deletion-date className="text-sm text-text-1">
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
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            if (busy) return
            setOpen(next)
            if (!next) {
              setConfirm('')
              setError('')
            }
          }}
        >
          <Button
            type="button"
            variant="outline"
            data-org-delete
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            Delete organization
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {orgName}?</AlertDialogTitle>
              <AlertDialogDescription>
                Any paid subscription ends now. The organization becomes read-only for 30 days so
                admins can export its data, and is then deleted with all of its projects, tasks,
                comments and files.{' '}
                {state.last_export_at
                  ? `The last export was made on ${billingDate(state.last_export_at)}.`
                  : 'No export has been made yet.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="org-delete-confirm">Type {state.slug} to confirm</Label>
              <Input
                id="org-delete-confirm"
                value={confirm}
                autoComplete="off"
                spellCheck={false}
                data-org-delete-confirm-input
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy || !matches}
                data-org-delete-confirm
                onClick={(event) => {
                  event.preventDefault()
                  void run(
                    () =>
                      convex.action(api.orgRemovals.request, { org_id: orgId, confirm: confirm }),
                    'The organization could not be deleted. Try again.',
                  )
                }}
              >
                {busy ? 'Deleting…' : 'Delete organization'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {error && deletion && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
