import { ConvexError } from 'convex/values'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../convex/_generated/api'
import { AppearanceProvider } from './AppearanceProvider'
import { AppUpdates } from './components/AppUpdates'
import { Button } from './components/ui/button'
import { armConvexAuth, authClient, clearLocalSession } from './lib/auth'
import { convex } from './lib/convex'
import { DEMO_ENDED_EVENT, WORKSPACE_SIGNUP_URL } from './lib/demoMode'
import {
  DEMO_MARKER_KEY,
  type DemoLifecycle,
  DemoSessionEnded,
  demoCountdown,
  demoStartupStep,
  readDemoMarker,
  runDemoStartup,
  saveDemoMarker,
  startDemo,
} from './lib/demoSession'
import { demoVisitorContext } from './lib/demoVisitor'
import { lazyFromModule } from './lib/lazyModule'
import { loadWorkspace, preloadWorkspacePage } from './lib/workspacePreload'
import { disposeDemoStore, initStore } from './store/planner'

const App = lazyFromModule(loadWorkspace, (module) => module.default)

type Phase = 'intro' | 'preparing' | 'ready' | 'expired' | 'lost' | 'error'

function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === 'object' && error.data?.message)
    return String(error.data.message)
  return error instanceof Error ? error.message : 'Please try again in a moment.'
}

export function DemoGate() {
  const [phase, setPhase] = useState<Phase>(() =>
    readDemoMarker(localStorage) ? 'preparing' : 'intro',
  )
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const lifecycle = useRef<DemoLifecycle | null>(null)
  const active = useRef(true)
  const ended = useRef(false)
  const stopLifecycle = useRef<(() => void) | null>(null)
  const stopStartup = useRef<AbortController | null>(null)
  const creationRequested = useRef(false)
  const clock = useRef({ received: 0, remaining: 0, serverNow: 0 })

  const end = useCallback((next: 'expired' | 'lost') => {
    if (ended.current) return
    ended.current = true
    creationRequested.current = false
    stopStartup.current?.abort(new DemoSessionEnded(next))
    stopLifecycle.current?.()
    stopLifecycle.current = null
    const marker = readDemoMarker(localStorage)
    saveDemoMarker(localStorage, {
      state: next,
      expiresAt: lifecycle.current?.expiresAt ?? marker?.expiresAt ?? null,
    })
    // Unmount editors and discard their local state. No final save or browser
    // reload may put an expired snapshot back on screen.
    disposeDemoStore()
    clearLocalSession()
    if (active.current) setPhase(next)
  }, [])

  useEffect(() => {
    active.current = true
    ended.current = false
    if (!readDemoMarker(localStorage) && !creationRequested.current) {
      setPhase('intro')
      return () => {
        active.current = false
      }
    }
    let cancelled = false
    const controller = new AbortController()
    stopStartup.current = controller
    const acceptLifecycle = (value: DemoLifecycle) => {
      if (cancelled || ended.current) return
      lifecycle.current = value
      if (value.status !== 'ready' || !value.expiresAt) {
        end(value.status === 'missing' ? 'lost' : 'expired')
        return
      }
      clock.current = {
        received: performance.now(),
        remaining: Math.max(0, value.expiresAt - value.serverNow),
        serverNow: value.serverNow,
      }
      setRemaining(clock.current.remaining)
      saveDemoMarker(localStorage, { state: 'started', expiresAt: value.expiresAt })
      if (clock.current.remaining <= 0) end('expired')
    }
    setPhase('preparing')
    setError('')
    void runDemoStartup(async (signal) => {
      if (cancelled) return
      const result = await startDemo(
        {
          storage: localStorage,
          create: creationRequested.current,
          configuration: () => convex.query(api.demo.configuration, {}),
          hasSession: async () => {
            const session = await authClient.getSession({
              query: { disableCookieCache: true },
              fetchOptions: { signal },
            })
            if (session.error) throw new Error('Could not reach the demo sign-in service.')
            return !!session.data?.session
          },
          signIn: async () => {
            const context = await demoVisitorContext(signal)
            signal.throwIfAborted()
            const result = await authClient.signIn.anonymous({
              fetchOptions: {
                signal,
                ...(context ? { headers: { 'X-Qivo-Demo-Visitor': context } } : {}),
              },
            })
            if (result.error) throw new Error(result.error.message || 'Could not start your demo.')
          },
          authenticate: armConvexAuth,
          current: () => convex.query(api.demo.current, {}),
          ensureMine: () => convex.mutation(api.demo.ensureMine, {}),
        },
        signal,
      )
      if (cancelled) return
      if (!result) {
        setPhase('intro')
        return
      }
      signal.throwIfAborted()
      acceptLifecycle(result)
      if (ended.current) return
      stopLifecycle.current = convex.onUpdate(api.demo.current, {}, acceptLifecycle, () => {
        // A connection drop normally stays pending in Convex. A reported
        // lifecycle refusal must never preserve editable workspace data.
        if (!cancelled) end('lost')
      })
      const openingPath = ['/', '/app', '/app/'].includes(location.pathname)
        ? `/app/${result.orgSlug}/board/all`
        : location.pathname
      preloadWorkspacePage(openingPath, location.hash)
      const [ready] = await demoStartupStep(
        () => Promise.all([initStore(), loadWorkspace()]),
        signal,
      )
      if (cancelled || ended.current) return
      signal.throwIfAborted()
      if (!ready) throw new DemoSessionEnded('lost')
      if (['/', '/app', '/app/'].includes(location.pathname))
        history.replaceState(null, '', `/app/${result.orgSlug}/board/all`)
      setPhase('ready')
    }, controller.signal).catch((error) => {
      if (cancelled || ended.current) return
      if (error instanceof DemoSessionEnded) {
        end(error.phase)
        return
      }
      if (error instanceof ConvexError && typeof error.data === 'object') {
        if (error.data?.reason === 'demo_expired') {
          end('expired')
          return
        }
        if (error.data?.reason === 'demo_unavailable') {
          end('lost')
          return
        }
      }
      cancelled = true
      active.current = false
      creationRequested.current = false
      controller.abort(error)
      stopLifecycle.current?.()
      stopLifecycle.current = null
      lifecycle.current = null
      disposeDemoStore()
      setError(errorMessage(error))
      setPhase('error')
    })
    return () => {
      cancelled = true
      active.current = false
      controller.abort()
      if (stopStartup.current === controller) stopStartup.current = null
      stopLifecycle.current?.()
      stopLifecycle.current = null
    }
  }, [attempt, end])

  useEffect(() => {
    const tick = () => {
      if (!lifecycle.current || ended.current) return
      const value = Math.max(
        0,
        clock.current.remaining - (performance.now() - clock.current.received),
      )
      setRemaining(value)
      if (!value) end('expired')
    }
    const wake = () => {
      tick()
      if (ended.current || !lifecycle.current) return
      // Sleep/resume and a changed wall clock cannot renew the server's TTL.
      void convex
        .query(api.demo.current, {})
        .then((value) => {
          if (ended.current || !active.current) return
          if (value.status !== 'ready' || !value.expiresAt) {
            end(value.status === 'missing' ? 'lost' : 'expired')
            return
          }
          // Convex may reuse an unchanged query result. Its old server timestamp
          // must never reset the elapsed clock on focus or reconnection.
          if (value.serverNow > clock.current.serverNow)
            clock.current = {
              received: performance.now(),
              remaining: Math.max(0, value.expiresAt - value.serverNow),
              serverNow: value.serverNow,
            }
          tick()
        })
        .catch(() => end('lost'))
    }
    const refused = (event: Event) =>
      end((event as CustomEvent).detail === 'lost' ? 'lost' : 'expired')
    const storage = (event: StorageEvent) => {
      if (event.key !== DEMO_MARKER_KEY) return
      const marker = readDemoMarker(localStorage)
      if (marker?.state === 'expired' || marker?.state === 'lost') end(marker.state)
    }
    const timer = setInterval(tick, 1000)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener(DEMO_ENDED_EVENT, refused)
    window.addEventListener('storage', storage)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener(DEMO_ENDED_EVENT, refused)
      window.removeEventListener('storage', storage)
    }
  }, [end])

  if (phase === 'ready')
    return (
      <AppearanceProvider>
        <div className="demo-workspace">
          <div data-demo-banner className="demo-banner">
            <span>Private demo · expires in {demoCountdown(remaining)}</span>
            <a href={WORKSPACE_SIGNUP_URL}>Sign up for Qivo</a>
          </div>
          <div className="demo-workspace-content">
            <Suspense fallback={null}>
              <App />
            </Suspense>
          </div>
        </div>
        <AppUpdates />
      </AppearanceProvider>
    )

  return (
    <main className="demo-gate">
      <div data-floating-surface className="demo-gate-card">
        <a className="text-xl font-semibold" href="https://qivo.io">
          qivo
        </a>
        <div role="status" aria-live="polite" className="mt-6">
          <h1 className="text-lg font-semibold">
            {phase === 'intro'
              ? 'Explore Qivo in a private demo'
              : phase === 'preparing'
                ? 'Preparing your private demo…'
                : phase === 'expired'
                  ? 'Your demo has expired.'
                  : phase === 'lost'
                    ? 'Your demo session is no longer available.'
                    : 'Could not open your demo'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {phase === 'intro'
              ? 'Create a private 24-hour workspace with sample projects, tasks and teammates from Northstar Labs.'
              : phase === 'preparing'
                ? 'Your private Northstar Labs workspace will open automatically when it is ready.'
                : phase === 'expired'
                  ? 'Your 24 hours are up. Qivo automatically removes your demo and temporary login.'
                  : phase === 'lost'
                    ? 'Start a new private copy to explore Qivo again.'
                    : error}
          </p>
          {phase === 'intro' && (
            <p className="mt-3 text-sm text-muted-foreground">
              We’ll sign you in automatically as Nora. No email address or password is needed. Your
              changes stay in your private copy. After 24 hours, Qivo automatically removes the demo
              and temporary login.
            </p>
          )}
        </div>
        {phase !== 'preparing' && (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button
              onClick={() => {
                if (phase === 'error' && readDemoMarker(localStorage)) {
                  // Reload cancels pending transport/token work and releases
                  // any browser lock. Keep the receipt marker and credential.
                  location.reload()
                  return
                }
                if (creationRequested.current) return
                if (phase === 'expired' || phase === 'lost') {
                  clearLocalSession()
                  disposeDemoStore()
                  localStorage.removeItem(DEMO_MARKER_KEY)
                  lifecycle.current = null
                  history.replaceState(null, '', '/app')
                }
                creationRequested.current = true
                setPhase('preparing')
                setAttempt((value) => value + 1)
              }}
            >
              {phase === 'intro'
                ? 'Create demo workspace'
                : phase === 'error'
                  ? 'Retry'
                  : 'Try again'}
            </Button>
          </div>
        )}
      </div>
    </main>
  )
}
