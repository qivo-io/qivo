// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Whether this page can show desktop alerts (lib/notify.ts canNotify),
   which the leader tab reports as can_notify, and when that changes
   (watchCapability). */

/** A page Notification whose permission the case sets, and whose
    constructor throws while `throws` is set. */
class PageNotification {
  static permission: NotificationPermission = 'granted'
  static throws = false
  static requestPermission = async () => PageNotification.permission
  onclick: (() => void) | null = null
  constructor() {
    if (PageNotification.throws) throw new TypeError('Illegal constructor')
  }
  close() {}
}

/** Gives the navigator `fields` for this case. */
function navigatorWith(fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(window.navigator, key, { value, configurable: true })
}

const DESKTOP = {
  platform: 'Win32',
  maxTouchPoints: 0,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36',
  userAgentData: undefined,
}

beforeEach(() => {
  vi.resetModules()
  PageNotification.permission = 'granted'
  PageNotification.throws = false
  vi.stubGlobal('Notification', PageNotification)
  navigatorWith(DESKTOP)
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.qivoDesktop = undefined
  for (const key of [...Object.keys(DESKTOP), 'permissions'])
    Reflect.deleteProperty(window.navigator, key)
})

describe('canNotify', () => {
  it('is true only with a granted permission on a desktop platform', async () => {
    const { canNotify } = await import('./notify')
    expect(canNotify()).toBe(true)
    PageNotification.permission = 'default'
    expect(canNotify()).toBe(false)
    PageNotification.permission = 'denied'
    expect(canNotify()).toBe(false)
    vi.stubGlobal('Notification', undefined)
    Reflect.deleteProperty(window, 'Notification')
    expect(canNotify()).toBe(false)
  })

  it('is false on an iPhone, an iPad that reports a Mac with touch, and Android phones and tablets', async () => {
    const { canNotify } = await import('./notify')
    navigatorWith({ platform: 'iPhone' })
    expect(canNotify()).toBe(false)
    navigatorWith({ platform: 'MacIntel', maxTouchPoints: 5 })
    expect(canNotify()).toBe(false)
    navigatorWith({ platform: 'MacIntel', maxTouchPoints: 0 })
    expect(canNotify()).toBe(true)
    // a tablet's hints say Android without mobile
    navigatorWith({
      platform: 'Linux armv8l',
      userAgentData: { platform: 'Android', mobile: false },
    })
    expect(canNotify()).toBe(false)
    navigatorWith({ userAgentData: { platform: 'Linux', mobile: false } })
    expect(canNotify()).toBe(true)
    navigatorWith({
      userAgentData: undefined,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36',
    })
    expect(canNotify()).toBe(false)
  })

  it('is false for the rest of the page’s life once the constructor threw', async () => {
    const { canNotify, desktopNotify, watchCapability } = await import('./notify')
    const heard: boolean[] = []
    const stop = watchCapability((can) => heard.push(can))
    PageNotification.throws = true
    desktopNotify('m1', 'Ada mentioned you, Board rev C', 'Look at this')
    expect(canNotify()).toBe(false)
    expect(heard).toEqual([false])
    PageNotification.throws = false
    expect(canNotify()).toBe(false)
    stop()
  })

  it('takes the desktop app’s bridge alone, whatever the web permission says', async () => {
    const { canNotify } = await import('./notify')
    const bridge = (permission: QivoDesktopNotificationPermission) =>
      ({ notifications: { supported: true, permission } }) as unknown as QivoDesktopBridge
    PageNotification.permission = 'denied'
    window.qivoDesktop = bridge('granted')
    expect(canNotify()).toBe(true)
    PageNotification.permission = 'granted'
    window.qivoDesktop = bridge('denied')
    expect(canNotify()).toBe(false)
    window.qivoDesktop = bridge('unsupported')
    expect(canNotify()).toBe(false)
  })
})

describe('watchCapability', () => {
  it('hears a change after a permission request, the status’s change, a desktop save and a return to view, and nothing else', async () => {
    const status = new EventTarget()
    navigatorWith({ permissions: { query: async () => status } })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    PageNotification.permission = 'default'
    const notify = await import('./notify')
    const heard: boolean[] = []
    const stop = notify.watchCapability((can) => heard.push(can))
    await Promise.resolve()
    await Promise.resolve()
    // a request that grants
    PageNotification.permission = 'granted'
    await notify.requestNotificationPermission()
    expect(heard).toEqual([true])
    // a request that changes nothing says nothing
    await notify.requestNotificationPermission()
    expect(heard).toEqual([true])
    // the browser's settings revoke it
    PageNotification.permission = 'denied'
    status.dispatchEvent(new Event('change'))
    expect(heard).toEqual([true, false])
    // a change nobody announced is read when the page shows again
    PageNotification.permission = 'granted'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(heard).toEqual([true, false, true])
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    expect(heard).toEqual([true, false, true])
    // the desktop app's Show notifications, after its save
    window.qivoDesktop = {
      notifications: { supported: true, permission: 'denied' },
    } as unknown as QivoDesktopBridge
    notify.noteCapabilityChange()
    expect(heard).toEqual([true, false, true, false])
    stop()
    window.qivoDesktop = undefined
    notify.noteCapabilityChange()
    status.dispatchEvent(new Event('change'))
    expect(heard).toHaveLength(4)
  })
})
