/** Sign-in providers whose pages the shell hands to the system browser. */
const oauthHosts = new Set(['accounts.google.com', 'login.microsoftonline.com', 'login.live.com'])

function parse(rawURL: string): URL | null {
  try {
    return new URL(rawURL)
  } catch {
    return null
  }
}

/**
 * Whether `rawURL` is a web page of the Qivo origin the window loads. Convex
 * endpoints and other Qivo subdomains are other origins, so they open
 * externally instead of becoming a renderer document. The protocol check
 * keeps out blob: URLs, whose origin is the page that made them.
 */
export function isAppURL(rawURL: string, appOrigin: string): boolean {
  const url = parse(rawURL)
  return Boolean(url && ['http:', 'https:'].includes(url.protocol) && url.origin === appOrigin)
}

/** Whether `rawURL` is an HTTPS page of a sign-in provider Qivo offers. */
export function isOAuthProviderURL(rawURL: string): boolean {
  const url = parse(rawURL)
  return url?.protocol === 'https:' && oauthHosts.has(url.hostname)
}

/** Whether the system may open `rawURL` for a link: a web page, an email address or a phone number. */
export function opensExternally(rawURL: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(rawURL)
}

type NavigationEvent = { url: string; isMainFrame: boolean; preventDefault: () => void }

/**
 * Handles `will-navigate` and `will-redirect`. Only the app origin's pages
 * load in the window, so a link or a server redirect to any other page, sign-in
 * providers included, goes to the system instead. Provider sign-in already runs
 * in the system browser (`qivo:auth:open-oauth`). Subframes are left alone:
 * Qivo pages embed none, and a subframe gets no permission and no IPC.
 */
export function createNavigationGuard(appOrigin: string, openExternal: (url: string) => void) {
  return (event: NavigationEvent): void => {
    if (!event.isMainFrame || isAppURL(event.url, appOrigin)) return
    event.preventDefault()
    if (opensExternally(event.url)) openExternal(event.url)
  }
}

/**
 * Handles `window.open` and links that target a new window. The shell opens
 * no second window: the system opens a link to another site, and a link to a
 * Qivo page does nothing.
 */
export function createWindowOpenHandler(appOrigin: string, openExternal: (url: string) => void) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    if (opensExternally(url) && !isAppURL(url, appOrigin)) openExternal(url)
    return { action: 'deny' }
  }
}

type GuardedContents = {
  setWindowOpenHandler(handler: ReturnType<typeof createWindowOpenHandler>): void
  on(event: 'will-navigate', listener: (event: NavigationEvent) => void): unknown
  on(event: 'will-redirect', listener: (event: NavigationEvent) => void): unknown
}

/**
 * Installs the navigation limits on a window's contents: the window-open
 * handler, and the guard for both links (`will-navigate`) and server
 * redirects (`will-redirect`).
 */
export function guardWindow(
  contents: GuardedContents,
  appOrigin: string,
  openExternal: (url: string) => void,
): void {
  contents.setWindowOpenHandler(createWindowOpenHandler(appOrigin, openExternal))
  const guard = createNavigationGuard(appOrigin, openExternal)
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
}
