// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SIGN_OUT_FAILED } from '../lib/authSession'

/* The operator console's gate when Convex drops its sign-in after the first
   answer. lib/authSession.ts arms a session that still exists again and
   reports the rest as lost, and the gate then shows the sign-in form
   without the password typed earlier. */

const auth = vi.hoisted(() => ({
  // armConvexAuth's first answer: whether Convex got a token
  armed: true,
  lost: [] as (() => void)[],
  // isOperator's answer
  operator: true,
  session: { data: null as { session: object } | null },
  signIn: vi.fn(async () => ({ error: null })),
  // the sentence to show when the server could not sign the operator out
  signOutAndReload: vi.fn<() => Promise<string | null>>(async () => null),
}))
vi.mock('./auth', () => ({
  armConvexAuth: async (onLost?: () => void) => {
    if (onLost) auth.lost.push(onLost)
    return auth.armed
  },
  authClient: {
    getSession: async () => auth.session,
    signIn: { email: auth.signIn },
  },
  signOutAndReload: auth.signOutAndReload,
}))
vi.mock('../lib/convex', () => ({ convex: { query: async () => auth.operator } }))
vi.mock('./AdminApp', () => ({ AdminApp: () => <p>Operator console</p> }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  auth.armed = true
  auth.lost = []
  auth.operator = true
  auth.session = { data: null }
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

/* Opens the gate. */
async function render() {
  const { AdminGate } = await import('./AdminGate')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AdminGate />
      </TooltipProvider>,
    ),
  )
}

/* Submits the sign-in form. */
async function submit() {
  await type(field('admin-email'), 'ops@example.com')
  await type(field('admin-password'), 'correct horse')
  await act(async () => field('admin-password')?.form?.requestSubmit())
}

/* Signs in through the form and returns once the console shows. */
async function signIn() {
  await render()
  await submit()
  expect(container.textContent).toContain('Operator console')
}

const NOT_ARMED = "Couldn't confirm your sign-in. Check your connection and sign in again."

describe('the operator gate after Convex drops the sign-in', () => {
  it('returns to the sign-in form without the password once the sign-in is lost', async () => {
    await signIn()
    await act(async () => auth.lost.at(-1)?.())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't keep you signed in. Sign in again.",
    )
    expect(field('admin-email')?.value).toBe('ops@example.com')
    expect(field('admin-password')?.value).toBe('')
  })
})

describe('the operator gate when Convex gets no token for the session', () => {
  it('asks a stored session to sign in again instead of saying No access', async () => {
    auth.session = { data: { session: {} } }
    auth.armed = false
    await render()
    expect(container.textContent).not.toContain('No access')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_ARMED)
    expect(field('admin-email')).not.toBeNull()
  })

  it('keeps the form after a sign-in whose token fetch fails, without the password', async () => {
    auth.armed = false
    await render()
    await submit()
    expect(container.textContent).not.toContain('No access')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_ARMED)
    expect(field('admin-email')?.value).toBe('ops@example.com')
    expect(field('admin-password')?.value).toBe('')
  })
})

describe('the operator sign-in', () => {
  it('sends the address in the form the account stores, with a punycode domain', async () => {
    await render()
    await type(field('admin-email'), ' Ops@Bücher.DE ')
    await type(field('admin-password'), 'correct horse')
    // dispatched, since jsdom's email check refuses a Unicode domain that
    // a browser such as Firefox lets through
    await act(async () =>
      field('admin-password')?.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    )
    expect(auth.signIn).toHaveBeenLastCalledWith({
      email: 'ops@xn--bcher-kva.de',
      password: 'correct horse',
    })
  })
})

describe('the no access screen when the operator uses another account', () => {
  /* Opens the gate on a stored session without operator access and presses
     the switch, whose sign-out answers `refused`. Returns the button. */
  async function useAnotherAccount(refused: string | null) {
    let answer!: (refused: string | null) => void
    auth.signOutAndReload.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    auth.session = { data: { session: {} } }
    auth.operator = false
    await render()
    expect(container.textContent).toContain(
      'Your account does not have platform administrator access.',
    )
    const pressed = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Use another account',
    )
    if (!pressed) throw new Error('no Use another account button')
    await act(async () => pressed.click())
    expect(pressed.textContent).toBe('Signing out…')
    expect(pressed.disabled).toBe(true)
    await act(async () => answer(refused))
    return pressed
  }

  it('says the sign-out failed and offers the button again', async () => {
    const pressed = await useAnotherAccount(SIGN_OUT_FAILED)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SIGN_OUT_FAILED)
    expect(pressed.textContent).toBe('Use another account')
    expect(pressed.disabled).toBe(false)
  })

  it('holds the button while a sign-out that ended reloads the page', async () => {
    const pressed = await useAnotherAccount(null)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(pressed.textContent).toBe('Signing out…')
    expect(pressed.disabled).toBe(true)
  })
})
