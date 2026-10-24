/* Short Better Auth validation errors (lib/authValidation.ts). A request
 * that holds more than AUTH_FULL_CHECK_VALUES values is checked only until
 * its first problems, and no validation error answers with a message over
 * AUTH_VALIDATION_MESSAGE_MAX characters. A smaller request, valid or not,
 * is checked and answered as Better Auth does on its own. */
/// <reference types="vite/client" />
import type { AuthContext } from '@better-auth/core'
import { getEndpoints } from 'better-auth/api'
import { describe, expect, it } from 'vitest'
import { createAuth } from '../auth'
import {
  boundValidationAnswer,
  holdsAtMost,
  shortValidationMessage,
  stopValidationEarly,
} from '../lib/authValidation'
import {
  AUTH_BODY_MAX_BYTES,
  AUTH_FULL_CHECK_VALUES,
  AUTH_VALIDATION_MESSAGE_MAX,
} from '../lib/limits'
import { OAUTH_CLIENT_METADATA_MAX_BYTES } from '../lib/oauthRegistration'
import { newT, type T } from './helpers.setup'

process.env.BETTER_AUTH_SECRET ??= 'authValidation-test-secret-not-a-deployment'

type FetchInit = { method: string; headers: Record<string, string>; body: string }
const http = (t: T, path: string, init: FetchInit): Promise<Response> =>
  (t as unknown as { fetch(path: string, init: FetchInit): Promise<Response> }).fetch(path, init)
const post = (t: T, path: string, body: string) =>
  http(t, `/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

/* `build(items)` as JSON, with as many numbers in `items` as fit in `bytes`. */
function numbersFilling(build: (items: number[]) => unknown, bytes: number): string {
  const count = Math.floor((bytes - JSON.stringify(build([])).length) / 2)
  const body = JSON.stringify(build(Array(count).fill(1)))
  expect(body.length).toBeLessThanOrEqual(bytes)
  return body
}

/* The body and query schemas of `endpoints`, by `<endpoint> body` and
 * `<endpoint> query`. */
const schemasOf = (endpoints: Record<string, { options?: object }>): Map<string, unknown> =>
  new Map(
    Object.entries(endpoints).flatMap(([key, { options = {} }]) =>
      Object.entries(options)
        .filter(([part, schema]) => (part === 'body' || part === 'query') && schema !== undefined)
        .map(([part, schema]): [string, unknown] => [`${key} ${part}`, schema]),
    ),
  )

const NOT_A_STRING = 'Invalid input: expected string, received number'

describe('validation errors on the auth routes', () => {
  it.each([
    ['/sign-in/social', (scopes: number[]) => ({ provider: 'google', scopes }), 'scopes'],
    ['/link-social', (scopes: number[]) => ({ provider: 'google', scopes }), 'scopes'],
    [
      '/link-social',
      (scopes: number[]) => ({ provider: 'google', idToken: { token: 'x', scopes } }),
      'idToken.scopes',
    ],
    [
      '/oauth2/update-consent',
      (scopes: number[]) => ({ id: 'x', update: { scopes } }),
      'update.scopes',
    ],
  ])('answers a 64 KiB invalid array on %s with its first problem', async (path, build, field) => {
    const response = await post(newT(), path, numbersFilling(build, AUTH_BODY_MAX_BYTES))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(
      JSON.stringify({ message: `[body.${field}.0] ${NOT_A_STRING}`, code: 'VALIDATION_ERROR' }),
    )
  })

  it('answers an invalid client registration of 8 KiB with its first problem and the CORS headers', async () => {
    const response = await http(newT(), '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { Origin: 'https://client.example.test', 'Content-Type': 'application/json' },
      body: numbersFilling(
        (redirect_uris) => ({ redirect_uris }),
        OAUTH_CLIENT_METADATA_MAX_BYTES - 16,
      ),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(JSON.parse(await response.text())).toEqual({
      message: `[body.redirect_uris.0] ${NOT_A_STRING}`,
      code: 'VALIDATION_ERROR',
    })
  })

  it('lists the first of many problems in a request checked in full and counts the rest', async () => {
    const count = AUTH_FULL_CHECK_VALUES - 100
    const response = await post(
      newT(),
      '/sign-in/social',
      JSON.stringify({ provider: 'google', scopes: Array(count).fill(1) }),
    )
    expect(response.status).toBe(400)
    const { message, code } = JSON.parse(await response.text())
    expect(code).toBe('VALIDATION_ERROR')
    expect(message.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    const listed = message.split('; ')
    const note = listed.pop()
    listed.forEach((problem: string, i: number) => {
      expect(problem).toBe(`[body.scopes.${i}] ${NOT_A_STRING}`)
    })
    expect(note).toBe(`and ${count - listed.length} more problems`)
  })

  it('answers a small invalid request with every problem, as Better Auth does', async () => {
    const response = await post(newT(), '/sign-in/email', '{}')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(
      JSON.stringify({
        message:
          '[body.email] Invalid input: expected string, received undefined; [body.password] Invalid input: expected string, received undefined',
        code: 'VALIDATION_ERROR',
      }),
    )
  })
})

describe('stopValidationEarly', () => {
  const auth = createAuth({} as Parameters<typeof createAuth>[0])
  const social = auth.api.signInSocial.options.body
  const registration = auth.api.registerOAuthClient.options.body
  const large = AUTH_FULL_CHECK_VALUES * 2

  it('gives a valid request the value zod gives it, below and above the full check', async () => {
    const bodies = [
      [social, { provider: 'google', scopes: ['openid'], disableRedirect: true }],
      [social, { provider: 'google', scopes: Array(large).fill('openid') }],
      [
        social,
        {
          provider: 'google',
          additionalData: Object.fromEntries(Array.from({ length: large }, (_, i) => [`k${i}`, i])),
        },
      ],
      [
        registration,
        {
          client_name: 'Client',
          redirect_uris: ['https://client.example.test/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
      ],
      [registration, { redirect_uris: Array(large).fill('https://client.example.test/cb') }],
    ] as const
    for (const [schema, body] of bodies) {
      const expected = schema.safeParse(body)
      expect(expected.success).toBe(true)
      expect(await schema['~standard'].validate(body)).toEqual({ value: expected.data })
    }
  })

  it('lists every problem of a small invalid request, as zod does', async () => {
    const body = { provider: 1, scopes: [1, 'openid', 2], disableRedirect: 'yes' }
    const result = await social['~standard'].validate(body)
    expect(result.issues).toEqual(social.safeParse(body).error?.issues)
    expect(result.issues).toHaveLength(4)
  })

  it('stops at the first problem of a large invalid request', async () => {
    const body = { provider: 'google', scopes: Array(large).fill(1) }
    expect(social.safeParse(body).error?.issues).toHaveLength(large)
    const result = await social['~standard'].validate(body)
    expect(result.issues?.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['scopes', 0], message: NOT_A_STRING },
    ])
  })

  it('reaches every schema the router checks with but /sign-in/email', () => {
    // The router builds its endpoints again for every request. Only
    // /sign-in/email's builds its body schema again too, so the router checks
    // it unchanged. That body takes four scalar fields, so its error lists at
    // most four problems.
    const own = schemasOf(auth.api)
    // the instance's context, which Better Auth types more narrowly than it builds
    const context = auth.$context as Promise<unknown> as Promise<AuthContext>
    const routed = schemasOf(getEndpoints(context, auth.options).api)
    expect([...routed.keys()]).toEqual([...own.keys()])
    const unreached = [...own].filter(([name, schema]) => routed.get(name) !== schema)
    expect(unreached.map(([name]) => name)).toEqual(['signInEmail body'])
  })

  it('changes a schema once however many instances share it', async () => {
    const validate = social['~standard'].validate
    stopValidationEarly(createAuth({} as Parameters<typeof createAuth>[0]))
    expect(social['~standard'].validate).toBe(validate)
  })
})

describe('holdsAtMost', () => {
  it('counts every value at every depth', () => {
    const value = { a: [1, 2, { b: null }], c: 'x' } // 7 values
    expect(holdsAtMost(value, 7)).toBe(true)
    expect(holdsAtMost(value, 6)).toBe(false)
    expect(holdsAtMost('x', 1)).toBe(true)
    expect(holdsAtMost(Array(10).fill(0), 10)).toBe(false)
  })

  it('stops on a value that refers to itself', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(holdsAtMost(value, 50)).toBe(false)
  })
})

describe('shortValidationMessage', () => {
  const problem = (i: number) => `[body.scopes.${i}] ${NOT_A_STRING}`

  it('keeps a message within the limit as it is', () => {
    const message = Array.from({ length: 3 }, (_, i) => problem(i)).join('; ')
    expect(shortValidationMessage(message)).toBe(message)
  })

  it('ends at a listed problem and counts the ones left out', () => {
    const message = Array.from({ length: 500 }, (_, i) => problem(i)).join('; ')
    const short = shortValidationMessage(message)
    expect(short.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    const listed = short.split('; ')
    const note = listed.pop()
    expect(listed).toEqual(Array.from({ length: listed.length }, (_, i) => problem(i)))
    expect(note).toBe(`and ${500 - listed.length} more problems`)
  })

  it('cuts a first problem longer than the limit inside it', () => {
    const long = `[body.permission.${'k'.repeat(10_000)}] Invalid input`
    const short = shortValidationMessage(`${long}; ${problem(1)}`)
    expect(short.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    expect(short).toMatch(/^\[body\.permission\.k+…; and 1 more problem$/)
  })
})

describe('boundValidationAnswer', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })

  it('returns every other answer itself, unread', async () => {
    const answers = [
      json(200, { token: 'x', user: { id: 'u' } }, { 'Set-Cookie': 'a=b; Path=/' }),
      new Response(null, { status: 302, headers: { Location: 'http://localhost:5199/app' } }),
      new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }),
      json(400, { message: 'x'.repeat(5_000), code: 'INVALID_EMAIL' }),
      json(400, { message: problemsOf(3), code: 'VALIDATION_ERROR' }),
      new Response('Bad request', { status: 400, headers: { 'Content-Type': 'text/plain' } }),
      json(413, { message: 'x'.repeat(5_000), code: 'VALIDATION_ERROR' }),
    ]
    for (const answer of answers) {
      expect(await boundValidationAnswer(answer)).toBe(answer)
      expect(answer.bodyUsed).toBe(false)
    }
  })

  it('shortens a long validation error and keeps its status, headers and other fields', async () => {
    const answer = json(
      400,
      { message: problemsOf(500), code: 'VALIDATION_ERROR' },
      { 'Set-Cookie': 'a=b; Path=/', 'Access-Control-Allow-Origin': '*', 'Content-Length': '1' },
    )
    const short = await boundValidationAnswer(answer)
    expect(short.status).toBe(400)
    expect(short.headers.get('Set-Cookie')).toBe('a=b; Path=/')
    expect(short.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(short.headers.get('Content-Length')).toBeNull()
    expect(JSON.parse(await short.text())).toEqual({
      message: shortValidationMessage(problemsOf(500)),
      code: 'VALIDATION_ERROR',
    })
  })
})

function problemsOf(count: number): string {
  return Array.from({ length: count }, (_, i) => `[body.scopes.${i}] ${NOT_A_STRING}`).join('; ')
}
