import { type HttpRouter, makeFunctionReference } from 'convex/server'
import { isDemoDeployment } from './lib/demo'
import { acceptsDemoReport, DEMO_REPORT_MAX_BYTES, demoMetricsSecret } from './lib/demoReporting'
import { answerAfterBody, readLimitedBody } from './lib/requestBody'

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(value: Uint8Array): string
}

/* The status of each reason readLimitedBody refuses a report body. */
const REFUSED = { missing: 400, too_large: 413, too_slow: 408 } as const

const receiveRef = makeFunctionReference<'mutation', { payload: string }, null>(
  'demoReporting:receive',
)
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export function registerDemoReporting(http: HttpRouter): void {
  http.route({
    path: '/internal/demo-metrics',
    method: 'POST',
    handler: answerAfterBody(async (ctx, request) => {
      if (isDemoDeployment() || !demoMetricsSecret())
        return new Response(null, { status: 404, headers })
      if (!acceptsDemoReport(request.headers.get('Authorization')))
        return new Response(null, { status: 401, headers })
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        return new Response(null, { status: 415, headers })
      try {
        // A stalled authenticated sender has a fixed deadline.
        const read = await readLimitedBody(request, DEMO_REPORT_MAX_BYTES, 30_000)
        if (!read.ok) return new Response(null, { status: REFUSED[read.reason], headers })
        const payload = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
        await ctx.runMutation(receiveRef, { payload })
      } catch {
        return new Response(null, { status: 400, headers })
      }
      return new Response(null, { status: 204, headers })
    }),
  })
}
