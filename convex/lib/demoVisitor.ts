/** Broad, declared browser/OS categories for aggregate demo analytics. Never
 * persist raw User-Agent, IP address or any location. */
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
