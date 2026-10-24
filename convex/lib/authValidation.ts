/* How long a Better Auth validation error may be, and what it may cost.
 *
 * Better Auth checks every request body and query with zod as the endpoint
 * starts, after its request checks and the `before` hooks, and ahead of any
 * session check. Better Call answers a failure with one
 * `[body.path] message` for every problem zod found, joined by "; ". A
 * 64 KiB body that holds an array of 32,000 numbers where strings belong,
 * such as `scopes` on /sign-in/social, so got a 2.2 MB answer, and zod spent
 * about 60 ms and 25 MiB building the 32,000 problems.
 *
 * Two bounds fix that. stopValidationEarly makes zod stop at the first
 * problem when a request holds more than AUTH_FULL_CHECK_VALUES values, so a
 * large invalid request costs about what a valid one does. A smaller request
 * is checked in full and answers as before. stopValidationEarly reaches every
 * schema the router checks with but /sign-in/email's, which Better Auth builds
 * again for every request; that body takes four scalar fields, so it lists at
 * most four problems. zod checks every entry of a record even when it stops
 * early, so auth.ts turns off /admin/has-permission, the one route whose
 * record entries can fail. boundValidationAnswer then cuts the answer's message to
 * AUTH_VALIDATION_MESSAGE_MAX characters at the end of a listed problem and
 * says how many it left out, which also bounds the answer of any check
 * stopValidationEarly does not reach. */

import { AUTH_FULL_CHECK_VALUES, AUTH_VALIDATION_MESSAGE_MAX, cutText } from './limits'

/* A Standard Schema result, as Better Call reads it. */
type StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/* The parts of a zod schema stopValidationEarly uses. `abortEarly` is the
 * internal parse option zod's own `validate` sets: an array or object stops
 * before its next value once one has an aborting problem, such as a wrong
 * type, which is why checkEarly makes every definition abort. A zod without
 * it parses in full, which boundValidationAnswer still bounds. */
type ZodSchema = ZodNode & {
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

/* A zod schema or check, as far as definitionsOf walks it. */
type ZodNode = { _zod: { def: Definition; innerType?: unknown } }

/* A zod definition. `abort` makes the problem its check finds end the
 * value's check, as aborting problems such as a wrong type always do. zod
 * reads it while it parses. */
type Definition = { [part: string]: unknown; abort?: boolean }

const isZodNode = (value: unknown): value is ZodNode =>
  typeof value === 'object' &&
  value !== null &&
  '_zod' in value &&
  typeof value._zod === 'object' &&
  value._zod !== null &&
  'def' in value._zod

/* Schemas already changed. Better Auth defines most of them once per module
 * and every auth instance shares them. */
const stopping = new WeakSet<object>()

/** The definitions in `schema`: its own, its checks' and every nested
 * schema's, through objects, arrays, unions, records, pipes, wrappers and
 * lazy schemas. */
export function definitionsOf(schema: ZodNode): Definition[] {
  const found = new Set<Definition>()
  const pending: unknown[] = [schema]
  while (pending.length > 0) {
    const next = pending.pop()
    if (Array.isArray(next)) {
      pending.push(...next)
      continue
    }
    if (!isZodNode(next) || found.has(next._zod.def)) continue
    const { def } = next._zod
    found.add(def)
    for (const part of Object.values(def)) {
      // a nested schema, a list of them (checks, options, items) or an object's shape
      if (isZodNode(part) || Array.isArray(part)) pending.push(part)
      else if (typeof part === 'object' && part !== null) pending.push(...Object.values(part))
    }
    if (def.type === 'lazy') pending.push(next._zod.innerType)
  }
  return [...found]
}

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

/* zod's check of `schema` with the early stop, as a Standard Schema result.
 * `abortEarly` alone stops a container only at an aborting problem, so an
 * array of 2,000 empty strings where each must hold one character would
 * still list 2,000 problems. Every definition in the schema therefore aborts
 * while the check runs, and gets its own setting back after. The check is
 * synchronous, so no other check sees the change. A valid value gets the same
 * result, since `abort` only acts on a problem. A record is the exception:
 * zod checks each of its entries whatever either setting says. */
function checkEarly(schema: ZodSchema, definitions: Definition[], value: unknown): StandardResult {
  const settings = definitions.map((def) => def.abort)
  let result: ReturnType<ZodSchema['safeParse']>
  try {
    for (const def of definitions) def.abort = true
    result = schema.safeParse(value, { abortEarly: true })
  } finally {
    definitions.forEach((def, i) => {
      if (settings[i] === undefined) delete def.abort
      else def.abort = settings[i]
    })
  }
  // `in`, since the app's tsconfig is not strict and so does not narrow on `success`
  return 'error' in result ? { issues: result.error.issues } : { value: result.data }
}

/** Makes every body and query check of `auth`'s endpoints stop at the first
 * problem when the request holds more than AUTH_FULL_CHECK_VALUES values. A
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
      let definitions: Definition[] | undefined
      schema['~standard'] = {
        ...standard,
        validate: (value) => {
          if (holdsAtMost(value, AUTH_FULL_CHECK_VALUES)) return standard.validate(value)
          try {
            definitions ??= definitionsOf(schema)
            return checkEarly(schema, definitions, value)
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
  let kept = problems[0].length > room ? `${cutText(problems[0], room - 1)}…` : problems[0]
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
