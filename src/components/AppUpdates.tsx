import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type AppUpdateState, createAppUpdateMonitor } from '../lib/appUpdates'
import { isUpdateBlocked, subscribeUpdateSafety } from '../lib/updateSafety'
import { Button } from './ui/button'

export function AppUpdates() {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [noticeHidden, setNoticeHidden] = useState(false)
  const monitorRef = useRef<ReturnType<typeof createAppUpdateMonitor> | null>(null)

  // The Electron shell owns downloading and installing native updates. Keep
  // its restart guard in sync with the same draft/save leases used by the web
  // update monitor, so a Windows update can never interrupt an edit.
  useEffect(() => {
    const desktop = window.qivoDesktop?.updates
    if (!desktop) return
    const publish = () => desktop.setBlocked(isUpdateBlocked())
    publish()
    return subscribeUpdateSafety(publish)
  }, [])

  useEffect(() => {
    // Hiding a notice makes room for the editor. Once work finishes, show
    // the imminent update again; the queued version and safety leases persist.
    if (!state?.available || !state.blocked) setNoticeHidden(false)
  }, [state?.available, state?.blocked])

  useEffect(() => {
    // Vite HMR owns development reloads. The build ID and manifest belong to
    // production builds, including a local `vite preview` verification.
    if (!import.meta.env.PROD) return
    let pointerDown = false
    let composing = false
    const editableFocused = () =>
      document.activeElement?.matches(
        'input:not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"], [contenteditable=""]',
      ) ?? false
    const monitor = createAppUpdateMonitor({
      buildId: __QIVO_BUILD_ID__,
      fetchVersion: async () => {
        const response = await fetch(`/version.json?t=${Date.now()}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
          throw new Error('Version unavailable')
        return response.json()
      },
      isBlocked: () => isUpdateBlocked() || pointerDown || composing || editableFocused(),
      isVisible: () =>
        document.visibilityState === 'visible' && document.hasFocus() && navigator.onLine,
      reload: () => window.location.reload(),
      onChange: setState,
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
    })
    monitorRef.current = monitor
    const activity = () => monitor.activity()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-app-update]')) return
      pointerDown = true
      activity()
    }
    const onPointerUp = () => {
      pointerDown = false
      activity()
    }
    const onCompositionStart = () => {
      composing = true
      activity()
    }
    const onCompositionEnd = () => {
      composing = false
      activity()
    }
    const wake = () => {
      pointerDown = false
      activity()
      if (document.visibilityState === 'visible' && navigator.onLine) void monitor.check()
    }
    const events = ['keydown', 'input', 'change', 'focusin', 'focusout'] as const
    for (const event of events) document.addEventListener(event, activity, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    window.addEventListener('blur', onPointerUp)
    document.addEventListener('compositionstart', onCompositionStart, true)
    document.addEventListener('compositionend', onCompositionEnd, true)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    window.addEventListener('vite:preloadError', wake)
    const unsubscribe = subscribeUpdateSafety(activity)
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void monitor.check()
    }, 60_000)
    void monitor.check()
    return () => {
      monitor.dispose()
      monitorRef.current = null
      unsubscribe()
      clearInterval(interval)
      for (const event of events) document.removeEventListener(event, activity, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('blur', onPointerUp)
      document.removeEventListener('compositionstart', onCompositionStart, true)
      document.removeEventListener('compositionend', onCompositionEnd, true)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('vite:preloadError', wake)
    }
  }, [])

  // Radix dialogs hide the app root from assistive technology. Keep this
  // live region mounted outside that root before a draft dialog can open.
  return createPortal(
    <div aria-live="polite" aria-atomic="true">
      {state?.available && !noticeHidden && (
        <div
          data-app-update
          data-floating-surface
          // The notice is outside modal DOM. Its controls must not count as
          // an outside press that closes the very draft holding this update.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          className="pointer-events-auto fixed top-4 left-1/2 z-[10000] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl min-[761px]:top-auto min-[761px]:bottom-4"
        >
          <div className="min-w-0 flex-1 basis-60 text-sm">
            <div className="font-semibold">A new version of Qivo is ready</div>
            <div className="mt-1 text-muted-foreground">
              {state.reloading
                ? 'Updating Qivo…'
                : state.blocked
                  ? 'Finish or discard your edits. Qivo will update when you’re ready.'
                  : state.automaticPaused
                    ? 'Reload to update Qivo.'
                    : 'Qivo will update automatically in a moment.'}
            </div>
          </div>
          <Button
            variant="outline"
            disabled={state.blocked || state.reloading}
            onClick={() => monitorRef.current?.reloadNow()}
          >
            Reload now
          </Button>
          {state.blocked && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1"
              onClick={() => setNoticeHidden(true)}
            >
              <X size={14} aria-hidden="true" />
              Hide notice
            </Button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
