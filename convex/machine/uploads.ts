/* The receiver of the upload URL that REST's POST /v1/tasks/{ref}/attachments
 * and MCP's start_attachment_upload answer (model/attachments.ts
 * startAttachmentUpload). The URL names its ticket and carries a file token
 * for it (lib/fileTokens.ts attachmentUploadUrl), so it needs no credential,
 * like the Convex upload URL it replaces. Unlike that URL, it stores at most
 * one file: a POST claims the ticket under its own id (beginTicketUpload),
 * and every other POST is refused before anything is read. The receiver
 * reads exactly the declared number of bytes, stores them and records the
 * file on the ticket (finishTicketUpload), which the confirm call then must
 * name. A POST that fails stores nothing and frees the URL for another try
 * (abandonTicketUpload). One that cannot, because its runtime stopped, holds
 * the URL for UPLOAD_CLAIM_MS at most.
 *
 * It answers like a Convex upload URL, `{"storageId": "…"}` with any
 * origin allowed, so clients built for one keep working. A refusal is
 * `{"error": message}` with 404 for an unknown, expired or forged URL, 409
 * for a used one and 400 for a body that is not the declared size. */

import type { HttpRouter } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { httpAction, internalMutation } from '../_generated/server'
import { verifyFileToken } from '../lib/fileTokens'
import { badRequest, type Refusal } from '../lib/functions'
import { LIMITS, overText } from '../lib/limits'
import {
  abandonTicketUpload,
  beginTicketUpload,
  finishTicketUpload,
  UPLOAD_CLAIM_MS,
  UPLOAD_TICKET_MISSING,
  uploadSizeWrong,
} from '../model/attachments'
import { internalError } from './shared'

const PREFIX = '/attachment-uploads/'

/* How long the receiver reads a body before it gives up, well inside
 * UPLOAD_CLAIM_MS so that a POST still storing its file keeps the URL. */
const READ_MS = UPLOAD_CLAIM_MS / 3

/** The answer for a body that took longer than READ_MS to arrive. */
export const UPLOAD_TOO_SLOW = 'the upload took too long; send it again'

/** The answer for a Content-Type longer than LIMITS.mediaType, the
 * confirm's sentence for it. */
export const MEDIA_TYPE_TOO_LONG = LIMITS.mediaType.refusal

/* The Convex runtime's Blob, timers and crypto, which convex/tsconfig's
 * ESNext lib does not declare. */
declare const Blob: { new (parts: Uint8Array[], options: { type: string }): Blob }
declare function setTimeout(callback: () => void, delay: number): unknown
declare function clearTimeout(timer: unknown): void
declare const crypto: { randomUUID(): string }
type BodyStream = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
  }
}

/* Claims the ticket's one POST (model/attachments.ts beginTicketUpload). */
export const begin = internalMutation({
  args: { ticket: v.string(), minter: v.string(), attempt: v.string() },
  handler: (ctx, a) =>
    beginTicketUpload(ctx, {
      ticketId: a.ticket,
      minter: a.minter,
      attempt: a.attempt,
      nowMs: Date.now(),
    }),
})

/* Records the stored file on the ticket, or deletes it
 * (model/attachments.ts finishTicketUpload). */
export const finish = internalMutation({
  args: {
    ticket: v.string(),
    minter: v.string(),
    attempt: v.string(),
    storage_id: v.id('_storage'),
  },
  handler: (ctx, a) =>
    finishTicketUpload(ctx, {
      ticketId: a.ticket,
      minter: a.minter,
      attempt: a.attempt,
      storageId: a.storage_id,
      nowMs: Date.now(),
    }),
})

/* Frees the ticket after a failed POST (model/attachments.ts
 * abandonTicketUpload). */
export const abandon = internalMutation({
  args: {
    ticket: v.string(),
    minter: v.string(),
    attempt: v.string(),
    storage_id: v.optional(v.id('_storage')),
  },
  handler: (ctx, a) =>
    abandonTicketUpload(ctx, {
      ticketId: a.ticket,
      minter: a.minter,
      attempt: a.attempt,
      storageId: a.storage_id,
    }),
})

/* Every answer allows any origin, as a Convex upload URL does, and is never
 * cached. */
const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'Referrer-Policy': 'no-referrer',
    },
  })

/** The request body's chunks when it holds exactly `size` bytes, else null.
 * It stops reading once the body passes `size`, so a longer body never
 * fills memory, and refuses a body still arriving after `readMs`. */
export async function readExactly(
  request: Request,
  size: number,
  readMs = READ_MS,
): Promise<Uint8Array[] | null> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) !== size) return null
  const body = (request as Request & { body: BodyStream | null }).body
  if (body === null) return size === 0 ? [] : null
  const reader = body.getReader()
  let timer: unknown
  const tooSlow = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(badRequest(UPLOAD_TOO_SLOW)), readMs)
  })
  const read = async (): Promise<Uint8Array[] | null> => {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > size) return null
      chunks.push(value)
    }
    return total === size ? chunks : null
  }
  try {
    return await Promise.race([read(), tooSlow])
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

/* POST /attachment-uploads/{ticket}?e=&m=&t= stores the ticket's file. */
const receive = httpAction(async (ctx, request) => {
  const url = new URL(request.url)
  const ticket = url.pathname.slice(PREFIX.length)
  const minter = url.searchParams.get('m')
  const token = url.searchParams.get('t')
  const exp = Number(url.searchParams.get('e'))
  if (
    ticket === '' ||
    ticket.includes('/') ||
    minter === null ||
    token === null ||
    !(await verifyFileToken({ kind: 'attachment_upload', id: ticket, minter, exp, token }))
  ) {
    return answer(404, { error: UPLOAD_TICKET_MISSING })
  }
  // the confirm refuses a longer media type, and the URL would be spent by
  // then, so this POST is refused before it claims anything
  const type = request.headers.get('Content-Type') ?? ''
  if (overText(LIMITS.mediaType, type.trim())) {
    return answer(400, { error: MEDIA_TYPE_TOO_LONG })
  }
  // this POST's own claim, so cleanup never frees another POST's claim
  const attempt = crypto.randomUUID()
  let storageId: Id<'_storage'> | undefined
  try {
    const { size } = await ctx.runMutation(internal.machine.uploads.begin, {
      ticket,
      minter,
      attempt,
    })
    const chunks = await readExactly(request, size)
    if (chunks === null) throw badRequest(uploadSizeWrong(size))
    storageId = await ctx.storage.store(new Blob(chunks, { type }))
    const kept = await ctx.runMutation(internal.machine.uploads.finish, {
      ticket,
      minter,
      attempt,
      storage_id: storageId,
    })
    // finish deleted the file of a ticket that expired or went meanwhile
    if (!kept) return answer(404, { error: UPLOAD_TICKET_MISSING })
    return answer(200, { storageId })
  } catch (e) {
    // also when begin's answer was lost after it committed the claim
    const stored = await ctx
      .runMutation(internal.machine.uploads.abandon, {
        ticket,
        minter,
        attempt,
        storage_id: storageId,
      })
      .catch(() => null)
    // finish committed but its answer was lost: the file is the ticket's
    if (stored !== null) return answer(200, { storageId: stored })
    if (!(e instanceof ConvexError)) return answer(500, { error: internalError(e) })
    const refusal = e.data as Refusal
    const status = refusal.code === 'not_found' ? 404 : refusal.code === 'conflict' ? 409 : 400
    return answer(status, { error: refusal.message })
  }
})

/* A browser's preflight for the POST, which sends its own Content-Type. */
const preflight = httpAction(
  async () =>
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    }),
)

/** Mounts the upload URL's routes on `http`. */
export function registerUploadRoutes(http: HttpRouter): void {
  http.route({ pathPrefix: PREFIX, method: 'POST', handler: receive })
  http.route({ pathPrefix: PREFIX, method: 'OPTIONS', handler: preflight })
}
