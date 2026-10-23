import { isAppURL } from './navigation.js'

type Permission = Parameters<
  NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>
>[1]

type PermissionSession = Pick<
  Electron.Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'
>

/**
 * The permissions the Qivo web app uses in the desktop window. Copying a link,
 * text or an image writes through `navigator.clipboard`, which needs
 * `clipboard-sanitized-write`. Inbox alerts go through the preload bridge, not
 * the web Notification API, so the page never asks for `notifications`.
 */
export const appPermissions: ReadonlySet<Permission> = new Set(['clipboard-sanitized-write'])

/** Only the app origin's top-level page may hold a permission, and only one in appPermissions. */
function allows(
  permission: Permission,
  origin: string | undefined,
  isMainFrame: boolean,
  appOrigin: string,
): boolean {
  return (
    isMainFrame && appPermissions.has(permission) && Boolean(origin && isAppURL(origin, appOrigin))
  )
}

/**
 * Replaces Electron's default, which grants every permission request and check
 * to every page, with a list of what Qivo uses. Everything else is refused,
 * including every request from another origin, such as a sign-in provider's
 * page, and every device (HID, serial and USB) permission. Call this from
 * `session-created` so each session is covered from the moment it exists.
 */
export function restrictPermissions(session: PermissionSession, appOrigin: string): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(allows(permission, details.requestingUrl, details.isMainFrame, appOrigin))
  })
  session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      // a check without a page, such as a service worker's, gets nothing
      webContents !== null && allows(permission, requestingOrigin, details.isMainFrame, appOrigin),
  )
  session.setDevicePermissionHandler(() => false)
}
