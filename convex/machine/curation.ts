/* Dedicated machine curation surface. Keys can browse and precheck the shared
 * image workspace; human approval, removal and calendar writes have no route.
 * Each dispatched function rechecks the key and its issuing operator inside
 * the query/mutation, after authorize stamps this authenticated request. */
import type { HttpRouter } from 'convex/server'
import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'
import { badRequest, type Refusal } from '../lib/functions'
import { validateCalendarDay } from '../lib/panorama'
import { CURATION_BODY_LIMIT_BYTES } from '../lib/panoramaCuration'
import { sha256hex } from './auth'

declare class TextEncoder {
  encode(text: string): Uint8Array
}

const BASE = '/v1/curation'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
const err = (error: string, status: number, extra: Record<string, string> = {}) =>
  json({ error }, status, extra)
const unauthorized = () =>
  err('invalid or inactive curation key', 401, { 'WWW-Authenticate': 'Bearer' })
const methodNotAllowed = (allow = 'GET, POST, OPTIONS') =>
  err('method not allowed', 405, { Allow: allow })

function refusalResponse(error: unknown): Response {
  if (error instanceof ConvexError && error.data !== null && typeof error.data === 'object') {
    const data = error.data as Partial<{
      code: Refusal['code'] | 'rate_limited'
      message: string
      retry_after: number
    }>
    if (data.code === 'forbidden') return unauthorized()
    if (data.code === 'rate_limited') {
      const retry =
        typeof data.retry_after === 'number' &&
        Number.isFinite(data.retry_after) &&
        data.retry_after > 0
          ? Math.ceil(data.retry_after)
          : 60
      return err(
        typeof data.message === 'string'
          ? data.message
          : 'curation request limit reached; try again shortly',
        429,
        { 'Retry-After': String(retry) },
      )
    }
    const status = { not_found: 404, bad_request: 400, rule: 409, conflict: 409 }[
      data.code as 'not_found' | 'bad_request' | 'rule' | 'conflict'
    ]
    if (typeof status === 'number' && typeof data.message === 'string')
      return err(data.message, status)
  }
  // Provider errors and exception strings may contain credentials or URLs.
  return err('unable to process the curation request', 500)
}

async function bodyObject(
  req: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  if (req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw badRequest('Content-Type must be application/json')
  }
  const length = req.headers.get('Content-Length')
  if (length !== null && Number(length) > CURATION_BODY_LIMIT_BYTES)
    throw badRequest('request body exceeds 16 KB')
  const text = await req.text()
  if (new TextEncoder().encode(text).byteLength > CURATION_BODY_LIMIT_BYTES)
    throw badRequest('request body exceeds 16 KB')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw badRequest('request body must be a JSON object')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object')
  }
  const fields = body as Record<string, unknown>
  if (Object.keys(fields).some((name) => !allowed.includes(name))) {
    throw badRequest('request body contains unsupported fields')
  }
  return fields
}

function field(body: Record<string, unknown>, name: string): string {
  if (typeof body[name] !== 'string') throw badRequest(`${name} must be a string`)
  return body[name]
}

function optionalField(body: Record<string, unknown>, name: string): string | undefined {
  return body[name] === undefined ? undefined : field(body, name)
}

async function reviewBody(
  req: Request,
  withDate: boolean,
): Promise<{
  decision: 'approved' | 'declined'
  reason: string
  day?: string
}> {
  const body = await bodyObject(
    req,
    withDate ? ['decision', 'reason', 'date'] : ['decision', 'reason'],
  )
  if (body.decision !== 'approved' && body.decision !== 'declined') {
    throw badRequest('decision must be approved or declined')
  }
  const day = optionalField(body, 'date')
  return {
    decision: body.decision,
    reason: field(body, 'reason'),
    ...(day !== undefined ? { day: validateCalendarDay(day) } : {}),
  }
}

function pathId(encoded: string): string {
  let id: string
  try {
    id = decodeURIComponent(encoded)
  } catch {
    throw badRequest('invalid resource id')
  }
  if (!id || /[/\\]/.test(id)) throw badRequest('invalid resource id')
  return id
}

const curationHandler = httpAction(async (ctx, req) => {
  if (req.method === 'OPTIONS') return json({}, 200)
  try {
    const match = /^Bearer (qvc_[0-9a-f]{64})$/.exec(req.headers.get('Authorization') ?? '')
    if (!match) return unauthorized()
    const { key_id } = await ctx.runMutation(internal.panoramaCuration.authorize, {
      hash: await sha256hex(match[1]),
    })
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed()
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === BASE) return methodNotAllowed()
    const parts = path.slice(BASE.length + 1).split('/')
    const cursor = url.searchParams.get('cursor') ?? undefined

    if (parts[0] === 'images' && parts.length === 1) {
      if (req.method !== 'GET') return methodNotAllowed('GET, OPTIONS')
      const status = url.searchParams.get('status') ?? undefined
      const agent_review = url.searchParams.get('agent_review') ?? undefined
      if (
        status !== undefined &&
        status !== 'pending' &&
        status !== 'approved' &&
        status !== 'removed'
      ) {
        throw badRequest('status must be pending, approved or removed')
      }
      if (
        agent_review !== undefined &&
        agent_review !== 'unreviewed' &&
        agent_review !== 'approved' &&
        agent_review !== 'declined'
      ) {
        throw badRequest('agent_review must be unreviewed, approved or declined')
      }
      return json(
        await ctx.runQuery(internal.panoramaCuration.machineImages, {
          key_id,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(status !== undefined ? { status: status as 'pending' | 'approved' | 'removed' } : {}),
          ...(agent_review !== undefined
            ? { agent_review: agent_review as 'unreviewed' | 'approved' | 'declined' }
            : {}),
        }),
      )
    }
    if (parts[0] === 'images' && parts.length === 2) {
      if (req.method !== 'GET') return methodNotAllowed('GET, OPTIONS')
      return json(
        await ctx.runQuery(internal.panoramaCuration.machineImage, {
          key_id,
          id: pathId(parts[1]),
        }),
      )
    }
    if (parts[0] === 'images' && parts.length === 3 && parts[2] === 'review') {
      if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS')
      return json(
        await ctx.runMutation(internal.panoramaCuration.machineReview, {
          key_id,
          id: pathId(parts[1]),
          ...(await reviewBody(req, true)),
        }),
      )
    }
    if (parts[0] === 'submissions' && parts.length === 1) {
      if (req.method === 'GET')
        return json(
          await ctx.runQuery(internal.panoramaCuration.machineSubmissions, {
            key_id,
            ...(cursor !== undefined ? { cursor } : {}),
          }),
        )
      const body = await bodyObject(req, ['url', 'date', 'title', 'creator', 'reason'])
      const title = optionalField(body, 'title')
      const creator = optionalField(body, 'creator')
      const reason = optionalField(body, 'reason')
      const request_id = req.headers.get('Idempotency-Key') ?? undefined
      return json(
        await ctx.runMutation(internal.panoramaCuration.machineSubmit, {
          key_id,
          ...(request_id !== undefined ? { request_id } : {}),
          input: {
            url: field(body, 'url'),
            date: validateCalendarDay(field(body, 'date')),
            ...(title !== undefined ? { title } : {}),
            ...(creator !== undefined ? { creator } : {}),
            ...(reason !== undefined ? { reason } : {}),
          },
        }),
        202,
      )
    }
    if (parts[0] === 'submissions' && parts.length === 2) {
      if (req.method !== 'GET') return methodNotAllowed('GET, OPTIONS')
      return json(
        await ctx.runQuery(internal.panoramaCuration.machineSubmission, {
          key_id,
          id: pathId(parts[1]),
        }),
      )
    }
    if (parts[0] === 'submissions' && parts.length === 3 && parts[2] === 'review') {
      if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS')
      return json(
        await ctx.runMutation(internal.panoramaCuration.machineReviewSubmission, {
          key_id,
          id: pathId(parts[1]),
          ...(await reviewBody(req, false)),
        }),
      )
    }
    return err('unknown curation route', 404)
  } catch (error) {
    return refusalResponse(error)
  }
})

export function registerCuration(http: HttpRouter): void {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'] as const) {
    http.route({ path: BASE, method, handler: curationHandler })
    http.route({ pathPrefix: `${BASE}/`, method, handler: curationHandler })
  }
}
