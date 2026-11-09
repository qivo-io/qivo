import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
import { SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { billingDate } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { useKeptLiveView } from '@/lib/liveView'
import {
  autoAttempted,
  chooseExportFile,
  type DeliveryState,
  deliverExport,
  deliveryNow,
  deliveryRunning,
  discardChosenFile,
  discardExportFile,
  type ExportFile,
  type ExportWay,
  exportWay,
  heldExportFile,
  heldFileWritable,
  holdExportFile,
  retryExportRecord,
  SECTION_LABELS,
  stopExportSave,
  useExportDelivery,
} from '@/lib/orgExport'
import { api } from '../../convex/_generated/api'
import { LIVE_READ_WARNING } from '../../convex/lib/orgExport'
import type { ExportSummary } from '../../convex/orgExport'
import { useOrgRemovalState } from '../lib/orgRemovalState'
import { P } from '../store/planner'

/* Settings › Organization › General › Export data, on the server's export
 * job (convex/orgExport.ts). An admin starts the organization's one export
 * or joins the one being prepared, and may leave the page while the server
 * prepares it; returning shows the same job. The page reads the job's
 * status while it shows (useKeptLiveView, paused while the tab is hidden)
 * and keeps its last answer, marked as refreshing, but acts only on a
 * current one. Each admin who asked gets one automatic download attempt per
 * job, made once its status answers ready on this page, and every admin may
 * download a ready archive by hand. The delivery itself runs in
 * lib/orgExport.ts, which records a save only once the desktop app or the
 * browser confirmed it. */

type StatusAnswer = { latest: ExportSummary | null; ready: ExportSummary | null }

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

/** Whether `job` is an archive that may still be downloaded at `now`. */
const downloadable = (job: ExportSummary | null, now: number) =>
  job?.state === 'ready' && job.expires_at !== null && Date.parse(job.expires_at) > now

/** The state `data-export-state` names for `job`: a ready job past its
 * four hours, whose expiry has not run yet, counts as expired. */
function stateOf(job: ExportSummary | null, now: number): string {
  if (job === null) return 'none'
  if (job.state === 'ready' && !downloadable(job, now)) return 'expired'
  return job.state
}

const wayLine: Record<ExportWay, string> = {
  desktop:
    'The desktop app saves exports in your Downloads folder and tells Qivo when one is saved.',
  file: "This browser asks where to save an export and tells Qivo when it's saved.",
  link: "This browser can't tell Qivo when a download finishes. Chrome and Edge on a computer can.",
}

/** Lets an admin prepare, follow, cancel and save the organization's
 * export, and says what it holds and how a save counts. */
export function OrganizationExport({ orgId }: { orgId: string }) {
  const way = exportWay()
  const status = useKeptLiveView<StatusAnswer>(
    api.orgExport.status,
    JSON.stringify({ org_id: orgId }),
  )
  const removal = useOrgRemovalState(orgId).state
  const { delivery, running } = useExportDelivery()
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // the job whose Cancel export question is open, so it never carries over
  // to a later job
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the time the page judges expiry by, moved on each minute
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const current = status.state === 'ok'
  const latest = status.value?.latest ?? null
  const older = status.value?.ready ?? null
  const latestId = latest?.id ?? null
  const latestState = stateOf(latest, now)
  const slug = P.org?.slug || removal?.slug || orgId

  // the automatic attempt, once a current answer shows the job this admin
  // asked for ready: by the page's way, or in a browser that chooses files
  // but holds none for this job (a reload, another tab), by the link
  useEffect(() => {
    if (!current || latest === null || latestState !== 'ready') return
    if (!latest.requested || latest.auto_download_at !== null) return
    if (autoAttempted(latest.id) || deliveryRunning() || latest.archive_bytes === null) return
    const job = latest
    const bytes = latest.archive_bytes
    let cancelled = false
    void (async () => {
      const file = heldExportFile(job.id)
      const via = way === 'file' && !(file && (await heldFileWritable(job.id))) ? 'link' : way
      if (cancelled) return
      await deliverExport({
        orgId,
        exportId: job.id,
        archiveBytes: bytes,
        automatic: true,
        file: via === 'file' ? file : null,
        via,
      })
      // another tab or device took the attempt: a file chosen for it goes
      if (deliveryNow()?.state === 'claimed') void discardExportFile(job.id)
    })()
    return () => {
      cancelled = true
    }
    // every answer, and each minute, may bring the attempt a refused save
    // held back; only a current answer acts
  }, [status.value, current, latestId, latestState, now])

  // a chosen file whose job ended without a save goes again, while empty
  useEffect(() => {
    if (latestId === null || !current) return
    if (latestState === 'failed' || latestState === 'cancelled' || latestState === 'expired')
      void discardExportFile(latestId)
  }, [current, latestId, latestState])

  /* Asks for the file first in a browser that chooses files, then starts
     or joins the export whatever the picker answered. */
  async function start() {
    const paused = P.cannotSaveText()
    if (paused) {
      setError(paused)
      return
    }
    const chosen = way === 'file' ? chooseExportFile(slug) : null
    setBusy(true)
    setError('')
    setNote('')
    let file: ExportFile | null = null
    try {
      file = chosen ? (await chosen).file : null
      const asked = await convex.mutation(api.orgExport.request, { org_id: orgId })
      if (file) holdExportFile(asked.export_id, file)
      if (asked.joined) setNote('An export was already being prepared, so you joined it.')
    } catch (cause) {
      // no export holds the file the picker made, so it goes while empty
      if (file) void discardChosenFile(file)
      setError(refusal(cause, "Couldn't start the export. Try again."))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(exportId: string) {
    const paused = P.cannotSaveText()
    if (paused) {
      setError(paused)
      return
    }
    setBusy(true)
    setError('')
    try {
      await convex.mutation(api.orgExport.cancel, { org_id: orgId, export_id: exportId })
      setConfirmCancel(null)
    } catch (cause) {
      setError(refusal(cause, "Couldn't cancel the export. Try again."))
    } finally {
      setBusy(false)
    }
  }

  /* Downloads `job` by hand: in a browser that chooses files, into the
     file this page holds for it or one the picker asks for in this click. */
  async function download(job: ExportSummary) {
    if (job.archive_bytes === null) return
    const paused = P.cannotSaveText()
    if (paused) {
      setError(paused)
      return
    }
    setError('')
    let file = way === 'file' ? heldExportFile(job.id) : null
    if (way === 'file' && file === null) {
      const chosen = await chooseExportFile(slug)
      if (chosen.file === null) {
        if (chosen.reason) setError(chosen.reason)
        return
      }
      file = chosen.file
      holdExportFile(job.id, file)
    }
    await deliverExport({
      orgId,
      exportId: job.id,
      archiveBytes: job.archive_bytes,
      automatic: false,
      file,
    })
  }

  const canAct = current && !busy && !running
  const shownDelivery =
    delivery !== null && shows(delivery, orgId, running, [latestId, older?.id]) ? delivery : null

  return (
    <SettingsSection
      title="Export organization data"
      description="Download the organization's data as a ZIP archive: every project and its tasks, archived work included, comments, history, people and roles, teams, project access, labels, milestones, organization settings, agent key details, and the Deleted items Qivo still keeps, in a folder of their own, each marked complete or partial."
      data-org-export=""
      data-export-state={status.state === 'loading' ? 'unknown' : latestState}
      data-export-id={latestId ?? undefined}
      data-export-delivery={way}
      aria-busy={status.state === 'refreshing' || undefined}
    >
      <div className="space-y-2 text-sm leading-relaxed text-text-2">
        <p data-export-leaves-out="">
          It leaves out attachment files, images in descriptions and comments, and profile pictures;
          their names and references stay. It also leaves out personal inboxes, follows, preferences
          and favorites, backgrounds, sign-in data and credentials.
        </p>
        <p data-export-warning="">{LIVE_READ_WARNING}</p>
        <p>
          Qivo has no import or restore for exports, and the export can't bring back the files it
          leaves out. Qivo prepares the export on its server, so you can leave this page.
        </p>
      </div>

      <div className="mt-3 space-y-2 text-sm" aria-live="polite">
        {status.state === 'loading' && <p className="text-text-2">Loading the export…</p>}
        {status.state === 'failed' && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-danger">
            {status.value ? "Couldn't refresh the export." : "Couldn't load the export."}
            <Button type="button" variant="outline" size="xs" onClick={status.retry}>
              Try again
            </Button>
          </div>
        )}
        {status.state === 'refreshing' && <p className="text-text-2">Refreshing…</p>}
        {status.value !== null && (
          <JobLines
            job={latest}
            state={latestState}
            way={way}
            heldFile={latestId !== null && heldExportFile(latestId) !== null}
            delivery={shownDelivery}
            onDownload={download}
            canAct={canAct}
          />
        )}
        {older !== null && downloadable(older, now) && (
          <div data-export-older="" className="flex flex-wrap items-center gap-2">
            <span>
              An earlier export is ready until {when(older.expires_at ?? '')}
              {older.archive_bytes !== null ? `, ${megabytes(older.archive_bytes)}` : ''}. A newer
              export replaces it once it's ready.
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!canAct}
              onClick={() => void download(older)}
              data-export-download="older"
            >
              {way === 'file' ? 'Save export…' : 'Download'}
            </Button>
          </div>
        )}
        {shownDelivery !== null && <DeliveryLine delivery={shownDelivery} />}
        {note && <p className="text-text-2">{note}</p>}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status.value !== null && latestState !== 'collecting' && (
          <Button type="button" onClick={() => void start()} disabled={!canAct} data-export-start>
            {way === 'file' ? 'Export data…' : 'Export data'}
          </Button>
        )}
        {latest !== null && latestState === 'collecting' && !latest.requested && (
          <Button type="button" onClick={() => void start()} disabled={!canAct} data-export-join>
            {way === 'file' ? 'Join export…' : 'Join export'}
          </Button>
        )}
        {latest !== null && latestState === 'collecting' && confirmCancel !== latest.id && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmCancel(latest.id)}
            disabled={!canAct}
            data-export-cancel
          >
            Cancel export
          </Button>
        )}
      </div>
      {latest !== null && latestState === 'collecting' && confirmCancel === latest.id && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-export-cancel-ask="">
          This stops the export for every admin who joined it.
          <Button
            type="button"
            variant="destructive"
            size="xs"
            onClick={() => void cancel(latest.id)}
            disabled={!canAct}
            data-export-cancel-confirm
          >
            Cancel export
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => setConfirmCancel(null)}>
            Keep exporting
          </Button>
        </div>
      )}
      {way === 'file' && (latest === null || latestState !== 'collecting') && (
        <p className="mt-2 text-sm text-text-2">
          Qivo asks where to save the export when you start it. The file stays empty until the
          export is saved.
        </p>
      )}

      {removal && (
        <p data-org-last-export className="mt-3 text-sm text-text-2">
          {removal.last_export_confirmed_at
            ? `Last saved export confirmed on ${billingDate(removal.last_export_confirmed_at)}.`
            : 'No saved export has been confirmed yet.'}{' '}
          {wayLine[way]} Deletion reminders count only confirmed saves.
        </p>
      )}
    </SettingsSection>
  )
}

/** Whether the panel of organization `orgId` shows `delivery`: never one
 * of another organization; one of an export the status answers; and one
 * whose export left the answer, such as an older archive a newer one
 * ended, while it runs, while its saved file's record is pending or
 * failed, or while it says to wait. */
function shows(
  delivery: DeliveryState,
  orgId: string,
  running: boolean,
  answered: readonly (string | null | undefined)[],
): boolean {
  if (delivery.orgId !== orgId) return false
  if (answered.includes(delivery.exportId) || running) return true
  if (delivery.state === 'saved') return delivery.record !== 'recorded'
  return delivery.state === 'busy'
}

/** What the server's refusal says, or `fallback`. */
function refusal(cause: unknown, fallback: string): string {
  const message =
    cause instanceof ConvexError ? (cause.data as { message?: unknown } | null)?.message : null
  return typeof message === 'string' ? message : fallback
}

/* The latest job's lines and its download button. */
function JobLines(props: {
  job: ExportSummary | null
  state: string
  way: ExportWay
  heldFile: boolean
  delivery: DeliveryState | null
  onDownload: (job: ExportSummary) => Promise<void>
  canAct: boolean
}) {
  const { job, state, way } = props
  if (job === null) return <p className="text-text-2">No export has been prepared yet.</p>
  const starter = job.requested_by ?? 'An admin'
  if (state === 'collecting') {
    const progress = job.progress
    const reading =
      progress.section === ''
        ? 'Finishing the archive: its README, its manifest and a check of its files.'
        : `Reading ${SECTION_LABELS[progress.section] ?? progress.section}, section ${Math.min(progress.sections_done + 1, progress.sections_total)} of ${progress.sections_total}. ${progress.records.toLocaleString()} records so far.`
    return (
      <div data-export-progress="">
        <p>{reading}</p>
        <p className="text-text-2">
          {job.requested
            ? `${starter} started this export at ${when(job.started_at)}. You asked for it.`
            : `${starter} is preparing an export, started at ${when(job.started_at)}.`}
          {job.requested && way === 'file' && props.heldFile
            ? " Keep this page open to save it when it's ready."
            : ''}
        </p>
      </div>
    )
  }
  if (state === 'ready') {
    const automatic =
      job.auto_download_at !== null && !autoAttempted(job.id)
        ? `The automatic download started at ${when(job.auto_download_at)}, here or on another device.`
        : null
    return (
      <div className="space-y-1" data-export-bytes={job.archive_bytes ?? undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Ready. Available until {when(job.expires_at ?? '')}
            {job.archive_bytes !== null ? `, ${megabytes(job.archive_bytes)}` : ''}.
          </span>
          <Button
            type="button"
            size="xs"
            disabled={!props.canAct}
            onClick={() => void props.onDownload(job)}
            data-export-download="latest"
          >
            {way === 'file' ? 'Save export…' : 'Download'}
          </Button>
        </div>
        {job.skipped_tasks > 0 && (
          <p className="text-text-2" data-export-skipped="">
            {job.skipped_tasks === 1 ? '1 task was' : `${job.skipped_tasks} tasks were`} moving to
            or from Deleted items while the export read them, so the tasks folder leaves{' '}
            {job.skipped_tasks === 1 ? 'it' : 'them'} out. The archive's deleted/items folder says
            which item holds them.
          </p>
        )}
        {job.served_at !== null && (
          <p className="text-text-2" data-export-served="">
            Sent by Qivo at {when(job.served_at)}.
          </p>
        )}
        {automatic && <p className="text-text-2">{automatic}</p>}
      </div>
    )
  }
  if (state === 'failed')
    return (
      <p className="text-danger" data-export-error={job.error?.code ?? ''}>
        {job.error?.message ?? 'The export stopped. Start a new export.'}
      </p>
    )
  if (state === 'cancelled')
    return <p>{job.cancelled_by ? `Cancelled by ${job.cancelled_by}.` : 'Cancelled.'}</p>
  return (
    <p>
      This export expired at {when(job.ended_at ?? job.expires_at ?? job.started_at)}. Prepare a new
      export.
    </p>
  )
}

/* What the page's latest save of an archive says. */
function DeliveryLine({ delivery }: { delivery: DeliveryState }) {
  switch (delivery.state) {
    case 'claiming':
      return <p className="text-text-2">Starting the download…</p>
    case 'saving':
      return (
        <div className="flex flex-wrap items-center gap-2" data-export-saving="">
          Saving… {megabytes(delivery.written)} of {megabytes(delivery.total)}
          <Button type="button" variant="outline" size="xs" onClick={stopExportSave}>
            Stop
          </Button>
        </div>
      )
    case 'downloading':
      return (
        <p data-export-saving="">
          Downloading in the desktop app… The download can't be stopped from this page.
        </p>
      )
    case 'saved':
      return (
        <div data-export-saved="" className="space-y-1">
          <p>{delivery.file ? `Saved as ${delivery.file}.` : 'Saved.'}</p>
          {delivery.record === 'recorded' && (
            <p className="text-text-2" data-export-recorded="true">
              Qivo recorded the saved export.
            </p>
          )}
          {delivery.record === 'refused' && (
            <p role="alert" data-export-recorded="refused" className="text-danger">
              The export was saved, but Qivo couldn't record it. {delivery.message}
            </p>
          )}
          {delivery.record === 'failed' && (
            <div
              role="alert"
              data-export-recorded="false"
              className="flex flex-wrap items-center gap-2 text-danger"
            >
              The export was saved, but Qivo couldn't record it.
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void retryExportRecord()}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )
    case 'sent':
      return delivery.way === 'desktop' ? (
        <p data-export-sent="">
          The desktop app couldn't save this export itself, so it's downloading it as a browser
          does. Qivo can't tell when that download finishes, so it doesn't count toward deletion
          reminders.
        </p>
      ) : delivery.way === 'file' ? (
        // the automatic attempt of a page that holds no file for the job,
        // after a reload or in another tab
        <p data-export-sent="">
          Your browser is downloading the export. Qivo can't confirm this download, so it doesn't
          count toward deletion reminders. Save export… saves a copy that Qivo counts.
        </p>
      ) : (
        <p data-export-sent="">
          Your browser is downloading the export. This browser can't tell Qivo when a download
          finishes, so it doesn't count toward deletion reminders.
        </p>
      )
    case 'busy':
      return (
        <p role="alert" className="text-danger" data-export-busy={delivery.by}>
          {delivery.by === 'desktop'
            ? 'The desktop app is already downloading an export. Try again once it has finished.'
            : delivery.retryAfter === null
              ? 'Qivo is busy sending this export. Try again in a few seconds.'
              : `Qivo is busy sending this export. Try again in ${delivery.retryAfter} ${delivery.retryAfter === 1 ? 'second' : 'seconds'}.`}
        </p>
      )
    case 'stopped':
      return (
        <p role="alert" className="text-danger" data-export-stopped="">
          The save stopped before it finished, so the file you chose holds no export.
          {delivery.removed ? ' Qivo deleted the empty file.' : ''}
        </p>
      )
    case 'unwritable':
      return (
        <p role="alert" className="text-danger" data-export-unwritable="">
          Qivo couldn't write to the file you chose, so no export was saved. Press Save export… to
          choose another place.
        </p>
      )
    case 'unconfirmed':
      return (
        <p role="alert" className="text-danger" data-export-unconfirmed="">
          The download didn't finish, so no export was saved. Try again.
          {delivery.leftover
            ? ` The desktop app couldn't delete the unfinished file ${delivery.leftover} in your Downloads folder, so delete it yourself.`
            : ''}
        </p>
      )
    case 'claimed':
      return null
    case 'refused':
      return (
        <p role="alert" className="text-danger">
          {delivery.message}
        </p>
      )
  }
}
