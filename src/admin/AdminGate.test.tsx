// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/* The operator console's gate when Convex drops its sign-in after the first
   answer. A session that still exists is armed again; otherwise the gate
   shows the sign-in form without the password typed earlier. */

const auth = vi.hoisted(() => ({
  lost: [] as (() => void)[],
  session: { data: null as { session: object } | null },
  signIn: vi.fn(async () => ({ error: null })),
}))
vi.mock('./auth', () => ({
  armConvexAuth: async (onLost?: () => void) => {
    if (onLost) auth.lost.push(onLost)
    return true
  },
  authClient: {
    getSession: async () => auth.session,
    signIn: { email: auth.signIn },
  },
  signOut: vi.fn(),
}))
vi.mock('../lib/convex', () => ({ convex: { query: async () => true } }))
vi.mock('./AdminApp', () => ({ AdminApp: () => <p>Operator console</p> }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  auth.lost = []
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

/* Signs in through the form and returns once the console shows. */
async function signIn() {
  const { AdminGate } = await import('./AdminGate')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AdminGate />
      </TooltipProvider>,
    ),
  )
  await type(field('admin-email'), 'ops@example.com')
  await type(field('admin-password'), 'correct horse')
  await act(async () => field('admin-password')?.form?.requestSubmit())
  expect(container.textContent).toContain('Operator console')
}

describe('the operator gate after Convex drops the sign-in', () => {
  it('returns to the sign-in form without the password once the session ended', async () => {
    await signIn()
    await act(async () => auth.lost.at(-1)?.())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Your session ended. Sign in again.',
    )
    expect(field('admin-email')?.value).toBe('ops@example.com')
    expect(field('admin-password')?.value).toBe('')
  })

  it('arms the sign-in again while the session lasts', async () => {
    await signIn()
    auth.session = { data: { session: {} } }
    const armed = auth.lost.length
    await act(async () => auth.lost.at(-1)?.())
    expect(auth.lost.length).toBe(armed + 1)
    expect(container.textContent).toContain('Operator console')
  })
})
