// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Seatless } from '../convex/lib/workspaceJoin'

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
/* What the gate passes the store's boot. */
type InitArgs = Parameters<typeof import('./store/planner').initStore>
// a login with no seat, unless a test says otherwise
const planner = vi.hoisted(() => ({
  initStore: vi.fn<(...args: InitArgs) => Promise<boolean | null>>(async () => null),
  // the root part's answer when the seatless boot found a seat the login
  // cannot open, in an organization being deleted or one that deactivated it
  seatless: vi.fn<() => Seatless | null>(() => null),
}))
vi.mock('./store/planner', () => ({
  initStore: planner.initStore,
  // the task key's prefix, which the router reads an address's task by
  ISSUE_PREFIX: 'QN',
  P: {
    seatless: planner.seatless,
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
  planner.seatless.mockReturnValue(null)
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

/* A signed-in login with no seat it can open gets the organization form,
   which says first when an organization deletion holds its seats or an
   organization deactivated it, and is there only while the server would
   create the organization. */
describe('a login with no seat', () => {
  const heading = () => container.querySelector('[data-seats-deleting]')
  const buttonNamed = (name: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === name)

  it('says why a login whose organization is being deleted has no seat, and keeps the form', async () => {
    signIn()
    planner.seatless.mockReturnValue({ deleting: true, create: 'now' })
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
    planner.seatless.mockReturnValue({ deleting: true, create: 'after_deletion' })
    await render()
    await vi.waitFor(() => expect(heading()).not.toBeNull())
    expect(container.textContent).toContain(
      'You can create a new organization once the deletion has removed you from it.',
    )
    expect(field('organization-name')).toBeNull()
    expect(buttonNamed('Create organization')).toBeUndefined()
    // the screen does not follow the deletion, so Check again reloads
    expect(document.activeElement).toBe(buttonNamed('Check again'))
    const reload = stubLocation()
    await act(async () => buttonNamed('Check again')?.click())
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps the form for a deletion answer without a create state, from an older backend', async () => {
    signIn()
    planner.seatless.mockReturnValue({ deleting: true } as Seatless)
    await render()
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    expect(container.textContent).toContain('You can create a new organization.')
  })

  /* Outside the demo, which never shows this screen, `blocked` beside a
     deletion means another organization deactivated the login's member
     seat, so the screen says that too. */
  it('tells a login whose member seat another organization deactivated so, and checks again', async () => {
    signIn()
    planner.seatless.mockReturnValue({ deleting: true, create: 'blocked' })
    await render()
    await vi.waitFor(() => expect(heading()).not.toBeNull())
    expect(container.textContent).toContain(
      'You no longer have access to it. Another organization has deactivated your account. An admin there can reactivate it, or remove you so you can create your own organization.',
    )
    expect(container.textContent).not.toContain('create a new organization')
    expect(field('organization-name')).toBeNull()
    expect(document.activeElement).toBe(buttonNamed('Check again'))
    expect(buttonNamed('Use another account')).toBeDefined()
  })

  it('tells a deactivated member so, with no form and no word of a deletion, and checks again', async () => {
    signIn()
    planner.seatless.mockReturnValue({ deleting: false, create: 'blocked' })
    await render()
    const title = () => container.querySelector('[data-seatless="deactivated"]')
    await vi.waitFor(() => expect(title()).not.toBeNull())
    expect(title()?.textContent).toBe('You no longer have access')
    expect(container.textContent).toContain(
      'Your organization has deactivated your account. An admin there can reactivate it, or remove you so you can create your own organization.',
    )
    expect(heading()).toBeNull()
    expect(container.textContent).not.toContain('being deleted')
    expect(container.textContent).not.toContain('If you expected an invitation')
    expect(field('organization-name')).toBeNull()
    expect(buttonNamed('Create organization')).toBeUndefined()
    expect(buttonNamed('Use another account')).toBeDefined()
    // an admin's reactivation or removal reaches the screen only by a reload,
    // which the desktop app does not offer by itself
    expect(document.activeElement).toBe(buttonNamed('Check again'))
    const reload = stubLocation()
    await act(async () => buttonNamed('Check again')?.click())
    expect(reload).toHaveBeenCalledOnce()
  })

  it('offers no Check again where the form is', async () => {
    signIn()
    await render()
    await vi.waitFor(() => expect(field('organization-name')).not.toBeNull())
    expect(buttonNamed('Check again')).toBeUndefined()
  })
})

/* The boot reads the task its address names with the first parts
   (store/liveParts.ts `address`), so the gate passes that task to the
   store, and none for an address that names no organization. */
describe('the boot on a task address', () => {
  it('passes the store the task the address names under its organization', async () => {
    stubLocation('http://localhost:3000/app/northstar/tasks/qn-7')
    planner.initStore.mockClear()
    signIn()
    await render()
    await vi.waitFor(() => expect(planner.initStore).toHaveBeenCalled())
    expect(planner.initStore.mock.lastCall?.[2]).toEqual({
      address: { slug: 'northstar', ref: 'QN-7' },
    })
  })

  it('passes no task for an address under ~', async () => {
    stubLocation('http://localhost:3000/app/~/tasks/7')
    planner.initStore.mockClear()
    signIn()
    await render()
    await vi.waitFor(() => expect(planner.initStore).toHaveBeenCalled())
    expect(planner.initStore.mock.lastCall?.[2]?.address).toBeUndefined()
  })
})

/* The sign-out holds in this browser whatever the server answers
   (lib/authSession.ts signOut), so every press ends in a reload. */
describe('a sign-out from the gate', () => {
  it('holds the confirm screen while it runs, then reloads the page', async () => {
    let end!: () => void
    auth.signOut.mockReturnValueOnce(
      new Promise((resolve) => {
        end = resolve
      }),
    )
    signIn(false)
    const reload = stubLocation()
    await render()
    const pressed = await vi.waitFor(() => button('Use another account'))
    const held = [pressed, button('Resend confirmation email'), button('Already confirmed? Reload')]
    await act(async () => pressed.click())
    expect(pressed.textContent).toBe('Signing out…')
    for (const b of held) expect(b.disabled, b.textContent ?? '').toBe(true)
    expect(reload).not.toHaveBeenCalled()
    await act(async () => end())
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
