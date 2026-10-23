import { describe, expect, it } from 'vitest'
import { appPermissions, restrictPermissions } from './permissions'

type Session = Parameters<typeof restrictPermissions>[0]
type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
type DeviceHandler = NonNullable<Parameters<Session['setDevicePermissionHandler']>[0]>
type Permission = Parameters<RequestHandler>[1]

const APP = 'https://qivo.io'
const page = {} as Electron.WebContents

/** Installs the policy on a stand-in session and keeps the handlers it sets. */
function install(appOrigin = APP) {
  const handlers: { request?: RequestHandler; check?: CheckHandler; device?: DeviceHandler } = {}
  restrictPermissions(
    {
      setPermissionRequestHandler: (handler) => {
        handlers.request = handler ?? undefined
      },
      setPermissionCheckHandler: (handler) => {
        handlers.check = handler ?? undefined
      },
      setDevicePermissionHandler: (handler) => {
        handlers.device = handler ?? undefined
      },
    },
    appOrigin,
  )
  const { request, check, device } = handlers
  if (!request || !check || !device) throw new Error('a permission handler is missing')
  /** What the request handler answers for a frame showing `url`. */
  const requests = (permission: Permission, url: string, isMainFrame = true) => {
    let answer: boolean | undefined
    request(
      page,
      permission,
      (granted) => {
        answer = granted
      },
      { requestingUrl: url, isMainFrame },
    )
    if (answer === undefined) throw new Error('the request was never answered')
    return answer
  }
  /** What the check handler answers for a frame of `origin`. */
  const checks = (
    permission: Permission,
    origin: string,
    isMainFrame = true,
    contents: Electron.WebContents | null = page,
  ) => check(contents, permission, origin, { isMainFrame })
  return { requests, checks, device }
}

// Every permission Qivo does not use, as Electron 44 names them.
const unused: Permission[] = [
  'ar',
  'automatic-fullscreen',
  'background-fetch',
  'background-sync',
  'captured-surface-control',
  'clipboard-read',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'geolocation-approximate',
  'hand-tracking',
  'hid',
  'idle-detection',
  'keyboardLock',
  'local-fonts',
  'local-network',
  'local-network-access',
  'loopback-network',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'nfc',
  'notifications',
  'openExternal',
  'payment-handler',
  'periodic-background-sync',
  'persistent-storage',
  'pointerLock',
  'screen-wake-lock',
  'sensors',
  'serial',
  'smart-card',
  'speaker-selection',
  'storage-access',
  'system-wake-lock',
  'top-level-storage-access',
  'usb',
  'vr',
  'web-app-installation',
  'web-printing',
  'window-management',
  'unknown',
]

describe('desktop permissions', () => {
  it('lets the Qivo page write to the clipboard', () => {
    expect([...appPermissions]).toEqual(['clipboard-sanitized-write'])
    const { requests, checks } = install()
    expect(requests('clipboard-sanitized-write', `${APP}/app/board`)).toBe(true)
    expect(checks('clipboard-sanitized-write', APP)).toBe(true)
    const local = install('http://localhost:5199')
    expect(local.requests('clipboard-sanitized-write', 'http://localhost:5199/app')).toBe(true)
    expect(local.checks('clipboard-sanitized-write', 'http://localhost:5199')).toBe(true)
  })

  it('refuses every other permission to the Qivo page', () => {
    const { requests, checks } = install()
    for (const permission of unused) {
      expect(requests(permission, `${APP}/app`), permission).toBe(false)
      expect(checks(permission, APP), permission).toBe(false)
    }
  })

  it('refuses every permission to other origins and to frames', () => {
    const { requests, checks } = install()
    const others = [
      'https://accounts.google.com/o/oauth2/v2/auth',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://evil.example',
      'https://qivo.io.evil.example/app',
      'https://staging.qivo.io/app',
      'http://qivo.io/app',
      'http://localhost:5199/app',
      'blob:https://qivo.io/0f8c1c1e-2c3b-4f6a-9d1e-5a7b8c9d0e1f',
      'data:text/html,<p>hi</p>',
      'null',
      '',
    ]
    for (const url of others) {
      for (const permission of [...appPermissions, ...unused]) {
        expect(requests(permission, url), `${permission} ${url}`).toBe(false)
        expect(checks(permission, url), `${permission} ${url}`).toBe(false)
      }
    }
    // a frame inside the Qivo page and a check made without a page
    expect(requests('clipboard-sanitized-write', `${APP}/app`, false)).toBe(false)
    expect(checks('clipboard-sanitized-write', APP, false)).toBe(false)
    expect(checks('clipboard-sanitized-write', APP, true, null)).toBe(false)
  })

  it('refuses every device', () => {
    const { device } = install()
    for (const deviceType of ['hid', 'serial', 'usb'] as const)
      expect(
        device({ deviceType, origin: APP, url: `${APP}/app`, device: {} as Electron.HIDDevice }),
      ).toBe(false)
  })
})
