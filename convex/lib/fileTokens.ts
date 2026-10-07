/* Short-lived file-token minting and verification for the storage gateway.
 *
 * Token: base64url(HMAC-SHA256(key, 'qivo-files-v1:{kind}:{uuid}:{minter}:{exp}'))
 * where `minter` is the caller's profile uuid (attachments) or auth-user id
 * (avatars/personal backgrounds) and `exp` is unix SECONDS. The gateway re-checks the MINTER's
 * access per request — exp only bounds the forwarded-link window.
 *
 * Key: DERIVED from BETTER_AUTH_SECRET with a domain-separation label
 * (key material = SHA-256(secret + ':qivo-files-token-v1')), never the raw
 * secret — a files-token oracle can't be turned against sessions, and no
 * extra env var can be forgotten on fresh dev/preview deployments
 * (BETTER_AUTH_SECRET is already mandatory-or-auth-refuses-to-boot).
 *
 * Web Crypto only — this runs in the V8 isolate (mintUrls query + the
 * /files//avatars gateway) and in edge-runtime under vitest. Deterministic
 * given key+message, so legal inside a query. The separate background_upload
 * kind authorizes only a short-lived, single-use owner-bound upload ticket. */

export const FILE_TOKEN_TTL_SECONDS = 600
/* Client re-mint skew: a cached URL within this window of exp is stale. */
export const FILE_TOKEN_SKEW_MS = 120_000

export type FileTokenKind =
  | 'attachment'
  | 'avatar'
  | 'background'
  | 'background_preview'
  | 'background_upload'
  | 'demo_upload'

const KEY_LABEL = ':qivo-files-token-v1'

/* Web Crypto globals: present in the isolate and in edge-runtime, but
 * convex/tsconfig's lib is ESNext only, which does not declare them. */
declare class TextEncoder {
  encode(input: string): Uint8Array
}
declare const crypto: {
  subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
    importKey(
      format: string,
      keyData: ArrayBuffer,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      keyUsages: string[],
    ): Promise<unknown>
    sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
    verify(
      algorithm: string,
      key: unknown,
      signature: Uint8Array,
      data: Uint8Array,
    ): Promise<boolean>
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const toBase64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64URL[a >> 2]
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += B64URL[c & 63]
  }
  return out
}

/* null on any malformed input — the gateway answers 404, never throws. */
const fromBase64url = (s: string): Uint8Array | null => {
  if (s.length % 4 === 1) return null
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of s) {
    const idx = B64URL.indexOf(ch)
    if (idx === -1) return null
    buffer = ((buffer << 6) | idx) >>> 0
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

const resolveSecret = (override?: string): string => {
  const secret = override ?? process.env.BETTER_AUTH_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('BETTER_AUTH_SECRET is not set — file tokens cannot be minted')
  }
  return secret
}

/* One derived HMAC key per secret per isolate (importKey is not free). */
const keyCache = new Map<string, Promise<unknown>>()

const hmacKey = (secret: string): Promise<unknown> => {
  let cached = keyCache.get(secret)
  if (cached === undefined) {
    cached = (async () => {
      const material = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(secret + KEY_LABEL),
      )
      return await crypto.subtle.importKey(
        'raw',
        material,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      )
    })()
    keyCache.set(secret, cached)
  }
  return cached
}

const message = (p: { kind: FileTokenKind; id: string; minter: string; exp: number }): Uint8Array =>
  new TextEncoder().encode(`qivo-files-v1:${p.kind}:${p.id}:${p.minter}:${p.exp}`)

export async function mintFileToken(p: {
  kind: FileTokenKind
  id: string
  minter: string
  exp: number
  secret?: string
}): Promise<string> {
  const key = await hmacKey(resolveSecret(p.secret))
  return toBase64url(await crypto.subtle.sign('HMAC', key, message(p)))
}

/* MAC (constant-time, via subtle.verify) AND expiry in one answer — the
 * gateway's single check; false covers tampered, expired and malformed alike
 * (one 404, no existence oracle). `now` is injectable for tests. */
export async function verifyFileToken(p: {
  kind: FileTokenKind
  id: string
  minter: string
  exp: number
  token: string
  now?: number
  secret?: string
}): Promise<boolean> {
  const nowMs = p.now ?? Date.now()
  if (!Number.isFinite(p.exp) || p.exp * 1000 <= nowMs) return false
  const sig = fromBase64url(p.token)
  if (sig === null || sig.length !== 32) return false
  const key = await hmacKey(resolveSecret(p.secret))
  return await crypto.subtle.verify('HMAC', key, sig, message(p))
}

/* Server-built absolute URLs (the deployment knows its own site origin;
 * prod maps it to api.qivo.io). The token covers kind/uuid/minter/exp only —
 * the client may append &download=1 to a cached attachment URL freely. */
const siteUrl = (): string => {
  const url = process.env.CONVEX_SITE_URL
  if (url === undefined || url === '') {
    throw new Error('CONVEX_SITE_URL is not set — file URLs cannot be built')
  }
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export function attachmentFileUrl(p: {
  id: string
  minter: string
  exp: number
  token: string
}): string {
  return `${siteUrl()}/files/${p.id}?e=${p.exp}&m=${encodeURIComponent(p.minter)}&t=${p.token}`
}

/* `v` is the avatar's storage id — pure cache-busting (the browser cache key
 * changes with the picture); the gateway ignores it for lookup. */
export function avatarFileUrl(p: {
  id: string
  minter: string
  exp: number
  token: string
  v: string
}): string {
  return `${siteUrl()}/avatars/${p.id}?e=${p.exp}&m=${encodeURIComponent(p.minter)}&t=${p.token}&v=${p.v}`
}

export function backgroundFileUrl(p: {
  id: string
  minter: string
  exp: number
  token: string
  preview?: boolean
  previewVersion?: number
}): string {
  // Version is only a cache key: the signed route always resolves the current
  // owner-bound derivative. It reveals no private storage identifier.
  const version = p.preview && p.previewVersion != null ? `&v=${p.previewVersion}` : ''
  return `${siteUrl()}/${p.preview ? 'background-previews' : 'backgrounds'}/${p.id}?e=${p.exp}&m=${encodeURIComponent(p.minter)}&t=${p.token}${version}`
}

export function backgroundUploadUrl(p: {
  id: string
  minter: string
  exp: number
  token: string
}): string {
  return `${siteUrl()}/background-uploads/${p.id}?e=${p.exp}&m=${encodeURIComponent(p.minter)}&t=${p.token}`
}
