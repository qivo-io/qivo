/** Broad, declared browser/OS categories for aggregate demo analytics. Never
 * persist raw User-Agent, IP address, precise location or the signed context. */
export const DEMO_VISITOR_HEADER = 'X-Qivo-Demo-Visitor'
export const DEMO_VISITOR_TTL_SECONDS = 300
export const DEMO_VISITOR_BROWSERS = [
  'Chrome',
  'Edge',
  'Firefox',
  'Safari',
  'Samsung Internet',
  'Opera',
  'Other',
  'Unknown',
] as const
export const DEMO_VISITOR_SYSTEMS = [
  'Windows',
  'macOS',
  'Linux',
  'Android',
  'iOS',
  'ChromeOS',
  'Unknown',
] as const

export function demoVisitorPlatform(userAgent: string | null) {
  const ua = (userAgent ?? '').slice(0, 2048)
  const browser = !ua
    ? 'Unknown'
    : /\b(?:Edg|EdgA|EdgiOS|Edge)\//i.test(ua)
      ? 'Edge'
      : /\b(?:OPR|OPiOS|Opera)(?:\/|\s)/i.test(ua)
        ? 'Opera'
        : /\bSamsungBrowser\//i.test(ua)
          ? 'Samsung Internet'
          : /\b(?:Firefox|FxiOS)\//i.test(ua)
            ? 'Firefox'
            : /\b(?:Chrome|CriOS|Chromium)\//i.test(ua)
              ? 'Chrome'
              : /\bVersion\//i.test(ua) && /\bSafari\//i.test(ua)
                ? 'Safari'
                : 'Other'
  const os =
    /\b(?:iPhone|iPad|iPod)\b/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua))
      ? 'iOS'
      : /\bAndroid\b/i.test(ua)
        ? 'Android'
        : /\bCrOS\b/i.test(ua)
          ? 'ChromeOS'
          : /\bWindows\b/i.test(ua)
            ? 'Windows'
            : /\b(?:Macintosh|Mac OS X)\b/i.test(ua)
              ? 'macOS'
              : /\bLinux\b/i.test(ua)
                ? 'Linux'
                : 'Unknown'
  return { browser, os }
}

declare class TextEncoder {
  encode(input: string): Uint8Array
}
declare const crypto: {
  subtle: {
    importKey(
      format: string,
      keyData: Uint8Array,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      keyUsages: string[],
    ): Promise<unknown>
    verify(
      algorithm: string,
      key: unknown,
      signature: Uint8Array,
      data: Uint8Array,
    ): Promise<boolean>
  }
}

/** Only the Vercel server can attest country. Direct Convex country headers
 * have no authority; invalid/missing context is an ordinary unknown value. */
export async function verifiedDemoCountry(
  context: string | null,
  options: { secret?: string; now?: number } = {},
): Promise<string> {
  const secret = options.secret ?? process.env.DEMO_METRICS_SECRET
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret) || !context || context.length > 128)
    return 'ZZ'
  const match = /^v1\.(\d{10})\.([A-Z]{2})\.([a-f0-9]{64})$/.exec(context)
  if (!match) return 'ZZ'
  const issuedAt = Number(match[1])
  const now = (options.now ?? Date.now()) / 1000
  if (issuedAt > now + 30 || issuedAt + DEMO_VISITOR_TTL_SECONDS <= now) return 'ZZ'
  const country = match[2]
  const signature = new Uint8Array(32)
  for (let i = 0; i < signature.length; i++)
    signature[i] = Number.parseInt(match[3].slice(i * 2, i * 2 + 2), 16)
  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(`qivo-demo-visitor-v1:${issuedAt}:${country}`),
    )
    return valid ? country : 'ZZ'
  } catch {
    return 'ZZ'
  }
}
