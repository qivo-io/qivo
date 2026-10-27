// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { NO_PASSWORD_LOGIN } from '../../../convex/lib/email'
import { LIMITS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { limitSentence, sentence } from '../../lib/fieldLimits'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Organization > Users on the real store: an agent's keys, adding a person
   and editing an invitation's address. The fixture admin (me) manages Atlas,
   a Standard user agent, and Anna, invited at a Unicode domain. The network
   lists no keys or invitation emails and accepts every agent key it is
   sent. */

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
  snap.profiles.push({
    ...me,
    id: 'anna',
    name: 'Anna Berg',
    org_role: 'user',
    auth_user_id: undefined,
    email: 'anna@xn--bcher-kva.de',
  })
  // the Users page lists agent keys on mount and after each new key
  network.query.mockResolvedValue([])
  network.onUpdate.mockImplementation((ref, _args, next) => {
    next(getFunctionName(ref) === 'invites:deliveries' ? [] : structuredClone(snap))
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
  // a test that timed out inside a pause leaves the fake timers on
  vi.useRealTimers()
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

/* Renders the Users page. */
async function show() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/* Renders the Users page and opens Atlas's keys. */
async function openKeys() {
  await show()
  await click(find('[data-user-row="atlas"] button[aria-label="Manage this agent\'s keys"]'))
}

const sentNames = () => network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))

describe('New key', () => {
  it('creates a key and shows its secret once', async () => {
    await openKeys()
    // a pasted name over the cap stays whole, and New key waits for it
    await type(nameField(), 'k'.repeat(81))
    expect(nameField().value).toHaveLength(81)
    expect(newKey().disabled).toBe(true)
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

describe('Add person', () => {
  const nameInput = () => find<HTMLInputElement>('input[aria-label="New person name"]')
  const addButton = () => find<HTMLButtonElement>('[data-add-user]')

  it('counts a name as the server stores it, with whitespace runs collapsed', async () => {
    await show()
    // 81 characters typed, 80 once the double space is one
    await type(nameInput(), `${'a'.repeat(40)}  ${'b'.repeat(39)}`)
    await type(find<HTMLInputElement>('[data-add-email]'), 'bo@example.com')
    expect(nameInput().getAttribute('aria-invalid')).toBeNull()
    expect(addButton().disabled).toBe(false)
    await click(addButton())
    const create = network.mutation.mock.calls.find(
      ([ref]) => getFunctionName(ref) === 'profiles:create',
    )
    expect(create?.[1]).toMatchObject({ name: `${'a'.repeat(40)} ${'b'.repeat(39)}` })
    // one more character is over the cap however it is spaced
    await type(nameInput(), `${'a'.repeat(40)}  ${'b'.repeat(40)}`)
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(addButton().disabled).toBe(true)
  })

  it('says why an address longer than the server stores cannot be added', async () => {
    await show()
    await type(nameInput(), 'Bo Lind')
    const email = find<HTMLInputElement>('[data-add-email]')
    await type(email, `${'a'.repeat(250)}@b.io`)
    expect(addButton().disabled).toBe(true)
    expect(email.getAttribute('aria-invalid')).toBe('true')
    // the field's tooltip, which shows on focus as on hover
    await act(async () => email.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      limitSentence(LIMITS.email),
    )
  })

  it('says under the row why an address a password login cannot use is refused', async () => {
    await show()
    await type(nameInput(), 'Jørn Hansen')
    const email = find<HTMLInputElement>('[data-add-email]')
    // Runs `typing` and then lets 600 ms pass, longer than the 500 ms the
    // note waits for typing to pause. Timeouts run on fake time from the
    // first keystroke to the end of the pause, so it takes no real time, and
    // the clock stays real as in the rest of this file. Going back to real
    // time drops any timeout still pending, so none may be.
    const pauseAfter = async (typing: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await typing()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600)
        })
        expect(vi.getTimerCount(), 'timeouts pending after the pause').toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
    // an address on its way to .com is refused at bo@example.c for a moment
    await pauseAfter(async () => {
      await type(email, 'bo@example.c')
      await type(email, 'bo@example.com')
    })
    expect(document.querySelector('[data-add-email-refusal]')).toBeNull()
    await pauseAfter(async () => {
      await type(email, 'jørn@example.no')
      expect(addButton().disabled).toBe(true)
      // the reason waits until typing pauses
      expect(document.querySelector('[data-add-email-refusal]')).toBeNull()
    })
    const note = find('[data-add-email-refusal]')
    expect(note.textContent).toBe(sentence(NO_PASSWORD_LOGIN))
    expect(note.textContent).toMatch(
      /^This address cannot get a password login\..*Use another address\.$/,
    )
    expect(email.getAttribute('aria-describedby')).toBe(note.id)
    expect(note.parentElement?.getAttribute('aria-live')).toBe('polite')
    // editing a refused address keeps the note in place, without a pause
    await type(email, 'jørn.hansen@example.no')
    expect(find('[data-add-email-refusal]')).toBe(note)
    await type(email, 'jorn@example.no')
    expect(document.querySelector('[data-add-email-refusal]')).toBeNull()
    expect(addButton().disabled).toBe(false)
    // without the note the field keeps its tooltip's description
    await act(async () => email.focus())
    const tooltip = document.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toBe('The email address they will use to sign in')
    expect(email.getAttribute('aria-describedby')).toBe(tooltip?.id)
  })
})

describe("An invitation's address", () => {
  it('sends nothing when the address is retyped with a Unicode domain', async () => {
    await show()
    const field = find<HTMLInputElement>('input[data-user-email="anna"]')
    await act(async () => field.focus())
    await type(field, 'Anna@Bücher.de')
    await act(async () => field.blur())
    expect(sentNames()).not.toContain('profiles:update')
    expect(field.value).toBe('anna@xn--bcher-kva.de')
  })

  it('says why an address a password login cannot use is not saved, and restores the old one', async () => {
    await show()
    const field = find<HTMLInputElement>('input[data-user-email="anna"]')
    await act(async () => field.focus())
    await type(field, 'ivan@правительство.рф')
    await act(async () => field.blur())
    expect(sentNames()).not.toContain('profiles:update')
    expect(window.showToast).toHaveBeenLastCalledWith(sentence(NO_PASSWORD_LOGIN), 'error')
    expect(field.value).toBe('anna@xn--bcher-kva.de')
  })
})
