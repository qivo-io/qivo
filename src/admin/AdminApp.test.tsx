// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/* The console's sign-out buttons, in the desktop nav and the compact header.
   Only the operator session is replaced, so the real signOutAndReload in
   ./auth reloads the page once the sign-out ends. */

const session = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('../lib/authSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authSession')>()),
  createAuthSession: () => ({
    authClient: { getSession: async () => ({ data: { user: { email: 'ops@example.com' } } }) },
    armConvexAuth: vi.fn(),
    signOut: session.signOut,
  }),
}))
vi.mock('../lib/convex', () => ({ convex: {} }))
vi.mock('./views/Dashboard', () => ({ Dashboard: () => <p>Dashboard</p> }))

let container: HTMLDivElement
let root: Root
let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom's own location.reload cannot be replaced
  reload = vi.fn()
  vi.stubGlobal('location', { href: 'http://localhost:3000/admin', reload })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* Opens the console and returns its two sign-out buttons, the nav's first. */
async function render() {
  const { AdminApp } = await import('./AdminApp')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AdminApp />
      </TooltipProvider>,
    ),
  )
  const buttons = [...container.querySelectorAll('button')].filter(
    (b) => b.textContent === 'Sign out',
  )
  expect(buttons).toHaveLength(2)
  return buttons
}

const labels = (buttons: HTMLButtonElement[]) => buttons.map((b) => b.textContent)
const held = (buttons: HTMLButtonElement[]) => buttons.map((b) => b.disabled)

describe('the console sign-out', () => {
  it.each([
    ['the nav', 0],
    ['the compact header', 1],
  ])('from %s holds both buttons until it ends, then reloads the page', async (_, which) => {
    let end!: () => void
    session.signOut.mockReturnValueOnce(
      new Promise((resolve) => {
        end = resolve
      }),
    )
    const buttons = await render()
    await act(async () => buttons[which].click())
    expect(labels(buttons)).toEqual(['Signing out…', 'Signing out…'])
    expect(held(buttons)).toEqual([true, true])
    // the compact button's name, which replaces its text for assistive technology
    expect(buttons[1].getAttribute('aria-label')).toBe('Signing out…')
    expect(reload).not.toHaveBeenCalled()

    await act(async () => end())
    expect(reload).toHaveBeenCalledOnce()
    expect(held(buttons)).toEqual([true, true])
  })
})
