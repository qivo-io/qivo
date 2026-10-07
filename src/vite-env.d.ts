/// <reference types="vite/client" />

declare const __QIVO_BUILD_ID__: string

type QivoDesktopNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

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

/* The root tsc pass reaches the Convex function sources through
   src/store → convex/_generated/api.d.ts (the typed function references).
   Those files run in the Convex isolate and read process.env, and this
   project carries no @types/node on purpose — mirror convex/env.d.ts's
   minimal declaration (URL/console come from lib.dom here, so `process`
   is the only gap). Type-level only: nothing in the browser bundle reads it. */
declare const process: { env: Record<string, string | undefined> }
