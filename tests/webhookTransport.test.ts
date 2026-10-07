import { createHmac } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { Server } from 'node:https'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { Webhook } from 'standardwebhooks'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Public test-only identity for the local receiver. No runtime certificate tool
// or filesystem writes are needed; this self-signed fixture expires in 2126.
const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCLouCXum63glHb
tOJ2GhtAU98yfnngm2IH0WmyYOYTjgXubCPKO7YfX/zbjEIdDa+zgZMNOzzKzzl4
9iXrWqfvb4WhZMZyfqzhZjzKVCaVmUzaazIc/zRzVKFjGqVpFENWhbB0+z6W5xWk
a+I2qlKK9ODRTGrgqH1yZZ/dGChI9X+36ZbN5PNB6d/KsibWczT8JsrKogsW4Rfq
yKB1vVjohvyB9+WeG1jegqc3X2hYaj3US9hyvJyR7cPJ+BpY4A1sIXIuYFxfK0uk
MQgaqcu3hoRhyPuS68jd1W7kuHx6dPa30JIFqsG5A5t4lXZuo3I8u4WNyN3qHdks
e2FFXZSxAgMBAAECggEACYTHYaB0Vq8cDGmWvG1IKUjuYJ9NiJmfA6BrX50KYg/e
6KNXhzwtzJK7Bm5XvWpG7WoqT48XtE2PAedpq1MJOqG0Ds3zVy+6cj0JbNNys+T4
37TJ/D8LYMdGnx5cYz7d3kKLxlWwLRJAn+44w/g1W0KZJrtaV8k0j/1MegJhEKQN
0vfyEifQoxhb/rQ45YrMuJllz6y8c+u+iNbrTQjhadFcOHJeYZyIyo//FX1OmuqY
RxVSnmaaiMBO3r8FZUR1bck4kClGGmx7prH3oj4cX+iiO4Ys0cooV0TMcIQr9xGF
l/V2+/SVhnROzlMJnYNEEInoXsCq+DZSKyeLkRBFyQKBgQC/HMCxabt1+S6nuCQR
fv67I9uIiy1aotgfJyW9U2h3A2aMfDJnprWAhY9R7zYRI8Ga2LYNmCVqaIAMESJ/
2ykEsc6zBVvsE6yHwGa5cUnguBB8Ytb3PD/hA5Tvyrbo6TA/9O00zDharEqEBNCg
c6q86Uwaag4M2hez/mJfS+jrnQKBgQC7C+MvXQF5rd7xL3OpOY9zUXQtlgmcnhV+
tF4lAZnvaDg+o3388042mtxf/5CuQ7Byheh/UOh0eCvtWrE1RyR4mO+QdxoG0WDK
pC1sExWPmVGFc4Ejtr2pe5Ru3er4uMAxKTo9BluKM+YlMoKRli7MM27oc5Q15MW+
aLTFxYxzJQKBgG8LheuQRByIbVOG624/HEQg0a7FL9U6SdnQJV2c2VZN44g9ogwY
Ed5bvKsfE4th+1y+DwpXHWZ20fAxBJrF/U99AV2D/6VsyRMX+JhH+2VXjjy4Ma/2
kidsrV2nrCApXp/K8Ql8oEIPWjzbj12r18lsxYuTlBZjouIzLXWx5eUBAoGASD3v
IPvq9fQRh1Wsdk+k+AUduf2Y+MSVyLohImnb6nt2Pbsnjerq6mwlcW5jkurR22mc
wo+dOF6xmJrOlqVDkNCAtmtJwhhcKef/Ix671RqCQei6l/CckDkKu0c62ZWBpXsm
4yrxcA9bdEJt64z1xiiXTXBWbfpN5ZzLNRd3h4ECgYBZMljVIcVn0wOdJ86jiA9+
Ze74bhHVOkQtEKpSYyK/nx98VZulqWSab++lfmU3ROOG3EQgEOvkXwfWe9cPioah
V7Y2D+DNK+atT9Mo1xpVxux/t7cpCsRfYYVMoR7/LiqRiOhu0zKoBDdKuoxLvfDG
SjX/nq1qMZFFzx+qIElDtA==
-----END PRIVATE KEY-----`
const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIUOjfTWYdtbZyHuiCm1pNG6XhFJz8wDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQcmVjZWl2ZXIuZXhhbXBsZTAgFw0yNjEwMDUwNTU4MjNa
GA8yMTI2MDkxMTA1NTgyM1owGzEZMBcGA1UEAwwQcmVjZWl2ZXIuZXhhbXBsZTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIui4Je6breCUdu04nYaG0BT
3zJ+eeCbYgfRabJg5hOOBe5sI8o7th9f/NuMQh0Nr7OBkw07PMrPOXj2Jetap+9v
haFkxnJ+rOFmPMpUJpWZTNprMhz/NHNUoWMapWkUQ1aFsHT7PpbnFaRr4jaqUor0
4NFMauCofXJln90YKEj1f7fpls3k80Hp38qyJtZzNPwmysqiCxbhF+rIoHW9WOiG
/IH35Z4bWN6CpzdfaFhqPdRL2HK8nJHtw8n4GljgDWwhci5gXF8rS6QxCBqpy7eG
hGHI+5LryN3VbuS4fHp09rfQkgWqwbkDm3iVdm6jcjy7hY3I3eod2Sx7YUVdlLEC
AwEAAaNwMG4wHQYDVR0OBBYEFDoZ429U8HWIS+XrhD3YWfmT6YWSMB8GA1UdIwQY
MBaAFDoZ429U8HWIS+XrhD3YWfmT6YWSMA8GA1UdEwEB/wQFMAMBAf8wGwYDVR0R
BBQwEoIQcmVjZWl2ZXIuZXhhbXBsZTANBgkqhkiG9w0BAQsFAAOCAQEAS8WHWoVc
O+DmgEvxwERdRmE2Rgn5uL0xRUGCLpiOC2z4olY1eMAkCltME2byNvOCxZuyu2oj
bAeOq7FMOiYfryi92MHHYl31GQ3PNZqEbdKfTz6pxUaKV+Gei6CewFz2tgOBaZQf
sziP82txXIt1xTw+IepLlK6ei2p6Mlg6ceEME7b9+FQqCDyVApwYFuEnFEv37QIB
SeqmzaDzTHrqa5EGYMflzqP6RfrX8ESD2RxgvMhXXNz0YVsYFzxHdIu+lWrecmkr
9zSaZH0t5s0x3HhQJUuFwgaIfs/D60XkEfEo4mfVDtuG/ke7YHJksTAwvhLudjI1
AhP4Q/460Dxc8Q==
-----END CERTIFICATE-----`

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
let server: Server
const sockets = new Set<Socket>()
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
