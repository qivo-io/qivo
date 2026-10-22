/* The one rule for an email address Qivo stores: an address the mail sender
 * can send to and a password login can use. The server's write paths, the
 * app and the operator console all use it, so a stored address never makes
 * an invitation or a password sign-up fail later. Imports only the
 * import-free registry, so the app can load this file. */

import { LIMITS, overText } from './limits'

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

/* The addresses Better Auth's password sign-up, sign-in and reset take: zod's
 * z.email() pattern, which better-auth tests every address with and has no
 * option to change. The part before the @ holds ASCII letters, digits and
 * _ ' + - in dot-separated runs, and the top-level domain at least two ASCII
 * letters. So jørn@example.no and a domain under a Unicode top-level domain
 * such as .рф (xn--p1ai) are refused, while Google and Microsoft sign-in take
 * them. tests/email.test.ts checks this copy against zod's own. */
export const PASSWORD_ADDR =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/** The refusal of an address the mail sender takes but a password login
 * does not (PASSWORD_ADDR). */
export const NO_PASSWORD_LOGIN =
  "this address cannot get a password login. Before the @ it may hold only letters a to z, digits and . _ ' + -, may not start or end with a dot or hold two dots in a row, and may not end with an apostrophe. Its domain must end in at least two letters a to z, such as .com. Use another address."

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

/** The value of punycode digit `c` (a to z, then 0 to 9), or -1 for any
 * other character. */
function digitValue(c: string): number {
  const p = c.charCodeAt(0)
  if (p >= 97 && p <= 122) return p - 97
  if (p >= 48 && p <= 57) return p - 22
  return -1
}

/** `encoded`, a label's punycode without the xn-- prefix, decoded by RFC 3492
 * section 6.2, or null when it is not valid punycode or decodes to a label
 * with no character outside ASCII, which a domain never writes so. A
 * delimiter that starts the label is invalid: section 6.2 then decodes from
 * the delimiter itself, which is no digit. */
function unpunycode(encoded: string): string | null {
  const dash = encoded.lastIndexOf('-')
  if (dash === 0) return null
  const points = Array.from(dash < 0 ? '' : encoded.slice(0, dash), (c) => c.charCodeAt(0))
  if (points.some((p) => p >= 0x80)) return null
  let n = 0x80
  let i = 0
  let bias = 72
  for (let at = dash < 0 ? 0 : dash + 1; at < encoded.length; ) {
    const old = i
    let w = 1
    for (let k = BASE; ; k += BASE) {
      if (at >= encoded.length) return null
      const d = digitValue(encoded[at++])
      if (d < 0) return null
      i += d * w
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias
      if (d < t) break
      w *= BASE - t
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(w)) return null
    }
    bias = adapt(i - old, points.length + 1, old === 0)
    n += Math.floor(i / (points.length + 1))
    i %= points.length + 1
    if (n > 0x10ffff) return null
    points.splice(i, 0, n)
    i += 1
  }
  return points.some((p) => p >= 0x80) ? String.fromCodePoint(...points) : null
}

/** Whether every character of `s` is ASCII. */
const isAscii = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) < 0x80)

/** The characters UTS 46 maps to nothing in a domain, such as the soft
 * hyphen and the zero-width space: dropped, as url.domainToASCII drops them. */
const IGNORED = new Set([
  0xad,
  0x34f,
  0x180b,
  0x180c,
  0x180d,
  0x200b,
  0x2060,
  0xfeff,
  ...Array.from({ length: 16 }, (_, i) => 0xfe00 + i),
])

/** `domain` without the characters UTS 46 ignores (IGNORED). */
const withoutIgnored = (domain: string): string =>
  [...domain].filter((c) => !IGNORED.has(c.codePointAt(0) ?? 0)).join('')

/** Whether a label that is not ASCII may be written as punycode: it holds
 * no control, format or space character and does not start with a
 * combining mark, which UTS 46 refuses. A refused label stays as typed, so
 * the address rule refuses the address. */
const encodable = (label: string): boolean => !/[\p{C}\p{Z}]/u.test(label) && !/^\p{M}/u.test(label)

/** `raw` trimmed and lowercased, with each domain label that is not ASCII
 * written as punycode (bücher.de becomes xn--bcher-kva.de), the form
 * cleanEmail tests and stores. The domain is first mapped as UTS 46 maps it
 * for browsers and url.domainToASCII: ignored characters dropped, NFKC, and
 * lowercased again, so full-width ｅｘａｍｐｌｅ.com becomes example.com. A
 * label UTS 46 refuses stays unconverted. It does not check the address.
 * Text longer than twice LIMITS.email.max is left unconverted, because no
 * conversion of it fits the limit. */
export function asciiEmail(raw: string): string {
  const text = raw.trim().toLowerCase()
  const at = text.lastIndexOf('@')
  if (at < 0 || text.length > 2 * LIMITS.email.max) return text
  const domain = withoutIgnored(text.slice(at + 1))
    .normalize('NFKC')
    .toLowerCase()
    .split(/[.\u3002\uff0e\uff61]/)
    .map((label) => (isAscii(label) || !encodable(label) ? label : `xn--${punycode(label)}`))
    .join('.')
  return `${text.slice(0, at + 1)}${domain}`
}

/** The address to store for `raw` (asciiEmail), or null when it is not one
 * address Qivo can mail, is longer than LIMITS.email.max or cannot get a
 * password login. */
export function cleanEmail(raw: string): string | null {
  const email = address(asciiEmail(raw))
  return email !== null && PASSWORD_ADDR.test(email) ? email : null
}

/** Why cleanEmail refuses `raw`, as the server's sentence, when the reason is
 * its length (LIMITS.email) or a password login (NO_PASSWORD_LOGIN). Null
 * for an address cleanEmail takes and for text that is no address at all,
 * which each caller words itself. */
export function emailRefusal(raw: string): string | null {
  const email = asciiEmail(raw)
  if (overText(LIMITS.email, email)) return LIMITS.email.refusal
  return address(email) !== null && !PASSWORD_ADDR.test(email) ? NO_PASSWORD_LOGIN : null
}

/** `email`, an address in the form asciiEmail writes, with each punycode
 * domain label written back in Unicode (anna@xn--bcher-kva.de becomes
 * anna@bücher.de), the form a provider sign-in may give a login. A label
 * that is not valid punycode stays as it is. */
export function unicodeEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return email
  const domain = email
    .slice(at + 1)
    .split('.')
    .map((label) => (label.startsWith('xn--') ? (unpunycode(label.slice(4)) ?? label) : label))
    .join('.')
  return `${email.slice(0, at + 1)}${domain}`
}
