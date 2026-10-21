/* The REST input rules every route shares, over HTTP:
 *
 *   1. Every route refuses a query parameter it does not take, and every
 *      route that may carry a body refuses a body field it does not take,
 *      including the routes that take no body. The sweep walks ROUTES, so a
 *      new route that skips the check fails here.
 *   2. A body whose bytes are not UTF-8 is refused, not stored as U+FFFD.
 *   3. POST /v1/webhooks reads its body by the same rules as every other
 *      route, and an unknown webhook path answers 404 whatever it carries. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { eventParamsJson } from '../lib/taskEvents'
import { sha256hex } from '../machine/auth'
import { ROUTES } from '../machine/rest'
import { NOW, newT, type T, uuid, withOrg } from './helpers.setup'

/* edge-runtime provides TextEncoder; convex/tsconfig's ESNext-only lib lacks
 * it. */
declare class TextEncoder {
  encode(input: string): Uint8Array
}
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* fileTokens reads these lazily (attachments.test.ts plants the same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'
g.process.env.CONVEX_SITE_URL ??= 'https://example.convex.site'

type FetchInit = { method: string; headers: Record<string, string>; body?: string | Uint8Array }

/* One REST request with `token`: the status and the parsed JSON body. */
async function call(
  t: T,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: FetchInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:
      body === undefined || body instanceof Uint8Array || typeof body === 'string'
        ? body
        : JSON.stringify(body),
  }
  const res = await (
    t as unknown as {
      fetch(path: string, init: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  const text = await res.text()
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  }
}

/* An organization admin's personal token that can write, and a real thing
 * behind every path parameter of every route. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const token = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const token_hash = await sha256hex(token)
  await t.run((ctx) =>
    ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: f.admin.id,
      name: 'Admin token',
      token_prefix: token.slice(0, 11),
      token_hash,
      access: 'write',
      created_at: NOW,
    }),
  )
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(t, token, method, path, body)
    if (res.status >= 300) throw new Error(`${method} ${path}: ${JSON.stringify(res.body)}`)
    return res.body
  }
  const task = await ok('POST', '/v1/tasks', { project: 'FW', title: 'Swept' })
  const other = await ok('POST', '/v1/tasks', { project: 'FW', title: 'Linked' })
  await ok('POST', `/v1/tasks/${task.key}/links`, { task: other.key, kind: 'blocks' })
  const comment = await ok('POST', `/v1/tasks/${task.key}/comments`, { body: 'Hello' })
  const label = await ok('POST', '/v1/labels', { name: 'Swept', color: '#336699' })
  const milestone = await ok('POST', '/v1/projects/TBED/milestones', {
    name: 'Launch',
    date: '2026-12-01',
  })
  const upload = await ok('POST', `/v1/tasks/${task.key}/attachments`, {
    name: 'a.txt',
    size: 1,
  })
  const attachment = await t.run(async (ctx) => {
    const issue = (await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', task.id as string))
      .unique()) as Doc<'issues'>
    const id = uuid()
    await ctx.db.insert('issue_attachments', {
      org_id: issue.org_id,
      id,
      issue_id: issue.id,
      name: 'kept.txt',
      size_bytes: 1,
      storage_id: await ctx.storage.store(new Blob(['x']) as never),
      inline: false,
      uploaded_by: f.admin.id,
      created_at: NOW,
    })
    return id
  })
  // each route's path parameters, by route path and parameter name
  const params: Record<string, string> = {
    ref: task.key as string,
    other: other.key as string,
    kind: 'blocks',
    id: attachment,
    ticket: upload.ticket as string,
    milestone: milestone.id as string,
    user: f.user.id,
  }
  const pathOf = (path: string) =>
    `/v1/${path
      .split('/')
      .map((part, i, parts) => {
        if (!part.startsWith(':')) return part
        const name = part.slice(1)
        if (name === 'ref') {
          if (parts[0] === 'projects') return 'TBED'
          if (parts[0] === 'users') return f.user.id
          if (parts[0] === 'labels') return label.id as string
          if (parts[0] === 'comments') return comment.id as string
          if (parts[0] === 'teams') return f.team.id
        }
        if (name === 'subject') return parts[i - 1] === 'teams' ? f.team.id : f.user.id
        return params[name]
      })
      .join('/')}`
  return { t, f, token, task, pathOf }
}

describe('unknown input', () => {
  it('every route refuses a query parameter it does not take', async () => {
    const { t, token, pathOf } = await fixture()
    for (const route of ROUTES) {
      const label = `${route.method} ${route.path}`
      const res = await call(t, token, route.method, `${pathOf(route.path)}?bogus=1`)
      const takes =
        route.query === undefined
          ? 'this request takes no query parameters'
          : `this request takes ${route.query.join(', ')}`
      expect(res, label).toEqual({
        status: 400,
        body: { error: `unknown query parameter "bogus"; ${takes}` },
      })
    }
  })

  it('every route that may carry a body refuses a field it does not take, and changes nothing', async () => {
    const { t, token, task, pathOf } = await fixture()
    const rows = () =>
      t.run(async (ctx) =>
        Promise.all(
          (['issues', 'comments', 'issue_links', 'labels', 'milestones', 'teams'] as const).map(
            async (table) => (await ctx.db.query(table).collect()).length,
          ),
        ),
      )
    const before = await rows()
    for (const route of ROUTES.filter((r) => r.method !== 'GET')) {
      const label = `${route.method} ${route.path}`
      const res = await call(t, token, route.method, pathOf(route.path), { bogus: 1 })
      expect(res.status, label).toBe(400)
      expect(res.body.error, label).toMatch(/^unknown field "bogus"; this request takes /)
    }
    expect(await rows()).toEqual(before)
    // the routes that take no body say so, and an empty body passes
    const path = `/v1/tasks/${task.key}/following`
    expect(await call(t, token, 'PUT', path, { bogus: 1 })).toEqual({
      status: 400,
      body: { error: 'unknown field "bogus"; this request takes no body' },
    })
    expect((await call(t, token, 'PUT', path, {})).status).toBe(200)
    expect((await call(t, token, 'DELETE', path, '')).status).toBe(200)
  })
})

describe('request bodies', () => {
  it('refuses a body whose bytes are not UTF-8 and stores nothing', async () => {
    const { t, token, task } = await fixture()
    // "Caf\xe9" in Latin-1, which is no UTF-8
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('{"title":"Caf'),
      0xe9,
      ...new TextEncoder().encode('"}'),
    ])
    const res = await call(t, token, 'PATCH', `/v1/tasks/${task.key}`, latin1)
    expect(res).toEqual({ status: 400, body: { error: 'request body is not valid UTF-8' } })
    const after = await call(t, token, 'GET', `/v1/tasks/${task.key}`)
    expect(after.body.title).toBe('Swept')
    // the same text in UTF-8 is stored as sent
    const utf8 = await call(t, token, 'PATCH', `/v1/tasks/${task.key}`, { title: 'Café' })
    expect(utf8.body.title).toBe('Café')
  })

  it('POST /v1/webhooks reads its body by the shared rules', async () => {
    const { t, token } = await fixture()
    expect(await call(t, token, 'POST', '/v1/webhooks', '{broken')).toEqual({
      status: 400,
      body: { error: 'request body must be JSON' },
    })
    expect(await call(t, token, 'POST', '/v1/webhooks', '[]')).toEqual({
      status: 400,
      body: { error: 'request body must be JSON' },
    })
    expect(
      await call(t, token, 'POST', '/v1/webhooks', '{"name":"task.updated","x":"\\ud83c"}'),
    ).toEqual({
      status: 400,
      body: { error: 'request body holds an unpaired surrogate, which UTF-8 cannot encode' },
    })
    expect(
      await call(t, token, 'POST', '/v1/webhooks', { name: 'task.updated', mode: 'webhook' }),
    ).toEqual({
      status: 400,
      body: {
        error: 'unknown field "mode"; this request takes name, arguments, delivery, cursor, ttlMs',
      },
    })
    expect(await call(t, token, 'GET', '/v1/webhooks?all=1')).toEqual({
      status: 400,
      body: { error: 'unknown query parameter "all"; this request takes no query parameters' },
    })
    expect(await call(t, token, 'DELETE', `/v1/webhooks/${uuid()}`, { force: true })).toEqual({
      status: 400,
      body: { error: 'unknown field "force"; this request takes no body' },
    })
    // a body the shared rules accept still reaches the subscription rules
    const res = await call(t, token, 'POST', '/v1/webhooks', { name: 'task.nope' })
    expect(res).toEqual({ status: 404, body: { error: 'Unknown event name' } })
    // the subscription rules read the body as sent: a number too large for a
    // double stays Infinity, which they refuse, never null (no filter), and
    // deep nesting gets their refusal rather than a stack overflow
    const tooBig = { name: 'task.updated', arguments: 'HUGE', delivery: { mode: 'webhook' } }
    const huge = JSON.stringify(tooBig).replace('"HUGE"', '1e309')
    expect(await call(t, token, 'POST', '/v1/webhooks', huge)).toEqual({
      status: 400,
      body: { error: 'Expected an object' },
    })
    expect(await call(t, token, 'POST', '/v1/webhooks', '{"name":1e309}')).toEqual({
      status: 400,
      body: { error: 'Event name must be a string' },
    })
    const deep = `{"name":"task.updated","delivery":${'['.repeat(5000)}${']'.repeat(5000)}}`
    expect(await call(t, token, 'POST', '/v1/webhooks', deep)).toEqual({
      status: 400,
      body: { error: 'Expected an object' },
    })
  })

  it('checks a webhook body and query only on a webhook route', async () => {
    const { t, token } = await fixture()
    const latin1 = new Uint8Array([...new TextEncoder().encode('{"name":"caf'), 0xe9, 0x22, 0x7d])
    for (const [method, path] of [
      ['POST', '/v1/webhooks'],
      ['DELETE', `/v1/webhooks/${uuid()}`],
    ])
      expect(await call(t, token, method, path, latin1)).toEqual({
        status: 400,
        body: { error: 'request body is not valid UTF-8' },
      })
    // an unknown webhook path is unknown whatever it carries
    for (const [method, path, body] of [
      ['GET', '/v1/webhooks/nope?x=1', undefined],
      ['PATCH', '/v1/webhooks?x=1', undefined],
      ['DELETE', '/v1/webhooks', { a: 1 }],
    ] as const)
      expect(await call(t, token, method, path, body)).toEqual({
        status: 404,
        body: { error: 'unknown webhook route' },
      })
  })

  it('refuses MCP event params that hold a number JSON cannot write', () => {
    expect(eventParamsJson({ ttlMs: -Infinity })).toBeNull()
    expect(eventParamsJson({ arguments: { task_id: [Number.NaN] } })).toBeNull()
    // a wide array, as a 1 MiB body can hold, walks without overflowing
    expect(eventParamsJson({ arguments: new Array(500_000).fill(0) })).toMatch(
      /^\{"arguments":\[0,/,
    )
    expect(eventParamsJson({ arguments: { task_id: null }, ttlMs: 60_000 })).toBe(
      '{"arguments":{"task_id":null},"ttlMs":60000}',
    )
  })
})
