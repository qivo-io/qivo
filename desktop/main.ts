import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  shell,
  Tray,
} from 'electron'
import electronUpdater from 'electron-updater'
import { resolveAppURL } from './appURL.js'
import { createLeavePrompt } from './leavePrompt.js'
import { guardWindow, isOAuthProviderURL } from './navigation.js'
import { disableStagingUserId } from './privacy.js'
import { secureSession } from './session.js'
import { createDesktopSettingsStore, defaultDesktopSettings } from './settings.js'
import { appImagePath, createLoginStartup, startupArgument } from './startup.js'
import { refusedSwitchesIn } from './switches.js'
import { createUpdatePrompt } from './updatePrompt.js'
import { useBuiltInFeed } from './updates.js'

// electron-updater is CommonJS. Import its default namespace explicitly so
// Electron's native ESM loader does not rely on synthetic named exports.
const { autoUpdater } = electronUpdater

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (process.platform === 'linux') app.setDesktopName('io.qivo.desktop')
if (process.platform === 'win32') app.setAppUserModelId('io.qivo.desktop')
const appURL = resolveAppURL(app.isPackaged, process.env)

let mainWindow: BrowserWindow | null = null
let appTray: Tray | null = null
let quitting = false
let settingsStore: ReturnType<typeof createDesktopSettingsStore> | null = null
let settingsError: Error | null = null
let desktopSettings = { ...defaultDesktopSettings }
let pendingDeepLink: string | null = null
let pendingOAuth: { state: string; expiresAt: number } | null = null

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

type UpdateState = {
  status: UpdateStatus
  version?: string
  message?: string
  blocked: boolean
}

let updateState: UpdateState = { status: 'idle', blocked: false }
let updaterReady = false

function isAuthorizedRenderer(event: {
  sender: Electron.WebContents
  senderFrame: Electron.WebFrameMain | null
}): boolean {
  if (
    event.sender !== mainWindow?.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false
  try {
    return new URL(event.senderFrame.url).origin === appURL.origin
  } catch {
    return false
  }
}

function sendUpdateState(): void {
  mainWindow?.webContents.send('qivo:updates:state', updateState)
}

function setUpdateState(next: Partial<UpdateState>): UpdateState {
  updateState = { ...updateState, ...next }
  sendUpdateState()
  updateTrayMenu()
  return updateState
}

const updatePrompt = createUpdatePrompt({
  isAvailable: () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && updateState.status === 'downloaded'),
  isBlocked: () => updateState.blocked,
  confirmInstall: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Qivo',
      message: 'A new version of Qivo is ready.',
      detail: 'Qivo will restart to finish installing the update.',
    })
    return answer.response === 0
  },
  install: () => autoUpdater.quitAndInstall(false, true),
  showNotification: (version, onClick) => {
    if (!desktopSettings.showNotifications || !Notification.isSupported()) return false
    const notification = new Notification({
      title: 'Qivo update ready',
      body: `Qivo ${version} is ready to install.`,
    })
    notification.on('click', onClick)
    notification.show()
    return true
  },
})

function setupAutoUpdates(): void {
  // Never contact a feed while running from source, so local development and
  // browser smoke drives stay deterministic. A packaged build checks only the
  // feed built into it, and a build without one never checks.
  const checks = useBuiltInFeed(autoUpdater, {
    packaged: app.isPackaged,
    env: process.env,
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
  })
  if (!checks) return
  disableStagingUserId(autoUpdater)
  autoUpdater.autoDownload = true
  // Download in the background and finish on a normal app quit. A click on
  // the ready notification still offers an immediate, confirmed restart.
  // Linux .deb/.rpm updates invoke a privileged package manager. Only install
  // those after the explicit confirmation above; Windows and macOS can finish
  // their downloaded installer on a normal quit.
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'linux'
  updaterReady = true
  autoUpdater.on('checking-for-update', () =>
    setUpdateState({ status: 'checking', message: undefined }),
  )
  autoUpdater.on('update-available', (info) =>
    setUpdateState({ status: 'available', version: info.version, message: undefined }),
  )
  autoUpdater.on('download-progress', () => setUpdateState({ status: 'downloading' }))
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'not-available' }))
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', version: info.version, message: undefined })
    updatePrompt.notify(info.version)
  })
  autoUpdater.on('error', (error) =>
    setUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  // A failed check is transient (offline starts are common), so the shell
  // reports it to its update UI and carries on with the already-installed app.
  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    setUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  })
  // Keep a running desktop session current without interrupting it. The
  // updater downloads in the background and the install path still requires
  // the same safety lease and explicit restart confirmation.
  setInterval(
    () => {
      if (updateState.status === 'downloaded' || updateState.status === 'downloading') return
      void autoUpdater.checkForUpdates().catch(() => {
        // Offline checks are expected; the next interval retries.
      })
    },
    4 * 60 * 60 * 1000,
  )
}

function showNotification(payload: unknown): boolean {
  if (!desktopSettings.showNotifications) return false
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>
  const tag = typeof value.tag === 'string' ? value.tag.slice(0, 256) : ''
  const title = typeof value.title === 'string' ? value.title.slice(0, 256) : ''
  const body = typeof value.body === 'string' ? value.body.slice(0, 4_096) : ''
  if (!tag || !title) return false
  if (!Notification.isSupported()) return false
  try {
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      showWindow()
      mainWindow?.webContents.send('qivo:notifications:click', tag)
    })
    notification.show()
    return true
  } catch {
    return false
  }
}

function notificationPermission(): 'default' | 'granted' | 'denied' | 'unsupported' {
  if (!Notification.isSupported()) return 'unsupported'
  return desktopSettings.showNotifications ? 'granted' : 'denied'
}

function parseOAuthCallback(
  rawURL: string,
): { state: string; ott?: string; error?: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawURL)
  } catch {
    return null
  }
  if (parsed.protocol !== 'qivo:' || parsed.hostname !== 'auth') return null
  const state = parsed.searchParams.get('state') || ''
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) return null
  const ott = parsed.searchParams.get('ott') || undefined
  const error = parsed.searchParams.get('error') || undefined
  if (!ott && !error) return null
  if (ott && !/^[a-zA-Z0-9._~-]{8,2048}$/.test(ott)) return null
  if (error && !/^[A-Z0-9_:-]{1,128}$/i.test(error)) return null
  return { state, ...(ott ? { ott } : {}), ...(error ? { error } : {}) }
}

function consumeDeepLink(rawURL: string): void {
  const callback = parseOAuthCallback(rawURL)
  if (!callback || !pendingOAuth || pendingOAuth.expiresAt < Date.now()) return
  if (callback.state !== pendingOAuth.state) return
  pendingOAuth = null
  const target = new URL(appURL.href)
  target.pathname = target.pathname.replace(/\/$/, '') || '/app'
  if (callback.ott) target.searchParams.set('ott', callback.ott)
  if (callback.error) target.searchParams.set('error', callback.error)
  target.searchParams.delete('desktop_auth')
  if (mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(target.href)
    showWindow()
  } else {
    pendingDeepLink = target.href
  }
}

function registerProtocol(): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux')
    return
  if (process.defaultApp) {
    // Electron's development launcher needs the script path in the registration.
    app.setAsDefaultProtocolClient('qivo', process.execPath, [path.resolve(process.argv[1] || '')])
  } else {
    app.setAsDefaultProtocolClient('qivo')
  }
}

function initializeSettings(): void {
  settingsError = null
  settingsStore = null
  try {
    const startup = createLoginStartup({
      platform: process.platform,
      packaged: app.isPackaged,
      executablePath: process.execPath,
      appImagePath: appImagePath(process.execPath, process.env),
      configDirectory: app.getPath('appData'),
      loginItems: app,
    })
    settingsStore = createDesktopSettingsStore({
      filePath: path.join(app.getPath('userData'), 'desktop-settings.json'),
      getStartAtLogin: startup.get,
      setStartAtLogin: startup.set,
    })
    desktopSettings = settingsStore.get()
    settingsStore.initialize()
    desktopSettings = settingsStore.get()
  } catch (error) {
    settingsError =
      error instanceof Error ? error : new Error('Qivo could not load desktop settings.')
    // A damaged preferences file must not silently replace a saved opt-out or
    // leave a startup window hidden while the user needs to fix the problem.
    if (!settingsStore)
      desktopSettings = {
        startAtLogin: false,
        closeToTray: false,
        minimizeToTray: false,
        showNotifications: false,
      }
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateTrayMenu(): void {
  if (!appTray || appTray.isDestroyed()) return
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Qivo', click: showWindow },
      ...(updateState.status === 'downloaded'
        ? [
            {
              label: 'Restart and update',
              enabled: !updateState.blocked,
              click: () => {
                showWindow()
                void updatePrompt.install()
              },
            },
          ]
        : []),
      { type: 'separator' },
      { label: 'Quit Qivo', click: () => app.quit() },
    ]),
  )
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/qivo.png'))
    if (icon.isEmpty()) throw new Error('Qivo tray icon is unavailable.')
    appTray = new Tray(icon.resize({ width: 24, height: 24 }))
    appTray.setToolTip('Qivo')
    updateTrayMenu()
    appTray.on('click', showWindow)
  } catch {
    appTray?.destroy()
    appTray = null
  }
}

function createWindow(startHidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111113',
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenu(null)
  guardWindow(mainWindow.webContents, appURL.origin, (url) => void shell.openExternal(url))
  const win = mainWindow
  win.webContents.on(
    'will-prevent-unload',
    createLeavePrompt({
      // a quit from the tray can find the window hidden; show what is at stake
      ask: (options) => {
        showWindow()
        return dialog.showMessageBoxSync(win, options)
      },
      // a quit that the page held back is over; closing hides to the tray again
      onStay: () => {
        quitting = false
      },
    }),
  )
  mainWindow.on('close', (event) => {
    if (quitting || !desktopSettings.closeToTray) return
    event.preventDefault()
    if (appTray && !appTray.isDestroyed()) mainWindow?.hide()
    else mainWindow?.minimize()
  })
  mainWindow.on('minimize', () => {
    if (desktopSettings.minimizeToTray && appTray && !appTray.isDestroyed()) mainWindow?.hide()
  })
  mainWindow.on('session-end', () => {
    quitting = true
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(appURL.href)
  if (pendingDeepLink) {
    const target = pendingDeepLink
    pendingDeepLink = null
    void mainWindow.loadURL(target)
  }
}

function installIPC(): void {
  ipcMain.handle('qivo:settings:get', (event) => {
    if (!isAuthorizedRenderer(event)) throw new Error('unauthorized')
    if (settingsError) initializeSettings()
    if (settingsError) throw settingsError
    return settingsStore?.get() ?? { ...desktopSettings }
  })
  ipcMain.handle('qivo:settings:update', (event, value: unknown) => {
    if (!isAuthorizedRenderer(event)) throw new Error('unauthorized')
    if (settingsError) initializeSettings()
    if (settingsError) throw settingsError
    if (!settingsStore) throw settingsError || new Error('Desktop settings are unavailable.')
    const previous = desktopSettings
    desktopSettings = settingsStore.update(value)
    settingsError = null
    if (!previous.showNotifications && desktopSettings.showNotifications && updateState.version)
      updatePrompt.notify(updateState.version)
    return settingsStore.get()
  })
  ipcMain.on('qivo:notifications:permission', (event) => {
    if (!isAuthorizedRenderer(event)) {
      event.returnValue = 'denied'
      return
    }
    event.returnValue = notificationPermission()
  })
  ipcMain.handle('qivo:notifications:request-permission', (event) => {
    if (!isAuthorizedRenderer(event)) return 'denied'
    return notificationPermission()
  })
  ipcMain.handle('qivo:notifications:show', (event, payload: unknown) => {
    if (!isAuthorizedRenderer(event)) return false
    return showNotification(payload)
  })
  ipcMain.handle('qivo:updates:get-state', (event) => {
    if (!isAuthorizedRenderer(event))
      return { status: 'error', message: 'unauthorized', blocked: true }
    return updateState
  })
  ipcMain.handle('qivo:updates:check', async (event) => {
    if (!isAuthorizedRenderer(event) || !updaterReady) return updateState
    setUpdateState({ status: 'checking', message: undefined })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      setUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return updateState
  })
  ipcMain.handle('qivo:updates:install', async (event) => {
    if (!isAuthorizedRenderer(event) || !updaterReady || updateState.blocked) return false
    return updatePrompt.install()
  })
  ipcMain.on('qivo:updates:set-blocked', (event, value: unknown) => {
    if (!isAuthorizedRenderer(event) || typeof value !== 'boolean') return
    const wasBlocked = updateState.blocked
    setUpdateState({ blocked: value })
    if (wasBlocked && !value && updateState.status === 'downloaded' && updateState.version)
      updatePrompt.notify(updateState.version)
  })
  ipcMain.handle('qivo:auth:begin-oauth', (event) => {
    if (!isAuthorizedRenderer(event)) throw new Error('unauthorized')
    const state = crypto.randomBytes(32).toString('base64url')
    pendingOAuth = { state, expiresAt: Date.now() + 10 * 60_000 }
    const callback = new URL(appURL.href)
    callback.search = ''
    callback.pathname = callback.pathname.replace(/\/$/, '') || '/app'
    callback.searchParams.set('desktop_auth', state)
    return { callbackURL: callback.href }
  })
  ipcMain.handle('qivo:auth:open-oauth', (event, rawURL: unknown) => {
    if (!isAuthorizedRenderer(event) || typeof rawURL !== 'string') return false
    if (!isOAuthProviderURL(rawURL)) return false
    // Keep provider sign-in in the system browser. The registered qivo://
    // protocol returns the one-time result to this shell after the callback.
    void shell.openExternal(new URL(rawURL).href)
    return true
  })
}

const refusedSwitches = refusedSwitchesIn(app.isPackaged, app.commandLine)
if (refusedSwitches.length > 0) {
  // Before ready this shows a dialog on Windows and writes to stderr on Linux.
  dialog.showErrorBox(
    'Qivo cannot start',
    `Qivo does not start with ${refusedSwitches.join(', ')}. Start it without ${refusedSwitches.length > 1 ? 'them' : 'it'}.`,
  )
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Register before ready so the window's session and electron-updater's
  // session are both covered from the moment they exist.
  app.on('session-created', (session) => secureSession(session, appURL.origin, process.platform))
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find((arg) => arg.startsWith('qivo://'))
    if (deepLink) consumeDeepLink(deepLink)
    if (deepLink || !commandLine.includes(startupArgument)) showWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    consumeDeepLink(url)
  })
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    initializeSettings()
    registerProtocol()
    installIPC()
    createTray()
    createWindow(
      Boolean(
        appTray &&
          !settingsError &&
          !settingsStore?.get().startAtLoginError &&
          process.argv.includes(startupArgument),
      ),
    )
    setupAutoUpdates()
    const startupDeepLink = process.argv.find((arg) => arg.startsWith('qivo://'))
    if (startupDeepLink) consumeDeepLink(startupDeepLink)
    app.on('activate', showWindow)
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    appTray?.destroy()
    appTray = null
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
