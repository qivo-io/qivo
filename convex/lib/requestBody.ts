/* How every HTTP route reads a request body, and why its answer waits for it.
 *
 * An answer sent while the client is still uploading lets Convex's HTTP front
 * end reset the connection or answer 502 in its place, so the client sees no
 * reason or the wrong one. Every route in convex/ therefore builds its
 * handler with answerAfterBody, which drops the rest of the body before the
 * answer goes out, however early the handler decided it. The one exception
 * is the Better Auth component's own route, whose handler (http.ts
 * createHttpAuthAfterBody) calls discardBody itself.
 * convex/tests/requestBody.test.ts refuses any other httpAction. */

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

/** The most discardBody reads, in bytes: well over the largest body any
 * Qivo route takes (a 20 MiB attachment). Convex sets no request size
 * limit of its own. */
export const DISCARD_MAX_BYTES = 32 * MIB

/**
 * Reads and drops whatever is left of a request body, so that the answer
 * goes out only after the client finished uploading. It stops after
 * `waitMs` or DISCARD_MAX_BYTES, so a slow or endless upload cannot hold the
 * action, and such a client may then still see a reset. It does not start on
 * a body declared longer than DISCARD_MAX_BYTES, which it could not finish,
 * and leaves alone a body a reader still holds (one cancelled after a
 * timeout).
 */
export async function discardBody(request: Request, waitMs = DISCARD_MS): Promise<void> {
  const body = bodyOf(request)
  if (body === null || body.locked) return
  const reader = body.getReader()
  if (Number(request.headers.get('Content-Length')) > DISCARD_MAX_BYTES) {
    await reader.cancel().catch(() => {})
    return
  }
  let timer: unknown
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs)
  })
  const drain = async () => {
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      size += value?.byteLength ?? 0
      if (size > DISCARD_MAX_BYTES) return
    }
  }
  try {
    await Promise.race([drain(), late])
  } catch {
    // the client gave up on its upload, so nothing is left to wait for
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

/** An httpAction whose answer, whatever it is and wherever the handler
 * decided it, goes out only after the request body arrived (discardBody).
 * Every route in convex/ is built with it. */
export const answerAfterBody = (handler: Parameters<typeof httpAction>[0]) =>
  httpAction(async (ctx, request) => {
    try {
      return await handler(ctx, request)
    } finally {
      await discardBody(request)
    }
  })

/** A body readLimitedBody read, or why it did not: `missing` for a request
 * without one, `too_large` for one declared or found longer than the limit
 * and `too_slow` for one still arriving at the deadline. */
export type LimitedBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'missing' | 'too_large' | 'too_slow' }

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
    return { ok: false, reason: 'too_large' }
  }
  const body = bodyOf(request)
  if (body === null) return { ok: false, reason: 'missing' }
  const reader = body.getReader()
  let timer: unknown
  let late = false
  const tooSlow = new Promise<LimitedBody>((resolve) => {
    if (waitMs === undefined) return
    timer = setTimeout(() => {
      late = true
      resolve({ ok: false, reason: 'too_slow' })
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
      if (size > maxBytes) return { ok: false, reason: 'too_large' }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, bytes }
  }
  try {
    return await Promise.race([read(), tooSlow])
  } finally {
    clearTimeout(timer)
    // a read still waits on a body that came too late, so only cancel ends it
    if (late) await reader.cancel().catch(() => {})
    else reader.releaseLock()
  }
}
