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

const notifications = {
  supported: Boolean(
    process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux',
  ),
  get permission(): NotificationPermission {
    return ipcRenderer.sendSync('qivo:notifications:permission') as NotificationPermission
  },
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

const auth = {
  beginOAuth: async (): Promise<{ callbackURL: string }> =>
    (await ipcRenderer.invoke('qivo:auth:begin-oauth')) as { callbackURL: string },
  openOAuth: async (url: string): Promise<boolean> =>
    Boolean(await ipcRenderer.invoke('qivo:auth:open-oauth', url)),
}

contextBridge.exposeInMainWorld('qivoDesktop', {
  isElectron: true,
  platform: process.platform,
  notifications,
  updates,
  auth,
})
