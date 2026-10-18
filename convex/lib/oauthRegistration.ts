/* Bounds on OAuth client registration. Dynamic client registration stays open
 * to unauthenticated callers (RFC 7591), so these limits keep an anonymous
 * caller from filling the deployment with client rows:
 *   - a registration's client metadata is capped in size,
 *   - registrations are counted per source address and for the whole
 *     deployment in fixed hourly windows (oauthRegistrations.ts admit),
 *   - a client that nobody approved is deleted after a few days
 *     (oauthRegistrations.ts sweepClients).
 * The limits apply to /oauth2/register and to /oauth2/create-client, which a
 * signed-in person can call, because both store the same client rows. */

import { sha256hex } from '../machine/auth'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

/** The length of one counting window. */
export const OAUTH_REGISTRATION_WINDOW_MS = 60 * 60_000

/** Registrations one source address may make in a window. A well-behaved
 * client registers once per installation or connector. The busiest real
 * source is a shared address: an office behind one NAT, or an assistant
 * service registering for many people from its own servers. Neither adds 60
 * connections in one hour. */
export const OAUTH_REGISTRATIONS_PER_SOURCE = 60

/** Registrations the whole deployment accepts in a window, from all sources. */
export const OAUTH_REGISTRATIONS_TOTAL = 600

/** The largest client metadata a registration may send, in bytes of its JSON.
 * Registrations from MCP clients are typically a few hundred bytes. Without a
 * cap one client row could approach the 1 MiB document limit. */
export const OAUTH_CLIENT_METADATA_MAX_BYTES = 8 * 1024

/** How old a client must be before the cleanup deletes it when no consent,
 * token or connection refers to it. */
export const OAUTH_UNUSED_CLIENT_TTL_MS = 3 * 24 * 60 * 60_000

/** The deployment's registration counter in machine_rate_limits. */
export const OAUTH_REGISTRATION_TOTAL_KEY = 'oauth_registration:all'

/** The prefix of the per-source counters in machine_rate_limits. */
export const OAUTH_REGISTRATION_SOURCE_PREFIX = 'oauth_registration:source:'

/** Whether a registration's client metadata is larger than the cap. */
export const clientMetadataTooLarge = (body: unknown): boolean =>
  new TextEncoder().encode(JSON.stringify(body ?? {})).length > OAUTH_CLIENT_METADATA_MAX_BYTES

/** The address a source counter groups. An IPv4 address counts as written,
 * also when it is mapped into IPv6. An IPv6 address counts as its /64
 * network, written `a:b:c:d::/64`, because one host can usually rotate
 * through its whole /64. Any other value is kept, cut to 64 characters, so it
 * still counts against a bucket of its own. */
export function addressBucket(address: string): string {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .split('%')[0]
  const ipv4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (ipv4) return ipv4[1]
  if (!/^[0-9a-f:]+$/.test(value) || !value.includes(':')) return value.slice(0, 64)
  const [head, tail] = value.split('::', 2)
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  const network = groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(':')
  return `${network}::/64`
}

/** The counter key for a registration from `address`, or from an unknown
 * address when it is null. The bucket is hashed with the auth secret, so the
 * stored key does not reveal the address. */
export async function registrationSourceKey(
  address: string | null,
  secret: string,
): Promise<string> {
  const bucket = address ? addressBucket(address) : 'unknown'
  const hash = await sha256hex(`qivo-oauth-registration-v1:${secret}:${bucket}`)
  return `${OAUTH_REGISTRATION_SOURCE_PREFIX}${hash}`
}
