/* Short Better Auth validation errors (lib/authValidation.ts). A request
 * that holds more than AUTH_FULL_CHECK_VALUES values is checked only until
 * its first problem, and no validation error answers with a message over
 * AUTH_VALIDATION_MESSAGE_MAX characters. A smaller request, valid or not,
 * is checked and answered as Better Auth does on its own. */
/// <reference types="vite/client" />
import type { AuthContext } from '@better-auth/core'
import { getEndpoints } from 'better-auth/api'
import { describe, expect, it, vi } from 'vitest'
import { createAuth } from '../auth'
import { AUTH_ROUTES, servesAuthRoute } from '../lib/authRoutes'
import {
  boundIssues,
  boundValidationAnswer,
  definitionsOf,
  holdsAtMost,
  problemText,
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
  it('answers a 64 KiB invalid array with its first problem', async () => {
    const build = (scopes: number[]) => ({ provider: 'google', scopes })
    const response = await post(
      newT(),
      '/sign-in/social',
      numbersFilling(build, AUTH_BODY_MAX_BYTES),
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(
      JSON.stringify({ message: `[body.scopes.0] ${NOT_A_STRING}`, code: 'VALIDATION_ERROR' }),
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

  it('cuts a client registration checked in full and keeps the CORS headers', async () => {
    const response = await http(newT(), '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { Origin: 'https://client.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: Array(AUTH_FULL_CHECK_VALUES - 100).fill(1) }),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const { message, code } = JSON.parse(await response.text())
    expect(code).toBe('VALIDATION_ERROR')
    expect(message.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    expect(message).toMatch(/^\[body\.redirect_uris\.0\] .*; and \d+ more problems$/)
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

  it.each([
    [
      'empty contacts',
      { redirect_uris: ['https://client.example.test/cb'], contacts: Array(large).fill('') },
      'contacts',
    ],
    [
      'redirect URIs that are not URLs',
      { redirect_uris: Array(large).fill('not a url') },
      'redirect_uris',
    ],
  ])('stops at the first problem of a large request of %s', async (_, body, field) => {
    expect(registration.safeParse(body).error?.issues.length).toBeGreaterThanOrEqual(large)
    const result = await registration['~standard'].validate(body)
    expect(result.issues?.map(({ path }) => path)).toEqual([[field, 0]])
  })

  it('leaves zod checking a small request in full after a large one', async () => {
    const small = { redirect_uris: ['not a url', 'nor this'], contacts: ['', ''] }
    const issues = registration.safeParse(small).error?.issues
    expect(issues).toHaveLength(6) // a URL problem and a parse problem for each URL
    await registration['~standard'].validate({ ...small, contacts: Array(large).fill('') })
    expect(registration.safeParse(small).error?.issues).toEqual(issues)
    expect((await registration['~standard'].validate(small)).issues).toEqual(issues)
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

  it('checks a large request early on every body and query schema, with the same answer', async () => {
    // A schema holding a `catch` is checked in full, so none of these does.
    const schemas = [...schemasOf(auth.api)] as [string, typeof social][]
    expect(schemas.some(([name]) => name.endsWith(' query'))).toBe(true)
    const large = Array(AUTH_FULL_CHECK_VALUES + 1).fill(0)
    const late = []
    const differ = []
    for (const [name, schema] of schemas) {
      const safeParse = vi.spyOn(schema, 'safeParse')
      try {
        const result = await schema['~standard'].validate(large)
        const early = safeParse.mock.calls.some(
          ([, ctx]) => ctx !== undefined && 'abortEarly' in ctx && ctx.abortEarly === true,
        )
        if (!early) late.push(name)
        if (!result.issues !== schema.safeParse(large).success) differ.push(name)
      } finally {
        safeParse.mockRestore()
      }
    }
    expect(late).toEqual([])
    expect(differ).toEqual([])
  })

  /* A schema of its own, wrapped as stopValidationEarly wraps an endpoint's. */
  const wrapped = <Schema extends object>(schema: Schema) => {
    stopValidationEarly({ api: { endpoint: { options: { body: schema } } } })
    return schema
  }
  const word = social.shape.scopes.unwrap().element

  it('checks a large request in full when the schema holds a catch, which reads the problems', async () => {
    // The fallback counts the problems, so the early stop's single problem
    // would make the refinement refuse a request the full check accepts.
    const counted = wrapped(
      word
        .array()
        .catch(((ctx: { error: { issues: unknown[] } }) => ctx.error.issues.length) as never)
        .refine((count: unknown) => count !== 1),
    )
    expect(counted.safeParse(Array(large).fill(1))).toEqual({ success: true, data: large })
    expect(await counted['~standard'].validate(Array(large).fill(1))).toEqual({ value: large })
  })

  it('checks a large request with an asynchronous check in full', async () => {
    const pending = wrapped(word.refine(async (value) => value === 'ok').array())
    expect(await pending['~standard'].validate(Array(large).fill('ok'))).toEqual({
      value: Array(large).fill('ok'),
    })
    const result = await pending['~standard'].validate(['no', ...Array(large).fill('ok'), 'no'])
    expect(result.issues?.map(({ path }) => path)).toEqual([[0], [large + 1]])
  })

  it('fails a large request whose early check breaks, rather than checking it another way', async () => {
    const broken = wrapped(word.array())
    vi.spyOn(broken, 'safeParse').mockImplementation(() => {
      throw new TypeError('a fault in the early check')
    })
    try {
      expect(() => broken['~standard'].validate(Array(large).fill('ok'))).toThrow(
        'a fault in the early check',
      )
      // a small request never takes the early check
      expect(await broken['~standard'].validate(['ok'])).toEqual({ value: ['ok'] })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('serves no record whose entries can fail, which zod would check in full', () => {
    // A record of any value under string keys cannot fail, so zod lists no
    // problem for its entries.
    const served = (path: string, method: string) =>
      servesAuthRoute(
        AUTH_ROUTES,
        new Request(`https://some.convex.site/api/auth${path.replace(/:[^/]+/g, 'x')}`, { method }),
      )
    const cannotFail = (part: unknown) => {
      const { type, checks } = (part as { _zod: { def: { type: string; checks?: unknown[] } } })
        ._zod.def
      return ['any', 'unknown'].includes(type) || (type === 'string' && !checks?.length)
    }
    const endpoints: Record<string, { path?: string; options: { method: string | string[] } }> =
      auth.api
    const failing = [...schemasOf(auth.api)]
      .filter(([name]) => {
        const { path, options } = endpoints[name.split(' ')[0]]
        return path !== undefined && [options.method].flat().some((method) => served(path, method))
      })
      .filter(([, schema]) =>
        definitionsOf(schema as Parameters<typeof definitionsOf>[0]).some(
          (def) => def.type === 'record' && !(cannotFail(def.keyType) && cannotFail(def.valueType)),
        ),
      )
      .map(([name]) => name)
    expect(failing).toEqual([])
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

describe('boundIssues', () => {
  const issue = (i: number, message = NOT_A_STRING) => ({ path: ['scopes', i], message })
  const issues = (count: number, message?: string) =>
    Array.from({ length: count }, (_, i) => issue(i, message))
  const listed = (kept: ReturnType<typeof boundIssues>) =>
    kept.map((each) => problemText(each, 'body')).join('; ')

  it('keeps problems that fit as they are', () => {
    const few = issues(3)
    expect(boundIssues(few, 'body')).toBe(few)
  })

  it('ends at a listed problem and counts the ones left out', () => {
    const kept = boundIssues(issues(500), 'body')
    expect(listed(kept).length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    expect(kept.slice(0, -1)).toEqual(issues(kept.length - 1))
    expect(kept.at(-1)).toEqual(
      issue(kept.length - 1, `${NOT_A_STRING}; and ${500 - kept.length} more problems`),
    )
  })

  it('keeps a problem whose message looks like a list of problems whole', () => {
    // The message names a value the request sent, which may hold "; [".
    const odd = 'Unrecognized key: "a; [body.b] c"'
    const kept = boundIssues(issues(500, odd), 'body')
    const message = listed(kept)
    expect(message.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    expect(kept.slice(0, -1)).toEqual(issues(kept.length - 1, odd))
    expect(message).toMatch(new RegExp(`; and ${500 - kept.length} more problems$`))
  })

  it('keeps an emoji at the cut whole or leaves it out', () => {
    const long = 'x'.repeat(AUTH_VALIDATION_MESSAGE_MAX)
    for (const at of [2000, 2001, 2002, 2003]) {
      const kept = boundIssues(
        [issue(0, `${long.slice(0, at)}😀${long.slice(at)}`), issue(1)],
        'body',
      )
      expect(listed(kept).length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
      expect(listed(kept).isWellFormed()).toBe(true)
    }
  })

  it('cuts the place and message of a first problem longer than the limit', () => {
    const long = {
      path: ['permission', 'k'.repeat(10_000)],
      message: `Invalid ${'input '.repeat(1_000)}`,
    }
    const message = listed(boundIssues([long, issue(1)], 'body'))
    expect(message.length).toBeLessThanOrEqual(AUTH_VALIDATION_MESSAGE_MAX)
    expect(message).toMatch(/^\[body\.permission\.k+…\] Invalid [input ]+…; and 1 more problem$/)
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

  it('cuts a long validation error and keeps its status, headers and other fields', async () => {
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
    const { message, code } = JSON.parse(await short.text())
    expect(code).toBe('VALIDATION_ERROR')
    expect(message).toHaveLength(AUTH_VALIDATION_MESSAGE_MAX)
    expect(message).toBe(`${problemsOf(500).slice(0, AUTH_VALIDATION_MESSAGE_MAX - 1)}…`)
  })
})

function problemsOf(count: number): string {
  return Array.from({ length: count }, (_, i) => `[body.scopes.${i}] ${NOT_A_STRING}`).join('; ')
}
