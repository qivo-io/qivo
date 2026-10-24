/* How long a Better Auth validation error may be, and what it may cost.
 *
 * Better Auth checks every request body and query with zod before anything
 * else, a session included, and Better Call answers a failure with one
 * `[body.path] message` for every problem zod found, joined by "; ". A
 * 64 KiB body that holds an array of 32,000 numbers where strings belong,
 * such as `scopes` on /sign-in/social, so got a 2.2 MB answer, and zod spent
 * about 60 ms and 25 MiB building the 32,000 problems.
 *
 * Two bounds fix that. stopValidationEarly makes zod stop at the first
 * problems when a request holds more than AUTH_FULL_CHECK_VALUES values, so a
 * large invalid request costs about what a valid one does. A smaller request
 * is checked in full and answers as before. It reaches every schema the
 * router checks with but /sign-in/email's, which Better Auth builds again for
 * every request; that body takes four scalar fields, so it lists at most four
 * problems. boundValidationAnswer then cuts the answer's message to
 * AUTH_VALIDATION_MESSAGE_MAX characters at the end of a listed problem and
 * says how many it left out, which also bounds the answer of any check
 * stopValidationEarly does not reach. */

import { AUTH_FULL_CHECK_VALUES, AUTH_VALIDATION_MESSAGE_MAX } from './limits'

/* A Standard Schema result, as Better Call reads it. */
type StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/* The parts of a zod schema stopValidationEarly uses. `abortEarly` is the
 * parse option zod's own `validate` sets: a container stops before its next
 * value once one has failed. A zod without it parses in full, which
 * boundValidationAnswer still bounds. */
type ZodSchema = {
  '~standard': {
    readonly vendor: string
    validate(value: unknown): StandardResult | Promise<StandardResult>
  }
  safeParse(
    value: unknown,
    ctx: { abortEarly: true },
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: ReadonlyArray<{ readonly message: string }> } }
}

const isZodSchema = (value: unknown): value is ZodSchema =>
  typeof value === 'object' &&
  value !== null &&
  '~standard' in value &&
  'safeParse' in value &&
  typeof value.safeParse === 'function'

/* Schemas already changed. Better Auth defines most of them once per module
 * and every auth instance shares them. */
const stopping = new WeakSet<object>()

/** Whether `value` holds at most `limit` values, itself and everything nested
 * in it counted. It stops counting at the limit. */
export function holdsAtMost(value: unknown, limit: number): boolean {
  let left = limit
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const next = pending.pop()
    left -= 1
    if (left < 0) return false
    if (typeof next !== 'object' || next === null) continue
    const children = Object.values(next)
    if (children.length > left) return false
    pending.push(...children)
  }
  return true
}

/* zod's check of `schema` with the early stop, as a Standard Schema result. */
function checkEarly(schema: ZodSchema, value: unknown): StandardResult {
  const result = schema.safeParse(value, { abortEarly: true })
  // `in`, since the app's tsconfig is not strict and so does not narrow on `success`
  return 'error' in result ? { issues: result.error.issues } : { value: result.data }
}

/** Makes every body and query check of `auth`'s endpoints stop at the first
 * problems when the request holds more than AUTH_FULL_CHECK_VALUES values. A
 * valid request gets the same value either way, since the stop only comes
 * after a problem. A schema zod cannot check synchronously keeps its own
 * check. It changes the schemas in place, so every instance sharing one
 * gets the change, and returns `auth`. */
export function stopValidationEarly<Auth extends { api: Record<string, { options?: object }> }>(
  auth: Auth,
): Auth {
  for (const { options } of Object.values(auth.api)) {
    if (!options) continue
    const body = 'body' in options ? options.body : undefined
    const query = 'query' in options ? options.query : undefined
    for (const schema of [body, query]) {
      if (!isZodSchema(schema) || stopping.has(schema)) continue
      stopping.add(schema)
      const standard = schema['~standard']
      schema['~standard'] = {
        ...standard,
        validate: (value) => {
          if (holdsAtMost(value, AUTH_FULL_CHECK_VALUES)) return standard.validate(value)
          try {
            return checkEarly(schema, value)
          } catch {
            // an asynchronous check, which safeParse refuses
            return standard.validate(value)
          }
        },
      }
    }
  }
  return auth
}

/* Better Call's separator between two listed problems. */
const SEPARATOR = '; '

/** `message`, a Better Call validation message of problems joined by "; ",
 * cut to AUTH_VALIDATION_MESSAGE_MAX characters at the end of a listed problem,
 * with how many problems it left out. A first problem longer than that is
 * cut inside, ending in "…". */
export function shortValidationMessage(message: string): string {
  if (message.length <= AUTH_VALIDATION_MESSAGE_MAX) return message
  // Every listed problem starts with its path in brackets.
  const problems = message.split(`${SEPARATOR}[`).map((text, i) => (i === 0 ? text : `[${text}`))
  const note = (left: number) =>
    `${SEPARATOR}and ${left} more ${left === 1 ? 'problem' : 'problems'}`
  const room = AUTH_VALIDATION_MESSAGE_MAX - note(problems.length).length
  let kept = problems[0].length > room ? `${problems[0].slice(0, room - 1)}…` : problems[0]
  let count = 1
  while (
    count < problems.length &&
    kept.length + SEPARATOR.length + problems[count].length <= room
  ) {
    kept += SEPARATOR + problems[count]
    count += 1
  }
  return count < problems.length ? kept + note(problems.length - count) : kept
}

/** `response`, unchanged unless it is Better Auth's 400 VALIDATION_ERROR
 * answer with a message over AUTH_VALIDATION_MESSAGE_MAX characters. That one gets
 * the same status, headers and fields, with the message cut by
 * shortValidationMessage. */
export async function boundValidationAnswer(response: Response): Promise<Response> {
  if (
    response.status !== 400 ||
    !response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')
  )
    return response
  let body: unknown
  try {
    body = JSON.parse(await response.clone().text())
  } catch {
    return response
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('code' in body) ||
    body.code !== 'VALIDATION_ERROR' ||
    !('message' in body) ||
    typeof body.message !== 'string' ||
    body.message.length <= AUTH_VALIDATION_MESSAGE_MAX
  )
    return response
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  return new Response(JSON.stringify({ ...body, message: shortValidationMessage(body.message) }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
