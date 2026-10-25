// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SeatsDeleting } from '../convex/lib/workspaceJoin'
import { SIGN_OUT_FAILED, SignOutFailed } from './lib/authSession'
import { loadFailureText } from './lib/loadFailure'

/* The gate with the auth client, the store and the workspace code replaced.
   Each test starts signed out, so every auth call answers without a session
   until the test signs someone in. */

type AuthCall = (args: object) => Promise<object>
type SessionResult = { data: { session: object; user: object } | null; error: null }
const auth = vi.hoisted(() => ({
  session: { data: null, error: null } as SessionResult,
  signIn: vi.fn<AuthCall>(async () => ({
    data: null,
    error: { code: 'INVALID_EMAIL_OR_PASSWORD' },
  })),
  // email confirmation is on, so a sign-up returns no token
  signUp: vi.fn<AuthCall>(async () => ({ data: {}, error: null })),
  requestPasswordReset: vi.fn<AuthCall>(async () => ({ error: null })),
  sendVerificationEmail: vi.fn<AuthCall>(async () => ({ error: null })),
  signOut: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('./lib/auth', () => ({
  authClient: {
    getSession: async () => auth.session,
    signIn: { email: auth.signIn, social: vi.fn() },
    signUp: { email: auth.signUp },
    requestPasswordReset: auth.requestPasswordReset,
    sendVerificationEmail: auth.sendVerificationEmail,
  },
  handleOAuthReturn: async () => {},
  signOut: auth.signOut,
}))
vi.mock('./lib/convex', () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }))
// a login with no seat, unless a test says otherwise
const planner = vi.hoisted(() => ({
  initStore: vi.fn<() => Promise<boolean | null>>(async () => null),
  // the root part's answer when the seatless boot found the login's
  // organization being deleted
  seatsDeleting: vi.fn<() => SeatsDeleting | null>(() => null),
}))
vi.mock('./store/planner', () => ({
  initStore: planner.initStore,
  P: {
    seatsDeleting: planner.seatsDeleting,
    getOAuthConnectionContext: async () => ({
      oauthQuery: 'sig=s',
      clientName: 'Example App',
      redirectOrigin: 'https://app.example.com',
      profileName: 'Ada',
      orgName: 'Acme',
      scopes: ['qivo:read'],
    }),
  },
}))
vi.mock('./lib/workspacePreload', () => ({
  loadWorkspace: vi.fn(),
  preloadWorkspacePage: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  auth.session = { data: null, error: null }
  planner.seatsDeleting.mockReturnValue(null)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)

/* The button that reads `label`. */
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button reads ${label}`)
  return found
}

/* Opens the gate. */
async function render() {
  const { AuthGate } = await import('./AuthGate')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AuthGate />
      </TooltipProvider>,
    ),
  )
}

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

/* Gives the gate a session for ada@example.com, whose address is confirmed
   unless `verified` is false. */
function signIn(verified = true) {
  auth.session = {
    data: { session: {}, user: { email: 'ada@example.com', emailVerified: verified } },
    error: null,
  }
}

// the connect page with a signed authorization request (lib/oauthConnection.ts)
const CONNECT_URL = 'http://localhost:3000/app/~/connect?sig=s&ba_param=client_id&client_id=c'

/* Replaces jsdom's location, whose reload cannot be replaced, with a copy at
   `href` whose reload is a mock. afterEach puts the real one back. */
function stubLocation(href = 'http://localhost:3000/app') {
  const { origin, pathname, search, hash } = new URL(href)
  const reload = vi.fn()
  vi.stubGlobal('location', { href, origin, pathname, search, hash, reload })
  return reload
}

/* Presses `label` and checks that it and the `others` buttons are held while
   the sign-out runs. The server then answers with a fault, and the screen
   must say so and give every button back. */
async function refuseSignOut(label: string, others: string[]) {
  let refuse!: () => void
  auth.signOut.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      refuse = () => reject(new SignOutFailed())
    }),
  )
  const pressed = await vi.waitFor(() => button(label))
  const held = [pressed, ...others.map(button)]
  await act(async () => pressed.click())
  expect(pressed.textContent).toBe('Signing out…')
  for (const b of held) expect(b.disabled, b.textContent ?? '').toBe(true)
  await act(async () => refuse())
  expect(pressed.textContent).toBe(label)
  for (const b of held) expect(b.disabled, b.textContent ?? '').toBe(false)
  expect(container.textContent).toContain(SIGN_OUT_FAILED)
}

/* The sign-in gate sends an address as Qivo stores and mails it
   (convex/lib/email.ts asciiEmail): lowercase, with a Unicode domain in
   punycode, so it matches the address an invitation used. */
describe('the address the sign-in gate sends', () => {
  it('is the stored form for sign-in, sign-up and password reset', async () => {
    await render()
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

/* A signed-in login with no seat gets the organization form, which says
   first when an organization deletion holds its seats, and is there only
   while the server would create the organization. */
describe('a login with no seat', () => {
  const heading = () => container.querySelector('[data-seats-deleting]')
  const buttonNamed = (name: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === name)

  it('says why a login whose organization is being deleted has no seat, and keeps the form', async () => {
    signIn()
    planner.seatsDeleting.mockReturnValue({ deleting: true, create: 'now' })
    await render()
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    expect(heading()?.textContent).toBe('This organization is being deleted')
    expect(container.textContent).toContain(
      'You no longer have access to it. You can create a new organization.',
    )
    expect(container.textContent).not.toContain('If you expected an invitation')
  })

  it('offers no new organization while the deletion still holds the home seat, and checks again', async () => {
    signIn()
    planner.seatsDeleting.mockReturnValue({ deleting: true, create: 'after_deletion' })
    await render()
    await vi.waitFor(() => expect(heading()).not.toBeNull())
    expect(container.textContent).toContain(
      'You can create a new organization once the deletion has removed you from it.',
    )
    expect(field('organization-name')).toBeNull()
    expect(buttonNamed('Create organization')).toBeUndefined()
    // once the deletion removed the seat, the next load offers the form
    planner.seatsDeleting.mockReturnValue({ deleting: true, create: 'now' })
    const loads = planner.initStore.mock.calls.length
    await act(async () => buttonNamed('Check again')?.click())
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    expect(planner.initStore.mock.calls.length).toBe(loads + 1)
  })

  it('offers no new organization to a login whose home seat another organization holds', async () => {
    signIn()
    planner.seatsDeleting.mockReturnValue({ deleting: true, create: 'blocked' })
    await render()
    await vi.waitFor(() => expect(heading()).not.toBeNull())
    expect(container.textContent).toContain('You no longer have access to it.')
    expect(container.textContent).not.toContain('create a new organization')
    expect(field('organization-name')).toBeNull()
    expect(buttonNamed('Check again')).toBeUndefined()
    expect(buttonNamed('Use another account')).toBeDefined()
  })
})

/* A fault or a rate limit leaves the person signed in (lib/authSession.ts
   signOut), so the screen stays, says so and lets them try again. */
describe('a sign-out the server could not complete', () => {
  it('keeps the load failure screen with both of its buttons and why it failed', async () => {
    signIn()
    const failure = new Error('offline')
    planner.initStore.mockRejectedValueOnce(failure)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = stubLocation()
    await render()
    await refuseSignOut('Sign out', ['Try again'])
    expect(container.textContent).toContain(loadFailureText(failure))
    expect(reload).not.toHaveBeenCalled()
  })

  it('clears the refusal when the person tries again, also on the next screen', async () => {
    signIn()
    const failure = new Error('offline')
    planner.initStore.mockRejectedValueOnce(failure)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubLocation()
    await render()
    await refuseSignOut('Sign out', ['Try again'])
    // the load works this time and finds no seat, so the organization form
    await act(async () => button('Try again').click())
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    expect(container.textContent).not.toContain(SIGN_OUT_FAILED)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the confirm screen with its buttons', async () => {
    signIn(false)
    const reload = stubLocation()
    await render()
    await refuseSignOut('Use another account', [
      'Resend confirmation email',
      'Already confirmed? Reload',
    ])
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SIGN_OUT_FAILED)
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps the organization form and the name typed into it', async () => {
    signIn()
    const reload = stubLocation()
    await render()
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    await type(field('organization-name'), 'Acme')
    await refuseSignOut('Use another account', ['Create organization'])
    expect(field('organization-name')?.value).toBe('Acme')
    expect(reload).not.toHaveBeenCalled()
  })

  it('stays on the connect page, which says so', async () => {
    signIn()
    auth.signOut.mockRejectedValueOnce(new SignOutFailed())
    const reload = stubLocation(CONNECT_URL)
    await render()
    const pressed = await vi.waitFor(() => button('Use another account'))
    await act(async () => pressed.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SIGN_OUT_FAILED)
    expect(pressed.textContent).toBe('Use another account')
    expect(pressed.disabled).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('a sign-out the server completes', () => {
  it('reloads the page from a gate screen', async () => {
    signIn()
    const reload = stubLocation()
    await render()
    const pressed = await vi.waitFor(() => button('Use another account'))
    await act(async () => pressed.click())
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads the page from the connect page', async () => {
    signIn()
    const reload = stubLocation(CONNECT_URL)
    await render()
    const pressed = await vi.waitFor(() => button('Use another account'))
    await act(async () => pressed.click())
    expect(reload).toHaveBeenCalledOnce()
  })
})
