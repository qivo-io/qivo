// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SIGN_OUT_FAILED, SignOutFailed } from '../lib/authSession'

/* The console's sign-out buttons, in the desktop nav and the compact header.
   Only the operator session is replaced, so the real signOutAndReload in
   ./auth turns its answer into a reload or a sentence to show. */

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
  ])('from %s shows the refusal and gives both buttons back', async (_, which) => {
    let refuse!: () => void
    session.signOut.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = () => reject(new SignOutFailed())
      }),
    )
    const buttons = await render()
    await act(async () => buttons[which].click())
    expect(labels(buttons)).toEqual(['Signing out…', 'Signing out…'])
    expect(held(buttons)).toEqual([true, true])
    // the compact button's name, which replaces its text for assistive technology
    expect(buttons[1].getAttribute('aria-label')).toBe('Signing out…')

    await act(async () => refuse())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SIGN_OUT_FAILED)
    expect(labels(buttons)).toEqual(['Sign out', 'Sign out'])
    expect(held(buttons)).toEqual([false, false])
    expect(buttons[1].getAttribute('aria-label')).toBe('Sign out')
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads the page once the server signs the operator out', async () => {
    const [nav] = await render()
    await act(async () => nav.click())
    expect(reload).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
