'use node'

import { createHash, randomUUID } from 'node:crypto'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction } from './_generated/server'
import type { Refusal } from './lib/functions'
import {
  EVENT_CATALOG,
  EVENT_NAMES,
  type EventFilters,
  type EventName,
  type EventReply,
  vEventOwner,
  WEBHOOK_MAX_TTL_MS,
  WEBHOOK_MIN_TTL_MS,
} from './lib/taskEvents'
import {
  type CallbackFailureReason,
  callbackError,
  callbackUrl,
  decryptSecret,
  encryptSecret,
  equalChallenge,
  postWebhook,
  signingSecret,
  signingSecretHash,
} from './lib/webhookTransport'

class EventRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function callbackFailure(reason: CallbackFailureReason): EventReply {
  return {
    error: { code: -32015, message: 'Callback verification failed', data: { reason } },
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}

function filtersOf(value: unknown): EventFilters {
  const obj = object(value ?? {})
  if (Object.keys(obj).some((key) => !['task_id', 'project_id'].includes(key)))
    throw new Error('Unsupported event filter')
  const filters: EventFilters = {}
  for (const key of ['task_id', 'project_id'] as const) {
    const value = obj[key]
    if (value === undefined) continue
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
      throw new Error(`${key} must be a UUID`)
    filters[key] = value.toLowerCase()
  }
  return filters
}

/** Shared MCP Events and REST subscription lifecycle. No app-specific behavior. */
export const manage = internalAction({
  args: { owner: vEventOwner, method: v.string(), params_json: v.string() },
  handler: async (ctx, { owner, method, params_json }): Promise<EventReply> => {
    let phase: 'input' | 'authorization' | 'callback' | 'save' = 'input'
    try {
      if (params_json.length > 16_384) throw new Error('Event subscription request is too large')
      const params = object(JSON.parse(params_json))
      if (method === 'events/list') {
        phase = 'authorization'
        await ctx.runQuery(internal.webhooks.authorize, { owner, filters: {} })
        if (params.cursor !== undefined && params.cursor !== null)
          return { error: { code: -32602, message: 'Event catalog has no further pages' } }
        return { result: { events: EVENT_CATALOG } }
      }
      if (method !== 'events/subscribe' && method !== 'events/unsubscribe')
        return { error: { code: -32601, message: 'Method not found' } }
      if (typeof params.name !== 'string') throw new Error('Event name must be a string')
      if (!EVENT_NAMES.includes(params.name as EventName))
        throw new EventRequestError(-32011, 'Unknown event name', { kind: 'event' })
      const name = params.name as EventName
      const filters = filtersOf(params.arguments)
      const delivery = object(params.delivery)
      if (method === 'events/subscribe' && delivery.mode === undefined)
        throw new Error('Delivery mode is required')
      if (delivery.mode !== undefined && delivery.mode !== 'webhook')
        throw new EventRequestError(-32014, 'Only webhook delivery is supported', {
          feature: 'deliveryMode',
          value: delivery.mode,
        })
      const url = callbackUrl(delivery.url)
      const id = createHash('sha256')
        .update(
          JSON.stringify([
            owner.profile_id,
            owner.credential_table,
            owner.credential_id,
            owner.credential_row_id,
            name,
            filters,
            url,
          ]),
        )
        .digest('hex')
      if (method === 'events/unsubscribe') {
        phase = 'authorization'
        await ctx.runMutation(internal.webhooks.remove, { owner, id })
        return { result: {} }
      }
      const secret = signingSecret(delivery.secret)
      if (params.cursor !== undefined && params.cursor !== null)
        throw new EventRequestError(-32014, 'Event replay is not supported. Use cursor null.', {
          feature: 'cursor',
        })
      const ttl = params.ttlMs
      if (
        ttl !== undefined &&
        ttl !== null &&
        (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0)
      )
        throw new Error('ttlMs must be a positive integer or null')
      const lifetime =
        typeof ttl === 'number'
          ? Math.max(WEBHOOK_MIN_TTL_MS, Math.min(ttl, WEBHOOK_MAX_TTL_MS))
          : undefined
      phase = 'authorization'
      await ctx.runQuery(internal.webhooks.authorize, { owner, filters })
      phase = 'save'
      const encrypted_secret = encryptSecret(secret, id)
      phase = 'callback'
      const challenge = randomUUID()
      const response = await postWebhook(
        url,
        secret,
        `msg_verification_${randomUUID()}`,
        id,
        JSON.stringify({ type: 'verification', challenge }),
      )
      if (response.status >= 500) return callbackFailure('http_5xx')
      if (response.status >= 400) return callbackFailure('http_4xx')
      if (response.status < 200 || response.status >= 300)
        return callbackFailure('challenge_failed')
      let verified = false
      try {
        verified = equalChallenge(object(JSON.parse(response.body)).challenge, challenge)
      } catch {
        // A reachable endpoint with an invalid response did not prove consent.
      }
      if (!verified) return callbackFailure('challenge_failed')
      phase = 'save'
      const result = await ctx.runMutation(internal.webhooks.save, {
        owner,
        id,
        name,
        filters,
        url,
        encrypted_secret,
        secret_hash: signingSecretHash(secret),
        legacy_secret_hash: createHash('sha256').update(secret).digest('hex'),
        expires_at: lifetime === undefined ? undefined : Date.now() + lifetime,
      })
      return { result }
    } catch (error) {
      if (error instanceof EventRequestError)
        return {
          error: {
            code: error.code,
            message: error.message,
            ...(error.data ? { data: error.data } : {}),
          },
        }
      if (error instanceof ConvexError) {
        const refusal = error.data as Refusal
        if (refusal.reason === 'webhook_subscription_limit')
          return {
            error: { code: -32013, message: refusal.message, data: { limit: 'subscriptions' } },
          }
        const code =
          refusal.code === 'forbidden' ? -32012 : refusal.code === 'not_found' ? -32011 : -32602
        return { error: { code, message: refusal.message } }
      }
      if (phase === 'callback') return callbackFailure(callbackError(error).reason)
      return {
        error: {
          code: phase === 'input' ? -32602 : -32603,
          message:
            phase === 'input' && error instanceof Error
              ? error.message
              : 'Event subscription could not be completed',
        },
      }
    }
  },
})

export const deliver = internalAction({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<null> => {
    const work = await ctx.runMutation(internal.webhooks.claim, { id })
    if (!work) return null
    let status = 0
    try {
      const sub = work.subscription
      const event = object(JSON.parse(work.delivery.payload))
      const response = await postWebhook(
        sub.url,
        decryptSecret(sub.encrypted_secret, sub.id),
        String(event.eventId),
        sub.id,
        work.delivery.payload,
        sub.previous_secret && (sub.rotation_until ?? 0) > Date.now()
          ? decryptSecret(sub.previous_secret, sub.id)
          : undefined,
        { responseMode: 'status' },
      )
      status = response.status
    } catch {
      // No URLs, secrets or remote response bodies belong in deployment logs.
    }
    await ctx.runMutation(internal.webhooks.finish, {
      id,
      attempt: work.attempt,
      status,
    })
    return null
  },
})
