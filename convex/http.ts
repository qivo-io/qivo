/* The one HTTP router. Convex loads it, with every module it imports, for
 * each HTTP action, so none of those modules may load Better Auth, auth.ts
 * or the adapter copy in vendor/convex-better-auth/, because REST, MCP, the
 * file and image links, uploads, billing webhooks, demo reporting and every
 * CORS preflight would pay for it. A handler that needs Better Auth imports
 * ./auth inside the handler, after the refusals that need none, as the
 * sign-in, OAuth machine and metadata handlers below do.
 * convex/tests/authTriggers.test.ts walks this module's static imports, and
 * every deployment's build calls those routes after the push
 * (scripts/auth-probe.mjs). Import a type from ./auth only with
 * `import type`, which loads nothing. */
import { httpRouter, makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { registerBilling } from './billingHttp'
import { registerDemoReporting } from './demoReportingHttp'
import {
  registerAuthRoutes,
  restoreOriginalForwardedHeaders,
  servedAuthRoutes,
  servesAuthRoute,
} from './lib/authRoutes'
import { boundValidationAnswer } from './lib/authValidation'
import { isDemoDeployment } from './lib/demo'
import { demoVisitorPlatform } from './lib/demoVisitor'
import { appOrigins } from './lib/deployment'
import { FILE_TOKEN_TTL_SECONDS, type FileTokenKind, verifyFileToken } from './lib/fileTokens'
import { badRequest } from './lib/functions'
import { AUTH_BODY_MAX_BYTES } from './lib/limits'
import { mcpResource, OAUTH_SCOPES, oauthIssuer } from './lib/oauth'
import { dosTime, type ZipPart, zipCentralRecord, zipEnd, zipLocalHeader } from './lib/orgExport'
import {
  manualImageDimensions,
  PANORAMA_MAX_BYTES,
  validateManualImageFile,
} from './lib/panoramaImage'
import { isoWeekForDate } from './lib/panoramaWeeks'
import { answerAfterBody, bufferedRequest, DISCARD_MS, readLimitedBody } from './lib/requestBody'
import { registerCuration } from './machine/curation'
import { registerMcpRoutes } from './machine/mcp'
import { conflictRetrying } from './machine/registry'
import { registerRestRoutes } from './machine/rest'
import { WRITE_CONFLICT, WRITE_CONFLICT_RETRY_AFTER } from './machine/shared'
import { registerUploadRoutes } from './machine/uploads'

const http = httpRouter()
registerBilling(http)
registerDemoReporting(http)
const recordDemoVisitor = makeFunctionReference<
  'mutation',
  { auth_user_id: string; browser: string; os: string }
>('demoVisitor:record')

/* Why readAuthBody refused a body, with its status, as a Better Auth error
 * code and a message naming the kind of request refused. */
const AUTH_BODY_REFUSALS = {
  too_large: {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: (kind: string) =>
      `The request body is larger than the ${AUTH_BODY_MAX_BYTES / 1024} KiB ${kind} may hold. Shorten what you sent and try again.`,
  },
  too_slow: {
    status: 408,
    code: 'REQUEST_TIMEOUT',
    message: () =>
      `The request took longer than ${DISCARD_MS / 1000} seconds to arrive. Check your connection and try again.`,
  },
} as const

/* Better Auth reads a request body itself, as it arrives and in full, before
 * it decides anything, so every body it gets is read here first: at most
 * AUTH_BODY_MAX_BYTES, within DISCARD_MS, the bound any unauthenticated
 * caller can already hold an answer for (lib/requestBody.ts). This answers
 * the copy that holds the body (bufferedRequest), or the refusal: 413 or 408
 * with a JSON `message` and `code`, as Better Auth's own errors carry them,
 * or for an OAuth client, `error` and `error_description` as OAuth 2.0's
 * do. */
async function readAuthBody(request: Request, oauthClient = false): Promise<Request | Response> {
  const read = await bufferedRequest(request, AUTH_BODY_MAX_BYTES, DISCARD_MS)
  if (read.outcome === 'read') return read.request
  const { status, code, message: messageFor } = AUTH_BODY_REFUSALS[read.outcome]
  const message = messageFor(oauthClient ? 'an authorization server request' : 'a sign-in request')
  return new Response(
    JSON.stringify(
      oauthClient ? { error: 'invalid_request', error_description: message } : { code, message },
    ),
    { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  )
}

/* Auth lives at /api/auth/* (OAuth callbacks /api/auth/callback/{microsoft,google}),
 * registered with its CORS by lib/authRoutes.ts, which builds no Better
 * Auth instance. This answers every GET and POST there. Before it loads
 * Better Auth (auth.ts) it refuses a route Qivo does not serve
 * (lib/authRoutes.ts) and, on the demo, an anonymous sign-in from a foreign
 * origin or without JSON, and then reads the body (readAuthBody), refusing
 * one too large or too slow. None of those refusals pays for loading Better
 * Auth. The demo's admission comes after the import, so neither a body that
 * never arrives nor a failed import takes an admission. An import that
 * fails throws, so the request fails with an error and no session, cookie
 * or token is issued. answerAfterBody drops the rest of the body before any
 * answer goes out, refusals included. A validation error's message is cut
 * to a bounded length (lib/authValidation.ts). */
const authRoute = answerAfterBody(async (ctx, original) => {
  if (!servesAuthRoute(servedAuthRoutes(), original))
    return isDemoDeployment()
      ? new Response(JSON.stringify({ message: 'This feature requires a regular workspace.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      : new Response('Not Found', { status: 404 })
  const anonymous =
    isDemoDeployment() &&
    original.method === 'POST' &&
    new URL(original.url).pathname === '/api/auth/sign-in/anonymous'
  if (anonymous) {
    const origin = original.headers.get('Origin')
    if (origin !== null && !appOrigins().includes(origin))
      return new Response(null, { status: 403 })
    if (!original.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
      return new Response(null, { status: 415 })
  }
  const read = await readAuthBody(original)
  if (read instanceof Response) return read
  const request = restoreOriginalForwardedHeaders(read)
  const { createAuth } = await import('./auth')
  // Enforced before Better Auth allocates any identity, even when the
  // caller goes directly to Convex rather than through our website.
  if (anonymous && !(await ctx.runMutation(internal.demoUploads.admit, {})))
    return new Response(
      JSON.stringify({ message: 'The demo is busy. Please try again shortly.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'Cache-Control': 'no-store',
        },
      },
    )
  const response = await createAuth(ctx).handler(request)
  if (anonymous && response.status === 200) {
    try {
      const body: unknown = JSON.parse(await response.clone().text())
      const user = body && typeof body === 'object' && 'user' in body ? body.user : null
      if (user && typeof user === 'object' && 'id' in user && typeof user.id === 'string') {
        await ctx.runMutation(recordDemoVisitor, {
          auth_user_id: user.id,
          ...demoVisitorPlatform(request.headers.get('User-Agent')),
        })
      }
    } catch {
      // Aggregate marketing metadata is optional. Keep the original auth
      // response and its cookies intact even if recording is unavailable.
    }
  }
  return boundValidationAnswer(response)
})
/* Qivo publishes no OpenID Connect discovery document. Convex checks tokens
 * with the keys at /api/auth/convex/jwks (auth.config.ts), and the OAuth
 * provider's document of this name is not served (lib/authRoutes.ts), so the
 * root location answers 404 too. */
http.route({
  path: '/.well-known/openid-configuration',
  method: 'GET',
  handler: answerAfterBody(async () => new Response('Not Found', { status: 404 })),
})
registerAuthRoutes(http, authRoute, {
  // the local development app, beside the app origins
  allowedOrigins: isDemoDeployment() ? [] : ['http://localhost:5199'],
  // Demo frontends from before country attribution was removed send this
  // header, for example during a deployment or after a Vercel Instant
  // Rollback. Allowing it keeps their sign-in working; Convex ignores it.
  allowedHeaders: isDemoDeployment() ? ['X-Qivo-Demo-Visitor'] : [],
})

/* A dedicated demo can display the main app's approved weekly/default photo
 * without receiving production credentials or workspace data. This feed accepts
 * a date only and reuses the authenticated app's exact display projection. */
const canvasHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}
http.route({
  path: '/public/canvas',
  method: 'GET',
  handler: answerAfterBody(async (ctx, request) => {
    if (isDemoDeployment()) return new Response(null, { status: 404, headers: canvasHeaders })
    const params = new URL(request.url).searchParams
    const dates = params.getAll('date')
    const date = dates[0] ?? ''
    try {
      if (dates.length !== 1 || [...params].some(([key]) => key !== 'date'))
        throw new Error('expected one date')
      isoWeekForDate(date)
    } catch {
      return new Response(JSON.stringify({ error: 'Use one valid date in YYYY-MM-DD format.' }), {
        status: 400,
        headers: canvasHeaders,
      })
    }
    const image = await ctx.runQuery(internal.appearance.publicCanvas, { date })
    return new Response(JSON.stringify(image), { headers: canvasHeaders })
  }),
})
http.route({
  path: '/public/canvas',
  method: 'OPTIONS',
  handler: answerAfterBody(
    async () =>
      new Response(null, { status: isDemoDeployment() ? 404 : 204, headers: canvasHeaders }),
  ),
})

/* Public OAuth clients may run on any browser origin. These machine
 * endpoints receive public CORS; authorization and consent keep the app's
 * existing session rules. Ignore ambient/session cookies here so registration
 * and token operations use only the explicit OAuth client credentials.
 * Registration also ignores an Authorization header: Better Auth 1.7 reads a
 * Bearer token there as an RFC 7591 initial access token, which Qivo does not
 * issue, and would refuse the open registration with 401. Better Auth
 * (auth.ts) loads only after the demo's refusal and the body read, so
 * neither pays for it, and an import that fails fails the request. */
const oauthMachineHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
  'Cache-Control': 'no-store',
}
const oauthMachine = answerAfterBody(async (ctx, request) => {
  if (isDemoDeployment()) return new Response(null, { status: 403, headers: oauthMachineHeaders })
  const read = await readAuthBody(request, true)
  let response: Response
  if (read instanceof Response) response = read
  else {
    const headers = new Headers(read.headers)
    headers.delete('Cookie')
    headers.delete('Better-Auth-Cookie')
    if (new URL(read.url).pathname.endsWith('/oauth2/register')) headers.delete('Authorization')
    const { createAuth } = await import('./auth')
    response = await boundValidationAnswer(
      await createAuth(ctx).handler(new Request(read, { headers })),
    )
  }
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete('Set-Cookie')
  responseHeaders.delete('Set-Better-Auth-Cookie')
  responseHeaders.delete('Access-Control-Allow-Credentials')
  for (const [name, value] of Object.entries(oauthMachineHeaders)) responseHeaders.set(name, value)
  return new Response(await response.text(), {
    status: response.status,
    headers: responseHeaders,
  })
})
const oauthMachinePreflight = answerAfterBody(
  async () => new Response(null, { status: 204, headers: oauthMachineHeaders }),
)
for (const endpoint of ['register', 'token', 'revoke']) {
  const path = `/api/auth/oauth2/${endpoint}`
  http.route({ path, method: 'POST', handler: oauthMachine })
  http.route({ path, method: 'OPTIONS', handler: oauthMachinePreflight })
}

const oauthMetadataHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=300',
}
const resourceMetadata = answerAfterBody(
  async () =>
    new Response(
      JSON.stringify({
        resource: mcpResource(),
        authorization_servers: [oauthIssuer()],
        scopes_supported: OAUTH_SCOPES.filter((scope) => scope !== 'offline_access'),
        bearer_methods_supported: ['header'],
      }),
      { headers: oauthMetadataHeaders },
    ),
)
/* The authorization server metadata, from Better Auth, which this handler
 * loads (auth.ts authServerMetadata). Its preflight needs none. */
const serverMetadata = answerAfterBody(async (ctx, request) =>
  (await import('./auth')).authServerMetadata(ctx, request, oauthMetadataHeaders),
)
const metadataPreflight = answerAfterBody(
  async () => new Response(null, { status: 204, headers: oauthMetadataHeaders }),
)
/* The demo has no authorization server (auth.ts) and accepts no MCP
 * credential, so it serves no OAuth metadata, and its MCP endpoint names none
 * (machine/mcp.ts). */
for (const path of isDemoDeployment()
  ? []
  : ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
  http.route({ path, method: 'GET', handler: resourceMetadata })
  http.route({ path, method: 'OPTIONS', handler: metadataPreflight })
}
for (const path of isDemoDeployment()
  ? []
  : [
      '/.well-known/oauth-authorization-server/api/auth',
      '/.well-known/oauth-authorization-server',
    ]) {
  http.route({ path, method: 'GET', handler: serverMetadata })
  http.route({ path, method: 'OPTIONS', handler: metadataPreflight })
}

/* ----------------------------------- /files + /avatars + /backgrounds gateway
 *
 *   GET /files/<attachment uuid>?e=<exp>&m=<minter profile uuid>&t=<mac>[&download=1]
 *   GET /avatars/<profile uuid>?e=<exp>&m=<minter auth-user id>&t=<mac>&v=<storage id>
 *   GET /background-previews/<image uuid>?e=<exp>&m=<owner auth-user id>&t=<mac>
 *   GET /backgrounds/<image uuid>?e=<exp>&m=<owner auth-user id>&t=<mac>
 *
 * The organization export's /exports/ route below shares these headers,
 * this 404 and the preflight.
 *
 * The MAC (lib/fileTokens: HMAC-SHA256 over kind/uuid/minter/exp, key derived
 * from BETTER_AUTH_SECRET) admits the request; the MINTER's access is then
 * RE-CHECKED per request (files.gatewayAttachment / gatewayAvatar) — exp only
 * bounds the forwarded-link window, revocation bites on the next fetch. `v`
 * on avatars is pure cache-busting; lookup ignores it.
 *
 * Security posture — this origin ALSO carries the Better Auth cookies, so
 * nothing served here may ever run as active content: inline Content-Type
 * only for the image allowlist, everything else (SVG and text/html included)
 * is application/octet-stream + attachment disposition; nosniff and the
 * no-src sandbox CSP go on EVERY response, refusals included. All failure
 * paths — malformed, tampered, expired, invisible, missing — answer one
 * uniform 404 (no existence oracle, no 401-vs-404 split). */

const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']

/* <img> tags are no-cors, but imgActions' fetch(url) (copy/download) and the
 * smoke's byte asserts are cross-origin reads from the app origin. Origin-echo
 * against the configured exact app origins — never `*` — keeps any future
 * cookie-authenticated fallback from requiring a CORS redesign. */
const corsOrigin = (origin: string | null): string | null => {
  if (origin === null) return null
  const allowed = new Set([
    ...(isDemoDeployment() ? [] : ['http://localhost:5199']),
    ...appOrigins(),
  ])
  return allowed.has(origin) ? origin : null
}

/* On every gateway response, 404s included. */
const gatewayHeaders = (origin: string | null): Headers => {
  const h = new Headers()
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('Content-Security-Policy', "default-src 'none'; sandbox")
  h.set('Vary', 'Origin')
  const echo = corsOrigin(origin)
  if (echo !== null) {
    h.set('Access-Control-Allow-Origin', echo)
    // Content-Disposition is not CORS-safelisted; without this the app origin
    // (and the smoke gate) could never verify a download's filename from JS
    h.set('Access-Control-Expose-Headers', 'Content-Disposition')
  }
  return h
}

/* RFC 6266: quoted ASCII fallback + RFC 5987 filename*=UTF-8''… (the
 * createSignedUrl {download: rec.name} successor — the row keeps the real
 * name; the storage key never had one). */
const attachmentDisposition = (name: string): string => {
  const fallback = name.replace(/[\\"]/g, '_').replace(/[^\x20-\x7e]/g, '?')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

const serve = (
  kind: Exclude<
    FileTokenKind,
    'attachment_upload' | 'background_upload' | 'demo_upload' | 'org_export'
  >,
  prefix: string,
) =>
  answerAfterBody(async (ctx, request) => {
    const url = new URL(request.url)
    const headers = gatewayHeaders(request.headers.get('Origin'))
    const refuse = (): Response => {
      headers.set('Cache-Control', 'no-store')
      return new Response(null, { status: 404, headers })
    }
    const id = url.pathname.slice(prefix.length)
    const e = url.searchParams.get('e')
    const m = url.searchParams.get('m')
    const t = url.searchParams.get('t')
    if (id === '' || id.includes('/') || e === null || m === null || t === null) return refuse()
    const exp = Number(e)
    // one answer for tampered/expired/malformed alike
    if (!(await verifyFileToken({ kind, id, minter: m, exp, token: t }))) return refuse()
    const rec =
      kind === 'attachment'
        ? await ctx.runQuery(internal.files.gatewayAttachment, { id, minter: m })
        : kind === 'avatar'
          ? await ctx.runQuery(internal.files.gatewayAvatar, { id, minter: m })
          : await ctx.runQuery(internal.appearance.gatewayCustom, {
              id,
              minter: m,
              preview: kind === 'background_preview',
            })
    if (rec === null) return refuse()
    const blob = await ctx.storage.get(rec.storage_id)
    if (blob === null) return refuse()
    // _storage.contentType (= blob.type; '' when the upload POST had no
    // header) → the row's mime → octet-stream; inline ONLY from the allowlist
    const stored = blob.type !== '' ? blob.type : (rec.mime ?? '')
    const inlineOk = INLINE_TYPES.includes(stored)
    const download = url.searchParams.get('download') === '1'
    headers.set('Content-Type', inlineOk ? stored : 'application/octet-stream')
    headers.set(
      'Content-Disposition',
      inlineOk && !download ? 'inline' : attachmentDisposition(rec.name),
    )
    // private (token-gated), capped at the token's REMAINING life; immutable
    // is honest — an attachment uuid's bytes never change (storage_id is
    // fixed at attach; avatar URLs re-key via v=<storage id>)
    const remaining = Math.min(
      Math.max(Math.floor(exp - Date.now() / 1000), 0),
      FILE_TOKEN_TTL_SECONDS,
    )
    headers.set(
      'Cache-Control',
      isDemoDeployment() || kind === 'background' || kind === 'background_preview'
        ? 'private, no-store'
        : `private, max-age=${remaining}, immutable`,
    )
    if (kind === 'background' || kind === 'background_preview')
      headers.set('Referrer-Policy', 'no-referrer')
    return new Response(blob, { status: 200, headers })
  })

/* Plain GETs never preflight (no custom headers, simple method), but answer
 * OPTIONS anyway so any future fetch() variant fails soft, not weird. */
const preflight = answerAfterBody(async (_ctx, request) => {
  const headers = gatewayHeaders(request.headers.get('Origin'))
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  headers.set('Access-Control-Max-Age', '86400')
  const asked = request.headers.get('Access-Control-Request-Headers')
  if (asked !== null) headers.set('Access-Control-Allow-Headers', asked)
  return new Response(null, { status: 204, headers })
})

http.route({ pathPrefix: '/files/', method: 'GET', handler: serve('attachment', '/files/') })
http.route({ pathPrefix: '/files/', method: 'OPTIONS', handler: preflight })
http.route({ pathPrefix: '/avatars/', method: 'GET', handler: serve('avatar', '/avatars/') })
http.route({ pathPrefix: '/avatars/', method: 'OPTIONS', handler: preflight })
http.route({
  pathPrefix: '/backgrounds/',
  method: 'GET',
  handler: serve('background', '/backgrounds/'),
})
http.route({ pathPrefix: '/backgrounds/', method: 'OPTIONS', handler: preflight })
http.route({
  pathPrefix: '/background-previews/',
  method: 'GET',
  handler: serve('background_preview', '/background-previews/'),
})
http.route({ pathPrefix: '/background-previews/', method: 'OPTIONS', handler: preflight })

/* ------------------------------------------------- /exports/ download route
 *
 *   GET /exports/<export uuid>?e=<exp>&m=<minter admin profile document id>&t=<mac>
 *
 * A ready organization export as one ZIP (lib/orgExport.ts), for the link
 * orgExport.claimDownload answers an admin: an org_export token, which no
 * other route accepts and which opens no other route, minted for the
 * export's id and the admin's profile document, valid model/orgExports.ts
 * DELIVERY.tokenSeconds. The MAC admits the request; deliveryOf then checks
 * that the minter is still an active admin of the job's organization, that
 * the job is ready and unexpired, that the organization's deletion and a
 * public demo's cleanup have not begun and that the archive's parts are all
 * there. A damaged archive fails its job (failDelivery). The download then
 * takes a lease (leaseDelivery, DELIVERY.streams a job and
 * DELIVERY.demoStreams on the demo), else 429 with Retry-After, which only
 * an admin who passed every check sees. Every other refusal is the
 * gateway's one 404, so the route says nothing of which check failed or
 * whether an export exists. Every answer carries the gateway's headers:
 * nosniff, the sandbox CSP and the app-origin echo, never `*` and with no
 * credentials, so the archive never runs as content on this origin, which
 * carries the sign-in cookies. The archive holds no file contents and the
 * route grants nothing else. */

/* What deliveryOf answers for an archive the route may serve. */
type Delivery = {
  completed_at: string
  slice: number
  parts: (ZipPart & { storage_id: Id<'_storage'> })[]
}

/**
 * A ready archive as one ZIP body, read only when its reader pulls (a
 * ReadableStream, as Convex recommends for answers past an HTTP action's
 * 64 MiB of memory): for each part in seq order its local header, then its
 * stored file from storage in slices of at most `slice` bytes, holding one
 * part's file at a time, then the central directory and its end record.
 * Before each part it checks the admin again (canDeliver), and it checks
 * each file's size against the part's stored_bytes. A refusal, a file that
 * is gone (failDelivery then ends a job still ready) or a size that
 * differs errors the body, which stops short of its Content-Length, so the
 * browser reports a failed download and no ZIP looks whole. Once the
 * reader took the end record's last slice, the next pull records the
 * delivery in the job's served_at (recordDelivery), which also ends its
 * lease, and closes the body; a failed record is logged, changes no byte
 * and releases the lease. A body that errors and a reader that cancels
 * stop the reads, record nothing and release the lease.
 *
 * The reader is the Convex runtime, not the client. On a local backend
 * (precompiled-2026-10-22, 6 November 2026) it pulled an 11 MB body as fast
 * as storage gave it, whatever the client took: a download curl stopped
 * after 18 KB was recorded within a second of its start, its lease ended
 * then, and a file erased three seconds into a download no longer stopped
 * it. So the record says that the backend read the whole archive into the
 * response, not that the client received it, and it leaves
 * organizations.last_export_at, which the deletion reminder reads, alone.
 * The per-part checks and the lease cover that read too, not the client's
 * transfer. Convex documents at most 30 minutes for an action; whether a
 * slow client's transfer counts toward it was not measured.
 */
function archiveStream(
  ctx: ActionCtx,
  archive: Delivery,
  link: { export_id: string; minter: string; exp: number },
  stream: string,
): ReadableStream<Uint8Array> {
  const runMutation = conflictRetrying(ctx)
  const dos = dosTime(archive.completed_at)
  const directory: Uint8Array[] = []
  // the part next to send, the bytes sent so far, and the bytes of the
  // current file or of the directory still to hand over
  let next = 0
  let offset = 0
  let pending: Uint8Array | null = null
  let at = 0
  let tail = false
  const release = () =>
    runMutation(internal.orgExport.releaseDelivery, { export_id: link.export_id, stream }).catch(
      (error: unknown) => console.warn('An export download kept its lease', { error }),
    )
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pending !== null && at < pending.length) {
          const slice = pending.subarray(at, at + archive.slice)
          at += slice.length
          controller.enqueue(slice)
          return
        }
        if (next < archive.parts.length) {
          const part = archive.parts[next]
          if (!(await ctx.runQuery(internal.orgExport.canDeliver, link)))
            throw new Error('the export is no longer deliverable')
          const blob = await ctx.storage.get(part.storage_id)
          if (blob === null) {
            await runMutation(internal.orgExport.failDelivery, { export_id: link.export_id })
            throw new Error(`the file of ${part.entry} is gone`)
          }
          if (blob.size !== part.stored_bytes)
            throw new Error(`the file of ${part.entry} is not its stored size`)
          const header = zipLocalHeader(part, dos)
          directory.push(zipCentralRecord(part, offset, dos))
          offset += header.length + part.stored_bytes
          pending = new Uint8Array(await blob.arrayBuffer())
          at = 0
          next += 1
          controller.enqueue(header)
          return
        }
        if (!tail) {
          tail = true
          const size = directory.reduce((sum, record) => sum + record.length, 0)
          const end = zipEnd(archive.parts.length, size, offset)
          pending = new Uint8Array(size + end.length)
          let write = 0
          for (const record of directory) {
            pending.set(record, write)
            write += record.length
          }
          pending.set(end, write)
          directory.length = 0
          at = Math.min(archive.slice, pending.length)
          controller.enqueue(pending.subarray(0, at))
          return
        }
        // the reader, the runtime, took the last slice
        pending = null
        await runMutation(internal.orgExport.recordDelivery, {
          export_id: link.export_id,
          stream,
        }).catch(async (error: unknown) => {
          console.error('A served export was not recorded', { export_id: link.export_id, error })
          // the record ends the lease, so without it the lease would hold
          // for DELIVERY.streamMs
          await release()
        })
        controller.close()
      } catch (error) {
        pending = null
        console.warn('An export download stopped short', { export_id: link.export_id, error })
        await release()
        controller.error(error)
      }
    },
    async cancel() {
      pending = null
      await release()
    },
  })
}

const EXPORTS = '/exports/'

const serveExport = answerAfterBody(async (ctx, request) => {
  const url = new URL(request.url)
  const headers = gatewayHeaders(request.headers.get('Origin'))
  const refuse = (status = 404): Response => {
    headers.set('Cache-Control', 'no-store')
    return new Response(null, { status, headers })
  }
  const id = url.pathname.slice(EXPORTS.length)
  const e = url.searchParams.get('e')
  const m = url.searchParams.get('m')
  const t = url.searchParams.get('t')
  if (id === '' || id.includes('/') || e === null || m === null || t === null) return refuse()
  const exp = Number(e)
  // one answer for tampered, expired, malformed and other kinds alike
  if (!(await verifyFileToken({ kind: 'org_export', id, minter: m, exp, token: t })))
    return refuse()
  const link = { export_id: id, minter: m, exp }
  const runMutation = conflictRetrying(ctx)
  const archive = await ctx.runQuery(internal.orgExport.deliveryOf, link)
  if (archive === null) return refuse()
  if ('missing' in archive) {
    await runMutation(internal.orgExport.failDelivery, { export_id: id }).catch((error: unknown) =>
      console.error('A damaged export was not failed', { export_id: id, error }),
    )
    return refuse()
  }
  let lease: { stream: string } | { busy: true; retry_after: number } | null
  try {
    lease = await runMutation(internal.orgExport.leaseDelivery, link)
  } catch (error) {
    // the lease kept conflicting with other downloads' leases
    if (!(error instanceof ConvexError) || error.data?.reason !== WRITE_CONFLICT) throw error
    lease = { busy: true, retry_after: WRITE_CONFLICT_RETRY_AFTER }
  }
  if (lease === null) return refuse()
  if ('busy' in lease) {
    headers.set('Retry-After', String(lease.retry_after))
    return refuse(429)
  }
  headers.set('Content-Type', 'application/zip')
  headers.set('Content-Disposition', attachmentDisposition(archive.name))
  headers.set('Content-Length', String(archive.bytes))
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  return new Response(archiveStream(ctx, archive, link, lease.stream), { status: 200, headers })
})

http.route({ pathPrefix: EXPORTS, method: 'GET', handler: serveExport })
http.route({ pathPrefix: EXPORTS, method: 'OPTIONS', handler: preflight })

/* Personal uploads use an owner-bound capability, not Convex's unbound POST
 * URLs followed by a caller-supplied storage id. The receiver stores exactly
 * the validated request body; replay/cancel/expiry/replacement are fenced in
 * one final mutation and unretained bytes are reference-safely discarded. */
declare const Blob: { new (parts: Uint8Array[], options: { type: string }): Blob }

/* An image or demo upload's bytes, at most `maxBytes` and within 30 s, else
 * the refusal that says why (lib/requestBody.ts readLimitedBody). A longer
 * body is refused with `tooLarge`, the demo reservation's own sentence
 * (model/demoUploads.ts demoBodyRefusal), or one that names `maxBytes`. */
async function readBackgroundBody(
  request: Request,
  maxBytes: number,
  tooLarge = `Choose a file no larger than ${maxBytes / 1024 / 1024} MiB.`,
): Promise<Uint8Array> {
  const read = await readLimitedBody(request, maxBytes, 30_000)
  if (read.outcome === 'read') return read.bytes
  throw badRequest(
    read.outcome === 'missing'
      ? 'Choose an image file to upload.'
      : read.outcome === 'too_slow'
        ? 'The image upload timed out. Try again.'
        : tooLarge,
  )
}

/* The answer for an image upload whose write kept conflicting or timing
 * out. The app cancels a failed upload's ticket, so its next step is a new
 * upload. */
const BACKGROUND_UPLOAD_BUSY =
  'The server was too busy to save the image, and nothing changed. Choose the image again.'

/* The image upload receiver. Its mutations retry write conflicts and time
 * outs like the upload URL's (machine/uploads.ts), and one that outlasts the
 * retries saved nothing and answers 503. Outside the demo the URL still
 * works, so the answer carries Retry-After. */
const receiveBackground = answerAfterBody(async (ctx, request) => {
  const headers = gatewayHeaders(request.headers.get('Origin'))
  if (headers.get('Access-Control-Allow-Origin') !== null)
    headers.set('Access-Control-Expose-Headers', 'Retry-After')
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Type', 'application/json')
  headers.set('Referrer-Policy', 'no-referrer')
  const refuse = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'not_found',
          message: 'This upload link expired or was cancelled. Choose the image again.',
        },
      }),
      { status: 404, headers },
    )
  // This browser-only upload grants mutation authority; unlike read-only img
  // tags, an explicit foreign Origin is rejected even with a valid ticket.
  const origin = request.headers.get('Origin')
  if (origin !== null && corsOrigin(origin) === null) return refuse()
  const url = new URL(request.url)
  const id = url.pathname.slice('/background-uploads/'.length)
  const e = url.searchParams.get('e'),
    m = url.searchParams.get('m'),
    t = url.searchParams.get('t')
  if (!id || id.includes('/') || e === null || m === null || t === null) return refuse()
  const exp = Number(e)
  if (!(await verifyFileToken({ kind: 'background_upload', id, minter: m, exp, token: t })))
    return refuse()
  if (!(await ctx.runQuery(internal.appearance.uploadContext, { id, minter: m, exp })))
    return refuse()
  const runMutation = conflictRetrying(ctx)
  let storageId: Id<'_storage'> | undefined
  let startedDemoWork = false
  try {
    // the demo's reservation bounds the body; elsewhere the image limit does
    const demoWork = await runMutation(internal.appearance.beginDemoUploadWork, { id, minter: m })
    startedDemoWork = isDemoDeployment()
    const mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? ''
    // Validate MIME before reading the body, and size after bounded streaming.
    try {
      validateManualImageFile(mime, 1)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Choose a valid image.')
    }
    const bytes = await readBackgroundBody(
      request,
      demoWork?.maxBytes ?? PANORAMA_MAX_BYTES,
      demoWork?.tooLarge,
    )
    let dimensions: { width: number; height: number }
    try {
      dimensions = manualImageDimensions(bytes, mime)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Choose a valid image.')
    }
    storageId = await ctx.storage.store(new Blob([bytes], { type: mime }))
    const settings = await runMutation(internal.appearance.finalizeUpload, {
      ticket_id: id,
      minter: m,
      storage_id: storageId,
      ...dimensions,
    })
    return new Response(JSON.stringify(settings), { status: 200, headers })
  } catch (error) {
    if (startedDemoWork)
      await runMutation(internal.demoUploads.abandon, {
        id,
        minter: m,
        storage_id: storageId,
      }).catch(() => {})
    if (storageId)
      await runMutation(internal.appearance.discardUpload, { storage_id: storageId }).catch(
        () => {},
      )
    const data =
      error instanceof ConvexError
        ? (error.data as { code?: string; message?: string; reason?: string })
        : null
    if (data?.reason === WRITE_CONFLICT) {
      // the demo's cleanup spent the URL's reservation, so only a new
      // upload can work there
      if (!startedDemoWork) headers.set('Retry-After', String(WRITE_CONFLICT_RETRY_AFTER))
      return new Response(
        JSON.stringify({ error: { code: 'conflict', message: BACKGROUND_UPLOAD_BUSY } }),
        { status: 503, headers },
      )
    }
    const code = data?.code ?? 'bad_request'
    const message = data?.message ?? 'The image upload failed. Choose the file again.'
    return new Response(JSON.stringify({ error: { code, message } }), {
      status: code === 'conflict' ? 409 : code === 'not_found' || code === 'forbidden' ? 404 : 400,
      headers,
    })
  }
})

http.route({ pathPrefix: '/background-uploads/', method: 'POST', handler: receiveBackground })
http.route({
  pathPrefix: '/background-uploads/',
  method: 'OPTIONS',
  handler: answerAfterBody(async (_ctx, request) => {
    const headers = gatewayHeaders(request.headers.get('Origin'))
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type')
    headers.set('Access-Control-Max-Age', '86400')
    return new Response(null, { status: 204, headers })
  }),
})

http.route({
  pathPrefix: '/demo-uploads/',
  method: 'POST',
  handler: answerAfterBody(async (ctx, request) => {
    const headers = gatewayHeaders(request.headers.get('Origin'))
    headers.set('Cache-Control', 'no-store')
    headers.set('Content-Type', 'application/json')
    const refuse = () =>
      new Response(JSON.stringify({ error: 'This upload has expired.' }), { status: 404, headers })
    if (!isDemoDeployment()) return refuse()
    const origin = request.headers.get('Origin')
    if (origin !== null && corsOrigin(origin) === null) return refuse()
    const url = new URL(request.url)
    const id = url.pathname.slice('/demo-uploads/'.length)
    const minter = url.searchParams.get('m'),
      token = url.searchParams.get('t'),
      exp = Number(url.searchParams.get('e'))
    if (
      !id ||
      id.includes('/') ||
      !minter ||
      !token ||
      !(await verifyFileToken({ kind: 'demo_upload', id, minter, token, exp }))
    )
      return refuse()
    let storageId: Id<'_storage'> | undefined
    let started = false
    try {
      const ticket = await ctx.runMutation(internal.demoUploads.begin, { id, minter, exp })
      started = true
      const bytes = await readBackgroundBody(request, ticket.maxBytes, ticket.tooLarge)
      const mime =
        request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ||
        'application/octet-stream'
      storageId = await ctx.storage.store(new Blob([bytes], { type: mime }))
      const result = await ctx.runMutation(internal.demoUploads.finish, {
        id,
        minter,
        storage_id: storageId,
      })
      return new Response(JSON.stringify(result), { status: 200, headers })
    } catch (error) {
      const stored = started
        ? await ctx
            .runMutation(internal.demoUploads.abandon, { id, minter, storage_id: storageId })
            .catch(() => null)
        : null
      // finish committed but its answer was lost, so the file is the upload's
      if (stored !== null)
        return new Response(JSON.stringify({ storageId: stored }), { status: 200, headers })
      const data = error instanceof ConvexError ? (error.data as { message?: string }) : null
      return new Response(
        JSON.stringify({ error: data?.message ?? 'The upload failed. Try again.' }),
        { status: 400, headers },
      )
    }
  }),
})
http.route({
  pathPrefix: '/demo-uploads/',
  method: 'OPTIONS',
  handler: answerAfterBody(async (_ctx, request) => {
    const headers = gatewayHeaders(request.headers.get('Origin'))
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type')
    return new Response(null, { status: 204, headers })
  }),
})

/* ------------------------------------------------ machine surfaces (phase 8)
 * Each surface registers its own routes from its own file, and http.ts only
 * mounts them, once. Their modules load no Better Auth either, so a REST or
 * MCP call pays nothing for sign-in (authTriggers.test.ts). Requests outside
 * /v1/*, /mcp, /api/auth/*, /files/*, /avatars/*, /backgrounds/*,
 * /background-previews/*, /exports/*, /background-uploads/*, /attachment-uploads/* get
 * Convex's default 404, because a root catch-all would collide with the auth
 * and gateway prefixes (an accepted difference). */
registerRestRoutes(http)
registerUploadRoutes(http)
registerCuration(http)
registerMcpRoutes(http)

export default http
