/* The receiver of the upload URL that REST's POST /v1/tasks/{ref}/attachments
 * and MCP's start_attachment_upload answer (model/attachments.ts
 * startAttachmentUpload). The URL names its ticket and carries a file token
 * for it (lib/fileTokens.ts attachmentUploadUrl), so it needs no credential,
 * like the Convex upload URL it replaces. Unlike that URL, it stores at most
 * one file: the first POST claims the ticket (beginTicketUpload), and every
 * later POST is refused before anything is read. The receiver reads exactly
 * the declared number of bytes, stores them and records the file on the
 * ticket (finishTicketUpload), which the confirm call then must name. A POST
 * that fails stores nothing and frees the URL for another try
 * (abandonTicketUpload).
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
import type { Refusal } from '../lib/functions'
import { badRequest } from '../lib/functions'
import {
  abandonTicketUpload,
  beginTicketUpload,
  finishTicketUpload,
  UPLOAD_TICKET_MISSING,
  uploadSizeWrong,
} from '../model/attachments'
import { internalError } from './shared'

const PREFIX = '/attachment-uploads/'

/* The Convex runtime's Blob, which convex/tsconfig's ESNext lib does not
 * declare. */
declare const Blob: { new (parts: Uint8Array[], options: { type: string }): Blob }
type BodyStream = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
  }
}

/* Claims the ticket's one POST (model/attachments.ts beginTicketUpload). */
export const begin = internalMutation({
  args: { ticket: v.string(), minter: v.string() },
  handler: (ctx, a) =>
    beginTicketUpload(ctx, { ticketId: a.ticket, minter: a.minter, nowMs: Date.now() }),
})

/* Records the stored file on the ticket, or deletes it
 * (model/attachments.ts finishTicketUpload). */
export const finish = internalMutation({
  args: { ticket: v.string(), minter: v.string(), storage_id: v.id('_storage') },
  handler: (ctx, a) =>
    finishTicketUpload(ctx, {
      ticketId: a.ticket,
      minter: a.minter,
      storageId: a.storage_id,
      nowMs: Date.now(),
    }),
})

/* Frees the ticket after a failed POST (model/attachments.ts
 * abandonTicketUpload). */
export const abandon = internalMutation({
  args: { ticket: v.string(), minter: v.string(), storage_id: v.optional(v.id('_storage')) },
  handler: (ctx, a) =>
    abandonTicketUpload(ctx, { ticketId: a.ticket, minter: a.minter, storageId: a.storage_id }),
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

/* The request body's chunks when it holds exactly `size` bytes, else null.
 * It stops reading once the body passes `size`, so a longer body never
 * fills memory. */
async function readExactly(request: Request, size: number): Promise<Uint8Array[] | null> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) !== size) return null
  const body = (request as Request & { body: BodyStream | null }).body
  if (body === null) return size === 0 ? [] : null
  const reader = body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let read = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      read += value.byteLength
      if (read > size) return null
      chunks.push(value)
    }
    return read === size ? chunks : null
  } finally {
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
  let storageId: Id<'_storage'> | undefined
  let claimed = false
  try {
    const { size } = await ctx.runMutation(internal.machine.uploads.begin, { ticket, minter })
    claimed = true
    const chunks = await readExactly(request, size)
    if (chunks === null) throw badRequest(uploadSizeWrong(size))
    const type = request.headers.get('Content-Type') ?? ''
    storageId = await ctx.storage.store(new Blob(chunks, { type }))
    const kept = await ctx.runMutation(internal.machine.uploads.finish, {
      ticket,
      minter,
      storage_id: storageId,
    })
    // finish deleted the file of a ticket that expired or went meanwhile
    if (!kept) return answer(404, { error: UPLOAD_TICKET_MISSING })
    return answer(200, { storageId })
  } catch (e) {
    if (claimed) {
      await ctx
        .runMutation(internal.machine.uploads.abandon, { ticket, minter, storage_id: storageId })
        .catch(() => {})
    }
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
