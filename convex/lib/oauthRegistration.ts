/* Bounds on OAuth client registration. Dynamic client registration stays open
 * to unauthenticated callers (RFC 7591), so these limits keep an anonymous
 * caller from filling the deployment with client rows:
 *   - a registration's client metadata is capped in size,
 *   - registrations are counted per source address, per IPv6 /48 network and
 *     for the whole deployment in fixed hourly windows
 *     (oauthRegistrations.ts admit),
 *   - a client that nobody approved is deleted after a few days
 *     (oauthRegistrations.ts sweepClients).
 * /oauth2/register is the only endpoint Qivo serves that creates or changes a
 * client. auth.ts disables the provider's client management endpoints. */

import { sha256hex } from '../machine/auth'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

/** The length of one counting window. */
export const OAUTH_REGISTRATION_WINDOW_MS = 60 * 60_000

/** Registrations one source address may make in a window. A well-behaved
 * client registers once per installation or connector. The busiest real
 * source is a shared address, such as an office behind one NAT or an
 * assistant service registering for many people from its own servers. Neither
 * adds 60 connections in one hour. */
export const OAUTH_REGISTRATIONS_PER_SOURCE = 60

/** Registrations one IPv6 /48 network may make in a window, over all of its
 * /64 networks. One customer's delegated prefix, often a /56 or /60, holds
 * many /64 networks. Without this limit one such connection could fill the
 * deployment limit alone; with it, one /48 gets at most a fifth of it. */
export const OAUTH_REGISTRATIONS_PER_NETWORK = 120

/** Registrations the whole deployment accepts in a window, from all sources. */
export const OAUTH_REGISTRATIONS_TOTAL = 600

/** The largest client metadata a registration may send, in bytes of its JSON.
 * Registrations from MCP clients are typically a few hundred bytes. Without a
 * cap one client row could approach the 1 MiB document limit. */
export const OAUTH_CLIENT_METADATA_MAX_BYTES = 8 * 1024

/** How old a client must be before the cleanup deletes it when no consent,
 * token, approved connection or pending authorization refers to it. */
export const OAUTH_UNUSED_CLIENT_TTL_MS = 3 * 24 * 60 * 60_000

/** The deployment's registration counter in machine_rate_limits. */
export const OAUTH_REGISTRATION_TOTAL_KEY = 'oauth_registration:all'

/** The prefix of the per-source counters in machine_rate_limits. */
export const OAUTH_REGISTRATION_SOURCE_PREFIX = 'oauth_registration:source:'

/** Whether a registration's client metadata is larger than the cap. */
export const clientMetadataTooLarge = (body: unknown): boolean =>
  new TextEncoder().encode(JSON.stringify(body ?? {})).length > OAUTH_CLIENT_METADATA_MAX_BYTES

/** The source counters a registration from `address` counts against, each
 * as a bucket and its limit. An IPv4 address counts as written, also when it
 * is mapped into IPv6. An IPv6 address counts as its /64 network, written
 * `a:b:c:d::/64`, because one host can usually rotate through its whole /64,
 * and also as its /48 network, written `a:b:c::/48`. Any other value is kept,
 * cut to 64 characters, so it still counts against a bucket of its own. */
export function addressBuckets(address: string): { bucket: string; limit: number }[] {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .split('%')[0]
  const ipv4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (ipv4) return [{ bucket: ipv4[1], limit: OAUTH_REGISTRATIONS_PER_SOURCE }]
  if (!/^[0-9a-f:]+$/.test(value) || !value.includes(':'))
    return [{ bucket: value.slice(0, 64), limit: OAUTH_REGISTRATIONS_PER_SOURCE }]
  const [head, tail] = value.split('::', 2)
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = (
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  ).map((group) => (Number.parseInt(group, 16) || 0).toString(16))
  return [
    { bucket: `${groups.slice(0, 4).join(':')}::/64`, limit: OAUTH_REGISTRATIONS_PER_SOURCE },
    { bucket: `${groups.slice(0, 3).join(':')}::/48`, limit: OAUTH_REGISTRATIONS_PER_NETWORK },
  ]
}

/** The counter key for one source bucket. The bucket is hashed with the auth
 * secret, so the stored key does not reveal the address. */
export async function registrationSourceKey(bucket: string, secret: string): Promise<string> {
  const hash = await sha256hex(`qivo-oauth-registration-v1:${secret}:${bucket}`)
  return `${OAUTH_REGISTRATION_SOURCE_PREFIX}${hash}`
}

/** The source counters a registration from `address`, or from an unknown
 * address when it is null, counts against, each as a key and its limit.
 * Every request with an unknown address shares one counter. */
export async function registrationSourceCounters(
  address: string | null,
  secret: string,
): Promise<{ key: string; limit: number }[]> {
  const buckets = address
    ? addressBuckets(address)
    : [{ bucket: 'unknown', limit: OAUTH_REGISTRATIONS_PER_SOURCE }]
  return Promise.all(
    buckets.map(async ({ bucket, limit }) => ({
      key: await registrationSourceKey(bucket, secret),
      limit,
    })),
  )
}
