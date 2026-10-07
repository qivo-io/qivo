/* Email avatars use SHA-256 hashes, primed asynchronously so render paths
   only read the cache. `d=blank` leaves initials visible for missing avatars
   without a failed-image console error. Retina sizes share 64/128/256px URL
   buckets to avoid separate requests for every displayed avatar size. */

/** Trimmed and lowercased, the way Gravatar hashes it. Empty → null, so a
    profile with no address never produces a URL. Pure. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email || '').trim().toLowerCase()
  return e ? e : null
}

/** CSS pixels → the `s=` to ask for. Doubled for retina and rounded up to one
    of three buckets, so the eight sizes in the app share three URLs. Pure. */
export function requestSize(cssPx: number): number {
  const wanted = Math.max(1, Math.round(cssPx)) * 2
  if (wanted <= 64) return 64
  if (wanted <= 128) return 128
  return 256
}

/** The image URL for an already-computed hash. Pure — the async half is
    `prime`, so this stays callable from render. */
export function urlForHash(hash: string, cssPx: number): string {
  return `https://gravatar.com/avatar/${hash}?s=${requestSize(cssPx)}&d=blank`
}

const hashes = new Map<string, string>() // normalized email -> sha-256 hex
const inFlight = new Set<string>()

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hash every address not hashed yet. Resolves true when the map grew, which
    is the caller's cue to re-render — before that, `gravatarUrl` returns null
    for those addresses and the initials chip stands in.

    Never rejects: `crypto.subtle` is undefined outside a secure context (and
    in some test environments), and a missing picture must not break a render.
    The address simply keeps no hash and keeps its initials. */
export async function prime(emails: Iterable<string | null | undefined>): Promise<boolean> {
  const todo: string[] = []
  for (const raw of emails) {
    const e = normalizeEmail(raw)
    if (!e || hashes.has(e) || inFlight.has(e)) continue
    inFlight.add(e)
    todo.push(e)
  }
  if (!todo.length) return false
  try {
    const digested = await Promise.all(todo.map(sha256Hex))
    todo.forEach((e, i) => {
      hashes.set(e, digested[i])
    })
    return true
  } catch {
    return false
  } finally {
    todo.forEach((e) => {
      inFlight.delete(e)
    })
  }
}

/** The URL to draw for this address at this size, or null — no address, or a
    hash that has not landed yet. Synchronous by construction. */
export function gravatarUrl(email: string | null | undefined, cssPx: number): string | null {
  const e = normalizeEmail(email)
  if (!e) return null
  const h = hashes.get(e)
  return h ? urlForHash(h, cssPx) : null
}

/** Test seam: drop every cached hash. */
export function resetGravatarCache(): void {
  hashes.clear()
  inFlight.clear()
}
