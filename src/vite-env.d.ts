/// <reference types="vite/client" />

declare const __QIVO_BUILD_ID__: string

type QivoDesktopNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

type QivoDesktopSettings = {
  startAtLogin: boolean
  closeToTray: boolean
  minimizeToTray: boolean
  showNotifications: boolean
}

type QivoDesktopSettingsSnapshot = QivoDesktopSettings & {
  startAtLoginError?: string
}

type QivoDesktopUpdateState = {
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

type QivoDesktopBridge = {
  isElectron: true
  platform: string
  // Hosted web updates also reach older shells that do not expose settings.
  settings?: {
    get(): Promise<QivoDesktopSettingsSnapshot>
    update(patch: Partial<QivoDesktopSettings>): Promise<QivoDesktopSettingsSnapshot>
  }
  notifications: {
    supported: boolean
    readonly permission: QivoDesktopNotificationPermission
    requestPermission(): Promise<QivoDesktopNotificationPermission>
    show(payload: { tag: string; title: string; body: string }): Promise<boolean>
    onClick(listener: (tag: string) => void): () => void
  }
  updates: {
    getState(): Promise<QivoDesktopUpdateState>
    check(): Promise<QivoDesktopUpdateState>
    install(): Promise<boolean>
    setBlocked(blocked: boolean): void
    onState(listener: (state: QivoDesktopUpdateState) => void): () => void
  }
  auth: {
    beginOAuth(): Promise<{ callbackURL: string }>
    openOAuth(url: string): Promise<boolean>
  }
}

interface Window {
  qivoDesktop?: QivoDesktopBridge
}

/* `process` in the Convex sources this program reaches comes from @types/node,
   which sharp's types bring in through convex/backgroundPreviewProcessor.ts. */
