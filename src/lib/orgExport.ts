import { ConvexError } from 'convex/values'
import { useSyncExternalStore } from 'react'
import { api } from '../../convex/_generated/api'
import { archiveFileName } from '../../convex/lib/orgExport'
import { P } from '../store/planner'
import { browserBackendUrl } from './backendUrl'
import { convex } from './convex'
import { holdUnsaved } from './leaveGuard'
import { beginUpdateBlock } from './updateSafety'

/* The organization export's delivery: how the export page saves a ready
 * archive of the server job (convex/orgExport.ts) and confirms the save
 * for the deletion reminder.
 *
 * Every path asks for the file first, then claims a two-minute link
 * (orgExport.claimDownload), then starts the request at once and keeps the
 * link nowhere. There are three ways, by where the page runs (exportWay):
 * - desktop: the desktop app downloads the link into the Downloads folder
 *   and answers when its download item completed with every byte
 *   (desktop/exportDownload.ts);
 * - file: a browser with the File System Access API streams the answer
 *   into a file the person chose, through pipeTo with backpressure, so the
 *   page holds only the stream's queued chunks and never the archive; the
 *   save counts once the file closed with exactly the archive's bytes;
 * - link: other browsers navigate to the link and download it themselves,
 *   which nothing confirms.
 * Only a confirmed save calls orgRemovals.recordExport, which names the
 * archive, so a download the app did not see saved never holds back the
 * deletion reminder.
 *
 * The state lives in this module, not in the panel, so a save goes on and
 * records when the panel unmounts. A save holds the page's unsaved lease
 * and an update block while it writes, so a reload or an update asks first;
 * a reload still ends it unconfirmed, and nothing is recorded. */

/** What each section of the job is called while the job reads it, by its
 * key (convex/lib/orgExport.ts JOB_ORDER). */
export const SECTION_LABELS: Record<string, string> = {
  organizations: 'the organization',
  teams: 'teams',
  profiles: 'people',
  projects: 'projects',
  tasks: 'tasks',
  labels: 'labels',
  activity_events: 'history',
  team_members: 'team members',
  project_access: 'project access',
  project_team_access: 'team access to projects',
  milestones: 'milestones',
  task_links: 'task links',
  task_labels: 'task labels',
  task_attachments: 'attachment details',
  comments: 'comments',
  agent_keys: 'agent keys',
  'deleted/teams': 'Deleted items: teams',
  'deleted/projects': 'Deleted items: projects',
  'deleted/tasks': 'Deleted items: tasks',
  'deleted/milestones': 'Deleted items: milestones',
  'deleted/project_access': 'Deleted items: project access',
  'deleted/project_team_access': 'Deleted items: team access to projects',
  'deleted/task_links': 'Deleted items: task links',
  'deleted/task_labels': 'Deleted items: task labels',
  'deleted/task_attachments': 'Deleted items: attachment details',
  'deleted/comments': 'Deleted items: comments',
  'deleted/items': 'Deleted items',
}

/** How this page saves an export. */
export type ExportWay = 'desktop' | 'file' | 'link'

/** The parts of a FileSystemFileHandle the file way uses. TypeScript's DOM
 * library has no File System Access API yet. */
export type ExportFile = {
  readonly name: string
  createWritable(): Promise<WritableStream<Uint8Array> & { abort(reason?: unknown): Promise<void> }>
  getFile(): Promise<{ size: number }>
  remove?(): Promise<void>
}

type SaveFilePicker = (options: {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
  startIn?: string
}) => Promise<ExportFile>

const pickerOf = (): SaveFilePicker | null => {
  const picker = (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
  return typeof picker === 'function' ? (picker as SaveFilePicker) : null
}

let way: ExportWay | null = null

/** How this page saves an export, read once a page load: the desktop app
 * when its bridge offers the download (a test build from before it takes
 * the link way, which hands the link to the system browser), a file when
 * the page is a secure context with showSaveFilePicker, else the link. */
export function exportWay(): ExportWay {
  if (way !== null) return way
  const desktop = window.qivoDesktop
  way = desktop
    ? desktop.orgExport
      ? 'desktop'
      : 'link'
    : window.isSecureContext && pickerOf() !== null
      ? 'file'
      : 'link'
  return way
}

/** What a delivery shows, for the export it saves. */
export type DeliveryState = { exportId: string } & (
  | { state: 'claiming' }
  | { state: 'saving'; written: number; total: number }
  | { state: 'downloading' }
  | { state: 'saved'; file: string | null; record: 'pending' | 'recorded' | 'failed' }
  | { state: 'sent' }
  | { state: 'busy'; retryAfter: number | null }
  | { state: 'stopped'; removed: boolean }
  | { state: 'unwritable' }
  | { state: 'unconfirmed'; leftover?: string }
  | { state: 'claimed' }
  | { state: 'refused'; message: string }
)

let delivery: DeliveryState | null = null
let running: AbortController | null = null
// what the panel reads, a new object on every change
let shown: { delivery: DeliveryState | null; running: boolean } = {
  delivery: null,
  running: false,
}
const listeners = new Set<() => void>()
// the file chosen for each export this page started or joined, for the
// page's life; a reload, another tab or another device has none
const files = new Map<string, ExportFile>()
// the exports whose automatic attempt this page made
const attempted = new Set<string>()
// what a saved, unrecorded delivery needs to record again
let unrecorded: { orgId: string; exportId: string } | null = null

const set = (next: DeliveryState | null) => {
  delivery = next
  publish()
}
const publish = () => {
  shown = { delivery, running: running !== null }
  for (const listener of listeners) listener()
}

/** The page's latest delivery, or null. */
export const deliveryNow = (): DeliveryState | null => delivery

/** The latest delivery and whether one runs, as the panel reads them. */
export function useExportDelivery(): { delivery: DeliveryState | null; running: boolean } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => shown,
    () => shown,
  )
}

/** Whether a delivery runs now. */
export const deliveryRunning = (): boolean => running !== null

/**
 * Asks where to save export archives of organization `slug`. Call it in a
 * click handler before any await, so the click's activation reaches the
 * picker. Answers the chosen file, or null for a cancelled picker, and with
 * another failure also its reason.
 */
export async function chooseExportFile(
  slug: string,
): Promise<{ file: ExportFile | null; reason: string | null }> {
  const picker = pickerOf()
  if (picker === null) return { file: null, reason: 'This browser cannot choose a file.' }
  try {
    const file = await picker({
      suggestedName: archiveFileName(slug, new Date().toISOString()),
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      startIn: 'downloads',
    })
    return { file, reason: null }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      return { file: null, reason: null }
    return { file: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Keeps `file` as where export `exportId` saves, for the page's life. */
export const holdExportFile = (exportId: string, file: ExportFile) => {
  files.set(exportId, file)
}

/** The file this page chose for export `exportId`, or null. */
export const heldExportFile = (exportId: string): ExportFile | null => files.get(exportId) ?? null

/** Whether the page may write to export `exportId`'s held file without a
 * click: its permission is granted, where the browser says. */
export async function heldFileWritable(exportId: string): Promise<boolean> {
  const file = files.get(exportId)
  if (!file) return false
  const query = (file as { queryPermission?: (o: { mode: string }) => Promise<string> })
    .queryPermission
  if (typeof query !== 'function') return true
  try {
    return (await query.call(file, { mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

/**
 * Lets go of export `exportId`'s held file without a save: deletes it
 * when the browser offers that and the file is still empty, as the picker
 * left it, so nobody takes it for a backup. Answers whether it deleted it.
 * Never deletes a file that holds anything.
 */
export async function discardExportFile(exportId: string): Promise<boolean> {
  const file = files.get(exportId)
  if (!file) return false
  files.delete(exportId)
  return await removeIfEmpty(file)
}

async function removeIfEmpty(file: ExportFile): Promise<boolean> {
  if (typeof file.remove !== 'function') return false
  try {
    if ((await file.getFile()).size !== 0) return false
    await file.remove()
    return true
  } catch {
    return false
  }
}

/** Whether this page made the automatic attempt of export `exportId`. */
export const autoAttempted = (exportId: string): boolean => attempted.has(exportId)

/** Stops a running file save (Stop). The desktop app's download cannot be
 * stopped from the page. */
export function stopExportSave(): void {
  running?.abort()
}

/** What the server's refusal says, or null for another failure. */
const refusalOf = (error: unknown): string | null => {
  if (!(error instanceof ConvexError)) return null
  const message = (error.data as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : null
}

/** A response's Retry-After seconds, or null. */
const retryAfterOf = (response: Response): number | null => {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null
}

/* Waits, up to about ten seconds, until no change waits for the server and
   no field holds typed text, because the link way's navigation fires the
   page's beforeunload: with a write in flight the browser would ask to
   leave, and for LEAVING_MS after it a failed request counts as cut off by
   the page's own load (lib/leaveGuard.ts pageLeaving). */
async function settled(): Promise<void> {
  for (let tries = 0; tries < 40 && P.hasUnsavedWork(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 250))
}

/** One save of export `exportId` of `orgId`, whose archive holds
 * `archiveBytes`. */
export type DeliverArgs = {
  orgId: string
  exportId: string
  archiveBytes: number
  automatic: boolean
  /** The file way's chosen file; the other ways take none. */
  file?: ExportFile | null
  /** The way to save by, this page's own unless given: a page that chooses
      files but holds none for an automatic attempt takes the link. */
  via?: ExportWay
}

/**
 * Saves export `exportId` in this page's way and records a confirmed save.
 * Answers false without claiming while another delivery runs (`busy`) or
 * while the page cannot save (P.cannotSaveText, shown as refused), and in
 * the file way without a file. An automatic attempt counts as made once
 * the server answered its claim, also a refusal, never when the page
 * refused it itself. The link is used at once and kept nowhere.
 */
export async function deliverExport(args: DeliverArgs): Promise<boolean> {
  const { orgId, exportId, archiveBytes, automatic } = args
  const how = args.via ?? exportWay()
  if (running !== null || (automatic && attempted.has(exportId))) return false
  if (how === 'file' && !args.file) return false
  const paused = P.cannotSaveText()
  if (paused) {
    set({ exportId, state: 'refused', message: paused })
    return false
  }
  const controller = new AbortController()
  running = controller
  set({ exportId, state: 'claiming' })
  try {
    if (how === 'link') await settled()
    let claim: { url: string; expires_at: string } | { url: null; reason: string }
    try {
      claim = await convex.mutation(api.orgExport.claimDownload, {
        org_id: orgId,
        export_id: exportId,
        automatic,
      })
    } catch (error) {
      if (automatic) attempted.add(exportId)
      set({
        exportId,
        state: 'refused',
        message: refusalOf(error) ?? "Couldn't start the download. Try again.",
      })
      return true
    }
    if (automatic) attempted.add(exportId)
    if ('reason' in claim) {
      set(claim.reason === 'claimed' ? { exportId, state: 'claimed' } : null)
      return true
    }
    const url = claim.url
    if (how === 'link') {
      openLink(url)
      set({ exportId, state: 'sent' })
      return true
    }
    if (how === 'desktop') return await viaDesktop(orgId, exportId, archiveBytes, url)
    return await intoFile(orgId, exportId, archiveBytes, url, args.file as ExportFile, controller)
  } finally {
    if (running === controller) {
      running = null
      publish()
    }
  }
}

/* Sends the browser to `url` with a clicked anchor in the same tab, with
   no download attribute and no target, as attachments download. */
function openLink(url: string): void {
  const a = document.createElement('a')
  a.href = browserBackendUrl(url)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function viaDesktop(
  orgId: string,
  exportId: string,
  archiveBytes: number,
  url: string,
): Promise<boolean> {
  const bridge = window.qivoDesktop?.orgExport
  if (!bridge) {
    set({ exportId, state: 'unconfirmed' })
    return true
  }
  const release = holdUnsaved('export')
  const unblock = beginUpdateBlock()
  set({ exportId, state: 'downloading' })
  try {
    const answer = await bridge.download(url)
    if (answer.state === 'completed' && answer.bytes === archiveBytes) {
      await record(orgId, exportId, answer.file)
      return true
    }
    set(
      answer.state === 'busy'
        ? { exportId, state: 'busy', retryAfter: null }
        : 'leftover' in answer
          ? { exportId, state: 'unconfirmed', leftover: answer.leftover }
          : { exportId, state: 'unconfirmed' },
    )
    return true
  } catch {
    set({ exportId, state: 'unconfirmed' })
    return true
  } finally {
    unblock()
    release()
  }
}

async function intoFile(
  orgId: string,
  exportId: string,
  archiveBytes: number,
  url: string,
  file: ExportFile,
  controller: AbortController,
): Promise<boolean> {
  const release = holdUnsaved('export')
  const unblock = beginUpdateBlock()
  let opened = false
  try {
    const response = await fetch(browserBackendUrl(url), {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 429) {
      void response.body?.cancel()
      set({ exportId, state: 'busy', retryAfter: retryAfterOf(response) })
      return true
    }
    const length = response.headers.get('Content-Length')
    if (
      response.status !== 200 ||
      response.body === null ||
      response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/zip' ||
      (length !== null && Number(length) !== archiveBytes)
    ) {
      void response.body?.cancel()
      set({ exportId, state: 'unconfirmed' })
      return true
    }
    let writable: Awaited<ReturnType<ExportFile['createWritable']>>
    try {
      writable = await file.createWritable()
    } catch {
      // the chosen place is gone or cannot be written, such as a folder
      // removed since: the page lets go of it, so the next Save export asks
      // for another, and drops the answer no writer takes
      void response.body.cancel().catch(() => {})
      if (files.get(exportId) === file) files.delete(exportId)
      set({ exportId, state: 'unwritable' })
      return true
    }
    opened = true
    let written = 0
    let shown = 0
    set({ exportId, state: 'saving', written, total: archiveBytes })
    const count = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        written += chunk.byteLength
        if (written > archiveBytes) throw new Error('the archive is longer than it should be')
        out.enqueue(chunk)
        // a line a MiB is enough to show the save moving
        if (written - shown >= 1024 * 1024 || written === archiveBytes) {
          shown = written
          set({ exportId, state: 'saving', written, total: archiveBytes })
        }
      },
      flush() {
        if (written !== archiveBytes) throw new Error('the archive ended short')
      },
    })
    // pipeTo closes the writable only once every byte reached it, and on
    // any error aborts it, which discards what it wrote, so the chosen file
    // never holds part of an archive
    await response.body.pipeThrough(count).pipeTo(writable, { signal: controller.signal })
    await record(orgId, exportId, file.name)
    files.delete(exportId)
    return true
  } catch {
    // nothing was saved; the chosen file is as the picker left it
    const removed = opened ? await removeIfEmpty(file) : false
    if (removed) files.delete(exportId)
    set({ exportId, state: 'stopped', removed })
    return true
  } finally {
    unblock()
    release()
  }
}

/* Records the confirmed save of export `exportId` (saved as `file`). */
async function record(orgId: string, exportId: string, file: string | null): Promise<void> {
  set({ exportId, state: 'saved', file, record: 'pending' })
  try {
    await convex.mutation(api.orgRemovals.recordExport, { org_id: orgId, export_id: exportId })
    unrecorded = null
    set({ exportId, state: 'saved', file, record: 'recorded' })
  } catch {
    unrecorded = { orgId, exportId }
    set({ exportId, state: 'saved', file, record: 'failed' })
  }
}

/** Records the last saved export again after its record failed (Try
 * again), never downloading it again. */
export async function retryExportRecord(): Promise<void> {
  const last = delivery
  if (unrecorded === null || last?.state !== 'saved' || last.exportId !== unrecorded.exportId)
    return
  if (P.cannotSaveText()) return
  await record(unrecorded.orgId, unrecorded.exportId, last.file)
}

/** Clears the latest delivery's line, such as after a new export starts. */
export function clearExportDelivery(): void {
  if (running === null) set(null)
}

/** Forgets every delivery, chosen file and attempt, for tests. */
export function resetExportDelivery(): void {
  running?.abort()
  running = null
  delivery = null
  unrecorded = null
  way = null
  files.clear()
  attempted.clear()
  publish()
}
