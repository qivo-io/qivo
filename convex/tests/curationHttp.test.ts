/* Exercise the registered HTTP shell with isolated internal-function dispatch.
 * Database scope, revocation races and human final approval are covered by
 * panoramaCuration's backend suite; no token or provider network is needed. */
import { type FunctionReference, getFunctionName, type HttpRouter, httpRouter } from 'convex/server'
import { ConvexError } from 'convex/values'
import { describe, expect, it, vi } from 'vitest'
import type { ActionCtx } from '../_generated/server'
import { sha256hex } from '../machine/auth'
import { registerCuration } from '../machine/curation'

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
declare const Request: { new (url: string, init?: FetchInit): Request }

const SECRET = `qvc_${'0123456789abcdef'.repeat(4)}`
const KEY_ID = 'curation-key-id'
const PREFIX = '/v1/curation'
type Ref = FunctionReference<'query' | 'mutation', 'internal', Record<string, unknown>, unknown>
type Call = { kind: 'query' | 'mutation'; name: string; args: Record<string, unknown> }

function fixture() {
  const router = httpRouter()
  registerCuration(router)
  const calls: Call[] = []
  const dispatch = vi.fn(
    async (call: Call): Promise<unknown> =>
      call.name === 'panoramaCuration:authorize'
        ? { key_id: KEY_ID }
        : { handled: call.name, args: call.args },
  )
  const call = async (kind: Call['kind'], ref: Ref, args: Record<string, unknown>) => {
    const entry = { kind, name: getFunctionName(ref), args }
    calls.push(entry)
    return dispatch(entry)
  }
  const ctx = {
    runQuery: (ref: Ref, args: Record<string, unknown>) => call('query', ref, args),
    runMutation: (ref: Ref, args: Record<string, unknown>) => call('mutation', ref, args),
  } as unknown as ActionCtx
  const send = async (path: string, init: FetchInit = {}) => {
    const method = init.method ?? 'GET'
    const pathname = new URL(`https://test.convex.site${path}`).pathname
    const route = router.lookup(pathname, method as Parameters<HttpRouter['lookup']>[1])
    if (!route) throw new Error(`route was not registered: ${method} ${pathname}`)
    const handler = route[0] as unknown as {
      _handler: (ctx: ActionCtx, req: Request) => Promise<Response>
    }
    const req = new Request(`https://test.convex.site${path}`, {
      ...init,
      method,
      headers: {
        Authorization: `Bearer ${SECRET}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    return handler._handler(ctx, req)
  }
  return { router, calls, dispatch, send }
}

const result = async (response: Response) =>
  JSON.parse(await response.text()) as Record<string, unknown>

describe('curation route registration and authentication', () => {
  it('registers only the dedicated prefix and exact entry for every supported HTTP method', () => {
    const { router } = fixture()
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'] as const) {
      expect(router.lookup(PREFIX, method)).not.toBeNull()
      expect(router.lookup(`${PREFIX}/images`, method)).not.toBeNull()
      expect(router.lookup('/v1/tasks', method)).toBeNull()
      expect(router.lookup('/v1/curation-other', method)).toBeNull()
    }
  })

  it.each([
    '',
    `Bearer qva_${'a'.repeat(64)}`,
    `Bearer qvt_${'a'.repeat(64)}`,
    `Bearer qvc_${'a'.repeat(63)}`,
    `Bearer qvc_${'a'.repeat(65)}`,
    `Bearer qvc_${'g'.repeat(64)}`,
    `Bearer qvc_${'A'.repeat(64)}`,
    `Basic ${SECRET}`,
    `bearer ${SECRET}`,
    `Bearer  ${SECRET}`,
  ])(
    'refuses invalid credential syntax without querying credentials: %s',
    async (Authorization) => {
      const { send, calls } = fixture()
      const response = await send(`${PREFIX}/images`, {
        headers: { Authorization, 'X-Api-Key': SECRET },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(calls).toEqual([])
      expect(await response.text()).not.toContain(SECRET)
    },
  )

  it('hashes the secret, authorizes through a mutation and forwards only the key id', async () => {
    const { send, calls } = fixture()
    const response = await send(`${PREFIX}/images`)
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        kind: 'mutation',
        name: 'panoramaCuration:authorize',
        args: { hash: await sha256hex(SECRET) },
      },
      { kind: 'query', name: 'panoramaCuration:machineImages', args: { key_id: KEY_ID } },
    ])
    expect(JSON.stringify(calls)).not.toContain(SECRET)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).toBe('application/json')
  })

  it('preflights without authentication or credentialed CORS', async () => {
    const { send, calls } = fixture()
    const response = await send(`${PREFIX}/submissions`, {
      method: 'OPTIONS',
      headers: { Authorization: '' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type, Idempotency-Key',
    )
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(calls).toEqual([])
  })

  it.each(['PATCH', 'DELETE', 'PUT'])(
    'authenticates unsupported %s before answering 405',
    async (method) => {
      const { send, calls } = fixture()
      expect(
        (await send(`${PREFIX}/images`, { method, headers: { Authorization: '' } })).status,
      ).toBe(401)
      expect(calls).toEqual([])
      const response = await send(`${PREFIX}/images`, { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET, POST, OPTIONS')
      expect(calls.map((call) => call.name)).toEqual(['panoramaCuration:authorize'])
    },
  )
})

describe('library, submissions and agent-precheck dispatch', () => {
  it('forwards the shared library filters and pagination cursor', async () => {
    const { send, calls } = fixture()
    expect(
      (await send(`${PREFIX}/images?status=pending&agent_review=unreviewed&cursor=next%2Bpage`))
        .status,
    ).toBe(200)
    expect(calls[1]).toEqual({
      kind: 'query',
      name: 'panoramaCuration:machineImages',
      args: { key_id: KEY_ID, status: 'pending', agent_review: 'unreviewed', cursor: 'next+page' },
    })
  })

  it.each(['status=unknown', 'status=', 'agent_review=accepted', 'agent_review='])(
    'refuses invalid filters: %s',
    async (query) => {
      const { send, calls } = fixture()
      expect((await send(`${PREFIX}/images?${query}`)).status).toBe(400)
      expect(calls).toHaveLength(1)
    },
  )

  it.each([
    ['images/image-1', 'machineImage', { id: 'image-1' }],
    ['submissions/submission-1', 'machineSubmission', { id: 'submission-1' }],
    ['submissions?cursor=page-2', 'machineSubmissions', { cursor: 'page-2' }],
  ])('reads %s through its designated query', async (path, fn, args) => {
    const { send, calls } = fixture()
    const response = await send(`${PREFIX}/${path}`)
    expect(response.status).toBe(200)
    expect(calls[1]).toEqual({
      kind: 'query',
      name: `panoramaCuration:${fn}`,
      args: { key_id: KEY_ID, ...args },
    })
  })

  it('passes image URLs and credits through without turning them into a download proxy', async () => {
    const { send, dispatch } = fixture()
    const photo = {
      id: 'image-1',
      image_url: 'https://test.convex.site/api/storage/image',
      attribution: 'Photographer · CC0',
    }
    dispatch.mockImplementation(async (call) =>
      call.name.endsWith(':authorize') ? { key_id: KEY_ID } : photo,
    )
    expect(await result(await send(`${PREFIX}/images/image-1`))).toEqual(photo)
  })

  it.each(['approved', 'declined'])(
    'records only an image %s precheck and maps date to day',
    async (decision) => {
      const { send, calls } = fixture()
      const response = await send(`${PREFIX}/images/image-1/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: 'Landscape suitability checked', date: '12-25' }),
      })
      expect(response.status).toBe(200)
      expect(calls[1]).toEqual({
        kind: 'mutation',
        name: 'panoramaCuration:machineReview',
        args: {
          key_id: KEY_ID,
          id: 'image-1',
          decision,
          reason: 'Landscape suitability checked',
          day: '12-25',
        },
      })
    },
  )

  it('allows image precheck without a date and a submission precheck without changing its date', async () => {
    const { send, calls } = fixture()
    const body = JSON.stringify({ decision: 'declined', reason: 'Visible advertising' })
    expect((await send(`${PREFIX}/images/image-1/review`, { method: 'POST', body })).status).toBe(
      200,
    )
    expect(
      (await send(`${PREFIX}/submissions/submission-1/review`, { method: 'POST', body })).status,
    ).toBe(200)
    expect(calls[1]).toMatchObject({
      name: 'panoramaCuration:machineReview',
      args: { key_id: KEY_ID, decision: 'declined', reason: 'Visible advertising' },
    })
    expect(calls[1].args).not.toHaveProperty('day')
    expect(calls[3]).toEqual({
      kind: 'mutation',
      name: 'panoramaCuration:machineReviewSubmission',
      args: {
        key_id: KEY_ID,
        id: 'submission-1',
        decision: 'declined',
        reason: 'Visible advertising',
      },
    })
  })

  it.each([undefined, 'external-request-123'])(
    'submits with optional idempotency key %s and always returns accepted',
    async (requestId) => {
      const { send, calls, dispatch } = fixture()
      const input = {
        url: 'https://unsplash.com/photos/lake',
        date: '12-25',
        title: 'Lake',
        creator: 'Photographer',
        reason: 'Seasonal selection',
      }
      const accepted = {
        submission: { id: 'submission-1', status: 'pending' },
        idempotent: requestId !== undefined,
      }
      dispatch.mockImplementation(async (call) =>
        call.name.endsWith(':authorize') ? { key_id: KEY_ID } : accepted,
      )
      const response = await send(`${PREFIX}/submissions`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: requestId ? { 'Idempotency-Key': requestId } : {},
      })
      expect(response.status).toBe(202)
      expect(await result(response)).toEqual(accepted)
      expect(calls[1]).toEqual({
        kind: 'mutation',
        name: 'panoramaCuration:machineSubmit',
        args: { key_id: KEY_ID, input, ...(requestId ? { request_id: requestId } : {}) },
      })
    },
  )

  it('accepts a minimal submission without inventing optional metadata', async () => {
    const { send, calls } = fixture()
    const input = { url: 'https://unsplash.com/photos/lake', date: '01-01' }
    expect(
      (await send(`${PREFIX}/submissions/`, { method: 'POST', body: JSON.stringify(input) }))
        .status,
    ).toBe(202)
    expect(calls[1].args).toEqual({ key_id: KEY_ID, input })
  })

  it.each(['approve', 'remove', 'assignDate', 'calendar'])(
    'has no human-final or destructive endpoint: %s',
    async (action) => {
      const { send, calls } = fixture()
      expect(
        (await send(`${PREFIX}/images/image-1/${action}`, { method: 'POST', body: '{}' })).status,
      ).toBe(404)
      expect(calls).toHaveLength(1)
    },
  )

  it.each([
    ['images', 'POST', 'GET, OPTIONS'],
    ['images/image-1', 'POST', 'GET, OPTIONS'],
    ['images/image-1/review', 'GET', 'POST, OPTIONS'],
    ['submissions/submission-1', 'POST', 'GET, OPTIONS'],
    ['submissions/submission-1/review', 'GET', 'POST, OPTIONS'],
  ])('returns 405 for %s using %s', async (path, method, allow) => {
    const { send, calls } = fixture()
    const response = await send(`${PREFIX}/${path}`, { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe(allow)
    expect(calls).toHaveLength(1)
  })

  it('distinguishes an authenticated unknown route from the bare entry point', async () => {
    const { send, calls } = fixture()
    expect((await send(`${PREFIX}/unknown`)).status).toBe(404)
    expect((await send(PREFIX)).status).toBe(405)
    expect(calls.map((call) => call.name)).toEqual([
      'panoramaCuration:authorize',
      'panoramaCuration:authorize',
    ])
  })

  it.each(['%ZZ', 'one%2Ftwo', 'one%5Ctwo'])(
    'refuses malformed or encoded separator ids: %s',
    async (id) => {
      const { send, calls } = fixture()
      expect((await send(`${PREFIX}/images/${id}`)).status).toBe(400)
      expect(calls).toHaveLength(1)
    },
  )
})

describe('body validation and safe failures', () => {
  it.each(['{', 'null', '[]', '"text"'])(
    'rejects non-object or malformed JSON: %s',
    async (body) => {
      const { send, calls } = fixture()
      expect((await send(`${PREFIX}/submissions`, { method: 'POST', body })).status).toBe(400)
      expect(calls).toHaveLength(1)
    },
  )

  it.each([
    { url: 123, date: '12-25' },
    { url: 'https://unsplash.com/photos/lake' },
    { url: 'https://unsplash.com/photos/lake', date: '2026-12-25' },
    { url: 'https://unsplash.com/photos/lake', date: '02-29' },
    { url: 'https://unsplash.com/photos/lake', date: '12-25', title: null },
    { url: 'https://unsplash.com/photos/lake', date: '12-25', approved: true },
  ])('rejects malformed submission fields: %j', async (input) => {
    const { send, calls } = fixture()
    expect(
      (await send(`${PREFIX}/submissions`, { method: 'POST', body: JSON.stringify(input) })).status,
    ).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it.each([
    { decision: 'accepted', reason: 'Checked' },
    { decision: 'approved' },
    { decision: 'approved', reason: 5 },
    { decision: 'approved', reason: 'Checked', date: '02-29' },
    { decision: 'approved', reason: 'Checked', human_approved: true },
  ])('rejects malformed or overreaching precheck fields: %j', async (input) => {
    const { send, calls } = fixture()
    expect(
      (
        await send(`${PREFIX}/images/image-1/review`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('does not allow the submission-review route to replace a requested date', async () => {
    const { send, calls } = fixture()
    expect(
      (
        await send(`${PREFIX}/submissions/submission-1/review`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approved', reason: 'Checked', date: '12-25' }),
        })
      ).status,
    ).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('requires JSON content type and validates UTF-8 bytes even without Content-Length', async () => {
    const { send, calls } = fixture()
    const input = { url: 'https://unsplash.com/photos/lake', date: '12-25' }
    expect(
      (
        await send(`${PREFIX}/submissions`, {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'Content-Type': 'text/plain' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await send(`${PREFIX}/submissions`, {
          method: 'POST',
          body: JSON.stringify({ ...input, reason: 'é'.repeat(9_000) }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await send(`${PREFIX}/submissions`, {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'Content-Length': '16385' },
        })
      ).status,
    ).toBe(400)
    expect(calls.map((call) => call.name)).toEqual(Array(3).fill('panoramaCuration:authorize'))
  })

  it('allows exactly 16 KiB, leaving field-specific limits to the backend', async () => {
    const { send } = fixture()
    const input = { url: 'https://unsplash.com/photos/lake', date: '12-25', reason: '' }
    input.reason = 'a'.repeat(16 * 1024 - JSON.stringify(input).length)
    expect(JSON.stringify(input)).toHaveLength(16 * 1024)
    expect(
      (await send(`${PREFIX}/submissions`, { method: 'POST', body: JSON.stringify(input) })).status,
    ).toBe(202)
  })

  it.each([
    ['forbidden', 401],
    ['bad_request', 400],
    ['not_found', 404],
    ['rule', 409],
    ['conflict', 409],
  ])('maps backend %s refusal to HTTP %s after dispatch', async (code, status) => {
    const { send, dispatch } = fixture()
    dispatch.mockImplementation(async (call) => {
      if (call.name.endsWith(':authorize')) return { key_id: KEY_ID }
      throw new ConvexError({ code, message: 'A safe refusal explanation' })
    })
    const response = await send(`${PREFIX}/images`)
    expect(response.status).toBe(status)
    expect(await result(response)).toEqual({
      error:
        code === 'forbidden' ? 'invalid or inactive curation key' : 'A safe refusal explanation',
    })
  })

  it('stops at a failed authorization and hides unexpected exception details', async () => {
    const { send, dispatch, calls } = fixture()
    dispatch.mockRejectedValueOnce(new ConvexError({ code: 'forbidden', message: 'key revoked' }))
    expect((await send(`${PREFIX}/images`)).status).toBe(401)
    expect(calls).toHaveLength(1)
    dispatch.mockRejectedValueOnce(
      new Error(`provider failed with Authorization: Bearer ${SECRET}`),
    )
    const response = await send(`${PREFIX}/images`)
    expect(response.status).toBe(500)
    expect(await result(response)).toEqual({ error: 'unable to process the curation request' })
  })

  it('returns an authorization rate limit as 429 with Retry-After and does not dispatch', async () => {
    const { send, dispatch, calls } = fixture()
    dispatch.mockRejectedValueOnce(
      new ConvexError({
        code: 'rate_limited',
        message: 'curation request limit reached; try again shortly',
        retry_after: 27,
      }),
    )
    const response = await send(`${PREFIX}/images`)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('27')
    expect(await result(response)).toEqual({
      error: 'curation request limit reached; try again shortly',
    })
    expect(calls).toHaveLength(1)
  })

  it('uses a safe whole-second retry delay for malformed rate-limit metadata', async () => {
    const { send, dispatch } = fixture()
    dispatch.mockRejectedValueOnce(new ConvexError({ code: 'rate_limited', retry_after: -1 }))
    const response = await send(`${PREFIX}/images`)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
  })

  it.each([null, SECRET, { code: '__proto__', message: SECRET }])(
    'hides malformed typed refusals: %j',
    async (data) => {
      const { send, dispatch } = fixture()
      dispatch.mockRejectedValueOnce(new ConvexError(data))
      const response = await send(`${PREFIX}/images`)
      expect(response.status).toBe(500)
      expect(await result(response)).toEqual({ error: 'unable to process the curation request' })
    },
  )
})
