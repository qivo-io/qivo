import { type HttpRouter, makeFunctionReference } from 'convex/server'
import { httpAction } from './_generated/server'
import { billingEnabled } from './lib/billingAccess'
import { POLAR_MAX_BODY_BYTES, verifyPolarWebhook } from './lib/polar'

declare const AbortSignal: { timeout(ms: number): unknown }
declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(id: unknown): void

const webhookRef = makeFunctionReference<
  'action',
  { event_id: string; subscription_id: string },
  null
>('billingSync:webhook')
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

async function readBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > POLAR_MAX_BODY_BYTES)
    throw new Error('large body')
  const body = (
    request as Request & {
      body: {
        getReader(): {
          read(): Promise<{ done: boolean; value?: Uint8Array }>
          cancel(): Promise<void>
        }
      } | null
    }
  ).body
  if (!body) throw new Error('missing body')
  const reader = body.getReader()
  let timer: unknown
  const receive = async () => {
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value) continue
      length += chunk.value.length
      if (length > POLAR_MAX_BODY_BYTES) throw new Error('large body')
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
  try {
    return await Promise.race([
      receive(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('body timeout')), 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

export function registerBilling(http: HttpRouter) {
  http.route({
    path: '/billing/polar/webhook',
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      if (!billingEnabled() || !process.env.POLAR_WEBHOOK_SECRET)
        return new Response(null, { status: 404, headers })
      let event: Awaited<ReturnType<typeof verifyPolarWebhook>>
      try {
        event = await verifyPolarWebhook(await readBody(request), request.headers)
      } catch {
        return new Response(null, { status: 400, headers })
      }
      if (!event.type.startsWith('subscription.'))
        return new Response(null, { status: 204, headers })
      const id = event.data.id
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))
        return new Response(null, { status: 400, headers })
      try {
        await ctx.runAction(webhookRef, { event_id: event.id, subscription_id: id })
      } catch {
        return new Response(null, { status: 503, headers })
      }
      return new Response(null, { status: 204, headers })
    }),
  })
}
