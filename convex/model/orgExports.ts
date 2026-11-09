/* The organization export job's model: its limits, the checks every commit
 * makes, ending a job and erasing its parts. orgExport.ts holds the job's
 * functions and describes the whole job in its header. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { deletionBegun } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { demoForOrg, isDemoDeployment } from '../lib/demo'
import { eraseFile } from './fileHolds'

/** The most bytes one archive may hold: its stored parts and their ZIP
 * headers (lib/orgExport.ts zipEntryBytes). Convex answers an HTTP action
 * with at most 100 MiB (Convex limits page, read 2026-10-28; its HTTP
 * actions page says the same and recommends streaming only to save memory),
 * so the download, which the /exports/ route (http.ts) streams as one ZIP
 * file, keeps 5 MiB of room under it. A job that would pass it fails with `too_large`
 * and erases its parts. Parts and their rows depend on no single file, so
 * several archive files can come later without a format change. */
export const MAX_ARCHIVE_BYTES = 95 * 1024 * 1024

/** About how many bytes of JSON one data part collects before the step
 * compresses and stores it. A part can pass it by one readBatch answer
 * (model/orgExportRead.ts readBatch, about 7 MiB at most: a wide tasks page
 * of 100 rows within PAGE_BYTES with texts within TEXT_ROOM, or a narrow
 * one of six texts at two description rows each), so a part holds at most
 * about 11 MiB of JSON. The step action holds it once as encoded
 * chunks and once joined, then the joined bytes and the compressed copy,
 * so about 22 MiB with deflate's tables and the answer it reads, well under
 * the 64 MiB a Convex action may use. */
export const PART_RAW_BYTES = 4 * 1024 * 1024

/** The most bytes one archive may hold on the public demo, where any
 * visitor is an admin and up to 500 demos run at once. A seeded demo's
 * archive measured 65,624 bytes (2026-10-29, convex/tests/demoCleanup.test.ts;
 * 65,731 for the Northstar seed on a local backend), so this leaves a
 * visitor about 30 times that for their own work. With one collecting job
 * and one ready archive per organization, a demo holds at most twice this
 * in export parts, which count against no upload budget. */
export const DEMO_ARCHIVE_BYTES = 2 * 1024 * 1024

/** The job's limits, a mutable object so tests can lower them
 * (convex/tests restore them from a copy after each case):
 * - archive, demoArchive: the archive's bytes (MAX_ARCHIVE_BYTES, and
 *   DEMO_ARCHIVE_BYTES on the public demo);
 * - part: the JSON one part collects (PART_RAW_BYTES);
 * - reads: the reads one step makes before it stores what it has (each
 *   readBatch is a bounded query, so a step stays far under Convex's action
 *   time limit);
 * - parts: the data parts one archive may have. The finish (orgExport.ts
 *   commitFinish) reads every data part's row in one index range and looks
 *   up each part's file, one range each, so 4,000 parts take 4,001 ranges.
 *   Its own reads take at most about 50 more: the job, its two new files,
 *   the stop check (the removal, a demo's receipt, the request rows and up
 *   to 32 profiles) and the earlier ready archives it ends with their
 *   scheduled functions. That stays under Convex's 4,096 ranges, and the
 *   ZIP far under its 65,535 entries;
 * - erase: the parts one erase leg erases (each a row delete and a file
 *   delete, both writes);
 * - unsettled: the Deleted items the job may name in its step as changed
 *   while it read them (step.unsettled, model/orgExportRead.ts readBatch),
 *   which its items section then calls partial. 256 ids of 36 characters
 *   take about 10 KB of the job row. Past them the job fails with
 *   `deleted_changing` rather than call a changed item complete;
 * - leftOut: the Deleted items the job may name in its step as having
 *   records it left out (step.left_out_items, orgExport.ts noteLeftOut),
 *   about 10 KB more. Which records are left out depends on the data, not
 *   on when the export runs, so a new export would leave out the same
 *   ones. Past that many names the job therefore does not fail. It keeps
 *   no names and calls every item it would call complete partial
 *   (step.left_out_more). */
export const EXPORT_LIMITS = {
  archive: MAX_ARCHIVE_BYTES,
  demoArchive: DEMO_ARCHIVE_BYTES,
  part: PART_RAW_BYTES,
  reads: 512,
  parts: 4000,
  erase: 128,
  unsettled: 256,
  leftOut: 256,
}

/** The delivery's own budgets (orgExport.ts claimDownload and the
 * /exports/ route in http.ts), a mutable object so tests can lower them:
 * - tokenSeconds: how long a download link may start a download. The
 *   export page asks for the file first and claims the link just before it
 *   starts the request (src/lib/orgExport.ts), and two minutes cover a slow
 *   claim and the desktop app's start of its own download. The route checks
 *   the admin again on every request, whatever the link's age, so the
 *   lifetime only bounds when a forwarded link may start one.
 * - streams: the downloads of one archive that may run at once, counted by
 *   a lease on the job row (orgExport.ts leaseDelivery). A download holds
 *   an HTTP action for as long as its body is read, and Convex runs a
 *   limited number of actions at once for the whole deployment (64 on its
 *   smallest plan, shared with sign-in, REST, MCP, the file gateway and the
 *   export steps), so the lease bounds how many reads of one archive the
 *   backend runs at once. Two let an admin start again beside a download
 *   that has not ended. The runtime reads the body as fast as storage gives
 *   it (http.ts archiveStream), so a lease lasts while the backend reads
 *   the archive, under a second for 11 MB on a local backend, not while a
 *   slow client downloads it, so it does not bound the downloads clients
 *   run at once.
 * - demoStreams: the downloads that may run at once on the whole public
 *   demo deployment, where every visitor is the admin of an organization of
 *   their own; a quarter of the smallest plan's actions.
 * - streamMs: how long a lease holds when its download never releases it,
 *   an action's longest run. A download that outlives it no longer counts.
 *   orgRemovals.ts recordExport also records a confirmed save up to this
 *   long after its archive ended (recordable).
 * - retrySeconds: the Retry-After of a download refused past either count.
 * - slice: the most bytes the route hands its reader, the runtime, at a
 *   time, so the record of a download served whole waits until the runtime
 *   took the archive's last slice (http.ts archiveStream).
 * A download's checks read about one range a part (orgExport.ts
 * readDelivery, 4,007 ranges at EXPORT_LIMITS.parts data parts), a handful
 * of reads before each part (canDeliver) and two small writes, the lease
 * and the record; a claim reads the caller's seats, the job and one
 * request row whatever the organization's size. */
export const DELIVERY = {
  tokenSeconds: 120,
  streams: 2,
  demoStreams: 16,
  streamMs: 30 * 60 * 1000,
  retrySeconds: 30,
  slice: 1024 * 1024,
}

/** The most bytes an archive may hold on this deployment
 * (EXPORT_LIMITS). */
export const archiveCap = (): number =>
  isDemoDeployment() ? EXPORT_LIMITS.demoArchive : EXPORT_LIMITS.archive

/** How long a ready archive stays downloadable: four hours after it is
 * ready, unless a newer archive of its organization ends it sooner
 * (orgExport.ts commitFinish). Downloads and later requests never extend
 * it. */
export const ARCHIVE_TTL_MS = 4 * 60 * 60 * 1000

/** How long an ended job and its request rows stay as export history. */
export const HISTORY_MS = 30 * 24 * 60 * 60 * 1000

/** A collecting job whose last step committed longer ago than this, with no
 * step waiting or running, is restarted (orgExport.ts recover); so is an
 * erase leg that stopped (orgExport.ts sweep). */
export const STALLED_MS = 60_000

/** The restarts without a committed step before a job fails as stalled. */
export const RESTARTS = 3

/** The request rows a check reads before it fails closed (requesterIsAdmin):
 * the first in order whose admin is still one lets the job go on. */
export const AUTHORITY_READS = 32

/** Why a job fails, each with the sentence its status shows. */
export const STOP_MESSAGES = {
  org_deleting: 'The export stopped because the organization is being deleted.',
  no_admin: 'The export stopped because no admin who requested it is an admin any more.',
  too_large:
    'This organization is too large to export as one download yet. The export stopped and its files were deleted.',
  stalled: 'The export stopped because it made no progress. Start a new export.',
  incomplete: 'The export stopped because some of its files were missing. Start a new export.',
  deleted_changing:
    'The export stopped because many deleted items changed while it ran. Start a new export.',
} as const
export type StopCode = keyof typeof STOP_MESSAGES

const eraseRef = makeFunctionReference<'mutation', { export_id: string }, null>('orgExport:erase')

/** The export job `id`, or null. */
export const exportOf = (ctx: QueryCtx, id: string) => byId(ctx, 'org_exports', id)

/** The organization's collecting job, at most one, or null. Read in the
 * transaction that inserts a new one, so two requests at once conflict and
 * the second joins the first. */
export const collectingJob = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('org_exports')
    .withIndex('by_org_state', (q) => q.eq('org_id', orgId).eq('state', 'collecting'))
    .first()

/* Whether an admin who asked for `job` still is an active admin of its
 * organization. It reads the request rows in order and stops at the first
 * whose profile is an active admin there, created before the request (a
 * later profile can take a removed one's id). After AUTHORITY_READS rows it
 * fails closed. */
async function requesterIsAdmin(ctx: QueryCtx, job: Doc<'org_exports'>): Promise<boolean> {
  const requests = await ctx.db
    .query('org_export_requests')
    .withIndex('by_export_profile', (q) => q.eq('export_id', job.id))
    .take(AUTHORITY_READS)
  for (const request of requests) {
    const profile = await byId(ctx, 'profiles', request.profile_id)
    if (
      profile !== null &&
      profile.org_id === job.org_id &&
      profile.active &&
      profile.org_role === 'admin' &&
      profile._creationTime < request._creationTime
    )
      return true
  }
  return false
}

/** Why job `job` must stop now, or null when it may go on: its
 * organization's deletion has begun, a public demo's cleanup has begun, or
 * no admin who asked for it is still an active admin there. */
export async function stopReason(ctx: QueryCtx, job: Doc<'org_exports'>): Promise<StopCode | null> {
  if (await deletionBegun(ctx, job.org_id)) return 'org_deleting'
  if (isDemoDeployment() && (await demoForOrg(ctx, job.org_id))?.status === 'deleting')
    return 'org_deleting'
  if (!(await requesterIsAdmin(ctx, job))) return 'no_admin'
  return null
}

/** How a job ends: failed with a code, cancelled by an admin, or expired. */
export type JobEnd =
  | { state: 'failed'; code: StopCode }
  | { state: 'cancelled'; by: string }
  | { state: 'expired' }

/** Ends job `job`, collecting or ready, as `end` says, and schedules the
 * erase legs of its parts (orgExport.ts erase). A step still waiting is
 * cancelled; a step already running finds the job ended at its commit and
 * deletes the file it stored. */
export async function endJob(
  ctx: MutationCtx,
  job: Doc<'org_exports'>,
  end: JobEnd,
): Promise<void> {
  if (job.scheduled_id !== undefined) {
    const next = await ctx.db.system.get(job.scheduled_id)
    if (next?.state.kind === 'pending') await ctx.scheduler.cancel(job.scheduled_id)
  }
  const now = new Date().toISOString()
  const scheduled_id = await ctx.scheduler.runAfter(0, eraseRef, { export_id: job.id })
  await ctx.db.patch(job._id, {
    state: end.state,
    ended_at: now,
    erasing_at: now,
    scheduled_id,
    ...(end.state === 'failed'
      ? { error: { code: end.code, message: STOP_MESSAGES[end.code] } }
      : end.state === 'cancelled'
        ? { cancelled_by: end.by }
        : {}),
  })
  console.info('Organization export ended', {
    export_id: job.id,
    state: end.state,
    ...(end.state === 'failed' ? { code: end.code } : {}),
  })
}

/** Erases up to `limit` parts of export `exportId`, each row with its file
 * at once (model/fileHolds.ts eraseFile): a part is a temporary copy, never
 * held for a restore. Answers whether parts are left. */
export async function eraseParts(
  ctx: MutationCtx,
  exportId: string,
  limit = EXPORT_LIMITS.erase,
): Promise<boolean> {
  const parts = await ctx.db
    .query('org_export_parts')
    .withIndex('by_export_seq', (q) => q.eq('export_id', exportId))
    .take(limit + 1)
  for (const part of parts.slice(0, limit)) {
    await ctx.db.delete(part._id)
    await eraseFile(ctx, part.storage_id)
  }
  return parts.length > limit
}

/** The request rows of export `exportId`, for the teardowns that delete
 * them with their job. */
export const requestsOf = (ctx: QueryCtx, exportId: string) =>
  ctx.db
    .query('org_export_requests')
    .withIndex('by_export_profile', (q) => q.eq('export_id', exportId))

/** The parts of export `exportId` in archive order. */
export const partsOf = (ctx: QueryCtx, exportId: string) =>
  ctx.db.query('org_export_parts').withIndex('by_export_seq', (q) => q.eq('export_id', exportId))

/** The organization's ready archives, newest last; at most one unless an
 * earlier release left more. */
export const readyJobs = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('org_exports')
    .withIndex('by_org_state', (q) => q.eq('org_id', orgId).eq('state', 'ready'))

/** The organization's export jobs, for status and the teardowns. */
export const jobsOf = (ctx: QueryCtx, orgId: string) =>
  ctx.db.query('org_exports').withIndex('by_org_started', (q) => q.eq('org_id', orgId))

/** Sets job `job`'s `served_at` the first time the route serves its
 * archive whole, every byte read into the response by the backend, which
 * does not wait for the client (http.ts archiveStream). It leaves
 * organizations.last_export_at alone, because the backend cannot know that
 * the client received the archive, so a served archive never stops the
 * deletion reminder (model/orgRetention.ts). The app records a download
 * only once the desktop app or the browser confirmed the saved file
 * (orgRemovals.ts recordExport). */
export async function noteDelivered(ctx: MutationCtx, job: Doc<'org_exports'>): Promise<void> {
  if (job.served_at === undefined)
    await ctx.db.patch(job._id, { served_at: new Date().toISOString() })
}

/** Whether `job` is an archive whose saved download orgRemovals.ts
 * recordExport may record at `now` (epoch ms): one that reached ready, that
 * the /exports/ route served whole (served_at), and that is still ready or
 * expired, which includes one a newer archive ended, with its end (ended_at,
 * else expires_at) less than DELIVERY.streamMs, an action's longest run,
 * before `now`. So a save that finished just after the archive ended still
 * counts, while a failed or cancelled job, an archive nobody fetched and an
 * old one never do. */
export function recordable(job: Doc<'org_exports'>, now: number): boolean {
  if (job.completed_at === undefined || job.served_at === undefined) return false
  if (job.state !== 'ready' && job.state !== 'expired') return false
  const end = job.ended_at ?? job.expires_at
  return end !== undefined && Date.parse(end) + DELIVERY.streamMs > now
}

/** The leases of job `job`'s downloads that have not run out at `now`
 * (DELIVERY.streams). */
export const liveStreams = (job: Doc<'org_exports'>, now: number) =>
  (job.streams ?? []).filter((stream) => stream.until > now)

/** How many downloads hold a lease on the whole deployment at `now`, read
 * up to DELIVERY.demoStreams: the jobs whose latest lease has not run out
 * (by_streaming), at most that many, each counting its live leases. */
export async function deploymentStreams(ctx: QueryCtx, now: number): Promise<number> {
  const jobs = await ctx.db
    .query('org_exports')
    .withIndex('by_streaming', (q) => q.gt('streams_until', now))
    .take(DELIVERY.demoStreams)
  return jobs.reduce((sum, job) => sum + liveStreams(job, now).length, 0)
}

/** Sets job `job`'s leases to `streams`, with `streams_until` the last of
 * them to run out, or neither once none is left. */
export async function setStreams(
  ctx: MutationCtx,
  job: Doc<'org_exports'>,
  streams: { id: string; until: number }[],
): Promise<void> {
  await ctx.db.patch(job._id, {
    streams: streams.length === 0 ? undefined : streams,
    streams_until: streams.length === 0 ? undefined : Math.max(...streams.map((s) => s.until)),
  })
}
