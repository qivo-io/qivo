// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OAuthConnect } from './OAuthConnect'

/* The connect page's "Use another account". AuthGate passes a sign-out that
   reloads the page when it ends (AuthGate.test.tsx drives it through the
   gate). */

vi.mock('../lib/auth', () => ({ authClient: { oauth2: { consent: vi.fn() } } }))
// a request for both scopes, so the page shows the Allow changes checkbox
vi.mock('../store/planner', () => ({
  P: {
    getOAuthConnectionContext: async () => ({
      oauthQuery: 'sig=s',
      clientName: 'Example App',
      redirectOrigin: 'https://app.example.com',
      profileName: 'Ada',
      orgName: 'Acme',
      scopes: ['qivo:read', 'qivo:write'],
    }),
  },
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

/* The button that reads `label`. */
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button reads ${label}`)
  return found
}

/* Opens the page with the sign-out `onUseAnotherAccount` and returns its
   switch button and every control the sign-out holds. */
async function render(onUseAnotherAccount: () => void) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OAuthConnect oauthQuery="sig=s" onUseAnotherAccount={onUseAnotherAccount} />
      </TooltipProvider>,
    ),
  )
  const pressed = await vi.waitFor(() => button('Use another account'))
  const checkbox = container.querySelector<HTMLButtonElement>('#oauth-allow-changes')
  if (!checkbox) throw new Error('no Allow changes checkbox')
  return { pressed, controls: [pressed, button('Cancel'), button('Connect'), checkbox] }
}

describe('the connect page when the person uses another account', () => {
  it('holds every control from the press until the sign-out reloads the page', async () => {
    const signOut = vi.fn()
    const { pressed, controls } = await render(signOut)
    await act(async () => pressed.click())
    expect(signOut).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(pressed.textContent).toBe('Signing out…')
    for (const c of controls) expect(c.disabled, c.id || c.textContent || '').toBe(true)
  })
})
