import { contextBridge, ipcRenderer } from 'electron'

type NotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

type NotificationPayload = {
  tag: string
  title: string
  body: string
}

type UpdateState = {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error'
  version?: string
  message?: string
  blocked?: boolean
}

type Unsubscribe = () => void

type DesktopSettings = {
  startAtLogin: boolean
  closeToTray: boolean
  minimizeToTray: boolean
  showNotifications: boolean
}

type DesktopSettingsSnapshot = DesktopSettings & { startAtLoginError?: string }

const settings = {
  get: async (): Promise<DesktopSettingsSnapshot> =>
    (await ipcRenderer.invoke('qivo:settings:get')) as DesktopSettingsSnapshot,
  update: async (patch: Partial<DesktopSettings>): Promise<DesktopSettingsSnapshot> =>
    (await ipcRenderer.invoke('qivo:settings:update', patch)) as DesktopSettingsSnapshot,
}

const notifications = {
  supported: Boolean(
    process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux',
  ),
  // contextBridge copies a getter's value when it exposes the bridge, so
  // `permission` holds the value at the page's load; currentPermission()
  // reads it again, as the notification leader needs after a settings save
  get permission(): NotificationPermission {
    return ipcRenderer.sendSync('qivo:notifications:permission') as NotificationPermission
  },
  currentPermission: (): NotificationPermission =>
    ipcRenderer.sendSync('qivo:notifications:permission') as NotificationPermission,
  requestPermission: async (): Promise<NotificationPermission> =>
    (await ipcRenderer.invoke('qivo:notifications:request-permission')) as NotificationPermission,
  show: async (payload: NotificationPayload): Promise<boolean> =>
    Boolean(await ipcRenderer.invoke('qivo:notifications:show', payload)),
  onClick: (listener: (tag: string) => void): Unsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, tag: unknown) => {
      if (typeof tag === 'string') listener(tag)
    }
    ipcRenderer.on('qivo:notifications:click', handler)
    return () => ipcRenderer.removeListener('qivo:notifications:click', handler)
  },
}

const updates = {
  getState: async (): Promise<UpdateState> =>
    (await ipcRenderer.invoke('qivo:updates:get-state')) as UpdateState,
  check: async (): Promise<UpdateState> =>
    (await ipcRenderer.invoke('qivo:updates:check')) as UpdateState,
  install: async (): Promise<boolean> => Boolean(await ipcRenderer.invoke('qivo:updates:install')),
  setBlocked: (blocked: boolean): void => {
    ipcRenderer.send('qivo:updates:set-blocked', blocked)
  },
  onState: (listener: (state: UpdateState) => void): Unsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state && typeof state === 'object') listener(state as UpdateState)
    }
    ipcRenderer.on('qivo:updates:state', handler)
    return () => ipcRenderer.removeListener('qivo:updates:state', handler)
  },
}

// The computer woke from sleep (main.ts forwards powerMonitor's resume).
const power = {
  onResume: (listener: () => void): Unsubscribe => {
    const handler = () => listener()
    ipcRenderer.on('qivo:power:resume', handler)
    return () => ipcRenderer.removeListener('qivo:power:resume', handler)
  },
}

type ExportDownloadAnswer =
  | { state: 'completed'; file: string; bytes: number }
  | { state: 'failed'; leftover: string }
  | { state: 'cancelled' | 'interrupted' | 'failed' | 'busy' | 'refused' }

// An organization export's download into the Downloads folder, answered
// when it finished (main.ts, exportDownload.ts). The shell takes only the
// export route's links and chooses the file itself.
const orgExport = {
  download: async (url: string): Promise<ExportDownloadAnswer> =>
    (await ipcRenderer.invoke('qivo:org-export:download', url)) as ExportDownloadAnswer,
}

const auth = {
  beginOAuth: async (): Promise<{ callbackURL: string }> =>
    (await ipcRenderer.invoke('qivo:auth:begin-oauth')) as { callbackURL: string },
  openOAuth: async (url: string): Promise<boolean> =>
    Boolean(await ipcRenderer.invoke('qivo:auth:open-oauth', url)),
}

contextBridge.exposeInMainWorld('qivoDesktop', {
  isElectron: true,
  platform: process.platform,
  settings,
  notifications,
  updates,
  power,
  orgExport,
  auth,
})
