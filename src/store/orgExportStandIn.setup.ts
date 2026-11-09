/* A stand-in for the organization export's server reads and writes
   (convex/orgExport.ts status, request, cancel and claimDownload, and
   convex/orgRemovals.ts state and recordExport), answering from one small
   job in memory, for the export panel's jsdom tests
   (src/panels/OrganizationExport.test.tsx) and the browser benchmark's
   server (scripts/perf/server.mjs), whose `orgexport` parameter shows the
   states a seeded backend reaches slowly or not at all.

   It follows the server's rules for one admin, the caller, beside another
   admin, `Ola`: request starts a job, or joins the one collecting, and
   records the caller's request; cancel ends a collecting job; a claim
   answers a link to a ready, unexpired archive, and with `automatic` only
   for a caller who asked, once (`claimed` after), else `not_requested`;
   recordExport records a served archive that is ready or ended less than
   30 minutes before. It reads no organization and checks no seat. It
   imports nothing the benchmark's worker cannot load. */

/** The sentences of the two failures the states show, which the worker
    cannot import from the model code (convex/model/orgExports.ts
    STOP_MESSAGES); the panel's test pins them equal. */
export const STOP_MESSAGES_TEXT = {
  deleted_changing:
    'The export stopped because many deleted items changed while it ran. Start a new export.',
  too_large:
    'This organization is too large to export as one download yet. The export stopped and its files were deleted.',
}

/** One job as orgExport.status answers it (convex/orgExport.ts
    ExportSummary). */
export type StandInSummary = {
  id: string
  state: 'collecting' | 'ready' | 'failed' | 'cancelled' | 'expired'
  started_at: string
  progress_at: string
  completed_at: string | null
  expires_at: string | null
  ended_at: string | null
  progress: { section: string; records: number; sections_done: number; sections_total: number }
  error: { code: string; message: string } | null
  archive_bytes: number | null
  skipped_tasks: number
  requested_by: string | null
  cancelled_by: string | null
  requested: boolean
  served_at: string | null
  auto_download_at: string | null
}

/** The states the perf page's `orgexport` parameter names, several joined
    by commas: `collecting` (reading tasks), `deleted` (reading
    deleted/comments), `others` (another admin's job, not joined),
    `joined`, `ready`, `claimed` (the caller's automatic download already
    claimed), `older` (a collecting job beside an older ready archive),
    `failed` (deleted_changing), `too-large`, `cancelled`, `expired`,
    `skipped` (a ready archive that left tasks out), `served` (a ready
    archive the server sent), `record-error` (recordExport fails) and
    `error` (status fails). */
export const ORG_EXPORT_STATES = [
  'collecting',
  'deleted',
  'others',
  'joined',
  'ready',
  'claimed',
  'older',
  'failed',
  'too-large',
  'cancelled',
  'expired',
  'skipped',
  'served',
  'record-error',
  'error',
] as const
export type OrgExportStandInState = (typeof ORG_EXPORT_STATES)[number]

const HOUR = 3_600_000
const SECTIONS = 26
/* the job's section keys by place (convex/lib/orgExport.ts JOB_ORDER) for
   the two the states read */
const TASKS_AT = 4
const DELETED_COMMENTS_AT = 24

/** A stand-in export server over `now` (epoch ms), with `states` forced
    as the perf page's parameter names them. `link` is the URL a claim
    answers, a small ZIP of `bytes` bytes the caller serves. */
export function orgExportStandIn(opts: {
  now: () => number
  states?: readonly string[]
  link?: string
  bytes?: number
  me?: string
  other?: string
  slug?: string
}) {
  const states = new Set(opts.states ?? [])
  const me = opts.me ?? 'Nora Lind'
  const other = opts.other ?? 'Ola Berg'
  const bytes = opts.bytes ?? 2048
  const iso = (ms: number) => new Date(ms).toISOString()
  let ids = 0
  const jobs: StandInSummary[] = []
  const subscribers = new Set<() => void>()
  let lastExportAt: string | null = null

  const job = (fields: Partial<StandInSummary>): StandInSummary => {
    const now = opts.now()
    ids += 1
    const summary: StandInSummary = {
      id: `export-${ids}`,
      state: 'collecting',
      started_at: iso(now - 4 * 60_000),
      progress_at: iso(now - 10_000),
      completed_at: null,
      expires_at: null,
      ended_at: null,
      progress: {
        section: 'tasks',
        records: 1240,
        sections_done: TASKS_AT,
        sections_total: SECTIONS,
      },
      error: null,
      archive_bytes: null,
      skipped_tasks: 0,
      requested_by: me,
      cancelled_by: null,
      requested: true,
      served_at: null,
      auto_download_at: null,
      ...fields,
    }
    jobs.push(summary)
    return summary
  }
  const ready = (fields: Partial<StandInSummary> = {}) => {
    const now = opts.now()
    return job({
      state: 'ready',
      completed_at: iso(now - 60_000),
      expires_at: iso(now - 60_000 + 4 * HOUR),
      progress: { section: '', records: 5320, sections_done: SECTIONS, sections_total: SECTIONS },
      archive_bytes: bytes,
      ...fields,
    })
  }

  // the forced states, oldest first, so the latest is the last
  if (states.has('older')) ready({ started_at: iso(opts.now() - 2 * HOUR) })
  if (states.has('expired'))
    job({
      state: 'expired',
      completed_at: iso(opts.now() - 5 * HOUR),
      expires_at: iso(opts.now() - HOUR),
      ended_at: iso(opts.now() - HOUR),
      archive_bytes: bytes,
    })
  if (states.has('cancelled'))
    job({ state: 'cancelled', ended_at: iso(opts.now() - 60_000), cancelled_by: other })
  if (states.has('failed'))
    job({
      state: 'failed',
      ended_at: iso(opts.now() - 60_000),
      error: { code: 'deleted_changing', message: STOP_MESSAGES_TEXT.deleted_changing },
    })
  if (states.has('too-large'))
    job({
      state: 'failed',
      ended_at: iso(opts.now() - 60_000),
      error: { code: 'too_large', message: STOP_MESSAGES_TEXT.too_large },
    })
  if (states.has('ready') || states.has('claimed') || states.has('skipped') || states.has('served'))
    ready({
      auto_download_at: states.has('claimed') ? iso(opts.now() - 30_000) : null,
      skipped_tasks: states.has('skipped') ? 3 : 0,
      served_at: states.has('served') ? iso(opts.now() - 20_000) : null,
    })
  if (states.has('collecting') || states.has('older')) job({})
  if (states.has('deleted'))
    job({
      progress: {
        section: 'deleted/comments',
        records: 4210,
        sections_done: DELETED_COMMENTS_AT,
        sections_total: SECTIONS,
      },
    })
  if (states.has('others')) job({ requested_by: other, requested: false })
  if (states.has('joined')) job({ requested_by: other, requested: true })

  const publish = () => {
    for (const listener of subscribers) listener()
  }
  const latest = () => jobs.at(-1) ?? null
  const byId = (id: string) => jobs.find((each) => each.id === id) ?? null

  /** orgExport.status's answer now. */
  const status = () => {
    if (states.has('error')) throw new Error('the export status failed')
    const last = latest()
    const now = opts.now()
    const newestReady = [...jobs].reverse().find((each) => each.state === 'ready') ?? null
    const older =
      newestReady !== null &&
      newestReady.id !== last?.id &&
      Date.parse(newestReady.expires_at ?? '') > now
        ? newestReady
        : null
    // a copy, as the wire carries it, so an answer a page keeps never
    // changes with the job
    return structuredClone({ latest: last, ready: older })
  }

  /** orgRemovals.state's answer now. */
  const removalState = () => ({
    slug: opts.slug ?? 'northstar',
    last_export_confirmed_at: lastExportAt,
    deletion: null,
  })

  const refuse = (message: string, code = 'rule') =>
    Object.assign(new Error(message), { data: { code, message } })

  const request = () => {
    const running = jobs.find((each) => each.state === 'collecting')
    if (running) {
      running.requested = true
      publish()
      return { export_id: running.id, joined: true }
    }
    const started = job({
      started_at: iso(opts.now()),
      progress_at: iso(opts.now()),
      progress: {
        section: 'organizations',
        records: 0,
        sections_done: 0,
        sections_total: SECTIONS,
      },
    })
    publish()
    return { export_id: started.id, joined: false }
  }

  const cancel = (exportId: string) => {
    const found = byId(exportId)
    if (!found) throw refuse('export not found', 'not_found')
    if (found.state !== 'collecting') return { state: found.state }
    Object.assign(found, { state: 'cancelled', ended_at: iso(opts.now()), cancelled_by: me })
    publish()
    return { state: 'cancelled' }
  }

  const claim = (exportId: string, automatic: boolean) => {
    const found = byId(exportId)
    if (!found) throw refuse('export not found', 'not_found')
    if (found.state === 'collecting')
      throw refuse('This export is still being prepared. Download it once it is ready.')
    if (found.state !== 'ready' || Date.parse(found.expires_at ?? '') <= opts.now())
      throw refuse('This export is no longer available. Prepare a new export.')
    if (automatic) {
      if (!found.requested) return { url: null, reason: 'not_requested' }
      if (found.auto_download_at !== null) return { url: null, reason: 'claimed' }
      found.auto_download_at = iso(opts.now())
      publish()
    }
    return {
      url: opts.link ?? 'https://stand-in.convex.site/exports/x?e=1&m=k&t=t',
      expires_at: iso(opts.now() + 120_000),
    }
  }

  /** Marks the archive `exportId` served, as the route does once the
      backend read it whole. */
  const serve = (exportId: string) => {
    const found = byId(exportId)
    if (found && found.served_at === null) {
      found.served_at = iso(opts.now())
      publish()
    }
  }

  const record = (exportId: string) => {
    if (states.has('record-error')) throw new Error('the record failed')
    const found = byId(exportId)
    if (!found) throw refuse('export not found', 'not_found')
    const end = Date.parse(found.ended_at ?? found.expires_at ?? '')
    if (
      found.completed_at === null ||
      found.served_at === null ||
      (found.state !== 'ready' && found.state !== 'expired') ||
      !(end + 30 * 60_000 > opts.now())
    )
      throw refuse(
        'This export can no longer be recorded. A saved export counts only when its download finishes within 30 minutes after the export ends. Prepare a new export.',
      )
    lastExportAt = iso(opts.now())
    publish()
    return null
  }

  /** The answer of query `name` with `args`, or undefined for another
      query. Throws as the query fails. */
  const query = (name: string): unknown => {
    if (name === 'orgExport:status') return status()
    if (name === 'orgRemovals:state') return removalState()
    return undefined
  }

  /** The answer of mutation `name` with `args`, or undefined for another
      mutation. Throws as the mutation refuses. */
  const mutation = (name: string, args: Record<string, unknown>): unknown => {
    const exportId = String(args.export_id ?? '')
    if (name === 'orgExport:request') return request()
    if (name === 'orgExport:cancel') return cancel(exportId)
    if (name === 'orgExport:claimDownload') return claim(exportId, args.automatic === true)
    if (name === 'orgRemovals:recordExport') return record(exportId)
    return undefined
  }

  return {
    jobs,
    status,
    query,
    mutation,
    serve,
    publish,
    /** Calls `listener` after every change. */
    subscribe(listener: () => void) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    /** Moves the latest job on to `fields`, such as ready. */
    update(fields: Partial<StandInSummary>, id = latest()?.id) {
      const found = id === undefined ? null : byId(id)
      if (found) Object.assign(found, fields)
      publish()
    },
    /** Readies the latest collecting job with its archive. */
    finish(id = latest()?.id) {
      const now = opts.now()
      const found = id === undefined ? null : byId(id)
      if (!found) return
      Object.assign(found, {
        state: 'ready',
        completed_at: iso(now),
        expires_at: iso(now + 4 * HOUR),
        progress: { section: '', records: 5320, sections_done: SECTIONS, sections_total: SECTIONS },
        archive_bytes: bytes,
      })
      publish()
    },
    force(next: readonly string[]) {
      states.clear()
      for (const state of next) states.add(state)
      publish()
    },
    lastExportAt: () => lastExportAt,
  }
}
