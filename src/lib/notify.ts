/* Desktop notifications for inbox messages. Thin wrapper over the browser
   Notification API: permission is only ever requested from a user gesture
   (the Inbox's "Enable desktop notifications" affordance), firing is a no-op
   unless granted, and the tag (message id) lets the OS coalesce the same
   message across tabs. Every would-be notification is also mirrored onto
   window.__qivoNotes so drives can assert without an OS surface. */

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

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
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
      desktopClickHandlers.set(tag, onClick)
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

const desktopClickHandlers = new Map<string, () => void>()
let desktopClickUnsubscribe: (() => void) | undefined

function installDesktopClickBridge(desktop: QivoDesktopBridge) {
  if (desktopClickUnsubscribe) return
  desktopClickUnsubscribe = desktop.notifications.onClick((tag) => {
    const handler = desktopClickHandlers.get(tag)
    desktopClickHandlers.delete(tag)
    handler?.()
  })
}
