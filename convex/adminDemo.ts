/* Main operator area only: reports are aggregate copies from the demo backend. */
import { type DemoMetricsResult, parseDemoMetricsReport } from './lib/demoMetricsReport'
import { demoMetricsSecret } from './lib/demoReporting'
import { platformQuery } from './lib/functions'

export const metrics = platformQuery({
  args: {},
  handler: async (ctx): Promise<DemoMetricsResult> => {
    if (!demoMetricsSecret())
      return {
        status: 'not_configured',
        message: 'Connect demo reporting to see workspace and visitor statistics here.',
      }
    const current = await ctx.db
      .query('demo_metric_reports')
      .withIndex('by_key', (q) => q.eq('key', 'demo'))
      .unique()
    if (!current)
      return {
        status: 'not_configured',
        message:
          'Waiting for the first demo usage report. Reports arrive every 15 minutes once connected.',
      }
    return { status: 'ready', report: parseDemoMetricsReport(JSON.parse(current.payload)) }
  },
})
