import { createHmac } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { Server } from 'node:https'
import { createServer } from 'node:https'
import type { Duplex } from 'node:stream'
import { Webhook } from 'standardwebhooks'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../convex/lib/limits'
import {
  CallbackError,
  callbackError,
  callbackUrl,
  decryptSecret,
  encryptSecret,
  postWebhook,
  publicAddress,
  signingSecret,
  signingSecretHash,
} from '../convex/lib/webhookTransport'
import { testCertificate, testKey } from './fixtures/local-tls.mjs'

const receiver = vi.hoisted(() => ({
  port: 0,
  ca: '',
  addresses: [{ address: '8.8.8.8', family: 4 }] as LookupAddress[],
  pinned: [] as { hostname: string; all: boolean; addresses: LookupAddress[] }[],
  connections: [] as string[],
  status: 200,
  mode: 'challenge' as 'challenge' | 'stream' | 'oversized' | 'reset',
  dnsHang: false,
}))
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    if (receiver.dnsHang) return new Promise<LookupAddress[]>(() => {})
    return receiver.addresses
  }),
}))
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return {
    ...actual,
    request: ((url, options, callback) => {
      const pinnedLookup = options.lookup
      if (!pinnedLookup) throw new Error('Production must pin the validated DNS answers')
      if (options.agent !== false)
        throw new Error('Production must not use a shared or proxied agent')
      const req = actual.request(
        url,
        {
          ...options,
          port: receiver.port,
          ca: receiver.ca,
          lookup: (hostname, lookupOptions, cb) => {
            // Exercise the production lookup, then translate its validated
            // addresses to local sockets without replacing its selection logic.
            pinnedLookup(hostname, lookupOptions, (error, addresses, family) => {
              if (error) return cb(error, addresses, family)
              const list = Array.isArray(addresses)
                ? addresses
                : [{ address: addresses, family: family! }]
              receiver.pinned.push({ hostname, all: lookupOptions.all ?? false, addresses: list })
              const mapped = list.map((entry) => ({
                family: entry.family,
                address:
                  entry.family === 6
                    ? '::1'
                    : entry.address === '8.8.8.8'
                      ? '127.0.0.1'
                      : '127.0.0.2',
              }))
              if (Array.isArray(addresses)) cb(null, mapped)
              else cb(null, mapped[0].address, mapped[0].family)
            })
          },
        },
        callback,
      )
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          receiver.connections.push(
            ...(socket.autoSelectFamilyAttemptedAddresses ?? []).map((address) =>
              address.slice(0, address.lastIndexOf(':')),
            ),
          )
        })
      })
      return req
    }) as typeof actual.request,
  }
})

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
let server: Server
const sockets = new Set<Duplex>()
let received: { body: string; headers: Record<string, string | string[] | undefined> }[] = []
beforeAll(async () => {
  receiver.ca = testCertificate
  server = createServer({ key: testKey, cert: testCertificate }, (request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ body, headers: request.headers })
      if (receiver.mode === 'reset') {
        request.socket.destroy()
        return
      }
      const challenge = (JSON.parse(body) as { challenge?: string }).challenge
      response.writeHead(receiver.status, {
        'Content-Type': 'application/json',
        Location: 'https://receiver.example/redirect',
      })
      if (receiver.mode === 'stream') {
        response.flushHeaders()
        response.write('x'.repeat(70_000))
      } else if (receiver.mode === 'oversized') response.end('x'.repeat(70_000))
      else response.end(JSON.stringify({ challenge }))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Receiver failed to listen')
  receiver.port = address.port
})
beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-encryption-key')
  vi.mocked(lookup).mockClear()
  receiver.addresses = [{ address: '8.8.8.8', family: 4 }]
  receiver.pinned = []
  receiver.connections = []
  receiver.status = 200
  receiver.mode = 'challenge'
  receiver.dnsHang = false
  received = []
})
afterEach(() => {
  for (const socket of sockets) socket.destroy()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
})

describe('standard webhook transport', () => {
  it('allows public HTTPS and blocks private, local, mapped and reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::8.8.8.8',
      '::127.0.0.1',
      '1000::1',
      '4000::1',
      'fc00::1',
      'fe80::1',
      '::ffff:8.8.8.8',
      '2001:db8::1',
      '2002:0808:0808::1',
      '64:ff9b::8.8.8.8',
    ])
      expect(publicAddress(address), address).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
    for (const url of [
      'http://receiver.example/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://[::127.0.0.1]/',
      'https://[4000::1]/',
      'https://user:password@receiver.example/',
      'https://receiver.example:8443/',
      'https://receiver.example/#fragment',
    ])
      expect(() => callbackUrl(url)).toThrow()
    expect(callbackUrl('https://receiver.example/events')).toBe('https://receiver.example/events')
    // the length limit counts the trimmed URL and refuses with its sentence
    const atCap = `https://receiver.example/${'a'.repeat(LIMITS.webhookUrl.max - 25)}`
    expect(atCap).toHaveLength(LIMITS.webhookUrl.max)
    expect(callbackUrl(`  ${atCap}  `)).toBe(atCap)
    expect(() => callbackUrl(`${atCap}a`)).toThrow(LIMITS.webhookUrl.refusal)
  })

  it('validates and encrypts secrets with an authenticated subscription binding', () => {
    expect(signingSecret(secret)).toBe(secret)
    expect(() => signingSecret('whsec_abc')).toThrow()
    expect(() => signingSecret(`whsec_${Buffer.alloc(65).toString('base64')}`)).toThrow()
    const encrypted = encryptSecret(secret, 'sub-1')
    expect(encrypted).not.toContain(secret)
    expect(decryptSecret(encrypted, 'sub-1')).toBe(secret)
    expect(() => decryptSecret(encrypted, 'sub-2')).toThrow()
    const tampered = Buffer.from(encrypted, 'base64')
    tampered[tampered.length - 1] ^= 1
    expect(() => decryptSecret(tampered.toString('base64'), 'sub-1')).toThrow()
    // GCM accepts the first bytes of a valid tag unless the tag length is fixed.
    const empty = Buffer.from(encryptSecret('', 'sub-1'), 'base64')
    expect(decryptSecret(empty.toString('base64'), 'sub-1')).toBe('')
    expect(() => decryptSecret(empty.subarray(0, 16).toString('base64'), 'sub-1')).toThrow()
    const hash = signingSecretHash(secret)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(signingSecretHash(secret)).toBe(hash)
    vi.stubEnv('BETTER_AUTH_SECRET', 'replacement-deployment-key')
    expect(signingSecretHash(secret)).not.toBe(hash)
    expect(() => decryptSecret(encrypted, 'sub-1')).toThrow()
  })

  it('pins validated DNS answers and sends independently signed HTTPS bytes with rotated keys', async () => {
    const body = JSON.stringify({ type: 'verification', challenge: 'challenge-123' })
    const previous = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
    const response = await postWebhook(
      'https://receiver.example/events',
      secret,
      'evt-1',
      'sub-1',
      body,
      previous,
    )
    expect(response).toEqual({ status: 200, body: JSON.stringify({ challenge: 'challenge-123' }) })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('receiver.example', { all: true })
    expect(receiver.pinned).toEqual([
      { hostname: 'receiver.example', all: true, addresses: receiver.addresses },
    ])
    expect(received).toHaveLength(1)
    expect(received[0].body).toBe(body)
    const headers = received[0].headers as Record<string, string>
    expect(headers['webhook-id']).toBe('evt-1')
    expect(headers['x-mcp-subscription-id']).toBe('sub-1')
    expect(Math.abs(Number(headers['webhook-timestamp']) - Date.now() / 1000)).toBeLessThan(5)
    const expectedSignature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`evt-1.${headers['webhook-timestamp']}.${body}`)
      .digest('base64')
    expect(headers['webhook-signature'].split(' ')[0]).toBe(`v1,${expectedSignature}`)
    for (const key of [secret, previous])
      expect(new Webhook(key).verify(received[0].body, headers)).toEqual(JSON.parse(body))
    expect(() => new Webhook(secret).verify(`${body} `, headers)).toThrow()
  })

  it('rechecks DNS and refuses mixed public/private answers before opening a socket', async () => {
    receiver.addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-2', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'connection_refused' })
    expect(receiver.pinned).toHaveLength(0)
    expect(received).toHaveLength(0)
  })

  it.each([
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ])('tries the next pinned address after a refused $address connection', async (first) => {
    receiver.addresses = [first, { address: '8.8.8.8', family: 4 }]
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-3', 'sub-1', '{}'),
    ).resolves.toMatchObject({ status: 200 })
    expect(receiver.pinned).toEqual([
      { hostname: 'receiver.example', all: true, addresses: receiver.addresses },
    ])
    expect(receiver.connections).toContain(first.family === 6 ? '::1' : '127.0.0.2')
    expect(receiver.connections).toContain('127.0.0.1')
    expect(received).toHaveLength(1)
  })

  it('does not try another address after the receiver has received the request', async () => {
    receiver.addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]
    receiver.mode = 'reset'
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-4', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'connection_refused' })
    expect(received).toHaveLength(1)
    expect(receiver.connections).not.toContain('127.0.0.2')
  })

  it.each([200, 410])(
    'accepts status %s without draining an oversized unfinished event response',
    async (status) => {
      receiver.status = status
      receiver.mode = 'stream'
      await expect(
        postWebhook('https://receiver.example/events', secret, 'evt-5', 'sub-1', '{}', undefined, {
          responseMode: 'status',
        }),
      ).resolves.toEqual({ status, body: '' })
      expect(received).toHaveLength(1)
    },
  )

  it('bounds verification responses and preserves non-2xx status without reading their bodies', async () => {
    receiver.mode = 'oversized'
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-6', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'challenge_failed' })
    receiver.status = 503
    receiver.mode = 'stream'
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-7', 'sub-1', '{}'),
    ).resolves.toEqual({ status: 503, body: '' })
  })

  it('does not follow callback redirects', async () => {
    receiver.status = 302
    receiver.mode = 'stream'
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-8', 'sub-1', '{}'),
    ).resolves.toEqual({ status: 302, body: '' })
    expect(received).toHaveLength(1)
  })

  it('preserves TLS hostname verification and classifies real certificate failures', async () => {
    await expect(
      postWebhook('https://other.example/events', secret, 'evt-9', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'tls_error' })
    expect(received).toHaveLength(0)
  })

  it('reports connection refusal and DNS timeouts without exposing remote details', async () => {
    receiver.addresses = [{ address: '1.1.1.1', family: 4 }]
    await expect(
      postWebhook('https://receiver.example/events', secret, 'evt-10', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'connection_refused' })
    receiver.dnsHang = true
    vi.useFakeTimers()
    const pending = expect(
      postWebhook('https://receiver.example/events', secret, 'evt-11', 'sub-1', '{}'),
    ).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    const typed = new CallbackError('http_4xx')
    expect(callbackError(typed)).toBe(typed)
    expect(callbackError(new AggregateError([{ code: 'ETIMEDOUT' }])).reason).toBe('timeout')
    expect(callbackError(new Error('private receiver details')).message).toBe(
      'Callback verification failed',
    )
  })
})
