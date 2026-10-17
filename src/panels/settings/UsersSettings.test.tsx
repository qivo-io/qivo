// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* An agent's keys in Organization > Users, on the real store. The fixture
   admin (me) manages Atlas, a Standard user agent. The network lists no keys
   and accepts every agent key it is sent. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', () => ({ convex: network }))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

// Imported after resetModules, so they share the store's module instances.
let pages: {
  users: typeof import('./UsersSettings')
  version: typeof import('../../store/usePlannerVersion')
}
let safety: typeof import('../../lib/updateSafety')
let snap: Snapshot
let container: HTMLDivElement
let root: Root

async function load() {
  vi.resetModules()
  snap = plannerFixture()
  const me = snap.profiles[0]
  snap.profiles.push({
    ...me,
    id: 'atlas',
    name: 'Atlas',
    kind: 'agent',
    org_role: 'user',
    auth_user_id: undefined,
    email: undefined,
  })
  // the Users page lists agent keys on mount and after each new key
  network.query.mockResolvedValue([])
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    if (name === 'tokens:createAgentKey') return Promise.resolve({ id: args.id })
    return new Promise(() => {})
  })
  const store = await import('../../store/planner')
  await store.initStore()
  pages = {
    users: await import('./UsersSettings'),
    version: await import('../../store/usePlannerVersion'),
  }
  safety = await import('../../lib/updateSafety')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  network.mutation.mockReset()
  network.query.mockReset()
})

/* Re-renders on every store change, as the app's shell does. */
function Live() {
  pages.version.usePlannerVersion()
  return <pages.users.OrgUsersPage setPage={vi.fn()} />
}

/* Lets the key list, the key hashing and the create call settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

function find<T extends Element = HTMLElement>(selector: string) {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const nameField = () => find<HTMLInputElement>('[data-agent-keys="atlas"] input')
const newKey = () => find<HTMLButtonElement>('[data-new-agent-key="atlas"]')
const createCalls = () =>
  network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'tokens:createAgentKey')

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}

/* Renders the Users page and opens Atlas's keys. */
async function openKeys() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  await settle()
  await click(find('[data-user-row="atlas"] button[aria-label="Manage this agent\'s keys"]'))
}

describe('New key', () => {
  it('creates a key and shows its secret once', async () => {
    await openKeys()
    expect(nameField().maxLength).toBe(80)
    await type(nameField(), 'CI runner')
    await click(newKey())
    await settle()

    expect(createCalls()).toHaveLength(1)
    const args = createCalls()[0][1]
    expect(args).toMatchObject({ org_id: snap.orgs[0].id, agent_id: 'atlas', name: 'CI runner' })
    const secret =
      find('[data-agent-keys="atlas"] [data-fresh-key]').textContent?.match(
        /qva_[0-9a-f]{48}/,
      )?.[0] ?? ''
    expect(secret).toMatch(/^qva_[0-9a-f]{48}$/)
    // the shape convex/tokens.ts requires
    expect(args.key_prefix).toMatch(/^qva_[0-9a-f]{3}\.\.\.[0-9a-f]{5}$/)
    expect(args.key_prefix).toBe(`${secret.slice(0, 7)}...${secret.slice(-5)}`)
    // the server only ever sees the SHA-256 of the secret
    expect(args.key_hash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(args.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(nameField().value).toBe('')
    expect(newKey().disabled).toBe(false)
    expect(window.showToast).not.toHaveBeenCalled()
  })

  it('recovers when the browser cannot hash the secret', async () => {
    // crypto.subtle is missing outside a secure context, such as plain http
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => {
      digest.mockRestore()
      quiet.mockRestore()
    })
    await openKeys()
    expect(safety.isUpdateBlocked()).toBe(false)

    // an empty name mints "Key"; the panel stays open and holds no lease
    await click(newKey())
    await settle()
    expect(createCalls()).toHaveLength(0)
    expect(window.showToast).toHaveBeenCalledWith("Couldn't create that key", 'error')
    expect(newKey().disabled).toBe(false)
    expect(safety.isUpdateBlocked()).toBe(false)

    // a typed name stays for a retry
    await type(nameField(), 'CI runner')
    await click(newKey())
    await settle()
    expect(createCalls()).toHaveLength(0)
    expect(window.showToast).toHaveBeenCalledTimes(2)
    expect(newKey().disabled).toBe(false)
    expect(nameField().value).toBe('CI runner')
  })
})
