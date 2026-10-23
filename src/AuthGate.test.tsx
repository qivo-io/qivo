// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/* The sign-in gate sends an address as Qivo stores and mails it
   (convex/lib/email.ts asciiEmail): lowercase, with a Unicode domain in
   punycode, so it matches the address an invitation used. Nobody is signed
   in, and every auth call answers without a session. */

type AuthCall = (args: object) => Promise<object>
const auth = vi.hoisted(() => ({
  signIn: vi.fn<AuthCall>(async () => ({
    data: null,
    error: { code: 'INVALID_EMAIL_OR_PASSWORD' },
  })),
  // email confirmation is on, so a sign-up returns no token
  signUp: vi.fn<AuthCall>(async () => ({ data: {}, error: null })),
  requestPasswordReset: vi.fn<AuthCall>(async () => ({ error: null })),
}))
vi.mock('./lib/auth', () => ({
  authClient: {
    getSession: async () => ({ data: null, error: null }),
    signIn: { email: auth.signIn, social: vi.fn() },
    signUp: { email: auth.signUp },
    requestPasswordReset: auth.requestPasswordReset,
  },
  handleOAuthReturn: async () => {},
  signOut: vi.fn(),
}))
vi.mock('./lib/convex', () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }))
vi.mock('./store/planner', () => ({ initStore: vi.fn(), P: { waitingForServer: () => false } }))
vi.mock('./store/usePlannerVersion', () => ({ usePlannerVersion: () => 0 }))
vi.mock('./lib/workspacePreload', () => ({
  loadWorkspace: vi.fn(),
  preloadWorkspacePage: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)

/* Types into a React-controlled input. */
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no such field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/* Submits the form holding `input`. Dispatched, since jsdom's email check
   refuses a Unicode domain that a browser such as Firefox lets through. */
async function submit(input: HTMLInputElement | null) {
  await act(async () =>
    input?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}

async function press(selector: string) {
  await act(async () => document.querySelector<HTMLElement>(selector)?.click())
}

describe('the address the sign-in gate sends', () => {
  it('is the stored form for sign-in, sign-up and password reset', async () => {
    const { AuthGate } = await import('./AuthGate')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <AuthGate />
        </TooltipProvider>,
      ),
    )
    const stored = 'anna@xn--bcher-kva.de'
    await vi.waitFor(() => expect(field('auth-email')).not.toBeNull())
    await type(field('auth-email'), 'Anna@Bücher.DE')
    await type(field('auth-password'), 'correct horse')

    await submit(field('auth-email'))
    expect(auth.signIn).toHaveBeenLastCalledWith({ email: stored, password: 'correct horse' })

    await press('[data-auth-toggle]')
    await submit(field('auth-email'))
    expect(auth.signUp).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: stored, name: 'anna' }),
    )

    // the sign-up said to check the inbox and went back to sign-in
    await press('[data-auth-forgot]')
    await submit(field('reset-email'))
    expect(auth.requestPasswordReset).toHaveBeenLastCalledWith(
      expect.objectContaining({ email: stored }),
    )
  })
})
