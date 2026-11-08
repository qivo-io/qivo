/* Desktop notifications for inbox messages. Thin wrapper over the browser
   Notification API and the desktop app's bridge: permission is only ever
   requested from a user gesture (the Inbox's "Enable notifications"
   affordance, and in the desktop app its Show notifications switch), never
   by the Notification delivery control, firing is a no-op unless granted,
   and the tag (the event's key) lets the OS coalesce one event across
   browsers. Which session shows an alert the server decides
   (convex/notifications.ts claimAlerts), the feed client asks it
   (lib/notificationFeed.ts), and only the leader tab of a browser profile
   runs that client and calls desktopNotify (lib/notificationLeader.ts).
   Whether this page can show alerts at all is canNotify(), which the
   leader reports to the server as can_notify, and watchCapability() says
   when that changed. Every would-be notification is also mirrored onto
   window.__qivoNotes so drives can assert without an OS surface. */

/* the verify-drive mirror — every would-be notification lands here too */
declare global {
  interface Window {
    __qivoNotes?: { tag: string; title: string; body: string }[]
  }
}

/* The navigator with Chromium's user agent client hints, absent elsewhere. */
type HintedNavigator = Navigator & { userAgentData?: { platform?: string } }

export function notificationsSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (window.qivoDesktop) return window.qivoDesktop.notifications.supported
  return 'Notification' in window
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window !== 'undefined' && window.qivoDesktop)
    return window.qivoDesktop.notifications.permission
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

/* Set once `new Notification` threw on this page, as it does where pages
   must show alerts through a service worker, so the page reports that it
   cannot notify for the rest of its life. */
let constructorFailed = false

/** Whether a page's own `new Notification` shows alerts on this platform:
    false on a phone or tablet, iOS and iPadOS read as lib/pageHistory.ts
    reads them and Android by its client hints' platform, else its user
    agent, and false once the constructor threw here. */
export function pageAlertsWork(): boolean {
  if (constructorFailed) return false
  try {
    const nav: HintedNavigator = navigator
    const platform = nav.platform ?? ''
    if (/^iP(hone|ad|od)/.test(platform)) return false
    if (platform === 'MacIntel' && nav.maxTouchPoints > 1) return false
    const hinted = nav.userAgentData?.platform
    if (hinted !== undefined) return hinted !== 'Android'
    return !/Android/.test(nav.userAgent ?? '')
  } catch {
    return false
  }
}

/** Whether this page can show desktop alerts now, which the leader tab
    reports to the server as `can_notify`: in the desktop app, its bridge's
    answer alone, read afresh, from Show notifications and the platform; in a browser, a
    granted permission on a platform whose pages can show alerts
    (pageAlertsWork). Anything it cannot read answers false. */
export function canNotify(): boolean {
  try {
    if (typeof window === 'undefined') return false
    // the bridge's `permission` is the value at the page's load
    if (window.qivoDesktop)
      return window.qivoDesktop.notifications.currentPermission() === 'granted'
    return 'Notification' in window && Notification.permission === 'granted' && pageAlertsWork()
  } catch {
    return false
  }
}

/* Who reads canNotify() again when it may have changed (watchCapability). */
const capabilityReaders = new Set<() => void>()

/* Has every capability watcher read canNotify() again. */
function capabilityMayHaveChanged() {
  for (const read of capabilityReaders) read()
}

/** Tells the capability watchers that a desktop settings save answered, so
    the leader reads Show notifications again at once
    (panels/settings/DesktopSettings.tsx). */
export function noteCapabilityChange(): void {
  capabilityMayHaveChanged()
}

/**
 * Calls `listener` with canNotify()'s new value when it changed. It reads
 * the value again after a permission request settles, on the permission
 * status's `change` where the browser has one (never in the desktop app,
 * whose web permission the shell refuses), after noteCapabilityChange(),
 * after the constructor threw, and when the page becomes visible or takes
 * focus, and calls `listener` only when the value differs from the one it
 * last heard, or from the value at the start. Answers the unsubscribe.
 */
export function watchCapability(listener: (can: boolean) => void): () => void {
  let last = canNotify()
  let stopped = false
  const read = () => {
    if (stopped) return
    const now = canNotify()
    if (now === last) return
    last = now
    listener(now)
  }
  capabilityReaders.add(read)
  const stops: (() => void)[] = [() => capabilityReaders.delete(read)]
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const shown = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', shown)
    stops.push(() => document.removeEventListener('visibilitychange', shown))
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', read)
    stops.push(() => window.removeEventListener('focus', read))
  }
  const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions
  if (typeof window !== 'undefined' && !window.qivoDesktop && permissions?.query) {
    void permissions
      .query({ name: 'notifications' })
      .then((status) => {
        if (stopped) return
        status.addEventListener('change', read)
        stops.push(() => status.removeEventListener('change', read))
      })
      .catch(() => {
        /* a browser without a notifications permission status */
      })
  }
  return () => {
    stopped = true
    for (const stop of stops) stop()
  }
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  try {
    return await askPermission()
  } finally {
    capabilityMayHaveChanged()
  }
}

/* The permission request itself, from a user gesture. */
async function askPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  if (window.qivoDesktop) return window.qivoDesktop.notifications.requestPermission()
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

export function desktopNotify(tag: string, title: string, body: string, onClick?: () => void) {
  window.__qivoNotes ||= []
  window.__qivoNotes.push({ tag, title, body })
  const desktop = window.qivoDesktop
  if (desktop) {
    if (onClick) {
      keepClickHandler(tag, onClick)
      installDesktopClickBridge(desktop)
    }
    void desktop.notifications
      .show({ tag, title, body })
      .then((shown) => {
        if (!shown) desktopClickHandlers.delete(tag)
      })
      .catch(() => desktopClickHandlers.delete(tag))
    return
  }
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  try {
    const n = new Notification(title, { body, tag })
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        /* focus is best-effort */
      }
      if (onClick) onClick()
      n.close()
    }
  } catch {
    // the constructor throws where pages must show alerts through a service
    // worker (Chrome on Android), so the page reports it cannot notify
    constructorFailed = true
    capabilityMayHaveChanged()
  }
}

/** The most click handlers the desktop bridge keeps, one an alert shown,
    so a long session holds a bounded map: the oldest goes first. */
export const CLICK_HANDLERS = 100

/* The desktop alerts' click handlers by tag, oldest first. */
const desktopClickHandlers = new Map<string, () => void>()
let desktopClickUnsubscribe: (() => void) | undefined

/* Keeps `onClick` for tag `tag` as the newest, dropping the oldest past
   CLICK_HANDLERS. */
function keepClickHandler(tag: string, onClick: () => void) {
  desktopClickHandlers.delete(tag)
  desktopClickHandlers.set(tag, onClick)
  while (desktopClickHandlers.size > CLICK_HANDLERS) {
    const oldest = desktopClickHandlers.keys().next().value
    if (oldest === undefined) break
    desktopClickHandlers.delete(oldest)
  }
}

/** How many desktop click handlers are kept, for tests. */
export const keptClickHandlers = () => desktopClickHandlers.size

function installDesktopClickBridge(desktop: QivoDesktopBridge) {
  if (desktopClickUnsubscribe) return
  desktopClickUnsubscribe = desktop.notifications.onClick((tag) => {
    const handler = desktopClickHandlers.get(tag)
    desktopClickHandlers.delete(tag)
    handler?.()
  })
}
