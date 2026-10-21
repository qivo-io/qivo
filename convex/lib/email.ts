/* The one rule for an email address Qivo stores: an address the mail sender
 * can send to. The server's write paths, the app and the operator console all
 * use it, so a stored address never makes an invitation fail later. Imports
 * only the import-free registry, so the app can load this file. */

import { LIMITS } from './limits'

/* ONE address, and nothing that could be read as two. The recipient is
 * user-typed, and whether a comma fans out or a `<` rewrites the From is the
 * provider's business, which is why it must not be decided there. An
 * apostrophe, as in o'brien, is an ordinary address character (RFC 5322
 * atext): it cannot split an address, and mail.ts sends the address as a
 * JSON string, never in a header it builds. The domain is ASCII letters,
 * digits and hyphens, so a Unicode domain is converted to punycode first
 * (asciiEmail). */
const ADDR =
  /^[^\s@,;:<>"\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i

/** `s` itself when it is one bare email address of at most LIMITS.email.max
 * characters (the RFC 5321 ceiling on a path), otherwise null. */
export const address = (s: string): string | null =>
  s.length <= LIMITS.email.max && ADDR.test(s) ? s : null

/* RFC 3492 punycode parameters. */
const BASE = 36
const T_MIN = 1
const T_MAX = 26
const SKEW = 38
const DAMP = 700

/** The bias adaptation of RFC 3492 section 6.1. */
function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1
  d += Math.floor(d / points)
  let k = 0
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN))
    k += BASE
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW))
}

/** The punycode digit for `d`, 0 to 35: a to z, then 0 to 9. */
const digit = (d: number): string => String.fromCharCode(d < 26 ? d + 97 : d + 22)

/** `label` encoded by RFC 3492 section 6.3, without the xn-- prefix. */
function punycode(label: string): string {
  const points = Array.from(label, (c) => c.codePointAt(0) ?? 0)
  let out = points
    .filter((p) => p < 0x80)
    .map((p) => String.fromCharCode(p))
    .join('')
  const basic = out.length
  let handled = basic
  if (basic > 0) out += '-'
  let n = 0x80
  let delta = 0
  let bias = 72
  while (handled < points.length) {
    let m = Infinity
    for (const p of points) if (p >= n && p < m) m = p
    delta += (m - n) * (handled + 1)
    n = m
    for (const p of points) {
      if (p < n) delta += 1
      if (p !== n) continue
      let q = delta
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias
        if (q < t) break
        out += digit(t + ((q - t) % (BASE - t)))
        q = Math.floor((q - t) / (BASE - t))
      }
      out += digit(q)
      bias = adapt(delta, handled + 1, handled === basic)
      delta = 0
      handled += 1
    }
    delta += 1
    n += 1
  }
  return out
}

/** Whether every character of `s` is ASCII. */
const isAscii = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) < 0x80)

/** `raw` trimmed and lowercased, with each domain label that is not ASCII
 * written as punycode (bücher.de becomes xn--bcher-kva.de), the form
 * cleanEmail tests and stores. The domain is first normalized with NFKC and
 * lowercased again, as the UTS 46 mapping browsers and url.domainToASCII
 * apply does, so full-width ｅｘａｍｐｌｅ.com becomes example.com. It does not
 * check the address. Text longer than twice LIMITS.email.max is left
 * unconverted, because no conversion of it fits the limit. */
export function asciiEmail(raw: string): string {
  const text = raw.trim().toLowerCase()
  const at = text.lastIndexOf('@')
  if (at < 0 || text.length > 2 * LIMITS.email.max) return text
  const domain = text
    .slice(at + 1)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[.\u3002\uff0e\uff61]/)
    .map((label) => (isAscii(label) ? label : `xn--${punycode(label)}`))
    .join('.')
  return `${text.slice(0, at + 1)}${domain}`
}

/** The address to store for `raw` (asciiEmail), or null when it is not one
 * address Qivo can mail or is longer than LIMITS.email.max. */
export const cleanEmail = (raw: string): string | null => address(asciiEmail(raw))
