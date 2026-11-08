/* Desktop notifications for inbox messages. Thin wrapper over the browser
   Notification API and the desktop app's bridge: permission is only ever
   requested from a user gesture (the Inbox's "Enable notifications"
   affordance), firing is a no-op unless granted, and the tag (the event's
   key) lets the OS coalesce one event across browsers. Which session shows
   an alert the server decides (convex/notifications.ts claimAlerts), and
   the feed client asks it (lib/notificationFeed.ts). Every would-be
   notification is also mirrored onto window.__qivoNotes so drives can
   assert without an OS surface. */

/* the verify-drive mirror — every would-be notification lands here too */
declare global {
  interface Window {
    __qivoNotes?: { tag: string; title: string; body: string }[]
  }
}

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

/* Who hears that a permission request settled (onNotificationPermission). */
const permissionListeners = new Set<() => void>()

/** Calls `listener` each time a permission request settles, so the feed
    client reads the capability again at once. Answers the unsubscribe. */
export function onNotificationPermission(listener: () => void): () => void {
  permissionListeners.add(listener)
  return () => permissionListeners.delete(listener)
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  try {
    return await askPermission()
  } finally {
    for (const listener of permissionListeners) listener()
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
    /* constructor can throw (e.g. some mobile browsers) — silently skip */
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
