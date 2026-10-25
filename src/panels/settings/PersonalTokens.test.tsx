// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CONFIRM_IGNORE_MS } from '../../lib/useConfirmArm'
import { plannerFixture } from '../../store/plannerFixture.setup'

/* The token list and the New token dialog on the real store. The network
   answers the token list and records the create call; the clock is fixed at
   15 Oct 2026 in local time, so every date below reads the same in any time
   zone. A click that confirms moves the clock past CONFIRM_IGNORE_MS first,
   because the clock does not move on its own. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Tokens = typeof import('./PersonalTokens')
type Expiry = typeof import('../../lib/tokenExpiry')
type Tooltip = typeof import('../../components/ui/tooltip')
type Safety = typeof import('../../lib/updateSafety')
type Token = {
  id: string
  name: string
  prefix: string
  access: 'read' | 'write'
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

const NOW = new Date(2026, 9, 15, 10, 0)
const MCP_URL = 'https://api.qivo.io/mcp'
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString()

// Imported after resetModules, so they share the store's module instances.
let ui: Tokens
let expiry: Expiry
let tooltip: Tooltip
let safety: Safety
let tokens: Token[]
let container: HTMLDivElement
let root: Root

/* The stored expiry for a last day, as the dialog creates it. */
const ending = (day: string) => {
  const at = expiry.expiryFromDay(day, new Date(2026, 0, 1))
  if (at === null) throw new Error(`${day} is not a valid last day`)
  return at
}
const token = (id: string, patch: Partial<Token>): Token => ({
  id,
  name: id,
  prefix: `qvt_${id.slice(0, 7).padEnd(7, '0')}`,
  access: 'write',
  createdAt: local(2026, 9, 2),
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  ...patch,
})

async function load() {
  vi.resetModules()
  const snap = plannerFixture()
  network.query.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'tokens:listMcpTokens') return Promise.resolve(structuredClone(tokens))
    return Promise.resolve(null)
  })
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    if (name === 'tokens:createMcpToken') return Promise.resolve({ id: args.id })
    return new Promise(() => {})
  })
  const store = await import('../../store/planner')
  await store.initStore()
  ui = await import('./PersonalTokens')
  expiry = await import('../../lib/tokenExpiry')
  tooltip = await import('../../components/ui/tooltip')
  safety = await import('../../lib/updateSafety')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.showToast = vi.fn()
  tokens = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
})

/* Lets the awaited list query, the token hashing and the create call settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

async function render() {
  await act(async () =>
    root.render(
      <tooltip.TooltipProvider>
        <ui.PersonalTokens mcpUrl={MCP_URL} />
      </tooltip.TooltipProvider>,
    ),
  )
  await settle()
}

function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const button = (text: string) => {
  const match = [...document.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!match) throw new Error(`Missing button ${text}`)
  return match
}
const dialog = () =>
  document.querySelector('[data-new-mcp-token]')?.getAttribute('data-new-mcp-token')
const createButton = () => button('Create token')
const mutations = () => network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))
const createCalls = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'tokens:createMcpToken')

async function type(selector: string, value: string) {
  const input = find<HTMLInputElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
/* Radix listens for clicks outside one tick after the dialog opens. */
async function openDialog() {
  await click(find('[data-mcp-new-token]'))
  await settle()
}
const radio = (choice: 'never' | 'on') =>
  find<HTMLInputElement>(`[data-new-mcp-token-expires="${choice}"]`)

describe('the token list', () => {
  it('shows access, expiry and last use, and dims revoked and expired tokens', async () => {
    tokens = [
      token('weekly', {
        access: 'read',
        expiresAt: ending('2027-01-12'),
        lastUsedAt: local(2026, 10, 14),
      }),
      token('laptop', { lastUsedAt: local(2026, 10, 14) }),
      token('cursor', { expiresAt: ending('2026-10-21') }),
      token('zapier', { access: 'read', expiresAt: ending('2026-09-30') }),
      token('old', { expiresAt: ending('2026-09-01'), revokedAt: local(2026, 8, 11) }),
    ]
    await render()
    const row = (id: string) => find(`[data-mcp-token="${id}"]`)
    const cell = (id: string, name: string) =>
      row(id).querySelector(`[data-mcp-token-cell="${name}"]`)
    const summary = (id: string) => row(id).querySelector('[data-mcp-token-summary]')?.textContent
    const action = (id: string) => row(id).querySelector('button')?.getAttribute('aria-label')

    expect(cell('weekly', 'access')?.textContent).toBe('Access Read only')
    expect(cell('weekly', 'expires')?.textContent).toBe('Expires 12 Jan 2027')
    expect(cell('weekly', 'used')?.textContent).toBe('Last used 14 Oct')
    expect(summary('weekly')).toBe('Read only, expires 12 Jan 2027, last used 14 Oct')
    expect(cell('laptop', 'expires')?.textContent).toBe('Expires Never')
    expect(summary('laptop')).toBe('Can make changes, never expires, last used 14 Oct')
    expect(cell('cursor', 'used')?.textContent).toBe('Last used Never')

    // within a week the expiry counts down in the warning color
    expect(cell('cursor', 'expires')?.textContent).toBe('Expires In 6 days')
    expect(cell('cursor', 'expires')?.className).toContain('text-warning')
    expect(cell('weekly', 'expires')?.className).not.toContain('text-warning')

    for (const id of ['weekly', 'laptop', 'cursor']) {
      expect(row(id).className).not.toContain('opacity-60')
      expect(action(id)).toBe('Revoke this token')
    }
    expect(row('zapier').textContent).toContain('zapierexpired')
    expect(row('zapier').className).toContain('opacity-60')
    expect(action('zapier')).toBe('Delete expired token')
    expect(summary('zapier')).toBe('Read only, expired 30 Sep, never used')
    // a revoked token shows no expiry at all
    expect(row('old').textContent).toContain('oldrevoked')
    expect(cell('old', 'expires')?.textContent).toBe('')
    expect(summary('old')).toBe('Can make changes, never used')
    expect(action('old')).toBe('Delete revoked token')
  })

  it('asks for a second click before revoking, and disarms when New token opens', async () => {
    tokens = [token('laptop', {})]
    await render()
    const revoke = find('[data-mcp-token="laptop"] button')
    await click(revoke)
    expect(revoke.getAttribute('aria-label')).toBe(
      'Confirm revocation. Connected clients lose access immediately',
    )
    expect(mutations()).not.toContain('tokens:revokeMcpToken')
    // opening New token disarms it, so a later click starts over
    await openDialog()
    await click(button('Cancel'))
    expect(revoke.getAttribute('aria-label')).toBe('Revoke this token')

    // a double click only arms it
    await click(revoke)
    await click(revoke)
    expect(mutations()).not.toContain('tokens:revokeMcpToken')
    expect(revoke.getAttribute('aria-label')).toBe(
      'Confirm revocation. Connected clients lose access immediately',
    )

    // a later click revokes once; a click while that runs only arms again
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await click(revoke)
    expect(mutations().filter((n) => n === 'tokens:revokeMcpToken')).toHaveLength(1)
    expect(revoke.getAttribute('aria-label')).toBe('Revoke this token')
    await click(revoke)
    expect(mutations().filter((n) => n === 'tokens:revokeMcpToken')).toHaveLength(1)
  })

  it('deletes an expired token on the second click, and only once', async () => {
    tokens = [token('zapier', { access: 'read', expiresAt: ending('2026-09-30') })]
    await render()
    const remove = find('[data-mcp-token="zapier"] button')
    await click(remove)
    expect(remove.getAttribute('aria-label')).toBe('Confirm token deletion')
    // armed, it stays an icon, so the cells keep their columns
    expect(remove.textContent).toBe('')
    vi.setSystemTime(Date.now() + CONFIRM_IGNORE_MS)
    await click(remove)
    await click(remove)
    expect(mutations().filter((n) => n === 'tokens:deleteMcpToken')).toHaveLength(1)
    expect(mutations()).not.toContain('tokens:revokeMcpToken')
  })

  it('marks a token expired when its expiry passes during the day', async () => {
    // created in a zone ahead of this one, so it ends mid-afternoon here
    const ends = new Date(NOW.getTime() + 50)
    tokens = [token('cursor', { expiresAt: ends.toISOString() })]
    await render()
    const row = find('[data-mcp-token="cursor"]')
    expect(row.textContent).not.toContain('expired')
    expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('Revoke this token')

    vi.setSystemTime(new Date(ends.getTime() + 10))
    await act(async () => await new Promise((r) => setTimeout(r, 100)))
    expect(row.textContent).toContain('cursorexpired')
    expect(row.className).toContain('opacity-60')
    expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('Delete expired token')
  })

  it('times an expiry from the current clock when the list reloads hours later', async () => {
    await render()
    // seven hours on, creating a token reloads the list, which now holds a
    // token that ends soon
    const later = new Date(NOW.getTime() + 7 * 3_600_000)
    vi.setSystemTime(later)
    const ends = new Date(later.getTime() + 50)
    tokens = [token('cursor', { expiresAt: ends.toISOString() })]
    await openDialog()
    await type('input[aria-label="Name"]', 'Raycast on my Mac')
    await click(createButton())
    await settle()
    await click(button('Done'))
    const row = find('[data-mcp-token="cursor"]')
    expect(row.textContent).not.toContain('expired')

    vi.setSystemTime(new Date(ends.getTime() + 10))
    await act(async () => await new Promise((r) => setTimeout(r, 100)))
    expect(row.textContent).toContain('cursorexpired')
    expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('Delete expired token')
  })
})

describe('New token', () => {
  it('creates a token that can make changes and never expires by default', async () => {
    await render()
    await openDialog()
    expect(dialog()).toBe('form')
    expect(find('[data-new-mcp-token-changes]').getAttribute('aria-checked')).toBe('true')
    expect(radio('never').checked).toBe(true)
    expect(find('input[aria-label="Name"]')).toBe(document.activeElement)
    expect(createButton().disabled).toBe(true)
    await type('input[aria-label="Name"]', '   ')
    expect(createButton().disabled).toBe(true)
    // a pasted name over the cap stays whole, and Create waits for it
    await type('input[aria-label="Name"]', 'n'.repeat(81))
    expect(find<HTMLInputElement>('input[aria-label="Name"]').value).toHaveLength(81)
    expect(createButton().disabled).toBe(true)

    await type('input[aria-label="Name"]', 'Raycast on my Mac')
    expect(createButton().disabled).toBe(false)
    tokens = [token('raycast', { name: 'Raycast on my Mac' })]
    await click(createButton())
    await settle()

    expect(createCalls()).toHaveLength(1)
    const args = createCalls()[0][1]
    expect(args).toMatchObject({ name: 'Raycast on my Mac', access: 'write' })
    expect(args).not.toHaveProperty('expires_at')
    expect(dialog()).toBe('created')
    expect(find('[data-new-mcp-token-summary]').textContent).toBe('Can make changes, never expires')
    // focus moves from the removed Name field to copying the secret
    expect(document.activeElement).toBe(find('[data-fresh-token]'))
    const secret = find('[data-fresh-token]').textContent?.replace('Copy token ', '') ?? ''
    expect(secret).toMatch(/^qvt_[0-9a-f]{48}$/)
    // the shape convex/tokens.ts requires
    expect(args.token_prefix).toMatch(/^qvt_[0-9a-f]{7}$/)
    expect(args.token_prefix).toBe(secret.slice(0, 11))
    // the server only ever sees the SHA-256 of the secret
    expect(args.token_hash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(find('[data-fresh-token-command]').textContent).toBe(
      `Copy Claude Code setup command claude mcp add --transport http qivo "${MCP_URL}" --header "Authorization: Bearer ${secret}"`,
    )
    // the list reloads with the new token
    expect(document.querySelector('[data-mcp-token="raycast"]')).not.toBeNull()
  })

  it('creates a read-only token with a last day, which selects On', async () => {
    await render()
    await openDialog()
    await type('input[aria-label="Name"]', 'Weekly report script')
    await click(find('[data-new-mcp-token-changes]'))
    expect(find('[data-new-mcp-token-changes]').getAttribute('aria-checked')).toBe('false')

    // On without a day cannot be created
    await click(radio('on'))
    expect(createButton().disabled).toBe(true)
    await click(radio('never'))
    expect(createButton().disabled).toBe(false)

    // the day input starts at today in local time; choosing a day picks On
    expect(find<HTMLInputElement>('[data-new-mcp-token-day]').min).toBe('2026-10-15')
    await type('[data-new-mcp-token-day]', '2027-01-12')
    expect(radio('on').checked).toBe(true)
    expect(createButton().disabled).toBe(false)

    await act(async () => {
      find('input[aria-label="Name"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await settle()
    expect(createCalls()).toHaveLength(1)
    expect(createCalls()[0][1]).toMatchObject({
      name: 'Weekly report script',
      access: 'read',
      expires_at: ending('2027-01-12'),
    })
    expect(find('[data-new-mcp-token-summary]').textContent).toBe('Read only, expires 12 Jan 2027')
  })

  it('ignores the Enter that confirms an IME candidate', async () => {
    await render()
    await openDialog()
    await type('input[aria-label="Name"]', '日本語')
    const enter = (init: KeyboardEventInit) =>
      act(async () => {
        find('input[aria-label="Name"]').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }),
        )
      })
    // Chrome marks it composing; Safari has already ended the composition
    await enter({ isComposing: true })
    await enter({ keyCode: 229 })
    await settle()
    expect(createCalls()).toHaveLength(0)
    expect(dialog()).toBe('form')
    await enter({})
    await settle()
    expect(createCalls()).toHaveLength(1)
  })

  it('refuses a day before today', async () => {
    await render()
    await openDialog()
    await type('input[aria-label="Name"]', 'Old')
    await type('[data-new-mcp-token-day]', '2026-10-14')
    expect(radio('on').checked).toBe(true)
    expect(createButton().disabled).toBe(true)
  })

  it('keeps the phone Back step while a token is being created', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    let finish = () => {}
    network.mutation.mockImplementation((ref, args) =>
      getFunctionName(ref) === 'tokens:createMcpToken'
        ? new Promise((resolve) => {
            finish = () => resolve({ id: args.id })
          })
        : Promise.resolve(null),
    )
    const back = async () =>
      act(async () => {
        history.back()
        await new Promise((r) => setTimeout(r, 50))
      })
    // the page's history and the layers' listener, as main.tsx and App add them
    const pageHistory = await import('../../lib/pageHistory')
    const removeHistory = pageHistory.installPageHistory()
    onTestFinished(pageHistory.listenBackLayers())
    onTestFinished(removeHistory)
    await render()
    const page = location.href
    await openDialog()
    expect(history.state?.qivoLayer).toBeTruthy()
    await type('input[aria-label="Name"]', 'Raycast')
    await click(createButton())

    // Back while the create call runs is refused, and its step comes back
    await back()
    expect(dialog()).toBe('form')
    expect(history.state?.qivoLayer).toBeTruthy()

    await act(async () => finish())
    await settle()
    expect(dialog()).toBe('created')
    // so the next Back closes the dialog rather than leaving the page
    await back()
    expect(dialog()).toBeUndefined()
    expect(location.href).toBe(page)
    expect(history.state?.qivoLayer).toBeUndefined()
  })

  it('stays on step one with the toast when the server refuses', async () => {
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'tokens:createMcpToken'
        ? Promise.reject(new Error('refused'))
        : Promise.resolve(null),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    await openDialog()
    await type('input[aria-label="Name"]', 'Raycast')
    await click(createButton())
    await settle()
    expect(window.showToast).toHaveBeenCalledWith("Couldn't create the MCP token", 'error')
    expect(dialog()).toBe('form')
    expect(find<HTMLInputElement>('input[aria-label="Name"]').value).toBe('Raycast')
    expect(createButton().disabled).toBe(false)
  })

  it('recovers when the browser cannot hash the secret', async () => {
    // crypto.subtle is missing outside a secure context, such as plain http
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => {
      digest.mockRestore()
      quiet.mockRestore()
    })
    await render()
    await openDialog()
    await type('input[aria-label="Name"]', 'Raycast')
    await click(createButton())
    await settle()
    expect(createCalls()).toHaveLength(0)
    expect(window.showToast).toHaveBeenCalledWith("Couldn't create the MCP token", 'error')
    expect(dialog()).toBe('form')
    expect(createButton().disabled).toBe(false)
    await click(button('Cancel'))
    expect(dialog()).toBeUndefined()
    expect(safety.isUpdateBlocked()).toBe(false)
  })

  it('keeps the secret through a click outside, and Escape or Done close and reset it', async () => {
    // Radix waits for the click that follows the press before it dismisses
    const outside = () =>
      act(async () => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
          document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      })
    await render()
    await openDialog()
    // a click outside closes step one, so the check below is a real one
    await outside()
    expect(dialog()).toBeUndefined()

    await openDialog()
    await type('input[aria-label="Name"]', 'Raycast')
    await click(createButton())
    await settle()
    expect(dialog()).toBe('created')
    expect(safety.isUpdateBlocked()).toBe(true)
    await outside()
    expect(dialog()).toBe('created')

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(dialog()).toBeUndefined()
    expect(safety.isUpdateBlocked()).toBe(false)

    // Done closes too, and the next dialog starts empty
    await openDialog()
    await type('input[aria-label="Name"]', 'Second')
    await click(createButton())
    await settle()
    await click(button('Done'))
    expect(dialog()).toBeUndefined()
    await openDialog()
    expect(find<HTMLInputElement>('input[aria-label="Name"]').value).toBe('')
    expect(radio('never').checked).toBe(true)
  })
})
