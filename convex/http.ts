import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { httpRouter, makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { internal } from './_generated/api'
import { appOrigins, authComponent, createAuth } from './auth'
import { registerBilling } from './billingHttp'
import { registerDemoReporting } from './demoReportingHttp'
import { isDemoDeployment } from './lib/demo'
import { demoVisitorPlatform } from './lib/demoVisitor'
import { FILE_TOKEN_TTL_SECONDS, type FileTokenKind, verifyFileToken } from './lib/fileTokens'
import { badRequest } from './lib/functions'
import { mcpResource, OAUTH_SCOPES, oauthIssuer } from './lib/oauth'
import {
  manualImageDimensions,
  PANORAMA_MAX_BYTES,
  validateManualImageFile,
} from './lib/panoramaImage'
import { isoWeekForDate } from './lib/panoramaWeeks'
import { answerAfterBody, discardBody, readLimitedBody } from './lib/requestBody'
import { registerCuration } from './machine/curation'
import { registerMcpRoutes } from './machine/mcp'
import { conflictRetrying } from './machine/registry'
import { registerRestRoutes } from './machine/rest'
import { WRITE_CONFLICT, WRITE_CONFLICT_RETRY_AFTER } from './machine/shared'
import { registerUploadRoutes } from './machine/uploads'
import { DEMO_FILE_BYTES } from './model/demoUploads'

const http = httpRouter()
registerBilling(http)
registerDemoReporting(http)
const recordDemoVisitor = makeFunctionReference<
  'mutation',
  { auth_user_id: string; browser: string; os: string }
>('demoVisitor:record')

/* Auth lives at /api/auth/* (OAuth callbacks /api/auth/callback/{microsoft,google}).
 * CORS allowedOrigins are concatenated with Better Auth's trusted origins
 * (SITE_URL plus exact ADDITIONAL_APP_ORIGINS), while the explicit localhost
 * entry preserves the original local dev allowance. */
const createHttpAuth: typeof createAuth = (ctx) => {
  const auth = createAuth(ctx)
  return {
    ...auth,
    handler: async (request: Request) => {
      if (isDemoDeployment()) {
        const path = new URL(request.url).pathname.replace(/\/$/, '')
        const permitted =
          request.method === 'POST'
            ? ['/api/auth/sign-in/anonymous', '/api/auth/sign-out']
            : [
                '/api/auth/get-session',
                '/api/auth/convex/token',
                '/api/auth/convex/jwks',
                '/api/auth/convex/.well-known/openid-configuration',
              ]
        if (!permitted.includes(path))
          return new Response(
            JSON.stringify({ message: 'This feature requires a regular workspace.' }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            },
          )
        if (path === '/api/auth/sign-in/anonymous') {
          const origin = request.headers.get('Origin')
          if (origin !== null && !appOrigins().includes(origin))
            return new Response(null, { status: 403 })
          if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
            return new Response(null, { status: 415 })
          // Enforced before Better Auth allocates any identity, even when the
          // caller goes directly to Convex rather than through our website.
          if (!('runMutation' in ctx) || !(await ctx.runMutation(internal.demoUploads.admit, {})))
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
        }
      }
      const response = await auth.handler(request)
      if (
        isDemoDeployment() &&
        request.method === 'POST' &&
        new URL(request.url).pathname.replace(/\/$/, '') === '/api/auth/sign-in/anonymous' &&
        response.status === 200 &&
        'runMutation' in ctx
      ) {
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
      return response
    },
  }
}
/* The component builds the auth routes itself, so this handler drops the
 * rest of the request body before its answer goes out, as answerAfterBody
 * does for every other route. The component's CORS preflight and its
 * /.well-known/openid-configuration redirect never reach it
 * (lib/requestBody.ts). */
const createHttpAuthAfterBody: typeof createAuth = (ctx) => {
  const auth = createHttpAuth(ctx)
  return {
    ...auth,
    handler: async (request: Request) => {
      try {
        return await auth.handler(request)
      } finally {
        await discardBody(request).catch(() => {})
      }
    },
  }
}
authComponent.registerRoutes(http, createHttpAuthAfterBody, {
  cors: {
    allowedOrigins: isDemoDeployment() ? [] : ['http://localhost:5199'],
    // Demo frontends from before country attribution was removed send this
    // header, for example during a deployment or after a Vercel Instant
    // Rollback. Allowing it keeps their sign-in working; Convex ignores it.
    allowedHeaders: isDemoDeployment() ? ['X-Qivo-Demo-Visitor'] : [],
  },
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
 * and token operations use only the explicit OAuth client credentials. */
const oauthMachineHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
  'Cache-Control': 'no-store',
}
const oauthMachine = answerAfterBody(async (ctx, request) => {
  if (isDemoDeployment()) return new Response(null, { status: 403, headers: oauthMachineHeaders })
  const headers = new Headers(request.headers)
  headers.delete('Cookie')
  headers.delete('Better-Auth-Cookie')
  // the copy takes over the body, so it is the one to drop before answering
  const forwarded = new Request(request, { headers })
  let response: Response
  try {
    response = await createAuth(ctx).handler(forwarded)
  } finally {
    await discardBody(forwarded).catch(() => {})
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
for (const endpoint of ['register', 'token', 'introspect', 'revoke']) {
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
const serverMetadata = answerAfterBody(async (ctx, request) =>
  oauthProviderAuthServerMetadata(createAuth(ctx), { headers: oauthMetadataHeaders })(request),
)
const metadataPreflight = answerAfterBody(
  async () => new Response(null, { status: 204, headers: oauthMetadataHeaders }),
)
for (const path of [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]) {
  http.route({ path, method: 'GET', handler: resourceMetadata })
  http.route({ path, method: 'OPTIONS', handler: metadataPreflight })
}
for (const path of [
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
  kind: Exclude<FileTokenKind, 'attachment_upload' | 'background_upload' | 'demo_upload'>,
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

/* Personal uploads use an owner-bound capability, not Convex's unbound POST
 * URLs followed by a caller-supplied storage id. The receiver stores exactly
 * the validated request body; replay/cancel/expiry/replacement are fenced in
 * one final mutation and unretained bytes are reference-safely discarded. */
declare const Blob: { new (parts: Uint8Array[], options: { type: string }): Blob }

/* An image or demo upload's bytes, at most `maxBytes` and within 30 s, else
 * the refusal that says why (lib/requestBody.ts readLimitedBody). */
async function readBackgroundBody(
  request: Request,
  maxBytes = isDemoDeployment() ? DEMO_FILE_BYTES : PANORAMA_MAX_BYTES,
): Promise<Uint8Array> {
  const read = await readLimitedBody(request, maxBytes, 30_000)
  if (read.outcome === 'read') return read.bytes
  throw badRequest(
    read.outcome === 'missing'
      ? 'Choose an image file to upload.'
      : read.outcome === 'too_slow'
        ? 'The image upload timed out. Try again.'
        : `Choose a file no larger than ${maxBytes / 1024 / 1024} MiB.`,
  )
}

/* The image upload receiver. Its mutations retry write conflicts and time
 * outs like the upload URL's (machine/uploads.ts), and one that outlasts the
 * retries saved nothing and answers 503 with Retry-After. */
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
  let storageId: import('./_generated/dataModel').Id<'_storage'> | undefined
  let startedDemoWork = false
  try {
    await runMutation(internal.appearance.beginDemoUploadWork, { id, minter: m })
    startedDemoWork = isDemoDeployment()
    const mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? ''
    // Validate MIME before reading the body, and size after bounded streaming.
    try {
      validateManualImageFile(mime, 1)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Choose a valid image.')
    }
    const bytes = await readBackgroundBody(request)
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
      headers.set('Retry-After', String(WRITE_CONFLICT_RETRY_AFTER))
      return new Response(
        JSON.stringify({
          error: {
            code: 'conflict',
            message: 'The server was too busy to save the image, and nothing changed. Try again.',
          },
        }),
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
    let storageId: import('./_generated/dataModel').Id<'_storage'> | undefined
    let started = false
    try {
      const ticket = await ctx.runMutation(internal.demoUploads.begin, { id, minter, exp })
      started = true
      const bytes = await readBackgroundBody(request, ticket.maxBytes)
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
      if (started)
        await ctx
          .runMutation(internal.demoUploads.abandon, { id, minter, storage_id: storageId })
          .catch(() => {})
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
 * Each surface registers its own routes from its own file — http.ts only
 * mounts them, once. Requests outside /v1/*, /mcp, /api/auth/*, /files/*,
 * /avatars/*, /backgrounds/*, /background-previews/*, /background-uploads/*,
 * /attachment-uploads/* get Convex's default 404 (a root catch-all would
 * collide with the auth + gateway prefixes — accepted delta). */
registerRestRoutes(http)
registerUploadRoutes(http)
registerCuration(http)
registerMcpRoutes(http)

export default http
