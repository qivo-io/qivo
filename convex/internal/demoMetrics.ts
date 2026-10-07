/* A bounded hourly estimate of the dedicated demo deployment. Pages commit
 * progress and their next delivery atomically; a run/step fence makes duplicate
 * scheduler deliveries harmless. Sampling is approximate across concurrent
 * writes, and includes orphan uploads because those files also consume space. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { isDemoDeployment, requireDemoDeployment } from '../lib/demo'
import type { DemoMetricsReport } from '../lib/demoMetricsReport'
import {
  DEMO_STORAGE_TABLES,
  demoMetricsSnapshot,
  ensureDemoMetrics,
  estimateDocumentBytes,
  METRICS_KEY,
  recordDemoCreated,
  recordStorageSample,
} from '../model/demoMetrics'

declare const crypto: { randomUUID(): string }

const PAGE = 64
const PAGE_BYTES = 512 * 1024
const STALE_MS = 10 * 60_000
const RESTART_MS = 2 * 60 * 60_000
const SCHEMA_KEY = DEMO_STORAGE_TABLES.join(',')
const stepRef = makeFunctionReference<'mutation', { run_id: string; step: number }, null>(
  'internal/demoMetrics:samplePage',
)

export const snapshot = internalQuery({
  args: {},
  handler: async (ctx): Promise<DemoMetricsReport> => {
    requireDemoDeployment()
    return demoMetricsSnapshot(ctx)
  },
})

export const sample = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!isDemoDeployment()) return null
    requireDemoDeployment()
    await ensureDemoMetrics(ctx)
    const now = Date.now()
    const running = await ctx.db
      .query('demo_metrics_scans')
      .withIndex('by_key', (q) => q.eq('key', METRICS_KEY))
      .unique()
    if (running && running.schema_key === SCHEMA_KEY && now - running.started_at < RESTART_MS) {
      if (now - running.progress_at >= STALE_MS) {
        await ctx.db.patch(running._id, { progress_at: now })
        await ctx.scheduler.runAfter(0, stepRef, { run_id: running.run_id, step: running.step })
      }
      return null
    }
    // A stale run may have a cursor from an older table layout; abandon its
    // partial estimate. The fresh run id fences every delayed old delivery.
    if (running) await ctx.db.delete(running._id)
    const run_id = crypto.randomUUID()
    await ctx.db.insert('demo_metrics_scans', {
      key: METRICS_KEY,
      run_id,
      started_at: now,
      progress_at: now,
      step: 0,
      schema_key: SCHEMA_KEY,
      phase: 'receipts',
      table_index: 0,
      database_bytes: 0,
      file_bytes: 0,
    })
    await ctx.scheduler.runAfter(0, stepRef, { run_id, step: 0 })
    return null
  },
})

export const samplePage = internalMutation({
  args: { run_id: v.string(), step: v.number() },
  handler: async (ctx, { run_id, step }): Promise<null> => {
    if (!isDemoDeployment()) return null
    requireDemoDeployment()
    const scan = await ctx.db
      .query('demo_metrics_scans')
      .withIndex('by_key', (q) => q.eq('key', METRICS_KEY))
      .unique()
    if (!scan || scan.run_id !== run_id || scan.step !== step || scan.schema_key !== SCHEMA_KEY)
      return null
    const options = {
      cursor: scan.cursor ?? null,
      numItems: PAGE,
      maximumRowsRead: PAGE,
      maximumBytesRead: PAGE_BYTES,
    }
    let phase = scan.phase
    let tableIndex = scan.table_index
    let cursor: string | undefined
    let databaseBytes = scan.database_bytes
    let fileBytes = scan.file_bytes
    if (phase === 'receipts') {
      const page = await ctx.db.query('demo_sessions').paginate(options)
      for (const receipt of page.page) await recordDemoCreated(ctx, receipt._id)
      if (page.isDone) phase = 'database'
      else cursor = page.continueCursor
    } else if (phase === 'database') {
      const page = await ctx.db.query(DEMO_STORAGE_TABLES[tableIndex]).paginate(options)
      for (const row of page.page) databaseBytes += estimateDocumentBytes(row)
      if (page.isDone) {
        tableIndex++
        if (tableIndex >= DEMO_STORAGE_TABLES.length) phase = 'files'
      } else cursor = page.continueCursor
    } else {
      const page = await ctx.db.system.query('_storage').paginate(options)
      for (const file of page.page) fileBytes += file.size
      if (page.isDone) {
        await recordStorageSample(ctx, databaseBytes, fileBytes)
        await ctx.db.delete(scan._id)
        return null
      }
      cursor = page.continueCursor
    }
    await ctx.db.patch(scan._id, {
      phase,
      table_index: tableIndex,
      cursor,
      database_bytes: databaseBytes,
      file_bytes: fileBytes,
      progress_at: Date.now(),
      step: step + 1,
    })
    await ctx.scheduler.runAfter(0, stepRef, { run_id, step: step + 1 })
    return null
  },
})
