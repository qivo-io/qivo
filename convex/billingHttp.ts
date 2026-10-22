import { type HttpRouter, makeFunctionReference } from 'convex/server'
import { billingEnabled } from './lib/billingAccess'
import { POLAR_MAX_BODY_BYTES, verifyPolarWebhook } from './lib/polar'
import { answerAfterBody, readLimitedBody } from './lib/requestBody'

const webhookRef = makeFunctionReference<
  'action',
  { event_id: string; subscription_id: string },
  null
>('billingSync:webhook')
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export function registerBilling(http: HttpRouter) {
  http.route({
    path: '/billing/polar/webhook',
    method: 'POST',
    handler: answerAfterBody(async (ctx, request) => {
      if (!billingEnabled() || !process.env.POLAR_WEBHOOK_SECRET)
        return new Response(null, { status: 404, headers })
      let event: Awaited<ReturnType<typeof verifyPolarWebhook>>
      try {
        // the signature covers these exact bytes
        const read = await readLimitedBody(request, POLAR_MAX_BODY_BYTES, 15_000)
        if (!read.ok) return new Response(null, { status: 400, headers })
        event = await verifyPolarWebhook(read.bytes, request.headers)
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
