/* The demo sends anonymous rollups to the normal deployment. The normal
 * operator console reads its own cached copy and never holds demo-user access. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction, internalMutation } from './_generated/server'
import { isDemoDeployment, requireDemoDeployment } from './lib/demo'
import { type DemoMetricsReport, parseDemoMetricsReport } from './lib/demoMetricsReport'
import {
  DEMO_REPORT_MAX_BYTES,
  demoMetricsDestination,
  demoMetricsSecret,
} from './lib/demoReporting'
import { badRequest } from './lib/functions'

declare class TextEncoder {
  encode(value: string): Uint8Array
}
declare const AbortSignal: { timeout(milliseconds: number): unknown }
declare function fetch(
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    redirect: 'error'
    signal: unknown
  },
): Promise<Response>

const snapshotRef = makeFunctionReference<'query', Record<string, never>, DemoMetricsReport>(
  'internal/demoMetrics:snapshot',
)

/** Idempotent replacement. Delayed retries cannot roll back a newer report. */
export const receive = internalMutation({
  args: { payload: v.string() },
  handler: async (ctx, { payload }): Promise<null> => {
    if (isDemoDeployment()) throw badRequest('Demo reports belong on the main application.')
    if (new TextEncoder().encode(payload).byteLength > DEMO_REPORT_MAX_BYTES)
      throw badRequest('Demo report is too large.')
    let report: DemoMetricsReport
    try {
      report = parseDemoMetricsReport(JSON.parse(payload))
    } catch {
      throw badRequest('Invalid demo report.')
    }
    if (report.generatedAt > Date.now() + 5 * 60_000)
      throw badRequest('Demo report timestamp is in the future.')
    const previous = await ctx.db
      .query('demo_metric_reports')
      .withIndex('by_key', (q) => q.eq('key', 'demo'))
      .unique()
    if (previous && report.generatedAt <= previous.generated_at) return null
    const values = {
      generated_at: report.generatedAt,
      received_at: Date.now(),
      payload: JSON.stringify(report),
    }
    if (previous) await ctx.db.patch(previous._id, values)
    else await ctx.db.insert('demo_metric_reports', { key: 'demo', ...values })
    return null
  },
})

/** Scheduled every 15 minutes; absence of configuration leaves demos usable. */
export const publish = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!isDemoDeployment()) return null
    requireDemoDeployment()
    const secret = demoMetricsSecret()
    const destination = demoMetricsDestination()
    if (!secret || !destination) return null
    const report = await ctx.runQuery(snapshotRef, {})
    const body = JSON.stringify(parseDemoMetricsReport(report))
    if (new TextEncoder().encode(body).byteLength > DEMO_REPORT_MAX_BYTES)
      throw new Error('The demo usage report exceeded its transfer limit.')
    const response = await fetch(destination, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    // Do not include a destination response, header or URL that could echo a secret.
    if (response.status !== 204) throw new Error(`Demo reporting failed (HTTP ${response.status}).`)
    return null
  },
})
