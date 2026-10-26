// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_UNAVAILABLE } from '../convex/lib/demoRefusals'
import { TooltipProvider } from './components/ui/tooltip'
import { DEMO_ENDED_EVENT } from './lib/demoMode'
import { DEMO_MARKER_KEY, DemoSessionEnded } from './lib/demoSession'

/* The demo gate over a loaded demo, with the auth client, Convex, the store
   and the workspace replaced: a marker of a started demo, a live session and
   a ready demo open the workspace, which the store then ends with the
   refusal it got (lib/demoMode.ts notifyDemoEnded). */

const EXPIRES_AT = Date.now() + 3_600_000
const network = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  onUpdate: vi.fn(() => () => {}),
}))
vi.mock('./lib/convex', () => ({ convex: network }))
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {} }, error: null }) },
  clearLocalSession: vi.fn(),
}))
vi.mock('./store/planner', () => ({
  initStore: async () => true,
  disposeDemoStore: vi.fn(),
}))
vi.mock('./lib/workspacePreload', () => {
  const workspace = { default: () => <p data-workspace>Workspace</p> }
  return {
    loadWorkspace: Object.assign(async () => workspace, { peek: () => workspace }),
    preloadWorkspacePage: vi.fn(),
  }
})
vi.mock('./AppearanceProvider', () => ({
  AppearanceProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./components/AppUpdates', () => ({ AppUpdates: () => null }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.setItem(DEMO_MARKER_KEY, JSON.stringify({ state: 'started', expiresAt: EXPIRES_AT }))
  network.query.mockImplementation(async (ref) =>
    getFunctionName(ref) === 'demo:configuration'
      ? { mode: 'demo', admissionOpen: true }
      : {
          mode: 'demo',
          status: 'ready',
          expiresAt: EXPIRES_AT,
          orgId: 'org-1',
          orgSlug: 'northstar-labs',
          progress: null,
          serverNow: Date.now(),
        },
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

/** Renders the gate and waits for the loaded demo's workspace. */
async function loaded() {
  const { DemoGate } = await import('./DemoGate')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <DemoGate />
      </TooltipProvider>,
    ),
  )
  await vi.waitFor(() => expect(container.querySelector('[data-workspace]')).not.toBeNull())
}

/** Ends the loaded demo as the store does, with `cause`, and returns the
    screen's heading and sentence. */
async function endWith(cause?: unknown) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(DEMO_ENDED_EVENT, { detail: cause }))
  })
  return {
    heading: container.querySelector('h1')?.textContent,
    sentence: container.querySelector('h1 + p')?.textContent,
  }
}

const refusal = (reason: string, message: string) =>
  new ConvexError({ code: 'forbidden', message, reason })

describe('a loaded demo the server refuses', () => {
  it('shows the demo backend’s own sentence for a demo it no longer serves', async () => {
    await loaded()
    expect(await endWith(refusal('demo_unavailable', DEMO_UNAVAILABLE.mainDeployment))).toEqual({
      heading: 'Your demo session is no longer available.',
      sentence: 'Demo access is unavailable on the main deployment.',
    })
    expect(JSON.parse(localStorage.getItem(DEMO_MARKER_KEY) ?? 'null')?.state).toBe('lost')
  })

  it('shows no other server text for a demo it no longer serves', async () => {
    await loaded()
    expect(await endWith(refusal('demo_unavailable', 'Index by_auth_user is not ready.'))).toEqual({
      heading: 'Your demo session is no longer available.',
      sentence: 'Start a new private copy to explore Qivo again.',
    })
  })

  it('says the demo expired for an expired demo and for a cause it cannot read', async () => {
    const expired = {
      heading: 'Your demo has expired.',
      sentence: 'Your 24 hours are up. Qivo automatically removes your demo and temporary login.',
    }
    await loaded()
    expect(await endWith(refusal('demo_expired', 'Your demo has expired.'))).toEqual(expired)
    await act(async () => root.unmount())
    root = createRoot(container)
    localStorage.setItem(
      DEMO_MARKER_KEY,
      JSON.stringify({ state: 'started', expiresAt: EXPIRES_AT }),
    )
    await loaded()
    // a demo whose seat is gone ends without a refusal
    expect(await endWith()).toEqual(expired)
  })

  it('shows the lost screen when the visitor leaves the demo', async () => {
    await loaded()
    expect(await endWith(new DemoSessionEnded('lost'))).toEqual({
      heading: 'Your demo session is no longer available.',
      sentence: 'Start a new private copy to explore Qivo again.',
    })
  })
})
