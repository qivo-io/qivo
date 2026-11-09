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
    /** the permission when the page loaded, which the bridge copies once */
    readonly permission: QivoDesktopNotificationPermission
    /** the permission now, from Show notifications and the platform; absent
        in a shell built before it, which installed test builds still run
        with each web release (lib/notify.ts canNotify) */
    currentPermission?(): QivoDesktopNotificationPermission
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
  /** The computer's wake from sleep, which the notification leader takes as
      a resume (lib/notificationLeader.ts); absent in a shell built before
      it, whose leader finds a sleep by its clock's gap instead. */
  power?: {
    onResume(listener: () => void): () => void
  }
  /** An organization export's download into the Downloads folder, answered
      when it finished (desktop/exportDownload.ts); absent in a shell built
      before it, where the export page takes the link way. */
  orgExport?: {
    download(url: string): Promise<QivoDesktopExportDownload>
  }
  auth: {
    beginOAuth(): Promise<{ callbackURL: string }>
    openOAuth(url: string): Promise<boolean>
  }
}

/** What the desktop app's export download answers: the saved file's name
    and bytes when it completed whole, else how it ended, with `leftover`
    naming a partial file in the Downloads folder the shell could not
    remove. */
type QivoDesktopExportDownload =
  | { state: 'completed'; file: string; bytes: number }
  | { state: 'failed'; leftover: string }
  | { state: 'cancelled' | 'interrupted' | 'failed' | 'busy' | 'refused' }

interface Window {
  qivoDesktop?: QivoDesktopBridge
}

/* `process` in the Convex sources this program reaches comes from @types/node,
   which sharp's types bring in through convex/backgroundPreviewProcessor.ts. */
