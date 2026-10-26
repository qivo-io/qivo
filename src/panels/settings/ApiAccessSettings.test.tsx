// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiAccessList, ApiCredentialRow } from '../../lib/apiAccess'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Settings › Organization › API access on the real store, and what a token's
   or connection's owner sees after an admin revoked it. The fixture admin
   (me) sees Daniel's and the Release bot's credentials and their own. The
   network answers the list for any period and accepts every revoke; the
   clock is fixed at 15 Oct 2026 in local time. */

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

const NOW = new Date(2026, 9, 15, 10, 0)
const local = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString()
const CURRENT = local(2026, 10, 1)
const PREVIOUS = 'month:2026-09'

// Imported after resetModules, so they share the store's module instances.
let ui: typeof import('./ApiAccessSettings')
let tokensUi: typeof import('./PersonalTokens')
let appsUi: typeof import('../ConnectedApps')
let tooltip: typeof import('../../components/ui/tooltip')
let snap: Snapshot
let me: string
let lists: Record<string, ApiAccessList>
let container: HTMLDivElement
let root: Root

const credential = (name: string, patch: Partial<ApiCredentialRow>): ApiCredentialRow => ({
  table: 'mcp_tokens',
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  prefix: `qvt_${name.toLowerCase().slice(0, 7)}`,
  profile_id: 'daniel',
  person: 'Daniel Berg',
  agent: false,
  access: 'write',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  revoked_by_admin: false,
  state: 'active',
  calls: 0,
  ...patch,
})

function fixtureLists(): Record<string, ApiAccessList> {
  const periods: ApiAccessList['periods'] = [
    { key: CURRENT, kind: 'paid', start: CURRENT, end: local(2026, 10, 31), current: true },
    {
      key: PREVIOUS,
      kind: 'month',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-30T00:00:00.000Z',
      current: false,
    },
  ]
  const plan = {
    currency: 'usd',
    api_calls_per_seat: 25_000,
    api_block_size: 25_000,
    api_block_price_cents: 100,
  }
  return {
    [CURRENT]: {
      periods,
      period: CURRENT,
      summary: { calls: 43_230, included_calls: 175_000, plan, waived: false },
      credentials: [
        credential('Cursor', { calls: 18_544, last_used_at: local(2026, 10, 15, 9, 48) }),
        credential('Claude', {
          table: 'oauth_connections',
          prefix: '4f1c2b7d9e0a1c3fa90e',
          profile_id: me,
          person: 'Planner',
          calls: 9_412,
        }),
        credential('GitHub Actions', {
          table: 'agent_keys',
          prefix: 'qva_2...22222',
          profile_id: 'relay',
          person: 'Release bot',
          agent: true,
          calls: 5_870,
        }),
        credential('Sheets export script', {
          access: 'read',
          // stored as the start of the day after its last day, 2 Dec
          expires_at: local(2026, 12, 3, 0),
          calls: 2_980,
        }),
        credential('Cursor, old', {
          state: 'revoked',
          revoked_at: local(2026, 10, 6),
          calls: 1_135,
        }),
        credential('Zapier', {
          prefix: null,
          access: null,
          state: 'deleted',
          profile_id: 'left',
          person: 'Removed user',
          calls: 300,
        }),
        credential('Raycast', { state: 'inactive', access: 'read' }),
      ],
    },
    [PREVIOUS]: {
      periods,
      period: PREVIOUS,
      // a past calendar month had no allowance
      summary: { calls: 640, included_calls: null, plan: null, waived: true },
      credentials: [credential('Cursor', { calls: 640 })],
    },
  }
}

async function load() {
  vi.resetModules()
  snap = plannerFixture()
  const admin = snap.profiles[0]
  me = admin.id
  snap.profiles.push(
    { ...admin, id: 'daniel', name: 'Daniel Berg', initials: 'DB', org_role: 'user' },
    {
      ...admin,
      id: 'relay',
      name: 'Release bot',
      initials: 'RB',
      org_role: 'user',
      kind: 'agent',
      auth_user_id: undefined,
    },
  )
  lists = fixtureLists()
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'apiAccess:list')
      return Promise.resolve(structuredClone(lists[args.period ?? CURRENT] ?? lists[CURRENT]))
    return Promise.resolve(null)
  })
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    if (name === 'apiAccess:revoke') return Promise.resolve(true)
    return new Promise(() => {})
  })
  const store = await import('../../store/planner')
  await store.initStore()
  ui = await import('./ApiAccessSettings')
  tokensUi = await import('./PersonalTokens')
  appsUi = await import('../ConnectedApps')
  tooltip = await import('../../components/ui/tooltip')
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

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

async function render(page: React.ReactNode) {
  await act(async () => root.render(<tooltip.TooltipProvider>{page}</tooltip.TooltipProvider>))
  await settle()
}

function find<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) {
  const element = scope.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const buttonIn = (scope: ParentNode, text: string) => {
  const match = [...scope.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!match) throw new Error(`Missing button ${text}`)
  return match as HTMLButtonElement
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
  await settle()
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const listed = () =>
  [...document.querySelectorAll('[data-api-credential]')].map(
    (row) => row.querySelector('.truncate')?.textContent,
  )
const row = (id: string) => find(`[data-api-credential="${id}"]`)
const cell = (id: string, name: string) =>
  row(id).querySelector(`[data-api-credential-cell="${name}"]`)?.textContent
/* The person cell's name, without the avatar's initials. */
const person = (id: string) =>
  row(id).querySelector('[data-api-credential-cell="person"] .truncate')?.textContent
const listCalls = () =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'apiAccess:list')
const revokeCalls = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'apiAccess:revoke')

describe('the API access page', () => {
  it('lists every credential with its owner, kind, access, last use and calls', async () => {
    await render(<ui.OrgApiAccessPage />)
    expect(find('[data-api-access-summary]').textContent).toContain(
      '43,230 of 175,000 included API calls',
    )
    expect(find('[data-api-access-summary]').textContent).toContain(
      '25,000 calls per seat, shared by the organization. Each started 25,000 above that costs $1.',
    )
    expect(find('[data-api-access-count]').textContent).toBe('7 credentials')
    expect(listed()).toEqual([
      'Cursor',
      'Claude',
      'GitHub Actions',
      'Sheets export script',
      'Cursor, old',
      'Zapier',
      'Raycast',
    ])
    expect(person('mcp_tokens:cursor')).toBe('Daniel Berg')
    expect(cell('mcp_tokens:cursor', 'kind')).toBe('Personal token')
    expect(cell('mcp_tokens:cursor', 'access')).toBe('Can make changes')
    expect(cell('mcp_tokens:cursor', 'used')).toBe('Last used 12 min ago')
    expect(cell('mcp_tokens:cursor', 'calls')).toBe('Calls 18,544')
    expect(person('oauth_connections:claude')).toBe('Planner (you)')
    expect(row('oauth_connections:claude').textContent).toContain('client 4f1c…a90e')
    expect(cell('agent_keys:github-actions', 'kind')).toBe('Agent key')
    expect(cell('mcp_tokens:sheets-export-script', 'access')).toBe('Read onlyexpires 2 Dec')
    // the state goes under the name, so the name is never cut short by it
    const old = row('mcp_tokens:cursor-old')
    expect(find('[data-api-credential-state]', old).textContent).toBe('revoked 6 Oct')
    expect(old.querySelector('.truncate')?.textContent).toBe('Cursor, old')
    expect(old.firstElementChild?.className).toContain('opacity-60')
    expect(old.querySelector('[data-api-credential-revoke]')).toBeNull()
    expect(person('mcp_tokens:zapier')).toBe('Removed user')
    expect(row('mcp_tokens:zapier').querySelector('[data-api-credential-revoke]')).toBeNull()
    // an inactive account's token can still be revoked, and is not dimmed
    const raycast = row('mcp_tokens:raycast')
    expect(find('[data-api-credential-state]', raycast).textContent).toBe('account inactive')
    expect(raycast.firstElementChild?.className).not.toContain('opacity-60')
    expect(raycast.querySelector('[data-api-credential-revoke]')).not.toBeNull()
    // the narrow list's summary line says what the columns say
    expect(find('[data-api-credential-summary]', row('mcp_tokens:cursor')).textContent).toBe(
      'Daniel Berg, Personal token, Can make changes, last used 12 min ago, 18,544 calls',
    )
  })

  it('filters by kind, state, person and search', async () => {
    await render(<ui.OrgApiAccessPage />)
    const filters = find('[data-api-access-filters]')
    await click(buttonIn(find('[aria-label="Kind"]', filters), 'Agent keys'))
    expect(listed()).toEqual(['GitHub Actions'])
    await click(buttonIn(find('[aria-label="Kind"]', filters), 'All'))
    await click(buttonIn(find('[aria-label="State"]', filters), 'Active'))
    expect(listed()).toEqual(['Cursor', 'Claude', 'GitHub Actions', 'Sheets export script'])
    await click(buttonIn(find('[aria-label="State"]', filters), 'All'))
    const person = find<HTMLSelectElement>('[data-api-access-person]')
    expect([...person.options].map((o) => o.textContent)).toEqual([
      'Everyone',
      'Planner (you)',
      'Daniel Berg',
      'Release bot',
      'Removed user',
    ])
    await choose(person, 'daniel')
    expect(listed()).toEqual(['Cursor', 'Sheets export script', 'Cursor, old', 'Raycast'])
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'sheets')
    expect(listed()).toEqual(['Sheets export script'])
    expect(find('[data-api-access-count]').textContent).toBe('1 credential')
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'nothing like it')
    expect(listed()).toEqual([])
    expect(find('[data-api-access]').textContent).toContain('No credentials match the filters.')
  })

  it('reads another period on demand and refreshes from the title', async () => {
    await render(<ui.OrgApiAccessPage />)
    expect(listCalls()).toHaveLength(1)
    const period = find<HTMLSelectElement>('[data-api-access-period]')
    expect([...period.options].map((o) => o.textContent)).toEqual([
      '1 Oct to 31 Oct',
      '1 Sep to 30 Sep',
    ])
    await choose(period, PREVIOUS)
    expect(listCalls().at(-1)?.[1]).toMatchObject({ period: PREVIOUS })
    // only the count: no allowance bar and no plan line
    const summary = find('[data-api-access-summary]')
    expect(find('p', summary).textContent).toBe('640 API calls')
    expect(summary.querySelectorAll('p')).toHaveLength(1)
    expect(summary.querySelector('[aria-label="Included API calls used"]')).toBeNull()
    expect(listed()).toEqual(['Cursor'])
    await click(find('[data-api-access-refresh]'))
    expect(listCalls()).toHaveLength(3)
    expect(listCalls().at(-1)?.[1]).toMatchObject({ period: PREVIOUS })
  })

  it('revokes in a window that says whose access stops, then reads the list again', async () => {
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-credential-revoke]', row('mcp_tokens:cursor')))
    const dialog = find('[data-api-access-revoke="mcp_tokens:cursor"]')
    expect(document.querySelector('[data-modal-shell]')?.textContent).toContain('Revoke Cursor?')
    expect(dialog.textContent).toBe(
      "Daniel Berg's personal token stops working right away. Daniel sees it as revoked by an admin and can create a new one.CursorPersonal token, qvt_cursor",
    )
    // Cancel sends nothing
    await click(buttonIn(find('[data-modal-shell]'), 'Cancel'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(revokeCalls()).toHaveLength(0)

    await click(find('[data-api-credential-revoke]', row('agent_keys:github-actions')))
    expect(find('[data-api-access-revoke]').textContent).toContain(
      "Release bot's agent key stops working right away. Create a new key for it in Users.",
    )
    await click(buttonIn(find('[data-modal-shell]'), 'Revoke'))
    expect(revokeCalls()).toHaveLength(1)
    expect(revokeCalls()[0][1]).toMatchObject({ table: 'agent_keys', id: 'github-actions' })
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('“GitHub Actions” revoked')
    expect(listCalls()).toHaveLength(2)
  })

  it('gives focus to the next Revoke, else the previous one, else the line, once a revoke takes its own away', async () => {
    // the server revokes, and the list read after it says so. The list
    // answers after the window has given focus back to the Revoke, as the
    // network does
    const read = network.query.getMockImplementation()
    network.query.mockImplementation(async (ref, args) => {
      await new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0))
      return read?.(ref, args)
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'apiAccess:revoke')
        for (const c of lists[CURRENT].credentials)
          if (c.table === args.table && c.id === args.id)
            Object.assign(c, { state: 'revoked', revoked_at: NOW.toISOString() })
      return Promise.resolve(name === 'apiAccess:revoke' ? true : null)
    })
    await render(<ui.OrgApiAccessPage />)
    const revoke = async (id: string) => {
      const button = find<HTMLButtonElement>('[data-api-credential-revoke]', row(id))
      button.focus()
      await click(button)
      await click(buttonIn(find('[data-modal-shell]'), 'Revoke'))
      expect(document.querySelector('[data-modal-shell]')).toBeNull()
    }
    // the row stays without its Revoke, so focus goes to the next row's
    await revoke('mcp_tokens:cursor')
    expect(row('mcp_tokens:cursor').querySelector('[data-api-credential-revoke]')).toBeNull()
    expect(document.activeElement).toBe(
      find('[data-api-credential-revoke]', row('oauth_connections:claude')),
    )
    // the Active filter drops the row, and the last one goes to the one before it
    await click(buttonIn(find('[aria-label="State"]'), 'Active'))
    await revoke('mcp_tokens:sheets-export-script')
    expect(
      document.querySelector('[data-api-credential="mcp_tokens:sheets-export-script"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(
      find('[data-api-credential-revoke]', row('agent_keys:github-actions')),
    )
    // with no row left, focus goes to the line that says so
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'GitHub')
    await revoke('agent_keys:github-actions')
    expect(document.activeElement?.textContent).toBe('No credentials match the filters.')
  })

  it('moves nothing when a credential whose window was cancelled ends later', async () => {
    await render(<ui.OrgApiAccessPage />)
    const revoke = find<HTMLButtonElement>('[data-api-credential-revoke]', row('mcp_tokens:cursor'))
    revoke.focus()
    await click(revoke)
    await click(buttonIn(find('[data-modal-shell]'), 'Cancel'))
    expect(document.activeElement).toBe(revoke)
    // another admin revokes it, and a Refresh that leaves focus nowhere, as
    // a click in Safari does, reads it
    revoke.blur()
    Object.assign(lists[CURRENT].credentials[0], {
      state: 'revoked',
      revoked_at: NOW.toISOString(),
    })
    await click(find('[data-api-access-refresh]'))
    expect(row('mcp_tokens:cursor').querySelector('[data-api-credential-revoke]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps the window open with the reason when the revoke is refused', async () => {
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'apiAccess:revoke'
        ? Promise.reject(new Error('refused'))
        : Promise.resolve(null),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-credential-revoke]', row('mcp_tokens:raycast')))
    await click(buttonIn(find('[data-modal-shell]'), 'Revoke'))
    expect(find('[data-modal-shell]').textContent).toContain("That didn't go through. Try again.")
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('goes back to the period shown when switching to another one fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<ui.OrgApiAccessPage />)
    const period = find<HTMLSelectElement>('[data-api-access-period]')
    network.query.mockRejectedValueOnce(new Error('offline'))
    await choose(period, PREVIOUS)
    expect(find('[role="alert"]').textContent).toContain("Couldn't refresh API access.")
    // the figures on screen are still the current period's, and so is the control
    expect(period.value).toBe(CURRENT)
    expect(find('[data-api-access-summary]').textContent).toContain('43,230')
    expect(listed()).toHaveLength(7)
  })

  it('says when the list could not be loaded, and loads it on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    network.query.mockRejectedValueOnce(new Error('offline'))
    await render(<ui.OrgApiAccessPage />)
    expect(find('[role="alert"]').textContent).toContain("Couldn't load API access.")
    expect(document.querySelector('[data-api-access]')).toBeNull()
    await click(buttonIn(find('[role="alert"]'), 'Retry'))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(listed()).toHaveLength(7)
  })
})

describe('what the owner sees after an admin revoked their credential', () => {
  it('tags the token "revoked by an admin", the connection "Revoked by an admin", and one whose app is gone', async () => {
    network.query.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      const token = {
        name: 'Cursor',
        prefix: 'qvt_c04be71',
        access: 'write',
        createdAt: local(2026, 9, 2),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: local(2026, 10, 6),
      }
      const app = {
        clientId: 'client',
        profileId: me,
        profileName: 'Planner',
        orgId: 'org',
        orgName: 'Testbed Labs',
        scopes: ['qivo:read'],
        createdAt: local(2026, 9, 2),
        lastUsedAt: null,
        revokedAt: local(2026, 10, 6),
      }
      if (name === 'tokens:listMcpTokens')
        return Promise.resolve([
          { ...token, id: 'by-admin', revokedByAdmin: true },
          { ...token, id: 'by-me', revokedByAdmin: false },
        ])
      if (name === 'oauthConnections:list')
        return Promise.resolve([
          { ...app, id: 'by-admin', clientName: 'ChatGPT', revokedByAdmin: true, appGone: false },
          { ...app, id: 'replayed', clientName: 'Claude', revokedByAdmin: false, appGone: false },
          // an app no longer in Qivo, which nothing revoked, and a live one
          {
            ...app,
            id: 'app-gone',
            clientName: 'Raycast',
            revokedAt: null,
            revokedByAdmin: false,
            appGone: true,
          },
          {
            ...app,
            id: 'live',
            clientName: 'Zed',
            revokedAt: null,
            revokedByAdmin: false,
            appGone: false,
          },
        ])
      return Promise.resolve(null)
    })
    await render(
      <>
        <tokensUi.PersonalTokens mcpUrl="https://api.qivo.io/mcp" />
        <appsUi.ConnectedApps />
      </>,
    )
    expect(find('[data-mcp-token="by-admin"]').textContent).toContain('Cursorrevoked by an admin')
    expect(find('[data-mcp-token="by-me"]').textContent).not.toContain('by an admin')
    expect(
      find('[data-oauth-connection="by-admin"] [data-oauth-connection-revoked]').textContent,
    ).toBe('Revoked by an admin')
    expect(
      find('[data-oauth-connection="replayed"] [data-oauth-connection-revoked]').textContent,
    ).toBe('Access revoked')
    expect(
      find('[data-oauth-connection="app-gone"] [data-oauth-connection-revoked]').textContent,
    ).toBe('App no longer available')
    expect(
      document.querySelector('[data-oauth-connection="live"] [data-oauth-connection-revoked]'),
    ).toBeNull()
  })
})
