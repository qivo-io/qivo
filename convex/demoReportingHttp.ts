import { type HttpRouter, makeFunctionReference } from 'convex/server'
import { httpAction } from './_generated/server'
import { isDemoDeployment } from './lib/demo'
import { acceptsDemoReport, DEMO_REPORT_MAX_BYTES, demoMetricsSecret } from './lib/demoReporting'

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(value: Uint8Array): string
}
declare function setTimeout(callback: () => void, delay: number): unknown
declare function clearTimeout(timer: unknown): void
type ReportBody = {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
}

class ReportBodyError extends Error {
  constructor(readonly status: number) {
    super('Invalid demo report body')
  }
}

/** Check streamed bytes before retaining each chunk, including requests that
 * omit Content-Length. A stalled authenticated sender has a fixed deadline. */
async function readReportBody(request: Request): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > DEMO_REPORT_MAX_BYTES)
    throw new ReportBodyError(413)
  const body = (request as Request & { body: ReportBody | null }).body
  if (!body) throw new ReportBodyError(400)
  const reader = body.getReader()
  let timer: unknown
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReportBodyError(408)), 30_000)
  })
  const receive = async () => {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > DEMO_REPORT_MAX_BYTES) throw new ReportBodyError(413)
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  try {
    return await Promise.race([receive(), timeout])
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}
const receiveRef = makeFunctionReference<'mutation', { payload: string }, null>(
  'demoReporting:receive',
)
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export function registerDemoReporting(http: HttpRouter): void {
  http.route({
    path: '/internal/demo-metrics',
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      if (isDemoDeployment() || !demoMetricsSecret())
        return new Response(null, { status: 404, headers })
      if (!acceptsDemoReport(request.headers.get('Authorization')))
        return new Response(null, { status: 401, headers })
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        return new Response(null, { status: 415, headers })
      try {
        const payload = await readReportBody(request)
        await ctx.runMutation(receiveRef, { payload })
      } catch (error) {
        return new Response(null, {
          status: error instanceof ReportBodyError ? error.status : 400,
          headers,
        })
      }
      return new Response(null, { status: 204, headers })
    }),
  })
}
