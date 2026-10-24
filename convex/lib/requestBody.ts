/* How every HTTP route reads a request body, and why its answer waits for it.
 *
 * An answer sent while the client is still uploading lets Convex's HTTP front
 * end reset the connection or answer 502 in its place, so the client sees no
 * reason or the wrong one. Every route in convex/ therefore builds its
 * handler with answerAfterBody, which drops the rest of the body before the
 * answer goes out, however early the handler decided it. The Better Auth
 * component builds its own routes: its GET and POST handler (http.ts
 * createHttpAuthAfterBody) calls discardBody itself, and hands Better Auth,
 * which reads a body with no bound in time or size, a copy whose body
 * bufferedRequest has already read (http.ts readAuthBody). Its CORS preflight
 * for /api/auth/* answers without a handler of ours. It takes OPTIONS, which
 * browsers send without a body. convex/tests/requestBody.test.ts refuses any
 * other module that imports httpAction. */

import { httpAction } from '../_generated/server'
import { MIB } from './limits'

/* convex/tsconfig's lib is ESNext only, which declares neither the timers
 * nor the request body stream the Convex runtime has. */
declare function setTimeout(callback: () => void, delay: number): unknown
declare function clearTimeout(timer: unknown): void

/** The Convex runtime's request body stream, which convex/tsconfig's ESNext
 * lib does not declare. */
export type BodyStream = {
  readonly locked: boolean
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
    releaseLock(): void
  }
}

/** The body stream of `request`, or null when it has none. */
export const bodyOf = (request: Request): BodyStream | null =>
  (request as Request & { body: BodyStream | null }).body

/** How long discardBody waits for the rest of a body, in milliseconds. A
 * body just over the 1 MiB cap arrives inside it at about 2 Mbit/s or more.
 * It is short because an unauthenticated caller can make every answer wait
 * this long, and HTTP actions share a concurrency limit. */
export const DISCARD_MS = 5_000

/** How long discardBody waits for the next bytes of a body, in
 * milliseconds, so a client that stopped sending frees the action at once
 * while one still uploading keeps its answer. */
export const DISCARD_IDLE_MS = 1_000

/** The most discardBody reads, in bytes: well over the largest body any
 * Qivo route takes (a 20 MiB attachment). Convex limits only
 * multipart/form-data request bodies, to 20 MiB, which no Qivo route
 * takes, so this is the only bound on the rest. */
export const DISCARD_MAX_BYTES = 32 * MIB

/** How long a cancel of a body may hold the answer, in milliseconds. A body
 * shared with a clone (Request.clone) finishes cancelling only once the
 * clone is cancelled too. No route clones the request the platform hands it
 * (Better Auth clones the copy bufferedRequest makes), so this only keeps a
 * cancel that does not settle from holding the answer. */
export const CANCEL_MS = 100

/* Cancels the body `reader` reads, waiting at most CANCEL_MS for it. */
async function cancelBody(reader: ReturnType<BodyStream['getReader']>): Promise<void> {
  let timer: unknown
  await Promise.race([
    reader.cancel().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CANCEL_MS)
    }),
  ])
  clearTimeout(timer)
}

/**
 * Reads and drops whatever is left of a request body, so that the answer
 * goes out only after the client finished uploading. It stops after
 * `waitMs`, after `idleMs` without bytes or past DISCARD_MAX_BYTES, so a
 * slow, stalled or endless upload holds the action at most `waitMs` and
 * CANCEL_MS, and such a client may then still see a reset or a 502. It does
 * not start on a body declared longer than DISCARD_MAX_BYTES, which it could
 * not finish, and leaves alone a body a reader still holds (one cancelled
 * after a timeout).
 */
export async function discardBody(
  request: Request,
  waitMs = DISCARD_MS,
  idleMs = DISCARD_IDLE_MS,
): Promise<void> {
  const body = bodyOf(request)
  if (body === null || body.locked) return
  const reader = body.getReader()
  if (Number(request.headers.get('Content-Length')) > DISCARD_MAX_BYTES) {
    await cancelBody(reader)
    return
  }
  let timer: unknown
  let idleTimer: unknown
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs)
  })
  // null once `idleMs` pass, restarted for every read
  const quiet = () =>
    new Promise<null>((resolve) => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => resolve(null), idleMs)
    })
  const drain = async () => {
    let size = 0
    for (;;) {
      const next = await Promise.race([reader.read(), quiet()])
      if (next === null || next.done) return
      size += next.value?.byteLength ?? 0
      if (size > DISCARD_MAX_BYTES) return
    }
  }
  try {
    await Promise.race([drain(), late])
  } catch {
    // the client gave up on its upload, so nothing is left to wait for
  } finally {
    clearTimeout(timer)
    clearTimeout(idleTimer)
    await cancelBody(reader)
  }
}

/** An httpAction whose answer, whatever it is and wherever the handler
 * decided it, goes out only after the request body arrived (discardBody).
 * Every route in convex/ is built with it. A failure while dropping the
 * body never replaces the answer, which may report a committed write. */
export const answerAfterBody = (handler: Parameters<typeof httpAction>[0]) =>
  httpAction(async (ctx, request) => {
    try {
      return await handler(ctx, request)
    } finally {
      await discardBody(request).catch(() => {})
    }
  })

/** A body readLimitedBody read (`read`), or why it did not: `missing` for
 * a request without one, `too_large` for one declared or found longer than
 * the limit and `too_slow` for one still arriving at the deadline. */
export type LimitedBody =
  | { outcome: 'read'; bytes: Uint8Array<ArrayBuffer> }
  | { outcome: 'missing' | 'too_large' | 'too_slow' }

/**
 * The request body's bytes when it holds at most `maxBytes`, and arrives
 * within `waitMs` when that is given. A Content-Length over the limit
 * decides before reading. Otherwise the bytes are counted as they arrive, so
 * a body sent without Content-Length stops being kept once it passes the
 * limit. A body that is too large is left to answerAfterBody's discardBody,
 * so the client still gets the answer. One that is too slow is cancelled,
 * since waiting longer would not finish it. A failed read, such as a client
 * that hung up, throws.
 */
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
  waitMs?: number,
): Promise<LimitedBody> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) {
    return { outcome: 'too_large' }
  }
  const body = bodyOf(request)
  if (body === null) return { outcome: 'missing' }
  const reader = body.getReader()
  let timer: unknown
  let late = false
  const tooSlow = new Promise<LimitedBody>((resolve) => {
    if (waitMs === undefined) return
    timer = setTimeout(() => {
      late = true
      resolve({ outcome: 'too_slow' })
    }, waitMs)
  })
  const read = async (): Promise<LimitedBody> => {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > maxBytes) return { outcome: 'too_large' }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { outcome: 'read', bytes }
  }
  try {
    return await Promise.race([read(), tooSlow])
  } finally {
    clearTimeout(timer)
    // a read still waits on a body that came too late, so only cancel ends it
    if (late) await cancelBody(reader)
    else reader.releaseLock()
  }
}

/**
 * A copy of `request` that holds its whole body in memory (`read`), or why
 * readLimitedBody could not read it. The copy has the original method, URL
 * and headers and exactly the bytes the client sent, so a handler that reads
 * the body itself, such as Better Auth's, can neither wait on a slow client
 * nor read past `maxBytes`. A request without a body comes back as it is. A
 * GET or HEAD request, which a Request cannot carry a body on, comes back as
 * a copy without one, so a body a client sent with it is never read; the
 * caller drops it with discardBody.
 */
export async function bufferedRequest(
  request: Request,
  maxBytes: number,
  waitMs: number,
): Promise<{ outcome: 'read'; request: Request } | { outcome: 'too_large' | 'too_slow' }> {
  if (request.method === 'GET' || request.method === 'HEAD')
    return {
      outcome: 'read',
      request:
        bodyOf(request) === null
          ? request
          : new Request(request.url, { method: request.method, headers: request.headers }),
    }
  const read = await readLimitedBody(request, maxBytes, waitMs)
  if (read.outcome === 'read')
    return {
      outcome: 'read',
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: read.bytes,
      }),
    }
  return read.outcome === 'missing' ? { outcome: 'read', request } : { outcome: read.outcome }
}
