'use node'

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { RequestOptions } from 'node:https'
import { request } from 'node:https'
import type { TcpNetConnectOpts } from 'node:net'
import { isIP } from 'node:net'
import { URL } from 'node:url'
import ipaddr from 'ipaddr.js'
import { Webhook } from 'standardwebhooks'

/** HTTPS destinations must resolve only to public addresses on every connection. */
export function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  const ip = ipaddr.parse(address)
  // IPv6 global unicast is allocated from 2000::/3. The library's fallback
  // "unicast" also includes reserved space such as IPv4-compatible ::/96.
  return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3))
}

export type CallbackFailureReason =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed'

/** Expose a protocol reason without returning remote URLs, bodies or TLS details. */
export class CallbackError extends Error {
  constructor(
    readonly reason: CallbackFailureReason,
    message = 'Callback verification failed',
  ) {
    super(message)
    this.name = 'CallbackError'
  }
}

export function callbackError(error: unknown): CallbackError {
  if (error instanceof CallbackError) return error
  if (error instanceof AggregateError) {
    const failures = error.errors.map(callbackError)
    return (
      failures.find((failure) => failure.reason === 'timeout') ??
      failures.find((failure) => failure.reason === 'tls_error') ??
      new CallbackError('connection_refused')
    )
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  if (code === 'ETIMEDOUT') return new CallbackError('timeout')
  if (
    /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(
      code,
    )
  )
    return new CallbackError('tls_error')
  return new CallbackError('connection_refused')
}

export function callbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid callback URL')
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new Error('Callbacks require HTTPS on port 443 without credentials or fragments')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (
    hostname.endsWith('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw new Error('Callback address is not public')
  return url.toString()
}

export function signingSecret(value: unknown): string {
  if (typeof value !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error('Expected a Standard Webhooks whsec_ signing secret')
  const text = value.slice(6)
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== text)
    throw new Error('Signing key must contain 24 to 64 base64-encoded bytes')
  return value
}

function deploymentSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('Webhook secret encryption is not configured')
  return secret
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(`qivo-webhook-secrets-v1\0${deploymentSecret()}`).digest()
}

/** Compare refresh keys without storing an unkeyed verifier for a receiver's secret. */
export function signingSecretHash(secret: string): string {
  return createHmac('sha256', deploymentSecret())
    .update('qivo-webhook-secret-equality-v1\0')
    .update(secret)
    .digest('hex')
}

export function encryptSecret(secret: string, subscriptionId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(Buffer.from(subscriptionId))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptSecret(encrypted: string, subscriptionId: string): string {
  const bytes = Buffer.from(encrypted, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(subscriptionId))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}

export function equalChallenge(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Pin the validated DNS answer in the socket lookup, preserving TLS hostname checks. */
export async function postWebhook(
  urlText: string,
  secret: string,
  id: string,
  subscriptionId: string,
  body: string,
  previousSecret?: string,
  options: { responseMode?: 'json' | 'status' } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(callbackUrl(urlText))
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(() => reject(new CallbackError('timeout')), 10_000)
    }),
  ])
    .catch((error: unknown) => {
      throw callbackError(error)
    })
    .finally(() => clearTimeout(dnsTimer))
  if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address)))
    throw new CallbackError('connection_refused', 'Callback address is not public')
  const now = new Date()
  const signature = new Webhook(secret).sign(id, now, body)
  const signatures = previousSecret
    ? `${signature} ${new Webhook(previousSecret).sign(id, now, body)}`
    : signature
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Webhook payload is too large')
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: unknown) => {
      clearTimeout(timer)
      reject(callbackError(error))
    }
    const requestOptions: RequestOptions &
      Pick<TcpNetConnectOpts, 'autoSelectFamily' | 'autoSelectFamilyAttemptTimeout'> = {
      method: 'POST',
      agent: false,
      // Node tries other pinned addresses only while connecting TCP. It never
      // resends an HTTP request after TLS or request transmission begins.
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
        'webhook-signature': signatures,
        'X-MCP-Subscription-Id': subscriptionId,
      },
    }
    try {
      const req = request(url, requestOptions, (response) => {
        const status = response.statusCode ?? 0
        response.on('error', fail)
        // Event acknowledgments and HTTP verification failures need only the
        // status. An endless or oversized response body cannot change it.
        if (options.responseMode === 'status' || status < 200 || status >= 300) {
          clearTimeout(timer)
          resolve({ status, body: '' })
          response.destroy()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 64 * 1024) {
            req.destroy(new CallbackError('challenge_failed', 'Callback response is too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          clearTimeout(timer)
          resolve({
            status,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      timer = setTimeout(() => req.destroy(new CallbackError('timeout')), 10_000)
      req.on('error', fail)
      req.end(body)
    } catch (error) {
      fail(error)
    }
  })
}
