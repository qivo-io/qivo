// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiAccessFigures,
  ApiAccessPageAnswer,
  ApiAccessPerson,
  ApiCredentialRow,
  ApiUsagePeriod,
} from '../../lib/apiAccess'
import type { ApiAccessPageArgs } from '../../store/planner'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Settings › Organization › API access on the real store, and what a token's
   or connection's owner sees after an admin revoked it. The fixture admin
   (me) sees Daniel's and the Release bot's credentials and their own. The
   network plays the server: it pages and filters a fixed list for each
   period (`server`), answers the person filter's people, and accepts every
   revoke; the clock is fixed at 15 Oct 2026 in local time. */

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
  removed: false,
  access: 'write',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  revoked_by_admin: false,
  state: 'active',
  calls: 0,
  ...patch,
})

/* What the fake server holds: each period's figures and credentials, in the
   server's order, the people the person filter lists, the rows a page holds,
   and answers a test puts in place of the computed ones. */
type Server = {
  periods: ApiUsagePeriod[]
  figures: Record<string, ApiAccessFigures['summary']>
  rows: Record<string, ApiCredentialRow[]>
  people: ApiAccessPerson[]
  pageSize: number
  peopleBatch: number
  page?: (args: ApiAccessPageArgs) => ApiAccessPageAnswer | undefined
}
let server: Server

function fixtureServer(): Server {
  const plan = {
    currency: 'usd',
    api_calls_per_seat: 25_000,
    api_block_size: 25_000,
    api_block_price_cents: 100,
  }
  return {
    periods: [
      { key: CURRENT, kind: 'paid', start: CURRENT, end: local(2026, 10, 31), current: true },
      {
        key: PREVIOUS,
        kind: 'month',
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-30T00:00:00.000Z',
        current: false,
      },
    ],
    figures: {
      [CURRENT]: { calls: 43_230, included_calls: 175_000, plan, waived: false },
      // a past calendar month had no allowance
      [PREVIOUS]: { calls: 640, included_calls: null, plan: null, waived: true },
    },
    rows: {
      [CURRENT]: [
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
          removed: true,
          calls: 300,
        }),
        credential('Raycast', { state: 'inactive', access: 'read' }),
      ],
      [PREVIOUS]: [credential('Cursor', { calls: 640 })],
    },
    people: [
      { id: 'daniel', name: 'Daniel Berg', agent: false, removed: false },
      { id: me, name: 'Planner', agent: false, removed: false },
      { id: 'relay', name: 'Release bot', agent: true, removed: false },
    ],
    pageSize: 25,
    peopleBatch: 25,
  }
}

/* The fake server's page: the period's rows through the filters, a page of
   pageSize from the cursor, which is the offset as text. */
function fakePage(args: ApiAccessPageArgs): ApiAccessPageAnswer {
  const placed = server.page?.(args)
  if (placed) return placed
  const period = args.period ?? CURRENT
  if (!(period in server.rows)) return { state: 'period_unavailable' }
  let person: ApiAccessPerson | null = null
  if (args.person !== undefined) {
    const found =
      server.people.find((p) => p.id === args.person) ??
      (args.person === 'left'
        ? { id: 'left', name: 'Removed user', agent: false, removed: true }
        : undefined)
    if (!found) return { state: 'unknown_person' }
    person = found
  }
  const search = args.search?.toLowerCase()
  const rows = server.rows[period].filter(
    (r) =>
      (args.kind === 'all' || r.table === args.kind) &&
      (args.state === 'all' || r.state === 'active') &&
      (args.person === undefined || r.profile_id === args.person) &&
      (search === undefined ||
        [r.name, r.prefix ?? '', r.person].join('\n').toLowerCase().includes(search)),
  )
  const from = args.cursor === undefined ? 0 : Number(args.cursor)
  const to = from + server.pageSize
  return {
    state: 'ready',
    period,
    person,
    rows: structuredClone(rows.slice(from, to)),
    next: to < rows.length ? String(to) : null,
    stopped: false,
  }
}

function fakeSummary(period: string | undefined) {
  const key = period ?? CURRENT
  if (!(key in server.figures)) return { state: 'period_unavailable', periods: server.periods }
  return {
    state: 'ready',
    periods: server.periods,
    period: key,
    summary: structuredClone(server.figures[key]),
  }
}

/* The network's answer to the read `name` with `args`. */
function answer(name: string, args: Record<string, unknown>): unknown {
  if (name === 'apiAccess:summary') return fakeSummary(args.period as string | undefined)
  if (name === 'apiAccess:page') {
    const { org_id: _org, ...rest } = args
    return fakePage(rest as ApiAccessPageArgs)
  }
  if (name === 'apiAccess:people') {
    const search = ((args.search as string | undefined) ?? '').toLowerCase()
    const people = server.people.filter((p) => p.name.toLowerCase().includes(search))
    const from = args.cursor === undefined ? 0 : Number(args.cursor)
    const to = from + server.peopleBatch
    return {
      state: 'ready',
      rows: people.slice(from, to),
      next: to < people.length ? String(to) : null,
      stopped: false,
    }
  }
  return null
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
  server = fixtureServer()
  network.query.mockImplementation((ref, args) =>
    Promise.resolve(answer(getFunctionName(ref), args)),
  )
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
/* Waits out the search delay (250 ms) and the read it sends. */
const rest = async () => {
  await act(async () => await new Promise((r) => setTimeout(r, 300)))
  await settle()
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
/* The row of credential `id` (`<table>:<uuid>`), whose key also names its
   owner and whether it is deleted. */
const row = (id: string) => find(`[data-api-credential^="${id}:"]`)
const cell = (id: string, name: string) =>
  row(id).querySelector(`[data-api-credential-cell="${name}"]`)?.textContent
/* The person cell's name, without the avatar's initials. */
const person = (id: string) =>
  row(id).querySelector('[data-api-credential-cell="person"] .truncate')?.textContent
const calls = (name: string) =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name)
/* The arguments of every page read, without the organization. */
const pageCalls = () =>
  calls('apiAccess:page').map(([, args]) => {
    const { org_id: _org, ...rest } = args as Record<string, unknown>
    return rest
  })
const summaryCalls = () => calls('apiAccess:summary')
const revokeCalls = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'apiAccess:revoke')
const note = () => document.querySelector('[data-api-access-note]')?.textContent
const count = () => document.querySelector('[data-api-access-count]')?.textContent

describe('the API access page', () => {
  it('lists the first page with its owner, kind, access, last use and calls', async () => {
    await render(<ui.OrgApiAccessPage />)
    expect(find('[data-api-access-summary]').textContent).toContain(
      '43,230 of 175,000 included API calls',
    )
    expect(find('[data-api-access-summary]').textContent).toContain(
      '25,000 calls per seat, shared by the organization. Each started 25,000 above that costs $1.',
    )
    // the rows on screen, with no total
    expect(count()).toBe('1–7')
    expect(listed()).toEqual([
      'Cursor',
      'Claude',
      'GitHub Actions',
      'Sheets export script',
      'Cursor, old',
      'Zapier',
      'Raycast',
    ])
    // one summary and one page, the current period, everything
    expect(summaryCalls().map(([, args]) => args)).toEqual([{ org_id: snap.profiles[0].org_id }])
    expect(pageCalls()).toEqual([{ kind: 'all', state: 'all' }])
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
    // a removed account has the placeholder portrait the row's `removed` asks for
    expect(person('mcp_tokens:zapier')).toBe('Removed user')
    expect(
      row('mcp_tokens:zapier').querySelector('[data-api-credential-cell="person"] [data-avatar]'),
    ).toBeNull()
    expect(
      row('mcp_tokens:cursor').querySelector('[data-api-credential-cell="person"] [data-avatar]'),
    ).not.toBeNull()
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
    // one page holds everything, so there is nothing to browse
    expect(document.querySelector('[data-api-access-pager]')).toBeNull()
  })

  it('browses with Next and Previous, reading only the page', async () => {
    server.pageSize = 3
    await render(<ui.OrgApiAccessPage />)
    expect([count(), listed()]).toEqual(['1–3', ['Cursor', 'Claude', 'GitHub Actions']])
    expect(find<HTMLButtonElement>('[data-api-access-previous]').disabled).toBe(true)
    await click(find('[data-api-access-next]'))
    expect([count(), listed()]).toEqual(['4–6', ['Sheets export script', 'Cursor, old', 'Zapier']])
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: CURRENT, cursor: '3' })
    await click(find('[data-api-access-next]'))
    expect([count(), listed()]).toEqual(['7', ['Raycast']])
    expect(find<HTMLButtonElement>('[data-api-access-next]').disabled).toBe(true)
    await click(find('[data-api-access-previous]'))
    expect(count()).toBe('4–6')
    await click(find('[data-api-access-previous]'))
    expect(count()).toBe('1–3')
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: CURRENT })
    // browsing read pages only; the summary was read once, on opening
    expect(summaryCalls()).toHaveLength(1)
  })

  it('starts again at the first page on every filter and search change, on the server', async () => {
    server.pageSize = 3
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-access-next]'))
    const filters = find('[data-api-access-filters]')
    await click(buttonIn(find('[aria-label="Kind"]', filters), 'Agent keys'))
    expect(pageCalls().at(-1)).toEqual({ kind: 'agent_keys', state: 'all', period: CURRENT })
    expect([count(), listed()]).toEqual(['1', ['GitHub Actions']])
    await click(buttonIn(find('[aria-label="Kind"]', filters), 'All'))
    await click(find('[data-api-access-next]'))
    await click(buttonIn(find('[aria-label="State"]', filters), 'Active'))
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'active', period: CURRENT })
    expect([count(), listed()]).toEqual(['1–3', ['Cursor', 'Claude', 'GitHub Actions']])
    await click(find('[data-api-access-next]'))
    // the search goes to the server once typing rests
    const before = pageCalls().length
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'sheets')
    await settle()
    expect(pageCalls()).toHaveLength(before)
    await rest()
    expect(pageCalls().at(-1)).toEqual({
      kind: 'all',
      state: 'active',
      period: CURRENT,
      search: 'sheets',
    })
    expect(listed()).toEqual(['Sheets export script'])
    // Escape clears the field, and the list follows at once
    await act(async () =>
      find('[data-api-access-search]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    await settle()
    expect(find<HTMLInputElement>('[data-api-access-search]').value).toBe('')
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'active', period: CURRENT })
    expect(summaryCalls()).toHaveLength(1)
  })

  it('picks a person from a searchable list read from the server, and keeps them named', async () => {
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-access-person]'))
    const choices = () =>
      [...find('[data-api-access-people]').querySelectorAll('button')].map((b) => b.textContent)
    expect(choices()).toEqual(['Everyone', 'Planner (you)', 'Daniel Berg', 'Release botagent'])
    expect(calls('apiAccess:people').at(-1)?.[1]).toEqual({ org_id: snap.profiles[0].org_id })
    await type(find<HTMLInputElement>('[data-api-access-people-search]'), 'rel')
    await rest()
    expect(calls('apiAccess:people').at(-1)?.[1]).toMatchObject({ search: 'rel' })
    expect(choices()).toEqual(['Everyone', 'Release botagent'])
    await click(find('[data-api-access-person-choice="relay"]'))
    expect(pageCalls().at(-1)).toEqual({
      kind: 'all',
      state: 'all',
      period: CURRENT,
      person: 'relay',
    })
    expect(listed()).toEqual(['GitHub Actions'])
    expect(find('[data-api-access-person]').textContent).toBe('Release bot')
    // a person with no credentials in a period stays chosen and named
    await choose(find<HTMLSelectElement>('[data-api-access-period]'), PREVIOUS)
    expect(find('[data-api-access-person]').textContent).toBe('Release bot')
    expect(note()).toBe('No credentials for Release bot in this period.')
  })

  it('loads the next batch of people on Retry after a failed Load more, one read at a time', async () => {
    server.peopleBatch = 2
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-access-person]'))
    const choices = () =>
      [...find('[data-api-access-people]').querySelectorAll('button')].map((b) => b.textContent)
    expect(choices()).toEqual(['Everyone', 'Planner (you)', 'Daniel Berg', 'Load more'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    network.query.mockRejectedValueOnce(new Error('offline'))
    await click(find('[data-api-access-people-more]'))
    const alert = find('[data-api-access-people] [role="alert"]')
    expect(alert.textContent).toContain("Couldn't load people.")
    const before = calls('apiAccess:people').length
    // two presses send one read
    const retry = buttonIn(alert, 'Retry')
    await act(async () => {
      retry.click()
      retry.click()
    })
    await settle()
    expect(calls('apiAccess:people')).toHaveLength(before + 1)
    expect(calls('apiAccess:people').at(-1)?.[1]).toMatchObject({ cursor: '2' })
    expect(choices()).toEqual(['Everyone', 'Planner (you)', 'Daniel Berg', 'Release botagent'])
  })

  it('reads another period on demand and refreshes from the title', async () => {
    await render(<ui.OrgApiAccessPage />)
    const period = find<HTMLSelectElement>('[data-api-access-period]')
    expect([...period.options].map((o) => o.textContent)).toEqual([
      '1 Oct to 31 Oct',
      '1 Sep to 30 Sep',
    ])
    await choose(period, PREVIOUS)
    expect(summaryCalls().at(-1)?.[1]).toMatchObject({ period: PREVIOUS })
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: PREVIOUS })
    // only the count: no allowance bar and no plan line
    const summary = find('[data-api-access-summary]')
    expect(find('p', summary).textContent).toBe('640 API calls')
    expect(summary.querySelectorAll('p')).toHaveLength(1)
    expect(summary.querySelector('[aria-label="Included API calls used"]')).toBeNull()
    expect(listed()).toEqual(['Cursor'])
    await click(find('[data-api-access-refresh]'))
    expect(summaryCalls()).toHaveLength(3)
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: PREVIOUS })
  })

  it('reads the summary again when a filter changes while a period change is on its way', async () => {
    const read = network.query.getMockImplementation()
    const held: (() => void)[] = []
    // the period change's reads wait until the test lets them through
    network.query.mockImplementation((ref, args) => {
      if (args.period === PREVIOUS && args.kind !== 'mcp_tokens' && held.length < 2)
        return new Promise((resolve) => held.push(() => resolve(read?.(ref, args))))
      return read?.(ref, args)
    })
    await render(<ui.OrgApiAccessPage />)
    await choose(find<HTMLSelectElement>('[data-api-access-period]'), PREVIOUS)
    await click(buttonIn(find('[aria-label="Kind"]'), 'Personal tokens'))
    expect(summaryCalls().at(-1)?.[1]).toMatchObject({ period: PREVIOUS })
    // the period's own figures, never the period before's over its rows
    expect(find('[data-api-access-summary] p').textContent).toBe('640 API calls')
    expect(listed()).toEqual(['Cursor'])
    expect(find<HTMLSelectElement>('[data-api-access-period]').value).toBe(PREVIOUS)
    // the period change's late answers change nothing
    await act(async () => {
      for (const go of held) go()
    })
    await settle()
    expect(find('[data-api-access-summary] p').textContent).toBe('640 API calls')
    expect(listed()).toEqual(['Cursor'])
  })

  it('paints only the newest answer when an older one arrives late', async () => {
    const read = network.query.getMockImplementation()
    let late: (() => void) | undefined
    network.query.mockImplementation((ref, args) => {
      // the first Agent keys page waits until the test lets it through
      if (getFunctionName(ref) === 'apiAccess:page' && args.kind === 'agent_keys' && !late)
        return new Promise((resolve) => {
          late = () => resolve(read?.(ref, args))
        })
      return read?.(ref, args)
    })
    await render(<ui.OrgApiAccessPage />)
    const kind = find('[aria-label="Kind"]')
    await click(buttonIn(kind, 'Agent keys'))
    await click(buttonIn(kind, 'Connected apps'))
    expect(listed()).toEqual(['Claude'])
    await act(async () => late?.())
    await settle()
    expect(listed()).toEqual(['Claude'])
  })

  it('keeps the figures, rows and controls of what is shown when a read fails, and Retry sends it again', async () => {
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
    // a failed filter change keeps the filter of the rows shown
    network.query.mockRejectedValueOnce(new Error('offline'))
    await click(buttonIn(find('[aria-label="Kind"]'), 'Agent keys'))
    expect(find('[aria-label="Kind"] [data-state="on"]').textContent).toBe('All')
    expect(listed()).toHaveLength(7)
    await click(buttonIn(find('[role="alert"]'), 'Retry'))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(listed()).toEqual(['GitHub Actions'])
  })

  it('puts the search box back with the search when a search read fails, and Retry applies it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<ui.OrgApiAccessPage />)
    const box = () => find<HTMLInputElement>('[data-api-access-search]')
    network.query.mockRejectedValueOnce(new Error('offline'))
    await type(box(), 'sheets')
    await rest()
    expect(find('[role="alert"]').textContent).toContain("Couldn't refresh API access.")
    // the box says what the rows on screen are filtered by
    expect(box().value).toBe('')
    expect(listed()).toHaveLength(7)
    await click(buttonIn(find('[role="alert"]'), 'Retry'))
    expect(pageCalls().at(-1)).toMatchObject({ search: 'sheets' })
    expect(box().value).toBe('sheets')
    expect(listed()).toEqual(['Sheets export script'])
    // later reads use the search the box shows
    await click(buttonIn(find('[aria-label="State"]'), 'Active'))
    expect(pageCalls().at(-1)).toMatchObject({ state: 'active', search: 'sheets' })
  })

  it('keeps the search box with the rows after a failed search, so the next filter reads what it shows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<ui.OrgApiAccessPage />)
    network.query.mockRejectedValueOnce(new Error('offline'))
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'sheets')
    await rest()
    await click(buttonIn(find('[aria-label="Kind"]'), 'Agent keys'))
    expect(pageCalls().at(-1)).toEqual({ kind: 'agent_keys', state: 'all', period: CURRENT })
    expect(find<HTMLInputElement>('[data-api-access-search]').value).toBe('')
    expect(listed()).toEqual(['GitHub Actions'])
  })

  it('says when the page could not be loaded, and loads it on Retry', async () => {
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

describe('the explicit states', () => {
  it('says the organization has no credentials, and that no credentials match', async () => {
    server.rows[CURRENT] = []
    await render(<ui.OrgApiAccessPage />)
    expect(note()).toBe('No API credentials yet.')
    await click(buttonIn(find('[aria-label="State"]'), 'Active'))
    expect(note()).toBe('No credentials match the filters.')
  })

  it('says when no more credentials match on a later page', async () => {
    server.pageSize = 3
    await render(<ui.OrgApiAccessPage />)
    // the list shrank between two pages
    server.rows[CURRENT] = server.rows[CURRENT].slice(0, 3)
    await click(find('[data-api-access-next]'))
    expect(note()).toBe('No more credentials match.')
    expect(find<HTMLButtonElement>('[data-api-access-previous]').disabled).toBe(false)
  })

  it('says a page stopped early on its read budget, never that nothing matches', async () => {
    server.page = (args) =>
      args.cursor === undefined
        ? { state: 'ready', period: CURRENT, person: null, rows: [], next: 'more', stopped: true }
        : undefined
    await render(<ui.OrgApiAccessPage />)
    expect(note()).toBe(
      'Qivo checked part of the list and found no matches there. Next continues with the rest.',
    )
    expect(document.body.textContent).not.toContain('No credentials match')
    server.page = (args) =>
      args.cursor === undefined
        ? {
            state: 'ready',
            period: CURRENT,
            person: null,
            rows: server.rows[CURRENT].slice(0, 2),
            next: 'more',
            stopped: true,
          }
        : undefined
    await click(find('[data-api-access-refresh]'))
    expect(find('[data-api-access-stopped]').textContent).toBe(
      'Qivo checked part of the list for this page. Next continues with the rest.',
    )
  })

  it('says when API access is not ready, and when the period total is not available', async () => {
    server.page = () => ({ state: 'not_ready' })
    server.figures[CURRENT] = { ...server.figures[CURRENT], calls: null }
    await render(<ui.OrgApiAccessPage />)
    expect(note()).toMatch(/^API access is not ready yet\./)
    expect(find('[data-api-access-total-pending]').textContent).toMatch(
      /^This period's total is not available yet\./,
    )
    expect(document.querySelector('[aria-label="Included API calls used"]')).toBeNull()
  })

  it('names an unknown person and offers everyone, deliberately', async () => {
    await render(
      <ui.OrgApiAccessPage
        entry={{ org_id: snap.profiles[0].org_id, profile_id: 'nobody', period_key: CURRENT }}
      />,
    )
    expect(note()).toBe(
      'This account is not in the organization, and no usage names it.Show everyone',
    )
    await click(buttonIn(find('[data-api-access-note]'), 'Show everyone'))
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: CURRENT })
    expect(listed()).toHaveLength(7)
  })
})

describe('arriving from Billing', () => {
  const entry = (
    patch: Partial<{ org_id: string; profile_id: string; period_key: string }> = {},
  ) => ({
    org_id: snap.profiles[0].org_id,
    profile_id: 'daniel',
    period_key: PREVIOUS,
    ...patch,
  })

  it('applies the account and period to the very first read, with every kind and state and no search', async () => {
    const used = vi.fn()
    await render(<ui.OrgApiAccessPage entry={entry()} onEntryUsed={used} />)
    expect(pageCalls()).toEqual([{ kind: 'all', state: 'all', period: PREVIOUS, person: 'daniel' }])
    expect(summaryCalls().map(([, args]) => args.period)).toEqual([PREVIOUS])
    expect(used).toHaveBeenCalledTimes(1)
    expect(find<HTMLSelectElement>('[data-api-access-period]').value).toBe(PREVIOUS)
    expect(find('[data-api-access-person]').textContent).toBe('Daniel Berg')
    expect(listed()).toEqual(['Cursor'])
    // the summary keeps its organization-wide meaning
    expect(find('[data-api-access-summary]').textContent).toContain('640 API calls')
  })

  it('keeps a removed account named, and says when it has nothing in the period', async () => {
    await render(<ui.OrgApiAccessPage entry={entry({ profile_id: 'left', period_key: CURRENT })} />)
    expect(find('[data-api-access-person]').textContent).toBe('Removed user')
    expect(listed()).toEqual(['Zapier'])
    await choose(find<HTMLSelectElement>('[data-api-access-period]'), PREVIOUS)
    expect(note()).toBe('No credentials for Removed user in this period.')
  })

  it('says a period that is no longer available is unavailable, and changes scope only on request', async () => {
    await render(<ui.OrgApiAccessPage entry={entry({ period_key: 'month:2025-01' })} />)
    expect(pageCalls()).toEqual([
      { kind: 'all', state: 'all', period: 'month:2025-01', person: 'daniel' },
    ])
    expect(note()).toBe(
      'This usage period is no longer available, so no credentials are listed for it.Show the current period',
    )
    expect(listed()).toEqual([])
    const period = find<HTMLSelectElement>('[data-api-access-period]')
    expect(period.selectedOptions[0]?.textContent).toBe('Period no longer available')
    await click(buttonIn(find('[data-api-access-note]'), 'Show the current period'))
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', person: 'daniel' })
    expect(period.value).toBe(CURRENT)
    expect(listed()).toEqual(['Cursor', 'Sheets export script', 'Cursor, old', 'Raycast'])
  })

  it('reads the current period’s figures when a filter changes while Show the current period is on its way', async () => {
    await render(<ui.OrgApiAccessPage entry={entry({ period_key: 'month:2025-01' })} />)
    const read = network.query.getMockImplementation()
    const held: (() => void)[] = []
    network.query.mockImplementation((ref, args) => {
      if (args.period === undefined && args.kind !== 'mcp_tokens' && held.length < 2)
        return new Promise((resolve) => held.push(() => resolve(read?.(ref, args))))
      return read?.(ref, args)
    })
    await click(buttonIn(find('[data-api-access-note]'), 'Show the current period'))
    await click(buttonIn(find('[aria-label="Kind"]'), 'Personal tokens'))
    expect(summaryCalls().at(-1)?.[1].period).toBeUndefined()
    expect(document.querySelector('[data-api-access-note="period-unavailable"]')).toBeNull()
    expect(find('[data-api-access-summary]').textContent).toContain('43,230')
    expect(find<HTMLSelectElement>('[data-api-access-period]').value).toBe(CURRENT)
    expect(listed()).toEqual(['Cursor', 'Sheets export script', 'Cursor, old', 'Raycast'])
    await act(async () => {
      for (const go of held) go()
    })
    await settle()
    expect(find('[data-api-access-summary]').textContent).toContain('43,230')
  })

  it('reads nothing for another organization’s entry until asked, and then unfiltered', async () => {
    await render(<ui.OrgApiAccessPage entry={entry({ org_id: 'another-org' })} />)
    expect(find('[data-api-access-foreign]').textContent).toContain(
      "This link came from another organization's Billing page",
    )
    expect(pageCalls()).toEqual([])
    await click(buttonIn(find('[data-api-access-foreign]'), "Show this organization's credentials"))
    expect(pageCalls()).toEqual([{ kind: 'all', state: 'all' }])
    expect(listed()).toHaveLength(7)
  })
})

describe('revoking', () => {
  it('revokes in a window that says whose access stops, then reads the summary and the same page again', async () => {
    server.pageSize = 3
    await render(<ui.OrgApiAccessPage />)
    await click(find('[data-api-access-next]'))
    await click(find('[data-api-credential-revoke]', row('mcp_tokens:sheets-export-script')))
    const dialog = find('[data-api-access-revoke^="mcp_tokens:sheets-export-script:"]')
    expect(document.querySelector('[data-modal-shell]')?.textContent).toContain(
      'Revoke Sheets export script?',
    )
    expect(dialog.textContent).toBe(
      "Daniel Berg's personal token stops working right away. Daniel sees it as revoked by an admin and can create a new one.Sheets export scriptPersonal token, qvt_sheets ",
    )
    // Cancel sends nothing
    await click(buttonIn(find('[data-modal-shell]'), 'Cancel'))
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(revokeCalls()).toHaveLength(0)

    await click(find('[data-api-credential-revoke]', row('mcp_tokens:sheets-export-script')))
    await click(buttonIn(find('[data-modal-shell]'), 'Revoke'))
    expect(revokeCalls()).toHaveLength(1)
    expect(revokeCalls()[0][1]).toMatchObject({ table: 'mcp_tokens', id: 'sheets-export-script' })
    expect(document.querySelector('[data-modal-shell]')).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('“Sheets export script” revoked')
    expect(summaryCalls()).toHaveLength(2)
    expect(pageCalls().at(-1)).toEqual({ kind: 'all', state: 'all', period: CURRENT, cursor: '3' })
    expect(count()).toBe('4–6')
  })

  it('gives focus to the next Revoke, else the previous one, else the line, once a revoke takes its own away', async () => {
    // the server revokes, and the page read after it says so. The page
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
        for (const c of server.rows[CURRENT])
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
      document.querySelector('[data-api-credential^="mcp_tokens:sheets-export-script:"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(
      find('[data-api-credential-revoke]', row('agent_keys:github-actions')),
    )
    // with no row left, focus goes to the line that says so
    await type(find<HTMLInputElement>('[data-api-access-search]'), 'GitHub')
    await rest()
    await revoke('agent_keys:github-actions')
    expect(document.activeElement?.textContent).toBe('No credentials match the filters.')
  })

  it('lists a deleted credential and the credential that took its uuid as two rows, and revokes the live one', async () => {
    // the Release bot's deleted key had the uuid Daniel's new token took
    server.rows[CURRENT] = [
      credential('Old key', {
        table: 'mcp_tokens',
        id: 'reused',
        prefix: null,
        access: null,
        state: 'deleted',
        profile_id: 'relay',
        person: 'Release bot',
        calls: 9,
      }),
      credential('New token', { id: 'reused' }),
    ]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(<ui.OrgApiAccessPage />)
    const keys = [...document.querySelectorAll('[data-api-credential]')].map((r) =>
      r.getAttribute('data-api-credential'),
    )
    expect(keys).toEqual(['mcp_tokens:reused:relay:deleted', 'mcp_tokens:reused:daniel'])
    expect(listed()).toEqual(['Old key', 'New token'])
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/)
    const live = find('[data-api-credential="mcp_tokens:reused:daniel"]')
    live.querySelector<HTMLElement>('[data-api-credential-revoke]')?.focus()
    await click(find('[data-api-credential-revoke]', live))
    await click(buttonIn(find('[data-modal-shell]'), 'Revoke'))
    expect(revokeCalls().at(-1)?.[1]).toMatchObject({ table: 'mcp_tokens', id: 'reused' })
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
    Object.assign(server.rows[CURRENT][0], { state: 'revoked', revoked_at: NOW.toISOString() })
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
